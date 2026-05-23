#!/usr/bin/env bash
# Idempotent provision + (re)deploy of lastlight as a systemd service on a
# KVM-capable Linux host. Run as root from the repo root:
#
#     sudo bash deploy/native/install.sh
#
# On first run: installs system deps, creates the lastlight user, scaffolds
# /etc/lastlight/lastlight.env from the example, installs and starts the
# systemd unit. On subsequent runs: re-installs the deps that changed,
# rebuilds, restarts the service.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
SERVICE_NAME=lastlight
LASTLIGHT_USER=lastlight
LASTLIGHT_HOME=/var/lib/lastlight
ENV_DIR=/etc/lastlight
ENV_FILE="${ENV_DIR}/lastlight.env"
PEM_FILE="${ENV_DIR}/app.pem"

if [ "$(id -u)" -ne 0 ]; then
  echo "install.sh must run as root (try: sudo $0)" >&2
  exit 1
fi

# ── 1. KVM check — gondolin silently hangs without it ──────────────────────
if [ ! -e /dev/kvm ]; then
  echo "ERROR: /dev/kvm not present on this host." >&2
  echo "  gondolin (lastlight's default sandbox) requires KVM. The host must" >&2
  echo "  be bare-metal Linux or a VM with nested virtualization enabled." >&2
  echo "  See agentic-pi/SPIKE-gondolin.md for the full constraint." >&2
  exit 1
fi

# ── 2. System dependencies (Debian/Ubuntu) ─────────────────────────────────
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends \
  curl ca-certificates git \
  qemu-system-x86 qemu-utils \
  python3 build-essential
# Use NodeSource for a current Node 22 LTS (Debian's nodejs is too old).
if ! command -v node >/dev/null 2>&1 || ! node -e 'process.exit(process.versions.node.split(".")[0] >= 20 ? 0 : 1)'; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y --no-install-recommends nodejs
fi

# ── 3. User + group ────────────────────────────────────────────────────────
if ! id "$LASTLIGHT_USER" >/dev/null 2>&1; then
  useradd --system --create-home --home-dir "$LASTLIGHT_HOME" \
    --shell /usr/sbin/nologin "$LASTLIGHT_USER"
fi
# `kvm` group exists once qemu is installed; gate the membership add to
# avoid a usermod warning on hosts where it doesn't.
if getent group kvm >/dev/null 2>&1; then
  usermod -aG kvm "$LASTLIGHT_USER"
fi

# ── 4. Repo install + build (as the lastlight user) ────────────────────────
chown -R "$LASTLIGHT_USER:$LASTLIGHT_USER" "$REPO_DIR"
sudo -u "$LASTLIGHT_USER" -H bash -c "cd '$REPO_DIR' && npm ci --no-audit --no-fund"
sudo -u "$LASTLIGHT_USER" -H bash -c "cd '$REPO_DIR' && npm run build && npm run build:dashboard"
# Prune dev deps to shrink the on-disk footprint of the deployed checkout.
sudo -u "$LASTLIGHT_USER" -H bash -c "cd '$REPO_DIR' && npm prune --omit=dev"

# ── 5. Env file scaffold (don't overwrite an existing config) ──────────────
mkdir -p "$ENV_DIR"
chmod 0750 "$ENV_DIR"
chgrp "$LASTLIGHT_USER" "$ENV_DIR"
if [ ! -f "$ENV_FILE" ]; then
  install -m 0640 -o root -g "$LASTLIGHT_USER" \
    "$REPO_DIR/deploy/native/lastlight.env.example" "$ENV_FILE"
  echo "" >&2
  echo "  NOTE: $ENV_FILE was just created from the example template." >&2
  echo "  Edit it to fill in your GitHub App, model API keys, Slack tokens, etc." >&2
  echo "  Then re-run this script to start the service." >&2
  echo "" >&2
fi

# ── 6. App PEM — referenced by GITHUB_APP_PRIVATE_KEY_PATH in the env file ─
# If you placed the PEM at /etc/lastlight/app.pem before running install.sh,
# this section locks down its permissions; otherwise it's a no-op.
if [ -f "$PEM_FILE" ]; then
  chown root:"$LASTLIGHT_USER" "$PEM_FILE"
  chmod 0640 "$PEM_FILE"
fi

# ── 7. systemd unit ────────────────────────────────────────────────────────
install -m 0644 \
  "$REPO_DIR/deploy/native/lastlight.service" \
  "/etc/systemd/system/${SERVICE_NAME}.service"
systemctl daemon-reload

# ── 8. Enable + start ──────────────────────────────────────────────────────
systemctl enable "${SERVICE_NAME}"
# Only start/restart if the env file looks configured (the example has the
# string CHANGE_ME everywhere a value is required).
if grep -q '^[A-Z].*=CHANGE_ME' "$ENV_FILE"; then
  echo "  $ENV_FILE still has CHANGE_ME placeholders — not (re)starting the service." >&2
  echo "  Fill in the values and re-run install.sh." >&2
  exit 0
fi
systemctl restart "${SERVICE_NAME}"

# Brief status read-out so the operator sees if it started cleanly.
sleep 2
systemctl status "${SERVICE_NAME}" --no-pager -l | head -20 || true
echo ""
echo "  Live logs:  journalctl -u ${SERVICE_NAME} -f"
