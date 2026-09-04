/**
 * `ActivityStore` — the one-row-per-action audit stream (issue #206).
 *
 * Two things here are dialect guards rather than ordinary coverage, and both
 * are the reason these bodies live in a suite instead of a `*.test.ts`:
 *
 * 1. **`detail` round-tripping.** It is `text({ mode: "json" })` on sqlite and
 *    real `jsonb` on Postgres — the exact divergence `client.ts` warns runs
 *    `JSON.parse` over an already-parsed object when a store resolves its
 *    tables from the wrong schema. Only the PGlite leg can catch that.
 * 2. **The same-millisecond page boundary.** `created_at` is millisecond
 *    resolution, so a burst of writes ties; the reads break it on the
 *    creation-ordered `id` rather than sqlite's `rowid`, which Postgres has no
 *    equivalent of. The deliberate collision below is what makes that a test.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runActivitySuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("ActivityStore", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    describe("ActivityStore.record", () => {
      it("round-trips every field, including a json detail", async () => {
        await db.activity.record({
          actorLogin: "octocat",
          actorType: "github",
          action: "cron.toggle",
          targetType: "cron",
          targetId: "merge-green-dependency-prs",
          outcome: "ok",
          detail: { enabled: false, schedule: "0 14 * * *", attempts: 3 },
        });

        const { activity, total } = await db.activity.list();
        expect(total).toBe(1);
        expect(activity[0]).toMatchObject({
          actorLogin: "octocat",
          actorType: "github",
          action: "cron.toggle",
          targetType: "cron",
          targetId: "merge-green-dependency-prs",
          outcome: "ok",
        });
        // The dialect-divergent column: `text` here, `jsonb` on Postgres. A
        // store that resolved its tables from the wrong schema would hand back
        // a string on one leg and an object on the other.
        expect(activity[0].detail).toEqual({
          enabled: false,
          schedule: "0 14 * * *",
          attempts: 3,
        });
        expect(activity[0].id).toBeTruthy();
        expect(activity[0].createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      });

      it("defaults outcome to ok and leaves absent fields undefined, not null", async () => {
        await db.activity.record({ action: "login" });

        const { activity } = await db.activity.list();
        expect(activity[0].outcome).toBe("ok");
        // `nullsToUndefined` at the store boundary — a caller checking
        // `=== undefined` must not meet a null.
        expect(activity[0].actorLogin).toBeUndefined();
        expect(activity[0].actorType).toBeUndefined();
        expect(activity[0].targetType).toBeUndefined();
        expect(activity[0].detail).toBeUndefined();
      });

      it("records a denied outcome with no actor — the password-login shape", async () => {
        await db.activity.record({ action: "login", actorType: "admin", outcome: "denied" });

        const { activity } = await db.activity.list();
        expect(activity[0].outcome).toBe("denied");
        expect(activity[0].actorLogin).toBeUndefined();
      });
    });

    describe("ActivityStore.list", () => {
      /**
       * Deliberately does NOT advance the clock between writes. `record()`
       * stamps `created_at` from the wall clock, so a tight loop puts every row
       * in the same millisecond — which is the tie the paged read has to break
       * correctly. Spacing the writes out would make the pagination test pass
       * against a broken tiebreak, so the collision is the point.
       */
      async function seed(n: number, action: "login" | "cron.fire" = "cron.fire") {
        for (let i = 0; i < n; i++) {
          await db.activity.record({
            actorLogin: i % 2 === 0 ? "alice" : "bob",
            actorType: "github",
            action,
            targetType: "cron",
            targetId: `cron-${i}`,
          });
        }
      }

      it("returns newest first with the post-filter total", async () => {
        await seed(3);
        const { activity, total } = await db.activity.list({ limit: 2 });
        expect(total).toBe(3);
        expect(activity).toHaveLength(2);
        // Newest first: the last-seeded row wins, and within the millisecond
        // tie the creation-ordered id decides.
        expect(activity[0].targetId).toBe("cron-2");
        expect(activity[1].targetId).toBe("cron-1");
      });

      it("pages a same-millisecond burst without skipping or repeating a row", async () => {
        await seed(10);

        const first = await db.activity.list({ limit: 4, offset: 0 });
        const second = await db.activity.list({ limit: 4, offset: 4 });
        const third = await db.activity.list({ limit: 4, offset: 8 });

        const ids = [...first.activity, ...second.activity, ...third.activity].map((r) => r.id);
        expect(ids).toHaveLength(10);
        expect(new Set(ids).size).toBe(10);
        expect(first.total).toBe(10);
      });

      it("filters by actor, action, target and since", async () => {
        await seed(4, "cron.fire");
        await db.activity.record({
          actorLogin: "alice",
          actorType: "cli",
          action: "workflow.cancel",
          targetType: "workflow_run",
          targetId: "run-1",
        });

        const byActor = await db.activity.list({ actor: "alice" });
        expect(byActor.total).toBe(3); // cron-0, cron-2, and the cancel
        expect(byActor.activity.every((r) => r.actorLogin === "alice")).toBe(true);

        const byAction = await db.activity.list({ action: "workflow.cancel" });
        expect(byAction.total).toBe(1);
        expect(byAction.activity[0].targetId).toBe("run-1");

        const byTarget = await db.activity.list({
          targetType: "workflow_run",
          targetId: "run-1",
        });
        expect(byTarget.total).toBe(1);

        const sinceFuture = await db.activity.list({ sinceIso: "2999-01-01T00:00:00.000Z" });
        expect(sinceFuture.total).toBe(0);
        expect(sinceFuture.activity).toEqual([]);

        const sincePast = await db.activity.list({ sinceIso: "2000-01-01T00:00:00.000Z" });
        expect(sincePast.total).toBe(5);
      });

      it("combines filters, and total reflects the filter rather than the page", async () => {
        await seed(6);
        const { activity, total } = await db.activity.list({
          actor: "alice",
          action: "cron.fire",
          limit: 1,
        });
        expect(total).toBe(3); // alice wrote cron-0, cron-2, cron-4
        expect(activity).toHaveLength(1); // …but asked for one
      });
    });

    describe("ActivityStore.actions", () => {
      it("returns the distinct verbs present, sorted", async () => {
        await db.activity.record({ action: "login" });
        await db.activity.record({ action: "cron.fire" });
        await db.activity.record({ action: "cron.fire" });
        await db.activity.record({ action: "workflow.cancel" });

        expect(await db.activity.actions()).toEqual(["cron.fire", "login", "workflow.cancel"]);
      });

      it("is empty on an empty table", async () => {
        expect(await db.activity.actions()).toEqual([]);
      });
    });
  });
}
