#!/usr/bin/env bash
# Last Light Docker entrypoint
# Links secrets, ensures state dirs, then starts the harness.
set -euo pipefail

SECRETS="/app/secrets"
APP_DIR="/app"
STATE_DIR="${STATE_DIR:-/app/data}"

# Symlink secrets from mounted volume
for f in .env; do
  if [ -f "$SECRETS/$f" ]; then
    ln -sf "$SECRETS/$f" "$APP_DIR/$f"
    echo "Linked $f from secrets volume"
  fi
done

# Symlink PEM files (GitHub App private key)
for pem in "$SECRETS"/*.pem; do
  if [ -f "$pem" ]; then
    ln -sf "$pem" "$APP_DIR/$(basename "$pem")"
    echo "Linked $(basename "$pem") from secrets volume"
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
