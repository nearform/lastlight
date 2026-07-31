# Phase 3 — Deterministic signals in code

> **Superseded in structure by [09-state-machine.md](09-state-machine.md).**
> This phase is restructured around a single `resolvePrState` snapshot rather
> than four enrichment fields, which makes it the **largest** phase, not the
> smallest. §3.2's `dependencyPreflight` becomes `resolveFixDisposition`, and
> §3.4's broadening is **incomplete without** the deterministic routing fix
> (09 → D5) — as written it sends human PRs to `dependabot-ci-fix`. Read 09
> first.

**Risk: ~~low~~ medium.** Independent of Phases 1 and 2; can land first.

Every later decision — retry or escalate, merge or wait — should rest on a fact
the harness computed, not on the agent's reading of `mergeable_state`. This
phase produces those facts and fixes four latent bugs found along the way.

## 3.1 — `enrichPrFixContext` (dispatcher)

`apps/server/src/engine/dispatcher.ts`

Extract the branch / CI-report / fork-guard block out of `handlePrFix`
(L578-668) into an exported `enrichPrFixContext(context, deps)`. It must now
also emit:

- **`headSha`** — currently **dropped**. `dependencyDedupSkip` compares live
  `pr.head.sha` against `lastRun.context.headSha`, which the ci-fix path may
  never set, so the "already assessed at this SHA" guard is weaker than it
  looks.
- **`baseChecksState`** — from `getBaseChecksState` (Phase 1), the sole signal
  for the `upstream-broken` class.
- **the structured CI report** (Phase 1) rendered into `ciSection`, plus
  `ciLogsAvailable`.

## 3.2 — `dependencyPreflight`

Rename and extend `dependencyDedupSkip` (L212-251) → `dependencyPreflight`,
returning `{ skip?, enrich? }`. In addition to today's two skips
(`requires-human` present; head SHA already assessed) it resolves:

```ts
const checksState = await github.getChecksConclusion(owner, name, pr.head.sha);
// → context: { checksState, checksSettledPassing: checksState === "passing" }
```

For `dependabot-pr-merge`, **`checksState === "pending"` is a skip** — the
settled webhook or the daily cron will pick it up. This is the "wait while CI
is still running" guard at its cheapest point, before any sandbox is
provisioned.

Keep the existing fail-open behaviour: a read failure returns no skip. We would
rather occasionally re-run than drop a genuine event.

## 3.3 — One enrichment path for webhook *and* cron

`apps/server/src/index.ts` — `dispatchWorkflow` (~L385-465) is the single choke
point both routes pass through (it is already where `resolveRepoRunConfig`
runs).

- Call `enrichPrFixContext` when `PR_FIX_SHAPED_WORKFLOWS.has(workflowName)`
  and `ciSection` is absent. **This closes a real gap**: the cron fan-out calls
  `dispatchWorkflow` directly, bypassing `handlePrFix`, so every nightly
  `fix-red-dependency-prs` run today has an empty `{{ciSection}}` and no
  fork-PR guard.
- **Fix `baseBranch`.** ci-fix currently gets `extra.baseBranch` from
  `getDefaultBranch()` (L442-453) because `extra.baseBranch` is only set on the
  `PR_HEADREF_PREPOPULATE_WORKFLOWS` path (L407-433). Resolve `pr.base.ref` for
  `PR_FIX_SHAPED_WORKFLOWS` too — a PR targeting a non-default branch currently
  merges the wrong base in the fix prompt's step 1.

## 3.4 — Give `pr-fix` a CI feedback loop

`apps/server/src/connectors/github-webhook.ts`

`pr.checks_failed` fires only for dependency PRs, so `pr-fix` can never see
whether its own push worked (Finding 2). Broaden the gate to *also* emit when
the head commit author is **`<botName>[bot]`** — i.e. Last Light pushed the
last commit:

```ts
const isDependencyPr =
  /^(dependabot|renovate)\[bot\]$/.test(commitAuthor) ||
  /^(dependabot|renovate)\//.test(headBranch);
const isOurOwnPush = commitAuthor === botLogin;      // <botName>[bot]
if (pr?.number && (isDependencyPr || isOurOwnPush)) { … }
```

This is precisely "did my fix work?" and stays bounded: it never fires for an
ordinary human PR the bot has not touched. It is nonetheless the one change in
this plan that can increase run volume on non-dependency PRs — watch it after
rollout.

Keep the existing `settledConclusion` gate for the broadened case too, so we
still fire once per SHA rather than once per check-reporting app.

## 3.5 — Make the cron's "green" honest

`apps/server/src/cron/dependabot-discovery.ts`

`discoverGreenDependencyPrs` filters on `mergeable_state === "clean"` only.
Also require `getChecksConclusion(headSha) === "passing"` when
`dependencies.requireSettledChecks` is on (Phase 6).

`mergeable_state === "clean"` alone is not proof: on a repo with **no required
checks** a red PR still reports mergeable — the exact hazard the merge prompt
documents at line 143, and the reason the direct-merge path exists in the first
place.

Cost note: this is one extra API call per green candidate. The sweep already
does a widening `unknown` re-poll per candidate, so the marginal cost is
modest, but it is why the behaviour is config-gated rather than unconditional.

### The uniform policy this creates

`requireSettledChecks` is now enforced on **all three** `dependabot-pr-merge`
routes via `checksSettledPassing` — not just the webhook, where it was an
emergent property of `settledConclusion`. Two edges it must handle (background
in [00-current-behaviour.md](00-current-behaviour.md)):

- **`"none"` is not `"passing"`.** A repo with zero CI never fires the webhook,
  so only the cron sees it, where `mergeable_state: clean` is true. Hence
  `dependencies.minSettledChecks: 1` — an auto-merge decision requires at least
  one settled check; `0` restores today's behaviour for repos that genuinely
  have no CI.
- **Settled ≠ complete.** `getChecksConclusion` only sees checks that *exist*;
  a late-created check run is invisible at settle time. This is why
  `github_enable_auto_merge` stays the default action and direct merge the
  narrow exception — GitHub's own required-checks gate is the real backstop.

## Files

- `apps/server/src/engine/dispatcher.ts`
- `apps/server/src/index.ts`
- `apps/server/src/connectors/github-webhook.ts`
- `apps/server/src/cron/dependabot-discovery.ts`

## Tests

- `tests/engine/dispatcher.test.ts` — `pending` → skip for pr-merge; the
  enrichment keys (`headSha`, `checksState`, `checksSettledPassing`,
  `baseChecksState`) are present; fail-open on a read error is preserved.
- `tests/connectors/github-webhook.test.ts` — a bot-authored head on a
  non-dependency PR emits `pr.checks_failed`; a human-authored one still emits
  nothing; the settle gate still applies to both.
- `tests/cron/dependabot-discovery.test.ts` — a `clean` PR with failing checks
  is **not** discovered green when `requireSettledChecks` is on, and **is**
  when it is off.
- A cron-dispatch test asserting `ciSection` is now populated on the backstop
  path (the regression this phase fixes).

## Done when

- Webhook and cron dispatches of a `pr-fix`-shaped workflow carry identical
  context.
- `headSha` and the PR's real `baseBranch` reach the run.
- `pr-fix` is re-triggered when CI fails on a commit Last Light pushed.
- No route can reach an auto-merge decision on `pending` checks.
