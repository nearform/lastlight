# Stuck-PR recovery — implementation plan index

Make a stuck pull request **recoverable by a maintainer**, and make it get
stuck far less often in the first place.

Two independent problems, filed together because the first one is why you
need the second and the second is what makes the first survivable:

1. **A fix run merges a stale base.** The base branch a fix phase merges is
   whatever was fetched when the run's *first* phase provisioned its
   workspace — minutes or tens of minutes earlier. On a repo where
   Renovate lands several bumps a day, the fix resolves yesterday's
   conflict and leaves today's, so the PR stays `dirty`. GitHub then
   refuses to build `refs/pull/N/merge`, no CI runs at all, and the
   harness reads `checksState: "passing"` off whatever commit-status app
   is left. See [01-base-freshness.md](01-base-freshness.md).
2. **The only way to re-arm an escalated PR is a non-bot push.** Three
   things a maintainer would naturally try — commenting, removing the
   label, pushing an empty commit — exactly one works, and two of the
   three post a duplicate escalation comment. See
   [03-retry-intervention.md](03-retry-intervention.md).

This directory is the executable plan. Each phase doc is self-sufficient:
an agent with no prior context should be able to execute its phase from
that doc plus this README alone.

> This plan answers **open question 9** of
> [dependency-pr-resilience](../dependency-pr-resilience/README.md):
> *"`requires-human` is an overloaded terminal flag … a proper fix
> deserves its own issue."* It is that issue. It also revises
> [09-state-machine.md](../dependency-pr-resilience/09-state-machine.md)
> §S1's escalation exits — read that doc first; this plan assumes it.

## The case that produced this plan

`cliftonc/drizzle-cube#1016` (`chore(deps): update dependency typescript to
v7`), 1 Aug 2026. Worth reading once, because every phase below traces to
one step of it.

| Time (UTC) | What happened |
|---|---|
| 06:49 | Maintainer asks the bot to merge the PR. It replies: conflicts with `main`. |
| 09:52 | `fix-red-dependency-prs` dispatches `dependabot-ci-fix` with `reason=dirty`. Workspace provisioned; `origin/main` = `449996d3` (main as of 02:05). |
| 09:52–09:58 | `diagnose` runs for 356 s on a `dirty` PR — a CI-failure taxonomy applied to a merge conflict — and answers `class=reproducible`, `cause=earlier CI jobs failed on older commits but are green now`. |
| 10:00:03 | `5dd5fd26` lands on `main` (a lockfile-touching dep bump). |
| 10:08 | `fix_iter_1` merges the **stale** `origin/main`. Merge commit `921c375c`'s second parent is `449996d3`, not `5dd5fd26`. |
| 10:22 | `fix_iter_2` pushes `356b06c`. Run cost ≈ $3.22; cumulative on the PR $6.66. |
| — | PR is `ahead 5, behind 1` and still `dirty`. GitHub will not build the merge ref, so **no CI workflow runs**. Only GitGuardian reports. `settledCheckCount` drops 11 → 1 and `checksState` reads `passing`. |
| 15:01 | The daily sweep re-discovers it. Dispatch gate: `$6.66 ≥ $5.00` → `budget-exhausted`, `requires-human`, comment. Run duration: 0 s. |

The `diagnose`-on-`dirty` waste was fixed the same day by `7cb77b5`
(`skip_if: reason == 'dirty'`), which landed at 11:47 UTC — two hours after
this run. Nothing else in the trace is fixed.

## Locked decisions

Settled in a design interview on 2 Aug 2026. Recorded here because several
were decided against the recommendation, and the reasoning matters more
than the outcome.

| # | Decision | Why |
|---|---|---|
| 1 | `fix.maxCostUsd` is a **futility guard**, not a spend guard | It is scoped to a *problem* and re-armed by a push, which is futility logic. A real spend cap belongs at server level and does not exist yet — see [Deferred](#deferred) |
| 2 | A **dedicated hold label** blocks Last Light; `requires-human` becomes a pure notification | A label is a live precondition needing no record, no inference and no conflict rule. It also removes the *only* place `requires-human` is read as a decision input (`pr-state.ts:619`) |
| 3 | The hold **blocks every workflow on any subject** carrying it — PRs and issues alike | A label nobody can remember the scope of is a label nobody reaches for. One word, one meaning |
| 4 | The hold **beats an explicit request**; the bot replies once saying why | Otherwise it is not a block |
| 5 | **No per-person authorization anywhere.** `by` is recorded for display and no decision function reads it | Same rule `PrNote` already lives under. Capability (`author_association`) is checked; identity never is |
| 6 | **Last one wins** — no precedence rules, no ownership | Decided explicitly. Dissolves every multi-maintainer conflict case |
| 7 | A retry does **exactly what a push does**: `attempt` → 1, cost baseline re-stamped, guard cleared | One predicate (`sameProblem`) decides everything. A second budget shape is how the old six-sites-disagreeing situation started |
| 8 | …with one asymmetry: **a retry keeps the journal, a push wipes it** | A push changed the code, so prior findings may be stale. A retry changed nothing but patience — discarding `priorAttempts` sends attempt 1 of the new window down attempt 1 of the old window's road |
| 9 | **Unbounded retries, full window each time** | Backstop is the server-level spend cap, not a hidden second budget |
| 10 | Model escalation moves from `attempt` to **`priorAttempts.length`** | Otherwise a retry silently downgrades the model on a PR that has already failed three times |
| 11 | Ship order: **comment + label-removal first, CLI alongside, dashboard later** | The first two are not features. They are the two doors maintainers already walk into, and both currently misfire |

## Phases

Execute in order. Phase 1 is independent of 2–4 and is the highest-value
change in the plan — it reduces how often anything below is needed.

- [x] **Phase 1** — [01-base-freshness.md](01-base-freshness.md) — refresh
  the base ref before a fix phase merges it *(risk: low — ~3 lines plus
  tests, reusing already-tested code)*
- [x] **Phase 2** — [02-hold-label.md](02-hold-label.md) — the hold label,
  and demoting `requires-human` to a pure notification *(risk: low —
  removes an inference rather than adding one)*
- [x] **Phase 3** — [03-retry-intervention.md](03-retry-intervention.md) —
  `PrState.intervention`, the `sameProblem` clause, and the three retry
  surfaces *(risk: medium — touches the predicate everything hangs off)*
- [x] **Phase 4** — [04-corrections.md](04-corrections.md) — the duplicate
  comment, the escalation comment's false promise, four stale doc comments
  and one dead branch *(risk: none — mostly prose)*

## Execution notes (2 Aug 2026)

All four phases landed together, plus three things the plan did not
anticipate:

- **The k8s backend had Phase 1's defect too.** `init-clone.ts`'s
  `CLONE_SCRIPT` mirrors `prePopulateWorkspace`, including the same-run
  early exit before `ensure_base`. Fixed alongside.
- **`sameProblem` had three readers, not two.** `deriveNotes` was added
  later by `10-pr-memory`. Applying the `retriedSince` clause verbatim
  would have marked the whole journal stale on a retry — the opposite of
  decision 8. `headMoved` was split out and given to staleness; budgets
  keep `sameProblem`.
- **The standalone `retry-requested` row swallowed its own ask.** Written
  `succeeded` at the current head, it repopulated
  `assessedHeadShaByWorkflow`, so the next cold resolve skipped with
  `already-assessed` — budgets re-armed, request refused. Both candidate
  fixes in Phase 3 were needed, each in the form that is actually true:
  ledger rows are not evidence of assessment, and a pending ask un-assesses
  the head until a run that saw it spends an attempt.

`fix.maxCostUsd` is now re-armable without bound (decision 9), so the
**server-level spend cap listed under [Deferred](#deferred) is live debt,
not an enhancement.**

Phase 4's `escalatePr` dedup is a genuine safety net for Phase 3 and should
not be deferred past it. The rest of Phase 4 can land at any point.

## What is deliberately not in this plan

- **Slack digest of escalated PRs.** ~~Blocked on per-repo/per-team channel
  routing, which does not exist: `slack.deliveryChannel` is a single
  channel.~~ **SHIPPED**, as part of the weekly repo digest
  (`workflows/cron-digest.yaml`, `src/cron/repo-digest.ts`): per-repo channel
  routing now exists (`notifications.slack.channel` in a repo's `.lastlight/`,
  the operator's `slack.repoChannels` map, then `slack.deliveryChannel`), and
  the digest reports the escalated set. Note it does NOT read it back out of
  the sweep — `fanOut` still returns only `{dispatched, failures}` and a skip
  still counts as a success. It asks GitHub for the open PRs carrying
  `requires-human`, which is the same set and is true regardless of which
  route escalated them. Per-TEAM routing remains unbuilt.
- **A dashboard view of escalated PRs.** `prState` appears nowhere in
  `admin/routes.ts`; there is no PR surface at all today. When it comes it
  should be the *list* — what is stuck, why, what was tried, what it cost —
  not a button bolted to a run detail panel.
- **A server-level spend cap.** Decision 9 makes this load-bearing: with
  unbounded full-window retries there is no other backstop. It is the one
  deferred item that is a prerequisite for something in this plan rather
  than an enhancement to it.

## Deferred

| Item | Blocked on | Note |
|---|---|---|
| ~~Slack digest~~ | — | **Shipped**: `cron-digest.yaml` + per-repo `notifications.slack.channel` |
| Per-team channel routing | the `github_teams` cache + a policy for team-scoped content | Per-repo covers the original ask |
| Dashboard escalated-PR list | a PR surface in the admin API | Build the list, not a button |
| Server-level spend cap | nothing — just unbuilt | Becomes the only backstop once Phase 3 ships |

## Cost posture

Phase 1 *saves* money: every avoided stale-base merge is a fix cycle
(≈ $3 on `drizzle-cube`) that does not need to happen. Phase 3 spends
money, by design — an unbounded full window means a maintainer can
authorise up to `fix.maxAttempts × cost-per-attempt` with one comment, as
often as they like. That is the accepted trade for decision 1, and the
reason the server-level cap is listed as a prerequisite rather than a
nice-to-have.
