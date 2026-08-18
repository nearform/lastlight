/**
 * The regression guard for interactive-transaction concurrency.
 *
 * Under the old synchronous driver, two named atomic ops physically could not
 * interleave. They can now: drizzle's libsql transactions are real `BEGIN`-held
 * transactions, and two overlapping ones on a single process surface
 * `SQLITE_BUSY` — plus failure modes beyond it (nested BEGIN, shared-handle
 * interleaving). The `busy_timeout` pragma cannot save us because it is
 * connection-scoped and the client swaps connections after each transaction, so
 * the connection-scoped op serializer is the load-bearing defense.
 *
 * These tests are file-backed on the sqlite leg on purpose. `:memory:` cannot
 * surface cross-transaction contention, and is destroyed outright by the first
 * committed transaction (see `tests/helpers/state-db.ts`). They are
 * dialect-neutral by construction — the compare-and-set + rollback contract —
 * so they are in the parameterized set, not the sqlite-only pile.
 *
 * Moved verbatim from the pre-Phase-3 `tests/state/concurrency.test.ts`.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import type { StateDb } from "#src/state/db.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runConcurrencySuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("transaction concurrency", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    async function seedPausedRun(): Promise<{ runId: string; approvalId: string }> {
      const runId = randomUUID();
      const approvalId = randomUUID();
      const now = new Date().toISOString();
      await db.runs.createRun({
        id: runId,
        workflowName: "build",
        triggerId: `acme/widgets#${Math.floor(Math.random() * 100000)}`,
        owner: "acme",
        repo: "widgets",
        currentPhase: "architect",
        status: "running",
        startedAt: now,
      });
      await db.runs.pauseForApproval(
        runId,
        {
          id: approvalId,
          workflowRunId: runId,
          gate: "post_architect",
          summary: "review the plan",
          createdAt: now,
        },
        { phase: "architect", summary: "paused" },
      );
      return { runId, approvalId };
    }

    describe("racing responders on one approval gate", () => {
      it("admits exactly one winner and rolls the loser back", async () => {
        const { runId, approvalId } = await seedPausedRun();

        const results = await Promise.allSettled([
          db.runs.resolveGateAndResume(approvalId, "alice"),
          db.runs.resolveGateAndFail(approvalId, "bob", "changed my mind"),
        ]);

        const fulfilled = results.filter((r) => r.status === "fulfilled");
        const rejected = results.filter((r) => r.status === "rejected");
        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);

        // The loser lost on the compare-and-set, not on a driver-level lock.
        // A SQLITE_BUSY leaking out here means the serializer stopped working and
        // the double-responder guard is being masked by an infrastructure error.
        const reason = String((rejected[0] as PromiseRejectedResult).reason);
        expect(reason).toMatch(/not pending/i);
        expect(reason).not.toMatch(/SQLITE_BUSY/i);

        // Exactly one responder was recorded, and the run agrees with them.
        const approval = await db.approvals.getById(approvalId);
        expect(approval?.status === "approved" || approval?.status === "rejected").toBe(true);
        expect(["alice", "bob"]).toContain(approval?.respondedBy);

        const run = await db.runs.getRun(runId);
        if (approval?.status === "approved") {
          expect(approval.respondedBy).toBe("alice");
          expect(run?.status).toBe("running");
        } else {
          expect(approval?.respondedBy).toBe("bob");
          expect(run?.status).toBe("failed");
        }
      });
    });

    describe("a run transaction racing a team transaction", () => {
      it("survives interleaving on the shared client", async () => {
        // The serializer is per-CONNECTION, not per-store, precisely because these
        // two stores transact on the same libsql client. Racing two RUN ops would
        // still pass under a store-scoped chain and so would prove nothing about
        // the bug this guards.
        const seeded = await Promise.all([seedPausedRun(), seedPausedRun(), seedPausedRun()]);

        const ops: Promise<unknown>[] = [];
        for (const [i, { approvalId }] of seeded.entries()) {
          ops.push(db.runs.resolveGateAndResume(approvalId, `user-${i}`));
          ops.push(
            db.teams.recordResolution({
              login: `login-${i}`,
              teams: [
                {
                  org: "acme",
                  slug: `team-${i}`,
                  name: `Team ${i}`,
                  repos: ["acme/widgets"],
                  truncated: false,
                },
              ],
              status: "ok",
            }),
          );
          ops.push(db.teams.invalidateLogin(`stale-${i}`));
        }

        const results = await Promise.allSettled(ops);
        const failures = results
          .filter((r): r is PromiseRejectedResult => r.status === "rejected")
          .map((r) => String(r.reason));
        expect(failures).toEqual([]);

        // Both stores' writes actually landed — a rolled-back transaction that
        // resolved successfully would be the worse failure.
        for (const [i, { runId }] of seeded.entries()) {
          expect((await db.runs.getRun(runId))?.status).toBe("running");
          const visible = await db.teams.reposForLogin(`login-${i}`);
          expect(visible.repos).toContain("acme/widgets");
        }
      });

      it("keeps the chain alive after an operation rejects", async () => {
        // A rejection must not poison the serializer for everyone queued behind it.
        const { approvalId } = await seedPausedRun();
        await db.runs.resolveGateAndResume(approvalId, "first");

        await expect(db.runs.resolveGateAndResume(approvalId, "second")).rejects.toThrow(
          /not pending/i,
        );

        const { runId: laterRun, approvalId: laterApproval } = await seedPausedRun();
        await db.runs.resolveGateAndResume(laterApproval, "third");
        expect((await db.runs.getRun(laterRun))?.status).toBe("running");
      });
    });

    describe("repeated overlapping pause/resume cycles", () => {
      it("stays clean under sustained contention", async () => {
        // Shakes out intermittent busy errors that a single race can miss.
        for (let batch = 0; batch < 5; batch++) {
          const seeded = await Promise.all([seedPausedRun(), seedPausedRun(), seedPausedRun(), seedPausedRun()]);
          const results = await Promise.allSettled(
            seeded.map(({ approvalId }) => db.runs.resolveGateAndResume(approvalId, "racer")),
          );
          const failures = results
            .filter((r): r is PromiseRejectedResult => r.status === "rejected")
            .map((r) => String(r.reason));
          expect(failures).toEqual([]);
        }
      });
    });
  });
}
