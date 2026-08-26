# State layer — schema, migrations, and the two dialects

This is the harness's own database: sixteen tables holding workflow runs,
executions, approvals, cron history, users, chat sessions, feedback signals and
the activity log.
It is written **once** and runs on **two dialects** — SQLite (via libsql) by
default, Postgres (node-postgres or Neon) when `DATABASE_URL` says so. Both are
supported production stores.

That duality is the whole difficulty of this directory. Almost every rule below
exists because a change that is obviously correct on one dialect is silently
wrong on the other.

> **Contract vs. guide.** [`spec/10-state.md`](../../spec/10-state.md) is the
> authoritative behavioural contract — the table-by-table schema, the split
> rule, the invariants. **This file is the procedure**: what to run, in what
> order, and what will bite you. When they disagree, the spec is right about
> *what the system does* and this file is right about *how to change it*.

## The one-paragraph version

Edit **both** `schema/sqlite.ts` and `schema/pg.ts`. Run **both** generators.
Commit the generated SQL **unedited**. Never point `drizzle-kit push` at a real
database. Then run the tests: `schema-parity` proves the two declarations match,
and the PGlite leg replays the entire behavioural suite against real Postgres.

## Files

| File | Role |
|---|---|
| `db.ts` | `StateDb` — the async factory (`await StateDb.open(url)` / `StateDb.fromClient(client, dialect)`; **no public constructor**). Picks the engine off the URL, runs that dialect's migrator, wires the stores together, and is the single import surface for their types. Every store method returns a `Promise`. |
| `client.ts` | The Drizzle client type, `tablesOf(client)`, and the **connection-scoped** op serializer the nine transaction sites share. |
| `dialect.ts` | The portability seam — everything that genuinely differs between the dialects. Reaching around it is a portability bug. |
| `schema/sqlite.ts` | The Drizzle schema. **The source of truth**, and the only one any store may import. |
| `schema/pg.ts` | The name-parity `pgTable` mirror. **Nothing under `src/` may import it** except `pg-client.ts`. |
| `pg-client.ts` | The production Postgres client factory — node-postgres or Neon behind one `PgClientHandle`, each **dynamically** imported inside its own builder. Registers the int8 parser. The one module allowed to import `schema/pg.ts`. |
| `legacy-sqlite.ts` | Idempotent pre-migrator compat step for SQLite deployments older than the baseline. sqlite-only, PRAGMA-guarded. |
| `data-migrate.ts` | One-way SQLite → Postgres row copy, FK-ordered and batched. `TABLE_ORDER` is the FK order; the coverage check is what stops a sixteenth table being silently skipped. |
| `state-cli.ts` | The `lastlight-state` bin (`check` / `migrate`) shipped in the agent image — what `lastlight server db` runs inside the container, since the CLI may never gain an edge to core. |
| `*-store.ts` | One store class per table, over one shared client. Each destructures its tables from `tablesOf(client)`. |
| `activity-store.ts` | The `activity_log` audit stream (issue #206) — one row per user-initiated action, append-only. Complements #205's per-run actor columns rather than replacing them. |
| `repo-ref.ts` | The single expression of the `(owner, BARE repo)` ↔ `owner/repo` join. |

Generated migrations live **outside** `src/`, in
[`apps/server/drizzle/`](../../drizzle) (`sqlite/` and `pg/`, each with its own
`meta/` journal). They ship in both the npm tarball and the docker image via
`package.json`'s `files` field — removing `"drizzle"` from it is a boot-time
crash in both.

## Changing the schema

### 1. Edit both schema files

A change to `schema/sqlite.ts` that is not mirrored into `schema/pg.ts` fails
`tests/state/schema-parity.test.ts`, which compares names, nullability, primary
keys and index structure across both declarations.

What the parity test deliberately **does not** compare — do not "fix" these into
it:

- **Column types.** `jsonb`-vs-`text` and `boolean`-vs-`integer` divergence *is
  the point* of having two schemas. Keep the same `$type<T>()` on both so the
  store-facing type is identical.
- **Index direction modifiers.** pg-core has a real `.desc()`; sqlite-core has
  no such API and spells it as a `sql` expression the direction can't be read
  back from.
- **Partial-index `WHERE` text** (`active = 1` vs `active`) and **default
  values** (`'[]'` vs `'[]'::jsonb`) — presence is compared, spelling is not.

Conventions that keep the two honest:

- **Timestamps are ISO-8601 `text` in both dialects.** Lexicographic ordering,
  dialect-neutral bucketing, zero data migration. Do not reach for a native
  timestamp type.
- **JSON columns** are `text({ mode: "json" })` on sqlite and real `jsonb` on
  Postgres, with the same `$type<T>()`.
- **No `rowid`.** Postgres has no equivalent. Tie-break on `id`.

### 2. Generate both dialects

```bash
pnpm --filter lastlight-core run db:generate:sqlite   # → drizzle/sqlite/
pnpm --filter lastlight-core run db:generate:pg       # → drizzle/pg/
```

These read `drizzle-sqlite.config.ts` / `drizzle-pg.config.ts` at the package
root (deliberately outside `tsconfig.json`'s `src/**` include, so `build` never
compiles them). Each writes a new numbered `.sql` file **and** an entry in that
dialect's `meta/_journal.json`. Commit all of it.

**Both, always, in the same commit.** A migration generated for one dialect and
not the other is not a partial change — it is a deployment on the other dialect
that boots against a schema its code no longer matches.

### 3. Never hand-edit generated SQL

One documented exception exists and will not be repeated:
`drizzle/sqlite/0000_baseline.sql` was hand-edited so every statement carries
`IF NOT EXISTS`, because it had to no-op over a real production database that
predates the journal. That is a baseline-over-legacy problem, and it is solved.

**Additive only: never drop, never narrow, never rename.** Long-running
deployments accumulate schema and both dialects handle it. Adding a nullable
column is safe; the alternatives are not.

### 4. Never `drizzle-kit push` at a real database

`push` diffs the declared schema against the live one and emits `DROP` for
anything it doesn't recognise. Production carries two orphan tables from the
pre-Drizzle migrator (`rate_limits`, `system_status`) that nothing in the tree
declares or reads — `push` would delete them, and whatever else it hasn't been
told about. Generated migrations only.

### 5. Run the tests

```bash
pnpm --filter lastlight-core test tests/state
```

Four guards, each catching a different class of drift:

| Guard | Catches |
|---|---|
| `schema-parity.test.ts` | A column or index added to one schema and not the other — named by table and side, before the PG leg fails somewhere less legible. |
| `db.pg.test.ts` + `session-manager.pg.test.ts` | The **PGlite leg**: the entire behavioural suite replayed against real Postgres compiled to WASM, hermetically, in the default test command. |
| `db.pg-server.test.ts` | The **real-server leg** — opt-in via `PG_INTEGRATION=1`, its own CI job. PGlite proves the *dialect*, not the *driver*. |
| `schema-equivalence.test.ts` | That the SQLite baseline still no-ops over the real pre-Drizzle production shape (reconstructed from `fixtures/legacy-schema.sql`). Bump its `MIGRATION_COUNT` when you add a sqlite migration — it is deliberately not derived from the journal. |

Behavioural tests go in `tests/state/suites/*.ts`, **not** in a `*.test.ts` of
their own. `store-suite.ts` is dialect-parameterized, so both legs run the
*identical* test bodies rather than a hand-maintained subset that quietly
diverges. All state must be function-scoped — two invocations can share one
process.

### 6. If you added a table

Six places do not update themselves. The first three fail loudly; the rest are
hardcoded counts that fail as an unhelpful off-by-one, so know them in advance:

1. **`data-migrate.ts`'s `TABLE_ORDER`** — the SQLite→Postgres copy refuses to
   start if a schema export is missing from it, so this fails loudly rather than
   losing data. Place it after anything it references by foreign key.
2. **`db.ts`** — wire the store in.
3. **`spec/10-state.md`** — the table inventory and the count.
4. **`tests/state/schema-equivalence.test.ts`** — add the table to
   `POST_BASELINE_TABLES` (plus its named indexes to `POST_BASELINE_INDEXES`),
   and bump `MIGRATION_COUNT`. **Do not add it to `LEGACY_TABLES`**: that list is
   the pre-Drizzle production shape, and the whole point of the first test is
   that the baseline no-ops over it. A new table is a *difference* between
   `before` and `after`, which is why those two lists exist separately at all.
5. **`tests/state/schema-parity.test.ts`** — the `covers all N tables` count.
6. **`tests/state/data-migrate.test.ts`** — two counts (`TABLE_ORDER` length and
   `result.tables` length), and ideally a row in `seed()` so the copy is actually
   exercised for the new table rather than merely counted.

`schema-parity.test.ts` otherwise derives its table list from the schema
exports, so the per-column and per-index parity checks cover a new table for
free once both declarations exist.

## Why `db.pg-server.test.ts` exists

PGlite parses `int8` to a JS number itself, so it **cannot** catch a missing
`setTypeParser(20, …)` — without which every `COUNT(*)` / `SUM()` arrives as a
**string** and the stats rollups concatenate instead of adding. It is also
single-connection, so the pool, the real `.rowCount`, and the SQLSTATE `23505`
unique-violation shape are only exercised against a real server.

If you touch `pg-client.ts`, run that leg.

## The rules that are load-bearing

- **`schema/pg.ts` has exactly one importer under `src/`: `pg-client.ts`.** It
  needs it to build the client — `tablesOf()` reads the schema back off the
  Drizzle instance, and one built with the *sqlite* schema would send `1` into a
  `boolean` and `JSON.parse` an already-parsed `jsonb` value. A store must
  destructure from `tablesOf(client)` instead of importing a schema directly.
  `driver-isolation.test.ts` pins this.
- **Both Postgres drivers are dynamically imported**, inside their own builder in
  `pg-client.ts`, itself reached only from `open()`'s postgres branch. So a
  SQLite deployment loads neither, and a node-postgres deployment never loads the
  Neon driver. That property is carried entirely by four `await import()`s — a
  refactor hoisting any of them to a static import breaks it while every test
  still passes and the app still works. Same test pins it.
- **`drizzle-orm/neon-http` is not an option.** It cannot run interactive
  transactions, so the nine transaction sites would type-check, pass a smoke
  test, and silently stop being atomic.
- **`asStateClient()` is not a portability seam — it is a silenced type error.**
  The query-builder *surface* is identical across drivers so the cast compiles;
  per-column *value mapping* is not, and does not go through `dialect.ts`.
- **`:memory:` is unsafe for anything that transacts.** The libsql local client
  hands its single connection to `client.transaction()` and lazily opens a *new*
  one for the next query — against `:memory:` that is a fresh, empty database, so
  the store silently vanishes after the first commit. Use `makeTestDb()`
  (`tests/helpers/state-db.ts`), a per-test temp file.
- **The op serializer is connection-scoped, and it — not `busy_timeout` — is the
  concurrency defence.** `busy_timeout` does not survive a transaction.
- **`tsc` cannot see a dropped promise.** Every store method is async now.
  `!promise` is always `false`, and TS2801 fires only on the bare `if (promise)`
  form; the Drizzle migration shipped 14 such bugs through a clean compiler.
  `lint:promises` (run by `typecheck`) is the guard — keep it passing rather than
  reaching for a grep.

## Known stale comment

`drizzle-pg.config.ts` still says `drizzle/pg/` "targets FRESH databases only (a
PGlite instance per test)" and that there is "no legacy story here". That was
true in #351, when Postgres existed only for tests. **#352 made Postgres a
production runtime and did not update the comment.**

The practical consequence, once a Postgres deployment exists in the wild: its
`__drizzle_migrations` records `0000_init`, so `0000_init.sql` becomes
**immutable** exactly like the sqlite baseline. A schema change is a *new*
numbered pg migration, never a regenerated `0000_init` — `db:generate:pg` does
the right thing on its own here; the risk is a human deciding to "clean up" the
single init file. The rest of the comment (generated output committed as
generated, hand-editing forbidden) still holds.

## Moving a deployment SQLite → Postgres

Operator-facing, not a schema task — full contract in
[`spec/10-state.md`](../../spec/10-state.md) → "Moving an existing database to
Postgres".

```bash
lastlight server db check                  # can the agent reach the server?
lastlight server db migrate --dry-run      # per-table row counts, writes nothing
lastlight server db migrate                # copy, then verify counts
```

It runs **inside the agent image** (`packages/cli` may never gain an edge to
`lastlight-core`, where the drivers and schemas live). With no `--to`, the
container's own `DATABASE_URL` is the target, so the credential never reaches
the host's process list. It refuses to run while the agent is up — a concurrent
writer produces a target that is quietly short of rows.
