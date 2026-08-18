import { describe, it, expect, beforeEach } from "vitest";
import { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";

let db: StateDb;

beforeEach(async () => {
  db = await makeTestDb();
});

/**
 * A workflow cron's fire, finished in one call.
 *
 * Deliberately does NOT advance the clock between fires. `start()` stamps
 * `started_at` from the wall clock, so a tight loop like this puts several
 * fires in the SAME millisecond — which is exactly the tie both ordered reads
 * (`latestByCron`, `recentFailures`) have to break correctly. Spacing the
 * fires out would make these tests pass against a broken tiebreak, so the
 * collision is the point.
 */
async function fire(
  cronName: string,
  status: "ok" | "partial" | "failed",
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = await db.cronRuns.start({
    cronName,
    workflow: "dependabot-pr-merge",
    source: "schedule",
    actor: null,
  });
  await db.cronRuns.finish(id, {
    status,
    reposEligible: 19,
    reposScanned: 14,
    discovered: 0,
    dispatched: 0,
    failures: status === "ok" ? 0 : 1,
    ...extra,
  });
  return id;
}

describe("CronRunStore.start / finish", () => {
  it("inserts a running row, then stamps the terminal fields", async () => {
    const id = await db.cronRuns.start({
      cronName: "merge-green-dependency-prs",
      workflow: "dependabot-pr-merge",
      source: "manual",
      actor: "robinbowes",
    });

    let row = (await db.cronRuns.latestByCron()).get("merge-green-dependency-prs")!;
    expect(row.status).toBe("running");
    expect(row.finishedAt).toBeNull();
    expect(row.source).toBe("manual");
    expect(row.actor).toBe("robinbowes");

    await db.cronRuns.finish(id, {
      status: "ok",
      reposEligible: 19,
      reposScanned: 14,
      discovered: 0,
      dispatched: 0,
      failures: 0,
    });

    row = (await db.cronRuns.latestByCron()).get("merge-green-dependency-prs")!;
    expect(row.status).toBe("ok");
    expect(row.finishedAt).not.toBeNull();
    expect(row.reposEligible).toBe(19);
    expect(row.reposScanned).toBe(14);
    // The case the whole feature exists for: a no-op fire is a RECORDED zero,
    // not an absent row.
    expect(row.discovered).toBe(0);
    expect(row.dispatched).toBe(0);
  });

  it("records the error message on a failed fire", async () => {
    const id = await db.cronRuns.start({
      cronName: "c-err",
      workflow: "w",
      source: "schedule",
      actor: null,
    });
    await db.cronRuns.finish(id, { status: "failed", error: "gh down" });

    const row = (await db.cronRuns.latestByCron()).get("c-err")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("gh down");
    expect(row.finishedAt).not.toBeNull();
  });

  it("round-trips a handler cron: handler set, workflow and counts null", async () => {
    const id = await db.cronRuns.start({
      cronName: "repo-digest",
      handler: "repo-digest",
      source: "schedule",
      actor: null,
    });
    await db.cronRuns.finish(id, { status: "ok" });

    const row = (await db.cronRuns.latestByCron()).get("repo-digest")!;
    expect(row.handler).toBe("repo-digest");
    expect(row.workflow).toBeNull();
    // A handler cron dispatches nothing and narrows repos inside itself, so
    // these are null by design, not by omission (design §3).
    expect(row.dispatched).toBeNull();
    expect(row.failures).toBeNull();
    expect(row.reposScanned).toBeNull();
  });
});

describe("CronRunStore.latestByCron", () => {
  it("returns the newest row per cron name", async () => {
    await fire("c1", "ok");
    await fire("c1", "partial");
    await fire("c2", "ok");

    const latest = await db.cronRuns.latestByCron();
    expect(latest.get("c1")!.status).toBe("partial");
    expect(latest.get("c2")!.status).toBe("ok");
  });

  it("is empty before any cron has fired", async () => {
    expect((await db.cronRuns.latestByCron()).size).toBe(0);
  });
});

describe("CronRunStore.recentFailures", () => {
  it("counts consecutive non-ok terminal fires, newest first", async () => {
    await fire("c3", "ok");
    await fire("c3", "failed");
    await fire("c3", "partial");

    // `partial` counts: a fire where dispatches failed is not a healthy fire.
    expect(await db.cronRuns.recentFailures("c3")).toBe(2);
  });

  it("resets to zero once a fire succeeds", async () => {
    await fire("c4", "failed");
    await fire("c4", "failed");
    expect(await db.cronRuns.recentFailures("c4")).toBe(2);

    await fire("c4", "ok");
    expect(await db.cronRuns.recentFailures("c4")).toBe(0);
  });

  it("ignores a still-running fire", async () => {
    await fire("c5", "failed");
    // A fire in flight is not a failure — it must not mask the terminal row
    // beneath it, nor count as one itself.
    await db.cronRuns.start({ cronName: "c5", workflow: "w", source: "schedule", actor: null });

    expect(await db.cronRuns.recentFailures("c5")).toBe(1);
  });

  it("is zero for a cron that has never fired", async () => {
    expect(await db.cronRuns.recentFailures("never-fired")).toBe(0);
  });

  it("does not count another cron's failures", async () => {
    await fire("c6", "failed");
    await fire("c7", "ok");

    expect(await db.cronRuns.recentFailures("c7")).toBe(0);
  });
});
