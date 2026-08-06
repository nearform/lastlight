/**
 * Shared types for messaging platform connectors (Slack, Discord, Teams, etc.).
 * Platform-specific connectors extend MessagingConfig and implement
 * the abstract methods in MessagingConnector.
 */

/** Base config shared by all messaging connectors */
export interface MessagingConfig {
  /** Platform user IDs allowed to interact with the bot */
  allowedUsers: string[];
  /** Bot's identifier for @mention detection (platform-specific format) */
  botIdentifier: string;
  /**
   * Called after the bot posts a message, with the id the platform assigned it
   * (issue #255).
   *
   * A reaction names a MESSAGE; a feedback signal needs a run. The platform id
   * is the only thing that joins the two, and on Slack it exists for exactly one
   * moment — the `chat.postMessage` response — after which the connector has
   * historically thrown it away. This hook is where it gets kept.
   *
   * Injected rather than reached for: the connector layer must not grow a
   * dependency on the state database (`spec/03-integrations.md` — every
   * connector normalizes and hands off; it never persists domain state).
   * Best-effort and synchronous; the caller swallows anything it throws.
   */
  onBotMessage?: (info: BotMessagePosted) => void;
}

/** One message the bot posted, as the platform identified it. */
export interface BotMessagePosted {
  channelId: string;
  /** Thread root, for locating the conversation the message belongs to. */
  threadId: string | null;
  /** Platform message id — a Slack `ts`. */
  messageId: string;
  /** The messaging session this reply belongs to, when it is a chat turn. */
  sessionId?: string;
}

/** Unique key identifying a conversation thread */
export interface ConversationKey {
  /** Platform name (e.g., "slack", "discord") */
  platform: string;
  /** Platform-specific channel/DM identifier */
  channelId: string;
  /** Thread identifier (null for top-level DMs) */
  threadId: string | null;
  /** User who initiated */
  userId: string;
}

/** Persisted conversation session */
export interface ConversationSession {
  id: string;
  platform: string;
  channelId: string;
  threadId: string | null;
  userId: string;
  /** Agent SDK session ID for multi-turn context (reserved for future use) */
  agentSessionId: string | null;
  createdAt: string;
  lastActivityAt: string;
  messageCount: number;
  active: boolean;
}

/** A single message in a conversation */
export interface ConversationMessage {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  timestamp: string;
  platformMessageId: string | null;
}

/** Parameters passed from platform connector to handleIncomingMessage() */
export interface IncomingMessageParams {
  platformUserId: string;
  platformUsername: string;
  channelId: string;
  threadId: string | null;
  messageId: string;
  text: string;
  isDM: boolean;
  isMention: boolean;
  raw: unknown;
}
