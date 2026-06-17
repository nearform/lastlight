#!/usr/bin/env bash
#
# cleanup-sandboxes.sh — prune stale per-task sandbox workspaces.
#
# Every agent task clones the target repo into $STATE_DIR/sandboxes/<taskId>/.
# The harness tears down the sandbox *container* when a task finishes but never
# the on-disk clone (see createTaskSandbox in src/sandbox/index.ts — its
# `cleanup` only calls sandbox.destroy(taskId)). Each taskId is unique, so these
# workspaces accumulate without bound — on prod they had grown to ~34G across
# 700+ dirs. This script removes workspace dirs whose contents were last
# modified more than RETENTION_DAYS ago, leaving recent and in-flight tasks
# untouched (tasks complete in minutes/hours, never days).
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
# Suggested cron on the host (daily 04:00, keep last 1 day):
#   0 4 * * * cd /home/lastlight/lastlight && docker compose exec -T agent bash -s < scripts/cleanup-sandboxes.sh >> /var/log/cleanup-sandboxes.log 2>&1
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
