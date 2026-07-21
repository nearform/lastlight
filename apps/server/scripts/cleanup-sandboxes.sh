#!/usr/bin/env bash
#
# cleanup-sandboxes.sh — MANUAL emergency prune of stale sandbox workspaces.
#
# NOTE (issue #106): the harness now owns sandbox-workspace reaping. It reaps an
# ephemeral run's clone on terminal success (workflows/simple.ts), reaps on
# admin cancel, and runs an hourly in-harness TTL + LRU sweep
# (src/cron/sandbox-sweep.ts, config `cleanup.sandbox.*`) that skips live
# containers. This script and its host cron are RETIRED — keep it only as a
# manual break-glass tool for an operator who needs to force a prune out-of-band
# (e.g. before the next hourly sweep fires). Do NOT reinstall it as a host cron.
#
# Every agent task clones the target repo into $STATE_DIR/sandboxes/<taskId>/.
# This script removes workspace dirs whose contents were last modified more than
# RETENTION_DAYS ago, leaving recent and in-flight tasks untouched.
#
# Caveat: GNU `find -mtime +N` keeps ~(N+1)*24h (day-count truncation), so
# RETENTION_DAYS=1 effectively retains ~48h — the in-harness sweep uses an
# explicit hours-based age check instead. Prefer the harness sweep; use this
# only to force an immediate prune.
#
# Run it inside the agent container, where $STATE_DIR/sandboxes lives on the
# named `agent-data` volume. The image doesn't bake scripts/, so pipe it in:
#
#   cd /home/lastlight/lastlight
#   docker compose exec -T agent bash -s < scripts/cleanup-sandboxes.sh
#
# Preview without deleting, or change the window:
#
#   docker compose exec -e DRY_RUN=1 -T agent bash -s < scripts/cleanup-sandboxes.sh
#   docker compose exec -e RETENTION_DAYS=7 -T agent bash -s < scripts/cleanup-sandboxes.sh
#
set -euo pipefail

SANDBOX_DIR="${SANDBOX_DIR:-${STATE_DIR:-/app/data}/sandboxes}"
RETENTION_DAYS="${RETENTION_DAYS:-1}"
DRY_RUN="${DRY_RUN:-0}"

if [ ! -d "$SANDBOX_DIR" ]; then
  echo "[cleanup-sandboxes] no sandbox dir at $SANDBOX_DIR — nothing to do"
  exit 0
fi

before=$(du -sh "$SANDBOX_DIR" 2>/dev/null | cut -f1)
stale_count=$(find "$SANDBOX_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" | wc -l | tr -d ' ')

echo "[cleanup-sandboxes] dir=$SANDBOX_DIR retention=${RETENTION_DAYS}d dry_run=$DRY_RUN total=${before:-?} stale=$stale_count"

if [ "$stale_count" -eq 0 ]; then
  echo "[cleanup-sandboxes] nothing older than ${RETENTION_DAYS}d — done"
  exit 0
fi

find "$SANDBOX_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" -print | sort

if [ "$DRY_RUN" = "1" ]; then
  echo "[cleanup-sandboxes] DRY_RUN=1 — no changes made"
  exit 0
fi

find "$SANDBOX_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+${RETENTION_DAYS}" -exec rm -rf {} +

after=$(du -sh "$SANDBOX_DIR" 2>/dev/null | cut -f1)
echo "[cleanup-sandboxes] removed $stale_count workspace(s); total ${before:-?} -> ${after:-?}"
