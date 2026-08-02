# Phase 4 — Corrections: one safety net, one false promise, five stale claims

**Risk: none for most of it.** Mostly prose. One item — the `escalatePr`
dedup — is a real safety net for Phase 3 and should land with it rather
than after.

Every item below was found while tracing `cliftonc/drizzle-cube#1016`.
They are collected here rather than scattered through Phases 1–3 so that
none of them is lost to "I'll fix the comment while I'm in there".

## 1. `escalatePr` has no dedup — the safety net (do this with Phase 3)

`escalatePr` (`apps/server/src/engine/pr-escalation.ts:103`) checks for a
missing head SHA and a missing GitHub client, then records, labels and
comments. It never asks whether it has **already escalated at this SHA**.

The module header explains why that was fine:

> *"Neither `postComment` nor `addLabels` de-duplicates … The once-only
> property comes from the persisted record instead: the next dispatch at
> the same head reads `escalatedAtSha` back, resolves `escalatedBy: "us"`,
> and takes the `escalated:` skip — which carries no `EscalationCase`, so
> nothing is applied."*

The once-only property is therefore **entirely dependent on the
`escalated:` guard firing first**. Any path that bypasses that guard and
then hits an escalating skip posts another comment. Two such paths exist
today (an explicit request, and a removed label), and Phase 3 deliberately
adds a third.

Add the belt:

```ts
// The `escalated:` guard is what normally makes this once-only, but it can
// be bypassed — by an explicit request, by a hand-removed label, or by a
// retry — and every bypass lands here again. Re-recording is harmless;
// re-commenting is #256.
if (state.escalatedAtSha === state.headSha) return null;
```

Place it after the head-SHA check and before the row write. Guard it with a
test that calls `escalatePr` twice at the same head and asserts one
comment.

## 2. The escalation comment makes a promise the code refuses

`renderEscalationComment` (`pr-escalation.ts:350`) closes with:

> *"**Push a commit to this branch and I'll pick it up again** … You can
> also ask me directly in a comment to override."*

The second sentence is false for `budget-exhausted` and
`attempts-exhausted` — `tests/engine/pr-decisions.test.ts:432` asserts that
an explicit request must **not** override the budget, with the comment
*"the cap exists to stop exactly this"*.

This has to be rewritten once Phases 2 and 3 land, because the true exits
change. After those phases the accurate text is roughly:

- push a commit — still works, still the zero-thinking option;
- comment `@last-light retry` — now works, and takes a reason;
- remove `requires-human` — now works;
- and, new: apply `<hold-label>` if you want the bot to stay off entirely.

Keep it pure and table-tested, as it is today. The wording is a contract:
it is the only place most people will ever learn how to un-stick the bot.

Update `tests/engine/pr-escalation.test.ts:424` alongside it.

## 3. `pr-state.ts:220` documents a manual exit that does not exist

`PrState.priorDiagnosisClass`'s doc comment:

> *"That asymmetry is what keeps the manual exit working: a maintainer who
> removes `requires-human` by hand is asking for another try, and a
> remembered `infra-dependent` would re-escalate on the next event and put
> the label straight back."*

The reasoning is correct for `not-retryable`. For `budget-exhausted` and
`attempts-exhausted` the manual exit does not work — removing the label
clears the guard, the budget gate fires anyway, and the label goes straight
back with a duplicate comment. The comment describes the intended design,
not the shipped one.

Phase 3 makes it true. Update the wording to say so explicitly rather than
leaving a reader to work out which cases it covers.

## 4. `router.ts:544` understates the maintainer check

```ts
// Only maintainers (OWNER, MEMBER, COLLABORATOR) can trigger builds.
```

The check at `:547` sits after the mention gate and before approval
commands, before classification, before everything — it gates the **entire
`@`-mention comment path** to `:759`. Build, review, fix, triage,
approve/reject: a non-maintainer mentioning the bot gets the canned reply
and nothing dispatches.

The comment has been understating the deployment's actual security posture,
which is the direction that causes people to add redundant checks — or, worse,
to believe a hole exists and design around it. Reword to say what it does.

## 5. `dependabot-discovery.ts:52` describes an exclusion that no longer exists

> *"The discovery exclusion below imports `REQUIRES_HUMAN_LABEL`"*

Nothing in that file uses the constant except its own definition — the
filter moved to the dispatch gate when it was centralised, which the
adjacent comment at `:45` correctly describes. Delete the stale clause.

Note this also becomes the *definition* of the constant's only remaining
job after Phase 2: a string the bot writes and nothing reads.

## 6. `dispatcher.ts:205` lists a dead event type

`explicitRequest` includes `envelope.type === "pr_review_comment.created"`,
but `router.ts:763` returns `{ action: "ignore", reason: "PR review events
not yet handled" }` for that type, so it never reaches the dispatcher.

Harmless, but it implies a supported path that does not exist. Either
delete it, or leave it with a comment saying it is provisional for when
review comments are handled — deleting is better, because the reinstating
change will have to touch this file anyway.

## 7. Slack has no maintainer gate

Not a correction so much as a gap to confirm. The `message` route
(`router.ts:765`) bypasses `MAINTAINER_ROLES` entirely — Slack has no
`author_association`. The only gate is `SLACK_ALLOWED_USERS`
(`connectors/messaging/base.ts:51`), which is **empty by default** and
therefore allows every user in the workspace.

That is defensible for a private workspace and not defensible for a shared
one. Check what production actually has set before deciding whether this
needs work; if `SLACK_ALLOWED_USERS` is unset on any deployment that can
reach a managed repo, it should be filed as its own issue rather than
folded in here.

## Tests

- `escalatePr` twice at the same head → one comment, one label call.
- The rewritten escalation comment, table-tested per case, asserting it
  names only exits that exist.
- No test needed for items 3–6; they are comments and a dead branch. The
  `docs-check` pre-commit hook and `tests/cron/label-vocab.test.ts` cover
  drift in the surfaces that matter.

## Done when

- Asking the bot to retry, or removing its label, cannot produce a second
  escalation comment under any ordering.
- Every exit named in the escalation comment actually works.
- No comment in the fix path describes behaviour the code does not have.
