# Phase 6 — Production Postgres runtime (operator-selectable DB)

Risk: **medium**. Phases 1–5 build the whole dual-dialect machinery but
**reserve** the Postgres runtime: `pg` stays out of runtime deps and
`StateDb.open()` *throws* on a `postgres://` URL — Postgres is proven only
against **PGlite (WASM) in CI**. This phase **activates** that reserved slot so
an operator can set `DATABASE_URL=postgres://…` (or `database.url` in the
overlay) and run Last Light on a real Postgres server in production — the
"users choose their DB, like finius" goal.

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

- `StateDb.open("postgres://…")` builds a real node-postgres pool client, runs
  the `drizzle/pg/` migrator against it, and returns a working `StateDb` (dialect
  `"postgres"`) — no longer throws.
- `pg` (node-postgres) is a **runtime dependency**; a SQLite deployment never
  loads it (lazy import in the postgres branch only).
- The **full state test suite runs green against a real Postgres server** (not
  just PGlite) — exercising the node-postgres driver, connection pool, real
  transactions, int8 handling, and unique-violation detection end-to-end.
- Credentials in `database.url` are redacted from the dashboard `/config` view.
- Docs describe Postgres as a supported production runtime; a minor npm release
  + GHCR image rebuild ships it.
- **Backward compatible**: absent `DATABASE_URL`/`database.url`, behavior is
  byte-identical to the sqlite path from Phase 5.

## Preconditions

- Phases 1–5 all ticked in [README.md](README.md); `main` carries the merged
  Drizzle engine and is green (`npm run build && npx vitest run`).
- `src/state/db.ts` has the async `StateDb.open(pathOrUrl)` from Phase 5 with
  the Phase-4 `postgres://` **throw** still in place (this phase replaces it).
- `src/state/client.ts` exports `asStateClient()` + the `Dialect` type;
  `src/state/dialect.ts` exports `changes()` / `isUniqueViolation()` written to
  cover node-postgres shapes (per 04's design — verify here against the real
  driver).
- `drizzle/pg/0000_init.sql` (+ `meta/`) exists and is committed (Phase 4).
- `config.database.url` slot resolves env > overlay > default and feeds
  `StateDb.open(config.database.url ?? config.dbPath)` at `src/index.ts`
  (Phase 5).

## Files

| File | Action |
|---|---|
| `src/state/pg-client.ts` | create — `makePgClient(url)`: pool + int8 parser + drizzle wrap |
| `src/state/db.ts` | edit — replace the Phase-4 `postgres://` throw with a real branch; `close()` drains the pool |
| `src/state/dialect.ts` | verify (edit only if needed) — `changes()`/`isUniqueViolation()` on node-postgres |
| `src/config/config.ts` | edit — redact credentials in `database.url` from `publicConfig` |
| `tests/state/db.pg-server.test.ts` | create — real-Postgres integration leg (opt-in) |
| `package.json` | `pg` under **dependencies**; `@testcontainers/postgresql` under devDependencies |
| `.github/workflows/ci.yml` (or equiv) | add real-PG job/service |
| `spec/10-state.md`, `CLAUDE.md`, `config/default.yaml` comment, `.env.example` | docs |

## 1. `src/state/pg-client.ts` — real Postgres client factory

```ts
// Production Postgres client. Imported ONLY from StateDb.open()'s postgres
// branch (lazy) so sqlite deployments never load node-postgres. PGlite (the
// test leg) constructs its own client in tests/ — this file is for the real
// server path.
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { asStateClient, type StateClient } from "./client.js";

// int8 (OID 20): node-postgres returns COUNT(*)/SUM(...) as a STRING by
// default. The stores expect numbers (PGlite already parses int8 → number, so
// the PGlite leg does NOT catch this — it is node-postgres-specific and called
// out in 04-postgres-pglite.md §"int8-as-string" + asStateClient()'s doc
// comment). Set the parser globally before building the pool.
pg.types.setTypeParser(20, (v: string) => Number(v));

export interface PgClientHandle {
  client: StateClient;
  close(): Promise<void>;
}

export function makePgClient(url: string, opts?: { poolMax?: number }): PgClientHandle {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts?.poolMax ?? 10,
  });
  const db = drizzle(pool);
  return {
    client: asStateClient(db),
    close: () => pool.end(),
  };
}
```

Notes:
- `drizzle-orm/node-postgres` + `drizzle-orm/node-postgres/migrator` ship inside
  the already-pinned stable `drizzle-orm` (no new drizzle dep).
- The int8 parser is process-global — harmless (the process only ever talks to
  one DB) and matches finius. If a future OID surprises (e.g. `numeric`/1700 from
  `AVG`), prefer a defensive `Number()` in `dialect.ts`'s aggregate helpers over
  widening the global parser.

## 2. `src/state/db.ts` — activate the postgres branch

Replace the Phase-4 guard (04 §5, the "PG runtime not enabled" `throw`) with a
real branch, ahead of the sqlite path/URL normalization (locked decision 9):

```ts
static async open(pathOrUrl: string, opts?: { poolMax?: number }): Promise<StateDb> {
  if (/^postgres(ql)?:\/\//i.test(pathOrUrl)) {
    const { makePgClient } = await import("./pg-client.js"); // lazy: keeps pg
    const { migrate } = await import("drizzle-orm/node-postgres/migrator");
    const handle = makePgClient(pathOrUrl, opts);            // out of sqlite path
    const migrationsFolder = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));
    await migrate(handle.client as never, { migrationsFolder });
    const db = StateDb.fromClient(handle.client, "postgres");
    db.#onClose = handle.close;   // wired so close() drains the pool
    return db;
  }
  // …existing sqlite normalization (:memory:, file:, bare path) unchanged…
}
```

- `close()` becomes: `await this.#onClose?.(); …` (drains the pool on PG;
  no-op-ish on sqlite where libsql closes its client).
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
(§4) is the real test, but eyeball these two:

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
// `npx vitest run` stays hermetic (PGlite leg covers the dialect).
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
    - run: PG_INTEGRATION=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npx vitest run tests/state/db.pg-server.test.ts
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

- **Optional pool knobs**: `database.poolMax` (+ maybe connect timeout) through
  the same generic resolver, defaulting sanely (`makePgClient` reads them).
  Small; skip if not wanted.
- **`config/default.yaml`** comment: update the Phase-5 note that said
  "postgres:// is recognized but throws at boot" → now a supported runtime
  (external/managed Postgres; set `DATABASE_URL` or `database.url`).
- **`.env.example`**: update the `DATABASE_URL` note the same way; add a
  `postgres://` example.
- **Deployment docs**: document the simplest path (point at an external/managed
  Postgres via `DATABASE_URL`); optionally an opt-in `docker-compose` `postgres`
  service profile for self-hosters. **State the single-writer constraint**: Last
  Light runs one instance and the five atomic ops rely on an in-process mutex
  (decision 8) — Postgres here is a storage choice, **not** multi-instance HA.

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
npm run build && npx vitest run           # default suite unchanged (PGlite leg only)
PG_INTEGRATION=1 npx vitest run tests/state/db.pg-server.test.ts   # real-PG leg green

# Boot smoke against a real server:
docker run -d --name pg-smoke -e POSTGRES_PASSWORD=x -p 5432:5432 postgres:16
DATABASE_URL=postgres://postgres:x@localhost:5432/postgres <boot the agent>
#   → migrator applies drizzle/pg; SELECT hash FROM __drizzle_migrations → one row
#   → dashboard lists runs; a trivial `lastlight triage <repo>#<issue>` completes

# Backward-compat: boot with NO DATABASE_URL → byte-identical sqlite behavior.

# Isolation guard — pg driver only reachable from the open() postgres branch:
grep -rn "pg\.Pool\|node-postgres\|from \"pg\"" src/ | grep -v "src/state/pg-client.ts"
#   → empty (pg-client.js is dynamically imported, never at module top)
```

Plus: dashboard `/config` masks a `postgres://u:p@…` value; `close()` drains the
pool (no leaked connections).

## Risk watch-items

- **int8-as-string** — the one behavior PGlite does NOT catch (§1). If aggregate
  results arrive as strings, the parser didn't register — confirm `setTypeParser`
  runs before the first pool query.
- **Lazy import discipline** — a stray top-level `import "pg"` anywhere in the
  runtime graph re-couples every sqlite deployment to node-postgres. The
  grep guard in Verification is the tripwire.
- **Credential leak** — the redaction (§6) is the only thing between a
  `postgres://user:pass@…` URL and the dashboard `/config` view. Test it.
- **Pool exhaustion / leaked connections** — ensure `close()` calls
  `pool.end()`; assert clean vitest exit on the integration leg.
- **CI Docker availability** — the real-PG leg must **skip cleanly** (not fail)
  when Docker/`PG_INTEGRATION` is absent, or it breaks contributors' local runs.

## Done criteria

- [ ] `src/state/pg-client.ts` — `makePgClient(url)`: pool + int8 parser +
      drizzle wrap; imported only via dynamic `import()`.
- [ ] `StateDb.open("postgres://…")` builds the client, runs the `drizzle/pg`
      migrator, returns a working `StateDb`; `close()` drains the pool. The
      Phase-4 throw is gone.
- [ ] `pg` in `dependencies`; `@testcontainers/postgresql` in devDependencies;
      grep guard confirms pg is not in the sqlite runtime graph.
- [ ] `tests/state/db.pg-server.test.ts` runs the full `runStateDbSuite` +
      concurrency-probe against real Postgres, opt-in, green in CI.
- [ ] `database.url` credentials redacted from `publicConfig`; test covers it.
- [ ] Docs (`spec/10-state.md`, `CLAUDE.md`, default.yaml, .env.example) describe
      the production PG runtime + single-writer constraint; docs-sync run clean.
- [ ] Backward-compat: no-DATABASE_URL boot identical to sqlite; verified.
- [ ] Minor npm release + GHCR rebuild shipped (publish.yml green).
- [ ] README.md Phase 6 checkbox ticked; deviations recorded below.
