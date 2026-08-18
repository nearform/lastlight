import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The store itself doesn't log, but StateDb's siblings do — keep stderr clean.
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { StateDb } from "#src/state/db.js";
import type { FeedbackAnchor, FeedbackAnchorInput } from "#src/state/feedback-store.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});
afterEach(() => {
  db.close();
});

function slackAnchor(over: Partial<FeedbackAnchorInput> = {}): FeedbackAnchor {
  return db.feedback.upsertAnchor({
    source: "slack",
    kind: "slack_message",
    externalId: "1712000000.000100",
    nodeId: null,
    channel: "C123",
    owner: null,
    repo: null,
    issueNumber: null,
    workflowRunId: "run-1",
    workflowName: "answer",
    messagingSessionId: null,
    ...over,
  });
}

function githubAnchor(over: Partial<FeedbackAnchorInput> = {}): FeedbackAnchor {
  return db.feedback.upsertAnchor({
    source: "github",
    kind: "issue_comment",
    externalId: "5139649039",
    nodeId: "IC_kwDO_abc",
    channel: null,
    owner: "nearform",
    repo: "lastlight",
    issueNumber: 255,
    workflowRunId: "run-2",
    workflowName: "pr-review",
    messagingSessionId: null,
    ...over,
  });
}

const rowCount = () =>
  (db.database.prepare("SELECT COUNT(*) AS n FROM feedback_anchors").get() as { n: number }).n;

const thumbsUp = { emoji: "+1", score: 1, sentiment: "good" as const };
const thumbsDown = { emoji: "-1", score: -1, sentiment: "bad" as const };
const eyes = { emoji: "eyes", score: 0, sentiment: "neutral" as const };

describe("anchors", () => {
  it("round-trips a slack anchor and finds it by (channel, ts)", () => {
    const anchor = slackAnchor();
    const found = db.feedback.findAnchor("slack", "C123", "1712000000.000100");
    expect(found).toEqual(anchor);
    expect(found?.workflowRunId).toBe("run-1");
  });

  it("finds a github anchor whose channel is NULL", () => {
    // `channel IS ?` rather than `= ?` — a NULL channel must still match, and
    // SQL equality against NULL never does.
    const anchor = githubAnchor();
    expect(db.feedback.findAnchor("github", null, "5139649039")?.id).toBe(anchor.id);
  });

  it("is idempotent — re-registering the same message keeps one anchor", () => {
    const first = slackAnchor();
    const second = slackAnchor();
    expect(second.id).toBe(first.id);
    expect(rowCount()).toBe(1);
  });

  it("is idempotent for GITHUB anchors too, which have no channel", () => {
    // SQLite treats NULLs as DISTINCT in a UNIQUE constraint, so a nullable
    // `channel` made `ON CONFLICT(source, channel, external_id)` silently
    // inoperative for every GitHub anchor: re-discovering the same comment —
    // which a retried run does, since its `since` window is unchanged — forked
    // a second row that the poller then spent budget on. Hence the '' sentinel.
    const first = githubAnchor();
    const second = githubAnchor();
    expect(second.id).toBe(first.id);
    expect(rowCount()).toBe(1);
  });

  it("keeps the sentinel out of the type callers see", () => {
    expect(githubAnchor().channel).toBeNull();
    expect(slackAnchor().channel).toBe("C123");
  });

  it("does not collide a slack ts with a github id that happens to match", () => {
    githubAnchor({ externalId: "555" });
    slackAnchor({ externalId: "555" });
    expect(rowCount()).toBe(2);
  });

  it("enriches an existing anchor rather than nulling out what it already knows", () => {
    const first = slackAnchor({ workflowRunId: "run-1", workflowName: "answer" });
    const second = slackAnchor({ workflowRunId: null, workflowName: null, messagingSessionId: "exec-9" });
    expect(second.id).toBe(first.id);
    expect(second.workflowRunId).toBe("run-1");
    expect(second.messagingSessionId).toBe("exec-9");
  });
});

describe("signals", () => {
  it("records a new signal and carries the anchor's attribution onto it", () => {
    const anchor = githubAnchor();
    const signal = db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "cliftonc" });
    expect(signal).toMatchObject({
      workflowRunId: "run-2",
      workflowName: "pr-review",
      repo: "lastlight",
      owner: "nearform",
      issueNumber: 255,
      emoji: "+1",
      score: 1,
      exportedAt: null,
    });
  });

  it("returns null on a replay so telemetry fires exactly once", () => {
    const anchor = slackAnchor();
    expect(db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" })).not.toBeNull();
    expect(db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" })).toBeNull();
    expect(db.feedback.list().total).toBe(1);
  });

  it("keeps different reactors and different emoji apart", () => {
    const anchor = slackAnchor();
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U2" });
    db.feedback.recordSignal({ anchor, ...thumbsDown, reactor: "U1" });
    expect(db.feedback.list().total).toBe(3);
  });

  it("retracts rather than deletes, and drops the row from the live list", () => {
    const anchor = slackAnchor();
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
    expect(db.feedback.removeSignal(anchor.id, "U1", "+1")).toBe(true);
    expect(db.feedback.list().total).toBe(0);
    expect(db.feedback.list({ includeRemoved: true }).total).toBe(1);
    // Retracting twice is a no-op, not a second event.
    expect(db.feedback.removeSignal(anchor.id, "U1", "+1")).toBe(false);
  });

  it("revives a retracted signal and re-arms its export", () => {
    const anchor = slackAnchor();
    const first = db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" })!;
    db.feedback.markExported([first.id]);
    db.feedback.removeSignal(anchor.id, "U1", "+1");

    const revived = db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
    expect(revived).not.toBeNull();
    expect(revived!.removedAt).toBeNull();
    expect(revived!.exportedAt).toBeNull();
    expect(db.feedback.list().total).toBe(1);
  });

  it("reconciles an anchor against a fresh read, retracting what has vanished", () => {
    const anchor = githubAnchor();
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "alice" });
    db.feedback.recordSignal({ anchor, ...thumbsDown, reactor: "bob" });

    const removed = db.feedback.reconcileAnchor(anchor.id, [{ reactor: "alice", emoji: "+1" }]);
    expect(removed).toBe(1);
    const live = db.feedback.forRun("run-2");
    expect(live.map((s) => s.reactor)).toEqual(["alice"]);
  });
});

describe("aggregates", () => {
  it("averages over SCORED signals only — 👀 must not drag the mean to zero", () => {
    const anchor = githubAnchor();
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "a" });
    db.feedback.recordSignal({ anchor, emoji: "rocket", score: 2, sentiment: "very_good", reactor: "b" });
    db.feedback.recordSignal({ anchor, ...eyes, reactor: "c" });

    const [row] = db.feedback.summaryByWorkflow(30);
    expect(row).toMatchObject({
      workflowName: "pr-review",
      total: 3,
      positive: 2,
      negative: 0,
      neutral: 1,
      averageScore: 1.5, // (1 + 2) / 2, not (1 + 2 + 0) / 3
    });
  });

  it("excludes retracted signals from the summary", () => {
    const anchor = githubAnchor();
    db.feedback.recordSignal({ anchor, ...thumbsDown, reactor: "a" });
    db.feedback.removeSignal(anchor.id, "a", "-1");
    expect(db.feedback.summaryByWorkflow(30)).toEqual([]);
  });

  it("zero-fills the daily series across the whole window", () => {
    const anchor = githubAnchor();
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "a" });

    const series = db.feedback.dailyScores(7);
    expect(series).toHaveLength(7);
    expect(series.at(-1)).toMatchObject({ total: 1, positive: 1, averageScore: 1 });
    expect(series.slice(0, 6).every((d) => d.total === 0)).toBe(true);
    // Keys are contiguous UTC dates.
    expect(new Set(series.map((d) => d.date)).size).toBe(7);
  });

  it("filters the daily series by workflow", () => {
    db.feedback.recordSignal({ anchor: githubAnchor(), ...thumbsUp, reactor: "a" });
    db.feedback.recordSignal({ anchor: slackAnchor(), ...thumbsUp, reactor: "b" });

    expect(db.feedback.dailyScores(1, "pr-review").at(-1)?.total).toBe(1);
    expect(db.feedback.dailyScores(1, "answer").at(-1)?.total).toBe(1);
    expect(db.feedback.dailyScores(1).at(-1)?.total).toBe(2);
  });
});

describe("polling rotation + retention", () => {
  it("returns never-polled github anchors first, then least-recently-polled", () => {
    const a = githubAnchor({ externalId: "1", nodeId: "IC_1" });
    const b = githubAnchor({ externalId: "2", nodeId: "IC_2" });
    const c = githubAnchor({ externalId: "3", nodeId: "IC_3" });
    db.feedback.markPolled([a.id], "2026-08-01T00:00:00.000Z");
    db.feedback.markPolled([b.id], "2026-08-05T00:00:00.000Z");

    const order = db.feedback.anchorsToPoll({ windowDays: 14, limit: 10 }).map((x) => x.id);
    expect(order).toEqual([c.id, a.id, b.id]);
  });

  it("never polls slack anchors — those arrive live", () => {
    slackAnchor();
    expect(db.feedback.anchorsToPoll({ windowDays: 14, limit: 10 })).toEqual([]);
  });

  it("drops anchors that have aged past the reaction window", () => {
    githubAnchor({ externalId: "old", nodeId: "IC_old", createdAt: "2020-01-01T00:00:00.000Z" });
    const fresh = githubAnchor({ externalId: "new", nodeId: "IC_new" });
    const ids = db.feedback.anchorsToPoll({ windowDays: 14, limit: 10 }).map((x) => x.id);
    expect(ids).toEqual([fresh.id]);
  });

  it("respects the per-tick cap", () => {
    for (let i = 0; i < 5; i++) githubAnchor({ externalId: `c${i}`, nodeId: `IC_${i}` });
    expect(db.feedback.anchorsToPoll({ windowDays: 14, limit: 2 })).toHaveLength(2);
  });

  it("prunes stale anchors but keeps the signals — those are the data", () => {
    const old = githubAnchor({ externalId: "old", createdAt: "2020-01-01T00:00:00.000Z" });
    db.feedback.recordSignal({ anchor: old, ...thumbsUp, reactor: "a" });

    expect(db.feedback.pruneAnchors(90)).toBe(1);
    expect(db.feedback.getAnchor(old.id)).toBeNull();
    expect(db.feedback.list().total).toBe(1);
  });
});

describe("export watermark", () => {
  it("hands out unexported signals and stops once marked", () => {
    const anchor = slackAnchor();
    const s = db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" })!;
    expect(db.feedback.pendingExport().map((x) => x.id)).toEqual([s.id]);
    db.feedback.markExported([s.id]);
    expect(db.feedback.pendingExport()).toEqual([]);
  });

  it("never hands out a signal the reactor already withdrew", () => {
    // Added and retracted while telemetry was off: it has no `exported_at` and
    // a `removed_at`. Exporting it on the backlog drain would put a +1 the
    // person explicitly took back onto the trace, with nothing saying so.
    const anchor = slackAnchor();
    const s = db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" })!;
    db.feedback.removeSignal(anchor.id, "U1", "+1");
    expect(s.exportedAt).toBeNull();
    expect(db.feedback.pendingExport()).toEqual([]);
  });

  it("hands out a signal that was withdrawn and then re-added", () => {
    const anchor = slackAnchor();
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
    db.feedback.removeSignal(anchor.id, "U1", "+1");
    db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
    expect(db.feedback.pendingExport()).toHaveLength(1);
  });
});
