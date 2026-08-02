# Phase 3 — `PrState.intervention`: making "go again" a recorded fact

**Risk: medium.** This touches `sameProblem()`, the predicate every budget
in the fix family hangs off. The change is small; the blast radius is not.

Depends on Phase 2 — the hold direction lives in a label, so this phase
only has to model the retry direction.

## The defect

The state machine models *the PR's problem* precisely and models *human
intent* not at all. There is exactly one way to express "a human
intervened": **the head SHA changed and the bot did not author it**. That
is an inference from a commit, not a record of a decision.

Three things a maintainer would naturally do, and what each actually does:

| Action | Today |
|---|---|
| Push a non-bot commit | ✅ Works. `sameProblem` false → baseline re-stamped, `attempt` → 1, guard cleared. |
| Comment `@last-light try again` | ❌ `explicitRequest` clears the escalation guard (`pr-decisions.ts:399`) then falls through the budget gate at `:418`, which has no override. Re-escalates → **duplicate comment**. |
| Remove `requires-human` | ❌ `escalatedBy` → `null` (`pr-state.ts:619`), guard clears, budget gate fires → **re-labels and posts a duplicate comment**. |

Both failures are the same failure: they clear the **guard** without moving
the **window**. That is `#256` — "budget-exhausted re-comments on every
push" — reintroduced through two doors the original fix did not cover.

Both are also actively advertised. `pr-escalation.ts:383` tells the
maintainer *"You can also ask me directly in a comment to override"*, which
`tests/engine/pr-decisions.test.ts:432` deliberately refuses. And
`PrState.priorDiagnosisClass`'s doc comment (`pr-state.ts:220`) justifies
its own design by *"keeping the manual exit working: a maintainer who
removes `requires-human` by hand is asking for another try"* — true for
`not-retryable`, false for the other two cases.

The empty-commit workaround that does work has its own cost: it launders
provenance. `headIsOurs` is a git author-name check (`pr-state.ts:455`), so
"a human intervened" is inferred from a commit rather than recorded, and
nobody can later ask who asked for the next $5 or why.

## The design

One field. Locked decisions 5, 6 and 7 keep it small.

```ts
/**
 * The last time a human told us to try again — the one thing that makes an
 * escalated problem dispatchable without a new commit.
 *
 * `by` and `note` are recorded for display and for the journal. **No
 * decision function reads either** — the same rule `PrNote` lives under.
 * Capability is checked at the surface (`author_association`, or GitHub's
 * own label permissions); identity is never a decision input.
 */
intervention: {
  at: string;
  /** The head SHA the retry was asked for — the retry's own idempotency key. */
  atSha: string;
  /** How it arrived: a comment, a label removal, or the admin API. */
  via: "comment" | "label" | "api";
  by?: string;
  note?: string;
} | null;
```

Only the retry direction, because Phase 2 put the hold in a label.

### `sameProblem` gains one clause

```ts
function sameProblem(state, prior): boolean {
  const priorHead = typeof prior?.headSha === "string" ? prior.headSha : "";
  const headChanged = !!state.headSha && !!priorHead && state.headSha !== priorHead;
  if (retriedSince(state, prior)) return false;   // ← new
  return !(headChanged && !state.headIsOurs);
}
```

`retriedSince` is true when an intervention was recorded after the prior
run's own snapshot. Because `sameProblem` is read in exactly two places —
the attempt counter and the cost baseline — this one clause re-arms both,
which is precisely locked decision 7: a retry does what a push does, so
there is still only one boundary.

### The one asymmetry: the journal survives a retry

Locked decision 8. Today `deriveAttemptHistory` returns `fresh` on
`!sameProblem` (`pr-state.ts:703`), wiping `priorAttempts`,
`flakyDeferrals` and `priorDiagnosisClass` together. That is right for a
push — the code changed, prior findings may be stale — and wrong for a
retry, where nothing changed but patience. On `#1016` the journal held the
one useful fact: that the diagnosis had already concluded CI was green at
the current head.

So `deriveAttemptHistory` needs to know *which kind* of fresh problem it is
looking at:

| | `attempt` | cost baseline | `priorAttempts` | `flakyDeferrals` | `priorDiagnosisClass` |
|---|---|---|---|---|---|
| push (non-bot head) | 1 | re-stamped | **wiped** | 0 | null |
| retry | 1 | re-stamped | **carried + seam line** | 0 | null |

`flakyDeferrals` resets on both: a human intervening is a statement that
the flaky-versus-real inference should start over, and they have better
evidence than the counter does.

The seam line matters. Without it the journal renders `attempt 1`,
`attempt 2`, and then a new run that also calls itself attempt 1, and the
agent cannot tell where the boundary is. Append one bounded line through
the existing `fix-markers.ts` machinery:

```
— retried by request: "arm64 runner was flaky" —
```

The note is the free text from the comment. It is bounded and fenced by
`pr-notes.ts` before it reaches a prompt, so it can inform an agent and can
never make a code path reachable.

### Model escalation moves off the counter

Locked decision 10. `escalateModelAfterAttempt: 1` means attempt 2+ uses
`models["pr-fix-retry"]`. With `attempt` resetting on a retry, a PR that
has failed three times on the escalated model gets retried on the base
model — backwards.

Switch the substitution in `apps/server/src/workflows/simple.ts` to key on
`priorAttempts.length`, which now survives a retry and is the thing that
actually knows how many times this has been tried. The counter goes back to
being purely a budget.

## The surfaces

Locked decision 11. The first two are repairs, not features.

### 1. Comment — `@last-light retry`

**Already maintainer-gated.** `router.ts:547` sits after the mention gate
and before approval commands, before classification, before everything —
it gates the entire `@`-mention comment path to `OWNER | MEMBER |
COLLABORATOR`. The comment above it says *"Only maintainers can trigger
builds"*, which has been understating it; fix that comment in Phase 4.

So no new authorization work. What changes is what `explicitRequest` does
in the fix family: instead of clearing the guard and falling through to the
budget gate, it **writes the intervention record and re-arms**.

Free text after the command becomes `note`, and lands in `PrState.notes`.

### 2. Removing `requires-human`

No new webhook needed. The escalation record already gives you
`escalatedAtSha`, so:

> we escalated at this SHA **and** the head has not moved **and** our label
> is gone

can only mean a human removed it. Detect it while resolving state, write
the intervention record **once**, and the guard then reads the record
rather than the label — so it does not re-fire on every subsequent event.

Note this becomes trivially detectable once Phase 2 lands, because the
label is no longer a decision input: its absence is pure evidence with no
competing meaning.

Also maintainer-gated for free — GitHub requires triage permission to
remove a label.

### 3. CLI — `lastlight pr retry <owner/repo#N>`

A thin client over a new admin endpoint, same idiom as `cron trigger`. The
endpoint has to exist for the eventual dashboard anyway, so it rides along
here. `via: "api"`, `by` from the authenticated admin session.

### Not now: the dashboard

`prState` appears nowhere in `admin/routes.ts` — there is no PR surface at
all. When it comes, build the **list** (what is stuck, why, what was tried,
what it cost), not a button on a run detail panel that you can only reach
if you already know the run id.

## Where the record lives

Follow `escalatePr` exactly: **a run row, written before any GitHub write**
(`pr-escalation.ts`, "Why the row, and why FIRST"). The same reasoning
applies unchanged — `resolvePrState` reads prior state off the previous
run's persisted `context.prState`, and a dispatch-time action that writes
no row persists nothing.

For a retry the crash-window ordering is gentler than for an escalation
(worst case a retry is silently lost and the maintainer asks again), but
use the same order anyway. Two mechanisms with the same shape and different
orderings is how the next reader gets it wrong.

A retry that is immediately followed by a dispatch does not need its own
row if the dispatched run's own snapshot carries the intervention — prefer
that where the retry results in a run, and write a standalone row only when
the retry is recorded but the dispatch is then skipped for an unrelated
reason. Confirm which during execution; do not guess.

## Interaction with the hold label

The hold is checked above everything (Phase 2), so a retry on a held PR
does nothing and gets the hold's one-line reply. That is locked decision 4
and it is the single case where "a maintainer asked and was not obeyed" is
intentional — which is why the reply is not optional.

## Tests

`tests/engine/pr-decisions.test.ts` and `tests/engine/pr-escalation.test.ts`
already have the fixture shape. Extend the existing "the cost window resets
with the problem" describe block, which is the closest analogue:

- A retry re-arms `attempt` to 1 and `cumulativeCostUsd` to 0, exactly as a
  push does.
- A retry **keeps** `priorAttempts` and appends the seam line; a push still
  wipes it.
- `flakyDeferrals` resets on both.
- A second retry at the same head after another escalation re-arms again —
  unbounded, full window (locked decision 9).
- A retry does **not** override the hold label, the fork guard, the run
  lock, `upstream-broken`, or a degraded read.
- Model escalation fires off `priorAttempts.length` and survives a retry.
- **Regression:** an explicit request on a budget-exhausted PR posts
  **one** comment total, not one per ask.
- **Regression:** removing `requires-human` re-arms rather than re-labels.

## Done when

- All three of comment, label-removal and CLI re-arm an escalated PR, and
  none of them produces a second escalation comment.
- The empty-commit trick is no longer the only exit, and the retry is
  attributable in the run detail panel.
- The agent's journal survives a retry, and the next attempt can see what
  the previous window already ruled out.
