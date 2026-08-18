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
  /**
   * Head commit SHA for PR-shaped events (`pr.checks_passed` / `pr.checks_failed`
   * carry the settled check_suite's head_sha). Used by the dependency-workflow
   * dedup guard to skip a PR already assessed at this exact SHA.
   */
  headSha?: string;
  /**
   * Is this a dependency-update (Dependabot / Renovate) PR? Set on the
   * check-outcome events, where the connector already computes it — from the
   * head commit's author and the suite's head branch — to decide whether to
   * emit at all.
   *
   * It is carried rather than discarded so the router can route
   * `pr.checks_failed` DETERMINISTICALLY (dependency → `dependabot-ci-fix`,
   * everything else → `pr-fix`) instead of paying a classifier call to
   * re-derive it from a prose sentence. That call could never select `pr-fix`
   * — `pr-fix.yaml` has no `classification:` block — so every red PR resolved
   * to the dependency workflow (09-state-machine.md → D5).
   */
  isDependencyPr?: boolean;
  /** The label just added, on a `pr.labeled` event. */
  addedLabel?: string;
  /**
   * Who the review was requested FROM, on a `pr.review_requested` event — a
   * login, or a `team/<slug>` for a team request. Set to our own `botLogin`
   * when the request arrived as a Re-run on the `last-light/review` check.
   */
  requestedReviewer?: string;
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
  | "pr.checks_failed" // a check_suite completed with a failure conclusion
  | "pr.checks_passed" // a check_suite completed green on a dependency-update PR
  /**
   * The head SHA's checks have SETTLED — either colour — on a PR that neither
   * check-outcome route above claimed.
   *
   * This is `review.trigger: after-checks`'s trigger, and it exists as its own
   * type because a single `check_suite.completed` delivery cannot become two
   * envelopes: `normalize()` returns ONE per delivery and `route()` returns one
   * handler, so "broaden `pr.checks_failed`" is a fan-out the pipeline cannot
   * express (09 → S2). FIX OUTRANKS REVIEW is therefore a property of which
   * type the connector emits: a settled-red PR the fix family can act on stays
   * `pr.checks_failed`, and only what is left becomes this.
   */
  | "pr.checks_settled"
  /**
   * A label was added to a PR. Carries {@link EventEnvelope.addedLabel} so
   * `review.requestLabel` works; the router ignores every other label, which is
   * what keeps this from becoming a firehose.
   */
  | "pr.labeled"
  /**
   * A review was explicitly requested from US — either through GitHub's
   * reviewer picker (opportunistic: App bot users are not generally selectable
   * there) or through the Re-run button on our own `last-light/review` check.
   */
  | "pr.review_requested"
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
