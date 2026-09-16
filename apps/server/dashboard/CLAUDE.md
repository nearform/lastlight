# @lastlight/dashboard

The admin SPA for `lastlight-core` — a private (`@lastlight/dashboard`) **React +
Vite + Tailwind** app, built into `dist/` and served by the harness at **`/admin`**
at runtime.

It's a **read-mostly** view over the harness admin API (`apps/server/src/admin/`):
workflow runs, sessions (via `SessionReader` / `ChatSessionReader`), approvals,
logs, config (Default / Overlay / Merged), managed repos, stats, and the
core/overlay version drift banner. Auth (password and/or Slack/GitHub OAuth) is
handled by the admin API; the SPA just carries the session token.

## The Board tab

`components/BoardPage.tsx` + `components/board/*` render the software-factory
pipeline: every open issue and PR in scope, filed under the stage label it
carries. The actions are **live** (Phase 7): `GET /admin/api/board` returns each
card's `actions` with `enabled` / `disabledReason`, and `CardActionMenu` routes
the ones the operator presses through `cardActions.ts` onto the admin API —
approve / reject (with an inline reason), cancel (behind an inline two-step
confirm: it stops work that is running now), retry, dispatch, and `open` as
plain navigation. A pending approval still also deep-links to `?approval=<id>`
and the existing `FocusedApprovalView`.

**Never re-derive `enabled` / `disabledReason` on the client.** The server
computes them because it is the side that knows the hold label, the PR-scoped
run lock and the route map; a second opinion here would be free to drift from
the gate that actually decides — the #256 defect class in a new place. The menu
renders the server's verdict verbatim (disabled exactly when it said so, tooltip
in its words) and `cardActions.ts` only routes what the operator was allowed to
press. That is the invariant Phase 7 preserved when it made the buttons live,
and it is the rule that mattered — not the read-only-ness.

A **409 is not an error to swallow**: it is the gate explaining itself in the
same words the bot would have posted on the issue, and it is the most useful
thing the board can say. It renders inline on the card, verbatim
(`failureMessage` → `BoardCard`'s feedback banner). So does the other
easy-to-miss answer: a PR retry that comes back `dispatched: false` is a 200
where nothing has started yet, and says so.

There is deliberately **no toast and no modal system** in this dashboard. The
board says everything on the card — an inline banner for an outcome, an inline
textarea for a reason, an inline two-step confirm for a cancel — the same idiom
`FocusedApprovalView` uses, where a decision and its justification belong on one
surface. Don't introduce a toast/modal layer to say something a card can say.

Two things to keep in mind when changing it:

- **Freshness is a stream, with a poll behind it.** `useBoardStream` holds an
  SSE connection to `GET /admin/api/board/stream`, which pushes a **revision**
  and never a board; the page refetches at its own scope when that revision
  moves. Refetch plainly — never with `refresh: true`, which bypasses the TTL
  and would defeat the endpoint's force-throttle on every push. While the
  stream is live the poll drops to a 120 s safety net, because a stream that
  dies quietly must not strand the view; whenever it is not live it falls back
  to the old 20 s cadence, so a browser or proxy that won't hold an EventSource
  open degrades to exactly the behaviour that shipped before it.
- **Both are visibility-gated, and the stream is CLOSED while
  `document.hidden`** — not merely paused. That matters more than stopping a
  poll did: a poll that isn't firing costs nothing, whereas an idle EventSource
  holds a connection open all night. Behind the endpoint's ~120 s cache are real
  GitHub requests, so a tab left open on a second monitor is exactly how a
  server-side TTL becomes a GitHub bill. Don't remove the gate, and don't
  shorten the intervals.
- **`unblock` is not its own endpoint.** The "Unblock & rebuild" action on a
  parked card posts the SAME stage move the drag gesture does — the target
  column arrives as the action's `to`, because stage labels are
  operator-configured and the client must never guess which column is the
  entrance. Don't give it a bespoke call: one path means one gate and one set
  of refusals, and a gate refusal ("the budget said no") is a 200 whose reason
  belongs on the card.
- **It is NOT the same as `retry`.** `retry` resumes the same run from the
  phase that failed; `unblock` starts a fresh build from the entry column.
  Both are offered on a failed card on purpose — a guardrails block wants the
  second, a flaky step wants the first.
- **Render `run.phase` in preference to `run.currentPhase`.** The raw column is
  written when a phase COMPLETES, so it lags by one for everything after the
  first — a run on `executor` reads `architect`, and one that died early reads
  the `phase_0` seed. `phase` is the server's corrected answer from the ledger,
  absent when the two agree, so the fallback keeps an older server working.
- **Columns come from the operator's `autonomy.stages`**, never from constants.
  `configured: false` means the deployment declared none — say so rather than
  inventing an Intake / Triage / Review set. Titles and labels are strings to
  display, never values to `switch` on.
- **One column is hidden by default: *Unstaged*.** Items carrying no stage
  label render FIRST, left of every stage, because that is the intake pile and
  the board should read left-to-right in the direction work travels.
- **The `on_success` column is VISIBLE by default; its checkbox is an opt-out.**
  It used to be hidden, on the reading that it is the pile the pipeline has
  finished with and therefore only grows. That reading was wrong, and the
  board's own GitHub query is the proof: it searches `is:open`, so an issue
  whose PR was merged and which was then closed leaves the board altogether.
  Nothing accumulates. What remains is every issue whose build succeeded, whose
  PR is open, and which is still open — work sitting on a HUMAN. Hiding it made
  the one column waiting on you the one column you could not see. Both toggles
  match on the server's `<stage>.<phase>` column id, never on label text —
  operators rename their own stage labels, so matching `"ready-for-human"`
  would break the moment somebody did.
- **The board only ever shows repos on the `autonomy.repos` allow-list**, and
  that is the server's decision, not a client filter. A managed repo outside it
  has no pipeline: every action on its cards would answer `409 not-autonomous`.
  With an empty allow-list the scope is empty and `scope.reason` says so — an
  empty board has to read as un-opted-in rather than as broken.

URL state is `?tab=board&brepo=<csv>&card=<owner/repo#N>&needs=1` — `brepo`, not
`repo`, which `ReposPage` already owns. Gated cards get an amber border, a
"waiting" treatment and sort first within their column; column headers carry an
"n waiting" badge.

**Drag-and-drop moves a card's stage LABEL** — `POST /admin/api/issues/:owner/
:repo/:number/stage` with `{ to, from }`, where `to: ""` is the unstaged column
(remove `from`, add nothing). Plain HTML5 drag events, **no DnD library**: the
interaction is one card onto one column, and `draggable` + the five handlers
express it at no cost. Three things to keep:

- **A held card is not draggable at all.** The server would refuse the move
  anyway, and offering a gesture then rejecting it is worse than not offering
  it. Likewise a column never highlights, and never calls `preventDefault`, for
  the card already in it — so that drop costs no request.
- **The endpoint dispatches on the two build columns.** A drop on a stage's
  `enter` or `running` label crosses the build gate as the logged-in human and
  starts a run; the two terminal columns and the unstaged column move the card
  and start nothing. So a 200 answers two independent questions — `moved` /
  `advanced` / `removed` are the LABEL outcome, `dispatched` / `dispatchReason`
  the BUILD one. Render the reason: a gate refusal (budget, a run already in
  flight) is an ordinary 200, and the card is the only place it can be seen.
- **A dispatched entry drop lands in the RUNNING column**, not the one it was
  dropped on, and the response says so in `landedLabel`. The server crosses the
  gate before writing an entry label — that is how it avoids racing its own
  webhook — so by the time it answers, the gate has already advanced the issue.
  Place the card where `landedLabel` says, or the drag appears to spring back.
- **The 409 renders verbatim on the card**, in the same feedback banner an
  action's refusal uses.

The decision — is this drop a move, where to, and is there anything to say
afterwards — lives in `board/stageDrop.ts` as a pure total function
(`resolveStageDrop`), not in the drag handlers; the components do the HTML5
plumbing and nothing else. The dragged card is mirrored in `BoardPage` state as
well as `dataTransfer` because `getData` is deliberately unreadable during
`dragover`, which is when a column must decide whether it is a legal target.

The board's logic is pure, exported and DOM-free — `sortGatedFirst`, `isGated`,
`timeAgo`, plus all of `cardActions.ts` (`subjectOf`, `intentForAction`, the
`needsReason` / `needsConfirm` / `isNavigation` predicates, `performIntent`,
`failureMessage`) and all of `stageDrop.ts` (`draggedCardOf`, `isDraggable`, the
`encode` / `decodeDragPayload` pair, `resolveStageDrop`,
`performStageMove`) — and `tests/` now covers it under vitest:
`pnpm --filter @lastlight/dashboard test`. `vitest.config.ts` is deliberately
node-environment and pure-function only: **no jsdom, no testing-library, no
renderer**. A component test that genuinely needed a DOM would have to add those
first — prefer extracting the logic, as the board did. The server side is covered
by `apps/server/tests/admin/board*.test.ts`.

## Commands

```bash
pnpm --filter @lastlight/dashboard dev        # vite dev server
pnpm --filter @lastlight/dashboard build      # tsc -b && vite build → dist/
pnpm --filter @lastlight/dashboard typecheck  # tsc -b
pnpm --filter @lastlight/dashboard test       # vitest run — tests/, pure helpers
```

`pnpm --filter lastlight-core build:dashboard` builds it as part of the server
package; the server's `dev` script runs both concurrently. See
[`apps/server/CLAUDE.md`](../CLAUDE.md) for the admin API + session-store details.
