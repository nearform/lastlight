#!/usr/bin/env bash
# Last Light Docker entrypoint
# Links secrets, ensures state dirs, then starts the harness.
set -euo pipefail

# Secrets live in the consolidated deployment folder (instance/secrets). Fall
# back to the legacy standalone secrets/ mount for pre-migration deployments.
SECRETS="/app/instance/secrets"
[ -d "$SECRETS" ] || SECRETS="/app/secrets"
APP_DIR="/app"
STATE_DIR="${STATE_DIR:-/app/data}"

# Materialize secrets into the writable /app layer, owned by `lastlight` (mode
# 600). We COPY rather than symlink: the source lives on a read-only mount owned
# by whatever uid created it on the host (often 1000), while the harness runs as
# `lastlight` (uid-pinned 10001) via gosu below. A symlink would leave the
# unreadable 600 source in place and the harness would EACCES on it. root (this
# entrypoint, pre-gosu) bypasses the source perms to read+copy; the chown then
# hands the copy to lastlight. Same pattern as the PEM→state-volume copy below.
# rm -f first so a stale symlink from an older image isn't written through.
for f in .env; do
  if [ -f "$SECRETS/$f" ]; then
    rm -f "$APP_DIR/$f"
    cp "$SECRETS/$f" "$APP_DIR/$f"
    chown lastlight:lastlight "$APP_DIR/$f"
    chmod 600 "$APP_DIR/$f"
    echo "Copied $f from secrets volume"
  fi
done

# GitHub App private key(s) — same copy+chown so the in-process Octokit (which
# also runs as lastlight) can read them.
for pem in "$SECRETS"/*.pem; do
  if [ -f "$pem" ]; then
    dest="$APP_DIR/$(basename "$pem")"
    rm -f "$dest"
    cp "$pem" "$dest"
    chown lastlight:lastlight "$dest"
    chmod 600 "$dest"
    echo "Copied $(basename "$pem") from secrets volume"
  fi
done

# Ensure state directory structure exists and is owned by lastlight.
# agent-sessions/ is where agentic-pi's event shim writes JSONL envelopes
# the dashboard reads (path is set by LASTLIGHT_SESSIONS_DIR).
mkdir -p "$STATE_DIR"/{logs,sandboxes,secrets,agent-sessions}
chown -R lastlight:lastlight "$STATE_DIR"

# Copy PEM to the data volume so sandbox containers can access it via shared
# volume (LASTLIGHT_SANDBOX=docker fallback path only — gondolin doesn't go
# through this). Owner is `lastlight` so the host harness (which exec's via
# gosu lastlight below) can read it for in-process GitHub API calls.
# Sandbox-entrypoint runs as root before switching to `agent`, so it can
# still read this 600 file and materialize an agent-readable copy when
# ALLOW_APP_PEM=1.
for pem in "$SECRETS"/*.pem; do
  if [ -f "$pem" ]; then
    cp "$pem" "$STATE_DIR/secrets/app.pem"
    chown lastlight:lastlight "$STATE_DIR/secrets/app.pem"
    chmod 600 "$STATE_DIR/secrets/app.pem"
    echo "Copied PEM to data volume for sandbox access"
    break
  fi
done

# Source .env if available
if [ -f "$APP_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$APP_DIR/.env"
  set +a
fi

# Fix Docker socket permissions — host GID may differ from container docker group
if [ -S /var/run/docker.sock ]; then
  chmod 666 /var/run/docker.sock
fi

echo "Starting Last Light (state: $STATE_DIR)..."
# Drop to non-root before exec'ing the harness.
exec gosu lastlight "$@"
