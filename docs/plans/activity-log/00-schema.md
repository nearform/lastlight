# Phase 1 — the table and the store

> **Status: implemented.** See the Execution notes at the end for what actually
> happened, including where reality diverged from the plan. The steps below are
> the plan **as originally written**, kept unchanged on purpose — the execution
> notes argue against them, and that comparison only works if the original
> survives. They are a record, not a to-do list.

Add `activity_log` on both dialects, an `ActivityStore` over it, and update the
six places that do not update themselves. **Nothing observable changes at
runtime**: no writer and no reader exists until Phases 2 and 3.

> Read [`src/state/CLAUDE.md`](../../../apps/server/src/state/CLAUDE.md) before
> starting. It is the procedure; `spec/10-state.md` is the contract. This doc
> assumes both and only records what is specific to this table.

## The table

Append-only. Never updated, never deleted.

```ts
/**
 * The cross-cutting audit stream (issue #206) — one row per user-initiated
 * action, across the dashboard, CLI, Slack, GitHub and cron.
 *
 * COMPLEMENTS the per-run actor columns #205 put on `workflow_runs` and
 * `executions`; it does not replace them. Those stay the hot-path attribution
 * a run's detail view reads. This is the chronological stream that answers
 * "what has this person done?" without joining five ledgers.
 *
 * `actor_login` is free text soft-joined to `users.login`, deliberately
 * without a foreign key — the same additive-enrichment choice #205 made, so a
 * row survives an actor who never logged into the dashboard.
 */
export const activityLog = sqliteTable(
  "activity_log",
  {
    id: text("id").primaryKey(),                    // creationOrderedId()
    createdAt: text("created_at").notNull(),        // ISO-8601 text, both dialects
    actorLogin: text("actor_login"),                // null when the token carries no login
    actorType: text("actor_type").$type<TriggerActorType>(),
    action: text("action").notNull().$type<ActivityAction>(),
    targetType: text("target_type"),                // null for actions with no target (login)
    targetId: text("target_id"),
    outcome: text("outcome").notNull().$type<ActivityOutcome>(),
    detail: text("detail", { mode: "json" }).$type<ActivityDetail>(),
  },
  (t) => [
    index("idx_activity_created").on(sql`${t.createdAt} DESC`),
    index("idx_activity_actor_created").on(t.actorLogin, sql`${t.createdAt} DESC`),
    index("idx_activity_target").on(t.targetType, t.targetId),
  ],
);
```

The `pg.ts` mirror is name-parity: `jsonb` for `detail`, `.desc()` for the index
directions, a `/** @see sqlite.ts → \`activityLog\` */` header, and the **same
`$type<T>()` on every column** so the store-facing type is identical. Comments
live in `sqlite.ts`; the mirror carries only dialect-specific notes.

Three conventions this table follows because `src/state/CLAUDE.md:68` requires
them: **ISO-8601 `text` timestamps on both dialects** (never a native timestamp
type), **`text({mode:"json"})` / `jsonb` with a shared `$type<T>()`** for
`detail`, and **no `rowid`** — hence decision 4.

### Types

```ts
export type ActivityOutcome = "ok" | "denied" | "error";

/** Small, bounded, and never a payload — see the PII non-goal. */
export type ActivityDetail = Record<string, string | number | boolean>;
```

`actor_type` reuses #205's `TriggerActorType`
(`github | slack | cli | cron | admin | system`) rather than declaring a second
vocabulary — #206 asks for exactly this.

### Actions

Fourteen verbs, `<noun>.<verb>`. **These strings become data**, so they are the
first of the two open questions in the README.

| `action` | Written when | `target_type` |
|---|---|---|
| `login` | A dashboard session is established (password, GitHub OAuth, Slack OAuth) | — |
| `workflow.trigger` | A **human-actored** dispatch starts a run (decision 3) | `workflow_run` |
| `workflow.retry` | Dashboard/CLI retry of a run | `workflow_run` |
| `workflow.cancel` | Dashboard/CLI cancel of a run | `workflow_run` |
| `workflow.toggle` | A workflow's kill switch flips | `workflow` |
| `approval.approve` | A gate is approved — dashboard, Slack button, or GitHub comment | `approval` |
| `approval.reject` | A gate is rejected, same three routes | `approval` |
| `cron.fire` | A cron fires, scheduled or manual, `workflow:` or `handler:` | `cron` |
| `cron.trigger` | Someone presses "Run now" | `cron` |
| `cron.toggle` | A cron is enabled or disabled | `cron` |
| `config.edit` | A cron schedule override is set or cleared | `cron` |
| `container.kill` | A sandbox container is killed from the dashboard | `container` |
| `artifact.edit` | A build-artifact doc is overwritten | `repo` |
| `pr.retry` | A stuck PR is un-stuck via the admin route or CLI | `pr` |

`target_id` is the bare identifier — `<run id>`, `<cron name>`, `<owner>/<repo>`,
`<owner>/<repo>#<n>`. The `workflow_run:<id>` form in #206's body is how the
**API filter** spells a target, not how the columns store it; the store splits
on the first `:`.

## The store

`src/state/activity-store.ts`, modelled on `CronRunStore` — the closest existing
append-only ledger. **Do not use `FeedbackStore` as the template**: it imports
the sqlite schema directly and has no `tablesOf(client)` call, violating
`src/state/CLAUDE.md:155`. It gets away with it only because its tables carry no
boolean or JSON column, which this one does.

```ts
export class ActivityStore {
  /** Table objects for THIS client's dialect — see client.ts → tablesOf. */
  private readonly t: StateTables;
  constructor(private client: StateClient) { this.t = tablesOf(client); }

  async record(entry: ActivityEntry): Promise<void>;
  async list(opts: ActivityListOptions): Promise<{ activity: ActivityRecord[]; total: number }>;
  async actions(): Promise<string[]>;   // distinct verbs, for the filter dropdown
}
```

Pure single-table CRUD: it opens no transaction, so it takes no `dbc` parameter,
no `serialize`, and no collaborator stores — the same shape as `UserStore`
(`user-store.ts:66`). Every method opens with `const { activityLog } = this.t;`.

- **`record()`** — `creationOrderedId()` copied from `cron-run-store.ts:26`
  (`${hexMillis}-${counter}-${randomUUID()}`), `createdAt` stamped here so no
  caller can pass a clock. Explicit `.values({...})` mapping every field with
  `?? null` for absent optionals.
- **`list()`** — the `FeedbackStore.list` shape (`feedback-store.ts:410`): an
  `SQL[]` predicate array, `and(...)`, a `select({ c: count() })` over the
  **same** where clause for `total`, then
  `.orderBy(desc(createdAt), desc(id)).limit().offset()`. Filters: `actor`,
  `action`, `targetType` + `targetId`, `sinceIso`.
  **The `desc(id)` tiebreak is load-bearing** — decision 4.
- **`actions()`** — `selectDistinct` over `action`, ordered. No filter; the
  vocabulary is small and bounded.
- **`deserialize()`** — module-level, `nullsToUndefined(row)` (`client.ts:137`)
  then `?? undefined` per field, as `user-store.ts:279`.

No `select *` discipline problem here: every column is small by construction, so
`list()` may project the whole row (unlike `WorkflowRunStore.list`, which must
exclude `context`/`scratch`).

## Generate both dialects

```bash
pnpm --filter lastlight-core run db:generate:sqlite
pnpm --filter lastlight-core run db:generate:pg
```

Commit both generated `.sql` files **and** both `meta/_journal.json` updates,
unedited, **in the same commit**. Never hand-edit generated SQL; never point
`drizzle-kit push` at a database.

Note the Postgres consequence recorded at `src/state/CLAUDE.md:186`: now that a
production Postgres deployment exists, `0000_init.sql` is immutable exactly like
the SQLite baseline. This is a **new numbered pg migration**, never a
regenerated init — `db:generate:pg` does the right thing on its own; the risk is
a human deciding to tidy the single init file.

## The things that do not update themselves

`src/state/CLAUDE.md:133` names three. Two test constants and three prose counts
make six.

| # | File | Change |
|---|---|---|
| 1 | `src/state/data-migrate.ts` | `{ key: "activityLog", orderBy: ["id"] }` in `TABLE_ORDER`, after `users`. No FK, so placement is free. **The SQLite→Postgres copy refuses to start if this is missed** |
| 2 | `src/state/db.ts` | Re-export the types + class (`:30-56`); `readonly activity: ActivityStore` with a doc comment naming #206 (`:115-137`); `this.activity = new ActivityStore(_client);` in the private constructor (`:146-165`) |
| 3 | `spec/10-state.md` | A new `### activity_log` section in the house format — SQL block, "Why it exists", "Why not overload `executions`" — modelled on `cron_runs` at `:374`. Add the store to the table at `~:1051`. Change "fifteen tables" at `:30` |
| 4 | `tests/state/schema-equivalence.test.ts` | Add `"activity_log"` to `EXPECTED_TABLES` (`:40`, sorts first) **and** fix its docstring, which says "The 15 tables". Bump `MIGRATION_COUNT` `2 → 3` (`:32`) |
| 5 | `src/state/CLAUDE.md` | Line 3 says "fifteen tables"; add `activity-store.ts` to the `*-store.ts` file table |
| 6 | `apps/server/CLAUDE.md` | The `schema/sqlite.ts` line in the repo-layout tree says "all fifteen tables" and lists them |

## Tests

`tests/state/suites/activity-suite.ts`, registered in `tests/state/store-suite.ts`
alongside `runCronRunsSuite`:

```ts
export function runActivitySuite(makeDb: MakeDb, _opts: SuiteOpts): void {
```

**Never a standalone `*.test.ts`.** Suites live under `suites/` precisely so both
the SQLite and PGlite legs replay identical bodies; a `*.test.ts` would run the
SQLite leg only and the Postgres value-mapping bug this repo fears most would
sail through. All state function-scoped — two invocations can share a process.

Cover:

- Round trip: every field survives, including a `detail` object — **the JSON
  column is the dialect-divergent one** (`text` vs `jsonb`), so this is the
  assertion that earns the PGlite leg.
- `list()` filters individually and combined; `total` is the post-filter count,
  not the page length.
- **Page stability across a same-millisecond boundary**: insert >1 page of rows
  in one tick, page through, assert no row is skipped or repeated. This is the
  regression test for decision 4 and it fails without the `desc(id)` tiebreak.
- `actions()` returns distinct verbs.
- `null` actor round-trips as `undefined`, not `null` (the `nullsToUndefined`
  contract).

`schema-parity.test.ts` derives its table list from the schema exports, so it
covers the new table for free once both declarations exist.

## Verify

```bash
pnpm --filter lastlight-core run db:generate:sqlite
pnpm --filter lastlight-core run db:generate:pg
pnpm --filter lastlight-core test tests/state   # both legs; PGlite runs by default
pnpm --filter lastlight-core typecheck          # includes lint:promises
```

`PG_INTEGRATION=1` is only needed when `pg-client.ts` changes. It does not here.

## Done when

- Both schema files declare the table; both dialects have a committed migration
  and journal entry.
- `schema-parity`, `schema-equivalence` and both legs of the state suite pass.
- `spec/10-state.md` documents the table and the count reads sixteen everywhere.
- `db.activity` exists on `StateDb` and nothing calls it yet.

## Execution notes (26 Aug 2026)

Phase 1 landed. The schema, the store and the generated migrations went in as
planned — `pnpm --filter lastlight-core test tests/state` is green on both legs
(515 tests), and the full `turbo run typecheck test build` gate passes. Four
things the plan did not anticipate, all of them in the test layer:

- **"Three places do not update themselves" is six.** `src/state/CLAUDE.md:133`
  named `TABLE_ORDER`, `db.ts` and `spec/10-state.md`. Also required:
  `schema-equivalence.test.ts` (two constants **and** a structural change, next
  bullet), `schema-parity.test.ts`'s `covers all N tables`, and two counts in
  `data-migrate.test.ts`. Only the first three fail loudly; the rest fail as an
  off-by-one that reads like a bug in your change. **That checklist has been
  corrected to six in `src/state/CLAUDE.md`** — the most useful thing this phase
  produced for the next person.

- **`schema-equivalence.test.ts` needed restructuring, not a bumped count.** It
  asserted the schema is *identical* before and after boot, which was sound
  while every table came from the baseline. `activity_log` is the **first table a
  post-baseline migration creates**, so `before` and `after` are now legitimately
  different sets. Rather than weaken the assertion, the file now separates
  `LEGACY_TABLES` (the pre-Drizzle production shape the baseline must still
  no-op over) from a derived `EXPECTED_TABLES`, with `POST_BASELINE_TABLES` /
  `POST_BASELINE_INDEXES` naming the difference. The proof the file exists for is
  intact; it just distinguishes "added a table" from "altered a legacy one".
  Its `uniques` comparison needed the same treatment — a new table brings its own
  PK tuple, which is a new rule on a new table, not a change to an existing one.

- **`data-migrate.test.ts`'s guard fired exactly as designed.** Its comment reads
  *"The guard that stops a 16th table from being silently left behind"* — and it
  caught the 16th table. Beyond the count, `seed()` now inserts two
  `activity_log` rows, because `detail` is `text`→`jsonb` across the copy and a
  count assertion would not have exercised it. One row carries a nested object
  with a non-ASCII string, one carries no detail at all, so NULL is proven to
  survive as NULL rather than as `"null"`.

- **The store needed no `dbc` and no serializer**, as planned — but note the
  best-effort contract deliberately did **not** go here. `ActivityStore.record`
  throws like any other store method; the swallow lives one level up in Phase 2's
  `recordActivity()`. Putting it in the store would have made "a store failure
  never fails the action" untestable, because nothing could observe the failure.

One cosmetic artefact: `db:generate:sqlite` rewrote
`drizzle/sqlite/meta/_journal.json` without its trailing newline (the pg journal
never had one). Left as generated — §3 forbids hand-editing generated output.
