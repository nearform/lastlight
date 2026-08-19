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

# ── What the CALLER asked for, captured before anything defaults it ───────
# Read here, applied after .env is sourced — see the .env block below for why.
# It has to be this early: the gondolin default is applied a few lines down,
# and capturing after that would make "unset" indistinguishable from "the
# default", which would stop .env from ever choosing a backend.
_CALLER_SANDBOX="${LASTLIGHT_SANDBOX:-}"
_CALLER_DEV_DB="${LASTLIGHT_DEV_DB:-}"
_CALLER_DATABASE_URL="${DATABASE_URL:-}"

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
#
# `set -a; source .env` exports every assignment, which means .env OVERWRITES
# anything the caller passed on the command line — the opposite of what every
# dotenv implementation does, and of what this script's own usage lines
# promise (`LASTLIGHT_SANDBOX=none npm run dev:local`). So the caller's values
# for the vars documented as overridable were captured at the top of the script
# and are put back here. Only these three: a blanket "environment always wins"
# would be a larger behavioural change to how .env is read.
if [ -f "$PROJECT_ROOT/.env" ]; then
  set -a
  # shellcheck disable=SC1090,SC1091
  source "$PROJECT_ROOT/.env"
  set +a
fi
[ -n "$_CALLER_SANDBOX" ] && export LASTLIGHT_SANDBOX="$_CALLER_SANDBOX"
[ -n "$_CALLER_DEV_DB" ] && export LASTLIGHT_DEV_DB="$_CALLER_DEV_DB"
[ -n "$_CALLER_DATABASE_URL" ] && export DATABASE_URL="$_CALLER_DATABASE_URL"

# ── State database ────────────────────────────────────────────────────────
# SQLite ($STATE_DIR/lastlight.db) by default — nothing to run.
#
# `LASTLIGHT_DEV_DB=postgres` instead points the harness at the compose
# `postgres` profile (docker-compose.yml), which is the same Postgres runtime
# production would use. Start it first:
#
#   pnpm --filter lastlight-core dev:db:up
#   pnpm --filter lastlight-core dev:db:migrate   # copy your SQLite data across
#
# An explicit DATABASE_URL (from .env or the environment) always wins — this
# only fills in the URL for the local container so nobody has to remember the
# port. Sourced .env has already been applied above.
DEV_PG_URL="postgres://${POSTGRES_USER:-lastlight}:${POSTGRES_PASSWORD:-lastlight}@127.0.0.1:${POSTGRES_PORT:-55432}/${POSTGRES_DB:-lastlight}"
if [ -z "${DATABASE_URL:-}" ] && [ "${LASTLIGHT_DEV_DB:-sqlite}" = "postgres" ]; then
  export DATABASE_URL="$DEV_PG_URL"
fi

if [ -n "${DATABASE_URL:-}" ] && [[ "$DATABASE_URL" =~ ^postgres ]]; then
  # Fail EARLY and with the fix in the message. Without this the harness boots,
  # the migrator dials a closed port, and the error is a wrapped
  # "Failed query: CREATE SCHEMA IF NOT EXISTS drizzle" several lines deep.
  PG_PORT="${POSTGRES_PORT:-55432}"
  if ! nc -z 127.0.0.1 "$PG_PORT" 2>/dev/null; then
    echo "ERROR: DATABASE_URL is Postgres but nothing is listening on 127.0.0.1:$PG_PORT." >&2
    echo "       Start it with: pnpm --filter lastlight-core dev:db:up" >&2
    echo "       (or set LASTLIGHT_DEV_DB=sqlite / unset DATABASE_URL to use the file)" >&2
    exit 1
  fi
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
# Never echo DATABASE_URL raw — it carries a password. The harness logs the
# redacted form itself at boot.
if [ -n "${DATABASE_URL:-}" ]; then
  echo "[dev-local] DATABASE_URL=$(printf '%s' "$DATABASE_URL" | sed -E 's#://[^@/]*@#://***:***@#')"
else
  echo "[dev-local] DATABASE_URL=(unset — SQLite at \$STATE_DIR/lastlight.db)"
fi
echo "[dev-local] Starting harness with hot reload..."

exec npx tsx watch src/index.ts
