# Execution outcome classification — implementation plan

Stop the dashboard reading `executions.success` as a health signal. It is not
one, and the chart currently paints a wall of red on a day when nothing failed.

> **Status: implemented** by [#328](https://github.com/nearform/lastlight/pull/328)
> (`ed853075`, 12 Aug 2026), which landed before this doc did.
> [#325](https://github.com/nearform/lastlight/issues/325) is still open — the
> PR carried no closing keyword.
>
> This is the design record, not outstanding work. The body below is kept as
> written, so its line numbers are as of plan time; [What
> landed](#what-landed) names the shipped code by symbol and records the two
> places execution diverged from this plan.

## The evidence

A homelab instance running v0.25.5, 11 Aug 2026, whole day:

```
423 executions = 172 green + 251 RED

  stop_reason = 'skipped'       131   $0.000   "skipped: trigger rule not satisfied"
  stop_reason = 'error_quota'   120   $0.000   "pod create rejected by ResourceQuota"
  ────────────────────────────────────────────
  actual failures                 0
```

59% of the bar is red and **none of it is a failure**. Over the preceding seven
days, 4 `error_sandbox` rows and 4 with a null stop reason are the only
arguably-real entries out of 307 red.

The two populations compound, which is why one bad hour looks catastrophic: a
quota rejection fails the `review` phase, the DAG cascade then skips
`post-review`, so **each retry writes two red rows** roughly 15 s apart. A
single saturation episode on `lastlight-sandboxes` renders as a 150-tall red
column.

## Why both are `success = 0` — deliberately, and it must stay that way

This is the crux, and it is why the fix belongs in the reader.

**Skips.** `recordSkippedPhase` (`src/state/execution-store.ts:326`) writes
`success = 0` on purpose, and says why:

> *"Because it is not `success = 1`, `shouldRunPhase` re-evaluates it on resume
> (the node will simply be re-skipped if the upstream is still failed)."*

**Quota rejections.** `src/workflows/runner.ts:471` is equally explicit:

> *"the engine treats `error_quota` as an ordinary phase failure and requeue"*

Flip either to `success = 1` and you break resume or backpressure respectively.

So `executions.success` already answers its question correctly. Its question is
**"may this phase be skipped on resume?"** — for which *skipped*, *quota-rejected*
and *crashed* are all legitimately the same answer. What it has never answered
is "did something go wrong", and the chart is the consumer that assumed it did.

`src/workflows/CLAUDE.md` even names the mismatch from the other side, calling
these rows "a *non-failing* skip in the `executions` ledger" — non-failing in
the ledger's own vocabulary, red in the chart's.

## Design

Derive an outcome from `(success, stop_reason)`, **once, in the store**:

```ts
export type ExecutionOutcome = "succeeded" | "skipped" | "deferred" | "failed";
```

| condition | outcome | rationale |
|---|---|---|
| `success = 1` | `succeeded` | — |
| `success = 0`, `stop_reason = 'skipped'` | `skipped` | the runner's own contract calls it non-failing |
| `success = 0`, `stop_reason = 'error_quota'` | `deferred` | capacity, not error: $0, 0 turns, requeued automatically |
| `success = 0`, otherwise | `failed` | the real thing |
| `success IS NULL` | in flight | already in neither bar; unchanged |

### Alternatives rejected

- **An `outcome` column + migration.** `success` still has to answer the resume
  question, so a second column duplicates state that can drift apart. A
  derivation cannot drift.
- **Filtering in the chart component.** There are three readers
  (`hourlyStats`, `dailyStats`, `executionStats().by_skill.fail`) and they would
  disagree the first time one is edited. Deriving in one place is the same
  argument `PrState` makes against six sites each fetching an overlapping
  subset.

### Where it lands

- **`dailyStats` / `hourlyStats`** (`execution-store.ts:826`, `:895`): return
  `succeeded | skipped | deferred | failed` counts in place of
  `successes | failures`.
- **`executionStats().by_skill`** (`:786`): same reclassification for `fail`.
- **`dashboard/src/components/HomePage.tsx`**: four stacked `<Bar>`s —
  `CHART.success` for succeeded, `CHART.accent` (amber) for deferred,
  `CHART.error` for failed, and a muted tone for skipped.

For that muted tone there is an exact precedent to reuse rather than invent:
the generic-loop `until_bash` check that runs and comes back red is already
rendered "neither green nor red" (`dashboard/src/components/pipeline-node.tsx:16`,
the `unmet` status). Borrow the tone, not the classification. In the ledger the
two are opposites: `condition_not_met` is stored `success = 1`, so it lands in
`succeeded` and really cost tokens, while `skipped` is `success = 0`, $0, and
never ran. What they share is only that neither is a failure — which is an
argument about visual weight, not about the data model.

Consider dropping `skipped` from the bar entirely and surfacing it in the
tooltip only: it is the *consequence* of another row's outcome, so stacking it
double-counts one incident visually. Recommend tooltip-only; flag as the
reviewer's call.

### Migration

None. The classification is derived at query time, so history reclassifies for
free. Note in the release notes that the red in existing screenshots will drop
sharply — that is the fix landing, not data loss.

## Non-goals

- Changing `executions.success`. It is load-bearing for `shouldRunPhase`.
- Changing what the runner or the store records.
- Hiding `error_quota`. It is a real signal — *"you are saturating the sandbox
  namespace and runs are queueing"* — and deserves its own colour, not
  suppression. Today it is indistinguishable from an agent crash.

## Related, but a separate issue

`consecutiveFailures(skill)` (`execution-store.ts:669`) reads the same column
and is the cron scheduler's alerting input — called as
`consecutiveFailures(job.workflow)` (`src/cron/scheduler.ts:64`) with a **bare
workflow name**, while every execution row in the instance DB inspected for this
plan carries `"<workflow>:<phase>"` (1,600+ rows, zero bare). The predicate can
therefore never match, `failures` is always `0`, and the alert at `:66` is
unreachable.

Structurally the same wrong-key bug as the pre-`PrState`
`isRunning(handler, triggerId)` guard, which "never matched a row — wrong key on
both predicates". Recorded here so this work does not silently inherit it; it
wants its own issue, because fixing the key without fixing the classification
would arm an alert that then fires on skips and quota deferrals.

## Testing

- Table test the classifier across the whole `(success, stop_reason)` matrix,
  including `NULL` on both.
- A store test that a `recordSkippedPhase` row classifies as `skipped` **and is
  still re-run by `shouldRunPhase`** — the invariant that must not regress, and
  the one a careless "just set success = 1" fix would break.
- A test pinning the four chart series, so a future edit cannot quietly fold
  `deferred` back into `failed`.
- Re-run the evidence query after the change and confirm the instance's red
  column goes to zero on a day with no real failures.

## What landed

### The classifier, as designed

`EXECUTION_OUTCOME_COLUMNS` (`src/state/execution-store.ts:220`) is the
`(success, stop_reason)` matrix above as one SQL fragment, interpolated into
all three readers — `executionStats()` (`:838`), `dailyStats` (`:883`) and
`hourlyStats` (`:946`) — so they cannot drift. Derived at query time; no
migration.

### Divergence 1 — `skipped` is in the bar, as a hatch

This doc recommended dropping it to the tooltip and flagged the call as the
reviewer's. It shipped **in** the stack instead, and the reason is recorded at
`HomePage.tsx:747`: the four bands have to total the "Executions" headline
above the chart, and `skipped` is 31% of rows on a busy day, so hiding it would
make the two disagree visibly.

Keeping it forced the other half of the decision. Hue could not carry a band
that is not an outcome — `skipped` measured ΔE 15.9 against the green, over the
floor but still visibly similar — so it is drawn as a 45° hatch (`ll-skip-hatch`,
`:720`): texture is a different channel, so it survives colour blindness, print
and `forced-colors`, and it reads as "placeholder", which is what a skip is.

### Divergence 2 — the colours were not this chart's to choose

The plan named `CHART.success` / `CHART.accent` (amber) / `CHART.error`. The
four outcomes instead map onto the shared `STATUS` palette (`OUTCOME`,
`HomePage.tsx:41`, from `dashboard/src/lib/status-colors.ts`), landed by
[#330](https://github.com/nearform/lastlight/pull/330) so that "good" means the
same green here as on the feedback page. `deferred` is `STATUS.info` (blue),
not amber — which also dissolved a constraint this plan never saw: amber sat
ΔE 2.8 from red, so the stack order had to keep the neutral between them.
Blue let the order become semantic — nothing wrong → nothing happened → load →
bad — leaving deferred↔failed (ΔE 19.0) as the only solid-to-solid boundary,
against 13.5 before.

The `unmet` tone this doc pointed at was a precedent for visual weight only, as
the paragraph above says. It survives as `STATUS.neutral` tinting the hatch,
but the hatch is what does the separating.

### The sibling bug

Filed as [#327](https://github.com/nearform/lastlight/issues/327) and still
open. `consecutiveFailures` has moved to `execution-store.ts:721`; the caller
at `src/cron/scheduler.ts:64` still passes the bare workflow name.
