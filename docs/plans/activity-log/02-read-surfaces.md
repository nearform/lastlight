# Phase 3 — the read surfaces

> **Status: implemented.** See the Execution notes at the end for what actually
> happened. The steps below are the plan **as originally written**.

The admin endpoint, the dashboard Activity tab + per-run strip, and the
`lastlight activity` subcommand. All read-only.

Depends on Phases 1 and 2.

## The endpoint

`GET /admin/api/activity`, in `src/admin/routes.ts`. Mirror
`GET /feedback/signals` (`:1323`) — the newest and cleanest list endpoint,
without the legacy `repos` scope baggage `/workflow-runs` carries:

```ts
app.get("/activity", async (c) => {
  const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
  const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
  const { activity, total } = await db.activity.list({
    limit,
    offset,
    actor:  c.req.query("actor")  || undefined,
    action: c.req.query("action") || undefined,
    target: c.req.query("target") || undefined,   // "<type>:<id>", split on the first ":"
    sinceIso: c.req.query("since") || undefined,
  });
  return c.json({ activity, total });
});
```

House conventions this follows, none of them optional:

- **`limit` clamped to `[1, 200]`, default 50; `offset` clamped `>= 0`.** The
  clamps matter — `GET /executions` (`:1456`) skips them with a bare `Number(...)`
  and is the counterexample, not the template.
- **Envelope `{ activity, total }`.** One object, no `meta`/`pagination` wrapper,
  and **no companion count endpoint** — `total` is the post-filter count from the
  same store call. The dashboard already exploits this shape elsewhere by
  requesting `limit: 1` when it wants only a count.
- **A companion distinct-values route** for the filter dropdown, mirroring
  `GET /workflow-names` (`:1575`) exactly:
  ```ts
  app.get("/activity/actions", async (c) => c.json({ actions: await db.activity.actions() }));
  ```

**Enrichment.** Rows join to `users` on `actor_login` for name and avatar. The
pattern already exists at `routes.ts:1583-1597`, where `GET /workflow-runs/:id`
enriches `triggered_by` via `db.users.findByLogin`. Batch it — one
`findByLogin` per distinct actor on the page, not per row.

**No per-run route.** Decision 6: the strip is
`GET /admin/api/activity?target=workflow_run:<id>`. The filter the global feed
needs is the filter the strip needs, and `GET /workflow-runs/:id/feedback` exists
only because feedback anchors cannot be expressed as a target filter.

**Repo scoping is deliberately not applied.** `/workflow-runs`, `/sessions` and
`/stats` accept `?repos=` for #169's per-repo visibility, but that is **UI
declutter, not enforcement** — the comment at `routes.ts:758` says so, and all
three keep returning global data. An audit stream filtered by which teams you
belong to would be misleading in a way a run list is not. If this changes later
it should be a real authorization decision, not a copied query param.

## Dashboard

`apps/server/dashboard/` — React 19 + Vite + Tailwind 4 + daisyUI. **No router
library** and **no React Query or SWR**: navigation is a `Tab` union plus URL
state, and data fetching is `fetch` + `useState`/`useEffect` + a `setInterval`
poll.

### The wire type is hand-mirrored

The dashboard has **no import edge to core**, so `ActivityRecord` is typed a
second time in `dashboard/src/api.ts`, beside the other response interfaces,
with `api.activity(opts)` / `api.activityActions()` built on the
`URLSearchParams` + `req<T>` pattern at `api.ts:884-915`.

**Add a mirror pin** in `tests/admin/`, modelled on
`dashboard-config-mirror.test.ts`. That file exists because a hand-mirrored type
drifted and hid three config blocks for a release; its header says so. The pin
reads the dashboard source as text from core's suite — the established technique
for pinning a UI contract without a React test runner.

### The tab — four edit points in `App.tsx`

1. `type Tab` union (`:56`) — add `"activity"`.
2. `const TABS` array (`:60`) — add it (this is what the enum parser reads).
3. The left icon rail's nav array (`:297-333`) — `{ id, label, Icon }`.
4. The render switch (`:335-426`) — one more ternary branch.

Tab state already round-trips through the URL via `useUrlState("tab", …,
enumParser(TABS, …))`, so a deep link works for free.

### `ActivityPage.tsx`

Model it on `FeedbackPage.tsx:86-113` — the closest size and shape: a couple of
`Promise.all` fetches, a 30 s poll, and a `catch {}` that deliberately leaves the
last good render in place rather than blanking the page on a transient failure.

Filter state (`actor`, `action`, `since`) through `useUrlState` +
`nullableStringParser`, so a filtered feed is linkable.

**Reuse, do not rebuild.** Four things already exist:

| Need | Use |
|---|---|
| The "who" cell — login + avatar + actor-type badge | `components/ActorChip.tsx` |
| Outcome colours | `lib/status-colors.ts` — never local hex; see the comment at `FeedbackPage.tsx:36-42` |
| Relative timestamps | `timeAgo` — currently **file-local** at `HomePage.tsx:96`. Lift it to `lib/` and import it in both places rather than copying a third formatter into the tree |
| The visual model for a compact row list | `LiveActivitySection` in `HomePage.tsx:425-500` |

`LiveActivitySection` is worth reading before designing anything: it is the
closest existing thing to an activity feed, and matching it keeps the new tab
from reading as a different product.

### The per-run strip

A new sibling inside `DetailPanel` (`WorkflowList.tsx`), between `<PrStatePanel>`
(`:525`) and `<ResizablePipeline>` (`:527`).

**Copy `PrStatePanel`'s self-hiding pattern**: it renders nothing when the run
carries no PR state, which is what keeps the detail panel from filling with empty
sections. An activity strip on a run nobody has touched should be invisible, not
an empty box.

Fetch once on run selection — not polled. `FeedbackBadge` (`WorkflowList.tsx:101`)
is the precedent: a run-scoped fetch at `:322-331` with no interval.

## CLI

`packages/cli/` — no commander, no yargs. A hand-rolled `parseArgs`
(`cli.ts:67`) and a `switch (cmd)` (`cli.ts:1352`).

**Put the logic in `packages/cli/src/activity-cli.ts`, not `cli.ts`.** `cli.ts`
runs `main()` on import, so anything defined there is untestable. Follow
`pr-cli.ts`: a self-contained module taking an injected `apiGet` seam, dynamically
imported from its `case`. That injection is the whole reason
`packages/cli/tests/pr-cli.test.ts` can exist.

Four registration points:

1. `case "activity": return cmdActivity();` in the switch (`cli.ts:1352-1381`).
2. `HELP_TOPICS` (`:273`) — the per-command detail shown by `lastlight activity help`.
3. The compact `HELP` index (`:388-423`) — add to the `Debug` line.
4. `BOOLEAN_FLAGS` (`cli.ts:44`) — **only if a boolean flag is added**. Value
   flags (`--actor`, `--action`, `--since`, `--limit`) need nothing.

Auth and transport are already solved: `apiGet(path)` (`:204`) handles the base
URL, the bearer token, `ensureFreshToken()`'s half-life refresh, and dies with a
friendly message on a network failure.

Output follows `cmdWorkflow`'s `list` (`cli.ts:597-624`): `table()` + `age()`
from `cli-format.ts` for humans, and `out("", data)` when `--json`, which prints
the envelope verbatim. End with the same dim summary line —
`` `${data.total} total.` `` — so the CLI reports the same number the UI shows.

## Verify

```bash
pnpm --filter lastlight-core test tests/admin
pnpm --filter @lastlight/dashboard typecheck
pnpm --filter lastlight test              # the CLI's own suite
pnpm turbo run typecheck test build       # the CI gate, from the repo root
```

### End to end

```bash
./scripts/dev-local.sh
```

In one session: log in, toggle a cron off and on, fire it manually, cancel the
run it produces, and answer an approval gate. Then confirm

- the Activity tab shows those actions as distinct rows, **attributed to your
  GitHub login rather than `admin`** (the Phase 2 fix);
- the run detail strip shows only that run's rows, and is invisible on an
  untouched run;
- `lastlight activity --limit 20` and `--json` agree with the UI, including
  `total`.

Then prove the dual-dialect path, which is the one thing unit tests cannot fully
cover:

```bash
pnpm --filter lastlight-core dev:db:up
pnpm --filter lastlight-core dev:db:migrate     # exercises TABLE_ORDER for the new table
LASTLIGHT_DEV_DB=postgres pnpm --filter lastlight-core dev
```

`dev:db:migrate` is the real check on Phase 1's `data-migrate.ts` entry — the
copy **refuses to start** if `activityLog` is missing from `TABLE_ORDER`, so a
clean run here is the proof that item shipped.

## Done when

- `GET /admin/api/activity` filters and paginates, and `total` is the
  post-filter count.
- The Activity tab renders a filterable feed with real avatars, and the filter
  state is in the URL.
- The per-run strip renders on a run with activity and vanishes on one without.
- `lastlight activity` and `--json` agree with the dashboard.
- The dashboard mirror pin passes.

## Execution notes (31 Aug 2026)

Phase 3 landed. `pnpm turbo run typecheck test build` green — 25/25 tasks. The
plan held up better here than in the earlier phases; four notes:

- **A real bug the plan never contemplated, found by the bot's own review.**
  `cron.fire` hardcoded `actorType: "admin"` for every manual fire, so a
  GitHub-authenticated "Run now" wrote `cron.trigger` as `github` and its paired
  `cron.fire` as `admin` — two rows for one action disagreeing about the same
  person. The cron context carried `_cronActor` (the login) but nothing about
  HOW they authenticated. Fixed by threading `_cronActorType` alongside it, with
  `admin` kept only as the genuine-unknown fallback (which is what `admin`
  means: a password session). Worth noting the review that caught it was
  `nearform-lastlight` reviewing its own feature.

- **`?target=` must split on the FIRST colon, not `split(":")`.** A target id
  can contain one — `container:lastlight-sandbox-a:b` — and a naive split would
  truncate it. Pinned by a test.

- **`limit=0` falls back to the default rather than clamping to 1**, because
  `parseInt(...) || 50` short-circuits on zero. That is `/feedback/signals` and
  `/workflow-runs` verbatim. My first test asserted the tidier rule and failed;
  the endpoint was right and the test was wrong. Consistency across the list
  endpoints beats a marginally better rule in one of them.

- **The user enrichment is per distinct login, not per row.** A page of 50 is
  routinely two or three people, so a per-row `findByLogin` would be up to 50
  queries for 3 answers.

Two things carried over from the plan and still hold: the per-run strip needed
no new route (`?target=workflow_run:<id>`), and it self-hides on a run nobody
has touched, copying `PrStatePanel` so the detail panel does not fill with empty
sections.
