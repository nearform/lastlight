import { EventEmitter } from "events";

/**
 * Normalized event envelope — the core engine only sees these,
 * never raw platform payloads. Adding a new connector (Slack, Discord, etc.)
 * means mapping platform events into this shape.
 */
export interface EventEnvelope {
  /** Unique event ID (for deduplication) */
  id: string;
  /** Source connector name */
  source: string;
  /** Normalized event type */
  type: EventType;
  /** Repository in owner/repo format */
  repo?: string;
  /** Issue or PR number */
  issueNumber?: number;
  /** PR number (distinct from issue for PR-specific events) */
  prNumber?: number;
  /** Login/username of the sender */
  sender: string;
  /** Login of the issue/PR original author (distinct from `sender`, the commenter) */
  issueAuthor?: string;
  /** Whether sender is a bot */
  senderIsBot: boolean;
  /** Event body text (issue body, comment body, PR body, etc.) */
  body: string;
  /** Title (for issues/PRs) */
  title?: string;
  /** Labels on the issue/PR */
  labels?: string[];
  /** GitHub author association (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE) */
  authorAssociation?: string;
  /** Original platform payload (for connector-specific logic) */
  raw: unknown;
  /** Reply on the same platform/thread */
  reply: (msg: string) => Promise<void>;
  /**
   * Re-assert a "thinking" indicator for this thread, if the platform has one.
   * Called at the start of each turn so a batched burst that drains as multiple
   * turns shows the indicator for every turn — the per-arrival show is cleared
   * by the first turn's reply. No-op for sources without an indicator (CLI).
   */
  typing?: () => Promise<void>;
  /** Timestamp of the event */
  timestamp: Date;
}

export type EventType =
  | "issue.opened"
  | "issue.reopened"
  | "issue.closed"
  | "pr.opened"
  | "pr.synchronize" // new commits pushed to a PR's branch
  | "pr.reopened"
  | "pr.closed"
  | "pr.merged"
  | "comment.created"
  | "pr_review.submitted"
  | "pr_review_comment.created"
  | "message"; // generic message from chat platforms (Slack, Discord)

/**
 * Connector interface — all event sources implement this.
 * The core engine registers a handler via on('event', ...) and
 * receives EventEnvelopes. It never knows which platform sent them.
 */
export interface Connector extends EventEmitter {
  /** Connector name (e.g., 'github', 'slack', 'discord') */
  readonly name: string;

  /** Start listening for events */
  start(): Promise<void>;

  /** Gracefully stop */
  stop(): Promise<void>;
}
