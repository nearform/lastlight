#!/usr/bin/env bash
# Sandbox container entrypoint — runs as root after volumes are mounted.
# Used only when LASTLIGHT_SANDBOX=docker (the gondolin sandbox runs in
# process and doesn't go through this script). Fixes permissions, writes
# AGENTS.md, sets up git identity, then drops to the agent user via gosu.
set -euo pipefail

AGENT_HOME="/home/agent"
WORKSPACE="$AGENT_HOME/workspace"
# LASTLIGHT_WORKSPACE is set as image-level ENV in sandbox.Dockerfile so it's
# visible to every `docker exec` call the harness makes (not just the
# entrypoint's PID-1 tree). It shows up in this shell's env via that
# mechanism; no export needed here. (LASTLIGHT_GIT_CREDENTIALS is now inert —
# git auth comes from GIT_CONFIG_* extraheader env, not a credentials file.)

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

# ── Git identity + auth ──
# Nothing to configure here. The harness sets the bot identity
# (GIT_AUTHOR_*/GIT_COMMITTER_*) and a github.com-scoped `http.extraheader`
# (Basic x-access-token:<token>) via GIT_CONFIG_* env in `agentGitIdentityEnv`,
# which reaches every `docker exec` the harness makes — no on-disk credentials
# file, no --system git config, no charset guard needed. See
# src/sandbox/git-http-auth.ts.

# ── Sentinel for harness waitForReady() ──
touch "$WORKSPACE/.ready"
chown agent:agent "$WORKSPACE/.ready"

# ── Drop to agent user ──
exec gosu agent "$@"
