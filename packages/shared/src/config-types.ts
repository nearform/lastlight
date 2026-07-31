/**
 * Config types the workflow loader needs, lifted out of `lastlight-core`'s
 * `config/config.ts` so `shared` never depends back on core (locked decision
 * 11). Core re-exports these from `lastlight-shared` so its own
 * `config/config.js` import surface is unchanged.
 *
 * The `fix:` / `dependencies:` / `review:` policy blocks below live here for the
 * same reason plus one more: they are **repo-settable** (issues #251/#252), so
 * `repo-config-schema.ts` — which bounds a repo's `.lastlight/` and is compiled
 * into the CLI as well as core — has to name their shape and their shipped
 * defaults. Core's normaliser and the repo-layer sanitizer therefore agree by
 * construction rather than by two hand-maintained copies.
 */

export interface DisabledConfig {
  workflows: string[];
  crons: string[];
  prompts: string[];
  skills: string[];
  agentContext: string[];
}

export interface RouteConfig {
  github: Record<string, string>;
  slack: Record<string, string>;
}

// ---------------------------------------------------------------------------
// fix: — the PR_FIX_SHAPED retry policy (issue #251)
// ---------------------------------------------------------------------------

/**
 * Retry/escalation policy for every PR_FIX_SHAPED workflow (`pr-fix`,
 * `dependabot-ci-fix`).
 *
 * Repo-settable subset (bounded in `repo-config-schema.ts`): `maxAttempts`,
 * `localIterations`, `maxCostUsd`, `maxFlakyDeferrals` and `retryableClasses`,
 * each clamped so a repo can only ever be MORE conservative than the operator.
 * `escalateModelAfterAttempt` (spend control) and `gateTimeoutSeconds` (resource
 * control) are operator-only.
 */
export interface FixConfig {
  /** Cross-run attempts per (repo, PR) before the PR is escalated to a human. */
  maxAttempts: number;
  /** Within-run gate-loop iterations inside ONE attempt. */
  localIterations: number;
  /** `until_bash` budget, in seconds, for the repo's build/test gate. */
  gateTimeoutSeconds: number;
  /** Attempts ABOVE this number use `models["pr-fix-retry"]` when one is set. */
  escalateModelAfterAttempt: number;
  /** Cumulative cost ceiling across attempts for one PR. `null` = unbounded. */
  maxCostUsd: number | null;
  /** How many times a `flaky` diagnosis may defer before it is treated as reproducible. */
  maxFlakyDeferrals: number;
  /**
   * Diagnosis classes another attempt may help with; every other class escalates
   * immediately. Deliberately a free string list rather than an enum: the
   * vocabulary belongs to the `diagnose` phase, and an operator naming a class
   * this build doesn't know should narrow the retry set, not fail the boot.
   */
  retryableClasses: string[];
}

/** The shipped `fix:` block. Mirrors `fix:` in `apps/server/config/default.yaml`. */
export function defaultFixConfig(): FixConfig {
  return {
    maxAttempts: 3,
    localIterations: 2,
    gateTimeoutSeconds: 900,
    escalateModelAfterAttempt: 1,
    maxCostUsd: 5.0,
    maxFlakyDeferrals: 2,
    retryableClasses: ["reproducible", "env-mismatch"],
  };
}

// ---------------------------------------------------------------------------
// dependencies: — major-bump auto-merge policy (issue #252)
// ---------------------------------------------------------------------------

/** How much blast radius a major dependency bump carries, ascending. */
export const DEPENDENCY_IMPACT_LEVELS = ["none", "low", "medium", "high"] as const;

export type DependencyImpact = (typeof DEPENDENCY_IMPACT_LEVELS)[number];

/** True when `value` is one of {@link DEPENDENCY_IMPACT_LEVELS}. */
export function isDependencyImpact(value: unknown): value is DependencyImpact {
  return typeof value === "string" && (DEPENDENCY_IMPACT_LEVELS as readonly string[]).includes(value);
}

/** Position of an impact tier on the `none < low < medium < high` scale. */
export function dependencyImpactRank(impact: DependencyImpact): number {
  return DEPENDENCY_IMPACT_LEVELS.indexOf(impact);
}

/**
 * Policy for merging dependency PRs — specifically, how far up the impact scale
 * a MAJOR bump may be auto-merged instead of escalated to a human.
 *
 * Repo-settable subset: `autoMergeMaxImpact` (clamped to the lower tier),
 * `requireSettledChecks` (add-only `true`) and `auditComment` (free — cosmetic).
 * `minSettledChecks` is **operator-only**: the §6.2 `max(repo, operator)` clamp
 * would weld the escape hatch shut for a repo with no CI at all (09 locked
 * decision 18).
 */
export interface DependenciesConfig {
  /** Ceiling for auto-merging a MAJOR bump. `none` = never auto-merge a major. */
  autoMergeMaxImpact: DependencyImpact;
  /** Enforce settled-"passing" checks on ALL routes (webhook, cron, comment). */
  requireSettledChecks: boolean;
  /** An auto-merge decision needs >= N settled checks; `0` = today's behaviour. */
  minSettledChecks: number;
  /** Post the evidence comment when auto-merging a major. */
  auditComment: boolean;
}

/** The shipped `dependencies:` block. Mirrors `dependencies:` in `config/default.yaml`. */
export function defaultDependenciesConfig(): DependenciesConfig {
  return {
    autoMergeMaxImpact: "medium",
    requireSettledChecks: true,
    minSettledChecks: 1,
    auditComment: true,
  };
}

// ---------------------------------------------------------------------------
// review: — when `pr-review` runs
// ---------------------------------------------------------------------------

/**
 * When a `pr-review` run is triggered.
 *
 * - `eager` — dispatch on `pr.opened` / `synchronize` / `reopened`, in parallel
 *   with CI (the historical behaviour).
 * - `after-checks` — dispatch once the head SHA's checks SETTLE, either colour.
 * - `on-request` — never automatically; only when explicitly asked for.
 *
 * (`review.afterChecks` — the settled/passing sub-mode — was deleted by 09
 * locked decision 14: a PR whose CI never goes green would never be reviewed.)
 */
export const REVIEW_TRIGGERS = ["eager", "after-checks", "on-request"] as const;

export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

/** True when `value` is one of {@link REVIEW_TRIGGERS}. */
export function isReviewTrigger(value: unknown): value is ReviewTrigger {
  return typeof value === "string" && (REVIEW_TRIGGERS as readonly string[]).includes(value);
}

/**
 * The `review:` block. Every key is repo-settable; `postsCheck` and `skipDraft`
 * are add-only `true` (a repo may ask for the check and may skip drafts; it may
 * not suppress an operator's check or force reviews onto drafts), `trigger` and
 * `requestLabel` are free — a repo choosing `on-request` is opting itself out of
 * automation, which is its call.
 */
export interface ReviewConfig {
  /** Post the `last-light/review` Check Run. */
  postsCheck: boolean;
  /** Which trigger mode this deployment/repo uses. */
  trigger: ReviewTrigger;
  /** Label that requests a review in `on-request` mode. `null` = no label route. */
  requestLabel: string | null;
  /** Skip draft PRs (matching what the review cron has always done). */
  skipDraft: boolean;
}

/** The shipped `review:` block. Mirrors `review:` in `config/default.yaml`. */
export function defaultReviewConfig(): ReviewConfig {
  return {
    postsCheck: false,
    trigger: "after-checks",
    requestLabel: null,
    skipDraft: true,
  };
}
