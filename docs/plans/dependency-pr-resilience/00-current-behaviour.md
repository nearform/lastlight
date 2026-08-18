# Phase 0 — How it behaves today (research record)

No code changes. This is the evidence base for every later phase; read it
before executing any of them. Line references are against the tree at the time
of writing (`v0.22.0`, commit `7d4cc40`).

## The two workflows

| | `dependabot-ci-fix` | `dependabot-pr-merge` |
|---|---|---|
| File | `apps/server/workflows/dependabot-ci-fix.yaml` | `apps/server/workflows/dependabot-pr-merge.yaml` |
| Kind | `pr-fix` | `pr-merge` |
| Phases | one — `fix` | one — `assess` |
| Prompt | `prompts/dependabot-ci-fix.md` (87 lines) | `prompts/dependabot-pr-merge.md` (219 lines) |
| Skill | `building` | `code-review` |
| Model | `{{models.pr-fix}}` | `{{models.review}}` |
| Checkout | **yes** — PR head pre-cloned, depth 50 | **no** — empty workspace, `github_*` tools only |
| Git profile | `repo-write` | `repo-write` (only for `github_enable_auto_merge`) |
| Postcondition | **none** | `on_output.requires_marker: ASSESSMENT_COMPLETE` |
| Loop | none | none |
| Cron backstop | `fix-red-dependency-prs`, daily 15:00 | `merge-green-dependency-prs`, daily 14:00 |

`pr-fix` (`apps/server/workflows/pr-fix.yaml`) is the same shape as
`dependabot-ci-fix`: one `fix` phase, `skill: building`, `{{models.pr-fix}}`,
`{{ciSection}}`, and it is in the same `PR_FIX_SHAPED_WORKFLOWS` and
`PER_TARGET_REUSE_WORKFLOWS` sets. Anything keyed off those sets improves both.

There is **no separate `pr-merge.yaml`** — `pr-merge` is only a `kind:`, and
`dependabot-pr-merge` is its sole member.

## Trigger matrix

### `dependabot-ci-fix`

| Route | Mechanism |
|---|---|
| `pr.checks_failed` webhook | `check_suite.completed` + `failure`/`timed_out`, pre-filtered to dependency PRs, **settle-aware**. Routed by the *classifier* (not deterministically) via the workflow's `classification.intent`. |
| `fix-red-dependency-prs` cron | `discoverRedDependencyPrs` finds settled-failing PRs, or `mergeable_state` in `behind`/`dirty`/`blocked`, and fans out one run per PR carrying `branch` + `reason`. |
| `@bot` comment | Classifier, enriched by `dependencyPrSignals()` with `prAuthor` + `checksState`. |

### `dependabot-pr-merge`

| Route | Waits for all checks to settle? |
|---|---|
| `pr.checks_passed` webhook | **Yes.** `settledConclusion` (`src/connectors/github-webhook.ts:451-467`) calls `getChecksConclusion(owner, repo, head_sha)`, which aggregates check_runs **and** the combined commit status. A suite going green while siblings still run reports `pending` and is dropped, so exactly one event fires per SHA — the last suite to settle. Routed **deterministically** (no classifier call). |
| `merge-green-dependency-prs` cron (14:00) | **No.** `discoverGreenDependencyPrs` filters on `mergeable_state === "clean"` only, never on the check conclusion. |
| `@bot` comment | **No.** `dependencyPrSignals` computes `checksState` for the *classifier*, but nothing gates the run on it. |

So the "wait for all checks" behaviour that exists is an emergent property of
one code path, not a policy — and it is **not configurable at all**. What *is*
configurable today is the cron (schedule + participation, via the operator
`crons:` block, `cron_overrides` rows, and per-repo `.lastlight/` opt-in/out
from #180) and whether the workflow runs at all (`disabled.workflows`).

Two edges follow from this and matter in Phase 3:

- **`"none"` is not `"passing"`.** A repo with zero CI never fires the webhook,
  so only the cron sees it — and there `mergeable_state: clean` is true. That is
  precisely the "direct merge lands a red PR" hazard the merge prompt already
  documents at line 143 (*"On a repo with no required checks, a PR whose checks
  are FAILING still reports as mergeable, so a direct merge would land a RED PR
  (this has happened)"*).
- **Settled ≠ complete.** `getChecksConclusion` can only see checks that
  *exist*. A check run created late (a `workflow_run`-triggered job, a required
  workflow that only starts after another finishes) is invisible at settle
  time, so "settled" can be premature. This is why `github_enable_auto_merge`
  must stay the default action and direct merge the narrow exception —
  GitHub's own required-checks gate is the real backstop.

## Finding 1 — we do not have `Actions: read`

`GitHubClient.getFailedChecks` (`apps/server/src/engine/github/github.ts:679`)
tries `octokit.rest.actions.downloadJobLogsForWorkflowRun` and, on any failure,
falls through to `fetchAnnotationExcerpt`:

```ts
try {
  const { data: logData } = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({...});
  logExcerpt = extractErrorExcerpt(fullLog);
} catch {
  // Job logs may not be available — fall back to annotations
}
```

That `catch` is silent. Meanwhile the documented App permission set —
`apps/www/src/pages/docs/github-app.astro:43-75`,
`apps/server/spec/03-integrations.md:60-62`,
`plugins/lastlight/skills/lastlight-server/SKILL.md:40` — lists **Contents,
Issues, Pull Requests, Checks, Workflows, Metadata**. "Workflows" is the
permission to *push files under `.github/workflows/`* (needed so the bot can
land Actions version bumps); it is **not** Actions.

So on every installation that followed our own setup docs, the log download
403s and the fix agent has been reasoning from check-run annotations rather
than real CI output. That call is the **only** Actions API usage in the entire
codebase.

## Finding 2 — `pr-fix` gets no CI feedback

`pr.checks_failed` is emitted only for dependency PRs. The connector pre-filters
(`src/connectors/github-webhook.ts` ~L378-433):

```ts
const isDependencyPr =
  /^(dependabot|renovate)\[bot\]$/.test(commitAuthor) ||
  /^(dependabot|renovate)\//.test(headBranch);
```

A human PR going red fires nothing. `pr-fix` is therefore comment-triggered
only and can never observe whether its own push worked — the same one-shot
problem as #251, one layer out.

## What exists today in place of a retry mechanism

There is **no per-PR attempt counter anywhere**. What stands in for one:

1. **`requires-human` as a terminal flag.** Applied by the agent
   (prompt-level), consumed by `listDependencyCandidates`
   (`src/cron/dependabot-discovery.ts:215`) so both crons skip it forever, and
   by `dependencyDedupSkip` (`src/engine/dispatcher.ts:236-238`) so webhooks
   skip it. Nothing ages or decrements it; only a later `dependabot-pr-merge`
   TRIVIAL verdict removes it.
2. **Head-SHA "assess once per SHA"** — `dispatcher.ts:240-249` compares live
   `pr.head.sha` against
   `db.runs.latestSucceededForTrigger(handler, "repo#N").context.headSha`.
   Only *succeeded* runs count, so a failed run re-runs on the same SHA.
3. **Concurrency guard** — `db.executions.isRunning(handler, triggerId)`.
4. **Per-target workspace reuse** — both dependency workflows are in
   `PER_TARGET_REUSE_WORKFLOWS`, so taskId is `${repo}-${prNumber}-${workflow}`
   and repeated runs land in the same sandbox dir (warm `node_modules`, a
   `git fetch` + `reset --hard` + `clean -fdx -e node_modules` on a cross-run
   marker).
5. **`MAX_RESTART_RESUMES = 3`** (`src/workflows/resume.ts:460`) — a harness
   crash-loop breaker, not a PR-level attempt count.
6. **Cron cadence** is the only repeat driver — daily, `maxPerRepo: 25`,
   oldest-first.

## Engine capabilities already available

From `packages/workflow-engine/src/core/schema.ts`:

- **`loop:`** (`PhaseLoopSchema`) — `max_cycles` +
  `on_request_changes.{fix_prompt, fix_model, fix_variant, re_review_prompt}`.
  Note `fix_model`: the existing precedent for *a different model on the retry
  step*.
- **`generic_loop:`** (`GenericLoopSchema`) — `max_iterations`, `until`,
  `until_bash`, `interactive`, `gate_kind`, `scratch_key`, `fresh_context`,
  `on_soft_failure: { retries, then }`. `runUntilBash`
  (`phase-executor.ts:753`) runs the command **inside the sandbox** against the
  persisted workspace; exit 0 ends the loop.
- **`type: bash` / `type: script`** phases run deterministic commands in the
  same workspace, with stdout exposed downstream via `output_var`.

**No production workflow uses `generic_loop` with `until_bash`, or `type: bash`
/ `type: script`.** The only example is
`apps/server/workflows/examples/tdd-loop.yaml`. They are integration-tested
(`tests/sandbox/command-exec.integration.test.ts`) but unproven in production.

### The three engine gaps this plan routes around

1. **Loops only retry *soft* outcomes.** `isSoftOutcome`
   (`phase-executor.ts:204-210`) is stop reason `unknown` / `error_truncated`.
   A hard failure (non-zero exit, tool error, terminated) is never retried by
   any loop. There is no "the tests failed, try again" policy.
2. **Per-attempt model templates are impossible.** `resolveModelVariant`
   (`phase-executor.ts:504-518`) renders `model:` / `fix_model:` against
   `this.run.ctx` **only**. The generic loop *does* put `iteration` /
   `maxIterations` into the prompt render context (`phase-executor.ts:1105-1112`)
   but calls `resolveModelVariant(phase.model, phase.variant, phaseName)`
   without it, so `{{attempt}}` inside a `model:` template cannot work.
3. **The engine cannot see spend.** `ExecutionResult.costUsd` is captured per
   phase into `executions.cost_usd` and rolled up as
   `workflow_runs.totalCostUsd` in `list()` only. The `ExecutionLedger` port
   exposes **no cost read**, so no in-engine budget check is possible without a
   new port method. Cost is accounted everywhere and enforced nowhere; the only
   admission concept is `concurrency.maxWorkflows`.

## Other latent bugs found (fixed in Phase 3)

1. **Cron-triggered `dependabot-ci-fix` gets no CI failure text.** The cron
   fan-out (`src/index.ts` ~L800-885) calls `dispatchWorkflow` **directly**,
   bypassing `handlePrFix`. So a backstop run carries `branch` + `reason` but
   no `ciSection` / `failedChecks`, and gets no fork-PR guard. `{{ciSection}}`
   renders empty on every nightly run. Conversely, webhook-triggered runs have
   `ciSection` but no `{{reason}}`.
2. **`handlePrFix` drops `headSha`** from the dispatch context, which quietly
   weakens `dependencyDedupSkip` — it compares against
   `lastRun.context.headSha`, which the ci-fix path may never set.
3. **`baseBranch` is the repo default, not the PR base.** For ci-fix,
   `src/index.ts:442-453` resolves `extra.baseBranch` via `getDefaultBranch()`
   because `extra.baseBranch` is only set on the
   `PR_HEADREF_PREPOPULATE_WORKFLOWS` path. A PR targeting a non-default branch
   therefore merges the wrong base in prompt step 1.
4. **`dependabot-ci-fix` has no completion marker.** It is the only dependency
   workflow with no `on_output.requires_marker`, so a run that inspects the PR
   and stops without pushing or labelling reports green.

## Frozen surfaces to respect

- **`runWorkflow.length === 9`** — pinned by `evals-contract.test.ts` (the
  `lastlight/evals` public contract). Never add a positional parameter; extend
  `ctx` or the defaulted 10th `repoConfig`.
- **`DEFAULT_REPO_CONFIG_ALLOW_KEYS` must equal `repoConfig.allowKeys` in
  `config/default.yaml`, including order** — asserted by
  `tests/config/repo-config-shared.test.ts` (they drifted once already).
- **`tests/cron/label-vocab.test.ts`** asserts the dependency label strings in
  `src/cron/dependabot-discovery.ts` appear verbatim in both dependabot
  prompts. Markdown cannot import, so this test is the only thing keeping code
  and prompts in sync.
- **`tests/workflows/dependabot-ci-fix.test.ts`** asserts
  `phases.map(p => p.name)` equals `["fix"]`.
- **`{{phaseOutputs}}` is empty across a resume boundary** — a phase skipped as
  already-`done` contributes nothing to the in-memory outputs map. Cross-phase
  and cross-attempt state must ride `scratch`, workspace files, or build
  assets.
