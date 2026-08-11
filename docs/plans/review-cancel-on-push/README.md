# Cancel-on-push — implementation plan

Kill a PR-scoped run that a new push has made worthless, instead of letting it
finish and throwing the result away.

Today the run lock resolves a push-during-a-run the other way round: the
**new** event loses. `runLockDrop` (`src/engine/pr-decisions.ts:303`) drops it
with `run-in-flight: pr-review <runId> is already working this PR`, the
in-flight run reviews a tree that no longer exists, and `post-review`'s
`staleAgainstCurrentHead` (`src/workflows/handlers/post-review.ts:304`)
correctly refuses to post it. The review is suppressed; the tokens are not.
The 30-minute `check-prs-awaiting-review` sweep is the re-pickup.

So the gap is narrow and precise: **we already detect this, we just detect it
after paying for it.** This plan moves the detection to the moment the push
arrives.

## Evidence — and why this is robustness, not a cost fix

Measured on the `yo61` homelab instance (v0.25.5), 11 Aug 2026, over the
44 `pr-review` runs that completed that day ($10.00):

| Category | Runs | Cost |
|---|---:|---:|
| Superseded **mid-run** — what this plan would cancel | **0** | **$0.00** |
| Stale at dispatch | 0 | $0.00 |
| Reviewed the then-current head, finished before the next push | 44 | $10.00 |

That day looked like the worst case for it — eight PRs opened within 38
seconds by a scripted rollout, then force-pushed in bulk four to five times
over four hours, 3–6 reviews per PR — and **not one run was overtaken**.
Reviews took 1–10 minutes; the pushes were 20–50 minutes apart.

Method, so this can be re-run before anyone prioritises the work: take each
run's `context.prState.headSha` and window from `workflow_runs`, the head's
committer date from `GET /repos/{r}/commits/{sha}`, and every
`head_ref_force_pushed` event from `GET /repos/{r}/issues/{n}/timeline`; a run
is superseded when the first push strictly newer than its head lands before
`finished_at`. **Beware one trap**: the force-push event fires 5–10 s *after*
the committer date of the commit it delivers, so a naive comparison flags
every run as stale. Require a real gap (>60 s) or match the pair.

Conclusion: **build this for correctness under adverse timing, not to save
money.** Cost work belongs in draft PRs (65% of that day's review spend) or
`review.trigger: on-request`. If a cheaper motive is wanted, note that the
window scales with review duration — `gh-release-stats#20`'s 12:19 run took
606 s, and a repo whose reviews take 10+ minutes on a PR pushed every few
minutes is inside the window continuously.

## Locked decisions

**1. Opt-in per workflow, not per family.** `pr-review` only, declared in
YAML. The other three PR-scoped workflows must never be cancelled by default:

| Workflow | Interruptible? | Why |
|---|---|---|
| `pr-review` | **yes** | It only reads. Killing it loses tokens already spent and nothing else. |
| `pr-fix`, `dependabot-ci-fix` | no | May be mid-`github_publish`. A half-applied change set, a workspace holding the fix loop's verify gate and journal, and an attempt counter that already handles a head move (`headMoved` → fresh problem) — three reasons the cost of being wrong is unbounded. |
| `dependabot-pr-merge` | no | May be mid-merge or mid-`enable_auto_merge`. |

Follow `pr_scoped:`'s precedent exactly (`src/workflows/pr-scope.ts`): a
`cancel_on_push: true` key on the definition, derived and memoised on the
loader's asset version, so remapping `routes.github.pr_review` to a fork does
not silently inherit or lose the behaviour.

**2. Two guards, both required, and the second is the interesting one.**

- *The head actually moved.* Never cancel a run working the same commit —
  that is the run lock doing its job (two events, one SHA). Requires the
  in-flight run's head, which `runInFlight` does not carry today (see below).
- *The delta is MATERIAL* — `hasMaterialChange(changed, review.generatedPaths)`
  (`src/engine/pr-decisions.ts:772`), the same predicate
  `staleAgainstCurrentHead` uses.

The second guard exists because cancelling and re-dispatching are **not** one
action. The superseding push crosses the normal gate, and that gate may
legitimately decline it — a lockfile-only push is skipped by the generated-only
branch (`pr-decisions.ts:914`). Cancel without this guard and the PR gets **no
review of the material change**: the run that would have covered it was killed,
and its replacement was suppressed. This is `staleAgainstCurrentHead`'s own
reasoning read forwards —

> *"dropping a review is only acceptable when a replacement is guaranteed"*

— and it is the one part of this plan that must not be simplified away.

**3. Supersede, don't queue.** The cancelled run is not resumed, re-queued or
auto-retried. Its replacement is the ordinary dispatch of the superseding
event, subject to every existing gate. Consistent with the run lock's own
"dropped with a reason, not queued, because each dropped case has a cron
re-pickup".

**4. A `queued` run is dropped, not cancelled.** `activeForTrigger`
(`src/state/workflow-run-store.ts:418`) matches `queued | running | paused`. A
queued run has spent nothing, so superseding it is free and unconditional —
it does not need guard 2, because it never had a result to lose.
A `paused` run is out of scope: `pr-review` declares no approval gate, so the
opt-in set can never contain one. Assert this rather than handle it.

## Implementation

### Phase 1 — extract a reusable cancel

`POST /admin/api/workflow-runs/:id/cancel` (`src/admin/routes.ts:1652`) is the
only caller of `db.runs.cancelRun` today, and the surrounding 100 lines do the
work that actually matters: mark the run's open `executions` rows failed, kill
the sandbox containers/pods, reap the workspace, and let the run store's
`TerminalRunObserver` complete the `last-light/review` check run
(`src/engine/review-check.ts`). All of it is inline in the route.

Extract `cancelWorkflowRun(runId, { reason, actor })` — probably beside the
run store or in `src/engine/` — and have the admin route call it. A second
caller that reimplements even part of this will silently strand an
`in_progress` check run or leak a sandbox pod, which is precisely the class of
bug `review-check.ts` was rewritten to eliminate.

Keep the existing failure posture: an unreachable cluster or transport error
must never fail the cancel.

### Phase 2 — carry the in-flight head

`PrState.runInFlight` is `{ workflow, runId } | null`
(`src/engine/pr-state.ts:414`). Guard 1 needs the head that run is working.
`applyDerivedState` already holds the row — `activeForTrigger` returns a full
`WorkflowRun` and only its name and id are kept (`pr-state.ts:668`) — so this
is a widening, not a new query:

```ts
runInFlight: { workflow: string; runId: string; headSha: string | null } | null;
```

Read it the same way `assessedHeadShaByWorkflow` does:
`priorPrState(run.context)?.headSha`. `null` when absent (a pre-upgrade row) —
and `null` must mean **do not cancel**, the fail-safe direction.

### Phase 3 — decide

A pure function beside its siblings in `pr-decisions.ts`, returning the same
`{ decision, reason, inputs }` shape so the log line, the run row and the
admin panel stay three renderings of one source:

```ts
export function resolveSupersede(
  state: PrState,
  cfg: ReviewConfig,
  opts: { cancellable: boolean; materialDelta: boolean | null },
): Decision<"supersede" | "keep">
```

`materialDelta` is `null` when the path comparison was degraded or truncated —
and `null` keeps the run, matching every other fail-open read in this file.

Call it in `applyPrDispatchGate` (`src/engine/dispatcher.ts:527`) — the one
choke point all three routes cross (dispatcher, `src/index.ts:497`, the admin
retry at `routes.ts:2701`) — **immediately before** `runLockDrop` would fire.
On `supersede`: cancel, then fall through to the normal gate so the new event
is evaluated on its merits. On `keep`: today's behaviour, unchanged.

The extra `getChangedPathsBetween` call costs one API request and only on the
path where a run is genuinely in flight at a different head — rare by
construction, per the evidence above.

### Phase 4 — config

```yaml
review:
  cancelOnPush: true    # supersede an in-flight review when a material push lands
```

Repo-clamped **add-only `true`**, beside `skipDraft` / `postsCheck` in
`sanitizeReview` (`packages/shared/src/repo-config-schema.ts:1116`): turning it
on spends less of the operator's budget and is the conservative direction;
turning it off when the operator has it on is the thing a repo may not do.

Default: propose `true`. Guard 2 makes it safe, and the failure mode it
prevents (a posted review of dead code) is worse than the one it introduces (a
review dropped a few minutes early, whose replacement is guaranteed). Flag it
as the operator's call at review time.

### Phase 5 — observability

- Log the cancel at `info` with `component: "dispatch"`, both SHAs and the
  superseding run's id.
- Persist the reason on the cancelled row so the dashboard reads
  `superseded by <sha>` rather than a bare `cancelled` — a manual cancel and
  an automatic supersede must not look identical in the run list.
- The check run resolves itself through `TerminalRunObserver`. Verify, don't
  assume: this is exactly what Phase 1's extraction is protecting.

## Non-goals

- Cancelling anything outside the opt-in set.
- Cancelling on events that cannot change the head (`labeled`, comments,
  `check_suite`, `ready_for_review`).
- A queue, a resume, or an automatic retry of the cancelled run.
- Any change to `staleAgainstCurrentHead`. It stays as the backstop for the
  case this plan cannot catch — a push that lands after the review phase has
  finished but before `post-review` posts.

## Testing

- Table tests on `resolveSupersede`: same head; different head + material;
  different head + generated-only; `materialDelta: null`; `headSha: null`;
  non-cancellable workflow; queued vs running. No GitHub mock, no sandbox —
  the point of keeping the decision pure.
- `pr-scope`-style test that `cancel_on_push` is read off the definition and
  that the fix family does **not** carry it.
- One integration test that a cancel completes the `last-light/review` check
  and marks the open execution rows failed — the regression this is most
  likely to reintroduce.
- Re-run the evidence query above after a week and record the hit count. If it
  stays zero on real traffic, that is a finding worth writing down, not a
  reason to have skipped the work.

## Open questions

1. Should a superseded run's spend still count toward a PR's cumulative cost?
   Irrelevant for `pr-review` (no budget) but decides the shape if the opt-in
   set ever widens.
2. Is one `getChangedPathsBetween` on the supersede path worth it, versus
   cancelling on any head move? The evidence says the call is rare; the guard
   it powers is the one that keeps a material change from going unreviewed.
   Recommend keeping it.
