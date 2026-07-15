/**
 * Shared, platform-agnostic notification model.
 *
 * The notifier renders workflow progress as a single "task list" surface that
 * is **edited in place** as phases run — one GitHub comment (via
 * `issues.updateComment`) and/or one Slack message (via `chat.update`) instead
 * of a fresh comment per phase. The model here is the canonical content; the
 * renderer (`render.ts`) turns it into markdown that both platforms consume
 * (Slack runs the markdown through `markdownToSlackMrkdwn` in its transport).
 *
 * Nothing in this module imports GitHub or Slack — platform code lives behind
 * the `NotifierTransport` interface so the content model stays decoupled and
 * shared.
 */

/** Lifecycle state of a single checklist step. */
export type StepStatus =
  | "pending"
  | "running"
  | "done"
  | "blocked"
  | "awaiting"
  | "failed"
  | "skipped";

/** One row in the task list. `key` is stable; `label` is what humans see. */
export interface ProgressStep {
  key: string;
  label: string;
  status: StepStatus;
  /** Optional one-line context shown after the label (e.g. a link or status). */
  detail?: string;
}

/** Metadata carried alongside an interactive approval prompt. */
export interface ApprovalNoteMeta {
  /** The paused workflow run id — a Slack Approve/Reject button carries it as
   *  its action value so the click resolves the right gate. */
  workflowRunId: string;
}

/** The full content model rendered into the single status surface. */
export interface ProgressModel {
  /** Heading line, e.g. "build for #18". */
  title: string;
  /** Optional bold sub-heading, e.g. the issue title. */
  subtitle?: string;
  /** Optional metadata lines under the heading (branch link, PR link, …). */
  meta?: string[];
  /** Ordered checklist. */
  steps: ProgressStep[];
  /** Optional trailing line (e.g. artifacts link). */
  footer?: string;
}

/**
 * A platform binding. Each transport owns its own in-place-update handle
 * (a GitHub comment id or a Slack message ts) internally.
 */
export interface NotifierTransport {
  /**
   * Create-or-update the single status surface with the rendered markdown.
   * The `model` is the same content source the markdown was rendered from —
   * a transport that can render richer UI (Slack Block Kit) uses it directly
   * while keeping `markdown` as the notification/accessibility fallback.
   * Transports that only speak markdown (GitHub) ignore it.
   */
  publish(markdown: string, model?: ProgressModel): Promise<void>;
  /**
   * Post a *new, separate* message (not an edit). Used for approval prompts —
   * moments worth an actual notification, since an in-place edit is silent.
   */
  note(markdown: string): Promise<void>;
  /**
   * Post a standalone *approval prompt*. Rich surfaces (Slack) render
   * interactive Approve/Reject controls from `meta`; markdown-only surfaces
   * (GitHub) omit this and the notifier falls back to `note(markdown)`.
   * Optional so a plain transport needs only `note`.
   */
  noteApproval?(markdown: string, meta: ApprovalNoteMeta): Promise<void>;
  /**
   * Whether this surface wants a separate *completion* ping at the end of a
   * run. Slack sets this (its in-place edits are silent and it has no other
   * signal); GitHub leaves it false — the edited checklist plus the
   * PR-opened event already notify watchers, so a terminal comment would just
   * be noise. Default false.
   */
  readonly terminalPing?: boolean;
}

/**
 * The runner-facing API. `runner.ts` only ever sees this interface — it never
 * touches a transport or the markdown directly.
 */
export interface ProgressReporter {
  /** Seed the task list. Idempotent: a resumed run re-seeds the same surface. */
  start(model: ProgressModel): Promise<void>;
  /** Transition a step's status (and optionally set its one-line detail). */
  step(key: string, status: StepStatus, detail?: string): Promise<void>;
  /**
   * Insert (or update) a dynamic step before `beforeKey` — used for loop
   * iterations (re-review / fix cycles). Appends when `beforeKey` is omitted
   * or not found.
   */
  insertStep(step: ProgressStep, beforeKey?: string): Promise<void>;
  /** Post a standalone message to every surface (e.g. an approval prompt). */
  note(markdown: string): Promise<void>;
  /**
   * Post an interactive approval prompt to every surface. Rich surfaces render
   * Approve/Reject controls (Slack Block Kit); others fall back to plain text.
   */
  noteApproval(markdown: string, meta: ApprovalNoteMeta): Promise<void>;
  /**
   * Set (or clear) the trailing footer of the single status surface and
   * re-publish in place. Used to fold a workflow's final synthesized result
   * into the same comment as the checklist rather than posting a new one.
   * Pass an empty string to clear.
   */
  footer(markdown: string): Promise<void>;
  /**
   * Post the run's completion message, but only to surfaces that want a
   * terminal ping (Slack) — GitHub is left with just the finished checklist.
   */
  noteTerminal(markdown: string): Promise<void>;
}

/** Persisted in-place-update handles, stored under `workflow_runs.scratch.notifier`. */
export interface NotifierState {
  githubCommentId?: number;
  slackTs?: string;
  slackChannel?: string;
  slackThread?: string;
}
