import type { Context } from "hono";
import { recordActivity } from "../activity.js";
import type { ActivityEntry, StateDb, TriggerActorType } from "../state/db.js";
import { actorFromContext, actorTypeFromContext } from "./auth.js";

/**
 * {@link recordActivity} with the actor filled in from the request — the
 * request-scoped half of the activity seam (issue #206).
 *
 * `actorLogin` is left NULL when the session carries no verified login: a
 * password login and an auth-disabled instance both produce that. Deliberately
 * NOT defaulted to `"admin"` the way the `updated_by` columns are — in an audit
 * stream `"admin"` reads as a person, and "we do not know who" is the truer
 * statement. `actor_type` still records `admin`, so the row is not anonymous
 * about HOW it happened, only about who.
 */
export async function recordActivityFor(
  c: Context,
  db: StateDb,
  entry: Omit<ActivityEntry, "actorLogin" | "actorType"> & { actorType?: TriggerActorType },
): Promise<void> {
  await recordActivity(db, {
    ...entry,
    actorLogin: actorFromContext(c) ?? null,
    actorType: entry.actorType ?? actorTypeFromContext(c) ?? null,
  });
}
