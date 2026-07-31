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
  disabled: DisabledConfig;               // { workflows, crons, prompts, skills, agentContext }: string[]
  crons: CronsConfig;                     // { enable: string[]; disable: string[] } — cron participation
  otel: OtelConfig;                       // OpenTelemetry export (off by default)
  publicConfig: PublicConfigBundle;       // redacted default/overlay/merged + provenance, for the dashboard
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    installationId: string;
  };
  githubToken?: string;                   // PAT fallback — ONLY when no App is configured
  slack?: SlackConfig;
  approval?: Record<string, boolean>;     // gate-name → enabled
  bootstrapLabel: string;
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
  repoConfig: RepoConfigPolicy;           // operator bounds on the per-repository layer
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
  deliveryChannel?: string;
}

interface SandboxCleanupConfig {
  enabled: boolean;                       // master switch for the TTL/LRU sweep (default true)
  reapOnCompletion: boolean;              // reap an ephemeral workspace on terminal success (default true)
  sweepSchedule: string;                  // cron expr for the backstop sweep (default "0 * * * *")
  retentionHours: number;                 // sweep dirs older than this (default 12)
  maxDirs: number;                        // LRU cap on workspace dirs (default 40)
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
}

interface FixConfig {                     // budgets for every PR_FIX_SHAPED workflow
  maxAttempts: number;                    // cross-run attempts per (repo, PR) before requires-human
  localIterations: number;                // gate-loop iterations WITHIN one attempt   [NOT WIRED]
  gateTimeoutSeconds: number;             // until_bash budget for the build/test gate [NOT WIRED]
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
}

interface KubernetesConfig {              // resolved by resolveKubernetesConfig(), env > block > defaults
  namespace: string; image: string; storageClassName: string; workspaceSize: string;
  runAsUser: number; harnessEndpoint: string; harnessNamespace: string;
  harnessPodLabels: Record<string, string>;
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
| `repoConfig.allowKeys` | `[models, variants, crons, disabled.workflows, disabled.crons, approval, fix, dependencies, review]` | Dotted config paths a repo may set. An entry admits itself and everything beneath it (`models` admits `models.architect`; `disabled.workflows` does **not** admit `disabled.prompts`). |
| `repoConfig.allowedModels` | `null` | `null` = any model whose `provider/` prefix is a provider Last Light can wire. A list restricts to exactly those specs (exact match, never a prefix rule). |
| `repoConfig.allowAssets` | `true` | Unpack and use the repo's `workflows/prompts/`, `skills/`, `agent-context/` overrides. `false` keeps `lastlight.yml` only. |

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
| `fix.retryableClasses` | yes | a **subset** of the operator's list — naming a class the operator doesn't retry would *add* a retryable failure mode; the remaining (possibly empty) subset stands, since retrying less is always allowed |
| `fix.escalateModelAfterAttempt` | **no** | operator-only — spend control |
| `fix.gateTimeoutSeconds` | **no** | operator-only — a shared-resource budget, not a "how careful is this repo" dial |
| `dependencies.autoMergeMaxImpact` | yes | the **lower** tier on `none < low < medium < high` (a clamp on a *prompt-level* ceiling — see below) |
| `dependencies.requireSettledChecks` | yes | add-only `true` — a repo may demand settled checks, never waive the operator's requirement |
| `dependencies.minSettledChecks` | **no** | operator-only — see below |
| `dependencies.auditComment` | yes | free — cosmetic either way, and the paper trail it silences is its own |
| `review.trigger` | yes | free — all three modes are equally safe; a repo choosing `on-request` is opting *itself* out of automation |
| `review.requestLabel` | yes | free, but validated as a label **name** (no `/`, no `..`) — same guard `disabled` applies to workflow names |
| `review.postsCheck` | yes | add-only `true` — a repo may ask for the check, never suppress one a branch-protection rule may be requiring |
| `review.skipDraft` | yes | add-only `true` — a repo may skip drafts, never force reviews onto them |

An add-only key given `false` is dropped as `policy-downgrade` when the operator
actually had the stricter value, and as `invalid-value` when it didn't — the key
is add-only either way, but only the first case is a repo *losing* an argument
with its operator.

The three operator-only leaves are reported as `key-not-allowed`, the same code
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

`review.postsCheck` predates the block and is still **mirrored** flat as
`config.reviewPostsCheck` (the `REVIEW_POSTS_CHECK` env var below) for the
public-config surface — one value projected two ways rather than a second source
of truth. Nothing reads the flat copy any more: the check lifecycle resolves
`review.postsCheck` off the run's repo-clamped config, so a repo that asked for
the check gets it.

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
| `GITHUB_APP_INSTALLATION_ID` | GitHub integration | — (**required** once `GITHUB_APP_ID` is set) |
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
| `SLACK_DELIVERY_CHANNEL` / `SLACK_HOME_CHANNEL` | cron report destination | none |
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
on any attempt above `fix.escalateModelAfterAttempt`, before the map is persisted
on the run context, so the admin panel shows the model that attempt actually used.
Unset, nothing changes at any attempt number. `diagnose` is left **unset** on purpose:
those examples are Anthropic models, and pinning one packaged would send that
phase at a provider a deployment overriding only `models.default` has no key for.
Unset it falls through to `default` — a cheap model there is the whole point of
splitting the phase out, so it is worth pinning per deployment.
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
| `SANDBOX_MEMORY_LIMIT` | docker only | `2g` |
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
  inside the target repo and `git commit`s them onto the working branch. PR
  bodies link them via `{{branchUrl}}`/`{{artifactUrl}}` → GitHub blob URLs.
  Byte-for-byte the historical behaviour.
- **`server`** — the docs are externalized to
  `$STATE_DIR/build-assets/<owner>/<repo>/<issueKey>/`, never committed. The
  executor stages the store's docs into the workspace before each phase and
  harvests changed docs back afterwards (`stageArtifactsIn`/`harvestArtifactsOut`
  in `src/engine/agent-executor.ts`). For **pre-cloned** workflows (build, pr-*)
  on a whole-workspace backend (docker/none/smol) the staged dir is the
  **workspace root** — a sibling of the checkout, reached by the agent via
  `{{issueDir}}` = `../.lastlight/<issueKey>` — so `git add -A` structurally
  can't see it (`buildAssetsRelocated`, `hostRepoDirFor`). gondolin mounts only
  cwd, so there (and in repo mode) the dir stays the in-repo `.lastlight/<key>/`
  and is git-excluded as a backstop. Prompts gate their doc commit behind
  `{{#if !externalizeArtifacts}}`, and `{{artifactUrl}}` resolves to a dashboard deep link
  (`/admin/?tab=artifacts&repo=…&key=…&doc=…`). The admin API exposes the store
  read-only at `/admin/api/artifacts[/:owner/:repo/:key[/:doc]]`.

Unknown `LASTLIGHT_BUILD_ASSETS` values log a warning and fall back to the
file/default location.

### State and paths

| Var | Purpose | Default |
|---|---|---|
| `STATE_DIR` | root for all persistent state | `./data` |
| `DB_PATH` | SQLite file | `$STATE_DIR/lastlight.db` |
| `LASTLIGHT_SESSIONS_DIR` | JSONL session envelopes (dashboard reads here) | `$STATE_DIR/agent-sessions` |
| `BUILD_ASSETS_DIR` | server-mode build-asset store root | `$STATE_DIR/build-assets` |
| `LASTLIGHT_OVERLAY_DIR` | deployment overlay root — `config.yaml` + asset overrides (`workflows/`, `workflows/prompts/`, `skills/`, `agent-context/`) + `secrets/`. Boot fails loudly if it's set but missing or unpopulated. | unset (no overlay) |
| `WEBHOOK_PORT` / `PORT` | webhook listener port | `8644` |

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
| `EXPLORE_DEFAULT_REPO` | `owner/name` — destination for Slack-initiated explore publish | unset (must be set or run fails at publish phase) |
| `REVIEW_POSTS_CHECK` | post a Check Run on PR head SHA after pr-review | `false` |
| `MAX_CONCURRENT_WORKFLOWS` | global cap on sandboxed workflow runs executing at once; excess triggers are persisted as `queued` and admitted FIFO as slots free (overlay `concurrency.maxWorkflows`) | `4` |
| `MAX_QUEUE_WAIT_MS` | how long a `queued` run may wait before it's dropped (cancelled with a "waited too long" notice) by the admission sweeper (overlay `concurrency.maxQueueWaitMs`) | `3600000` (1 hr) |
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
| `repoConfig.{enabled,allowKeys,allowedModels,allowAssets}` | see the per-repository layer above | The operator's bounds on the repo layer. | **never** — a repo can't widen its own bounds |
| `deploy.version` | `string \| null`, `null` | Core-version pin (git tag/ref). Deployment config, not runtime behaviour. Env: `LASTLIGHT_CORE_VERSION`. | no |
| `bootstrap.label` / `explore.defaultRepo` | see Misc | Env: `BOOTSTRAP_LABEL` / `EXPLORE_DEFAULT_REPO`. | no |
| `review.{postsCheck,trigger,requestLabel,skipDraft}` | `false` / `after-checks` / `null` / `true` | When a `pr-review` run is triggered, and whether it posts the `last-light/review` check. `after-checks` means "once the head SHA's checks **settle**, either colour" — so the review can read and cite the CI result, and a push-storm collapses to one review per settled SHA. There is no settled-*and-passing* sub-mode: a PR whose CI never goes green would then never be reviewed at all. Enforced by `resolveReviewTrigger` (`src/engine/pr-decisions.ts`) at the [dispatch gate](/spec/05-router#reviewtrigger--one-resolver-every-route) — **one** implementation, on every route, with `src/cron/review-discovery.ts` reduced to a candidate finder. `on-request` is served by `requestLabel`, an `@bot review` comment, and the Re-run button on the check; `review_requested` is opportunistic only, since GitHub App bot users are not selectable in the reviewer picker. Env: `REVIEW_POSTS_CHECK` (`postsCheck` only). | **yes** — `postsCheck`/`skipDraft` add-only, the rest free |
| `fix.{maxAttempts,localIterations,gateTimeoutSeconds,escalateModelAfterAttempt,maxCostUsd,maxFlakyDeferrals,retryableClasses}` | `3` / `2` / `900` / `1` / `5.0` / `2` / `[reproducible, env-mismatch]` | Retry budgets shared by every PR_FIX_SHAPED workflow (`pr-fix`, `dependabot-ci-fix`). `maxAttempts` counts *across runs* for one PR; the cost ceiling is cumulative per PR and ships **on**. A diagnosis class outside `retryableClasses` escalates immediately rather than burning budget on a retry that can't help. **`localIterations` and `gateTimeoutSeconds` are parsed, clamped and reported but read by nothing**: the phase schema takes `max_iterations` / `timeout_seconds` as plain numbers, so they can't be templated from config, and both fix workflow YAMLs hardcode the matching `2` and `900`. Setting either key changes nothing — edit the workflow YAML (or fork it in an overlay) instead. | **yes**, clamped one-way (`escalateModelAfterAttempt` / `gateTimeoutSeconds` operator-only) |
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
can never silently uncap spend. And `fix.retryableClasses` is a free string list
rather than an enum: the class vocabulary belongs to the `diagnose` phase, and an
operator naming a class this build doesn't know should narrow the retry set, not
fail the boot.

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
`GITHUB_APP_INSTALLATION_ID` / `GITHUB_APP_PRIVATE_KEY_PATH` into it when the
profile sets `allowMcpAppAuth`. An absent key means "no credential", so nothing
has to be blanked out — and the map is never spliced into the harness's shared
`process.env` (issue #215; see `09-sandbox.md`).

## STATE_DIR tree

`sessions/`, `logs/` and `sandboxes/` are created at boot (`main()` in
`src/index.ts`); the rest appear on first use:

```
$STATE_DIR/
├── lastlight.db           SQLite — see §10
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
