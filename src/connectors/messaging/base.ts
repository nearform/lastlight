import { EventEmitter } from "events";
import { randomUUID } from "crypto";
import type { Connector, EventEnvelope } from "../types.js";
import type { SessionManager } from "./session-manager.js";
import type { MessagingConfig, IncomingMessageParams } from "./types.js";

/**
 * Abstract base class for messaging platform connectors.
 *
 * Handles common logic: allowlist checks, DM vs channel behavior,
 * session management, and EventEnvelope construction.
 *
 * Subclasses implement platform-specific transport (Slack Socket Mode,
 * Discord Gateway, Teams Bot Framework, etc.) and the three abstract methods.
 */
export abstract class MessagingConnector extends EventEmitter implements Connector {
  abstract readonly name: string;
  protected config: MessagingConfig;
  protected sessionManager: SessionManager;

  constructor(config: MessagingConfig, sessionManager: SessionManager) {
    super();
    this.config = config;
    this.sessionManager = sessionManager;
  }

  abstract start(): Promise<void>;
  abstract stop(): Promise<void>;

  /** Send a text message to a channel/thread */
  abstract sendMessage(channelId: string, threadId: string | null, text: string): Promise<string | void>;
  /** Add an emoji reaction to a message */
  abstract addReaction(channelId: string, messageId: string, emoji: string): Promise<void>;
  /**
   * Show a typing/processing indicator.
   * @param messageId   the user's message id (e.g. for an emoji reaction fallback)
   * @param threadRootId the thread root id (where status indicators must anchor)
   */
  abstract showTyping(channelId: string, messageId: string, threadRootId: string): Promise<void>;
  /** Clear the typing/processing indicator (optional — not all platforms need this) */
  async clearTyping(_channelId: string, _threadId: string): Promise<void> {}

  /**
   * Process an incoming message from any platform.
   * Called by platform-specific event listeners.
   */
  protected async handleIncomingMessage(params: IncomingMessageParams): Promise<void> {
    const { platformUserId, platformUsername, channelId, threadId, messageId, text, isDM, isMention, raw } = params;

    // Allowlist check
    if (this.config.allowedUsers.length > 0 && !this.config.allowedUsers.includes(platformUserId)) {
      console.log(`[${this.name}] Ignoring message from unauthorized user: ${platformUsername} (${platformUserId})`);
      return;
    }

    // In channels, respond to @mentions or replies in threads the bot is already in
    if (!isDM && !isMention) {
      if (!threadId || !this.sessionManager.hasActiveThread(this.name, channelId, threadId)) {
        return;
      }
    }

    // Strip bot mention from the message text
    const cleanText = this.stripBotMention(text).trim();
    if (!cleanText) return;

    // Thread anchor for status indicators / replies, and the session key.
    // A reply inside an existing thread carries its parent thread ts and
    // continues that thread/session; a top-level message (no thread_ts —
    // e.g. the user starting a NEW conversation in a DM, or a fresh channel
    // @mention) roots a new thread on its own ts. This is exactly Slack's
    // own threading: each distinct thread is its own conversation, so each
    // maps to its own session. (Do NOT collapse top-level DM messages into
    // the most-recent thread — that strands a deliberately-new thread's
    // replies back in the old one.)
    const replyThreadId = threadId || messageId;

    // Show acknowledgment
    this.showTyping(channelId, messageId, replyThreadId).catch(() => {});

    // Get or create session
    const session = this.sessionManager.getOrCreateSession({
      platform: this.name,
      channelId,
      threadId: replyThreadId,
      userId: platformUserId,
    });

    // NOTE: conversation persistence (user + assistant rows in
    // messaging_messages, plus touchSession) is owned solely by the chat
    // engine (src/engine/chat-runner.ts), which is the only path common to
    // every chat surface — Slack here and the CLI /api/chat route, which
    // never touches this connector. Recording here as well double-wrote
    // every turn (a clean copy AND chat-runner's untrusted-wrapped copy)
    // and fed both back into the model's rehydrated history. Build the
    // session for routing/ids only; let chat-runner do the writes.

    // Build the reply callback — sends to same channel/thread
    const reply = async (msg: string) => {
      // Clear thinking indicator before sending response
      this.clearTyping(channelId, replyThreadId).catch(() => {});
      // Chunk long messages
      const chunks = this.chunkMessage(msg);
      for (const chunk of chunks) {
        await this.sendMessage(channelId, replyThreadId, chunk);
      }
    };

    // Build EventEnvelope
    const envelope: EventEnvelope = {
      id: `${this.name}-${messageId}`,
      source: this.name,
      type: "message",
      sender: platformUsername,
      senderIsBot: false,
      body: cleanText,
      raw: {
        ...typeof raw === "object" && raw !== null ? raw : {},
        sessionId: session.id,
        platformUserId,
        channelId,
        threadId: replyThreadId,
      },
      reply,
      timestamp: new Date(),
    };

    this.emit("event", envelope);
  }

  /** Strip the bot @mention from message text */
  protected stripBotMention(text: string): string {
    if (!this.config.botIdentifier) return text;
    // Generic pattern — subclasses can override for platform-specific mention formats
    const mentionPattern = new RegExp(`<@${this.config.botIdentifier}>|@${this.config.botIdentifier}`, "gi");
    return text.replace(mentionPattern, "").trim();
  }

  /** Split a message into chunks that fit platform limits */
  protected chunkMessage(text: string, maxLength = 3000): string[] {
    if (text.length <= maxLength) return [text];

    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      // Try to break at a newline
      let breakPoint = remaining.lastIndexOf("\n", maxLength);
      if (breakPoint < maxLength * 0.5) {
        // No good newline break — try space
        breakPoint = remaining.lastIndexOf(" ", maxLength);
      }
      if (breakPoint < maxLength * 0.3) {
        // No good break — hard cut
        breakPoint = maxLength;
      }

      chunks.push(remaining.slice(0, breakPoint));
      remaining = remaining.slice(breakPoint).trimStart();
    }

    return chunks;
  }
}
