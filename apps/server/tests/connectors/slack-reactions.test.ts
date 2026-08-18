import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

// Telemetry export is covered by tests/telemetry/feedback.test.ts; here we only
// care that ingest reaches it exactly once per NEW signal.
const emitted = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("#src/telemetry/feedback.js", () => ({
  recordFeedbackSignal: (input: unknown) => {
    emitted.calls.push(input);
  },
}));

// `isTelemetryEnabled` is module state owned by the real SDK boot; override it
// so the export path runs without starting an exporter.
const telemetry = vi.hoisted(() => ({ enabled: true }));
vi.mock("#src/telemetry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/telemetry/index.js")>();
  return { ...actual, isTelemetryEnabled: () => telemetry.enabled };
});

import { StateDb } from "#src/state/db.js";
import {
  handleSlackReaction,
  registerSlackAnchor,
  type SlackReactionEvent,
} from "#src/engine/feedback/slack.js";
import { drainFeedbackExport } from "#src/engine/feedback/ingest.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
  emitted.calls = [];
  telemetry.enabled = true;
});
afterEach(() => {
  db.close();
});

const CHANNEL = "C0FEED";
const TS = "1754472600.000100";

function anchorFor(over: Parameters<typeof registerSlackAnchor>[1] | object = {}) {
  return registerSlackAnchor(db, {
    channelId: CHANNEL,
    threadId: "1754472500.000100",
    messageId: TS,
    workflowRunId: "run-1",
    workflowName: "answer",
    ...over,
  });
}

function reaction(over: Partial<SlackReactionEvent> = {}): SlackReactionEvent {
  return {
    type: "reaction_added",
    user: "U_HUMAN",
    reaction: "+1",
    item_user: "U_BOT",
    item: { type: "message", channel: CHANNEL, ts: TS },
    event_ts: "1754472700.000200",
    ...over,
  };
}

const deps = () => ({ db, botLogin: "last-light[bot]" });

describe("registerSlackAnchor", () => {
  it("makes a posted message findable by (channel, ts)", () => {
    const anchor = anchorFor();
    expect(anchor).not.toBeNull();
    expect(db.feedback.findAnchor("slack", CHANNEL, TS)?.workflowRunId).toBe("run-1");
  });
});

describe("handleSlackReaction", () => {
  it("scores a 👍 against the run that posted the message", () => {
    anchorFor();
    expect(handleSlackReaction(deps(), reaction())).toBe(true);

    const { signals } = db.feedback.list();
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      source: "slack",
      emoji: "+1",
      score: 1,
      sentiment: "good",
      reactor: "U_HUMAN",
      workflowRunId: "run-1",
      workflowName: "answer",
    });
  });

  it("dates the signal from the reaction's own Slack timestamp", () => {
    anchorFor();
    handleSlackReaction(deps(), reaction());
    // 1754472700 epoch seconds — a Slack ts is an id that sorts by time, not a date.
    expect(db.feedback.list().signals[0]!.reactedAt).toBe(
      new Date(1754472700 * 1000).toISOString(),
    );
  });

  it("folds skin tones and aliases before scoring", () => {
    anchorFor();
    handleSlackReaction(deps(), reaction({ reaction: "thumbsup::skin-tone-4" }));
    expect(db.feedback.list().signals[0]).toMatchObject({ emoji: "+1", score: 1 });
  });

  it("records 👀 without scoring it", () => {
    anchorFor();
    handleSlackReaction(deps(), reaction({ reaction: "eyes" }));
    expect(db.feedback.list().signals[0]).toMatchObject({ score: 0, sentiment: "neutral" });
  });

  it("drops a reaction on a message we never posted", () => {
    // No anchor registered — the overwhelmingly common case in a busy channel.
    expect(handleSlackReaction(deps(), reaction())).toBe(false);
    expect(db.feedback.list().total).toBe(0);
    expect(emitted.calls).toHaveLength(0);
  });

  it("drops an emoji outside the vocabulary", () => {
    anchorFor();
    expect(handleSlackReaction(deps(), reaction({ reaction: "pizza" }))).toBe(false);
    expect(db.feedback.list().total).toBe(0);
  });

  it("ignores reactions on non-message items", () => {
    anchorFor();
    const onFile = reaction({ item: { type: "file", channel: CHANNEL, ts: TS } });
    expect(handleSlackReaction(deps(), onFile)).toBe(false);
  });

  it("honours the SLACK_ALLOWED_USERS allowlist", () => {
    anchorFor();
    const gated = { ...deps(), allowedUsers: ["U_SOMEONE_ELSE"] };
    expect(handleSlackReaction(gated, reaction())).toBe(false);
    expect(db.feedback.list().total).toBe(0);

    const permitted = { ...deps(), allowedUsers: ["U_HUMAN"] };
    expect(handleSlackReaction(permitted, reaction())).toBe(true);
  });

  it("retracts on reaction_removed, keeping the row", () => {
    anchorFor();
    handleSlackReaction(deps(), reaction());
    expect(handleSlackReaction(deps(), reaction({ type: "reaction_removed" }))).toBe(true);

    expect(db.feedback.list().total).toBe(0);
    expect(db.feedback.list({ includeRemoved: true }).total).toBe(1);
  });

  it("is idempotent under Slack's at-least-once redelivery", () => {
    anchorFor();
    expect(handleSlackReaction(deps(), reaction())).toBe(true);
    expect(handleSlackReaction(deps(), reaction())).toBe(false);
    expect(db.feedback.list().total).toBe(1);
    // And the duplicate must not double-count in the telemetry backend.
    expect(emitted.calls).toHaveLength(1);
  });

  it("exports each new signal to OTel exactly once and marks the watermark", () => {
    anchorFor();
    handleSlackReaction(deps(), reaction());
    expect(emitted.calls).toHaveLength(1);
    expect(db.feedback.pendingExport()).toEqual([]);
  });

  it("skips the OTel export when feedback.otel is off, but still records", () => {
    anchorFor();
    handleSlackReaction({ ...deps(), otel: false }, reaction());
    expect(emitted.calls).toHaveLength(0);
    expect(db.feedback.list().total).toBe(1);
  });

  it("leaves the watermark UNSET when telemetry is off, so the signal can be exported later", () => {
    // Marking it exported here would silently discard it: switching OTel on
    // tomorrow would find an empty backlog and every pre-OTel signal would be
    // missing from the backend forever.
    telemetry.enabled = false;
    anchorFor();
    handleSlackReaction(deps(), reaction());
    expect(emitted.calls).toHaveLength(0);
    expect(db.feedback.pendingExport()).toHaveLength(1);
  });
});

describe("drainFeedbackExport", () => {
  it("exports the backlog once telemetry is switched on", () => {
    telemetry.enabled = false;
    anchorFor();
    handleSlackReaction(deps(), reaction());
    expect(emitted.calls).toHaveLength(0);

    telemetry.enabled = true;
    expect(drainFeedbackExport(db)).toBe(1);
    expect(emitted.calls).toHaveLength(1);
    expect(db.feedback.pendingExport()).toEqual([]);
    // Idempotent: a second boot has nothing left to do.
    expect(drainFeedbackExport(db)).toBe(0);
  });

  it("does not backfill a reaction the person withdrew before OTel was enabled", () => {
    // The one route this was reachable through: the live path can't export a
    // retraction, so only the drain could have put a withdrawn +1 on a trace.
    telemetry.enabled = false;
    const anchor = anchorFor()!;
    handleSlackReaction(deps(), reaction());
    handleSlackReaction(deps(), reaction({ type: "reaction_removed" }));

    telemetry.enabled = true;
    expect(drainFeedbackExport(db)).toBe(0);
    expect(emitted.calls).toHaveLength(0);
    expect(anchor).not.toBeNull();
  });

  it("does nothing while telemetry is still off", () => {
    telemetry.enabled = false;
    anchorFor();
    handleSlackReaction(deps(), reaction());
    expect(drainFeedbackExport(db)).toBe(0);
    expect(db.feedback.pendingExport()).toHaveLength(1);
  });

  it("retires a signal whose anchor has been pruned rather than re-reading it every boot", () => {
    telemetry.enabled = false;
    const anchor = anchorFor()!;
    handleSlackReaction(deps(), reaction());
    db.database.prepare("DELETE FROM feedback_anchors WHERE id = ?").run(anchor.id);

    telemetry.enabled = true;
    expect(drainFeedbackExport(db)).toBe(0);
    expect(emitted.calls).toHaveLength(0);
    expect(db.feedback.pendingExport()).toEqual([]);
  });

  it("ignores a malformed payload rather than throwing into the webhook", () => {
    expect(handleSlackReaction(deps(), { type: "reaction_added" })).toBe(false);
    expect(handleSlackReaction(deps(), reaction({ item: undefined }))).toBe(false);
  });
});

describe("chat-turn attribution", () => {
  it("attributes a reaction on a chat reply to its messaging session", () => {
    // How `src/index.ts` registers a chat reply: no run, but a named surface.
    registerSlackAnchor(db, {
      channelId: CHANNEL,
      messageId: TS,
      messagingSessionId: "session-7",
      workflowName: "chat",
    });
    handleSlackReaction(deps(), reaction());
    expect(db.feedback.list().signals[0]).toMatchObject({
      messagingSessionId: "session-7",
      workflowRunId: null,
      workflowName: "chat",
    });
  });

  it("gives chat its own row in the leaderboard rather than lumping it into 'unattributed'", () => {
    registerSlackAnchor(db, {
      channelId: CHANNEL,
      messageId: TS,
      messagingSessionId: "session-7",
      workflowName: "chat",
    });
    handleSlackReaction(deps(), reaction());
    expect(db.feedback.summaryByWorkflow(30)).toEqual([
      { workflowName: "chat", total: 1, positive: 1, negative: 0, neutral: 0, averageScore: 1 },
    ]);
  });
});
