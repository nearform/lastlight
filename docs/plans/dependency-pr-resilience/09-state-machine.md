# Phase 3′ — The PR state machine (normative)

**Read this with [00-current-behaviour.md](00-current-behaviour.md) before
executing any phase.** It supersedes parts of Phases 3, 4, 5, 7 and 8, and it is
the record of a design review that found the original plan's state handling
incoherent in ways that would have shipped real defects.

The plan's other documents describe *what to build*. This one describes *what
the system knows about a pull request, where that knowledge lives, and who is
allowed to read it*. Every decision below was reached by walking a concrete
failure sequence, not by preference.

## The finding

Seventeen questions into a design review, every answer resolved the same way:
**read it live, read it once, key it on the PR**. That is not a coincidence —
it is the shape of the defect. The original plan spread reads of PR state across
six sites (`dependencyDedupSkip`, `enrichPrFixContext`, `dispatchWorkflow`,
`resolveReviewTrigger`, `discoverGreenDependencyPrs`, `discoverRedDependencyPrs`),
each fetching an overlapping subset and each free to disagree — the same failure
mode [07-review-triggers.md](07-review-triggers.md) §7.4 identifies for the
trigger surface ("spread across **four** places, and only one is config-aware"),
generalised to the whole plan.

Meanwhile the state itself was scattered across seven stores: GitHub labels (six
of them after Phase 5), the `last-light/review` check run, run `context`, run
`scratch` markers, execution status, live GitHub reads, and a file in the
sandbox workspace.

Three concrete defects fell out of that, each of which would have shipped:

- **`upstream-broken` latched a PR dead forever** (§D1) — a skip path that
  writes no run row, gated on a verdict read from the last run row.
- **Phase 3.4 routed human PRs into `dependabot-ci-fix`** (§D5) — because
  `pr-fix.yaml` has no `classification:` block and so can never be selected by
  `fallbackWorkflowForIntent`.
- **Auto-merge was credited with a safety guarantee it does not have on
  unprotected repos** (§D10), for **major** version bumps.

None of them are hard to fix. All three are invisible unless you write the state
machine down.

## The reframe — one resolved snapshot

Phase 3 stops being "add four enrichment fields to the dispatch context" and
becomes "**resolve the PR's state once, then decide**".

```ts
resolvePrState(owner, repo, prNumber, deps): Promise<PrState>
```

```ts
interface PrState {
  // ── live from GitHub ───────────────────────────────────────────────────
  headSha: string;
  headAuthor: string;          // git author name; `git-auth.ts:87` sets ours to botLogin
  baseRef: string;             // the PR's real base, not getDefaultBranch()
  isDraft: boolean;
  isFork: boolean;
  labels: string[];
  checksState: "passing" | "failing" | "pending" | "none";
  settledCheckCount: number;
  baseChecksState: "passing" | "failing" | "pending" | "none";
  botReviewAtHead: { state: string } | null;

  // ── derived from our own history, keyed on the PR ──────────────────────
  attempt: number;
  flakyDeferrals: number;
  escalatedAtSha: string | null;
  escalatedBy: "us" | "human" | null;
  priorAttempts: string[];     // one marker line per attempt
  cumulativeCostUsd: number;
  runInFlight: { workflow: string; runId: string } | null;
}
```

Computed **once**, at `dispatchWorkflow` — the choke point
[03-signals.md](03-signals.md) §3.3 already identifies as the single place both
the webhook and cron routes pass through, and where `resolveRepoRunConfig`
already runs. Every decision in this plan then becomes a **pure function over
it**, with no I/O:

| Function | Replaces |
|---|---|
| `mayMerge(state, cfg)` | the prompt's `mergeable_state` heuristic; `discoverGreenDependencyPrs`'s `clean` filter; §5.5's direct-merge gate |
| `resolveReviewTrigger(state, cfg)` | §7.4's four enforcement points; §7.4c's dedup preflight; `review-discovery.ts`'s draft filter |
| `resolveFixDisposition(state, cfg)` | `dependencyDedupSkip`; §4.3's escalation table |
| `renderContext(state)` | `enrichPrFixContext`; everything the prompts render |

Each returns **`{ decision, reason, inputs }`**, never a bare enum. The reason
string is produced by the decision function and rendered in three places — the
log line, the escalation comment ([04-retry.md](04-retry.md) §4.3 requires one
that "names which escalation case this is"), and the admin detail panel (§S3).
One source, three renderings, instead of three prose variants that drift.

Three things follow:

1. **The `PrState` type is the documentation of the state machine.** It can be
   read, reviewed and diffed. Prose across ten documents cannot.
2. **The cron discoverers stop holding policy.** They find candidates; the
   resolver decides. That deletes the divergence between the cron's `clean`
   filter and the webhook's settle logic which [00-current-behaviour.md](00-current-behaviour.md)
   identifies as the root of the documented "direct merge lands a red PR" hazard.
3. **Most of [06-config.md](06-config.md) §6.5's verification becomes a table
   test** over literal `PrState` fixtures — no GitHub mock, no sandbox. Only the
   genuinely agentic parts need the harness.

## S1 — The fix state machine

### Identity

Fix state is keyed on **(`PR_FIX_SHAPED_WORKFLOWS`, PR)**, not on
(workflow, PR). "How many times have we tried to fix this PR, and what did we
try" is a fact about the pull request; which workflow ran is an implementation
detail of how the event arrived.

This matters because routing varies: `dependabot-ci-fix`'s own
`classification.description` says *"Also choose it when a maintainer's comment
asks the bot to handle/look at/fix such a PR"*, so an `@bot fix this` comment on
a red Dependabot PR is an LLM decision that could land on either workflow. Under
(workflow, PR) keying that PR would get a second, empty attempt counter: attempt
resets to 1, `{{priorAttempts}}` renders blank, the escalation record isn't
found, and the budget silently doubles.

`latestForTrigger` therefore takes `workflowNames: string[]`. The same key
governs `attempt`, `flakyDeferrals`, `priorAttempts`, `escalatedAtSha`, the
cumulative cost cap, and the workspace (§S4).

### The attempt counter

`attempt` is scoped to a **problem**, not to a PR. The problem is "this head, or
a head we authored on top of it":

| Live head vs `prior.headSha` | New head's author | `attempt` |
|---|---|---|
| unchanged | — | `prior + 1` — we made no progress (covers `no-change` and `gave-up`) |
| changed | `botLogin` (us) | `prior + 1` — our fix landed, CI still red; same problem |
| changed | anyone else | **1** — the world moved; fresh problem |

The third row is what makes a maintainer's push, a Dependabot rebase, or a
Renovate recreate re-arm the loop. The original plan reset only on a
dependency-bot-authored head, which never fires for `pr-fix` on a human PR — so
a human PR that exhausted its attempts was permanently un-fixable for the life
of the PR. Resetting on author alone is also wrong: an attempt that pushes
nothing leaves the head unchanged, which would reset forever.

**`attempt` increments only when the run produced a `DIAGNOSIS_COMPLETE`
marker.** A crashed run — sandbox provisioning failure, quota rejection, model
API error — must not consume budget. This is the single most important
robustness rule in the plan: without it, one bad hour silently escalates *every*
open dependency PR across *every* managed repo to `requires-human`, and a human
must then un-stick each one by hand. Nothing else in this design can cause
damage that broad. The `$5` cost cap and `MAX_RESTART_RESUMES = 3` bound the
crash-loop case instead, and neither poisons a label.

### The five classes and their dispositions

| Class | Runs `fix` phase? | Attempt | Disposition |
|---|---|---|---|
| `reproducible` | yes | +1 | fix, gate, push |
| `env-mismatch` | yes | +1 | align to CI, gate, push |
| `flaky` | **no** | no | deferral — see below |
| `infra-dependent` | no | +1 | escalate immediately |
| `upstream-broken` | no | no | skip — see §D1 |

**`flaky` short-circuits.** By its own definition there is nothing to fix, so it
must not reach the `fix` phase — the entire justification for `diagnose` being a
separate cheap phase ([02-diagnosis.md](02-diagnosis.md) §2.2, *"it gates
spend"*) applies here more than anywhere. The original plan listed only
`infra-dependent` and `upstream-broken` as `BLOCKED`, so `flaky` fell through to
a full sandbox, checkout, install and 900-second gate loop — for a failure the
diagnosis had just said not to fix.

**`flaky` is bounded.** `fix.maxFlakyDeferrals: 2`; on the third consecutive
`flaky` the diagnosis is **promoted to `reproducible`** and a normal attempt is
spent. If a job reports flaky three times running it is not flaky, it is an
intermittent real failure — exactly the PR a human would want attempted.
Without the cap, `fix-red-dependency-prs` running daily against a PR with one
flaky test produces an unbounded series of free full runs.

`fix.maxCostUsd: 5.0` ships **on**, cumulative per PR across attempts, on the
§S1 key. A brake that ships disconnected is not a brake.

### Terminal outcomes

`failed` is reserved for **malfunction**. Correct-but-stopped outcomes
(`infra-dependent`, `upstream-broken`, `flaky`) are recorded **`succeeded`**,
with the disposition carried in the recorded `PrState`. The run did its job — it
correctly determined the PR cannot be fixed here. The PR is blocked; the run is
not.

This is not cosmetic. `failed` has four mechanical consequences:

1. `messages.on_failure` posts *"Couldn't auto-fix the failing checks — leaving
   it for a human"* to the PR — actively wrong on a `flaky` deferral, and it
   comments every time.
2. The dashboard **Retry** button targets `failed`/`cancelled`
   (`workflow-run-store.ts:513`) — offering an operator a retry that cannot
   succeed.
3. Cost and failure stats are polluted, undercutting §6.5's rollout plan of
   measuring cost per attempt from `executions.cost_usd`.
4. `latestSucceededForTrigger` excludes failed runs, so the existing
   "already assessed at this SHA" dedup **does not fire** — an
   `infra-dependent` PR re-diagnoses on every check-suite re-fire.

Recording them `succeeded` fixes all four, and (4) becomes a positive: the SHA
dedup starts working for exactly the cases that must not be re-attempted. The
status is now purely mechanical, which is fine — after §S3 the *meaning* is
visible in the detail panel regardless of colour.

### `requires-human` is a notification, not a state

The label is a one-way door today: `dependabot-discovery.ts:215` filters it for
the cron and `dependencyDedupSkip` filters it for the webhook, while the only
code that *removes* it is `dependabot-pr-merge.md` STEP 2b — which those same
guards prevent from ever being dispatched. The sole exit is an `@bot` comment.
Phase 4 and Phase 5 would have added three more producers (attempts exhausted,
`infra-dependent`, high-impact major) to the existing two, giving five distinct
meanings, one flag, no expiry, one manual exit.

**The state is not the label — it is "we escalated at head SHA X".** So the
*guard* becomes stateful rather than the label:

```
skip if requires-human is present AND
   ( no run of ours escalated this PR    → a human applied it: permanent override )
   OR ( live head is escalatedAtSha, or a commit we authored on top of it )
```

`escalatedAtSha` is already on the run context. No new storage, no extra API
call, no label mutation. Three consequences:

- A maintainer's push re-arms both the counter and the merge path — the
  behaviour a human expects after being asked to intervene.
- A human manually applying `requires-human` to mean "bot, stay out" remains a
  **hard permanent override**, because there is no escalating run of ours to
  match. The original design lost that distinction entirely.
- The five *reasons* live in the escalation comment, which §4.3 already requires
  to name the case, the attempt count, and each attempt's `class=` / `cause=`.

This settles README open question 9 in practice without a separate issue: the
label stays overloaded, but nobody has to guess what it meant, because the run
that applied it carries `escalatedBy`, `escalatedAtSha` and `priorAttempts[]`.

### The push gate is a file the agent writes for itself

§4.5's push discipline rests entirely on `../.lastlight-verify.sh`, authored by
the agent being gated. An agent that writes `exit 0` passes its own gate;
`until_bash` only checks the exit code.

The blast radius is bounded, and the plan should say so plainly rather than
implying push discipline is a correctness guarantee: `dependabot-ci-fix.md:63`
is explicit that *"the `dependabot-pr-merge` workflow takes over the merge — you
do NOT merge or label a healthy PR"*, so **nothing ever merges on the strength
of the local gate**. Real CI is always the merge authority. A weak gate costs a
wasted attempt and a noisy push, never a bad merge. So this needs hardening, not
redesign:

1. **Record the script's contents on the run record**, surfaced in the §S3
   panel. This is the most useful debugging artifact in the fix loop.
2. **`gate=skipped` never authorises a push.** The `CI_FIX_COMPLETE` marker
   already carries `gate=<green|red|skipped>`; make the absence of a script an
   explicit `skipped` and treat it as `red` for push purposes. Today "no script
   yet exits non-zero and simply loops" works only by accident of exit codes.
3. **Rewrite it unconditionally each attempt.** With the shared family workspace
   (§S4) it survives across attempts *and* across workflows — it sits outside
   the git tree, so `git clean -fdx -e node_modules` does not remove it. A stale
   gate from a superseded diagnosis is a live hazard, not a theoretical one.

Static validation of the script's contents is deliberately **not** recommended —
it is an arms race against your own agent, and (1) lets you see the problem
instead of guessing at it.

## S2 — The review state machine

### One resolver, every route

Keeping the crons (§S5) would have made `review.trigger` need three independent
implementations: `resolveReviewTrigger` (webhook), `review-discovery.ts` (cron),
and a silent bypass on the comment path. That is §7.4's own complaint, in a plan
whose thesis is "make the policy configurable rather than hardcoded".

The split is **discovery vs. policy**, not webhook vs. cron:

- `resolveReviewTrigger(state, cfg) → dispatch | skip` is a **pure function**
  over `PrState`, called from `dispatchWorkflow` — the one choke point every
  route crosses.
- `review-discovery.ts` reverts to a pure **candidate finder**: open PRs in
  managed repos. It learns nothing about modes, drafts, or settled checks. Its
  existing draft filter and `getLatestBotReview` call become `PrState` fields.
- §7.4c's dedup preflight disappears as a separate concept — `botReviewAtHead`
  is one field of the snapshot, checked once, for every route.

**An explicit `@bot review` always dispatches**, overriding mode, draft and
dedup. Today that carve-out is accidental (the comment path simply never crosses
these code paths); as one branch of the resolver it is a decision. It mirrors
the override `target-policy.ts:58` already documents for the dependency guard.

### Trigger modes

`review.trigger: eager | after-checks | on-request`. **`review.afterChecks` is
deleted.** The `passing` variant is a footgun in combination with the fix loop: a
PR we gave up on never goes green, so under `passing` the cron refuses too, and
the escalated PRs — the ones most needing human eyes — would be the only ones
with no review at all. `after-checks` means "on settle, either colour", which is
also the mode that lets the review cite the CI failure (§7.6's benefit 1).

With one value the config leaf has no reason to exist — one fewer key to plumb
through four layers.

### Fix outranks review

A single `check_suite.completed(failure)` delivery cannot become both
`pr.checks_failed → pr-fix` and a review settle trigger: `normalize()` returns
`Promise<EventEnvelope | null>` — **one envelope per delivery** — and `route()`
returns one handler. §7.3 describes broadening `check_suite.completed` as a
filter widening; it is actually a fan-out the pipeline cannot express.

Fan-out is not wanted anyway. If both fire, `pr-review` reviews a tree `pr-fix`
is concurrently rewriting; the fix pushes, CI re-runs, settles red, and you
review again — up to `maxAttempts` reviews per PR, most stale before they land.
That is §7's own benefit 2 ("collapses wasted review cycles") reintroduced by
§7's own trigger.

So it is a **precedence**, and it needs no new state:

- On a settled-**failing** suite where the PR is fix-eligible, the envelope stays
  `pr.checks_failed` → fix. The review is simply **not dispatched** — not
  deferred, not queued, no record.
- Fix pushes → CI green → next settle is `passing` → not fix-eligible → review
  fires naturally.
- Fix pushes → CI still red → next settle routes to fix again. Correct.

The only gap is the paths where **the fix chain ends without pushing**, so no
new commit exists and no further `check_suite` ever fires: attempts exhausted,
`infra-dependent`, a `flaky` deferral, `upstream-broken`, or a crash. Those are
precisely the PRs where a human most wants a review posted.

**`check-prs-awaiting-review` is the release mechanism for all five.** Within 30
minutes its candidates reach `resolveReviewTrigger`, which sees
`checksState: failing`, no run in flight, mode `after-checks` → dispatch. This is
the strongest single reason for §S5's decision to keep the crons, and it was not
visible until the fix and review machines were drawn together.

### The check run must be a projection of run state

`last-light/review` is completed inside a `.then()` chained onto the in-memory
`workflowPromise` (`dispatcher.ts:425`). `updateCheckRun` appears **only** in
`dispatcher.ts` — `resume.ts` and `admission.ts` never touch it, and the queued
branch says so: *"Documented limitation: the check stays in-progress until
admission fires."*

So a check is stranded `in_progress` on every server restart mid-review (i.e.
**every deploy**), every queued-then-resumed run, every `expireStaleRuns`
cancellation, and every crash. Nobody has noticed because
`check-prs-awaiting-review` re-reviews the PR every 30 minutes and
`createCheckRun` posts a *new* check run under the same name, superseding the
stranded one. **The polling cron is the de facto repair mechanism for stuck
checks** — which the original Phase 8 deleted.

Worse, that repair is accidental and Phase 7 breaks it independently: checks
strand most often on a review that ran and posted, and in that state
`botReviewAtHead` is set, so §7.4c's new dedup skips the run and posts no
superseding check. You can have the dedup or the accidental repair, not both.

The fix is durability, not routing (§7.4a addresses *which routes* post a check;
the defect is that the lifecycle is bound to a process):

1. Persist `reviewCheckRunId` (+ owner, repo, headSha) on the run context.
2. Complete it from the run's **terminal transition** — the same place that
   writes `succeeded` / `failed` / `cancelled` — so `simple.ts`, `resume.ts` and
   `expireQueued` all resolve it for free. `expireStaleRuns` already posts a
   comment via `postExpiryAck`; concluding the check belongs beside it.
3. A run that never dispatches (draft skip, dedup skip) **never creates a
   check**, rather than creating and immediately concluding one.

Boot-time reconciliation is **not** needed: terminal-transition completion plus
the existing `MAX_RESTART_RESUMES = 3` resume path covers restart.

This is a simplification, not an addition — the current design's bug is that the
check's state lives somewhere the run's state does not.

## S3 — Surfacing state in the admin UI

The recorded snapshot is nearly free: §S1 already requires `headSha`, `attempt`,
`flakyDeferrals` and `escalatedAtSha` on the run context. Persist the **whole**
`PrState` there instead of scattered leaves, and render it in the run **detail
panel** for any PR-related workflow, beside the phase timeline — including the
`{decision, reason}` pairs and the `.lastlight-verify.sh` contents:

```
mayMerge               → false   ("checksState=failing")
resolveFixDisposition  → skip    ("baseChecksState=failing — upstream broken")
resolveReviewTrigger   → skip    ("run in flight: dependabot-ci-fix 4821")
```

This is why the decision functions return `{decision, reason}` rather than bare
enums: the reason must be produced by the decision, not reconstructed by the
view.

**Deferred to its own issue:** a live `GET /admin/api/repos/:owner/:repo/pulls/:n/state`
inspector (answers "why is this PR stuck *now*"), a PR list across managed
repos, and a `RouterPlayground`-style dry-run with overridden config. All are
natural once `PrState` exists; none are needed to ship this plan.

## S4 — One run per PR

`db.executions.isRunning(handler, triggerId)` (`dispatcher.ts:133`) is keyed on
**handler**, and `PER_TARGET_REUSE_WORKFLOWS` builds taskId as
`${repo}-${prNumber}-${workflow}` — so two fix workflows get **separate sandbox
directories** for the same PR. Nothing prevents an `@bot fix this` comment
routed to `pr-fix` running concurrently with a `fix-red-dependency-prs` dispatch
of `dependabot-ci-fix`: two agents, two clones of the same branch, both running
the gate, both pushing.

**The lock is PR-scoped**, across every PR-scoped workflow (`pr-fix`,
`dependabot-ci-fix`, `dependabot-pr-merge`, `pr-review`) — not family-scoped.
That is simpler, and it makes §S2's review precedence a *consequence* of the lock
rather than a separate field. It also closes a case the original plan did not
raise: `dependabot-ci-fix` pushes a fix, CI goes green while the run is still
writing its comment and marker, `pr.checks_passed` fires, and
`dependabot-pr-merge` enables auto-merge **against a PR whose fix run is still
in flight**.

**The fix family shares one workspace**: taskId becomes
`${repo}-${prNumber}-fix` for `PR_FIX_SHAPED_WORKFLOWS`. If only one can run at
a time, two directories are pure waste, and attempt 2 reuses attempt 1's warm
`node_modules` even when routing differed. (`dependabot-pr-merge` keeps its own —
it has no checkout.) The consequence for `.lastlight-verify.sh` is handled in
§S1.

**The loser is dropped with a reason**, not queued — surfaced in the recorded
`PrState` as *"skipped: pr-fix run 4821 already in flight"*. An explicit `@bot`
request additionally gets a reply, which `dispatcher.ts:136` already does for
`envelope.type === "message"`; a maintainer who is silently dropped will just
ask again.

> **Coupling that must not be lost.** Drop-on-conflict is only sound because
> every dropped case has a cron re-pickup: `merge-green-dependency-prs` (daily
> 14:00), `fix-red-dependency-prs` (daily 15:00), `check-prs-awaiting-review`
> (every 30 min). **A future Phase 8 must convert dropped-on-lock into
> queued-on-lock before removing any of them.**

## S5 — Phase 8 is deferred

The crons stay. Phase 8's value is "less polling"; its cost is three blocking
prerequisites (`ready_for_review` mapping, queued-run expiry policy, check
lifecycle) plus a permanent coverage reduction — and the review sweep turns out
to be load-bearing in three ways the original plan did not account for:

1. It is the **release mechanism** for the five no-push fix terminals (§S2).
2. It is the **de facto repair** for stranded `last-light/review` checks (§S2) —
   though §S2's durable lifecycle now makes this redundant, which is the right
   order to fix it in.
3. It is the **re-pickup** that makes the PR-scoped lock's drop-on-conflict safe
   (§S4).

Two of Phase 8's three prerequisites are worth doing on their own merits and
should be lifted out of it: `ready_for_review` → `pr.opened` semantics (§7.3),
and a non-silent outcome for a queued run that expires. Do those; delete the
crons later with evidence of how often they actually find work.

**Consequence:** §7.4b is **un-superseded**. Generalising `jobs.ts:37-40`'s
hardcoded `condition.unless: webhooksEnabled` into a predicate map is a live
question again, because `check-prs-awaiting-review` must now run *with* webhooks
enabled.

## D — Defects found, with their resolutions

Each of these is a sequence that would have shipped. They are numbered by the
review question that found them.

### D1 — `upstream-broken` latched a PR dead forever

§4.3's escalation table reads the **prior run's** diagnosis class at dispatch,
and maps `upstream-broken` to *"skip without labelling — it self-heals when the
base goes green"*. It does not self-heal:

1. Attempt 1 diagnoses `upstream-broken`; the marker lands in that run's scratch.
2. The base goes green. A push fires `pr.checks_failed` again.
3. At dispatch, `latestForTrigger` returns run #1. Prior class is
   `upstream-broken` → **skip**.
4. A skip returns `{ kind: "skipped" }` and **writes no run row**
   (`dispatcher.ts:216`).
5. `latestForTrigger` therefore returns run #1 forever. Every future event
   skips. The PR is dead, with no label, no comment and nothing on the PR
   explaining why — strictly worse than `requires-human`, which is at least
   visible.

**Resolution.** Delete the prior-class row. `upstream-broken` becomes a **live**
precondition in `resolveFixDisposition`: `baseChecksState === "failing"` → skip,
no increment, no label. The signal is already fetched by §3.1. The diagnosis
class stays as explanation, not as a dispatch input.

> **General rule, which this generalises to:** *no prior-run verdict may gate
> dispatch unless the skipping path writes a run row.* Otherwise the verdict
> freezes. `infra-dependent` survives the rule because it writes a visible,
> clearable label; `upstream-broken` did not.

### D5 — Phase 3.4 routes human PRs into `dependabot-ci-fix`

Finding 2 motivates §3.4: *"`pr-fix` never receives CI feedback at all."*
Broadening the emit gate does not fix that, because **routing** is the
bottleneck:

1. CI fails; §3.4's `isOurOwnPush` makes the connector emit `pr.checks_failed`.
2. `router.ts:218` builds *"Pull request #N … its CI checks have failed."* —
   identical in shape for a dependency PR and a human one — and hands it to
   `classifyComment`.
3. `fallbackWorkflowForIntent` resolves the intent. **`pr-fix.yaml` has no
   `classification:` block at all**, so it can never be selected. Only
   `dependabot-ci-fix` claims the failed-checks intent.
4. The human PR runs `dependabot-ci-fix` — a dependency-bump prompt, the
   `dependency-trivial` / `dependency-functional` label vocabulary, and
   membership in `DEPENDENCY_WEBHOOK_WORKFLOWS`, so it also inherits a
   `requires-human` preflight it was never designed for.

So §3.4 as written increases run volume on human PRs — README open question 4,
the change flagged as the plan's real behaviour risk — and spends it on the
wrong workflow, while the thing it exists to enable still does not happen.
`router.ts:221`'s load-bearing comment (*"a human's red PR never reaches this
case"*) silently becomes false.

**Resolution.** The connector already computes `isDependencyPr` and
`isOurOwnPush` to decide whether to emit, then discards both so the router can
pay an LLM call to re-guess them from a string. Carry the discriminator on the
envelope and route `pr.checks_failed` **deterministically**, exactly as
`pr.checks_passed` already does at `router.ts:263` (*"no classifier LLM call:
the connector's dependency-PR pre-filter is the gate"*):

```
isDependencyPr (Dependabot / Renovate) → getWorkflowByIntent("dependabot-ci-fix")
otherwise                              → "pr-fix"
```

Cheaper, non-flaky, and it makes the two check-outcome routes symmetric. The
dependency route must only ever fire for genuine Dependabot/Renovate PRs;
everything else is `pr-fix`.

(§3.4's `commitAuthor === botLogin` comparison is sound —
`git-auth.ts:87` sets `user.name` to `botLogin`, and the connector reads
`headCommit.author.name`.)

### D10 — auto-merge is not the safe path on unprotected repos

The assumption is load-bearing in three places — Phase 0 (*"`github_enable_auto_merge`
must stay the default action and direct merge the narrow exception — GitHub's
own required-checks gate is the real backstop"*), §3.5 verbatim, and §5.5, which
gates **only direct merge** on `{{checksSettledPassing}}`.

GitHub's auto-merge merges as soon as all merge requirements are satisfied. On a
repo with **no required status checks** there are no requirements beyond
mergeability, so `github_enable_auto_merge` on an already-mergeable PR merges it
essentially immediately. Auto-merge and direct merge are the same action there.

That is not a hypothetical population — it is the one the plan already names
twice: Phase 0's *"`"none"` is not `"passing"`"*, and the merge prompt at line
143 (*"On a repo with no required checks, a PR whose checks are FAILING still
reports as mergeable, so a direct merge would land a RED PR (**this has
happened**)"*).

So the safety argument is circular: direct merge is gated because required
checks might not exist; auto-merge is ungated because required checks will catch
it. On any unprotected repo, Phase 5 hands a **major** version bump the ungated
path — a regression against today, where every major escalates.

**Resolution.** Stop treating auto-merge vs. direct merge as a safety boundary.
One predicate gates the decision to merge *at all*:

```ts
mayMerge(state, cfg) =
  state.checksSettledPassing && state.settledCheckCount >= cfg.minSettledChecks
```

Auto-merge remains the preferred *mechanism* — it genuinely handles the race
between our decision and a late-created check — it is just no longer credited
with a guarantee it only provides on protected repos. Stating the invariant once
in code also fixes the asymmetry where `requireSettledChecks` was described as
enforced "on all three routes" while the *action* those routes led to was not.

### `minSettledChecks` — default and clamp

Ships **`1`**, packaged. A genuinely CI-less repo therefore stops auto-merging
dependency PRs on upgrade; that is a real behaviour reduction and belongs in the
release notes.

**It is operator-only — removed from the repo-settable set.** §6.2 clamps it
`max(repo, operator)`, so a CI-less repo could never opt back down to `0`: the
escape hatch is welded shut in the direction people will need it. "How many
checks does this repo have" is a *fact*, not a policy — a repo setting `0` is
describing itself, not loosening a safety rule, and the add-only clamp model has
no vocabulary for that.

The CI-less case is handled on the fact instead: `checksState === "none"` is
insufficient evidence for a **major** bump (escalate), while non-majors continue
down the existing TRIVIAL path unchanged. Today's behaviour is preserved for the
CI-less repos that only ever see patch bumps; only Phase 5's *new* capability is
withheld.

## Locked decisions

| # | Decision | Supersedes |
|---|---|---|
| 1 | `resolvePrState` computed once at `dispatchWorkflow`; four pure decision functions returning `{decision, reason}` | §3.1–3.5 restructured |
| 2 | No prior-run verdict gates dispatch unless the skipping path writes a run row | §4.3 |
| 3 | `upstream-broken` is a live `baseChecksState` precondition, not a prior class | §4.3 |
| 4 | `attempt` is scoped to a problem: unchanged head or our authorship → +1; anyone else's push → reset to 1 | §4.1 |
| 5 | `attempt` increments only on a `DIAGNOSIS_COMPLETE` marker — crashes never consume budget | new |
| 6 | `requires-human` is a notification; the guard is stateful on `escalatedAtSha` + `escalatedBy` | §4.3, README Q9 |
| 7 | `flaky` short-circuits before the `fix` phase; promoted to `reproducible` after `maxFlakyDeferrals: 2` | §2.2, §4.3 |
| 8 | `fix.maxCostUsd: 5.0`, cumulative per PR, shipped **on** | §6.1 |
| 9 | `failed` means malfunction; correct-but-stopped outcomes record `succeeded` | §2.2 |
| 10 | `pr.checks_failed` routes deterministically — dependency → `dependabot-ci-fix`, else → `pr-fix`. No classifier | §3.4 |
| 11 | Fix state keys on (`PR_FIX_SHAPED_WORKFLOWS`, PR) | §4.1, §4.2 |
| 12 | PR-scoped run lock across all PR-scoped workflows; fix family shares one workspace; drop-and-reply on conflict | new |
| 13 | `resolveReviewTrigger` is pure, called at `dispatchWorkflow`; `review-discovery.ts` is a candidate finder only | §7.4 |
| 14 | `review.afterChecks` deleted; `after-checks` means "on settle, either colour" | §7.1 |
| 15 | Fix outranks review on a settled-failing suite; no deferral state; the cron releases the no-push terminals | §7.3, §7.6 |
| 16 | The `last-light/review` check is a projection of persisted run state, completed at the run's terminal transition | §7.4a |
| 17 | One `mayMerge` predicate gates both merge actions | §3.5, §5.5 |
| 18 | `minSettledChecks: 1`, operator-only; `checksState === "none"` blocks major auto-merge only | §6.1, §6.2 |
| 19 | Recorded `PrState` in the run detail panel; live inspector deferred | new |
| 20 | Phase 8 deferred; crons kept; §7.4b un-superseded | 08 |
| 21 | `.lastlight-verify.sh` is recorded, rewritten each attempt, and `gate=skipped` never authorises a push | §4.5 |

## Effect on the README's open questions

| # | Question | Status |
|---|---|---|
| 1 | App re-consent for `Actions: read` | **Open** — unchanged |
| 2 | agentic-pi scope / release timing | **Open** — unchanged |
| 3 | `autoMergeMaxImpact` packaged default | **Open** — still `low` packaged, `medium` in the overlay |
| 4 | Broadening `pr.checks_failed` | **Resolved** — D5; deterministic routing bounds the volume and sends it to the right workflow |
| 5 | `pr-review` default trigger mode | **Partial** — `passing` deleted (§S2); `eager` vs `after-checks` as the packaged default, and the `skipDraft: true` default, are still open |
| 6 | Webhook-less deployments | **Moot** — Phase 8 deferred, crons kept |
| 7 | Queued run that expires | **Resolved** — the crons re-pick it up; lifted out of Phase 8 as work worth doing on its own merits |
| 8 | Should bot-authored PRs be reviewable? | **Open** — not examined |
| 9 | `requires-human` overloaded | **Resolved in practice** — §S1; the reason is inspectable even though the label stays overloaded |

## What changes in each phase doc

Each phase doc remains executable on its own; these are the deltas.

| Doc | Delta |
|---|---|
| [03-signals.md](03-signals.md) | Restructured around `resolvePrState`. §3.2 `dependencyPreflight` → `resolveFixDisposition`. §3.4's routing fix (D5) is **mandatory** with the emit broadening. Now the largest phase |
| [04-retry.md](04-retry.md) | §4.1 attempt table (§S1); §4.3 escalation table replaced; `flaky` short-circuit + cap; `maxCostUsd: 5.0`; §4.5 gate hardening |
| [05-impact.md](05-impact.md) | §5.5's direct-merge gate → `mayMerge` for both actions (D10) |
| [06-config.md](06-config.md) | Add `fix.maxFlakyDeferrals`; `maxCostUsd` default `5.0`; `minSettledChecks` operator-only; delete `review.afterChecks` |
| [07-review-triggers.md](07-review-triggers.md) | §7.1 loses `afterChecks`; §7.2's `excludeApp` still required; §7.4 → the pure resolver; §7.4a → durable check lifecycle; §7.4b un-superseded; §7.4c folded into `PrState` |
| [08-remove-backstop-crons.md](08-remove-backstop-crons.md) | **Deferred.** Lift out `ready_for_review` mapping and the queued-run expiry policy as independent work |
