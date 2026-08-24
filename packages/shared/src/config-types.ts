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
 * The five classes a `diagnose` phase may return (09 → S1,
 * `apps/server/skills/fixing/SKILL.md`), which is also the vocabulary
 * {@link FixConfig.retryableClasses} names members of.
 *
 * It lives here rather than beside the marker parser in core because BOTH
 * validators of that leaf need it: core's boot normaliser, and the repo-layer
 * clamp in `./repo-config-schema.ts` — which is compiled into the CLI and may
 * never reach core. `apps/server/src/engine/fix-markers.ts` re-exports it, so
 * every reader of the marker grammar still finds it where it expects to.
 */
export const DIAGNOSIS_CLASSES = [
  "reproducible",
  "env-mismatch",
  "flaky",
  "infra-dependent",
  "upstream-broken",
] as const;

export type DiagnosisClass = (typeof DIAGNOSIS_CLASSES)[number];

/** True when `value` is one of {@link DIAGNOSIS_CLASSES}. */
export function isDiagnosisClass(value: unknown): value is DiagnosisClass {
  return typeof value === "string" && (DIAGNOSIS_CLASSES as readonly string[]).includes(value);
}

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
  /**
   * Within-run gate-loop iterations inside ONE attempt.
   *
   * Read by the fix phase's `generic_loop.max_iterations:
   * { from: fix.localIterations, default: 2 }` in `pr-fix.yaml` /
   * `dependabot-ci-fix.yaml` — the effective block is seeded on the run's
   * template context, so the repo-clamped value is the operative bound.
   */
  localIterations: number;
  /**
   * `until_bash` budget, in seconds, for the repo's build/test gate. Read by
   * the same phase's `timeout_seconds: { from: fix.gateTimeoutSeconds, … }`.
   */
  gateTimeoutSeconds: number;
  /** Attempts ABOVE this number use `models["pr-fix-retry"]` when one is set. */
  escalateModelAfterAttempt: number;
  /** Cumulative cost ceiling across attempts for one PR. `null` = unbounded. */
  maxCostUsd: number | null;
  /** How many times a `flaky` diagnosis may defer before it is treated as reproducible. */
  maxFlakyDeferrals: number;
  /**
   * Diagnosis classes another attempt may help with; every other class escalates
   * immediately. Members must be {@link DIAGNOSIS_CLASSES}.
   *
   * Typed `string[]` rather than `DiagnosisClass[]` because it is parsed from
   * untrusted YAML and a bad member must NARROW the retry set with a warning
   * rather than fail the boot — but it is validated against the enum on both
   * paths now. It was not: a typo (`reproducable`) silently made every
   * diagnosis escalate `not-retryable` on the second dispatch, with nothing
   * said anywhere (#256).
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
 * Repo-settable subset: `autoMergeMaxImpact` (clamped to the lower tier), and
 * `requireSettledChecks` + `auditComment` (both add-only `true`).
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
 * How much automation a trigger mode buys, ascending — the scale the repo-layer
 * clamp takes the minimum on.
 *
 * Not derived from {@link REVIEW_TRIGGERS}' index, which runs the other way: the
 * list is ordered most-automatic first for readability, and silently inverting
 * it is exactly the kind of coupling that breaks when someone reorders the
 * literal. Stated explicitly instead.
 *
 * `eager` runs a full agent review on every push; `after-checks` runs one per
 * settled head; `on-request` runs none unless asked. So a repo that commits
 * `eager` against an `on-request` deployment is buying itself an agent run per
 * push at the operator's expense (#256) — the same direction `fix.maxAttempts`
 * is clamped in, and the same clamp applies.
 */
const REVIEW_TRIGGER_AUTOMATION: Record<ReviewTrigger, number> = {
  "on-request": 0,
  "after-checks": 1,
  eager: 2,
};

/** Position of a trigger mode on the automation scale. */
export function reviewTriggerRank(trigger: ReviewTrigger): number {
  return REVIEW_TRIGGER_AUTOMATION[trigger];
}

/**
 * The `review.analysis:` sub-block — the evidence pipeline
 * (`docs/plans/review-evidence-pipeline/`).
 *
 * **OFF by default, and that is a locked decision** (README locked decision 8):
 * `enabled: false` must reproduce today's two-phase review byte-for-byte, so
 * every projection this block governs is *absent* from the template context
 * rather than present-and-empty. Each stage lands dark and is switched on per
 * deployment once it has been measured.
 *
 * **Operator-only, unlike every other `review:` leaf.** It buys analysis on the
 * operator's budget, which is the same argument that made `review.trigger`
 * clamped rather than free (#256) — except there is no "more conservative"
 * direction here to clamp towards, so a repo asking for it answers
 * `key-not-allowed` exactly as `fix.escalateModelAfterAttempt` does.
 */
export interface ReviewAnalysisConfig {
  /** `false` ⇒ today's two-phase review, byte-for-byte. */
  enabled: boolean;
  /**
   * How many `spec` obligations one PR may carry.
   *
   * A **safety bound**, not a budget — it should never bind on a real PR. The
   * extractor still ranks, truncates, and records in the rendered block how
   * many it dropped (a silently truncated list is the failure locked decision 6
   * exists to prevent); this number exists only to stop a pathological PR
   * blowing the prompt.
   *
   * It shipped at 6, which was inert while the spec axis produced nothing. The
   * moment the axis started working it bound on FIVE of the six linked cases in
   * the gate set, discarding acceptance criteria a human wrote on the issue —
   * the most direct statement of intent this pipeline ever gets. Capping
   * GENERATION also inverts locked decision 2: we over-generate deliberately and
   * let the probe oracle and WP6b's attention boundary narrow. Truncating
   * obligations truncates DISCOVERY, which is the measured ceiling.
   */
  maxSpecObligations: number;
  /**
   * How many **facts-derived** obligations one PR may carry, across all five
   * families `lastlight-facts seed` produces (`contract`, `enforcement`,
   * `security`, `state`, `tests`). The `spec` family has its own budget above,
   * because it is built harness-side from the issue text and shares no ranking
   * axis with these.
   *
   * A budget, so the seeder RANKS: mechanism class first — `enforcement` and
   * `contract` are the two that have ever converted — then by how much of the
   * impact cone lies outside the diff. What it drops is counted in
   * `obligations.json` with the reason, never truncated silently.
   */
  maxObligations: number;
  /**
   * Which obligation BLOCK the six survey families are handed — the CONTROL for
   * 2026-08-23, and the only key in this block that exists to make a result
   * readable rather than to buy compute.
   *
   * `full` (the default) is that day's block: a mandatory discharge contract
   * with a `discharge` field to record a code in, an un-truncated id checklist,
   * and one worked exemplar. It moved discharge compliance 0/33 → 33/33 on
   * `prreview__skillspro-1587-r2` — and moved the union of matched gold
   * **4-of-5 → 0-of-5**, over three repeats, with half to two thirds of every
   * hypothesis becoming a clean quote (`QUOTE`, `failureScenario: null`).
   *
   * Two variables changed in the same commit, so the run cannot say which:
   * whether the obligations ask the WRONG QUESTION and making a wrong question
   * mandatory turns hunting into checklist-clearing, or whether RELIABLE SEEDING
   * itself suppresses discovery (the same commit stopped ~24% of survey branches
   * losing their seed entirely). `minimal` renders the pre-2026-08-23 block —
   * same obligations, delivered just as reliably, asking the old question — so
   * one arm separates them.
   *
   * It reaches the five facts-derived families as `lastlight-facts seed
   * --contract`, is stamped into `obligations.json`, and the `spec` family reads
   * it directly (`renderSpecObligations`) because it is rendered harness-side.
   * **`lastlight-facts discharge` degrades to its `test -s` floor under
   * `minimal`**: measured compliance under that block was 0/31, 0/34 and 0/40,
   * so a gate demanding a code the block never asked for would fail every family
   * of every run.
   */
  obligationContract: "full" | "minimal";
  /**
   * How many of the six survey families actually run.
   *
   * **Six, and the default is not negotiable down without saying which.** The
   * previous design defaulted this to 3 against six families and never recorded
   * which three ran — so half the families silently never executed, and
   * `enforcement`, the one that produced the only gold match, could have been
   * among them (§D4). A value below 6 takes the families in the seeder's rank
   * order and the run says so in its artifact.
   */
  surveyPasses: number;
  /**
   * How many survey families run CONCURRENTLY (WP11c).
   *
   * A CEILING, not a guarantee: the run clamps it to what the active sandbox
   * backend can actually hold. `none` and `docker` take the declared value;
   * `gondolin` boots a QEMU micro-VM per agent session inside the harness
   * process and pins to 1, as do `smol` and `kubernetes` until measured. So on
   * a stock deployment (gondolin) this key changes nothing at all today.
   *
   * Six by default because six is what the fan-out exists for. The six families
   * write six disjoint append-only files and never read each other's, so there
   * was never an ordering constraint between them — only a scheduler that ran
   * one DAG node at a time. Chained, they were 851s of a 29-minute review (49%
   * of the wall clock); concurrent, they are the slowest single family.
   *
   * Lower it to bound provider rate-limit pressure or memory, not to bound
   * spend: the six passes cost the same in tokens either way.
   */
  surveyConcurrency: number;
  /**
   * WP4 — the `prepare` + `falsify` pair: install dependencies so a probe can be
   * **run**, then write probes and run them.
   *
   * A second switch under an already-gated block, deliberately. `prepare` is the
   * phase that decides whether the review workspace has a `node_modules`, and
   * that one fact changes three things at once: it is what makes a
   * package-extending `tsconfig` resolve (so `contract` can seed at all on a
   * normal monorepo), it is the only route to a coverage artifact (so `tests`
   * can), and it re-arms the memory profile of a *different* phase. Bundling it
   * into `enabled` would have made "run the surveys" and "install the PR
   * author's dependencies" the same decision.
   *
   * `false` reproduces WP3 exactly. Default posture is **off in production, on
   * in the eval overlay** — the ablation rung is what decides whether it ships
   * on, and that is a number, not a judgement call.
   */
  probes: boolean;
  /**
   * Let `prepare`'s install run the tree's own lifecycle scripts.
   *
   * **Off, and it is a security default rather than a performance one.** The
   * install runs against a PULL REQUEST HEAD, so a `postinstall` there is code
   * the PR author wrote executing on the operator's infrastructure — and
   * `pr-review`'s workspace has never installed anything, which makes `prepare`
   * the first thing in the workflow that could. What `prepare` is FOR (making an
   * `extends` resolve, putting library source on disk to be read) needs the
   * files, not their scripts.
   *
   * Turning it on is legitimate for a repo whose install genuinely does not work
   * without them; it is not the default for the same reason `probes` is not.
   */
  probeLifecycleScripts: boolean;
  /**
   * Run the repo's own `tsc --noEmit` in `prepare` and record the diagnostics.
   *
   * Cheap, independent of the other two, and **not** a CI re-run: CI reports a
   * pass/fail summary over a matrix, this reports a per-file, per-line
   * diagnostic that can be attached to a specific hypothesis (locked decision
   * 11 — we never re-derive what `checksState` already said).
   */
  probeTypecheck: boolean;
  /**
   * Run a coverage command in `prepare` so the `tests` obligation family has an
   * input for the first time.
   *
   * **The one step in this pipeline that runs a test suite**, which is the
   * wall-clock item §D13 deleted along with `mutants` and `suite`. It is a
   * separate switch because it is a separate price: everything else in `prepare`
   * is seconds and this is minutes. It never guesses a command — only one the
   * repo itself named (a `coverage` / `test:coverage` script) — because a
   * guessed fifteen-minute run that produced nothing makes "no command" and "no
   * artifact" the same row in the funnel.
   */
  probeCoverage: boolean;
  /** Ceiling on `prepare`'s dependency install, in seconds. */
  prepareTimeoutSeconds: number;
  /** Ceiling on `prepare`'s coverage run, in seconds. Minutes, not seconds. */
  coverageTimeoutSeconds: number;
  /**
   * How many rounds `falsify` gets to write and run probes.
   *
   * Two. v3's lesson 3 is the sizing argument: the loop's exit condition is a
   * five-line existence gate, not a validator — v2's full quote validator was
   * overkill and cost 2.4× for a worse result.
   */
  probeRounds: number;
  /**
   * The inline-comment attention budget (WP6b).
   *
   * Preserving internal recall and spending a human's attention are two
   * different budgets, and conflating them is how a recall-first reviewer
   * becomes unreadable. Everything past this rank goes to the review BODY —
   * still posted, still visible, just not an inline comment. Nothing is dropped.
   *
   * Eight, on the evidence in *"Does AI Code Review Lead to Code Changes?"*
   * (22k+ real review comments): concise, hunk-level, actionable findings are
   * substantially likelier to lead to a change. Twenty inline comments is not
   * twenty times the signal of eight; it is a muted bot.
   */
  maxInlineComments: number;
  /**
   * Per-obligation-family confidence bar for an INLINE comment. Below the bar a
   * finding goes to the body; it is never deleted.
   *
   * **Per-family, not global, and that is a measured choice.** AutoCommenter
   * (Google Critique) found a global threshold catastrophic — at `t = 0.98`,
   * ~80% of below-threshold predictions were still correct — while per-URL
   * thresholds raised recall without hurting precision.
   *
   * **These numbers are initial guesses to be tuned on the train split, not
   * measurements.** Record each retune in the eval journal.
   */
  thresholds: Record<string, number>;
  /**
   * Below this confidence a finding is recorded but not posted at all.
   *
   * The one tier that costs recall, so it is deliberately low and deliberately
   * auditable. A finding carrying NO confidence is never affected — see
   * `tierFindings`; treating an absent field as zero would silently delete every
   * finding from any prompt that has not been taught to self-score.
   */
  internalFloor: number;
}

/**
 * The `review:` block. Every key except `analysis` is repo-settable, and every
 * one of those is CLAMPED towards less automation: `postsCheck` and `skipDraft`
 * are add-only `true` (a repo may ask for the check and may skip drafts; it may
 * not suppress an operator's check or force reviews onto drafts), `trigger`
 * takes the lower {@link reviewTriggerRank} of repo and operator,
 * `generatedPaths` is superset-only (a longer list suppresses MORE
 * re-reviews), and `requestLabel` is free — naming a label only ever adds an
 * explicit, human-initiated route. {@link ReviewAnalysisConfig} is
 * operator-only; see its own doc.
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
  /**
   * Path patterns whose changes are DERIVED, not authored — lock files,
   * minified bundles, code-generator output (issue #271).
   *
   * Per-head-SHA dedup was the only suppression gate on a re-review, so any new
   * head earned a fresh formal review by design. A lock file re-derivation is a
   * new head, so nearform/skillspro#1641 got two byte-identical APPROVEs six
   * minutes apart. When EVERY path changed since our last posted review matches
   * one of these, there is nothing a reviewer could say that it did not already
   * say, and `resolveReviewTrigger` skips.
   *
   * Empty list = the gate is off (the pre-#271 behaviour). Matched by
   * `isGeneratedPath` — `*` stops at a `/`, `**` crosses one, and a pattern with
   * no `/` matches a BASENAME anywhere in the tree.
   *
   * This never suppresses a FIRST review, an explicit `@bot review`, or a push
   * that also touched a hand-written file — see `resolveReviewTrigger`.
   */
  generatedPaths: string[];
  /** The evidence pipeline. Off by default — see {@link ReviewAnalysisConfig}. */
  analysis: ReviewAnalysisConfig;
}

/**
 * Where a repo's outbound notifications go — today, the weekly Slack digest.
 *
 * Unlike `fix` / `dependencies` / `review`, this is **routing, not policy**:
 * there is no "more conservative" direction for a channel name, so the repo
 * layer's usual one-way clamp does not apply and a repo's value simply wins.
 * What makes that safe is the layer's trust rule, not a bound: `.lastlight/` is
 * always read from the repo's DEFAULT BRANCH, never a PR head, so a pull
 * request cannot redirect the bot's output. The operator's kill switch is the
 * generic one — drop `notifications` from `repoConfig.allowKeys`.
 *
 * A channel the bot isn't a member of simply fails the post (Slack answers
 * `not_in_channel`), which is logged and skipped. There is no way to make the
 * bot speak somewhere it hasn't been invited.
 */
export interface NotificationsConfig {
  slack: {
    /**
     * Channel id (`C…`) or `#name`. `null` = fall through to the operator's
     * `slack.repoChannels` map and then `slack.deliveryChannel`; if none of the
     * three resolves, the repo gets no digest at all.
     */
    channel: string | null;
  };
}

/** The shipped `notifications:` block — everything off, so the feature is inert by default. */
export function defaultNotificationsConfig(): NotificationsConfig {
  return { slack: { channel: null } };
}

/** The shipped `review:` block. Mirrors `review:` in `config/default.yaml`. */
export function defaultReviewConfig(): ReviewConfig {
  return {
    postsCheck: false,
    trigger: "after-checks",
    requestLabel: null,
    skipDraft: true,
    // Deliberately narrow: only artifacts a tool WRITES from something else in
    // the same diff. `dist/` and `build/` are not here — plenty of repos keep
    // hand-written source under those names, and a wrong entry here silently
    // suppresses real reviews. Operators add their own generator output.
    generatedPaths: [
      "*.lock",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lockb",
      "go.sum",
      "*.min.js",
      "*.min.css",
      "*.generated.*",
      "**/__generated__/**",
    ],
    analysis: {
      enabled: false,
      // A safety bound, not a budget — see config/default.yaml for why this is
      // 40 rather than the 6 it shipped with. It must not bind on a real PR:
      // capping generation truncates discovery, which is the measured ceiling.
      maxSpecObligations: 40,
      maxObligations: 40,
      // `minimal` ships, measured in: under `full`, half to two-thirds of
      // survey output arrives as clean-quote verification reports that reached
      // real PRs as posted findings; under `minimal` the same recall union
      // posts with 37–71% better SNR and half the run-to-run variance. `full`
      // remains the opt-in telemetry arm (discharge codes + the
      // clean-discharge demotion at the posting boundary).
      obligationContract: "minimal",
      surveyPasses: 6,
      surveyConcurrency: 6,
      probes: false,
      probeLifecycleScripts: false,
      probeTypecheck: false,
      probeCoverage: false,
      prepareTimeoutSeconds: 300,
      coverageTimeoutSeconds: 900,
      probeRounds: 2,
      maxInlineComments: 8,
      thresholds: {
        contract: 0.35,
        enforcement: 0.35,
        security: 0.3,
        state: 0.5,
        tests: 0.6,
        spec: 0.45,
      },
      internalFloor: 0.15,
    },
  };
}
