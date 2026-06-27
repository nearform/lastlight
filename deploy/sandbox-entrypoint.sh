#!/usr/bin/env bash
# Sandbox container entrypoint — runs as root after volumes are mounted.
# Used only when LASTLIGHT_SANDBOX=docker (the gondolin sandbox runs in
# process and doesn't go through this script). Fixes permissions, writes
# AGENTS.md, sets up git identity, then drops to the agent user via gosu.
set -euo pipefail

AGENT_HOME="/home/agent"
WORKSPACE="$AGENT_HOME/workspace"
# LASTLIGHT_WORKSPACE and LASTLIGHT_GIT_CREDENTIALS are set as image-level
# ENV in sandbox.Dockerfile so they're visible to every `docker exec` call
# the harness makes (not just the entrypoint's PID-1 tree). They show up in
# this shell's env via that mechanism; no export needed here.

# ── Fix workspace ownership (bind-mounts may be root-owned on macOS) ──
chown -R agent:agent "$WORKSPACE" 2>/dev/null || true
chown agent:agent "$AGENT_HOME"

# Ensure ~/.config exists and is agent-owned before any root-side mkdir
# below claims it (some tools write here at startup).
mkdir -p "$AGENT_HOME/.config"
chown agent:agent "$AGENT_HOME/.config"

# ── Shared package-manager cache (issue #107) ──
# /cache is a Docker named volume shared across every sandbox so npm / pnpm /
# yarn reuse already-downloaded tarballs. A freshly-created volume is root-owned,
# and a cache seeded by an older image (when `agent` had a different UID) leaves
# children owned by the wrong UID — which blocks npm/pnpm/yarn writes (e.g.
# /cache/npm/_logs). Self-heal: if the subdir OR any immediate child isn't
# agent-owned, chown -R it. The recursive pass runs only when something is
# actually wrong, so a warm, correctly-owned cache stays cheap.
if [ -d /cache ]; then
  for sub in npm pnpm yarn uv; do
    mkdir -p "/cache/$sub"
    if [ -n "$(find "/cache/$sub" -maxdepth 1 ! -user agent -print -quit 2>/dev/null)" ]; then
      chown -R agent:agent "/cache/$sub" 2>/dev/null || true
    fi
  done
fi

# ── App PEM: keep shared copy unreadable by the agent by default ──
if [ -f /data/secrets/app.pem ]; then
  chmod 600 /data/secrets/app.pem 2>/dev/null || true
fi

# Optionally materialize an agent-readable PEM for high-trust runs only.
# The harness forwards GITHUB_APP_PRIVATE_KEY_PATH into the sandbox env so
# any tool inside that needs the App key can find it.
if [ "${ALLOW_APP_PEM:-0}" = "1" ] && [ -f /data/secrets/app.pem ]; then
  cp /data/secrets/app.pem "$AGENT_HOME/.config/app.pem"
  chown agent:agent "$AGENT_HOME/.config/app.pem"
  chmod 600 "$AGENT_HOME/.config/app.pem"
  export GITHUB_APP_PRIVATE_KEY_PATH="$AGENT_HOME/.config/app.pem"
else
  export GITHUB_APP_PRIVATE_KEY_PATH=""
fi

# ── AGENTS.md — agentic-pi auto-loads this from cwd as the agent's
# system context (same convention as CLAUDE.md). ──
if [ ! -f "$WORKSPACE/AGENTS.md" ]; then
  cat /app/agent-context/*.md > "$WORKSPACE/AGENTS.md" 2>/dev/null || true
fi
chown agent:agent "$WORKSPACE/AGENTS.md" 2>/dev/null || true

# ── Git identity and auth (system-wide so it applies regardless of exec user) ──
git config --system user.name "last-light[bot]"
git config --system user.email "last-light[bot]@users.noreply.github.com"

if [ -n "${GIT_TOKEN:-}" ]; then
  # Reject tokens containing characters that would break the URL line in
  # the credentials file (newline, '@', ':', '/', whitespace). Real GitHub
  # tokens are alphanumeric + underscore — the wider charset here is
  # defensive against future format changes.
  if ! printf %s "$GIT_TOKEN" | grep -Eq '^[A-Za-z0-9_-]+$'; then
    echo "ERROR: GIT_TOKEN contains characters outside [A-Za-z0-9_-]; refusing to write credentials file" >&2
    exit 1
  fi
  # Write the file as the agent user (mode 600) so the helper can read it
  # after the entrypoint drops privileges. Path is set by us above; the
  # `store --file=<path>` value goes into git's config as argv-split (no
  # shell), so the only constraint is no-whitespace in the path.
  install -m 600 -o agent -g agent /dev/null "$LASTLIGHT_GIT_CREDENTIALS"
  printf 'https://x-access-token:%s@github.com\n' "$GIT_TOKEN" > "$LASTLIGHT_GIT_CREDENTIALS"
  chown agent:agent "$LASTLIGHT_GIT_CREDENTIALS"
  git config --system credential.helper "store --file=$LASTLIGHT_GIT_CREDENTIALS"
fi

# ── Sentinel for harness waitForReady() ──
touch "$WORKSPACE/.ready"
chown agent:agent "$WORKSPACE/.ready"

# ── Drop to agent user ──
exec gosu agent "$@"
