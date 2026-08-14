import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateDb } from "#src/state/db.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** A workflow cron's fire, finished in one call. */
function fire(
  cronName: string,
  status: "ok" | "partial" | "failed",
  extra: Record<string, unknown> = {},
): string {
  const id = db.cronRuns.start({
    cronName,
    workflow: "dependabot-pr-merge",
    source: "schedule",
    actor: null,
  });
  db.cronRuns.finish(id, {
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
  it("inserts a running row, then stamps the terminal fields", () => {
    const id = db.cronRuns.start({
      cronName: "merge-green-dependency-prs",
      workflow: "dependabot-pr-merge",
      source: "manual",
      actor: "robinbowes",
    });

    let row = db.cronRuns.latestByCron().get("merge-green-dependency-prs")!;
    expect(row.status).toBe("running");
    expect(row.finishedAt).toBeNull();
    expect(row.source).toBe("manual");
    expect(row.actor).toBe("robinbowes");

    db.cronRuns.finish(id, {
      status: "ok",
      reposEligible: 19,
      reposScanned: 14,
      discovered: 0,
      dispatched: 0,
      failures: 0,
    });

    row = db.cronRuns.latestByCron().get("merge-green-dependency-prs")!;
    expect(row.status).toBe("ok");
    expect(row.finishedAt).not.toBeNull();
    expect(row.reposEligible).toBe(19);
    expect(row.reposScanned).toBe(14);
    // The case the whole feature exists for: a no-op fire is a RECORDED zero,
    // not an absent row.
    expect(row.discovered).toBe(0);
    expect(row.dispatched).toBe(0);
  });

  it("records the error message on a failed fire", () => {
    const id = db.cronRuns.start({
      cronName: "c-err",
      workflow: "w",
      source: "schedule",
      actor: null,
    });
    db.cronRuns.finish(id, { status: "failed", error: "gh down" });

    const row = db.cronRuns.latestByCron().get("c-err")!;
    expect(row.status).toBe("failed");
    expect(row.error).toContain("gh down");
    expect(row.finishedAt).not.toBeNull();
  });

  it("round-trips a handler cron: handler set, workflow and counts null", () => {
    const id = db.cronRuns.start({
      cronName: "repo-digest",
      handler: "repo-digest",
      source: "schedule",
      actor: null,
    });
    db.cronRuns.finish(id, { status: "ok" });

    const row = db.cronRuns.latestByCron().get("repo-digest")!;
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
  it("returns the newest row per cron name", () => {
    fire("c1", "ok");
    fire("c1", "partial");
    fire("c2", "ok");

    const latest = db.cronRuns.latestByCron();
    expect(latest.get("c1")!.status).toBe("partial");
    expect(latest.get("c2")!.status).toBe("ok");
  });

  it("is empty before any cron has fired", () => {
    expect(db.cronRuns.latestByCron().size).toBe(0);
  });
});

describe("CronRunStore.recentFailures", () => {
  it("counts consecutive non-ok terminal fires, newest first", () => {
    fire("c3", "ok");
    fire("c3", "failed");
    fire("c3", "partial");

    // `partial` counts: a fire where dispatches failed is not a healthy fire.
    expect(db.cronRuns.recentFailures("c3")).toBe(2);
  });

  it("resets to zero once a fire succeeds", () => {
    fire("c4", "failed");
    fire("c4", "failed");
    expect(db.cronRuns.recentFailures("c4")).toBe(2);

    fire("c4", "ok");
    expect(db.cronRuns.recentFailures("c4")).toBe(0);
  });

  it("ignores a still-running fire", () => {
    fire("c5", "failed");
    // A fire in flight is not a failure — it must not mask the terminal row
    // beneath it, nor count as one itself.
    db.cronRuns.start({ cronName: "c5", workflow: "w", source: "schedule", actor: null });

    expect(db.cronRuns.recentFailures("c5")).toBe(1);
  });

  it("is zero for a cron that has never fired", () => {
    expect(db.cronRuns.recentFailures("never-fired")).toBe(0);
  });

  it("does not count another cron's failures", () => {
    fire("c6", "failed");
    fire("c7", "ok");

    expect(db.cronRuns.recentFailures("c7")).toBe(0);
  });
});
