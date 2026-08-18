# Phase 4 — Bounded, diagnosis-gated retries (#251)

> **Superseded in part by [09-state-machine.md](09-state-machine.md) §S1.**
> §4.1's reset rule and §4.3's escalation table are both replaced — the table's
> `upstream-broken` row latches a PR permanently dead (09 → D1), and the reset
> never fires for `pr-fix`. Also changed: `flaky` short-circuits before the
> `fix` phase and is capped; a crashed run never consumes an attempt; state keys
> on (`PR_FIX_SHAPED_WORKFLOWS`, PR); `maxCostUsd` ships at `5.0`, on.

**Risk: medium** — `generic_loop` + `until_bash` has no production consumer
yet. Depends on Phases 2 and 3.

Two nested loops:

- **Outer, cross-run** — driven by real CI. Attempt N+1 happens when the
  `pr.checks_failed` webhook fires again after our push. Bounded by
  `fix.maxAttempts` and gated by the diagnosis class.
- **Inner, within-run** — the agent iterates locally against the repo's own
  build/test gate so it never pushes a fix that fails that gate.

## 4.1 — The attempt counter

Derived at dispatch from the previous run. **No new table, no migration.**

Add to `apps/server/src/state/workflow-run-store.ts`:

```ts
latestForTrigger(workflowName: string, triggerId: string): WorkflowRun | null
```

— a near-copy of the existing `latestSucceededForTrigger` (L208) without the
status filter (a *failed* attempt still counts).

Then, at dispatch:

```
attempt = (prior?.context.attempt ?? 0) + 1
```

written onto the new run's `context`.

**Not incremented** when the prior run's diagnosis class was `flaky` — a
network blip must not consume the budget.

**Reset to 1** when the PR's head commit was authored by the dependency bot
rather than by us — Dependabot rebased, recreated, or pushed a newer bump, so
this is a fresh problem. The connector already reads the head-commit author for
its dependency gate; compare against `botLogin` (`<botName>[bot]`). A PR that
goes green resets naturally, since ci-fix stops being triggered.

### Why not a label or a new column

- **A label** (`lastlight/attempt-2`) is visible but noisy on the PR, and
  mutating it is another write per run.
- **A column** needs a migration for something derivable.
- **Counting bot commits on the PR** self-resets elegantly but misses attempts
  that failed without pushing — exactly the attempts we most need to bound.

Deriving from the prior run's `context` reuses machinery that already exists
(`latestSucceededForTrigger` reads prior-run `context` today) and is correct
for no-push attempts.

## 4.2 — Cross-attempt memory

The per-PR workspace is reused (`PER_TARGET_REUSE_WORKFLOWS` covers both fix
workflows) but is `reset --hard`-ed between runs, and `{{phaseOutputs}}` is
empty across a run boundary. So cross-attempt state must be **small and
persisted**.

Harvest the `DIAGNOSIS_COMPLETE` and `CI_FIX_COMPLETE` marker lines (Phase 2)
in the existing `RunnerCallbacks.onPhaseEnd` hook wired in
`apps/server/src/index.ts`, and `db.runs.mergeScratch` them onto the run. No
engine change — `onPhaseEnd` already receives the phase result.

At dispatch, walk back through prior runs via `latestForTrigger` and render
their marker lines as `{{priorAttempts}}`:

```
attempt 1: class=reproducible cause=lockfile stale vs package.json | outcome=pushed gate=green
attempt 2: class=env-mismatch cause=CI runs node 22, sandbox node 20 | outcome=pushed gate=green
```

One line per attempt, not a transcript. Attempt 3 therefore knows what was
tried and what was ruled out.

## 4.3 — Escalation policy

All decided **at dispatch, before a sandbox is provisioned** — that is what
makes the cost saving real.

| Condition | Action |
|---|---|
| `attempt > fix.maxAttempts` | Do not dispatch. Apply `requires-human`; post **one** comment naming which escalation case this is, the attempt count, and each attempt's `class=` + `cause=`. |
| Prior class `infra-dependent` | Escalate immediately — do not spend the remaining attempts. |
| Prior class `upstream-broken` | **Skip without labelling.** Not this PR's fault; it self-heals when the base goes green and the cron retries. |
| Prior class `flaky` | Dispatch, but do not increment the counter. |
| `fix.maxCostUsd` exceeded | Escalate as at `maxAttempts`. |

The `upstream-broken` carve-out matters beyond cost: it is the first case where
we *stop* poisoning `requires-human` with a condition that will resolve itself.

### Cost enforcement without an engine change

The engine cannot see spend — `ExecutionLedger` exposes no cost read (see
[00-current-behaviour.md](00-current-behaviour.md) → engine gap 3). Rather than
add a port method and an in-loop check, sum `executions.cost_usd` for prior
runs of (workflow, `owner/repo#N`) via a new `ExecutionStore` query and compare
against `fix.maxCostUsd` at dispatch. Same outcome, far smaller change.

## 4.4 — Model escalation

`resolveModelVariant` (`packages/workflow-engine/src/core/phase-executor.ts:504`)
renders `model:` templates against `run.ctx` **only** — `iteration` /
`fixCycle` are deliberately out of scope — so `{{attempt}}` inside a `model:`
template cannot work without an engine change.

Cheapest correct route, in `apps/server/src/workflows/simple.ts`: when
`attempt > fix.escalateModelAfterAttempt` **and** the effective model map has a
`pr-fix-retry` key, substitute `models["pr-fix"] = models["pr-fix-retry"]` for
that run.

- No engine change, no YAML change.
- Composes with the per-repo `models` override from #180 for free — the map is
  already the merged `base ⊕ repo` one.
- Operators who set no `pr-fix-retry` key get today's behaviour exactly.

Also seed `{{attempt}}` and `{{maxAttempts}}` onto `ctx` (free —
`TemplateContext` has an index signature and `request.extra` already flows into
`ctx`) so the prompt can say *"this is attempt 2 of 3; attempt 1 tried X."*

## 4.5 — The within-run local gate loop

Give the `fix` phase a `generic_loop`. **No engine change needed** —
`GenericLoopSchema` already has `max_iterations` + `until_bash`, and
`runUntilBash` (`phase-executor.ts:753`) runs the command *inside the sandbox*
against the persisted workspace, exit 0 ending the loop.

```yaml
  - name: fix
    label: Fix
    prompt: prompts/pr-fix.md          # / prompts/dependabot-ci-fix.md
    skills: [fixing, building]
    model: "{{models.pr-fix}}"
    timeout_seconds: 900               # see the trap below
    on_output:
      requires_marker: "CI_FIX_COMPLETE"
    generic_loop:
      max_iterations: 2                # {{fix.localIterations}}
      until_bash: "sh ../.lastlight-verify.sh"
      fresh_context: false             # iteration 2 sees {{previousOutput}}
```

The gate command is **not statically knowable** — the package manager is
detected from the lockfile at runtime, and the right command is whatever CI
runs. So the `fixing` skill instructs the agent to write the exact gate command
**it derived from the CI workflow file** into `../.lastlight-verify.sh` at the
workspace root — a sibling of the checkout, structurally outside the git tree,
the same placement the skill bundle already uses. Iteration 1 with no script
yet exits non-zero and simply loops.

Push only on a green local gate. If still red at
`{{iteration}} == {{maxIterations}}`, emit `outcome=gave-up` and let
dispatch-time escalation own the `requires-human` decision — **do not push a
speculative fix.**

### Two traps to respect

1. **`timeout_seconds` is load-bearing, not cosmetic.** `runUntilBash` passes
   `timeoutSeconds: phase.timeout_seconds ?? 30`. Thirty seconds will kill any
   real test suite mid-run and report a false red.
2. **The engine only retries *soft* outcomes.** `isSoftOutcome` is stop reason
   `unknown` / `error_truncated`; a hard agent crash still fails the phase.
   That is **acceptable** — the crash surfaces as a failed run and the
   cross-run counter picks it up on the next webhook. **Do not add
   hard-failure retry to the engine as part of this work**; it is a much larger
   change with much wider blast radius.

## Files

| File | Change |
|---|---|
| `apps/server/src/state/workflow-run-store.ts` | `latestForTrigger` |
| `apps/server/src/state/execution-store.ts` | cumulative cost query for a trigger |
| `apps/server/src/index.ts` | attempt derivation, escalation, marker harvest in `onPhaseEnd` |
| `apps/server/src/workflows/simple.ts` | `pr-fix-retry` model substitution; seed `attempt`/`maxAttempts`/`priorAttempts` onto `ctx` |
| `apps/server/workflows/{pr-fix,dependabot-ci-fix}.yaml` | `generic_loop` + `timeout_seconds` + marker on `fix` |
| `apps/server/workflows/prompts/{pr-fix,dependabot-ci-fix}.md` | attempt awareness, push discipline, the verify script |

## Tests

New `apps/server/tests/workflows/pr-fix-attempts.test.ts`:

- counter increments across runs; resets on a bot-authored head; does **not**
  increment after a `flaky` class;
- escalation fires at `maxAttempts`, immediately on `infra-dependent`, and
  skips-without-labelling on `upstream-broken`;
- the cost cap escalates;
- `pr-fix-retry` substitution fires only above the threshold, and not at all
  when the key is unset;
- `{{priorAttempts}}` renders prior marker lines.

Use `packages/workflow-engine/src/test-support/fakes.ts` — `FakeAgentPort`
scripts an `ExecutionResult` queue, which is exactly the shape needed to assert
attempt counts and per-attempt models.

New sandbox integration test alongside
`apps/server/tests/sandbox/command-exec.integration.test.ts` covering
`generic_loop` + `until_bash`: a script that fails then passes must produce two
iterations, and the phase-level `timeout_seconds` must be honoured. This is the
one genuinely new production runtime path.

## Done when

- A red dependency PR is attempted at most `fix.maxAttempts` times, with each
  attempt seeing what the previous ones tried.
- Non-retryable classes escalate on attempt 1 rather than 3.
- No fix is pushed that fails the repo's own gate locally.
- `pr-fix` gets the same treatment as `dependabot-ci-fix`.
