#!/usr/bin/env bash
# Sandbox container entrypoint — runs as root after volumes are mounted.
# Sets up permissions, OpenCode workspace files (AGENTS.md + opencode.json),
# git identity, then drops to the agent user via gosu.
set -euo pipefail

AGENT_HOME="/home/agent"
WORKSPACE="$AGENT_HOME/workspace"

# ── Fix workspace ownership (bind-mounts may be root-owned on macOS) ──
chown -R agent:agent "$WORKSPACE" 2>/dev/null || true
chown agent:agent "$AGENT_HOME"

# ── App PEM: keep shared copy unreadable by the agent by default ──
if [ -f /data/secrets/app.pem ]; then
  chmod 600 /data/secrets/app.pem 2>/dev/null || true
fi

# Optionally materialize an agent-readable PEM for high-trust runs only.
# Path is referenced by deploy/opencode-config.tmpl.json via ${GITHUB_APP_PRIVATE_KEY_PATH}.
if [ "${ALLOW_APP_PEM:-0}" = "1" ] && [ -f /data/secrets/app.pem ]; then
  mkdir -p "$AGENT_HOME/.config"
  cp /data/secrets/app.pem "$AGENT_HOME/.config/app.pem"
  chown agent:agent "$AGENT_HOME/.config/app.pem"
  chmod 600 "$AGENT_HOME/.config/app.pem"
  export GITHUB_APP_PRIVATE_KEY_PATH="$AGENT_HOME/.config/app.pem"
else
  export GITHUB_APP_PRIVATE_KEY_PATH=""
fi

# ── AGENTS.md (the OpenCode equivalent of CLAUDE.md, auto-loaded from cwd) ──
cat /app/agent-context/*.md > "$WORKSPACE/AGENTS.md" 2>/dev/null || true
chown agent:agent "$WORKSPACE/AGENTS.md" 2>/dev/null || true

# ── opencode.json — MCP config from template ──
envsubst '$GITHUB_APP_ID $GITHUB_APP_INSTALLATION_ID $GITHUB_APP_PRIVATE_KEY_PATH $GITHUB_TOKEN' \
  < /app/opencode-config.tmpl.json > "$WORKSPACE/opencode.json"
chown agent:agent "$WORKSPACE/opencode.json"

# ── Git identity and auth (system-wide so it applies regardless of exec user) ──
git config --system user.name "last-light[bot]"
git config --system user.email "last-light[bot]@users.noreply.github.com"

if [ -n "${GIT_TOKEN:-}" ]; then
  git config --system credential.helper \
    '!f() { echo "username=x-access-token"; echo "password='"$GIT_TOKEN"'"; }; f'
fi

# ── Sentinel for harness waitForReady() ──
touch "$WORKSPACE/.ready"
chown agent:agent "$WORKSPACE/.ready"

# ── Drop to agent user ──
exec gosu agent "$@"
