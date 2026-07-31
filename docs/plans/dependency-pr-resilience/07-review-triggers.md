# Phase 7 — Configurable `pr-review` trigger modes

> **Superseded in part by [09-state-machine.md](09-state-machine.md) §S2.**
> `review.afterChecks` is deleted (`passing` is a footgun with the fix loop).
> §7.4's gate becomes a **pure** `resolveReviewTrigger` over `PrState`, called
> at `dispatchWorkflow` for every route, and `review-discovery.ts` reverts to a
> candidate finder — §7.4c folds into the snapshot. §7.4a is not about *routes*
> but about **durability**: the check is completed from a `.then()` on an
> in-memory promise, so it strands on every deploy. And §7.3's broadened
> `check_suite.completed` is a fan-out `normalize()` cannot express — fix
> outranks review on a red settle instead.
>
> **§7.4b is un-superseded** — Phase 8 is deferred, so the cron survives and
> `condition.unless: webhooksEnabled` needs generalising after all.

**Risk: medium.** Depends on Phase 3 (`checksSettledPassing`, the broadened
`check_suite` handler) and Phase 6 (the config plumbing). Independent of
Phases 4 and 5.

Make *when* `pr-review` runs an operator/repo decision rather than a hardcoded
"immediately on open and on every push".

## First, a correction to the premise

The motivating idea was that `pr-review` is duplicative because *"it of course
will ALSO run the CI"*. **It does not.** `apps/server/skills/pr-review/SKILL.md`
is explicit, at lines 11-14:

> read the change and reason about it. Do **not** install dependencies, build, or
> run tests — that is CI's job, and it validates whether the change actually works
> […] not a build gate.

and again at line 79: *"Reason about the code statically; **don't build or run
it** — trust CI to catch […]"*. `pr-review.yaml` reinforces it in a comment:
*"No `building` — pr-review is a pure code review; CI validates that the change
builds/runs."* It gets a checkout (needed for `git diff origin/base...HEAD` and
reading surrounding code) but never installs or executes anything.

So gating the review behind CI does **not** save a duplicated test run. It is
still worth doing, for three different reasons:

1. **The review is currently blind to CI.** It reasons statically about a
   change without knowing whether that change even builds. Gating lets the
   review *read* the CI result and reference it — "this fails typecheck on
   line 42, which is the same issue as finding 2".
2. **It collapses wasted review cycles.** Every `pr.synchronize` re-reviews.
   A developer pushing three commits in five minutes to fix CI gets three
   reviews, of which the first two are stale before they post. Gating on
   settled checks means one review per settled head SHA.
3. **It stops reviewing PRs that are obviously not ready** — including drafts
   (see 7.5).

## 7.1 — Three trigger modes

```yaml
review:
  postsCheck: false          # existing — post the `last-light/review` Check Run
  trigger: eager             # eager | after-checks | on-request
  afterChecks: settled       # settled | passing — only meaningful for after-checks
  requestLabel: null         # e.g. "lastlight:review" — only meaningful for on-request
  skipDraft: true            # NEW default; see 7.5
```

### `eager` — today's behaviour (default)

`pr.opened` / `pr.synchronize` / `pr.reopened` dispatch `pr-review` immediately,
in parallel with CI. Unchanged, so upgrading changes nothing.

### `after-checks` — run once CI has settled, still as a check

The mode the question was really about: *"only run after the other checks have
passed, but still be a check."*

- On `pr.opened` / `pr.synchronize` / `pr.reopened`, **do not dispatch**.
- If `postsCheck` is on, create the `last-light/review` Check Run in
  `status: queued` with output *"Waiting for CI to finish before reviewing."*
  Branch protection then already sees the check, so a repo can require it
  without racing.
- Dispatch when the head SHA's checks settle, off the `check_suite.completed`
  handler — the same `settledConclusion` machinery Phase 3 broadens beyond
  dependency PRs.
- `review.afterChecks` decides *which* settled state qualifies:
  - **`settled`** (default) — run when checks stop moving, green **or** red.
    Guarantees the review always eventually happens, and a red CI result is
    useful review input.
  - **`passing`** — run only when green. Closest to "don't review until it
    works", but a PR whose CI never goes green is never reviewed.

`createCheckRun` currently hardcodes `status: "in_progress"`
(`apps/server/src/engine/github/github.ts:500-509`) and needs a `status` option
for the `queued` case. `updateCheckRun` already accepts `queued`.

### `on-request` — Copilot-style

No automatic dispatch at all. The review runs when explicitly asked for:

| Request signal | Status |
|---|---|
| `@<botName> review` comment | **Works today** — the classifier routes it via `pr-review`'s `classification.intent: review` |
| The Check Run "Re-run" button | **Works today** — `check_run.rerequested` → `pr.synchronize` (`github-webhook.ts:370-376`) |
| A label, e.g. `lastlight:review` | **New** — needs `pull_request.labeled` handling (see 7.3) |
| `pull_request.review_requested` naming the bot | **New, opportunistic** — see the caveat below |

If `postsCheck` is on, post the check immediately with
`conclusion: neutral` and output *"Review available on request — use Re-run, or
comment `@<botName> review`."* `neutral` is treated as passing by branch
protection, so it never blocks a merge, and the check's Re-run button becomes
the request affordance. That is a nicer UX than it sounds: the check *is* the
button.

> **Caveat on `review_requested`.** GitHub's docs say a review may be requested
> from *"a person or team with read access"*
> ([requesting a review](https://docs.github.com/articles/requesting-a-pull-request-review)) —
> GitHub App bot users are not selectable in the reviewer picker, and Copilot's
> reviewer is a first-party special case, not a general capability. So
> `on-request` mode **must not depend on it**. Handle
> `pull_request.review_requested` opportunistically — if
> `requested_reviewer.login === botLogin`, treat it as a request — because it
> costs almost nothing and future-proofs, but ship the label + comment + Re-run
> paths as the real mechanism.

## 7.2 — The self-gating deadlock (must-fix)

**`postsCheck: true` + `trigger: after-checks` deadlocks unless we exclude our
own check.**

`getChecksConclusion` (`github.ts:648-673`) aggregates *all* check runs on the
head SHA. If `last-light/review` is one of them and sits `queued` waiting for
CI, the aggregate is permanently `pending`, the settle event never fires, and
the review never runs. Worse, if the check is *required*, the PR is unmergeable
forever.

Fix: add an `excludeApp?: string` option to `getChecksConclusion` and pass
`botName`, filtering out check runs whose `app.slug` matches. Apply it wherever
the conclusion is used to decide **whether to trigger** work.

Related, and worth deciding explicitly: `pr-review` can post its check on a
Dependabot PR too, at which point `settledConclusion` for `pr.checks_passed`
also waits on our own review check. Arguably desirable (don't auto-merge before
we reviewed) but it can deadlock the same way. The safe rule is uniform:
**exclude our own checks from every trigger-side settle computation**, and let
GitHub's required-check gate do the real merge gating.

## 7.3 — Webhook coverage to add

`apps/server/src/connectors/github-webhook.ts` handles only `opened`,
`synchronize` and `reopened` for `pull_request` (L311-326). Add:

- **`labeled`** → a new `pr.labeled` event type carrying the added label name,
  so `review.requestLabel` works. Also useful beyond review.
- **`review_requested`** → `pr.review_requested`, carrying
  `requested_reviewer.login`, per the caveat above.
- **`ready_for_review`** → maps naturally to `pr.opened` semantics: a draft
  becoming ready is exactly when an eager review should fire. Pairs with
  `skipDraft`. **Mandatory once Phase 8 lands** — with `skipDraft: true` and no
  backstop cron, a PR opened as a draft and later marked ready would otherwise
  get no review at all.

Each needs a route entry in `config/default.yaml`'s `routes.github` and a
branch in `apps/server/src/engine/router.ts`.

## 7.4 — Where the mode is enforced

The trigger surface is spread across **four** places today, and only one is
config-aware. Any mode switch has to account for all four.

| # | Place | Today |
|---|---|---|
| 1 | `github-webhook.ts` `normalize()` | Decides which GitHub actions become events at all. `review_requested` / `ready_for_review` / `labeled` produce **nothing** — `type` stays null and the delivery is answered `{ filtered: true, reason: "unmapped event" }` |
| 2 | `router.ts:196-215` | Hard-codes `pr.* → pr-review` with a `gh[...] \|\| "pr-review"` fallback, so a route key can be **redirected but not disabled** — deleting `routes.github.pr_opened` does not switch the review off |
| 3 | `cron-review.yaml` `condition.unless: webhooksEnabled` | The only existing on/off switch. `jobs.ts:37-40` understands **only that one literal string** |
| 4 | `dispatcher.ts:359-369` | Decides the Check Run **independently** of 1-3, and **only on the webhook path** |

`review.trigger` is a dispatch-time decision, so the main gate belongs next to
the existing check-posting logic in `handleWebhookDispatch`
(`apps/server/src/engine/dispatcher.ts:350-396`), which already computes
`wantReviewCheck`. Extend that block into a single
`resolveReviewTrigger(envelope, routeKey, deps)` returning
`dispatch | defer | skip`, plus the check status to post.

Do **not** put the mode gate in the router: its job is
`event → { workflow, context }`, and a deferred review is still routed to
`pr-review` — it just runs later. (If a mode ever needs a hard router-level
ignore, `router.ts:595-597`'s
`{ action: "ignore", reason: "PR review events not yet handled" }` is the
pattern to mirror.)

### 7.4a — The check must be lifted off the webhook path

**`postsCheck` currently only fires for `pr.opened` / `pr.synchronize` /
`pr.reopened` via `handleWebhookDispatch`.** A cron-, comment-, Slack- or
CLI-triggered pr-review never posts a `last-light/review` check at all.

That is already a gap; both new modes make it acute:
- `on-request` reviews arrive as `comment.created` (or a label), so under
  today's logic the check would never be posted **or updated** — the neutral
  "available on request" check would sit there forever after the review ran.
- `after-checks` reviews are dispatched from `check_suite.completed`, not from
  a PR-attention event, so the same applies.

So the check lifecycle must move out of the `isPrReviewEvent` branch and key on
*"this run is a pr-review against a known PR"*, regardless of what triggered it.

### 7.4b — ~~Generalise the cron condition~~ (SUPERSEDED by Phase 8)

This section originally proposed generalising `jobs.ts:37-40`'s hardcoded
`condition.unless: webhooksEnabled` filter into a predicate map, so the
`check-prs-awaiting-review` cron could act as the safety net for a deferred
review whose `check_suite.completed` was never delivered.

**[08-remove-backstop-crons.md](08-remove-backstop-crons.md) deletes that cron
entirely.** There is no review backstop to generalise for, and with both
consumers gone the `condition.unless` mechanism has no production user at all.

The consequence lands squarely on this phase: **`after-checks` has no safety
net.** A dropped settle event means the review never runs and, with `postsCheck`
on, a `queued` check sits on the PR indefinitely. Recovery is manual —
redelivery from the App's Advanced tab, the check's Re-run button, or
`@<botName> review`. If that proves too thin, the right re-addition is a bounded
*reconciliation* (find PRs with a stale `queued` `last-light/review` check and
settle them) rather than the old polling sweep — see Phase 8 → Consequences §4.

This makes §7.4a (lifting the check lifecycle off the webhook-only path)
**mandatory** rather than merely tidy: it is now the only thing that can resolve
a stuck check.

### 7.4c — Add a pre-sandbox dedup for pr-review

Worth fixing while in here. **`pr-review` has no equivalent of
`dependencyDedupSkip`** — that guard is scoped to
`DEPENDENCY_WEBHOOK_WORKFLOWS`. So a duplicate review provisions a sandbox,
shallow-clones, deepens to find the merge base, and runs the review agent
before `post-review`'s idempotency check discovers a review already exists at
that head SHA (`handlers/post-review.ts:163-171`) and no-ops.

Reuse the existing `getLatestBotReview` in a preflight, exactly as the cron
does, so a redundant review costs one API call instead of a full sandbox run.
This matters more under `after-checks`, where the settle event and the cron
backstop can both fire for the same SHA.

## 7.5 — Draft PRs (an existing inconsistency)

`discoverPrsAwaitingReview` filters drafts out
(`review-discovery.ts:97`: `.filter((pr) => !pr.draft && pr.authorLogin !== botLogin)`),
but **the webhook path has no draft check at all** — `grep -rn "draft"` across
`router.ts`, `github-webhook.ts` and `dispatcher.ts` finds only the unrelated
`draft: false` literal at `router.ts:115`. So a draft PR opened today gets a
full review it did not ask for, while the cron would have skipped it.

Add `review.skipDraft: true` and enforce it on the webhook path, with
`ready_for_review` (7.3) as the event that un-defers. This is a small
behaviour change on upgrade and should be called out in the release notes.

## 7.6 — Letting the review use the CI result

Benefit 1 from the top of this document. When `trigger: after-checks`, the
review should carry what CI said — reuse Phase 1 and Phase 3 directly:

- `checksState` — `passing` / `failing` / `pending` / `none`.
- `ciSection` — the structured failure report, for a red PR.

> **There is no `prompts/pr-review.md`.** The `review` phase declares `skills:`
> with **no `prompt:`**, so the user prompt is *synthesized* by
> `buildPhasePrompt` (`packages/workflow-engine/src/core/phase-executor.ts:117-146`):
> *"Use the **pr-review** skill to handle this request."* plus a `Context:`
> block built from the run context. (`prompts/reviewer.md` and
> `re-reviewer.md` belong to `build.yaml`, not here.)
>
> So there is nowhere to put a `{{checksState}}` template today. Two options:
> **(a)** confirm the synthesized `Context:` block carries the new keys — the
> cheaper route, and it benefits every skill-only phase; or **(b)** give
> pr-review a real `prompts/pr-review.md`, which costs a file but makes the
> contract explicit and forkable per-repo. Decide before implementing; (a) is
> preferred unless the context block turns out to be a fixed field list.

Then update `skills/pr-review/SKILL.md` to use it: *"CI has already run — do not
speculate about whether this builds. When CI is red, the failure report is in
your context; treat it as evidence, and do not duplicate findings CI already
surfaced."* This sharpens the existing "trust CI to catch it" instruction
(SKILL.md L11-14, L78-80) from an article of faith into a fact the agent can
read.

While editing that skill, drop the vestigial `mode: scan` branch at L45-49
(*"Only when no PR is given (a repo-wide `mode: scan`) do you list open
PRs"*) — that mode was removed when discovery moved into code, and the
instruction is now dead weight the model still reads.

It also creates an opportunity worth flagging but **not** doing here: a red PR
could route to `pr-fix` instead of `pr-review`. That is a routing change with
its own blast radius; keep it out of this phase.

## Files

| File | Change |
|---|---|
| `apps/server/config/default.yaml` | `review.trigger` / `afterChecks` / `requestLabel` / `skipDraft`; new `routes.github` entries |
| `apps/server/src/config/config.ts` | fields + lenient normalizer (`reviewPostsCheck` at L612 is the pattern) |
| `apps/server/src/engine/github/github.ts` | `getChecksConclusion(..., { excludeApp })`; `createCheckRun` `status` option |
| `apps/server/src/connectors/github-webhook.ts` | `labeled` / `review_requested` / `ready_for_review`; broaden `check_suite.completed` to non-dependency PRs when `after-checks` is on |
| `apps/server/src/engine/router.ts` | routes for the new event types |
| `apps/server/src/engine/dispatcher.ts` | `resolveReviewTrigger` — dispatch / defer / skip; lift the check lifecycle off the `isPrReviewEvent` branch (7.4a); pr-review preflight dedup (7.4c) |
| `apps/server/src/cron/jobs.ts` | generalise `condition.unless` into a predicate map (7.4b) |
| `apps/server/src/cron/review-discovery.ts` | honour `trigger` + the settled filter |
| `apps/server/skills/pr-review/SKILL.md` | consume the CI state; drop the dead `mode: scan` branch (L45-49) |
| `packages/shared/src/repo-config-schema.ts` | `review` in `allowKeys` + `sanitizeReview` (per [06-config.md](06-config.md)) |

### Repo-settable and clamp direction

| Key | Repo-settable | Clamp |
|---|---|---|
| `review.trigger` | yes | free — all three modes are equally "safe"; a repo choosing `on-request` is opting out of automation, which is its call |
| `review.afterChecks` | yes | free |
| `review.requestLabel` | yes | free (a plain label name; reject `/` and `..` like `sanitizeDisabled` does) |
| `review.skipDraft` | yes | add-only `true` — a repo may skip drafts, not force reviews onto them |
| `review.postsCheck` | yes | add-only `true` — a repo may ask for the check, not suppress an operator's |

## Tests

- `tests/engine/dispatcher.test.ts` — the three modes: `eager` dispatches;
  `after-checks` defers and posts a `queued` check; `on-request` skips and posts
  a `neutral` check.
- `tests/connectors/github-webhook.test.ts` — `labeled` / `review_requested` /
  `ready_for_review` normalize correctly; `check_suite.completed` on a
  non-dependency PR dispatches `pr-review` only in `after-checks` mode.
- **A deadlock regression test**: with `postsCheck: true` and
  `trigger: after-checks`, `getChecksConclusion` must not report `pending`
  solely because of our own `last-light/review` check. This is the one that
  bites in production if it regresses.
- `tests/engine/dispatcher.test.ts` (existing L667/L683/L705 check tests) —
  extend so the check is posted for a **comment-triggered** review too (7.4a),
  which it is not today.
- A pr-review preflight-dedup test: a second dispatch at the same head SHA with
  an existing bot review must skip **before** any sandbox (7.4c).
- `tests/cron/review-discovery.test.ts` — no sweep in `on-request`; the settled
  filter in `after-checks`. `tests/cron/jobs` — the generalised
  `condition.unless` predicate map (7.4b).
- A draft-PR test on the webhook path (currently absent).

## Done when

- An operator can pick `eager` / `after-checks` / `on-request` per instance and
  a repo can pick its own.
- `after-checks` + `postsCheck` produces a `queued` check that becomes a real
  conclusion after CI settles, and **cannot deadlock on its own check**.
- `on-request` posts a `neutral` check whose Re-run button requests the review.
- Draft PRs are treated the same on the webhook and cron paths.
- The review can see and cite the CI outcome.
- The `last-light/review` check is posted and completed for **every** pr-review
  route, not just the three PR-attention webhooks.
- A redundant review at an already-reviewed head SHA costs one API call, not a
  sandbox run.
