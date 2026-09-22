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
 * `escalateModelAfterAttempt` (spend control) is operator-only.
 *
 * The gate's `until_bash` budget is NOT here: it is `gate.timeoutSeconds`
 * ({@link GateConfig}, issue #385). `fix.gateTimeoutSeconds` survives only as a
 * deprecated OPERATOR-overlay alias that core's loader maps across.
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
    escalateModelAfterAttempt: 1,
    maxCostUsd: 5.0,
    maxFlakyDeferrals: 2,
    retryableClasses: ["reproducible", "env-mismatch"],
  };
}

// ---------------------------------------------------------------------------
// gate: + sandbox timeouts — wall-clock budgets (issue #385)
// ---------------------------------------------------------------------------
//
// NO shipped-defaults factory, on purpose: `apps/server/config/default.yaml` is
// the single source of every timeout value, core's loader fails loud on a
// missing key, and core's pre-boot path derives its fallback by loading that
// same file. A TS literal here would be a second, silently-drifting copy.

/**
 * The build/test GATE budget — one number for "a single full build/test gate
 * command" (install excluded), shared by the fix loops' `until_bash` gate and
 * the agent's own gate commands (passed to agentic-pi as `--gate-timeout`).
 *
 * Repo-settable subset: `timeoutSeconds` ONLY, and it is the one policy leaf
 * that may be LOOSENED by a repo — only the repo knows how long its suite takes
 * — so it is clamped `min(repo, maxTimeoutSeconds)` instead of `min(repo,
 * operator)`. `maxTimeoutSeconds` and `phaseTimeoutSeconds` are operator-only.
 *
 * Invariant (validated at config load): `timeoutSeconds <= maxTimeoutSeconds <
 * phaseTimeoutSeconds`.
 */
export interface GateConfig {
  /** Budget, in seconds, for ONE full build/test gate command. */
  timeoutSeconds: number;
  /** Operator ceiling a repo's `gate.timeoutSeconds` is clamped to. */
  maxTimeoutSeconds: number;
  /** Budget for a phase that runs a gate; must exceed {@link maxTimeoutSeconds}. */
  phaseTimeoutSeconds: number;
}

/** The `gate:` leaves a repo may never set (dropped with a warning). */
export const GATE_OPERATOR_ONLY_KEYS: readonly string[] = ["maxTimeoutSeconds", "phaseTimeoutSeconds"];

/**
 * The sandbox's default wall-clock budgets, each applying only when the phase
 * sets no `timeout_seconds` of its own. Operator-only (`sandbox:` is not
 * repo-settable).
 */
export interface SandboxTimeoutsConfig {
  /** One agent phase run. */
  agentTimeoutSeconds: number;
  /** A `type: bash` / `type: script` phase. */
  commandTimeoutSeconds: number;
  /** A `generic_loop.until_bash` check. */
  untilBashTimeoutSeconds: number;
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
 * `review.analysis.probes` — what WP4's two phases are allowed to cost.
 *
 * See {@link ReviewConfig.analysis.probes} for what each value buys. The three
 * spellings exist because `prepare` and `falsify` were gated on ONE boolean,
 * which made "run the oracle" and "install a pull request author's
 * dependencies into the workspace" the same decision when they are not.
 */
export type ProbeMode = "off" | "static" | "full";

/**
 * Read an operator's `probes` value. **Total**, and every failure direction is
 * the cheap one.
 *
 * The one compatibility property that matters: a bare `true` — every deployment
 * and every eval overlay that opted into WP4 before this key was tri-stated —
 * lands on `"static"`, so nothing silently gains an install by upgrading. Only
 * the literal string `"full"` buys a package manager.
 *
 * Everything else, including the truthy strings (`"true"`, `"yes"`, `"1"`),
 * lands on `"off"`. That preserves the spirit of the `=== true` parsing this
 * replaces: a value that merely LOOKS enabled must never spend the operator's
 * compute, and a typo must be inert rather than expensive.
 */
export function coerceProbeMode(raw: unknown): ProbeMode {
  if (raw === "full") return "full";
  if (raw === "static" || raw === true) return "static";
  return "off";
}

/**
 * What `adjudicate` reads and what it writes. See
 * {@link ReviewAnalysisConfig.adjudicate}.
 *
 * Three literals rather than a boolean because this selects a PHASE SHAPE.
 * `"jev"` is the third value this type's doc comment predicted — a per-row
 * System-1 classifier over the same dossier
 * ([#399](https://github.com/nearform/lastlight/issues/399) idea 2) — built
 * and measured 2026-09-22: 260 hypotheses across an 8-case arm, 83.6%
 * agreement with a Sonnet adjudicate call on the identical dossier evidence,
 * for $0.0053. It **implies** `"dossier"` (the rendering and the typed
 * `claim`/`category`/`fix` output are unchanged) and additionally runs
 * `jev-classify`, whose per-hypothesis category is rendered into the dossier
 * as an ADVISORY line — Sonnet still writes every disposition itself. Not a
 * replacement of the adjudicator: the measured agreement is weakest exactly
 * on the rarest, highest-stakes categories (`defect` 33%, `correctness-risk`
 * 40% recall against Sonnet's own call), so nothing here skips or overrides
 * Sonnet's judgement yet. `obligationContract` has the same three-value shape
 * for the same reason (a phase shape, not a flag).
 */
export type AdjudicateMode = "legacy" | "dossier" | "jev";

/**
 * Read an operator's `adjudicate` value. **Total**, and it fails toward the
 * shipped phase.
 *
 * Only the literals `"dossier"` and `"jev"` move a deployment. A bare `true`
 * does NOT — unlike {@link coerceProbeMode}, where `true` meant something
 * specific historically, nothing has ever written `adjudicate: true`, so
 * there is no compatibility to preserve and no reason to let a truthy-ish
 * value select an unmeasured phase shape.
 */
export function coerceAdjudicateMode(raw: unknown): AdjudicateMode {
  if (raw === "jev") return "jev";
  return raw === "dossier" ? "dossier" : "legacy";
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
 * (`docs/plans/deterministic-pr-levers.md`).
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
   * A TOTAL BACKSTOP over the **facts-derived** obligations one PR may carry,
   * across all five families `lastlight-facts seed` produces (`contract`,
   * `enforcement`, `security`, `state`, `tests`). The `spec` family has its own
   * bound above, because it is built harness-side from the issue text and
   * shares no ranking axis with these.
   *
   * **Truncation is per FAMILY, not here.** The seeder caps each family at its
   * own ceiling — `contract` 12, `enforcement` 12, `state` 8, `security` 8,
   * `tests` 8 (`FAMILY_CAPS` in `packages/code-facts/src/seed.ts`) — because
   * each family's obligations feed exactly ONE survey branch, so the cost is
   * per branch rather than per document, and cross-family ranking prices
   * incommensurable mechanism classes against each other. Measured: `contract`
   * minted 89 across the eight gate cases while `security` minted 3, and the
   * pooled budget went to `contract`.
   *
   * This number is applied AFTER those ceilings and defaults to their sum, so
   * it cannot bind on a shipped configuration — it is there so that raising one
   * ceiling is a bounded act. What it drops is counted in `obligations.json`
   * with the reason (naming the ceiling or the backstop), never silently.
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
   * What `adjudicate` is handed, and what shape it writes back.
   *
   * - `legacy` — the shipped phase. The prompt names the files and the model
   *   shells out to assemble them, then writes a `tier` and a `confidence` per
   *   finding.
   * - `dossier` — a deterministic `dossier` phase renders every record the
   *   phase needs (`lastlight-facts dossier`) and the harness attaches it, and
   *   the model writes typed ATTRIBUTES (`claim` / `category` / `fix`) from
   *   which a pure `computeTier()` derives the tier. `confidence` is not asked
   *   for.
   *
   * **One key for both halves on purpose.** They change the same phase's
   * measured surface — its input and its output — so shipping them together
   * costs ONE comparability break with the archive instead of two, and one arm
   * validates both. Splitting them would buy a second baseline nobody wants.
   *
   * What it is fixing, measured on the 8-case probes arm: `adjudicate` spends
   * **137 bash calls across 8 adjudications** (35 turns / 30 bash on the
   * stress case) re-deriving records the harness already holds — about a third
   * of case cost — and then makes its actual judgement at the end of a long,
   * noisy transcript, which is the condition under which every measured
   * failure of this phase has happened. See
   * [#399](https://github.com/nearform/lastlight/issues/399).
   *
   * Defaults to `legacy`, and an unrecognised value lands there too: the same
   * direction every switch in this block fails. No deployment changes
   * behaviour until an operator asks and an arm has measured it.
   */
  adjudicate: AdjudicateMode;
  /**
   * Which D2 minting arms `lastlight-facts seed` runs, as a comma-list over
   * `all-in-diff` (contract obligations for symbols whose every reference is
   * inside the diff) and `registrations` (security obligations for route/hook
   * registration order).
   *
   * BOTH ON by default — the measured shipped shape (8-case confirm: internal
   * paired +10/−1, p=0.006, the only lever measured to GROW the recall union
   * rather than rotate it; external validation +7/−0, p=0.008). `""` is
   * NEITHER — the pre-D2 baseline set, byte-identical to a run before the
   * toggle existed. Reaches the seeder as `--mint <spec>`
   * on the seed phase's command line, appended ONLY when non-empty, and the
   * seeder stamps what it was asked into `obligations.json` (`minting`) so an
   * artifact answers "which arm produced this". Kept a plain string rather
   * than a validated union because the CLI is the loud gate: any unknown token
   * exits 2 before the document is read — a typo'd arm can never silently run
   * baseline and report a number for an experiment that never happened.
   */
  mint: string;
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
   * WP4 — the `prepare` + `falsify` pair: prepare the probe environment, then
   * write probes and run them. **Tri-state**, and the middle value is the point.
   *
   * One key used to gate both phases, so the only way to reach the oracle was
   * to buy an install of the PR author's dependencies. That was an accident of
   * gating, not a design constraint: `review-falsify.md` already reads
   * `probes/env.json` as a fact and branches on `installed: false` — anything
   * it cannot run becomes `unprobed` with a stated reason and **survives** to
   * adjudication. The pass was written for the zero-install world before
   * anything could put it there.
   *
   * - **`"off"`** — neither phase runs. Reproduces WP3 exactly, and it is the
   *   shipped default (LD8: the whole pipeline is off out of the box).
   * - **`"static"`** — both phases run and **nothing is ever installed**.
   *   `prepare` runs with `--no-install`, so it writes a real `env.json`
   *   (`install: "skipped"`, `installed` read off the filesystem as always) and
   *   `falsify` gets the fact its prompt is written against. Seconds of CPU and
   *   no package manager, no test suite, no `postinstall` from a pull request
   *   head.
   * - **`"full"`** — today's behaviour: `prepare` installs. That buys the
   *   DISCOVERY side rather than the probe side — a `tsconfig` that `extends` a
   *   bare package specifier resolves, so `contract` can seed on a normal
   *   monorepo (measured over the 50-PR corpus: tier-1 cases 21 → 5, contract
   *   deltas 73 → 19 without it) — and it is separately decidable from wanting
   *   an oracle at all.
   *
   * **A bare `true` coerces to `"static"`**, never `"full"`: no deployment may
   * silently gain an install by upgrading. See {@link coerceProbeMode}.
   */
  probes: ProbeMode;
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
  /** Phase budget for `pr-review.yaml`'s deterministic `facts` step, in seconds. */
  factsTimeoutSeconds: number;
  /** Phase budget for the `seed` step, in seconds. */
  seedTimeoutSeconds: number;
  /** Phase budget for the `reconcile` step, in seconds. */
  reconcileTimeoutSeconds: number;
  /**
   * Phase budget for `falsify`, the oracle, in seconds.
   *
   * It had none at all until probes could run without an install, and
   * `probeRounds` was never a budget: two rounds of an agent that may write
   * and run code is a count, not a ceiling, and CPU is the constraint this
   * pipeline is bounded by. A whole-phase ceiling covering every round.
   */
  falsifyTimeoutSeconds: number;
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
   * Ten, on the evidence in *"Does AI Code Review Lead to Code Changes?"*
   * (22k+ real review comments): concise, hunk-level, actionable findings are
   * substantially likelier to lead to a change, and the wall the paper warns
   * about is TWENTY — twenty inline comments is not twice the signal of ten,
   * it is a muted bot. Ten is a ceiling, not a budget that bites: measured
   * inline volume is 1–5 per PR, so this has never bound, and anything past it
   * goes to the body rather than away.
   */
  maxInlineComments: number;
  /**
   * **REMOVED (2026-09-21): `internalFloor` and the per-family `thresholds`.**
   * Both were confidence gates, and `finding.confidence` was measured at AUROC
   * 0.228 [0.171, 0.299] over 516 findings from 20 preserved case-runs — a
   * strong signal pointing the WRONG way. They also cost nothing to remove:
   * across the preserved archive not one gold finding was lost to
   * `below-floor` or `below-threshold`. An overlay still carrying either key
   * is accepted and ignored (`config.ts` warns). See `rankOf` in
   * `apps/server/src/engine/github/review-poster.ts`.
   */
  /**
   * Cap on findings rendered into the review BODY (the "Additional findings"
   * section) — the body-side sibling of `maxInlineComments`, and the one
   * budget that DOES filter: everything past it is recorded `internal` with
   * the machine reason `body-budget` in `disposition.json`, never posted.
   * Nothing is deleted — the demotion stays auditable like every other
   * `internal` entry.
   *
   * - `null` — unlimited: the legacy funnel, where everything demoted from
   *   inline lands in the body.
   * - `0` — no overflow at all: nothing tiers to body; anything that would
   *   have gone there is recorded `internal` instead.
   * - `N > 0` — at most N body findings, ranked by severity exactly as the
   *   inline overflow ranks.
   *
   * **`5` is the shipped default, and the number it replaced is the reason.**
   * `0` was measured rather than assumed: under the production
   * Sonnet-adjudicator shape no-overflow keeps 29/36 matched gold and lifts
   * precision 0.263 → 0.492 / F1 0.362 → 0.479 on the Martian external set.
   * But the same $0 sweep showed that result is
   * **adjudicator-shape-conditional** — under Haiku-everywhere the body tier
   * carries most of the matched gold and cap 0 costs posted recall 0.42 →
   * 0.12, while MID caps keep nearly all of it (skillspro cap 4: 0.300, cap 8:
   * 0.380 against 0.420 unlimited; Martian cap 4: 0.548, cap 8: 0.581 against
   * 0.581 unlimited, at slightly better precision). `5` is the
   * recall-preserving compromise pending a real boundary tune, not a measured
   * optimum — which is also why eval overlays keep pinning this key
   * explicitly instead of inheriting whatever it currently is.
   */
  maxBodyComments: number | null;
  /**
   * The TypeSafe model id `jev-classify` calls, under `adjudicate: "jev"`.
   * `null` ⇒ the CLI's own default (`TYPESAFE_MODEL` env, else `jev-latest`) —
   * kept out of the `models:` map because TypeSafe is a separate provider
   * from the `provider/model` chat models that map resolves, and conflating
   * them would let an unrelated key silently redirect a model call nothing
   * else reads.
   */
  jevModel: string | null;
  /** Phase budget for `jev-classify`, in seconds. Cheap and fast per call (a
   * TypeSafe `systemOne` round trip is ~100ms), but the phase makes one call
   * per hypothesis and a case can carry dozens. */
  jevTimeoutSeconds: number;
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
  /**
   * Skip a re-review whose effective diff is UNCHANGED — the PR's own
   * `base...head` three-dot diff is byte-identical to the one we reviewed
   * (issue #378).
   *
   * The case this covers and `generatedPaths` cannot is a merge from the base
   * branch. A `Merge branch 'main' into feature` push changes no line the
   * author wrote, but it is a new head SHA, and the delta since our last review
   * is every file the base brought in — hundreds of hand-written ones, which
   * the generated-only gate is right to refuse to suppress. `PrState` answers
   * the other question directly by fingerprinting the three-dot diff at both
   * head SHAs. It also covers a rebase that preserves the tree and an empty
   * force-push, and it correctly does NOT fire when the base touched a file the
   * PR also touches, because the merged patch then genuinely differs.
   *
   * `false` turns the gate off. It never suppresses a first review or an
   * explicit `@bot review` / request label / check Re-run, and every degraded
   * read (a truncated compare, a file GitHub gave no patch for) dispatches.
   *
   * Repo-settable only DOWNWARD: a repo may set it `false` and buy itself more
   * review runs, never `true` over an operator who turned it off.
   */
  skipUnchangedDiff: boolean;
  /** The depth-triage phase. See {@link ReviewTriageConfig}. */
  triage: ReviewTriageConfig;
  /** The evidence pipeline. Off by default — see {@link ReviewAnalysisConfig}. */
  analysis: ReviewAnalysisConfig;
}

/**
 * The cheap model pass at the head of `pr-review.yaml` that decides how much
 * review a re-review is owed (issue #378).
 *
 * Between "the diff did not move at all" (which `skipUnchangedDiff` suppresses
 * outright) and "this is a substantial new push" there is a grey middle: a real
 * but small delta since the last review. Running the full evidence pipeline
 * over it costs roughly what the first review cost — the survey fan-out is ~75%
 * of a review's spend and ~90% of its branch-seconds — to re-derive findings
 * that have not changed.
 *
 * The phase emits one `REVIEW_DEPTH: full|light` marker, which the harvest
 * writes to `scratch.reviewTriage`; the seven analysis phases carry
 * `skip_if: "scratch.reviewTriage.depth == 'light'"` and the review prompt
 * renders a focused single-pass arm. It runs ONLY on a re-review, so a first
 * review of a PR is untouched.
 *
 * OPERATOR-ONLY, the same reasoning {@link ReviewAnalysisConfig} records: it is
 * spend, and there is no "more conservative" direction for a repo to clamp it
 * toward.
 */
export interface ReviewTriageConfig {
  /**
   * Run the triage phase on a re-review.
   *
   * ON by default, unlike `analysis`. It is not the same trade: the pipeline is
   * an unmeasured addition that buys more analysis, while triage is one cheap
   * pass that can only ever REMOVE work from a run that would otherwise have
   * happened in full. Its worst case — the model says `full`, or emits no
   * marker at all — is today's review plus one short prompt.
   */
  enabled: boolean;
  /** Phase timeout. The pass reads a diff and answers with one line. */
  timeoutSeconds: number;
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

/** The DURATION leaves of `review.analysis` — see {@link ReviewPolicy}. */
export type ReviewAnalysisDurationKey =
  | "prepareTimeoutSeconds"
  | "coverageTimeoutSeconds"
  | "factsTimeoutSeconds"
  | "seedTimeoutSeconds"
  | "reconcileTimeoutSeconds"
  | "falsifyTimeoutSeconds"
  | "jevTimeoutSeconds";

/**
 * A {@link ReviewConfig} WITHOUT its duration leaves (`triage.timeoutSeconds`
 * and the `review.analysis` phase budgets).
 *
 * Every timeout default lives in `config/default.yaml` only (issue #385), so the
 * TS factory below can no longer produce a complete `ReviewConfig`. The
 * durations are all operator-only, so the repo-layer merge never needs them
 * either: it resolves this shape, and core re-attaches the operator's
 * durations from its resolved (or packaged) config.
 */
export type ReviewPolicy = Omit<ReviewConfig, "triage" | "analysis"> & {
  triage: Omit<ReviewTriageConfig, "timeoutSeconds">;
  analysis: Omit<ReviewAnalysisConfig, ReviewAnalysisDurationKey>;
};

/**
 * The shipped `review:` POLICY — `review:` in `config/default.yaml` minus its
 * durations (see {@link ReviewPolicy}). Core's `defaultReviewConfig()` is the
 * complete, default.yaml-derived block.
 */
export function defaultReviewPolicy(): ReviewPolicy {
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
    // ON, and it is the conservative direction: the gate fires only where the
    // PR's own patch is byte-identical to the one we already reviewed, and
    // every uncertain read dispatches.
    skipUnchangedDiff: true,
    // ON by default — one cheap pass that can only remove work from a
    // re-review. See {@link ReviewTriageConfig.enabled}.
    triage: { enabled: true },
    analysis: {
      enabled: false,
      // A safety bound, not a budget — see config/default.yaml for why this is
      // 40 rather than the 6 it shipped with. It must not bind on a real PR:
      // capping generation truncates discovery, which is the measured ceiling.
      maxSpecObligations: 40,
      // The TOTAL backstop, and it is the per-family ceilings' sum
      // (12 + 12 + 8 + 8 + 8) so it cannot bind unless an operator raises one.
      maxObligations: 48,
      // `minimal` ships, measured in: under `full`, half to two-thirds of
      // survey output arrives as clean-quote verification reports that reached
      // real PRs as posted findings; under `minimal` the same recall union
      // posts with 37–71% better SNR and half the run-to-run variance. `full`
      // remains the opt-in telemetry arm (discharge codes + the
      // clean-discharge demotion at the posting boundary).
      obligationContract: "minimal",
      // `dossier` measured 2026-09-22 (mechanism confirmed; posted-recall
      // guardrail inconclusive on n=1 — repeats pending). `jev` built and
      // screened the same day (83.6% agreement with Sonnet, $0.0053) but not
      // yet compared against gold. Neither has an arm behind it yet. See the
      // field's doc.
      adjudicate: "legacy",
      // Both D2 rules — the measured shipped shape. See the field's doc.
      mint: "all-in-diff,registrations",
      surveyPasses: 6,
      surveyConcurrency: 6,
      probes: "off",
      probeLifecycleScripts: false,
      probeTypecheck: false,
      probeCoverage: false,
      probeRounds: 2,
      maxInlineComments: 10,
      // A bounded body overflow. Cap 0 measured better under the production
      // Sonnet adjudicator (precision 0.263→0.492 / F1 0.362→0.479) but that
      // win is adjudicator-shape-conditional — under Haiku-everywhere the body
      // tier carries most of the matched gold (posted recall 0.42→0.12 at 0),
      // and mid caps kept nearly all of it. 5 is the recall-preserving
      // compromise; `null` restores the legacy unlimited funnel. See the
      // field's doc.
      maxBodyComments: 5,
      // `null` ⇒ jev-classify's own default (TYPESAFE_MODEL env, else
      // jev-latest). Inert unless `adjudicate: "jev"`.
      jevModel: null,
    },
  };
}
