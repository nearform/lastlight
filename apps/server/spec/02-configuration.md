---
title: "Configuration"
order: 2
description: "Every env var the harness reads, the typed config schema, the default/overlay/env/repo layer precedence, the per-repository .lastlight/ layer and its operator bounds, model and variant overrides, sandbox backend selection, approval-gate enablement, secrets layout, and the STATE_DIR tree."
---

## Purpose

Configuration is the single source of truth for every runtime knob.
Every other component reads from the typed `LastLightConfig` value the
harness loads at boot; other spec pages cite this one rather than
redocumenting env vars locally.

The config layer's job is to parse the environment, validate the
non-negotiable bits (the GitHub App PEM, if present, must exist and
parse), apply defaults, and expose a typed object the rest of the
process consumes. Malformed JSON inputs (`LASTLIGHT_MODELS`, etc.) log a
warning and fall back — they don't crash boot.

## Schema

```ts
interface LastLightConfig {
  port: number;
  webhookSecret: string;
  botName: string;                        // GitHub App slug (no [bot]); default "last-light".
                                          // Derives the @mention handle, botLogin, and git author.
  botLogin: string;                       // "<botName>[bot]" unless BOT_LOGIN overrides
  dbPath: string;
  database: {                             // state DB. url: libsql-style (file:/:memory:) OR postgres://
    url?: string;                         //   absent = file: + dbPath
    driver?: "pg" | "neon";               //   postgres only; absent = auto-detect from the host
    poolMax?: number;                     //   postgres only; default 10
  };
  overlayDir?: string;                    // resolved $LASTLIGHT_OVERLAY_DIR, if set
  builtInRoot: string;                    // packaged asset root (parent of config/default.yaml)
  stateDir: string;
  sandboxDir: string;                     // $STATE_DIR/sandboxes
  sessionsDir: string;
  model: string;                          // provider/model, e.g. "anthropic/claude-sonnet-4-6"
  models: ModelConfig;                    // { default: string; [taskType: string]: string }
  variants: VariantConfig;                // { default?: string; [taskType: string]: string | undefined }
  maxTurns: number;
  sandbox: SandboxBackend;                // "gondolin" | "docker" | "smol" | "none" | "kubernetes"
  kubernetes?: Partial<KubernetesConfig>; // the `sandbox.kubernetes` block, normalized
  buildAssets: "repo" | "server";         // where build handoff docs live
  buildAssetsDir: string;                  // server-mode store root ($STATE_DIR/build-assets)
  deploy: { version: string | null };      // core-version pin (git tag/ref) or null = track main
  managedRepos: string[];                 // empty = source the list from the App installation
  routes: RouteConfig;                    // { github: Record<string,string>; slack: Record<string,string> }
                                          // mirrored by defaultRouteConfig() for the
                                          // no-config-loaded case; pinned equal in tests
  disabled: DisabledConfig;               // { workflows, crons, prompts, skills, agentContext }: string[]
  crons: CronsConfig;                     // { enable: string[]; disable: string[] } — cron participation
  otel: OtelConfig;                       // OpenTelemetry export (off by default)
  publicConfig: PublicConfigBundle;       // redacted default/overlay/merged + provenance, for the dashboard
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    installationId?: string;              // legacy seed only — installations are DISCOVERED
  };
  githubToken?: string;                   // PAT fallback — ONLY when no App is configured
  slack?: SlackConfig;
  approval?: Record<string, boolean>;     // gate-name → enabled
  bootstrapLabel: string;
  holdLabel: string;                      // the HOLD label — a human applies it to stop Last Light
  exploreDefaultRepo?: string;
  publicUrl?: string;
  reviewPostsCheck: boolean;              // `review.postsCheck`, flattened — predates the block below
  review: ReviewConfig;                   // when pr-review runs, + the draft/label rules
  fix: FixConfig;                         // retry budgets for the PR_FIX_SHAPED workflows
  dependencies: DependenciesConfig;       // major-bump auto-merge policy
  concurrency: {                          // global sandbox-run concurrency cap
    maxWorkflows: number;                 //   max runs executing at once (default 4)
    maxQueueWaitMs: number;               //   TTL before a queued run is dropped (default 1 hr)
  };
  cleanup: { sandbox: SandboxCleanupConfig };  // sandbox-workspace reaping
  feedback: FeedbackConfig;               // reaction-derived eval signals
  teamVisibility: TeamVisibilityConfig;   // per-repo dashboard visibility from GitHub teams
  repoConfig: RepoConfigPolicy;           // operator bounds on the per-repository layer
}

interface TeamVisibilityConfig {
  enabled: boolean;                       // OFF by default — needs the App's org Members: read
  ttlMinutes: number;                     // how long a resolved answer is reused (default 60)
  maxTeamsPerUser: number;                // more teams than this ⇒ fail open (default 50)
  maxPagesPerTeam: number;                // 100 repos/page; a bigger grant ⇒ fail open (default 20)
  maxRequestsPerResolve: number;          // ceiling for one cache miss (default 60)
}

interface OtelConfig {
  enabled: boolean;                       // master switch (LASTLIGHT_OTEL_ENABLED)
  serviceName: string;                    // OTEL service.name (default "lastlight")
  includeContent: boolean;                // attach prompt/message/tool content (default false)
  forwardToSandbox: boolean;              // also emit telemetry from inside the sandbox (default true)
  strict: boolean;                        // throw on OTEL init failure instead of warning (default false)
  metrics: boolean;                       // export OTLP metrics (default true; false = traces only)
  collectorHosts: string[];               // extra collector hosts for the gondolin egress allowlist
}

interface SlackConfig {
  botToken: string;
  mode: "webhook" | "socket";             // auto: webhook when a signing secret is set, else socket
  appToken?: string;                      // required only for socket mode
  signingSecret?: string;                 // required only for webhook mode
  allowedUsers: string[];
  deliveryChannel?: string;                // last-resort channel (SLACK_DELIVERY_CHANNEL)
  repoChannels: Record<string, string>;    // "owner/repo" -> channel id (overlay `slack.repoChannels`)
}

interface DigestConfig {                   // the weekly repo digest; operator-only
  windowDays: number;                      // how far back a digest looks (default 7)
  narrative: boolean;                      // spend one cheap model call summarizing the week (default true)
  maxItems: number;                        // cap on the escalation list (default 5)
  listItems: number;                       // cap on each content list — merged PRs, issues opened/closed (default 8, max 25)
  detailItems: number;                     // how many items' text the summariser reads (default 25, max 60)
}

interface SandboxCleanupConfig {
  enabled: boolean;                       // master switch for the TTL/LRU sweep (default true)
  reapOnCompletion: boolean;              // reap an ephemeral workspace on terminal success (default true)
  sweepSchedule: string;                  // cron expr for the backstop sweep (default "0 * * * *")
  retentionHours: number;                 // sweep dirs older than this (default 12)
  maxDirs: number;                        // LRU cap on workspace dirs (default 40)
}

interface FeedbackConfig {                // issue #255 — operator-only, never repo-settable
  enabled: boolean;                       // master switch; Slack signals are live (default true)
  github: boolean;                        // opt into the GitHub reaction poller (default FALSE)
  pollSchedule: string;                   // cron expr for that poller (default "*/30 * * * *")
  windowDays: number;                     // how long an anchor stays pollable (default 14)
  maxAnchorsPerTick: number;              // hard budget: /100 = GraphQL requests (default 500)
  retentionDays: number;                  // anchors pruned past this; signals kept (default 90)
  otel: boolean;                          // export each signal onto the run's trace (default true)
}

interface CronsConfig {                   // valid at EVERY layer (default / overlay / repo)
  enable: string[];
  disable: string[];                      // the legacy `disabled.crons` list is unioned in here
}

interface ReviewConfig {                  // when a pr-review run is triggered
  postsCheck: boolean;                    // post the `last-light/review` Check Run
  trigger: "eager" | "after-checks" | "on-request";
  requestLabel: string | null;            // the label that asks for one in `on-request`
  skipDraft: boolean;                     // skip draft PRs
  generatedPaths: string[];               // derived paths — a push touching only these earns no re-review
  analysis: ReviewAnalysisConfig;         // the review evidence pipeline; OFF by default, operator-only
}

interface ReviewAnalysisConfig {          // docs/plans/deterministic-pr-levers.md
  enabled: boolean;                       // false ⇒ today's two-phase review (analysis phases skip; the review brief keeps its full-procedure mode)
  maxSpecObligations: number;             // SAFETY BOUND for the `spec` family — should never bind
  maxObligations: number;                 // TOTAL backstop over the five facts-derived families — truncation is PER FAMILY (see below); defaults to the ceilings' sum, so it cannot bind unless one is raised
  obligationContract: "full" | "minimal"; // WHICH obligation block the six families are handed — minimal ships; full is the telemetry arm
  mint: string;                           // D2 seed mint rules, comma-list of "all-in-diff" / "registrations" — BOTH ON by default; "" = pre-D2 baseline set
  surveyPasses: number;                   // how many of the six families run (six)
  surveyConcurrency: number;              // how many run AT ONCE; clamped by the backend ceiling
  probes: boolean;                        // install deps so a probe can be RUN (+ the four below)
  probeLifecycleScripts: boolean;         // off: a postinstall at a PR head is the author's code
  probeTypecheck: boolean;
  probeCoverage: boolean;
  prepareTimeoutSeconds: number;
  coverageTimeoutSeconds: number;
  probeRounds: number;
  maxInlineComments: number;              // attention boundary — a budget, not a filter
  thresholds: Record<string, number>;     // confidence bar PER obligation family
  internalFloor: number;                  // below this a finding is recorded, not posted
  maxBodyComments: number | null;         // cap on the review BODY — the one budget that DOES filter; null = unlimited (legacy)
}

interface FixConfig {                     // budgets for every PR_FIX_SHAPED workflow
  maxAttempts: number;                    // cross-run attempts per (repo, PR) before requires-human
  localIterations: number;                // gate-loop iterations WITHIN one attempt
  gateTimeoutSeconds: number;             // until_bash budget for the build/test gate
  escalateModelAfterAttempt: number;      // attempts above this use models["pr-fix-retry"]
  maxCostUsd: number | null;              // cumulative ceiling for ONE PR; null = unbounded
  maxFlakyDeferrals: number;              // `flaky` verdicts before one counts as reproducible
  retryableClasses: string[];             // diagnosis classes another attempt may help with
}

interface DependenciesConfig {            // how far a MAJOR dependency bump may auto-merge
  autoMergeMaxImpact: "none" | "low" | "medium" | "high";  // PROMPT-LEVEL — see below
  requireSettledChecks: boolean;          // `mayMerge` demands settled-"passing"
  minSettledChecks: number;               // ...and >= N settled checks; 0 = legacy
  auditComment: boolean;                  // post the evidence comment when auto-merging a major
}

interface RepoConfigPolicy {              // lastlight-shared/repo-config-schema
  enabled: boolean;                       // false ignores every repo's .lastlight/ (no fetch)
  allowKeys: string[];                    // dotted config paths a repo may set
  allowedModels: string[] | null;         // null = any model whose provider prefix is known
  allowAssets: boolean;                   // unpack the repo's prompt/skill/agent-context overrides
  allowedImages: string[] | null;         // null = NO image permitted (inverse of allowedModels)
  maxServices: number;                    // ceiling on dependency services per phase
}

interface KubernetesConfig {              // resolved by resolveKubernetesConfig(), env > block > defaults
  namespace: string; image: string; storageClassName: string; workspaceSize: string;
  runAsUser: number; harnessEndpoint: string; harnessNamespace: string;
  harnessPodLabels: Record<string, string>; forwarderImage: string;
}
```

Defined in `src/config/config.ts` (`LastLightConfig` + the interfaces above;
`RepoConfigPolicy` is imported and re-exported from
`lastlight-shared/repo-config-schema`, and `DisabledConfig` / `RouteConfig` /
`ReviewConfig` / `FixConfig` / `DependenciesConfig` from
`lastlight-shared/config-types`). The three policy blocks live in the leaf
package for a sharper reason than the other two: they are **repo-settable**, so
the sanitizer that bounds a repo's `.lastlight/` — compiled into the CLI as well
as core — has to know their shape *and* their shipped defaults. Core's
normaliser and the repo-layer clamps therefore agree by construction rather than
via two hand-maintained copies. Loaded once at boot, never mutated. A
re-implementation should treat this object as effectively `Readonly` —
any per-task overrides are layered *over* the base config at dispatch
time, not back into it. The one exception is the **per-repository layer**
(below), which is resolved per dispatch and carried explicitly through the run,
never merged back into this object.

## Layers and precedence

Configuration resolves in four layers, last wins, key by key:

```
config/default.yaml  →  $LASTLIGHT_OVERLAY_DIR/config.yaml  →  env  →  <target repo>/.lastlight/lastlight.yml
    (packaged)                  (operator overlay)           (env)              (per-repo, bounded)
```

The first three are the **boot** layers, resolved once by `resolveConfigLayers`
(`src/config/config-resolve.ts`) into the merged tree *plus* a parallel
provenance tree (each leaf tagged `default` / `overlay` / `env`), which the
dashboard's Config view is derived from. Merge semantics are one definition,
`mergeLayer` in `lastlight-shared/repo-config-schema`, re-exported by
`config-resolve.ts`: **plain objects deep-merge key by key; arrays and scalars
replace wholesale.** So `models` / `variants` / `routes` / `approval` merge,
while `managedRepos` and every `disabled.*` list replace.

Two documented exceptions to plain key-by-key precedence, handled in
`loadConfig` rather than in the resolver:

- `approval` — `APPROVAL_GATES` replaces the file map *wholesale*, not merged.
- `otel.collectorHosts` — env hosts are *unioned* with file hosts, not replaced,
  so an OTLP endpoint env var adds to rather than drops overlay hosts.

Secrets are **env-only** and never read from YAML. `publicConfig` carries a
redacted (`SENSITIVE_KEY_RE` / `redactPublic`) copy of default / overlay /
merged / sources for the dashboard.

## The per-repository layer (`.lastlight/`)

A **managed repo** may commit a `.lastlight/` directory that overrides a bounded
subset of config *for runs against that repo only*. It is the fourth layer above
— applied after env, bounded by the operator's `repoConfig` block.

```
.lastlight/
├── lastlight.yml              # the config override
├── workflows/prompts/*.md     # prompt overrides — a repo may NOT contribute workflow YAML
├── skills/<name>/SKILL.md     # skill overrides
└── agent-context/*.md         # ADDITIVE ONLY — may not shadow a built-in/overlay file by basename
```

The layout mirrors a deployment overlay exactly, so the unpacked tree is handed
to the same layer-aware asset loader with no second code path.

**Trust rule.** The layer is always read from the repo's **default branch**,
resolved live from the repo metadata — never a PR head, never the sandbox
checkout. Without that rule a pull request could commit a `lastlight.yml` that
re-points the model, disables the review workflow and drops the approval gates of
the very agent reviewing it. Enforced in `src/config/repo-config.ts`.

**Failure rule.** Warn, drop the offending bits, run anyway. Invalid YAML drops
the whole file; an unknown or out-of-bounds key drops just that key; a fetch
error falls back to the last good cached copy, or to no layer at all. Every
rejection becomes a structured `RepoConfigWarning` (codes: `invalid-yaml`,
`not-a-mapping`, `key-not-allowed`, `invalid-value`, `model-not-allowed`,
`unknown-provider`, `approval-downgrade`, `policy-downgrade`, `path-escape`, `symlink`, `size-cap`,
`file-count-cap`, `workflow-not-allowed`, `assets-not-allowed`,
`unrecognised-asset`, `fetch-failed`) surfaced on the run row, the admin API and
the CLI. A repo's config file can never fail a run.

### Operator bounds (`repoConfig` in `config/default.yaml`)

| Key | Default | Meaning |
|---|---|---|
| `repoConfig.enabled` | `true` | Master switch. `false` ignores every repo's `.lastlight/` — no fetch at all. |
| `repoConfig.allowKeys` | `[models, variants, crons, disabled.workflows, disabled.crons, approval, fix, dependencies, review, notifications, services]` | Dotted config paths a repo may set. An entry admits itself and everything beneath it (`models` admits `models.architect`; `disabled.workflows` does **not** admit `disabled.prompts`). |
| `repoConfig.allowedModels` | `null` | `null` = any model whose `provider/` prefix is a provider Last Light can wire. A list restricts to exactly those specs (exact match, never a prefix rule). |
| `repoConfig.allowAssets` | `true` | Unpack and use the repo's `workflows/prompts/`, `skills/`, `agent-context/` overrides. `false` keeps `lastlight.yml` only. |
| `repoConfig.allowedImages` | `[]` → `null` | Container images a repo may run as dependency services, registry-qualified (`docker.io/library/postgres:*`, `mcr.microsoft.com/mssql/server:*`). **Note the polarity is the INVERSE of `allowedModels`:** absent, `null` or `[]` permits **nothing**. A service image is arbitrary code pulled onto the operator's infrastructure, so the feature is inert until images are listed. Empty normalises to `null` so "unset" and "empty" are one state. |
| `repoConfig.maxServices` | `2` | Ceiling on dependency services per phase. |

`DEFAULT_REPO_CONFIG_ALLOW_KEYS` (`packages/shared/src/repo-config-schema.ts`) is
the fallback when config isn't in reach, and must stay identical to
`repoConfig.allowKeys` in `config/default.yaml` — pinned by
`tests/config/repo-config-shared.test.ts`.

### What a repo may set

| Key | Semantics |
|---|---|
| `models` | Per-task model map. Each leaf must be a `provider/model` string with a known provider prefix, and must pass `allowedModels`. |
| `variants` | Per-task reasoning-effort map (non-empty strings). |
| `crons` | `{ enable, disable }` — cron participation (see below). Accepted and validated, but **not** part of the merged per-run config: it is read off the raw layer by the scheduler at tick time. |
| `disabled.workflows` | A repo opting *itself* out of a workflow. Enforced at the `dispatchWorkflow` choke point — the dispatch is refused before any `workflow_runs` row exists. |
| `disabled.crons` | Legacy spelling of `crons.disable`, unioned into it. |
| `approval` | **Add-only.** A repo may raise a gate for runs against itself (`true`); every `false` is dropped with a warning (`approval-downgrade` when the operator had set that gate). A repo can never remove oversight the operator asked for. |
| `fix` | Retry budgets for the PR_FIX_SHAPED workflows. **One-way clamped** — see below. |
| `dependencies` | Major-bump auto-merge policy. **One-way clamped** — see below. |
| `review` | When `pr-review` runs, plus the draft/label rules. **One-way clamped** — see below. |
| `notifications` | Where this repo's outbound Slack goes (`notifications.slack.channel`). The one repo-settable key with **no clamp direction** — see below. |
| `services` | Dependency services a phase runs against (a test postgres, redis, …). A **capability grant**, not a clamp: it is a request measured against `allowedImages`, so shape is validated and a disallowed image is dropped with a `service-not-allowed` warning. See `09-sandbox.md` → "Dependency services". |

Arrays replace, per the merge semantics above — so a repo's `disabled.workflows`
list replaces the operator's rather than adding to it. Operators who don't want
that remove the key from `allowKeys`.

Anything outside `allowKeys` — and anything inside it that this schema has no
validator for — is dropped with a `key-not-allowed` warning. Refusing unknown
keys is deliberate: an unbounded pass-through would let an operator widen the
layer past what has been reviewed.

### The policy blocks: a repo may only be *more* conservative

`fix`, `dependencies` and `review` are budgets and blast-radius dials, not
preferences, so admitting them wholesale would let a repo vote itself a bigger
share of the operator's money and machines. The generalisation of `approval`'s
add-only rule covers all three: **a repo may only ever be more conservative than
the operator.** A leaf that would loosen is *dropped* — and dropping is the
clamp, because the base already carries the operator's value, so the dropped
leaf resolves to exactly it. The repo is told why with a `policy-downgrade`
warning; the run proceeds either way.

| Key | Repo-settable | Clamp |
|---|---|---|
| `fix.maxAttempts` | yes | `min(repo, operator)` |
| `fix.localIterations` | yes | `min(repo, operator)` |
| `fix.maxFlakyDeferrals` | yes | `min(repo, operator)` |
| `fix.maxCostUsd` | yes | `min(repo, operator)`; a repo may not propose `null`, which means "no ceiling" and is therefore the loosest value there is |
| `fix.retryableClasses` | yes | validated against the five diagnosis classes, then a **subset** of the operator's list — naming a class the operator doesn't retry would *add* a retryable failure mode; the remaining (possibly empty) subset stands, since retrying less is always allowed. A member that is not a diagnosis class at all is reported as `invalid-value`, not `policy-downgrade`: a typo and a policy decision are different problems with different fixes |
| `fix.escalateModelAfterAttempt` | **no** | operator-only — spend control |
| `fix.gateTimeoutSeconds` | **no** | operator-only — a shared-resource budget, not a "how careful is this repo" dial |
| `dependencies.autoMergeMaxImpact` | yes | the **lower** tier on `none < low < medium < high` (a clamp on a *prompt-level* ceiling — see below) |
| `dependencies.requireSettledChecks` | yes | add-only `true` — a repo may demand settled checks, never waive the operator's requirement |
| `dependencies.minSettledChecks` | **no** | operator-only — see below |
| `dependencies.auditComment` | yes | add-only `true` — a repo may *ask* for the auto-merge audit record, never silence one the operator requires. It is not cosmetic: it is the record of a major version this deployment auto-merged into that repo, and the party it would silence is the party being audited |
| `review.trigger` | yes | the **lower** tier on `on-request < after-checks < eager`. The three modes are equally *safe* and not equally *expensive*: `eager` buys a full agent review per push, on the operator's budget. Opting down is still entirely the repo's call |
| `review.requestLabel` | yes | free, but validated as a label **name** (no `/`, no `..`) — same guard `disabled` applies to workflow names. Naming one only ever ADDS an explicit, human-initiated route; the operator's own label keeps working. Both are honoured at the `pr.labeled` router branch |
| `review.postsCheck` | yes | add-only `true` — a repo may ask for the check, never suppress one a branch-protection rule may be requiring |
| `review.skipDraft` | yes | add-only `true` — a repo may skip drafts, never force reviews onto them |
| `review.generatedPaths` | yes | **superset**-only — the mirror of `fix.retryableClasses`. A longer list suppresses more re-reviews, which is the conservative direction; dropping one of the operator's patterns buys the repo an extra agent run per lock-file bump on the operator's budget. An omitted operator pattern is restored (arrays replace wholesale on merge, so the clamp keeps the union) and reported as `policy-downgrade` |
| `review.analysis` | **no** | operator-only — the review evidence pipeline is spend, and there is no "how careful is this repo" direction to clamp it in. Turning it **on** buys extra analysis on the operator's budget; turning it **off** against an operator who enabled it opts the repo out of the review machinery the deployment chose. Neither is the repo's call. It is also the one `review:` leaf that NESTS, so its provenance is reported under a dotted key (`analysis.enabled`), exactly as `notifications.slack.channel` is |

An add-only key given `false` is dropped as `policy-downgrade` when the operator
actually had the stricter value, and as `invalid-value` when it didn't — the key
is add-only either way, but only the first case is a repo *losing* an argument
with its operator.

The four operator-only leaves are reported as `key-not-allowed`, the same code
an operator narrowing `allowKeys` produces, because from the repo's side it is
the same answer: this key is not yours to set. `minSettledChecks` is the
interesting one — the obvious clamp, `max(repo, operator)`, would weld the escape
hatch shut for a repo with **no CI at all**, which could then only ever raise the
number of settled checks an auto-merge needs and never lower it to `0`. That case
belongs to the merge decision (a `checksState` of `none`), not to a config clamp.

**Where `dependencies` is enforced.** The block is enforced in two different
ways and the difference matters when reading it as a safety property.
`requireSettledChecks` and `minSettledChecks` are **code**: `mayMerge`
(`src/engine/pr-decisions.ts`) evaluates them against the resolved check state
before the run starts, and the merge prompt is handed the verdict as
`{{mayMerge}}` / `{{mayMergeReason}}` with an instruction not to re-derive it —
one predicate, one reading. `requireSettledChecks` additionally makes the
dispatch gate refuse a `pending` PR outright. `autoMergeMaxImpact` is
**prompt-level**: the impact tier is the agent's own judgement, self-reported in
the `ASSESSMENT_COMPLETE` marker, and the ceiling reaches the run only as text
in `workflows/prompts/dependabot-pr-merge.md`. No code parses `impact=`,
compares it to the ceiling, or withholds the merge capability from a phase whose
tier came back above it — the phase must run either way, because it also labels
and comments. So the settled-checks pair bounds *when* a merge may be decided;
the ceiling is policy the agent is asked to honour.

That makes the tier's accuracy a **measured** property rather than an enforced
one, which is why it has an eval: `apps/evals/datasets/dependency-merge/` runs a
major bump per tier and grades the `impact=` the agent reports. Its first run
earned its keep — an agent that classified a major FUNCTIONAL was recording
`impact=none`, which is safe (nothing auto-merges) but erases the impact label
the audit trail depends on. The wording that permitted the reading is fixed.

`review.postsCheck` predates the block and is still **mirrored** flat as
`config.reviewPostsCheck` (the `REVIEW_POSTS_CHECK` env var below) for the
public-config surface — one value projected two ways rather than a second source
of truth. Nothing reads the flat copy any more: the check lifecycle resolves
`review.postsCheck` off the run's repo-clamped config, so a repo that asked for
the check gets it.

### `notifications:` — routing, not policy

`notifications.slack.channel` is where this repo's weekly digest goes. It is the
one repo-settable key with **no clamp direction**: a channel has no "more
conservative" value, so the one-way rule the policy blocks share does not apply
and the repo's answer simply wins.

What bounds it instead is not a bound at all, and that is the point:

- the layer is **always read from the repo's default branch**, never a PR head,
  so a pull request cannot redirect the output of the agent reviewing it;
- Slack will not deliver to a channel the bot has not been invited to. A hostile
  `.lastlight/` achieves `channel_not_found`, which is logged and skipped.

Validation is therefore about SHAPE only — a channel id (`C…`/`G…`/`D…`), a
`#channel-name`, or `null`, at most 80 characters. Anything else is dropped with
an `invalid-value` warning, so a typo surfaces on the run row rather than as a
silent failure once a week.

`channel: null` is **meaningful and preserved**: it says "send me no digest" and
beats the operator's `slack.repoChannels` entry. Because a merged `null` cannot
say whether the repo chose it or never set the key, the resolver reads
**provenance** — `sources.notifications["slack.channel"] === "repo"` — which is
exactly the question being asked. That is also why this leaf is flattened to a
dotted key in `RepoConfigSources`, where every other block is one level deep.

The operator's kill switch is the generic one: drop `notifications` from
`repoConfig.allowKeys` and step 1 of the resolution chain disappears.

Full resolution order and the operator-side `slack.repoChannels` map:
[Integrations → Where a repo's Slack output goes](/spec/03-integrations).

### Cron participation (`crons:`)

The `crons: { enable, disable }` block is valid at **every** layer, read with a
layer-specific meaning:

| Layer | `disable: [x]` | `enable: [x]` |
|---|---|---|
| operator (`default.yaml` / overlay) | cron `x` is off **by default**, globally | no-op — a cron is on unless something disables it |
| repo (`.lastlight/lastlight.yml`) | this repo drops out of `x`'s fan-out | this repo opts **in**, even when `x` is off globally |

A name in both lists is disabled, at every layer — a cron that doesn't run is the
safe reading of a contradictory config. The legacy `disabled.crons` list is
unioned into `crons.disable` by the normaliser (and additionally drops the cron's
definition at asset-load time, so it is the harder kill).

"Off globally" means "off by default", **not** "structurally removed": the tick
stays registered (`src/cron/jobs.ts` marks it `_cronGloballyEnabled: false`) so a
repo's opt-in can be resolved at fan-out time (`resolveCronRepos`,
`src/cron/repo-crons.ts`) without re-registering croner jobs. A tick whose repo
list resolves empty is a cheap no-op. **The operator's un-overridable kill switch
is removing `crons` from `repoConfig.allowKeys`** — `repoLayerMayVote()` then
short-circuits with zero fetches and the operator's `crons.disable` is final.

### Fetch, cache, and per-run wiring

- **Fetch** — through the App-authenticated GitHub client
  (`GitHubClient.fetchRepoConfigTree`), so private repos work. A PAT is used when
  no App is configured; chat-only mode (neither) skips the layer entirely.
- **Cache** — `<stateDir>/repo-config/<owner>/<repo>/`, holding `meta.json` (a
  sidecar: default branch, tree sha, etag, warnings) beside `files/` (the
  unpacked tree; written to `files.tmp` and renamed, so a crash can't leave a
  half-written layer). TTL `REPO_CONFIG_TTL_MS` = 60 s; past it a **conditional**
  request goes out (etag / tree sha), so a cron fanning out over N repos costs N
  conditional requests and zero downloads. Caps: `REPO_CONFIG_MAX_FILES` = 200,
  `REPO_CONFIG_MAX_BYTES` = 2 MiB. Symlinks and non-regular blobs are rejected on
  sight.
- **Resolution** — once per dispatch, at the `dispatchWorkflow` choke point in
  `src/index.ts` (beside the unmanaged-repo guard), so webhook, router, cron,
  `/api/run`, `/api/build` and approval resume all get the same answer.
  Only a context naming exactly **one** repo resolves a layer
  (`soleRepoInContext`).
- **Per-run carriage** — the result (`RunRepoConfig`, `src/workflows/simple.ts`)
  is carried explicitly through the run, never installed into a module global:
  up to `concurrency.maxWorkflows` runs plus a cron fan-out are in flight at
  once. Assets resolve through a **per-run `AssetResolver`**
  (`createAssetResolver` in `packages/shared/src/workflow-loader.ts`) built over
  `globals + makeLayer("repo", <cache root>)` with
  `agentContextAdditiveOnly: true`. The composed agent context travels as
  `ExecutorConfig.agentContext` (see [Sandbox](/spec/09-sandbox)).
- **Persistence + resume** — what the repo actually won is persisted on
  `workflow_runs.context.repoConfig` (`RepoConfigRunRecord`: repo, default
  branch, tree sha, the leaves whose provenance is `repo`, asset paths,
  warnings). A **resume reuses that record** rather than re-resolving, so an edit
  made while a run was paused/queued/dead can't retarget it mid-flight. The one
  unpinnable part is the unpacked asset root — recovered by exact tree-sha match,
  and dropped with a warning (never silently swapped) when that tree is gone.
- **Reporting** — asset-level drops (a repo `agent-context/*.md` ignored because
  a higher-trust layer owns that basename) land on
  `workflow_runs.scratch.repoConfig.assetWarnings`.

Surfaces: `GET /admin/api/repos/:owner/:repo/config` (merged config + per-leaf
provenance + the raw, redacted repo layer + warnings + assets + the effective
policy; `?refresh=1` bypasses the TTL) powers the dashboard's per-repo **Config**
tab and `lastlight repo config show <owner/repo>`. `lastlight repo fork` and
`lastlight repo config validate` are the authoring side, offline, running the
same pure validators from `lastlight-shared/repo-config-schema`.

**Known gap.** The dashboard mirrors `RepoMergedConfig` / `RepoConfigSources` by
hand in `apps/server/dashboard/src/api.ts` (the SPA has no import edge to core),
and those copies do not yet carry `fix` / `dependencies` / `review` — so the API
returns the blocks with full provenance but the per-repo **Config** tab doesn't
render them. The CLI's `repo config show` does.

## Env vars, by group

The defaults below are what the harness produces if the var is unset.
Required vars are fatal only if the *feature* they gate is needed —
missing `GITHUB_APP_ID` is fine for a chat-only deployment.

### GitHub App

| Var | Required for | Default |
|---|---|---|
| `GITHUB_APP_ID` | GitHub integration | — (its presence is what gates the whole `githubApp` block) |
| `GITHUB_APP_INSTALLATION_ID` | nothing — **optional legacy seed**. Installations are discovered from the App JWT and resolved per repo owner (see "Multi-installation GitHub Apps" below); this is only the last-resort answer when that lookup itself fails. | — |
| `GITHUB_APP_PRIVATE_KEY_PATH` | GitHub integration | — (**required** once `GITHUB_APP_ID` is set; the deploy stack points it at `secrets/app.pem`) |
| `GITHUB_TOKEN` | PAT **fallback** — read-only GitHub in chat + CLI-driven read-only workflows without the App. Ignored whenever a GitHub App is configured (App always wins). | — |
| `WEBHOOK_SECRET` | webhook signature verification | empty (verification **disabled**) |
| `GITHUB_APP_BOT_NAME` | bot slug — `@mention` handle + `botLogin` + git author (also overlay `botName`) | `last-light` |
| `BOT_LOGIN` | self-event filtering (overrides the `<botName>[bot]` derivation) | `<botName>[bot]` |

The PEM is validated at boot (`validateConfig()` in `src/index.ts`): it must exist and
parse as PEM. Missing or malformed PEM exits `78` (`EX_CONFIG`).
`resolveGithubAuth()` is the single place the App-vs-PAT precedence lives.

### Slack

| Var | Required for | Default |
|---|---|---|
| `SLACK_BOT_TOKEN` | Slack at all | — |
| `SLACK_MODE` | receive transport: `webhook` or `socket` | auto: `webhook` if `SLACK_SIGNING_SECRET` set, else `socket` |
| `SLACK_SIGNING_SECRET` | required for `webhook` mode (Events API signature) | — |
| `SLACK_APP_TOKEN` | required for `socket` mode (Socket Mode) | — |
| `SLACK_ALLOWED_USERS` | allowlist (comma-separated user IDs) | empty = all allowed |
| `SLACK_DELIVERY_CHANNEL` / `SLACK_HOME_CHANNEL` | last-resort channel for the repo digest, after a repo's own `notifications.slack.channel` and the operator's `slack.repoChannels` map | none |
| `SLACK_OAUTH_CLIENT_ID` / `SLACK_OAUTH_CLIENT_SECRET` / `SLACK_OAUTH_REDIRECT_URI` | "Login with Slack" for dashboard | none |
| `SLACK_ALLOWED_WORKSPACE` | restrict OAuth to one team | none |
| `CHAT_BATCH_DEBOUNCE_MS` | settle window to coalesce a bursty thread before classifying (see [Chat](/spec/11-chat)) | `700` (0 disables) |

Presence of `SLACK_BOT_TOKEN` gates the `slack` config sub-object.
Without it, the Slack connector never registers.

### Models and reasoning

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_MODEL` / `OPENCODE_MODEL` | base model for all phases | `anthropic/claude-sonnet-4-6` |
| `LASTLIGHT_MODELS` / `OPENCODE_MODELS` | per-phase model overrides (JSON) | `{}` |
| `LASTLIGHT_THINKING` / `OPENCODE_VARIANT` | base reasoning-effort | (provider default) |
| `LASTLIGHT_THINKINGS` / `OPENCODE_VARIANTS` | per-phase reasoning overrides (JSON) | `{}` |
| `ANTHROPIC_API_KEY` | provider auth | — |
| `OPENAI_API_KEY` | provider auth | — |
| `OPENROUTER_API_KEY` | provider auth | — |

`OPENCODE_*` names are kept as legacy aliases — the runtime is now
agentic-pi / pi-ai, but production deployments may still set the old
names and we don't want to break them. New deployments should prefer
`LASTLIGHT_*`.

JSON parse failures on `*_MODELS` / `*_VARIANTS` log a warning and use
`{}` — they do not crash boot.

### Models / variants override JSON

```json
LASTLIGHT_MODELS={
  "default":   "anthropic/claude-sonnet-4-6",
  "architect": "anthropic/claude-opus-4-7",
  "chat":      "anthropic/claude-haiku-4-5",
  "triage":    "openai/gpt-4-turbo"
}

LASTLIGHT_THINKINGS={
  "default":   "low",
  "architect": "high",
  "reviewer":  "high",
  "triage":    "minimal"
}
```

Keys are phase names from YAML workflows (e.g. `architect`, `reviewer`)
or skill types (e.g. `chat`, `triage`). `default` is the catch-all.
`config/default.yaml`'s commented examples also name `diagnose` (the CI-failure
classifier that opens both fix workflows) and `pr-fix-retry` — which, when set,
`escalateFixModel` (`src/workflows/simple.ts`) substitutes for `models["pr-fix"]`
above `fix.escalateModelAfterAttempt`, before the map is persisted
on the run context, so the admin panel shows the model that attempt actually used.
The leaf is expressed in *attempts* and stays that way, but what it is compared
against is `priorAttempts.length + 1` — the **journal**, not the `attempt`
counter. `attempt` is a budget position that re-arms on a push or a recorded
retry, so keying the model on it downgraded a PR that had already failed three
times back to the base model the moment somebody asked for another go. The
journal survives a retry (and is wiped by a push, where the code genuinely
changed), so it is the count that knows how many times this has actually been
tried. Each retry also leaves a seam line in the journal, so the count runs one
ahead per intervention — the conservative direction. Unset, nothing changes at
any attempt number. `diagnose` is left **unset** on purpose:
those examples are Anthropic models, and pinning one packaged would send that
phase at a provider a deployment overriding only `models.default` has no key for.
Unset it falls through to `default` — a cheap model there is the whole point of
splitting the phase out, so it is worth pinning per deployment.
`pr-review.yaml` adds two more: `review-survey` (the survey fan-out's branches,
plus `falsify`) and `review-adjudicate` — the adjudicate phase's own key, so an
overlay can move the ranking pass without moving `models.review`. The latter is
the one key with its own fall-through: the phase's `model:` template is an
`{{#if}}` pair that renders `models.review` when the key is unset, because a
bare `{{models.review-adjudicate}}` would render *empty* and resolve to the
default model, not to `models.review`.

**`review-survey` is the one key `config/default.yaml` ships SET**, to
`anthropic/claude-haiku-4-5-20251001` — the opposite of the `diagnose` rule
above, and deliberately. It is not a cost downgrade: on review *recall* Haiku
4.5 beats Sonnet 4.6 on two independent evals (41.2% vs 22.1% on the Martian
corpus), so it is the better model for hypothesis generation, which is what a
survey branch does. Unset it fell through to `default`, and every recall, cost
and latency number recorded for the evidence pipeline assumes Haiku surveys —
so the silent fall-through meant an operator who turned the pipeline on ran six
Sonnet phases under a configuration nothing had measured. A wrong-provider
failure is loud on the first run; a quietly-different model is not. **A
non-Anthropic deployment must therefore override `models.review-survey` in its
overlay**, as it already overrides `models.default`.
Resolution at dispatch (`resolveModel` / `resolveVariant`, `src/config/config.ts`):
per-type if present, else `default`, else the base `LASTLIGHT_MODEL`.
A repo's `.lastlight/lastlight.yml` can add per-task entries on top for runs
against that repo (see the per-repository layer above). Thinking values are pi-ai's
`ThinkingLevel`: `off | minimal | low | medium | high | xhigh`.

### Sandbox

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_SANDBOX` | backend: `gondolin` / `docker` / `smol` / `none` / `kubernetes` | `gondolin` (config `sandbox.backend`) |
| `MAX_TURNS` | agent loop budget per session | `200` (config `sandbox.maxTurns`) |
| `SANDBOX_MEMORY_LIMIT` | docker only — per-sandbox `--memory`/`--memory-swap`. Raised from `2g` because a type-aware `lastlight facts` pass peaks at 2.4–3.0 GB on a bare tree and 3.5–4.4 GB on an installed one; an OOM there exits 134 with no envelope, which a review cron then re-dispatches every 30 min. Lower it on a small host — the cost is n × this per concurrent sandbox. | `8g` |
| `SANDBOX_DATA_VOLUME` | docker only — named volume or bind-mount path | `lastlight_agent-data` |
| `LASTLIGHT_SANDBOX_NETWORK` | docker only | `lastlight_sandbox-egress` |
| `SMOLVM_BIN` | smol only — `smolvm` CLI path | `smolvm` |
| `SMOLVM_IMAGE` | smol only — OCI ref OR local `docker save` archive | `lastlight-sandbox:latest` |
| `LASTLIGHT_K8S_NAMESPACE` / `K8S_SANDBOX_IMAGE` / `LASTLIGHT_K8S_STORAGE_CLASS` / `LASTLIGHT_K8S_WORKSPACE_SIZE` / `LASTLIGHT_K8S_RUN_AS_USER` / `LASTLIGHT_K8S_HARNESS_ENDPOINT` / `LASTLIGHT_K8S_HARNESS_NAMESPACE` / `LASTLIGHT_K8S_HARNESS_POD_LABELS` | kubernetes only — override the matching `sandbox.kubernetes.*` config key | see `K8S_DEFAULTS` in `src/config/config.ts` |

Unknown `LASTLIGHT_SANDBOX` values log a warning and fall back to the
file/default backend. `none` is for local dev only — no isolation. `smol`
(experimental) runs agent work in a smolvm micro-VM; it needs a host
hypervisor + the `smolvm` CLI, and its `--allow-host` egress is
IP-pinned per host rather than apex+subdomain. `kubernetes` runs each phase as a
bare Pod in a dedicated namespace. See `09-sandbox.md` for both.

The `kubernetes` block is the one config sub-tree resolved lazily rather than at
boot: `sandbox.kubernetes` in YAML is guarded field-by-field into
`config.kubernetes` (present fields only, no defaults), and
`resolveKubernetesConfig()` applies **env override → that block → `K8S_DEFAULTS`**
at each call site.

### Build assets

Where the per-phase build handoff docs (`architect-plan.md`, `status.md`,
`executor-summary.md`, `reviewer-verdict.md`, `guardrails-report.md`, the
`explore-*` docs) live. Config block `buildAssets.location` (file/overlay) or
the env override below.

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_BUILD_ASSETS` | `repo` / `server` | file/default `repo` |
| `BUILD_ASSETS_DIR` | server-mode store root | `$STATE_DIR/build-assets` |

- **`repo`** (default) — the agent writes the docs into `.lastlight/<issueKey>/`
  inside the target repo and publishes them onto the working branch with
  `github_publish` (`include: [".lastlight"]`, one signed commit). PR
  bodies link them via `{{branchUrl}}`/`{{artifactUrl}}` → GitHub blob URLs.
  Byte-for-byte the historical behaviour.
- **`server`** — the docs are externalized to
  `$STATE_DIR/build-assets/<owner>/<repo>/<issueKey>/`, never committed. The
  executor stages the store's docs into the workspace before each phase and
  harvests changed docs back afterwards (`stageArtifactsIn`/`harvestArtifactsOut`
  in `src/engine/agent-executor.ts`). For **pre-cloned** workflows (build, pr-*)
  on a whole-workspace backend (docker/none/smol) the staged dir is the
  **workspace root** — a sibling of the checkout, reached by the agent via
  `{{issueDir}}` = `../.lastlight/<issueKey>` — so neither `git add -A` nor the
  publish's working-tree diff can structurally see it (`buildAssetsRelocated`,
  `hostRepoDirFor`). gondolin mounts only
  cwd, so there (and in repo mode) the dir stays the in-repo `.lastlight/<key>/`
  and is git-excluded as a backstop. Prompts gate their doc publish behind
  `{{#if !externalizeArtifacts}}`, and `{{artifactUrl}}` resolves to a dashboard deep link
  (`/admin/?tab=artifacts&repo=…&key=…&doc=…`). The admin API exposes the store
  read-only at `/admin/api/artifacts[/:owner/:repo/:key[/:doc]]`.

Unknown `LASTLIGHT_BUILD_ASSETS` values log a warning and fall back to the
file/default location.

### State and paths

| Var | Purpose | Default |
|---|---|---|
| `STATE_DIR` | root for all persistent state | `./data` |
| `DB_PATH` | SQLite file (unused when `DATABASE_URL` names a `postgres://` server) | `$STATE_DIR/lastlight.db` |
| `DATABASE_URL` | state DB — a libsql-style URL (`file:…`, `:memory:`) or `postgres://…`; wins over `DB_PATH`; also settable as `database.url` in YAML | unset |
| `DATABASE_DRIVER` | how a `postgres://` URL is carried: `pg` (node-postgres TCP pool) or `neon` (`@neondatabase/serverless` WebSocket pool). Unset auto-detects from the host (`*.neon.tech` → `neon`) | unset |
| `DATABASE_POOL_MAX` | Postgres pool ceiling (`database.poolMax`) | `10` |
| `LASTLIGHT_SESSIONS_DIR` | JSONL session envelopes (dashboard reads here) | `$STATE_DIR/agent-sessions` |
| `BUILD_ASSETS_DIR` | server-mode build-asset store root | `$STATE_DIR/build-assets` |
| `LASTLIGHT_OVERLAY_DIR` | deployment overlay root — `config.yaml` + asset overrides (`workflows/`, `workflows/prompts/`, `skills/`, `agent-context/`) + `secrets/`. Boot fails loudly if it's set but missing or unpopulated. | unset (no overlay) |
| `WEBHOOK_PORT` / `PORT` | webhook listener port | `8644` |

**Which one wins.** The state DB target resolves first-hit-wins:
`DATABASE_URL` → overlay `config.yaml` `database.url` → `config/default.yaml`
`database.url` (ships `null`) → `file:` + `dbPath` (i.e. `DB_PATH` or
`$STATE_DIR/lastlight.db`). `database.url` rides the ordinary config resolver,
so the dashboard's `/config` provenance tree shows where the effective value
came from. A `postgres://` URL selects the **Postgres runtime** — an
external/managed server, pooled, with its own generated migrations (see
[State](/spec/10-state#dialect-posture)). Setting none of these is the
pre-Drizzle behaviour, so existing deployments are unaffected, and SQLite
remains the default.

**Put a `postgres://` URL in `DATABASE_URL`, not in `config.yaml`.** It is a
valid YAML slot, which is exactly the trap: the overlay is a git repo with a
GitHub remote, so a credentialed URL there is a password pushed to a remote,
and the dashboard's masking happens at render time and cannot un-commit
anything. `lastlight server setup` writes this one slot to
`instance/secrets/.env` for that reason. Credentials in a `postgres://` value
are masked by VALUE wherever they appear in the `/config` provenance tree and
in the boot log — never by key, since `url` must keep matching `publicUrl` and
`avatarUrl`, and a `file:` URL should stay legible.

There is **no** `WORKFLOW_DIR` env var and no `workflowDir` config field: assets
resolve layer-wise (built-in root ⊕ overlay root, plus a per-run repo layer), not
from a single directory. `builtInRoot` is derived from the location of
`config/default.yaml`.

### Approval gates

| Var | Format |
|---|---|
| `APPROVAL_GATES` | comma-separated gate names, e.g. `post_architect,post_triage` |

Parsed into `Record<string, boolean>` (`parseApprovalGates`, `src/config/config.ts`) —
and, unlike every other key, it *replaces* the file `approval` map wholesale
rather than merging over it. A phase
declaring `approval_gate: post_architect` only pauses if `post_architect`
appears in the map. Missing names are *implicitly disabled* — there is no
"enable all" mode.

### Dashboard

| Var | Purpose | Default |
|---|---|---|
| `ADMIN_PASSWORD` | enable password login | empty |
| `ADMIN_SECRET` | HMAC secret for session cookies | `lastlight-dev-secret` |
| `PUBLIC_URL` | absolute base URL for outbound links | derived from `DOMAIN` or unset |
| `DOMAIN` | TLS domain, used to derive `PUBLIC_URL` as `https://<DOMAIN>` | unset |

`ADMIN_SECRET`'s default is unsafe in production — it must be replaced.

Auth (`authIsEnabled`, `src/admin/auth.ts`) is required when **any** login
method is configured — `ADMIN_PASSWORD` **or** a working OAuth provider (Slack
needs client id + secret; GitHub also needs `GITHUB_ALLOWED_ORG`). The same
gate protects the dashboard and the `/api/*` trigger routes. The dashboard is
only fully open when *no* method is set. `GET /auth-required` returns
`{ required, password, slackOAuth, githubOAuth }` so the login screen shows the
right methods (no dead password box for an OAuth-only gate); `POST /login`
refuses password auth — never minting an open token — whenever auth is on but
no password is set.

**The "my repos" filter** (`teamVisibility`, issue #169) offers each
GitHub-authenticated admin a header toggle that narrows every list to the
managed repos their GitHub org teams own, **plus the ones their own account
owns**. The ownership half closes a gap that was pure artefact rather than the
deliberate approximation the rest of the feature makes: teams are an *org*
concept, so a repo under a personal account can never be granted by one, and a
strictly team-derived answer hid every personal repo an instance managed — on a
mostly-personal deployment, most of the dashboard. The test is
`owner === login`; the tempting restatement "the owner is not an organization"
selects the same set on a single-owner instance and is a disclosure bug on any
other, putting everybody else's personal repos into your filter. It costs no
extra request — the owner is already in the managed string — and it is derived
per request rather than persisted, so it re-intersects with the live managed
list and has no cache of its own to go stale. An **incomplete** team answer
(`truncated` / `error`) is deliberately *not* rescued by it: "your own repos
plus an unknown fraction of your teams'" would confidently hide the org repos
the failed half would have contributed. `GET /admin/api/me/repos` returns
`{ repos, synced, reason }`, which the SPA passes back as the `?repos=` query
filter on the run lists (so paging and totals stay honest) and applies locally
to the session list.

**Opt-in, off by default, remembered per browser.** That inversion is
load-bearing. Team grants describe **involvement, not access** — an org owner
reaches every repo without a team grant anywhere — so applied as a default this
hides people's own work. Measured against the live `nearform` install: of 8
managed repos, one maintainer's single team covered 4, and the 4 it hid included
`nearform/lastlight`, on which they hold `admin` via org ownership. Applied as a
filter somebody switched on, the same narrowing is exactly what they asked for,
and one click undoes it. So the toggle is never pre-applied, and the feature is
never described to a user as visibility or access.

**The control renders whenever `enabled` is on — not only once grants
resolve.** It used to appear only when there were real grants to narrow to,
which hid it in precisely the state where somebody needs it: they have just
created a team or granted it repos, and the answer they must invalidate is
cached for `ttlMinutes`, behind a stale-while-revalidate read that serves the
old value once more after expiry. `POST /me/repos/resync` and the SPA hook's
`resync()` both existed; nothing in the UI ever called them, so the only route
back was waiting out the TTL and reloading twice. The unresolved states now
render explanatory and retryable, naming the `reason` (no teams, no GitHub
identity, over budget, GitHub error) with the re-sync on the control itself.
`teamVisibility.enabled: false` is the one state it is still not drawn in —
and the one a re-sync provably cannot change, since `resync()` short-circuits
on that flag before it reaches GitHub. The mapping from each `reason` to the
rendered state is pinned in `tests/admin/dashboard-repo-scope.test.ts` against
the server's own `VisibilityReason` union, so adding a reason without deciding
how the UI answers it fails the build.

The `enabled` flag is the **operator** switch, and needs a setup step: grant the
GitHub App the organization **`Members: read`** permission, subscribe it to the
`team` / `membership` / `organization` webhook events, and re-consent the App on
each installation. Without that the resolver fails open and nothing is filtered
for anyone — the control still appears (the operator asked for it) and says why
it has nothing to offer, which is how an operator finds out the setup step is
outstanding instead of seeing a feature that silently did nothing. `repos: null` is the fail-open sentinel meaning
"no filter" — returned for a password/Slack login, an `allowedOrg: "*"`
deployment, an over-budget resolution and any GitHub error. This is **not**
access control: the server keeps returning global data on `/workflow-runs`,
`/sessions` and `/stats`.

### Web search (opt-in per phase)

| Var | Provider |
|---|---|
| `TAVILY_API_KEY` | Tavily |
| `EXA_API_KEY` | Exa |
| `BRAVE_SEARCH_API_KEY` | Brave |

These are forwarded into the sandbox env *only when* the dispatching
phase declared `web_search: true` in its YAML
(`executeAgent` in `src/engine/agent-executor.ts`, gated on `config.webSearch`).
Auto-detection precedence:
Tavily > Exa > Brave. Provider API keys (Anthropic / OpenAI /
OpenRouter) are forwarded unconditionally.

### Telemetry (OpenTelemetry)

Off by default; `LASTLIGHT_OTEL_ENABLED=true` is the master switch (a bare
`OTEL_EXPORTER_OTLP_ENDPOINT` does **not** enable it). Standard `OTEL_*` vars
configure the exporter endpoint/headers/resources. A run exports a nested
OpenInference span tree — `lastlight.workflow.run` (CHAIN) → `.workflow.phase`
(CHAIN) → `.agent.execute` (AGENT) → per-turn (LLM) → per-tool (TOOL) — with
per-turn/per-run tokens + cost, so an OpenInference backend (e.g. Arize Phoenix)
renders a proper agent tree. Constants: `src/telemetry/openinference.ts`; tree:
`AgentSpanTree` (`src/telemetry/pi-events.ts`).

A **feedback signal** (issue #255) exports one more span,
`lastlight.feedback.signal` (OpenInference `EVALUATOR`), carrying
`feedback.{source,emoji,score,sentiment,anchor.kind,anchor.url}` plus
`langfuse.score.user_feedback` + `.data_type` for Langfuse's vocabulary. The
reactor's identity is content, so it rides behind
`LASTLIGHT_OTEL_INCLUDE_CONTENT` like every other content value.

The span is **parented on the original run's span**, reconstructed from
`workflow_runs.trace_id` / `span_id` as a remote context. That is the whole
point: a 👍 arrives minutes or days after the run's spans have closed, so
starting a span *now* would produce a disconnected second trace that no backend
can relate to the work. Instead the score lands on the trace it grades. With no
recorded trace (telemetry was off during the run) it exports as its own root
span — losing the association beats losing the signal.

Caveat worth stating plainly: **Langfuse does not yet map `langfuse.score.*` to
first-class Scores on its OTLP ingest path** ([langfuse discussion
#14652](https://github.com/orgs/langfuse/discussions/14652)). Today the
attributes ride along on a span that is correctly placed on the trace; they
become a real Score the day that ships, with no change here. Phoenix reads the
`EVALUATOR` span kind today.

Metrics: `lastlight.feedback.signals` (counter) + `lastlight.feedback.score`
(histogram — a distribution, not a sum, so one 🎉 cannot cancel one 👎 and
report silence).

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_OTEL_ENABLED` | master switch for all telemetry export | `false` |
| `LASTLIGHT_OTEL_SERVICE_NAME` | OTEL `service.name` (also `OTEL_SERVICE_NAME`) | `lastlight` |
| `LASTLIGHT_OTEL_INCLUDE_CONTENT` | attach (truncated) prompt/message/tool content to spans | `false` |
| `LASTLIGHT_OTEL_FORWARD_TO_SANDBOX` | emit telemetry from inside the sandbox too | `true` |
| `LASTLIGHT_OTEL_STRICT` | throw on OTEL init/export-setup failure instead of warning | `false` |
| `LASTLIGHT_OTEL_METRICS_ENABLED` | export OTLP metrics; `false` = traces only, for a backend that rejects metrics (e.g. Phoenix) (overlay `otel.metrics`) | `true` |
| `LASTLIGHT_OTEL_COLLECTOR_HOSTS` | extra collector hosts added to the gondolin egress allowlist | unset |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | OTLP/HTTP encoding: `http/protobuf` (default) or `http/json` | `http/protobuf` |

### Misc

| Var | Purpose | Default |
|---|---|---|
| `BOOTSTRAP_LABEL` | label for issues that set up missing guardrails | `lastlight:bootstrap` |
| `LASTLIGHT_HOLD_LABEL` | the HOLD label a maintainer applies to stop Last Light acting on an issue or PR (overlay `hold.label`) | `lastlight-ignore` |
| `EXPLORE_DEFAULT_REPO` | `owner/name` — destination for Slack-initiated explore publish | unset (must be set or run fails at publish phase) |
| `REVIEW_POSTS_CHECK` | post a Check Run on PR head SHA after pr-review | `false` |
| `MAX_CONCURRENT_WORKFLOWS` | global cap on sandboxed workflow runs executing at once; excess triggers are persisted as `queued` and admitted FIFO as slots free (overlay `concurrency.maxWorkflows`) | `4` |
| `MAX_QUEUE_WAIT_MS` | how long a `queued` run may wait before it's dropped (cancelled with a "waited too long" notice) by the admission sweeper (overlay `concurrency.maxQueueWaitMs`) | `3600000` (1 hr) |
| `LASTLIGHT_FEEDBACK_ENABLED` | master switch for reaction-derived eval signals (overlay `feedback.enabled`) | `true` |
| `LASTLIGHT_FEEDBACK_GITHUB` | opt into the GitHub reaction poller — GitHub sends no webhook for reactions, so this half must be polled (overlay `feedback.github`) | `false` |
| `LASTLIGHT_FEEDBACK_OTEL` | export each signal as a span on the run's own trace (overlay `feedback.otel`) | `true` |
| `LASTLIGHT_FEEDBACK_WINDOW_DAYS` | how long a GitHub anchor stays in the poll rotation (overlay `feedback.windowDays`) | `14` |
| `LASTLIGHT_GIT_CREDENTIALS` | **inert** — legacy credentials-file path; git auth now flows via a github.com-scoped `http.extraheader` (`GIT_CONFIG_*` env), not a credentials file | unset |
| `LASTLIGHT_WRITE_GLOBAL_GIT` | when `"1"`, also write the bot identity + `http.extraheader` auth to the harness user's global `~/.gitconfig` (non-sandboxed direct-exec path only) | `0` |
| `LASTLIGHT_GIT_SHA` | core git SHA baked into the image (Dockerfile `ARG`); surfaced by `GET /admin/api/server/info` for the dashboard drift banner | empty → "unknown" |
| `LASTLIGHT_BUILD_DATE` | build date baked alongside `LASTLIGHT_GIT_SHA` | empty |
| `LASTLIGHT_CORE_VERSION` | override the overlay's `deploy.version` core-version pin (git tag/ref); `server update\|setup` checks core out at it and the drift banner compares against it | overlay `deploy.version`; `main`/`latest`/unset = track main |

### CLI client

The published `lastlight` thin client (`packages/cli/src/cli.ts`) reads its own env:

| Var | Purpose | Default |
|---|---|---|
| `LASTLIGHT_URL` | server URL | `http://localhost:8644` |
| `LASTLIGHT_TOKEN` | auth token (checked against `ADMIN_PASSWORD`) | empty |
| `LASTLIGHT_HOME` | working dir for the host-local `lastlight server` lifecycle commands (checkout + `instance/` overlay + override symlink) | `~/lastlight` (or saved `serverHome`) |

The CLI is also the host control plane: `lastlight server
setup\|start\|stop\|restart\|update\|status` shell out to `git` + `docker
compose` in `LASTLIGHT_HOME` (resolved `--home` → env → `serverHome` in
`~/.lastlight/config.json` → `~/lastlight`). `server update` reproduces the
production `deploy.sh` flow (pull overlay → converge core → **pull prebuilt
images** → `up -d --remove-orphans` → restart egress sidecars → health-check).
By default it *pulls* the four images from GHCR
(`ghcr.io/nearform/lastlight-{agent,sandbox-base,sandbox,sandbox-qa}`, published
on GitHub Release by the `images` job of `.github/workflows/publish.yml`; the
same job also publishes a fifth image, `lastlight-agent-qemu`, for the
gondolin/k8s path, which the compose stack doesn't use and `server update`
doesn't pull) at the tag
`resolveImageTag` returns — the overlay `deploy.version` pin, else `:latest` —
and re-tags each to its local name so compose + the harness (fixed names in
`src/sandbox/images.ts`) find them unchanged; `--local` builds from source
instead (the old `docker compose build` waves). After a healthy `up` it then
**prunes superseded images** — deleting the old `ghcr.io/nearform/lastlight-*`
version tags beyond the newest `KEEP_IMAGE_VERSIONS` (2) per repo plus the
just-deployed tag, then `docker image prune -f` for the dangling leftovers of
repeated `:latest` re-pulls (each version is ~12 GB across the four repos, so
without this a host fills up). Best-effort and skippable with `--no-prune`.
These run on the server, unlike the rest of the CLI which targets a remote
instance over HTTP.

**Core-version pin.** The overlay drives *which core version* an instance runs
via `deploy.version` in its `config.yaml` (or the `LASTLIGHT_CORE_VERSION` env
override) — read by `readCorePin()` (`src/config/core-pin.ts`). `server update`
pulls the overlay first, then, if a pin is set, `git fetch --tags` + `git
checkout <tag>` (detached HEAD) instead of `git checkout main` + `pull --ff-only
origin main`; `server setup` applies the same pin before its first build. Unset,
or the sentinels `main`/`latest`, mean track `main`. When pinned, the drift
surfaces (`server status`, the dashboard `GET /server/info` banner) compare the
running image's SHA against the pinned tag rather than `main` HEAD — so "behind"
means "pin bumped, redeploy needed", and an already-pinned instance shows a
quiet "pinned vX.Y.Z" label instead of an update nudge. This makes bumping
`deploy.version` in the overlay repo the declarative trigger for a CI/CD deploy.

`lastlight fork <workflow>` (host-local, `packages/cli/src/fork-cli.ts`) copies a built-in
workflow YAML plus every prompt and skill its phases reference into the
`instance/` overlay so they can be edited per-deployment (the overlay wins by
logical name at startup). `lastlight fork agent-context [file]` does the same
for the persona files (`soul.md` / `rules.md` / `security.md`). The forked
assets are then surfaced as overrides: `lastlight server status` prints an
**Overrides** section (each asset tagged *shadows default* or *added*) and the
dashboard's Config tab gains an **Overrides** pane reading
`GET /admin/api/overrides` — both backed by the shared
`enumerateOverlayAssets` enumerator (`packages/shared/src/overlay-assets.ts`), which
also backs the per-repo asset list on `GET /admin/api/repos/:owner/:repo/config`.

## YAML-only config keys

These have no env var — they're set in `config/default.yaml` or the overlay's
`config.yaml` (a repo may set only the subset marked below, within
`repoConfig.allowKeys`).

| Key | Type / default | Meaning | Repo-settable |
|---|---|---|---|
| `managedRepos` | `string[]`, `[]` | The repos Last Light acts on. **Empty is meaningful**: the effective list is then sourced from the GitHub App *installation* (fetched at boot, kept live by `installation` / `installation_repositories` webhooks). A non-empty list wins and restricts to exactly those repos. Enforced at ingress **and** at the `dispatchWorkflow` choke point. Surfaced by `GET /admin/api/managed-repos` (configured / installation / effective / source). | no |
| `botName` | `string`, `last-light` | The GitHub App slug, no `[bot]` suffix. Single source of truth for the bot's identity — derives the `@mention` handle the router triggers on, `botLogin` (`<botName>[bot]`, the self-comment/self-review filter), and the git commit author. Env: `GITHUB_APP_BOT_NAME`. | no |
| `routes` | `{ github, slack }` maps | Deterministic event/intent → workflow name routing. Deep-merges over the defaults, so an overlay adds or repoints one key without restating the table. See `05-router.md`. | no |
| `disabled.workflows` | `string[]`, `[]` | Workflow names dropped at asset-load time. | **yes** (a repo opting *itself* out; refused at dispatch) |
| `disabled.crons` | `string[]`, `[]` | Legacy spelling of `crons.disable`, unioned into it — and additionally drops the cron's definition at load time, so it is the harder kill. | **yes** |
| `disabled.prompts` / `disabled.skills` / `disabled.agentContext` | `string[]`, `[]` | Drop a prompt (by path or basename), a skill, or an agent-context file (exact filename or stem). | no |
| `crons` | `{ enable, disable }`, both `[]` | Cron participation — see the per-repository layer above for the per-layer meaning. | **yes** |
| `approval` | `Record<string, boolean>`, `{}` | Gate name → enabled. `APPROVAL_GATES` replaces this wholesale. | **yes**, add-only |
| `models` / `variants` | maps | Per-task model / reasoning-effort. | **yes** |
| `sandbox.backend` / `sandbox.maxTurns` / `sandbox.kubernetes` | see Sandbox above | Backend selection + the k8s block. | no |
| `buildAssets.location` | `repo` \| `server` | Where build handoff docs live. | no |
| `concurrency.maxWorkflows` / `.maxQueueWaitMs` | `4` / `3600000` | Global admission cap. | no |
| `cleanup.sandbox.{enabled,reapOnCompletion,sweepSchedule,retentionHours,maxDirs}` | `true` / `true` / `"0 * * * *"` / `12` / `40` | Sandbox-workspace reaping: reap an ephemeral run's workspace on terminal success, plus an hourly TTL + LRU backstop sweep that bounds the reusable per-PR cache. See `09-sandbox.md`. | no |
| `feedback.{enabled,github,pollSchedule,windowDays,maxAnchorsPerTick,retentionDays,otel}` | `true` / `false` / `"*/30 * * * *"` / `14` / `500` / `90` / `true` | Reaction-derived eval signals (issue #255): a 👍/👎 on something the bot wrote, scored against the run that wrote it. **Two switches because the two surfaces cost different things.** Slack is event-driven and free — `reaction_added` is a real event, so `enabled` turns on a webhook handler and nothing else. GitHub delivers **no webhook for reactions at all**, so `github` opts into a poller and ships **off**. What bounds that poller is the data, not the schedule: it polls individual bot comments ("anchors"), never issues; each retires after `windowDays`; and `maxAnchorsPerTick / 100` is exactly how many batched GraphQL requests a tick may issue, at one rate-limit point each. Env: `LASTLIGHT_FEEDBACK_ENABLED` / `_GITHUB` / `_OTEL` / `_WINDOW_DAYS`. | no — it governs API spend and telemetry export, neither of which is a target repo's business |
| `teamVisibility.{enabled,ttlMinutes,maxTeamsPerUser,maxPagesPerTeam,maxRequestsPerResolve}` | `false` / `60` / `50` / `20` / `60` | GitHub team-based per-repo visibility in the admin dashboard (issue #169): a GitHub-authenticated admin sees only the managed repos their org teams can reach. **UI declutter, not access control** — every list endpoint still returns global data and the filtering happens in the browser, which is what licenses the budgets: every one of them, when blown, shows *more* than necessary rather than a partial list. **Ships off**, because it needs the App's organization `Members: read` permission and therefore a re-consent on each installation. Nothing is crawled up front: a person's teams are resolved on their first dashboard request via one `Organization.teams(userLogins:)` GraphQL query per org plus a page or two per team, then cached for `ttlMinutes` — so the cost tracks the *user's* team count, not the org's repo count. `team` / `membership` / `organization` webhooks invalidate the cache; `POST /admin/api/me/repos/resync` is the manual fallback. No env vars. | no — it governs API spend and who sees what |
| `repoConfig.{enabled,allowKeys,allowedModels,allowAssets}` | see the per-repository layer above | The operator's bounds on the repo layer. | **never** — a repo can't widen its own bounds |
| `deploy.version` | `string \| null`, `null` | Core-version pin (git tag/ref). Deployment config, not runtime behaviour. Env: `LASTLIGHT_CORE_VERSION`. | no |
| `bootstrap.label` / `explore.defaultRepo` | see Misc | Env: `BOOTSTRAP_LABEL` / `EXPLORE_DEFAULT_REPO`. | no |
| `hold.label` | `string`, `lastlight-ignore` | The **HOLD** label. A maintainer applies it to any issue or pull request and Last Light stops acting on that subject entirely — no triage, no review, no fix, no merge, and no comment. It is checked at the dispatch gate above every other guard except a failed PR read, and in the router as a subject-level hard ignore so non-PR-scoped workflows honour it too; it beats an explicit `@bot …` request, which earns exactly one reply naming the label. Removing it resumes the bot with no record to clear — that liveness is why it is a label rather than a stored verdict. Distinct from `requires-human`, which the bot *writes* as a notification and nothing reads. See [Router](/spec/05-router#the-hold--the-first-gate). Renaming it changes what the code gates on; the packaged prompts create the **default** name in their `github_ensure_labels` pass, so a rename also wants a forked prompt (or the label created by hand). Env: `LASTLIGHT_HOLD_LABEL`. | no — a repo that could rename it could rename it to something nobody applies |
| `review.{postsCheck,trigger,requestLabel,skipDraft,generatedPaths}` | `false` / `after-checks` / `null` / `true` | When a `pr-review` run is triggered, and whether it posts the `last-light/review` check. `after-checks` means "once the head SHA's checks **settle**, either colour" — so the review can read and cite the CI result, and a push-storm collapses to one review per settled SHA. There is no settled-*and-passing* sub-mode: a PR whose CI never goes green would then never be reviewed at all. Enforced by `resolveReviewTrigger` (`src/engine/pr-decisions.ts`) at the [dispatch gate](/spec/05-router#reviewtrigger--one-resolver-every-route) — **one** implementation, on every route, with `src/cron/review-discovery.ts` reduced to a candidate finder. `on-request` is served by `requestLabel`, an `@bot review` comment, and the Re-run button on the check; `review_requested` is opportunistic only, since GitHub App bot users are not selectable in the reviewer picker. `generatedPaths` lists paths whose contents are DERIVED rather than authored — lock files, minified bundles, generator output. When **every** path changed since the review we posted matches one, the re-review is skipped: per-head dedup was the only suppression gate, so a lock-file re-derivation was a new head SHA and therefore a second formal review (issue #271). It never suppresses a first review, an explicit request, or a push that also touched a hand-written file; `[]` turns it off. Patterns: `*` stops at a `/`, `**` crosses one, and a pattern with no `/` matches a basename anywhere in the tree. Env: `REVIEW_POSTS_CHECK` (`postsCheck` only). | **yes** — `postsCheck`/`skipDraft` add-only, `trigger` clamped to the lower automation tier, `generatedPaths` superset-only, `requestLabel` free |
| `review.analysis.{enabled,maxSpecObligations,maxObligations,obligationContract,mint,surveyPasses,surveyConcurrency,probes,probeLifecycleScripts,probeTypecheck,probeCoverage,prepareTimeoutSeconds,coverageTimeoutSeconds,probeRounds,maxInlineComments,thresholds,internalFloor,maxBodyComments}` | `false` / `40` / `48` / `minimal` / `all-in-diff,registrations` / `6` / `6` / `false` ×4 / `300` / `900` / `2` / `10` / six per-family bars / `0.15` / `5` (`null` = unlimited) | The **review evidence pipeline** (`docs/plans/deterministic-pr-levers.md`). `enabled: false` reproduces today's two-phase review: every analysis phase skips, and the `review` phase's two-mode prompt (`prompts/review.md`) collapses to the classic skill nudge plus a curated Context section. (Until that prompt landed the phase had no template at all — its prompt was the whole render context serialised as `key: value` lines, and the off-path guarantee was byte-for-byte on that dump; the guarantee is now the pinned two-mode contract in `golden-pr-review.test.ts`.) Every variable the block governs stays *absent* from the template context rather than present-and-empty, and that is still a locked decision rather than a convention: `skip_if` coercion and the prompt's `{{#if analysisEnabled}}` both read absence as off, and any remaining skills-only phase renders the whole-context dump, where a key present-but-blank is itself a prompt change. Anything that is not literally `true` is off. What `true` adds today is the **`spec` axis** (issue #271's fix 6): `{{prBody}}` and `{{linkedIssues}}` (the PR's body and the issues it closes, via `closingIssuesReferences` — neither had ever reached a prompt), plus `{{specObligations}}`, one obligation per acceptance criterion found in the issue or PR body. Each obligation names **both ends** of the mechanism — the criterion quoted verbatim, and the PR's changed files as candidates with `found: false` — because a one-ended seed measures *worse* than no seed at all (IRIS ablation: −3). Turning it on also costs two extra GitHub reads per `pr-review` dispatch (`resolveSpecContext`, `src/engine/pr-state.ts`); both are best-effort and a failure degrades the block rather than the run. It further un-gates the **split verdict**: `findings.json` may carry `verdict: { spec, standards }` and a `fail` on either axis stops the review being an `APPROVE` (fix 7). With `enabled: true` the workflow additionally runs a deterministic `facts` phase — which also **stages the diff once** (`lastlight-facts all --stage-diff`), writing `.lastlight/pr-review/diff/index.md` plus one unified patch per changed file, so the five survey branches read a patch instead of re-deriving the range: measured, they made ~93 bash calls per case with ~30 of them re-deriving the one fixed merge-base range the envelope already held, and every re-derivation is another chance to spell it two-dot (6,125 changed files against 3, on the worst corpus case). Staging failure is `degraded` at most — the envelope records it and the index says so in words, because *"we could not stage"* and *"the PR changed nothing"* must never be one silence — then a `seed` phase that turns its envelope into obligations naming both ends of a mechanism, and a **`survey` fan-out phase with five branches** — `contract`, `enforcement`, `security`, `state` and `spec`, one per obligation family, each appending only to its own `hypotheses/<family>.jsonl`, so consensus collapse is impossible by construction rather than by instruction. The seeder still emits all **six families** — `tests` keeps its block and its `measured: false` row, so the eval instrument reports it `notMeasured` rather than "did not convert" — but no branch runs it: no seeder function exists for the family and its coverage source needs the probes-gated `prepare`, so its branch only ever paid a sixth of the fan-out to write NOT MEASURED (0 artifacts in every measured run); reinstating it is one branch entry plus a seeder. Two things make a branch's seed actually arrive and actually get used. Its family's obligations block reaches it as a **`context_file`** — the harness reads the file and appends it to the branch's prompt rather than naming a path the model must resolve, because 27 of 133 reads across three stored runs resolved against the workspace root instead of the checkout and silently turned a seeded pass into an unseeded one (see [Workflow engine §`fanout`](/spec/06-workflow-engine)). And its exit gate is `lastlight-facts discharge --family <f>` rather than `test -s`, which **one line of any content passes**: the gate requires every obligation the family owns to carry a `QUOTE` / `ABSENT` / `PARTIAL` / `PROBE` discharge in that file. That contract was in the seeder's block from the start and nothing enforced it — measured over both preserved runs of 2026-08-22, across all eight cases and every family, *not one* obligation ever carried a discharge code (0 of 31, 0 of 34, 0 of 40), because the prescribed row shape printed twenty lines below the contract had no field to record one in. With no readable `obligations.json` the gate degrades to the `test -s` floor it replaces rather than becoming a condition no agent can satisfy, and the `spec` family keeps `test -s` because its obligations are built harness-side and never reach that document. The surveys were originally six chained phases and were 49% of the review's wall clock; as one `type: fanout` node the branches run concurrently against the single provisioned workspace, so the block costs the slowest branch rather than the sum. `surveyConcurrency` is the declared width and is **clamped by the active sandbox backend** — six on `none`/`docker`, but **one** on `gondolin` (the production default), `smol` and `kubernetes`, where each branch would be a micro-VM inside the harness process. A clamp to one runs the branches as a chain, which is byte-identical to the phases they replaced. The legacy `review` phase still **runs** in both modes — `post-review` depends on it with `all_success` (a failed review must not post) and a skipped node is not `succeeded` — but with the pipeline on its brief collapses to one fast **independent** pass: PR-level judgment only, no per-hunk re-derivation, and no reading `hypotheses/` or `obligations/` (adjudicate is the fresh-context reader, and a finding copied from a hypothesis is one it can no longer cross-check), because a full second review beside six surveys was measured pure waste — 137s / $0.30 per case for an `APPROVE` with zero findings while 41 hypotheses sat unread. It still writes `findings.json`, which adjudicate seeds from and `post-review` fails loudly without. It also adds the two phases that make any of that reach a human: **`adjudicate`**, the first phase that READS the hypothesis files, which merges across families, ranks, tiers into inline/body/internal and may delete a claim only against a probe transcript. Its prompt carries three calibration rules: a **verification report** — a finding asserting correct/unchanged/satisfied behaviour, or merely describing what the diff does — is *always* tier `internal`, whatever its confidence; a **speculative hazard** — a defect that exists only after a hypothetical future change (*"nothing prevents a future developer from…"*) — is *always* `internal` too, because it asserts no misbehaviour of the code in this PR (measured: twelve such findings reached one clean PR across two repeats, every one a false positive); and **confidence prices the defect claim, never the observation** — 0.90+ needs a reproduced transcript or the defect end-to-end in quoted code, because measured runs sat uniformly at 0.75+ and silently disabled every downstream threshold. The phase also has its **own model key**, `models.review-adjudicate` — ranking an already-generated set is a different task from survey discovery, so an overlay can move it without moving `models.review` — behind an `{{#if}}` pair that falls through to `models.review` when unset (a bare unset key would render *empty* and land on the default model instead); and **`reconcile`**, its deterministic model-free floor, which exists because reaching a `generic_loop`'s `max_iterations` without the exit condition is *not* a phase failure in this engine — so `lastlight-facts findings --repair` writes every unaccounted-for hypothesis at `internal` tier and promotes any deletion whose transcript is missing back to `internal`. `adjudicate` is a **sibling** of `post-review` rather than a link in its chain, so that however it fails the review is still posted: `trigger_rule` is per node, so including it in `post-review`'s dependencies would have forced that node to `all_done` and lost the invariant that a failed review must not post. **Obligations are bounded PER FAMILY, and `maxObligations` is only the total backstop over that.** The seeder caps each family at its own ceiling — `contract` 12 · `enforcement` 12 · `state` 8 · `security` 8 · `tests` 8 (`FAMILY_CAPS`, `packages/code-facts/src/seed.ts`) — and each family keeps its own top obligations in the existing global-rank order. Two reasons, and both are about what the number buys. **The cost is per branch, not per document**: each family's obligations feed exactly one survey branch, so a pooled cap bounds the sum while the thing that actually costs money and context is the fattest single branch, which a ceiling bounds directly. And **cross-family ranking prices incommensurable mechanism classes against each other** — a `contract` rank of 91 and a `security` rank of 41 are two points on a class ordering, not on one scale, so subtracting one family's questions from another's on the strength of them is arithmetic nobody has evidence for. Measured across the eight gate cases: `contract` minted **89** obligations while `security` minted **3**, and 35 obligations were dropped carrying the words *"These are NOT checked"* — a family's questions going unasked because a *different* family had a lot to say. Reserving floors inside the pool (the mechanism this replaced) did not fix that: the reserve still competed for one budget, so it displaced `contract` slots on exactly the heavy-mint cases and is a suspect in the recall regression measured after it landed. Ceilings remove the competition rather than arbitrating it — a family minting 3 against a ceiling of 8 keeps all 3 whether its neighbour minted 4 or 400, and no family can lose a slot to another's excess. `maxObligations` is then applied **after** the ceilings, dropping the lowest-ranked across families if the post-cap total still exceeds it; it defaults to `48`, which **is** the ceilings' sum, so on a shipped configuration it cannot bind and it exists so that raising one ceiling is a bounded act rather than an unbounded one. It is **threaded**: `renderContext` projects it and the `seed` phase passes `--max-obligations` (shell-defaulted to the seeder's own `48`) — until it was, the operator's value never reached the sandbox CLI at all, and only the accident of the two defaults being equal kept the dead key inert rather than wrong. Every truncation is still counted in `dropped[]`, one reason per family naming that family's ceiling and one more for the backstop — so a reader comparing two families' counts can tell *"little to say"* from *"truncated at its own ceiling"* — and the coverage set is still sealed before any model call. `surveyPasses` is **recorded, not consumed**: the fan-out's declared branch list is the authority (five branches), nothing reads the key to pick or drop branches, and it stays on config so the value an operator believed they set is on the record. `maxSpecObligations` bounds the `spec` family alone, and it is a **safety bound rather than a routine clamp**: it shipped at `6` and was inert while the axis produced nothing, but the moment the axis started working it became the binding constraint on five of six linked cases — discarding 5 of 11 extracted criteria, which are the acceptance-criteria checklists a human wrote on the issue. Capping *generation* also inverts locked decision 2: the pipeline deliberately over-generates and narrows at the probe oracle and the attention boundary, so truncating obligations truncates **discovery**, which is the measured ceiling. It is now `40` and should never bind on a real PR; if it does, the rendered block says how many it dropped. **`obligationContract` selects which obligation *block*** the `seed` phase renders into `.lastlight/pr-review/obligations/<family>.md` and hands to the survey branches — threaded to the five facts-derived families as `lastlight-facts seed --contract` (the phase's shell defaults an empty render to `minimal`), and read in-process by the harness-built `spec` family, so all six axes move together. **`minimal` is the shipped default, and it was measured in rather than assumed.** `full` is the block as it has stood since 2026-08-23, when it gained the three lines that make a discharge code *recordable* — a pointer to the row's own `discharge` field and to an un-truncated id checklist — plus a `failureScenario` requirement and one worked exemplar. Discharge compliance went **0/33 → 33/33**. Recall went the other way: on the comparator case the union of matched gold fell from **4-of-5 to 0-of-5**, three repeats running, and under `full` half to two thirds of every hypothesis arrives as a *clean quote* — `discharge: QUOTE`, `failureScenario: null`, *"I found the line and it is fine"* — verification reports that reached real pull requests as posted findings. Under `minimal` the same recall union posts with **37–71% better signal-to-noise and half the run-to-run variance**, which is why it ships. Two candidate causes for the regression, and one run cannot separate them: the obligations may ask the **wrong question**, and making a wrong question mandatory turns hunting into checklist-clearing; **or** reliable seeding itself suppresses discovery, since the same change also stopped ~24% of survey branches losing their seed entirely. `minimal` began as the **control** that separates them — it renders the pre-2026-08-23 block, so delivery is held constant and only the question changes — and the control arm won. `full` remains available as the **opt-in telemetry arm**: it buys the discharge-code telemetry and the clean-discharge demotion it enables at the posting boundary (below), at the cost of the verification-report volume above. `minimal` is **not "no discharge contract"**: the four codes and *"Reading a file is not a discharge"* both predate the regression, and what that day's commit added was exactly the three lines above. The minimal block therefore asks for a discharge and gives the survey nowhere to record one, which is why compliance measured `0/31`, `0/34` and `0/40` under it — reproducing that block byte-for-byte is what kept the comparison honest, and it is the block production now runs. The setting is **stamped into `obligations.json`** rather than passed only as a render argument, so the block a survey was handed, the contract `checkDischarge` grades it against, and the artifact read back weeks later cannot disagree. That stamp is also how the gate knows to **degrade to its existing `test -s` floor under `minimal`** — the same mechanism it already falls back to on an unreadable `obligations.json`, one mechanism with two triggers rather than a second code path. Grading a field nobody was told to write would put four of the five branches at `condition_not_met` on every run of the shipped default, and that is a pipeline-failure signature every result would then have to be read around. Nor is the mis-grading hypothetical: of 447 preserved minimal-era hypothesis rows, **74 carry a `discharge`/`status` string at all and only 43 of those are one of the four codes** — the other 31 invented a fifth (`N/A` ×11, `enforced` ×6, `needs_investigation` ×4, and a tail besides). `N/A` being the commonest invention is why the spec renderer already carries a *"THERE IS NO FIFTH CODE"* paragraph. **`mint` widens the seeder, and both rules are ON by default** — the measured shipped shape (8-case confirm: internal paired +10/−1, p=0.006; external validation +7/−0, p=0.008; `""` restores the pre-D2 baseline set). Every original minting rule requires references *outside* the diff, so a defect wholly inside a new hunk was invisible to all four; `mint` is a comma-list naming the two D2 rules that close that gap — `all-in-diff` (a `contract`-family obligation for a changed runtime symbol whose every reference is also in the diff: *"quote the line a caller cannot see and would be surprised by"*) and `registrations` (a `security`-family obligation ordering the route/hook registrations a symbol makes, from the tier-1-only `registrations` fact). It reaches the sandbox as `lastlight-facts seed --mint <spec>`, appended only when non-empty, and the CLI **refuses any unknown token with exit 2** — a typo'd experiment arm must be loud rather than silently measuring the baseline. Like `obligationContract`, what was asked is **stamped into `obligations.json`** (`minting: {allInDiff, registrations}`) so the artifact answers "which arm produced this" months later. **`probes` is a second switch under the same block**, and it is separate because it buys something different: a review workspace with a `node_modules` in it. That one fact is what makes a `tsconfig` that `extends` a bare package specifier resolve — without it tsgo excludes the project, the case drops to tier 2 and the `contract` family emits nothing (measured over 50 real PRs: tier-1 cases 21 → 5) — and it is the only route to a coverage artifact, without which the `tests` family is *not measured* rather than clean — the absence that is why that family has no survey branch today. It also hands a later phase an installed tree to analyse. `probeLifecycleScripts` is **off as a security default**: the install runs at a pull request head, so a `postinstall` there is code the PR author wrote executing on the operator's infrastructure, and nothing `probes` exists for needs it. `probeTypecheck` runs the repo's own `tsc --noEmit` for per-line diagnostics — *not* a CI re-run, since `checksState`/`ciSection` are already in the context. `probeCoverage` is the one step in the pipeline that runs a test suite, which is why it is its own switch and why it never guesses a command, only one the repo itself named. The last four keys are the **attention boundary** (WP6b), and they are the only ones that change what a human sees. `maxInlineComments` (10) is a budget, not a filter: everything past it is ranked by severity × confidence and rendered into the review body under *"Additional findings"* — still posted, still visible, never dropped. Ten comes from *"Does AI Code Review Lead to Code Changes?"* (22k+ real review comments), which found concise hunk-level actionable findings substantially likelier to cause a change; the wall that paper warns about is *twenty*, which is a muted bot rather than twice the signal of ten. It is a ceiling rather than a budget that bites — measured inline volume is 1–5 per PR, so it has never bound, and the overflow lands in the body either way, which is why moving it from 8 costs no recall. `thresholds` is a confidence bar **per obligation family**, and per-family rather than global because AutoCommenter (Google Critique) measured a global threshold as catastrophic — at `t = 0.98`, ~80% of below-threshold predictions were still correct — while per-URL thresholds raised recall without hurting precision; an overlay tuning one family merges onto the packaged set rather than replacing it, so the other five keep their bars. The shipped numbers are **initial guesses to be tuned on the train split, not measurements**. `internalFloor` (0.15) is the one tier that costs recall: below it a finding is recorded and not posted at all, which is why the disposition of every finding is written to `.lastlight/pr-review/disposition.json` — *"what did we know and not say?"* has to be answerable, or the tier is a dark drop rather than an attention boundary. **A finding carrying no `confidence` is never affected by either bar**: absence is not zero, and reading it as zero would silently delete every finding today's reviewer writes. The boundary also carries one rule that is **not a confidence rule at all**: a finding whose supporting hypotheses are **all clean discharges** is tiered `internal` *before any confidence check* — recorded, never posted. A clean discharge is a row the survey closed with `QUOTE` **and** a `failureScenario` present and explicitly `null`, i.e. *"I looked, I quote the line, and it is fine"*, so a finding built entirely out of them is an **anti-finding**: it cannot match a gold defect by construction, and wherever it is posted it is pure attention cost. Neither bar can reach it, because it is not an unconfident finding but a confident report of nothing — finding confidence is uniformly ≥ 0.7 (median 0.95–1.00), so `internalFloor` and the per-family `thresholds` (0.30–0.60) rarely bind on their own merits. Measured on one repeat: **30 posted findings became 13**, demoting 17 anti-findings that were all sitting in the review body at `confidence: 1.00`. Two sibling repeats were unchanged, because the adjudicator had already tiered those `internal` itself — which is precisely the run-to-run variance this rule removes *by construction* rather than by luck. **The strictness is load-bearing.** Requiring the key to be present *and* null, rather than merely absent, is what makes the rule a no-op under `obligationContract: minimal`, whose prescribed row shape has no such field; read loosely it would have demoted 28 findings across 4 of 16 minimal-era instances on the strength of a field nobody had asked for. `maxBodyComments` (`5`) is the body-side sibling of `maxInlineComments`, and it is the one budget that **does** filter: it caps the FINAL body list — applied after the inline overflow has landed there, so inline excess competes for body slots like everything else — ranked by the same severity × confidence rank, and the excess is tiered `internal` with the machine reason `body-budget` rather than rendered. `5` ships as a recall-preserving compromise, and the number it replaced is the reason it is not a measured optimum. `0` *was* measured rather than assumed: under the production Sonnet-adjudicator shape, no-overflow keeps 29/36 matched gold and lifts precision 0.263 → 0.492 / F1 0.362 → 0.479 on the Martian external set. But the same sweep showed that win is **adjudicator-shape-conditional** — under Haiku-everywhere the body tier carries most of the matched gold and cap 0 costs posted recall 0.42 → 0.12, while mid caps keep nearly all of it (skillspro cap 4: 0.300, cap 8: 0.380 against 0.420 unlimited; Martian cap 4: 0.548, cap 8: 0.581 against 0.581 unlimited, at slightly better precision). So the shipped value holds recall until the boundary is genuinely tuned. An explicit `null` restores the legacy unlimited funnel — a first-class value, not a fallback, and still what an eval overlay measuring a particular adjudicator shape should pin explicitly rather than inherit — and it is `null`, never a typo, that opens the funnel: garbage degrades to the shipped default. Because withholding must stay auditable, each entry in `disposition.json` carries a machine-readable reason — `adjudicated` (the document tiered it itself), `clean-discharge`, `below-floor`, or `body-budget` (past the body cap — nothing is deleted, the demotion is recorded). The four boundary budgets reach `post-review` on the **run context** (`specContext` projects `maxInlineComments` / `internalFloor` / `maxBodyComments` — `"null"` is the unlimited literal — and `boundaryThresholds` as JSON, whenever the pipeline is on), with `getRuntimeConfig()` only the fallback: the eval harness threads the arm's `review:` policy through the context and never populates the process-global config, so a boundary read only off the global silently applied the packaged defaults to every eval arm whatever the overlay pinned. Production is unchanged by construction — the context projects from the same runtime config the fallback reads. No env var. | **no** — operator-only; it is spend, with no more-conservative direction to clamp towards |
| `fix.{maxAttempts,localIterations,gateTimeoutSeconds,escalateModelAfterAttempt,maxCostUsd,maxFlakyDeferrals,retryableClasses}` | `3` / `2` / `900` / `1` / `5.0` / `2` / `[reproducible, env-mismatch]` | Retry budgets shared by every PR_FIX_SHAPED workflow (`pr-fix`, `dependabot-ci-fix`). `maxAttempts` counts *across runs* for one PR; the cost ceiling is cumulative per PR and ships **on**. A diagnosis class outside `retryableClasses` escalates immediately rather than burning budget on a retry that can't help. `localIterations` and `gateTimeoutSeconds` reach the fix phase through a **templated phase budget**: `generic_loop.max_iterations: { from: fix.localIterations, default: 2 }` and `timeout_seconds: { from: fix.gateTimeoutSeconds, default: 900 }` in both fix workflow YAMLs. The `from:` path resolves against the run's EFFECTIVE (already repo-clamped) `fix` block; the literal is the fallback for a context carrying no `fix:` at all. See `06-workflow-engine.md` → "Templated phase budgets". | **yes**, clamped one-way (`escalateModelAfterAttempt` / `gateTimeoutSeconds` operator-only) |
| `dependencies.{autoMergeMaxImpact,requireSettledChecks,minSettledChecks,auditComment}` | `medium` / `true` / `1` / `true` | How far up the impact scale a **major** dependency bump may auto-merge. Impact, not semver magnitude, is the gate: a `@types/*` major is not a framework rewrite. Enforced in two different ways — `requireSettledChecks` / `minSettledChecks` are code (`mayMerge`, decided before the run and handed to the prompt as a verdict), `autoMergeMaxImpact` is prompt-level (the tier is the agent's self-report; nothing parses it or compares it to the ceiling). See "Where `dependencies` is enforced" above. | **yes**, clamped one-way (`minSettledChecks` operator-only) |
| `otel.*` | see Telemetry | Env-overridable per key; `collectorHosts` is *unioned* with env, not replaced. | no |
| `cron.webhooksEnabledCondition` | `true` | Present in `default.yaml` but **inert** — `normalizeFileConfig` never reads a `cron:` block. The real condition is declared per cron YAML (`condition.unless: webhooksEnabled`) and applied by `getJobs`, with `webhooksEnabled` derived in `src/index.ts` as `webhookSecret && githubApp`. | no |

The lenient-vs-strict split matters: blocks whose job is to **bound untrusted
input** (`crons`, `repoConfig.allowKeys`, `repoConfig.allowedModels`, and the
`fix` / `dependencies` / `review` policy blocks) degrade a malformed value to the
documented default rather than throwing, because the same shapes are also read
out of an untrusted repo layer and the two paths must not disagree.
`managedRepos` and `routes`, by contrast, throw on a malformed value — they're
operator-only.

Two spots inside the policy blocks where "lenient" has a specific reading:
`fix.maxCostUsd: null` is the documented "no ceiling" value and is honoured,
while an absent or mistyped key falls back to the shipped ceiling — so a typo
can never silently uncap spend. And `fix.retryableClasses` is validated against
the five diagnosis classes (`DIAGNOSIS_CLASSES` in
`packages/shared/src/config-types.ts`, re-exported by
`src/engine/fix-markers.ts`) but still degrades rather than throwing: an unknown
member is dropped with a warning naming the five, and a list that ends up empty
warns that no PR will be retried. Dropping is the only correct direction — a
class we do not recognise cannot be retried — but doing it silently was the
defect: `reproducable` left a list that looked configured and made every
diagnosis escalate `not-retryable` on the second dispatch.

The three whole-number budgets (`maxAttempts`, `localIterations`,
`maxFlakyDeferrals`) require integers on the operator path too, matching the
repo-layer clamp; `fix: { maxAttempts: 2.5 }` is refused with a warning rather
than leaving the two layers disagreeing about one leaf. `gateTimeoutSeconds` is
a duration, not a count, and still takes any positive number.

`publicConfig` isn't a knob: it's the redacted default / overlay / merged /
provenance bundle `loadConfig` builds for `GET /admin/api/config`.

## Secrets layout

The GitHub App PEM is the only secret with a non-env home. Layout
inside the harness process:

```
secrets/app.pem                     ← original (mode 600)
$STATE_DIR/secrets/app.pem          ← copy populated by deploy/entrypoint.sh
                                      so sandboxes on the shared volume can
                                      reach it, but only when allowed
```

The PEM is read by the harness itself to mint installation tokens
(`src/engine/github/git-auth.ts`). Sandboxes receive the **minted token**
(`GIT_TOKEN` env), not the PEM. The PEM only reaches a sandbox when the
access profile sets `allowMcpAppAuth: true` (currently only the
`repo-write` profile for the build cycle), and even then via the shared
secrets volume — never inlined in env or sandbox args.

Low-trust sandboxes are simply never *given* the App env at all: the executor
builds a per-run credential map and only writes `GITHUB_APP_ID` /
`GITHUB_APP_INSTALLATION_ID` (the one **resolved for the run's owner**) /
`GITHUB_APP_PRIVATE_KEY_PATH` into it when the profile sets `allowMcpAppAuth`. An absent key means "no credential", so nothing
has to be blanked out — and the map is never spliced into the harness's shared
`process.env` (issue #215; see `09-sandbox.md`).

## STATE_DIR tree

`sessions/`, `logs/` and `sandboxes/` are created at boot (`main()` in
`src/index.ts`); the rest appear on first use:

```
$STATE_DIR/
├── lastlight.db           SQLite state DB (absent on the Postgres runtime) — see §10
├── logs/                  structured harness logs
├── sandboxes/             cloned repos, one dir per taskId
├── secrets/
│   └── app.pem            mode-600 copy of the GitHub App PEM
├── agent-sessions/        JSONL envelopes, one file per agent session.
│                          Dashboard reads from here.
├── build-assets/          server-mode build handoff docs (when
│                          buildAssets.location = server):
│                          <owner>/<repo>/<issueKey>/*.md
├── repo-config/           per-repository config layer cache (see above):
│   └── <owner>/<repo>/
│       ├── meta.json      sidecar — default branch, tree sha, etag, warnings
│       └── files/         the unpacked .lastlight/ tree
└── proxy/                 generated egress firewall configs
    ├── nginx-strict.conf
    ├── nginx-open.conf
    ├── Corefile.strict
    ├── Corefile.open
    └── otel-collector.yaml   in-network collector config (mode 0600 —
                              may hold backend auth headers)
```

`proxy/` is regenerated on every harness boot from the allowlist in
`src/sandbox/egress-allowlist.ts` (plus the harness `OTEL_*` env for the
collector config) — bind-mounted read-only into the firewall + collector
containers. `repo-config/` is a *cache*: safe to delete, refilled by the next
conditional fetch. It holds untrusted bytes from managed repos, so nothing in it
is ever executed — only read as prompts / skills / agent-context / YAML.

## Invariants

- **PEM never reaches a sandbox by default.** Only the `repo-write`
  profile gets it, and only via the shared secrets volume — never via
  env, args, or stdin.
- **Empty `WEBHOOK_SECRET` is permitted but logs a warning.** In
  production this is dangerous; in dev it's necessary for ngrok-style
  setups. The choice is on the operator.
- **Defaults are dev-safe, not prod-safe.** `ADMIN_SECRET` is the most
  obvious example — its default explicitly contains `dev`. A production
  config validator (out of scope for the harness) is the right place to
  refuse boot on dev defaults.
- **JSON config never fails-closed.** Both `LASTLIGHT_MODELS` and
  `LASTLIGHT_THINKINGS` log on parse error and use `{}`. The cost is a
  silent fall-back to the default model — acceptable because the
  alternative would refuse to boot a working harness over a typo.
- **`APPROVAL_GATES` is positive enable, never negative disable.** There
  is no `APPROVAL_GATES=*` shortcut. A re-implementation that wants
  one-line "enable everything" should add an explicit token like `all`,
  not silently treat missing as enabled.
- **`OPENCODE_*` aliases stay.** They are the legacy names from when the
  runtime was OpenCode; they will keep working. New env should use
  `LASTLIGHT_*` for clarity.
- **The repo layer is read from the default branch, never a PR head.** This is
  the whole security model of `.lastlight/`. A re-implementation that resolves it
  from the checkout under review has handed every contributor the agent's
  configuration.
- **A repo's config file can never fail a run.** Every rejection is a warning +
  a drop. The single exception is `disabled.workflows`, where the repo is
  deliberately refusing the run — reported the same way the unmanaged-repo guard
  refuses one.
- **The repo layer is bounded by the operator, and can't widen itself.**
  `repoConfig` is operator-only; an allow-listed key with no validator is still
  dropped, so widening requires a code change that has been reviewed, not a
  config edit.
- **Repo `agent-context` is additive only.** A repo file whose basename an
  operator-owned layer already provides is dropped, so committing `security.md`
  or `rules.md` can't neuter the operator's rules. Enforced once, at composition
  time (`agentContextAdditiveOnly`); every downstream consumer uses the composed
  value verbatim.
- **Repo `approval` is add-only.** A repo may raise a gate for runs against
  itself, never clear one.
- **A repo may only ever be more conservative than the operator.** The same rule
  generalised to the `fix` / `dependencies` / `review` policy blocks: a leaf that
  would loosen a budget, widen a retry set or raise an auto-merge ceiling is
  dropped (`policy-downgrade`) and resolves back to the operator's value. Where
  even a one-way clamp would be wrong — spend, a shared resource, or an escape
  hatch a `max()` would weld shut — the leaf is operator-only instead. A
  re-implementation that admits these blocks symmetrically has let every managed
  repo set its own budget.
- **Per-run config is per-run state, never a global.** The repo layer is carried
  on the run (and on a per-run `AssetResolver`), because concurrent runs and cron
  fan-outs share the process — a module-level install would hand one repo's
  overrides to another repo's run.

## Current implementation

Boot config is `src/config/config.ts` — `loadConfig()` (dotenv → default YAML →
overlay YAML → the materialized env layer → `normalizeFileConfig`), plus
`buildEnvConfigLayer` (the single home for env-var→config-path knowledge,
legacy `OPENCODE_*` aliases included), `parseApprovalGates`, `resolvePublicUrl`,
`sandboxBackend`, `resolveKubernetesConfig`, `resolveGithubAuth`, and the
redaction pair `SENSITIVE_KEY_RE` / `redactPublic`. Layer merging is
`src/config/config-resolve.ts`, which re-exports `mergeLayer` from
`lastlight-shared/repo-config-schema` rather than carrying its own copy.

Per-task resolvers — `resolveModel(models, taskType)`, `resolveVariant()` — sit
alongside the schema and are called from the runner and dispatch closure, not
from the config loader itself.

The per-repository layer is split across three files, by purity:

| File | Owns |
|---|---|
| `packages/shared/src/repo-config-schema.ts` | The **pure** half — bounds (`RepoConfigPolicy`, `DEFAULT_REPO_CONFIG_ALLOW_KEYS`, the size/file caps), path classification (`repoLayerPathKind`, `isRepoWorkflowPath`), the file-level guard (`sanitizeRepoFiles`), the config-level guard (`parseRepoConfigYaml`, `sanitizeRepoConfigLayer`), the merge (`mergeLayer`, `resolveRepoConfig`), and the warning vocabulary. In the leaf package because the CLI validates `.lastlight/` offline and may never gain an edge to core. |
| `apps/server/src/config/repo-config.ts` | The **impure** half — `fetchRepoLayer` / `refreshRepoLayer` / `invalidateRepoLayer` / `getCachedRepoLayer`, the TTL + sidecar cache, the atomic unpack, `repoConfigPolicy()`, `repoConfigBaseFromRuntime()`. Re-exports the pure half wholesale, so it is the single import surface for core. |
| `apps/server/src/workflows/simple.ts` | The **per-run** projection — `resolveRepoRunConfig` (called from the dispatch choke point), `RunRepoConfig`, `repoConfigRunRecord` (persist) / `restoreRepoRunConfig` (resume), `soleRepoInContext`. |

Cron participation lives beside the scheduler instead
(`apps/server/src/cron/repo-crons.ts`: `resolveCronRepos`, `repoCronPrefs`,
`cronVote`, `repoLayerMayVote`, `operatorCrons`) because it decides *which repos*
a cron fans out over — a decision made before any run, and therefore before any
merged per-run config, exists.

The cheap one-shot helpers (`classifier`, `screener` in `src/engine/llm.ts`)
also honour the `models:` map: `defaultFastModel(taskType)` reads
`config.models[taskType]` first (so `models.classifier` / `models.screener` in
`config.yaml` work like any per-task model), then the env `OPENCODE_MODELS`
map, then the first provider's fast model. Unlike `resolveModel`, it never
falls back to `models.default` — an unset helper stays on the cheap provider
default rather than inheriting the (expensive) workflow default.

## Rebuild notes

- **Layered config, not flattened.** Keep base + per-task-override
  separate. Flattening them at load time means future per-task knobs
  require a config schema change instead of a JSON-blob update.
- **Validate at boundary, not at use.** The harness's pre-flight check
  is the right place for fatal validation. Once `LastLightConfig` is
  built, downstream code should not have to re-check field shapes.
- **Type the variant level.** Even if you load it from a string env var,
  parse to a typed enum at the boundary so `thinking: "wat"` fails fast
  instead of silently degrading to a provider default.
- **Pick semantic exit codes.** A re-implementation in Go / Rust / etc.
  should still distinguish "this won't work no matter how many times
  you restart" (use 78 `EX_CONFIG`) from "I crashed" (any other code).
- **Secrets layout is enforceable.** A re-implementation can go further
  and refuse to read the PEM unless it's mode-600 and owned by the
  process user. Last Light's current check is structural (the file
  exists and parses); a hardened version should check the FS metadata
  too.
- **Forward per-provider keys conservatively.** Provider API keys reach
  the sandbox; web-search keys reach it only when the phase opts in.
  A new key category should default to *not* forwarded — opt-in is the
  safe default.
