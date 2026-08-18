import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";

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
import { messagingSessions } from "#src/state/schema/sqlite.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../../helpers/state-db.js";

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
  let db: StateDb;
  let manager: SessionManager;

  beforeEach(async () => {
    db = await makeTestDb();
    manager = new SessionManager(db.client);
  });

  describe("withThreadTranscript", () => {
    it("records the inbound message and every reply on the thread's session", async () => {
      const session = await manager.getOrCreateSession(KEY);
      const envelope = makeMessageEnvelope(session.id);

      const wrapped = withThreadTranscript(envelope, manager);
      await wrapped.reply("Starting *answer*...");
      await wrapped.reply("*answer* completed.");

      // The inbound record is deliberately fire-and-forget (the wrapper must
      // return an envelope synchronously), so poll rather than assume it has
      // landed by the time the replies have.
      await vi.waitFor(async () => {
        expect((await manager.getHistory(session.id)).map((h) => [h.role, h.content])).toEqual([
          ["user", "how does the sandbox work in cliftonc/lastlight?"],
          ["assistant", "Starting *answer*..."],
          ["assistant", "*answer* completed."],
        ]);
      });
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
      const session = await manager.getOrCreateSession(KEY);
      const envelope = makeMessageEnvelope(session.id, {
        reply: vi.fn().mockRejectedValue(new Error("slack down")),
      });

      await expect(withThreadTranscript(envelope, manager).reply("hi")).rejects.toThrow("slack down");
      // The inbound message is still recorded; the undelivered reply is not.
      await vi.waitFor(async () => {
        expect((await manager.getHistory(session.id)).map((h) => h.role)).toEqual(["user"]);
      });
    });
  });

  describe("recordThreadMessageForThread", () => {
    it("records a workflow's answer against the thread, without a session id", async () => {
      const session = await manager.getOrCreateSession(KEY);

      await recordThreadMessageForThread(
        manager,
        "slack",
        KEY.channelId,
        KEY.threadId,
        "assistant",
        "The sandbox runs one container per phase.",
      );

      expect((await manager.getHistory(session.id)).map((h) => h.content)).toEqual([
        "The sandbox runs one container per phase.",
      ]);
    });

    it("revives a session the run outlived, so the thread continues", async () => {
      const session = await manager.getOrCreateSession(KEY);
      // A workflow that ran longer than SESSION_TIMEOUT_MS between the
      // question and its answer.
      await db.client
        .update(messagingSessions)
        .set({ lastActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
        .where(eq(messagingSessions.id, session.id));

      await recordThreadMessageForThread(
        manager,
        "slack",
        KEY.channelId,
        KEY.threadId,
        "assistant",
        "answer",
      );

      expect(await manager.getHistory(session.id)).toHaveLength(1);
      // Revived: the user's next message continues this session rather than
      // re-keying to a fresh one that cannot see the answer.
      expect((await manager.getOrCreateSession(KEY)).id).toBe(session.id);
    });

    it("is a no-op for a thread with no session at all", async () => {
      await expect(
        recordThreadMessageForThread(manager, "slack", "C-unknown", "t-unknown", "assistant", "hi"),
      ).resolves.toBeUndefined();
    });
  });

  describe("recordThreadMessage", () => {
    it("skips empty and whitespace-only text", async () => {
      const session = await manager.getOrCreateSession(KEY);
      await recordThreadMessage(manager, session.id, "assistant", "   \n ");
      expect(await manager.getHistory(session.id)).toHaveLength(0);
    });

    it("clamps a long report to its tail — what a follow-up refers back to", async () => {
      const session = await manager.getOrCreateSession(KEY);
      await recordThreadMessage(
        manager,
        session.id,
        "assistant",
        "x".repeat(50_000) + "THE-VERDICT",
      );

      const [row] = await manager.getHistory(session.id);
      expect(row.content.length).toBeLessThanOrEqual(MAX_TRANSCRIPT_CHARS);
      expect(row.content.endsWith("THE-VERDICT")).toBe(true);
      expect(row.content.startsWith("…(truncated)…")).toBe(true);
    });

    it("never throws when the store rejects the write", async () => {
      await expect(
        recordThreadMessage(manager, "no-such-session", "user", "hi"),
      ).resolves.toBeUndefined();
    });
  });
});
