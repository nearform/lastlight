import { logger } from "./logging/logger.js";
import type { ActivityEntry, StateDb } from "./state/db.js";

const log = logger("activity");

/**
 * Append one activity row, BEST-EFFORT (issue #206).
 *
 * This is the entire best-effort contract, and it lives here rather than in
 * `ActivityStore.record` on purpose: the store throws like any other store
 * method, so a test can still observe a write failing. Swallowing inside the
 * store would make "a logging failure never fails the action" unfalsifiable.
 *
 * The rule it enforces: **recording that something happened must never stop it
 * from happening.** Same posture as #205's identity capture and every read in
 * `pr-state.ts` — an audit trail is worth less than the action it describes.
 *
 * Lives at `src/` rather than under `admin/` because every layer writes to it:
 * the admin routes, `dispatchWorkflow` in `index.ts`, the dispatcher's approval
 * seam and the cron runner. `admin/activity.ts` adds the Hono-flavoured wrapper
 * on top for the request-scoped case.
 */
export async function recordActivity(db: StateDb, entry: ActivityEntry): Promise<void> {
  try {
    await db.activity.record(entry);
  } catch (err) {
    log.warn("activity write failed", { err, action: entry.action, target: entry.targetId });
  }
}
