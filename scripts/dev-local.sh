#!/usr/bin/env bash
# Run the lastlight harness on your local machine without polluting your
# host environment. Defaults to running agent workloads via gondolin (the
# native QEMU sandbox in agentic-pi), so no Docker image is required.
#
# Override LASTLIGHT_SANDBOX before invocation to choose a different
# backend:
#   LASTLIGHT_SANDBOX=none   npm run dev:local   # no isolation (fast iteration)
#   LASTLIGHT_SANDBOX=docker npm run dev:local   # legacy container path
#
set -euo pipefail

# ── Resolve project root regardless of where the script is called from ────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

# ── Local state layout ────────────────────────────────────────────────────
# The harness writes the SQLite DB, sandboxes/, logs/ and the dashboard
# session JSONLs under $STATE_DIR. agent-sessions/ is the directory the
# dashboard reads from (was opencode-home/ pre-refactor).
STATE_DIR_LOCAL="$PROJECT_ROOT/data"
mkdir -p "$STATE_DIR_LOCAL/agent-sessions/projects" "$STATE_DIR_LOCAL/secrets"

# ── Sanity-check the default sandbox backend (gondolin) ──────────────────
LASTLIGHT_SANDBOX="${LASTLIGHT_SANDBOX:-gondolin}"
if [ "$LASTLIGHT_SANDBOX" = "gondolin" ]; then
  if ! command -v qemu-system-x86_64 >/dev/null 2>&1 && ! command -v qemu-system-aarch64 >/dev/null 2>&1; then
    echo "WARNING: LASTLIGHT_SANDBOX=gondolin but no qemu-system-* binary on PATH." >&2
    echo "         Install QEMU (brew install qemu / apt install qemu-system) or" >&2
    echo "         set LASTLIGHT_SANDBOX=none for an unsandboxed run." >&2
  fi
fi
if [ "$LASTLIGHT_SANDBOX" = "docker" ]; then
  if ! docker images -q lastlight-sandbox:latest | grep -q .; then
    echo "ERROR: LASTLIGHT_SANDBOX=docker but lastlight-sandbox:latest is not built." >&2
    echo "       Build it with: docker compose --profile build-only build sandbox-base && docker compose --profile build-only build sandbox" >&2
    exit 1
  fi
fi

# ── Source .env (for GITHUB_APP_* etc.) ───────────────────────────────────
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi

# ── Environment overrides ─────────────────────────────────────────────────
export STATE_DIR="$STATE_DIR_LOCAL"
export LASTLIGHT_SESSIONS_DIR="$STATE_DIR_LOCAL/agent-sessions"
export LASTLIGHT_SANDBOX
# Mirrors STATE_DIR for the docker-mode bind mount.
export SANDBOX_DATA_VOLUME="$STATE_DIR_LOCAL/sandbox-data"

echo "[dev-local] STATE_DIR=$STATE_DIR"
echo "[dev-local] LASTLIGHT_SESSIONS_DIR=$LASTLIGHT_SESSIONS_DIR"
echo "[dev-local] LASTLIGHT_SANDBOX=$LASTLIGHT_SANDBOX"
echo "[dev-local] Starting harness with hot reload..."

exec npx tsx watch src/index.ts
