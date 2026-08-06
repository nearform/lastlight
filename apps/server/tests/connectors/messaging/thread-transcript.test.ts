import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";

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

import { SessionManager } from "#src/connectors/messaging/session-manager.js";
import {
  withThreadTranscript,
  recordThreadMessage,
  recordThreadMessageForThread,
  MAX_TRANSCRIPT_CHARS,
} from "#src/connectors/messaging/thread-transcript.js";
import type { EventEnvelope } from "#src/connectors/types.js";

const KEY = {
  platform: "slack",
  channelId: "C123",
  threadId: "thread-1",
  userId: "U999",
};

function makeMessageEnvelope(
  sessionId: string | undefined,
  overrides: Partial<EventEnvelope> = {},
): EventEnvelope {
  return {
    id: "slack-1",
    source: "slack",
    type: "message",
    sender: "clifton",
    senderIsBot: false,
    body: "how does the sandbox work in cliftonc/lastlight?",
    raw: { sessionId, channelId: KEY.channelId, threadId: KEY.threadId },
    reply: vi.fn().mockResolvedValue(undefined),
    timestamp: new Date(),
    ...overrides,
  };
}

describe("thread transcript", () => {
  let db: Database.Database;
  let manager: SessionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("withThreadTranscript", () => {
    it("records the inbound message and every reply on the thread's session", async () => {
      const session = manager.getOrCreateSession(KEY);
      const envelope = makeMessageEnvelope(session.id);

      const wrapped = withThreadTranscript(envelope, manager);
      await wrapped.reply("Starting *answer*...");
      await wrapped.reply("*answer* completed.");

      expect(manager.getHistory(session.id).map((h) => [h.role, h.content])).toEqual([
        ["user", "how does the sandbox work in cliftonc/lastlight?"],
        ["assistant", "Starting *answer*..."],
        ["assistant", "*answer* completed."],
      ]);
      // Still actually replies — the transcript is a side effect, not a
      // replacement transport.
      expect(envelope.reply).toHaveBeenCalledTimes(2);
    });

    it("leaves a non-messaging envelope untouched", () => {
      const envelope = makeMessageEnvelope("sess", { type: "issue.opened" });
      expect(withThreadTranscript(envelope, manager)).toBe(envelope);
    });

    it("leaves an envelope with no session untouched", () => {
      // The CLI `/api/chat` route never crosses a connector, so there is no
      // messaging session to record against.
      const envelope = makeMessageEnvelope(undefined);
      expect(withThreadTranscript(envelope, manager)).toBe(envelope);
    });

    it("propagates a reply failure rather than swallowing it", async () => {
      const session = manager.getOrCreateSession(KEY);
      const envelope = makeMessageEnvelope(session.id, {
        reply: vi.fn().mockRejectedValue(new Error("slack down")),
      });

      await expect(withThreadTranscript(envelope, manager).reply("hi")).rejects.toThrow("slack down");
      // The inbound message is still recorded; the undelivered reply is not.
      expect(manager.getHistory(session.id).map((h) => h.role)).toEqual(["user"]);
    });
  });

  describe("recordThreadMessageForThread", () => {
    it("records a workflow's answer against the thread, without a session id", () => {
      const session = manager.getOrCreateSession(KEY);

      recordThreadMessageForThread(
        manager,
        "slack",
        KEY.channelId,
        KEY.threadId,
        "assistant",
        "The sandbox runs one container per phase.",
      );

      expect(manager.getHistory(session.id).map((h) => h.content)).toEqual([
        "The sandbox runs one container per phase.",
      ]);
    });

    it("revives a session the run outlived, so the thread continues", () => {
      const session = manager.getOrCreateSession(KEY);
      // A workflow that ran longer than SESSION_TIMEOUT_MS between the
      // question and its answer.
      db.prepare(`UPDATE messaging_sessions SET last_activity_at = ? WHERE id = ?`)
        .run(new Date(Date.now() - 60 * 60 * 1000).toISOString(), session.id);

      recordThreadMessageForThread(manager, "slack", KEY.channelId, KEY.threadId, "assistant", "answer");

      expect(manager.getHistory(session.id)).toHaveLength(1);
      // Revived: the user's next message continues this session rather than
      // re-keying to a fresh one that cannot see the answer.
      expect(manager.getOrCreateSession(KEY).id).toBe(session.id);
    });

    it("is a no-op for a thread with no session at all", () => {
      expect(() =>
        recordThreadMessageForThread(manager, "slack", "C-unknown", "t-unknown", "assistant", "hi"),
      ).not.toThrow();
    });
  });

  describe("recordThreadMessage", () => {
    it("skips empty and whitespace-only text", () => {
      const session = manager.getOrCreateSession(KEY);
      recordThreadMessage(manager, session.id, "assistant", "   \n ");
      expect(manager.getHistory(session.id)).toHaveLength(0);
    });

    it("clamps a long report to its tail — what a follow-up refers back to", () => {
      const session = manager.getOrCreateSession(KEY);
      recordThreadMessage(manager, session.id, "assistant", "x".repeat(50_000) + "THE-VERDICT");

      const [row] = manager.getHistory(session.id);
      expect(row.content.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
      expect(row.content.endsWith("THE-VERDICT")).toBe(true);
      expect(row.content.startsWith("…(truncated)…")).toBe(true);
    });

    it("never throws when the store rejects the write", () => {
      expect(() => recordThreadMessage(manager, "no-such-session", "user", "hi")).not.toThrow();
    });
  });
});
