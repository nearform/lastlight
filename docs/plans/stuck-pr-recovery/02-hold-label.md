# Phase 2 — A hold label, and `requires-human` as a pure notification

**Risk: low.** This phase *removes* an inference rather than adding one.
Net effect on `pr-state.ts` is negative lines.

## The defect

`09-state-machine.md` §S1 and `pr-escalation.ts`'s module header both
assert that **`requires-human` is a notification, not a state**. The code
does not quite achieve it: intent is still inferred from the label, which
makes the label a state in practice.

`applyEscalationRecord` (`apps/server/src/engine/pr-state.ts:605`) decides
whose label it is by asking *have we ever run on this PR* (`:623`), not
*who applied it*:

```ts
if (!state.labels.includes(REQUIRES_HUMAN_LABEL)) { state.escalatedBy = null; return; }
if (!priorAny) { state.escalatedBy = "human"; return; }   // ← the only "human" branch
state.escalatedBy = "us";
```

So a maintainer applying `requires-human` by hand to mean *"leave this PR
alone"* is honoured **only on a PR the bot has never touched**. On any PR
the bot has ever worked — reviewed once, assessed once — it reads as the
bot's own escalation, and is therefore cleared by the next person's push.

The doc comment at `:593` knows this and defends it:

> *"Misreading in this direction costs at most further dispatches on a PR
> already bounded by `fix.maxAttempts` and `fix.maxCostUsd`."*

**Phase 3 removes that defence.** Once a retry re-arms both budgets, a
mis-read hold can be overridden indefinitely. This phase must therefore
land before or with Phase 3, not after.

## The design

Two labels, two jobs, neither inferred.

| Label | Written by | Read by | Meaning |
|---|---|---|---|
| `requires-human` | the bot (escalation, and the agent per the dependabot prompts) | **nothing** | *"I stopped and a human should look."* A notification. |
| the hold label | a human only | the dispatch gate | *"Last Light, stay off this."* A live precondition. |

### Why a label rather than a record

- It is a **live precondition**, which is the design's stated preference
  (`PrState`'s "live from GitHub" half, and `09 → D1`: a live precondition
  re-evaluates every event, a stored verdict freezes). Nothing to persist,
  nothing to migrate, nothing to clear.
- It is **idempotent**. Present or absent. Locked decision 6 ("last one
  wins") never has to be applied, because there is no ordering to resolve.
- It is **maintainer-gated for free**: GitHub requires triage permission to
  add or remove a label, so no `author_association` check is needed on this
  path.
- Removing it resumes the bot with no record to clean up.

### Naming

Pick one and put it in `dependabot-discovery.ts` beside the existing label
vocabulary, which is documented as *"THE single source of truth for these
strings"*. Candidates: `lastlight-hold`, `lastlight-ignore`,
`no-lastlight`. Prefer whichever reads correctly in the sentence a
maintainer will say out loud when they apply it.

It should be **operator-configurable** with a packaged default, alongside
the rest of the label vocabulary, and created by the same
`github_ensure_labels` pass with its own colour — the colour is part of the
contract for the existing three.

## Changes

### 1. Block at the dispatch choke point

Locked decision 3: the hold blocks **every** workflow on **any** subject
carrying it — PRs and issues alike.

- **PR-scoped path**: a new branch in `resolveDispatchDisposition`, placed
  **above every other guard except `readDegradedDrop`**. Above the run
  lock, above the fork check, above the budgets. It is not a verdict about
  a problem; it is an instruction, and it outranks everything except "we
  could not read the PR at all".
- **Issue path**: the same string checked against the envelope's labels in
  the router, so `issue-triage` and `issue-comment` honour it too.

The skip carries **no `EscalationCase`** — nothing is labelled, nothing is
commented, no run row is written. It is a silent drop, exactly like
`upstream-broken`.

### 2. One reply when an explicit request loses to it

Locked decision 4: the hold beats an explicit request. A maintainer who
comments `@last-light <anything>` on a held subject gets one reply naming
the label and how to lift it — otherwise the bot is silently ignoring a
direct instruction, which is worse than refusing it.

Follow the existing pattern: the reply belongs to **the route that has a
human on the other end**, not to the decision — same argument
`applyPrDispatchGate` already makes for the fork notice and the run-lock
reply. A cron tick must say nothing.

Dedup is not needed here the way it is for the fork notice: this only fires
on an explicit request, so it is one reply per ask, which is correct.

### 3. Stop reading `requires-human`

`pr-state.ts:619` is the **only** place `REQUIRES_HUMAN_LABEL` is read as a
decision input. Verified:

```bash
grep -rn "REQUIRES_HUMAN_LABEL" --include="*.ts" apps/server/src packages | grep -v test
```

returns the definition, the two writes in `pr-escalation.ts`, and that one
read. Delete the read and:

- `PrState.escalatedBy` collapses from `"us" | "human" | null` to a boolean
  — or disappears entirely in favour of `escalatedAtSha !== null`. Prefer
  deleting it: the field's whole purpose was the tri-state.
- `applyEscalationRecord` loses the `priorAny` discriminator, the
  `escalatedBy: "human"` branch, and the 45-line doc comment explaining a
  hazard that no longer exists.
- `resolveFixDisposition`'s `human-hold` branch (`pr-decisions.ts:390`)
  goes away; the `escalatedBy === "us"` branch at `:399` becomes
  `escalatedAtSha !== null`.

The label keeps being **applied** by `escalatePr` and by the agent per
`prompts/dependabot-ci-fix.md` and `prompts/dependabot-pr-merge.md`. It is
still how a human finds out. It just stops meaning anything to the code.

### 4. Documentation

- `spec/05-router.md` → "The PR-scoped dispatch gate" — add the hold as the
  first gate.
- `spec/02-configuration.md` — the label name if it becomes configurable.
- `docs/agents/triage-labels.md` — add the hold to the canonical vocabulary.
- `tests/cron/label-vocab.test.ts` already pins prompt strings against the
  code constants; extend it to cover the new label.
- The `apps/www` site, via the `docs-sync` skill — this changes an operator-
  visible behaviour.

## Migration

PRs currently held by a hand-applied `requires-human` will stop being held
when this ships. The blast radius is small, because that hold only ever
worked on PRs the bot had never touched — by definition the PRs it was
least likely to be dispatched to anyway.

Worth a line in `BREAKING-CHANGES.md`-style release notes: *"If you have
been using `requires-human` to keep Last Light off a PR, apply
`<hold-label>` instead."*

## Tests

Table tests in `tests/engine/pr-decisions.test.ts`, which already has the
fixture shape for this:

- Hold present → skip, on every PR-scoped workflow, with no
  `EscalationCase`, no `review` placeholder, and no run row.
- Hold present + `explicitRequest` → still skip (decision 4).
- Hold present + a run already in flight → still skip, and the hold reason
  is the one reported, since it sits above the run lock.
- Hold present + degraded read → the degraded drop wins, since it sits
  above the hold.
- Hold absent + `requires-human` present, applied by a human, on a PR we
  have worked → **dispatches** (the behaviour change).
- Removing the hold re-dispatches with no record to clear.

Router tests for the issue path: hold on an issue suppresses `issue-triage`
and `issue-comment`.

## Done when

- `REQUIRES_HUMAN_LABEL` appears in no decision path.
- A maintainer can stop the bot touching any PR or issue with one label,
  and start it again by removing that label.
- `@`-mentioning the bot on a held subject produces exactly one reply
  explaining why nothing happened.
- `escalatedBy` is gone, and the essay at `pr-state.ts:560-604` with it.
