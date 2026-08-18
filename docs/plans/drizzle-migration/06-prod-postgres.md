# Phase 6 — Production Postgres runtime (operator-selectable DB)

Risk: **medium**. Phases 1–5 shipped in **v0.26.0** and built the whole
dual-dialect machinery, but deliberately **reserved** the Postgres runtime:
`pg` stays out of runtime deps and
`StateDb.open()` *throws* on a `postgres://` URL — Postgres is proven only
against **PGlite (WASM) in CI**. This phase **activates** that reserved slot so
an operator can set `DATABASE_URL=postgres://…` (or `database.url` in the
overlay) and run Last Light on a real Postgres server in production — the
"users choose their DB, like finius" goal.

The Postgres runtime is **driver-selectable**: the same `postgres://` dialect
runs over standard **node-postgres** (default — self-hosted PG and most managed
services: RDS, Cloud SQL, Supabase's pooler, etc.) OR over **Neon's serverless
driver** (`drizzle-orm/neon-serverless`) for serverless/edge Postgres. Both
produce the identical Drizzle `PgDatabase` query surface behind the existing
`"postgres"` dialect seam, so **store code and the dialect seam are unchanged** —
only client construction differs (see §1a). Adding a driver is how future hosts
(e.g. Cloudflare Hyperdrive, other WebSocket-pooled PG) drop in without a second
rewrite.

> This phase amends **locked decision 3** (originally "test-only PG"). The
> extension is deliberate — see README.md's decision list. Everything here is
> **additive on top of merged phases 1–5**; the sqlite/libsql production path is
> unchanged and remains the default.

Read [README.md](README.md), [00-architecture.md](00-architecture.md), and
[04-postgres-pglite.md](04-postgres-pglite.md) first. Line references were
accurate at planning time — trust the described pattern over any drifted line
number.

## Goal

After this phase:

- `StateDb.open("postgres://…")` builds a real Postgres pool client — via
  node-postgres **or** the Neon serverless driver, chosen per §1a — runs the
  `drizzle/pg/` migrator against it, and returns a working `StateDb` (dialect
  `"postgres"`) — no longer throws.
- `pg` (node-postgres) and `@neondatabase/serverless` are **runtime
  dependencies**, each imported **lazily in its own driver branch only** — a
  SQLite deployment loads neither, and a node-postgres deployment never loads the
  Neon driver (and vice-versa).
- The **full state test suite runs green against a real Postgres server** (not
  just PGlite) — the same `runStateDbSuite` (all 8 tables incl. `users`),
  exercising the node-postgres driver, connection pool, real
  transactions, int8 handling, and unique-violation detection end-to-end.
- Credentials in `database.url` are redacted from the dashboard `/config` view.
- **`lastlight server setup` offers the choice** (§7a) — SQLite by default,
  external Postgres on request, with the URL written to the gitignored
  `secrets/.env` and never to the version-controlled overlay `config.yaml`.
  Without this the runtime is selectable only by an operator who reads the
  docs; the wizard is how most instances get installed.
- Docs describe Postgres as a supported production runtime; a minor npm release
  + GHCR image rebuild ships it.
- **Backward compatible**: absent `DATABASE_URL`/`database.url`, behavior is
  byte-identical to the sqlite path from Phase 5.

## Preconditions

- **All satisfied as of 2026-08-18** — Phases 1–5 shipped in **v0.26.0** (PR
  #351) and drizby prod has been running the Drizzle engine since. Re-verify
  green before starting (`pnpm turbo run typecheck test build`; the baseline on
  `main` at v0.26.0 is **207 test files / 3,446 tests**), then treat the rest of
  this list as context rather than as gates.
- Phases 1–5 all ticked in [README.md](README.md); `main` carries the merged
  Drizzle engine and is green
  (`pnpm --filter lastlight-core build && pnpm --filter lastlight-core test`).
- `apps/server/src/state/db.ts` has the async `StateDb.open(pathOrUrl)` from
  Phase 5 with the Phase-4 `postgres://` **throw** still in place (this phase
  replaces it).
- `apps/server/src/state/client.ts` exports `asStateClient()` + the `Dialect`
  type; `apps/server/src/state/dialect.ts` exports `changes()` /
  `isUniqueViolation()` written to
  cover node-postgres shapes (per 04's design — verify here against the real
  driver).
- `apps/server/drizzle/pg/0000_init.sql` (+ `meta/`) exists and is committed
  (Phase 4).
- `config.database.url` slot resolves env > overlay > default and feeds
  `StateDb.open(config.database.url ?? config.dbPath)` at
  `apps/server/src/index.ts` (Phase 5).

## Files

| File | Action |
|---|---|
| `apps/server/src/state/pg-client.ts` | create — `makePgClient(url, driver)`: dispatches to the node-postgres or neon-serverless builder; int8 parser + drizzle wrap |
| `apps/server/src/state/db.ts` | edit — replace the Phase-4 `postgres://` throw with a real branch; resolve the driver; `close()` drains the pool |
| `apps/server/src/state/dialect.ts` | verify (edit only if needed) — `changes()`/`isUniqueViolation()` on node-postgres **and** neon-serverless (both surface `.rowCount` / SQLSTATE `23505`) |
| `apps/server/src/config/config.ts` | edit — redact credentials in `database.url` from `publicConfig`; resolve `database.driver` |
| `packages/cli/src/setup.ts` | edit — the `collectDatabase()` wizard step (§7a); the URL rides `buildEnvContent()`, **never** `buildOverlayConfig()` |
| `packages/cli/CLAUDE.md`, `apps/server/plugins/lastlight/skills/lastlight-server/SKILL.md` | edit — both enumerate the wizard's prompts (§7a) |
| `apps/server/tests/state/db.pg-server.test.ts` | create — real-Postgres integration leg (opt-in, node-postgres) |
| `apps/server/package.json` | `pg` **and** `@neondatabase/serverless` under **dependencies**; `@testcontainers/postgresql` under devDependencies |
| `.github/workflows/ci.yml` (or equiv) | add real-PG job/service |
| `apps/server/spec/10-state.md`, `apps/server/CLAUDE.md`, `apps/server/config/default.yaml` comment, `apps/server/.env.example` | docs |

## 1. `src/state/pg-client.ts` — real Postgres client factory

One factory, two driver builders. Both return the same `PgClientHandle`
(`StateClient` + `close()`); the caller (`db.ts`, §2) passes a resolved
`driver`. Each builder's driver-specific imports are **dynamic inside the
builder** so only the selected driver is ever loaded.

```ts
// Production Postgres client. Imported ONLY from StateDb.open()'s postgres
// branch (lazy) so sqlite deployments never load any pg driver. PGlite (the
// test leg) constructs its own client in tests/ — this file is for the real
// server path. Each builder dynamically imports its own driver so a
// node-postgres deployment never pulls in @neondatabase/serverless (or vice-versa).
import { asStateClient, type StateClient } from "./client.js";

export type PgDriver = "pg" | "neon";

export interface PgClientHandle {
  client: StateClient;
  close(): Promise<void>;
}

// node-postgres — standard TCP pool. Default for self-hosted + most managed PG.
async function makeNodePgClient(url: string, poolMax: number): Promise<PgClientHandle> {
  const pg = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  // int8 (OID 20): node-postgres returns COUNT(*)/SUM(...) as a STRING by
  // default. The stores expect numbers (PGlite already parses int8 → number, so
  // the PGlite leg does NOT catch this — node-postgres-specific, called out in
  // 04-postgres-pglite.md §"int8-as-string" + asStateClient()'s doc comment).
  pg.types.setTypeParser(20, (v: string) => Number(v));
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  return { client: asStateClient(drizzle(pool)), close: () => pool.end() };
}

// Neon serverless — WebSocket pool. For Neon (and other WebSocket-pooled PG).
// MUST be the serverless (WebSocket) driver, NOT neon-http: the HTTP driver
// cannot run interactive/session transactions, and our five named atomic ops
// require `client.transaction(async tx => …)` (locked decision 2).
async function makeNeonClient(url: string, poolMax: number): Promise<PgClientHandle> {
  const { Pool, types } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-serverless");
  types.setTypeParser(20, (v: string) => Number(v)); // same int8→number fix
  const pool = new Pool({ connectionString: url, max: poolMax });
  return { client: asStateClient(drizzle(pool)), close: () => pool.end() };
}

export function makePgClient(
  url: string,
  driver: PgDriver,
  opts?: { poolMax?: number },
): Promise<PgClientHandle> {
  const poolMax = opts?.poolMax ?? 10;
  return driver === "neon" ? makeNeonClient(url, poolMax) : makeNodePgClient(url, poolMax);
}
```

Notes:
- `drizzle-orm/node-postgres`, `.../neon-serverless`, and their `/migrator`
  entrypoints all ship inside the already-pinned stable `drizzle-orm` (no new
  drizzle dep) — only the underlying drivers (`pg`, `@neondatabase/serverless`)
  are new runtime deps, each loaded lazily by its builder.
- Both drivers surface aggregates as int8 strings and need the OID-20 parser;
  the parser call is process-global (the process talks to one DB) — harmless. If
  a future OID surprises (e.g. `numeric`/1700 from `AVG`), prefer a defensive
  `Number()` in `dialect.ts`'s aggregate helpers over widening the global parser.
- **Neon over WebSocket** gives a real pooled connection with session
  transactions — a drop-in for `pg.Pool` at the Drizzle layer. The Neon
  `Pool`'s `rowCount` and `23505` error shape match node-postgres, so
  `dialect.ts`'s `changes()` / `isUniqueViolation()` cover it unchanged (verify
  in §3). Do **not** reach for `drizzle-orm/neon-http` as a "simpler" option —
  it silently loses transactions.

## 1a. Driver selection (`database.driver`)

The dialect stays `"postgres"` for both drivers; the driver is a separate,
narrow choice resolved in `db.ts`'s postgres branch:

- Config slot **`database.driver: "pg" | "neon"`** (env `DATABASE_DRIVER`),
  resolved env > overlay > default through the same generic resolver as
  `database.url` (Phase 5).
- **Default = auto-detect from the URL host** when `database.driver` is unset:
  a host matching `*.neon.tech` (or a `?…&sslmode=` Neon-style pooler host)
  selects `"neon"`, everything else `"pg"`. An explicit `database.driver` always
  wins over the heuristic (so a Neon URL fronted by a non-`.tech` custom domain,
  or forcing node-postgres against Neon's TCP endpoint, both work).
- Keep it small: a `resolvePgDriver(url, configured?)` pure helper (unit-tested
  on a table of host → driver cases) beside `makePgClient`.

## 2. `src/state/db.ts` — activate the postgres branch

Replace the Phase-4 guard (04 §5, the "PG runtime not enabled" `throw`) with a
real branch, ahead of the sqlite path/URL normalization (locked decision 9):

```ts
static async open(
  pathOrUrl: string,
  opts?: { poolMax?: number; driver?: PgDriver },
): Promise<StateDb> {
  if (/^postgres(ql)?:\/\//i.test(pathOrUrl)) {
    const { makePgClient, resolvePgDriver } = await import("./pg-client.js"); // lazy
    const driver = resolvePgDriver(pathOrUrl, opts?.driver);                  // pg | neon
    // per-driver migrator — both fed the same drizzle/pg baseline
    const { migrate } = driver === "neon"
      ? await import("drizzle-orm/neon-serverless/migrator")
      : await import("drizzle-orm/node-postgres/migrator");
    const handle = await makePgClient(pathOrUrl, driver, opts); // out of sqlite path
    const migrationsFolder = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));
    await migrate(handle.client as never, { migrationsFolder });
    const db = StateDb.fromClient(handle.client, "postgres");
    db.#onClose = handle.close;   // wired so close() drains the pool
    return db;
  }
  // …existing sqlite normalization (:memory:, file:, bare path) unchanged…
}
```

- The `driver` comes from `opts.driver` (← resolved `config.database.driver` at
  `index.ts`, Phase 5's wiring extended with the one extra field) or, unset,
  `resolvePgDriver`'s URL heuristic (§1a).
- `close()` becomes: `await this.#onClose?.(); …` (drains the pool on PG —
  `pool.end()` for both drivers; no-op-ish on sqlite where libsql closes its client).
- `migrationsFolder` uses the **same module-relative `../../drizzle/pg`** pattern
  the sqlite side uses for `../../drizzle/sqlite` — resolves correctly from
  `src/state/`, `dist/state/`, and the installed npm package (Phase 5's path
  trace applies identically; `drizzle/pg/` already ships in npm `files` +
  Dockerfile `COPY drizzle/`).
- **Do not** import `pg-client.js` or `node-postgres/migrator` at module top —
  the dynamic `import()` is what keeps `pg` out of every sqlite deployment's
  runtime graph.

## 3. Verify the dialect seam on the real driver

`dialect.ts` was written (Phase 2b/4) to cover node-postgres, but only PGlite
exercised it so far. Confirm against the real driver — the integration leg
(§4) is the real test, but eyeball these two (they hold for **both** node-postgres
and neon-serverless, which share `.rowCount` and the `23505` error shape):

- `changes(result)` reads node-postgres's `.rowCount` for the five compare-and-set
  atomic ops. A miss shows up as approval/reply-gate tests failing `undefined !== 1`.
- `isUniqueViolation(err)` walks `DrizzleQueryError.cause` for SQLSTATE `23505`
  (node-postgres surfaces `err.code === "23505"`). Drives
  `SessionManager.getOrCreateSession`'s concurrent-insert re-read (decision 11).

## 4. `tests/state/db.pg-server.test.ts` — real-Postgres integration leg

PGlite proves the **dialect**; it does not prove the **driver / pool /
transaction** path. Run the *same* Phase-3 suite against a real Postgres:

```ts
import { describe } from "vitest";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { makePgClient } from "../../src/state/pg-client.js";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { StateDb } from "../../src/state/db.js";
import { runStateDbSuite } from "./store-suite.js";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));

// Opt-in: only runs when Docker is available (CI service or PG_INTEGRATION=1),
// mirroring how the sandbox/docker integration tests gate themselves. Default
// `pnpm --filter lastlight-core test` stays hermetic (PGlite leg covers the dialect).
const enabled = process.env.PG_INTEGRATION === "1";

describe.skipIf(!enabled)("StateDb on real Postgres (node-postgres)", () => {
  // one container for the file; each makeDb() gets a fresh SCHEMA (or DATABASE)
  // so the runStateDbSuite pristine-per-call contract holds.
  runStateDbSuite(/* makeDb backed by PostgreSqlContainer + makePgClient + migrate */,
    { dialect: "postgres" });
});
```

- **Pristine-per-call**: reuse one container, but hand each `makeDb()` a fresh
  Postgres **schema** (`CREATE SCHEMA t_<n>; SET search_path`) or a fresh
  database — cheaper than a container per test, satisfies the Phase-3 contract.
- **Include the concurrency-probe / mutex test (decision 8)** here — the five
  named atomic ops under a *real connection pool* is the highest-value assertion
  this leg adds over PGlite (PGlite is single-connection).
- Assert `close()` drains the pool (no leaked handles → vitest exits clean).
- **The Neon driver is intentionally NOT in the default CI leg** — it needs a
  real Neon endpoint (or Neon's local `wsproxy`), which is not worth wiring into
  every CI run. It's a thin swap of `pg.Pool` for the Neon `Pool` under the same
  Drizzle `PgDatabase` (the node-postgres leg already proves the dialect + the
  atomic ops over a pool), so cover it by: (a) unit-testing `resolvePgDriver`'s
  host→driver table, and (b) a documented manual smoke against a free Neon dev
  branch (`DATABASE_URL=postgres://…neon.tech/… DATABASE_DRIVER=neon`, boot →
  migrate → a trivial run). Optionally an opt-in `NEON_INTEGRATION=1` leg pointed
  at `@neondatabase/serverless`'s local WebSocket proxy — nice-to-have, not
  required to tick this phase.

## 5. CI

Add a dedicated job (do **not** slow the default suite):

```yaml
pg-integration:
  runs-on: ubuntu-latest
  services:
    postgres:
      image: postgres:16
      env: { POSTGRES_PASSWORD: postgres }
      ports: ["5432:5432"]
      options: >-
        --health-cmd "pg_isready" --health-interval 5s
        --health-timeout 5s --health-retries 5
  steps:
    - # …checkout, pnpm install, build…
    - run: PG_INTEGRATION=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres pnpm --filter lastlight-core exec vitest run tests/state/db.pg-server.test.ts
```

(Testcontainers path needs Docker-in-Docker; the `services:` Postgres above is
simpler on GitHub runners — point the test at `DATABASE_URL` when set, else spin
a container locally. Pick one; the `services:` form is recommended for CI.)

## 6. `src/config/config.ts` — redact credentials

Phase 5 left a tripwire: `SENSITIVE_KEY_RE` doesn't match `url`, so
`database.url` is echoed by the dashboard `/config` provenance view. A
`postgres://user:pass@host/db` URL carries credentials — redact it from
`publicConfig`:

- Mask the userinfo when building `publicConfig` (`postgres://***:***@host/db`),
  OR add the `database.url` leaf to the sensitive matcher. Masking-userinfo is
  preferable — it keeps the non-secret host/db visible for provenance debugging.
- `file:` URLs and `:memory:` are non-secret — leave them visible.
- Add a config test: a `postgres://u:p@…` value is masked in `publicConfig`; a
  `file:` value is not.

## 7. Config surface, deployment docs

The `database.url` slot itself needs no wiring change (Phase 5). Additions:

- **`database.driver` slot**: `"pg" | "neon"` (env `DATABASE_DRIVER`) through the
  same generic resolver; unset → the §1a URL heuristic. Non-secret — surfaced in
  `/config` provenance like the other slots.
- **Optional pool knobs**: `database.poolMax` (+ maybe connect timeout) through
  the same generic resolver, defaulting sanely (`makePgClient` reads them).
  Small; skip if not wanted.
- **`config/default.yaml`** comment: update the Phase-5 note that said
  "postgres:// is recognized but throws at boot" → now a supported runtime
  (external/managed Postgres; set `DATABASE_URL` or `database.url`, optionally
  `DATABASE_DRIVER=neon` for Neon serverless).
- **`.env.example`**: update the `DATABASE_URL` note the same way; add both a
  standard `postgres://` example and a Neon (`…neon.tech`) one with
  `DATABASE_DRIVER=neon`.
- **Deployment docs**: document the simplest path (point at an external/managed
  Postgres via `DATABASE_URL`); call out **Neon** as a first-class option
  (serverless Postgres, `DATABASE_DRIVER=neon` — auto-detected for `*.neon.tech`
  hosts) and optionally an opt-in `docker-compose` `postgres` service profile for
  self-hosters. **State the single-writer constraint**: Last Light runs one
  instance and the five atomic ops rely on an in-process mutex (decision 8) —
  Postgres here is a storage choice, **not** multi-instance HA (this is also why
  Neon's `neon-http` per-request model buys us nothing and its transaction loss
  would break the atomic ops — §1).

## 7a. `lastlight server setup` — offer the choice in the wizard

Phases 1–5 deliberately add **no CLI surface**: with `postgres://` throwing at
boot there is no choice to present. This phase creates one, and an operator who
only ever meets Last Light through `lastlight server setup` would otherwise
never learn it exists — the wizard is the install path in
`packages/cli/CLAUDE.md` and the `lastlight-server` skill.

**One prompt, defaulting to today's behaviour.** Slot it into
`packages/cli/src/setup.ts` after `collectManagedRepos()` and before
`collectModelAndKey()` — infrastructure questions before model questions,
matching the existing order.

```ts
async function collectDatabase(): Promise<{ url?: string; driver?: PgDriver }> {
  p.log.step(gold("State database"));
  const choice = await p.select({
    message: "Where should Last Light keep its state?",
    options: [
      { value: "sqlite", label: "SQLite (recommended)",
        hint: "a file in the agent-data volume; nothing to run" },
      { value: "postgres", label: "External Postgres",
        hint: "you supply a server — managed, self-hosted, or Neon" },
    ],
    initialValue: "sqlite",
  });
  if (choice !== "postgres") return {};                     // ← the whole slot stays absent
  const url = required(await p.text({
    message: "DATABASE_URL",
    placeholder: "postgres://user:pass@host:5432/lastlight",
    validate: (v) => /^postgres(ql)?:\/\//i.test(v ?? "") ? undefined
      : "Must be a postgres:// URL. Leave the DB choice on SQLite to use a file.",
  }));
  return { url, driver: resolvePgDriver(url) };             // reported, not asked
}
```

Four rules, each of which is a bug if broken:

1. **The Postgres URL goes in `instance/secrets/.env`, NEVER in
   `instance/config.yaml`.** `database.url` is a YAML-resolvable slot, so
   writing it to the overlay is the obvious move and it is **wrong**: the
   wizard offers to create a **GitHub repo from `instance/`** at the end of
   setup, and `buildOverlayConfig()`'s output is the file that gets committed.
   A `postgres://user:pass@host/db` there is a credential pushed to a git
   remote. `.env` lives under the overlay's gitignored `secrets/`, which is
   where every other credential the wizard collects already goes. So this is
   the one config slot the wizard fills through `buildEnvContent()` rather than
   `buildOverlayConfig()` — say so in a comment at both functions, because the
   asymmetry looks like an oversight.
2. **SQLite writes nothing at all** — no `DATABASE_URL` line, no
   `database:` block. The slot resolves to `file:` + `dbPath` by absence
   (Phase 5 §1), and an emitted `DATABASE_URL=file:./data/lastlight.db` would
   pin a path that `STATE_DIR` is supposed to move. Existing `.env` files
   written by older wizards must keep working untouched; this is guaranteed by
   writing nothing.
3. **`--yes` (non-interactive) takes SQLite** without prompting, like the
   other `opts.yes` branches (`packages/cli/src/setup.ts`, the build/launch
   confirm). CI and scripted installs must not acquire a new required answer.
4. **Do not ask for the driver.** `resolvePgDriver` (§1a) reads it off the
   host, so the wizard *reports* it (`p.log.info("Driver: neon (detected from
   *.neon.tech)")`) and writes `DATABASE_DRIVER` only when the operator's URL
   forces the non-obvious answer. A second prompt buys nothing an operator can
   answer better than the heuristic can, and `.env` remains hand-editable for
   the exotic case.

**Connectivity check before the wizard moves on.** The wizard already validates
what it can (the PEM resolves, the domain parses). A wrong `DATABASE_URL` is
strictly worse than those, because it surfaces as a **container that boots and
dies** several minutes later at the "Build and launch" step, long after the
context is gone. Open a connection, run `select 1`, close it — and on failure
offer *retry / re-enter / continue anyway* rather than aborting, since a
firewall rule the operator is about to add is a legitimate reason to proceed.
The CLI cannot `import "pg"` for this: `packages/cli` has no edge to
`lastlight-core` and must not grow one (a dep-cruiser gate, root `CLAUDE.md`).
Options, in order of preference:

- Skip the live check and lean on the `p.text` regex + a printed reminder. Cheap,
  honest, and one release later than ideal.
- Have `lastlight server setup` run the probe **inside the agent image it is
  about to launch** (`docker run --rm --entrypoint node lastlight-agent …`),
  which is where `pg` legitimately lives. No new CLI dependency, exercises the
  real driver and the real network path from the real container.

The second is preferable and is *not* free — cost it before committing to it.

**Also update**, in the same commit:

- `packages/cli/CLAUDE.md` — the `server setup` command entry gains the
  database step.
- `apps/server/plugins/lastlight/skills/lastlight-server/SKILL.md` — the
  install skill walks an agent through the same wizard and enumerates its
  prompts; a new prompt it doesn't know about makes it narrate the wrong
  sequence.
- `packages/cli/tests/` — a unit test that `buildEnvContent()` emits
  `DATABASE_URL` for the postgres answer and **nothing** for the sqlite answer,
  and that `buildOverlayConfig()` never contains `postgres://` for either.

## 8. Data migration (sqlite → postgres) — OUT OF SCOPE (optional follow-on)

"Users choose their DB" is satisfied for **fresh deployments** by §§1–7 (start
empty on Postgres). Migrating an *existing* SQLite DB into Postgres is a
separate, optional effort — **do not block this phase on it**:

- Ship later as a standalone CLI (`lastlight state migrate --from file:… --to
  postgres://…`) that streams rows table-by-table through the Drizzle schema.
  Identical `$type<T>` on both dialects makes it a read-sqlite / insert-pg loop,
  FK-ordered (`messaging_sessions`→`messaging_messages`,
  `workflow_runs`→`executions`→`workflow_approvals`).
- Existing prod (drizby/nearform) stays on sqlite/libsql unless/until someone
  wants to switch; that's when this tool gets built.

## 9. Docs + release

- Rewrite the "dialect posture" note in `spec/10-state.md` (added in Phase 5):
  Postgres is now a **supported production runtime**, not test-only; document
  `DATABASE_URL=postgres://…`, credential redaction, the real-PG CI leg, and the
  single-writer constraint.
- `CLAUDE.md`: extend the `DATABASE_URL` bullet with the `postgres://` runtime +
  redaction note.
- **Run the `docs-sync` skill** before committing (`src/state/**` +
  `src/config/**` are in its trigger map → `spec/10-state.md`; it also mirrors
  the lastlight-www site).
- **Release**: prod-facing change → per npm-release-policy a Release must fire
  `publish.yml` (rebuilds the GHCR images `server update` pulls). Minor bump,
  three version files in lockstep, annotated tag (transcribe Phase 5 §6).

## Verification

```bash
# default suite unchanged (PGlite leg only)
pnpm --filter lastlight-core build && pnpm --filter lastlight-core test
# real-PG leg green
PG_INTEGRATION=1 pnpm --filter lastlight-core exec vitest run tests/state/db.pg-server.test.ts

# Boot smoke against a real server:
docker run -d --name pg-smoke -e POSTGRES_PASSWORD=x -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:x@localhost:5432/postgres <boot the agent>
#   → migrator applies drizzle/pg; SELECT hash FROM __drizzle_migrations → one row
#   → dashboard lists runs; a trivial `lastlight triage <repo>#<issue>` completes

# Backward-compat: boot with NO DATABASE_URL → byte-identical sqlite behavior.

# Isolation guard — pg drivers only reachable from the open() postgres branch
# (run from apps/server/):
grep -rn "node-postgres\|neon-serverless\|from \"pg\"\|@neondatabase/serverless" src/ \
  | grep -v "src/state/pg-client.ts"
#   → empty (pg-client.js is dynamically imported, and its own driver imports
#     are dynamic per-builder, so neither pg nor @neondatabase/serverless is in
#     any module's top-level graph)
```

Plus: dashboard `/config` masks a `postgres://u:p@…` value; `close()` drains the
pool (no leaked connections).

## Risk watch-items

- **int8-as-string** — the one behavior PGlite does NOT catch (§1). If aggregate
  results arrive as strings, the parser didn't register — confirm `setTypeParser`
  runs before the first pool query.
- **Lazy import discipline** — a stray top-level `import "pg"` /
  `import "@neondatabase/serverless"` (or a static driver import inside
  `pg-client.ts` rather than inside its builder) re-couples every deployment to a
  driver it may not use. The grep guard in Verification is the tripwire.
- **Wrong Neon driver** — importing `drizzle-orm/neon-http` instead of
  `neon-serverless` type-checks and passes simple reads, then loses every
  transaction: the five atomic ops silently stop being atomic. Pin the WebSocket
  driver (§1) and let the concurrency-probe test catch a regression.
- **Credential leak, two paths.** (a) The redaction (§6) is the only thing
  between a `postgres://user:pass@…` URL and the dashboard `/config` view —
  test it. (b) **The overlay repo is the worse one**, and §6 does nothing for
  it: `database.url` is a YAML slot, so an operator (or the setup wizard, if
  §7a's rule 1 is broken) can put a credentialed URL in `instance/config.yaml`,
  which is a **git repo with a GitHub remote**. Redaction happens at render
  time and cannot un-commit anything. The wizard must write to `.env`, and the
  `default.yaml` comment (§7) should say plainly: *put a `postgres://` URL in
  `DATABASE_URL`, not in `config.yaml` — the overlay is version-controlled.*
- **Pool exhaustion / leaked connections** — ensure `close()` calls
  `pool.end()`; assert clean vitest exit on the integration leg.
- **CI Docker availability** — the real-PG leg must **skip cleanly** (not fail)
  when Docker/`PG_INTEGRATION` is absent, or it breaks contributors' local runs.

## Done criteria

- [x] `src/state/pg-client.ts` — `makePgClient(url, driver)` dispatches to the
      node-postgres or neon-serverless builder (each with per-builder dynamic
      driver imports + int8 parser + drizzle wrap); `resolvePgDriver(url, cfg?)`
      host heuristic, unit-tested.
- [x] `StateDb.open("postgres://…")` resolves the driver, builds the client, runs
      the matching `drizzle/pg` migrator, returns a working `StateDb`; `close()`
      drains the pool. The Phase-4 throw is gone.
- [x] `pg` **and** `@neondatabase/serverless` in `apps/server/package.json`
      `dependencies`; ~~`@testcontainers/postgresql` in devDependencies~~ (not
      needed — Deviations §3); grep guard confirms neither driver is in the
      sqlite (or the other driver's) runtime graph — now an executable test.
- [x] `database.driver` (`pg` | `neon`, env `DATABASE_DRIVER`) resolves
      env > overlay > default, unset → URL auto-detect; documented in
      default.yaml / .env.example. Plus `database.poolMax` / `DATABASE_POOL_MAX`.
- [x] `tests/state/db.pg-server.test.ts` runs the full `runStateDbSuite` +
      concurrency-probe against real Postgres, opt-in, green in CI.
- [x] `database.url` credentials redacted from `publicConfig`; test covers it.
      Also from the boot log, which the doc missed (Deviations §5).
- [x] `lastlight server setup` offers SQLite (default) vs external Postgres;
      the postgres answer writes `DATABASE_URL` to `instance/secrets/.env` and
      the sqlite answer writes **nothing**; ~~`--yes` takes SQLite silently~~
      (structurally moot — Deviations §6);
      `buildOverlayConfig()` never emits a `postgres://` URL (tested);
      `packages/cli/CLAUDE.md` + the `lastlight-server` skill list the new step.
- [x] Docs (`spec/10-state.md`, `spec/02-configuration.md`, `CLAUDE.md`,
      default.yaml, .env.example) describe the production PG runtime +
      single-writer constraint; docs-sync run clean (site: `docs/configuration`,
      `docs/cli`, `docs/production`).
- [x] Backward-compat: no-DATABASE_URL boot identical to sqlite; verified.
- [x] **(Added to scope)** sqlite → postgres data migration —
      `src/state/data-migrate.ts` + the `lastlight-state` bin + `lastlight
      server db check|migrate`. See Deviations §9.
- [ ] Minor npm release + GHCR rebuild shipped (publish.yml green).
- [x] README.md Phase 6 checkbox ticked; deviations recorded below.

## Deviations

*Executed 2026-08-18 on branch `phase6-prod-postgres`, off `main` at v0.26.0.
Baseline before: 207 test files. After: **211 files**, plus one opt-in file that
skips without `PG_INTEGRATION=1` (so 6 skipped, was 5). Full workspace gate
(`pnpm turbo run typecheck test build`) green.*

### 1. §1's `makePgClient` snippet would have thrown on first use ⚠

The snippet is `drizzle(pool)` with no `{ schema }`. That is precisely the trap
the README's own "Tables" row warns about: `tablesOf(client)` reads the schema
back off `db._.fullSchema`, so a client built without it throws
"StateClient was constructed without its schema" on the first query.

So **`pg-client.ts` imports `schema/pg.ts`** — and that breaks the Phase-4
invariant "nothing under `src/` may import `schema/pg.ts`", which the phase doc
did not anticipate. The invariant is not dropped, it is **narrowed**: exactly
one module may, it is the module that builds Postgres clients, and it is itself
only reachable through the dynamic import on `open()`'s postgres branch — so a
SQLite deployment still never loads it. `tests/state/driver-isolation.test.ts`
now pins both halves (no static driver import anywhere under `src/`; exactly one
importer of `schema/pg.ts`), which replaces the doc's manual Verification grep
with something CI runs.

### 2. `resolvePgDriver` and the redaction live in `lastlight-shared`

§1a puts `resolvePgDriver` "beside `makePgClient`". It cannot live there: §7a's
wizard needs it too, and `packages/cli` may never gain an edge to
`lastlight-core`. New module `packages/shared/src/database-url.ts` —
`isPostgresUrl` / `isPgDriver` / `resolvePgDriver` / `redactDbUrl` /
`parsePgEndpoint` — for the same reason `repo-config-schema.ts` lives there.
It imports no driver, so it adds nothing to the CLI's dependency graph.

`redactDbUrl` is hand-parsed rather than `new URL()`-based, because `new URL()`
throws on an unencoded `@` in a password — exactly the case where getting
redaction right matters most. It fails **closed**: anything whose authority
boundary is ambiguous is masked wholesale.

### 3. No `@testcontainers/postgresql`

The Files table asks for it as a devDependency. The leg reads `PG_TEST_URL` /
`DATABASE_URL` and CI uses a `services: postgres:16` block (which §5 itself
recommends over the testcontainers path), so the dependency buys nothing —
locally you point it at any server, `docker run` included. One fewer devDep and
no Docker-in-Docker.

### 4. Per-test isolation needs the MIGRATOR's journal to move too

§4 says "a fresh SCHEMA (`CREATE SCHEMA t_<n>; SET search_path`)". True but
insufficient: the drizzle pg migrator records applied migrations in
`drizzle.__drizzle_migrations`, which is NOT inside the test schema. Shared, the
second test's `migrate()` sees the journal already full, no-ops, and hands back
a schema with **no tables** — a failure that looks like a query bug. The leg
passes `migrationsSchema: schema` so the journal moves with the tables. The
search_path rides the connection string (`?options=-c search_path=…`), so
`makePgClient`'s production signature needed no test-only parameter.

### 5. The credential leaked to the boot log as well, and the fix is by VALUE

§6 only names `publicConfig`. `src/index.ts` also had
`configLog.info("Database", { path: dbTarget })` — the raw URL, into a
structured log that outlives the process. Fixed with the same `redactDbUrl`.

And the redaction rule is a **leaf-value** rule inside `redactPublic()` (any
string that is a `postgres://` URL is masked, wherever it appears), not the
"add `database.url` to the sensitive matcher" option §6 offers. Two reasons: a
key rule cannot distinguish `database.url` from `publicUrl`/`avatarUrl` without
a path-aware walk, and a `file:` URL should stay legible — §6 wanted that
anyway. As a value rule it also cannot be defeated by someone nesting or
renaming the slot later.

### 6. §7a rule 3 (`--yes` → SQLite) is structurally moot

`runSetup()` takes no options and hard-exits unless stdin is a TTY, so there is
no non-interactive path to acquire a new required answer. Nothing to do; noted
so a future reader does not go looking for the branch.

### 7. The connectivity check: §7a's preferred option is not available here

§7a prefers probing inside the agent image (`docker run --rm --entrypoint node
lastlight-agent …`) and asks for it to be costed. **The cost is that it cannot
work at that point in the wizard**: `writeConfig()` runs before
`dockerBuildAndLaunch()`, so on a first install the image does not exist yet.

Shipped instead: a bare **TCP connect** to the parsed host/port (`node:net`, no
new dependency, no `pg` edge), with the honest caveat printed — credentials and
the database name are not checked — plus `lastlight server db check`, which IS
the full probe and DOES run inside the image, available the moment the build
finishes. On failure the wizard offers to keep the URL anyway, per §7a.

### 8. `DATABASE_DRIVER` is never written automatically

§7a rule 4 says write it "only when the operator's URL forces the non-obvious
answer". No such case is detectable at wizard time: the heuristic already
handles `*.neon.tech`, and the one case needing an explicit driver — Neon behind
a custom domain — is by definition indistinguishable from the host. So the
wizard reports the detected driver and emits a **commented** `# DATABASE_DRIVER=neon`
line explaining when to uncomment it. Pinned by a test that the line is present
and inactive.

### 9. §8 (the data migration) was pulled INTO scope

Requested during execution, so "OUT OF SCOPE" above is superseded. Shipped as
`src/state/data-migrate.ts` (`migrateStateData` / `copyStateData`), the
`lastlight-state` bin (`src/state/state-cli.ts`, added to `package.json` `bin`),
and `lastlight server db check|migrate` in the CLI. Design notes worth keeping:

- It is a **read-and-insert loop through the two Drizzle schemas**, exactly as
  §8 predicted: identical `$type<T>` on both dialects makes the JS value in the
  middle dialect-neutral. Booleans, jsonb and floats need no special-casing.
- The CLI wrapper runs it **inside the agent container** — the same reasoning as
  §7a's connectivity check, and here the image always exists.
  `STATE_CLI_PATH = /app/dist/state/state-cli.js`, **not**
  `/app/apps/server/dist/…`: the Dockerfile's `pnpm deploy` flattens the package
  into `/app` (matching `CMD ["node", "dist/index.js"]`).
- With no `--to`, the target is the container's own `DATABASE_URL`, so the
  credential never reaches the host's process list or shell history. That is the
  documented path.
- Four guards, each a data-loss bug if dropped: both ends migrated first, FK
  order (`messaging_sessions` → `messaging_messages`, the only declared FK), an
  empty-target precondition with a `--truncate` escape hatch, and a
  **coverage check against the schema's own exports** so a sixteenth table added
  later fails loudly instead of being silently skipped.
- `StateMigrationError.wrote` distinguishes a refusal *before* the first insert
  from a failure *after* it. Telling an operator to `--truncate` a database this
  run never touched is how they delete the wrong one.
- `describeError` unwraps the cause chain, because Drizzle's own message is just
  the SQL: without it, a wrong password reads as "Failed query: select 1".

### 10. What the real production migration found

Verified against a copy of the drizby snapshot (43 MB, **4,666 rows across all
fifteen tables**): **0.7 s**, row counts verified per table, and every row of
`executions` (2,238) and `workflow_runs` (1,629) **field-for-field identical**
after normalising object key order. The harness then booted against the result
(redacted boot log, `dialect: postgres`, zero errors) and a `finishRun`
transaction wrote through it.

Three differences are inherent and immaterial, and are documented rather than
"fixed":

1. **jsonb normalises object key order** (`{phase,timestamp,success}` becomes
   `{phase,success,timestamp}`). Semantically identical; only a naive
   `JSON.stringify` comparison sees it.
2. **`SUM()` over floats accumulates in a different order** — `dailyStats()`'s
   `costUsd` differs in the last ULP (`74.045826` vs `74.04582599999999`). The
   per-row `cost_usd` values are byte-identical; this is float addition order,
   not data loss.
3. **`messaging_messages.id` is reassigned** by design — `GENERATED ALWAYS AS
   IDENTITY` rejects an explicit value, nothing references the id, and reading
   in id order preserves the message sequence.

### 11. Not done

- **The release.** Version bumps + the GitHub Release that fires `publish.yml`
  are deliberately left for a human call, per the npm-release-policy.
- **The Neon manual smoke.** §4 lists it as a nice-to-have against a real Neon
  dev branch. The driver is wired, unit-tested on the host heuristic and
  isolated from the node-postgres path, but **no query has run over
  `@neondatabase/serverless`** — treat Neon as untested-in-anger until someone
  points a dev branch at it.
