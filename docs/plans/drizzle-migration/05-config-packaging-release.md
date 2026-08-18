# Phase 5 — Config, packaging, Dockerfile, docs, cutover, release

Risk: **low-medium**. The operator-facing surface: a `database.url` config
slot, Dockerfile toolchain removal, shipping `drizzle/` in both the npm
tarball and the docker image, the spec/CLAUDE.md rewrite, the production
cutover, and the npm release the evals barrel requires.

Read [README.md](README.md) and [00-architecture.md](00-architecture.md)
first. Line references were verified against `main` at planning time — if
one has drifted, trust the described pattern.

## Goal

After this phase:

- Operators can set the state DB via `DATABASE_URL` env or `database.url` in
  overlay/default YAML; absent both, behavior is byte-identical to today
  (`DB_PATH` → `$STATE_DIR/lastlight.db`).
- The agent image builds without `python3 make g++` and boots with
  `@libsql/client`'s prebuilt binding; the image contains `drizzle/`.
- The npm tarball ships `drizzle/` and a packed install can run the migrator.
- `spec/10-state.md` and `CLAUDE.md` describe the Drizzle reality.
- Prod is cut over (runbook below) and a minor npm release is published.

## Preconditions

- Phases 1, 2 (combined), 3, 4 all ticked in [README.md](README.md).
- `apps/server/src/state/db.ts` exposes async `StateDb.open(pathOrUrl)` that: accepts
  `:memory:`, `file:` URLs, AND bare filesystem paths (normalizing per
  locked decision 9), resolves `migrationsFolder` via
  `new URL("../../drizzle/sqlite", import.meta.url)`, and **throws** an
  informative error on `postgres://` URLs (Phase 4).
- This phase begins by **merging the `drizzle-migration` branch to `main`**
  (locked decision 6) — do the merge, verify green on `main`, then proceed;
  the prod cutover runbook below runs promptly after the merge so `main`
  doesn't sit in the "carries the engine, prod not yet backed up/cut over"
  window any longer than necessary.
- `better-sqlite3` is gone from `apps/server/package.json` (Phase 2b) — done,
  though the Dockerfile's `python3 make g++` lines are NOT (see §Dockerfile).
- Repo green: `pnpm --filter lastlight-core build && pnpm --filter lastlight-core test`
  (**206 files / 3,127 tests** as of Phase 2, before Phase 3's +1).

> ### ⚠ Inherited from Phase 2 — two items land here
>
> 1. **The prod-shape smoke is a RELEASE GATE, not optional.** 02b's
>    Verification specified it and Phase 2 could not run it: it needs a copy of
>    the real `lastlight.db` out of the prod docker volume, which is a host
>    operation. It matters more than it did when it was written, because
>    `0001_backfill_repo_refs.sql` is the **first migration that writes to
>    production data**. Run it against a copy, twice (it must be idempotent),
>    and check `__drizzle_migrations` has exactly 2 rows and
>    `PRAGMA integrity_check` says `ok` — the steps are in 02b's Verification.
>
>    **✅ RUN AND PASSED 2026-08-18** against a snapshot of drizby prod
>    (v0.25.9, 41 MB, 2,238 executions / 1,629 runs) — see **§0** below. Re-run
>    before the actual cutover if prod has moved on, but the shape of the
>    answer is now known rather than assumed.
> 2. **`spec/10-state.md` is already updated** (Phase 2 rewrote its Migrations
>    section for the journaled model). The docs-sync sweep here still owns
>    `CLAUDE.md` and any other surface, but do not redo that section.
>
> Also note the release bumps cascade across **all five** published packages —
> `lastlight-workflow-engine`'s ports changed shape (locked decision 13).

## 0. Prod-shape smoke — already discharged

**Run 2026-08-18 against a real snapshot of drizby prod (v0.25.9).** This is the release gate the ⚠ block above inherits from Phase 2, and it is the one thing standing between `0001_backfill_repo_refs.sql` and real production rows. It passed. Re-run it before the actual cutover if prod has moved on — the recipe below is the reusable part.

### Taking the snapshot

The DB lives in the `lastlight_agent-data` docker volume, not in the repo checkout, and **there is no `sqlite3` binary in the agent container** — but `better-sqlite3` is (prod still runs the pre-Drizzle release), and its `.backup()` is the SQLite online-backup API, which is safe against a live writer. A plain `cp` is not: prod had 1.2 MB of uncheckpointed WAL at the time, and a checkpoint landing mid-copy yields a torn file.

1. In the agent container, `new Database(path, { readonly: true }).backup("/tmp/prod-snapshot.db")` — writes to the container's `/tmp`, so nothing is added to the persistent volume.
2. Stream it out with `docker exec … cat` redirected to a local file, so no copy is left on the host disk either.
3. `sha256sum` both ends to prove the transfer, then delete the container-side temp file.

Keep the snapshot **outside the repo** — it holds real repo names, agent output text, Slack ids and user logins. `~/lastlight-prod-snapshots/` is where the 2026-08-18 one is.

### Result

Run `StateDb.open()` over a *copy*, never the snapshot itself, then a second time for idempotency.

| Check | Result |
|---|---|
| `PRAGMA integrity_check` | `ok` |
| First open (legacy pre-step + `0000_baseline` + `0001_backfill`) | **96 ms** over 41 MB |
| Second open | **11 ms**, journal still 2 rows — idempotent |
| `__drizzle_migrations` | exactly **2** rows |
| Row counts, all 17 prod tables | **unchanged** |
| Tables added | `__drizzle_migrations` only |
| Indexes dropped | **none** |
| Indexes added | exactly the **five** `*_unique` Phase 1 predicted (3 on `users`, 1 each on the two feedback tables) |

Real prod rows then read back through the new column mappings: 40 runs' `context` parsed as objects (largest **60 KB**), `phase_history` non-empty, `success` came back a real **boolean** (419 true / 81 false over 500 rows), `extension_status` parsed on 458 rows, and `executionStats` / `dailyStats` / `listChatThreads` / `getAllCronOverrides` all returned sane values.

### Two findings the plan did not have

1. **Prod has 17 tables, not 15.** `rate_limits` (13 rows) and `system_status` (1 row) are orphans from an older `migrate.ts`; nothing in `src/`, `tests/` or `packages/` references either. They are harmless — the migrator only ever `CREATE TABLE IF NOT EXISTS` and never drops — and the smoke confirms both survive untouched. **But they are a live reason never to point `drizzle-kit push` at production**, which would generate a DROP for both. Generated-migrations-only is the rule; this is the concrete cost of breaking it.
2. **`0001_backfill_repo_refs.sql` is a NO-OP on drizby.** Every `workflow_runs` row is already `(owner, bare repo)`, and `executions` is already normalized (1,168 bare-with-owner, 893 chat rows with no repo, 177 with neither). Expected rather than surprising: the old `migrate.ts` ran these same statements on **every boot**, so prod converged long ago, and journaling them (locked decision 14) changes *when* they run, not *what* they do. That lowers the risk for this host but says nothing about one that has been offline across the relevant releases — so keep the gate.

## 1. Config slot — `database.url`

Follow the established layering pattern (`src/config/config-resolve.ts`:
env > overlay > default, key-by-key for mappings). `database.url` rides the
generic resolver — no special-casing, and the dashboard `/config` provenance
view works for free.

### `src/config/config.ts`

Three edits, matching how `buildAssets` / `explore` flow today:

1. **Type** — in `LastLightConfig` (~line 104, next to `dbPath`):

   ```ts
   dbPath: string;
   /** State DB URL (libsql-style). Absent → `file:` + dbPath. */
   database: { url?: string };
   ```

   Keep `dbPath` — it remains the fallback and other surfaces may read it.

2. **Env layer** — in `buildEnvConfigLayer` (~line 563), one line alongside
   the other env→path mappings:

   ```ts
   if (env.DATABASE_URL) layer.database = { url: env.DATABASE_URL };
   ```

3. **File normalization** — in `normalizeFileConfig` (~line 406): add
   `database: { url?: string }` to the return type and:

   ```ts
   const databaseRaw = isPlainObject(raw.database) ? raw.database : {};
   const databaseUrl =
     typeof databaseRaw.url === "string" && databaseRaw.url.trim()
       ? databaseRaw.url.trim()
       : undefined;   // yaml `url: null` and absent both land here
   ```

   Then in `loadConfig`'s config literal (~line 360), next to the existing
   `dbPath: process.env.DB_PATH || join(stateDir, "lastlight.db")` (line 368
   — **unchanged**):

   ```ts
   database: { url: fileCfg.database.url },
   ```

### Resolution contract (spec this exactly)

Effective URL, first hit wins:

1. `DATABASE_URL` env (via the env layer — so it also shows as `env` in the
   provenance tree).
2. Overlay `config.yaml` → `database.url`.
3. `config/default.yaml` → `database.url` (ships `null`).
4. Absent → `` `file:${config.dbPath}` `` — i.e. `DB_PATH` env or
   `$STATE_DIR/lastlight.db`. **Fully backward compatible**; existing
   deployments change nothing.

Apply it at the single construction site, `src/index.ts` (~line 142, which
Phase 2b already made `await StateDb.open(...)`):

```ts
// open() normalizes both forms (locked decision 9): a DATABASE_URL like
// "file:/app/data/lastlight.db" passes through; the bare dbPath fallback
// gets resolved + file:-prefixed inside open(). Do NOT prefix here.
const dbTarget = config.database.url ?? config.dbPath;
const db = await StateDb.open(dbTarget);
console.log(`[state] Database: ${dbTarget}`);
```

`StateDb.open` itself takes the resolved path-or-URL and does not read config.
`postgres://` still throws per Phase 4 ("PG runtime not enabled; sqlite is
the supported production store") — the slot is reserved, not live.

### `config/default.yaml`

Add (near `buildAssets`, with a comment in the file's house style):

```yaml
# State database. `url` is a libsql-style URL ("file:/app/data/lastlight.db",
# ":memory:"). null/absent → file: + the DB_PATH / $STATE_DIR/lastlight.db
# resolution (the pre-0.10 behavior). postgres:// is recognized but throws at
# boot — the Postgres runtime is test-only (PGlite) for now.
database:
  url: null
```

### `.env.example`

Add under "Agent Settings" next to `STATE_DIR`:

```
# DATABASE_URL=file:./data/lastlight.db  # State DB URL (libsql). Default:
#                                        # file:$STATE_DIR/lastlight.db (DB_PATH
#                                        # still honored). postgres:// is
#                                        # reserved and throws at boot.
```

### Tests + redaction note

- Extend `tests/config.test.ts` / `tests/config-overlay.test.ts`: env beats
  overlay beats default; yaml `null` → `undefined`; absent → `undefined`
  (callers fall back to dbPath); provenance leaf reads `env` when
  `DATABASE_URL` is set.
- `SENSITIVE_KEY_RE` in config.ts does **not** match `url`, so `database.url`
  is echoed by the dashboard `/config` view. Fine today (`file:` URLs are
  non-secret; `postgres://` can't boot), but leave a comment beside
  `SENSITIVE_KEY_RE`: when the PG runtime is enabled, credentials in
  `database.url` must be redacted from `publicConfig`.

## 2. Dockerfile

> **Corrected 2026-08-18.** The Dockerfile is now a **two-stage pnpm build**
> and it installs the toolchain **TWICE** — the original text described a
> single install and would have left half the fix undone:
>
> - **Build stage, `apps/server/Dockerfile:22-25`** — `python3 make g++` for
>   "native modules (better-sqlite3) compiled during install". This is the one
>   that actually compiles, at the `pnpm install --frozen-lockfile --filter
>   lastlight-core...` on `:44`.
> - **Runtime stage, `:68-74`** — installs `python3 make g++` *again*,
>   alongside git/ripgrep/docker-CLI/gosu. This one is already redundant today:
>   the compiled `.node` binary is copied wholesale from the build stage at
>   `:90` (`COPY --from=build /app /app`), and both stages are `node:22-slim`
>   so the ABI matches. It is ~200 MB of dead toolchain in the shipped image.
>
> **Remove it from both.** Dropping only the runtime one leaves the (slow)
> build-stage compile in place. ~~They come out in the same commit as
> `pnpm remove better-sqlite3` (Phase 2's dependency-removal step).~~
> **Corrected:** Phase 2 removed the dependency but did **not** touch the
> Dockerfile (that was deliberate — 02b's risk watch-item defers the image proof
> to here). So the apt lines are still present and are now pure dead weight;
> removing them is **this phase's job alone**, and nothing gates on it until the
> image is built. That also means the libsql prebuilt-binary claim behind locked
> decision 2 is still **unproven on `node:22-slim`** — the smoke build below is
> the first time it is tested.
>
> Unrelated but worth not breaking: the **sandbox** images
> (`sandbox.Dockerfile:41-44`, `sandbox-base.Dockerfile:28`) also install
> `python3 make g++` — for ssh2's `cpu-features` via gondolin, **not** for
> better-sqlite3. Sandbox containers never open the state DB. **Leave them
> alone.**
>
> Also note `:63` — `pnpm --filter lastlight-core deploy --prod /app` is what
> shapes the runtime `node_modules`. `drizzle/` is not a dependency, so
> `pnpm deploy` will not carry it; the explicit COPY below is genuinely
> required.

Current state: the apt lines install `python3 make g++` for better-sqlite3's
node-gyp build. **`drizzle/` is not copied by any existing COPY** — the
COPY set is `package*.json`, `dashboard/package.json`, `tsconfig.json`,
`src/`, `dashboard/`, `deploy/`, `config/`, `skills/`, `agent-context/`,
`workflows/`, `CLAUDE.md`. Without a new COPY the migrator dies at boot.

1. Drop the toolchain — from **both stages** (`:22-25` and `:68-74`):

   ```dockerfile
   # System deps: git, ripgrep, docker CLI (for the docker-sandbox fallback
   # only), gosu. No compiler toolchain: the only native module,
   # @libsql/client, ships prebuilt bindings for linux glibc.
   RUN apt-get update && apt-get install -y --no-install-recommends \
       git ripgrep curl jq ca-certificates gosu \
       && curl -fsSL https://get.docker.com | sh \
       && rm -rf /var/lib/apt/lists/*
   ```

2. Ship the migrations — in the "frequently changing content" block (after
   `COPY --chown=lastlight:lastlight config/ config/`, line 55):

   ```dockerfile
   COPY --chown=lastlight:lastlight drizzle/ drizzle/
   ```

   Runtime resolution: `/app/dist/state/db.js` →
   `new URL("../../drizzle/sqlite", …)` → `/app/drizzle/sqlite`. Correct
   with `drizzle/` copied to `/app/drizzle`. Do NOT copy the
   `drizzle-*.config.ts` files — drizzle-kit is a devDep, generation is a
   dev-machine activity.

### Verification — against the real runtime, not assumptions

Per the CLAUDE.md deployment warning (entrypoint runs as root, then
`exec gosu lastlight`; the harness runs as UID 10001), verify with a
throwaway container, not just a green build:

```bash
docker build -t lastlight-agent:drizzle-smoke .

# (a) prebuilt libsql binding loads on node:22-slim with no toolchain:
docker run --rm --entrypoint node lastlight-agent:drizzle-smoke \
  --input-type=module -e "const {createClient}=await import('@libsql/client'); \
  const c=createClient({url:':memory:'}); console.log((await c.execute('select 1')).rows)"

# (b) full entrypoint chain as UID 10001 writes + migrates a fresh DB:
docker volume create ll-drizzle-smoke
docker run -d --name ll-smoke -e WEBHOOK_SECRET=x \
  -v ll-drizzle-smoke:/app/data lastlight-agent:drizzle-smoke
sleep 5
docker logs ll-smoke 2>&1 | grep -iE "state|drizzle|migrat"   # migrator ran
docker exec ll-smoke ls -ln /app/data/lastlight.db            # owner uid 10001
docker rm -f ll-smoke && docker volume rm ll-drizzle-smoke
```

If boot needs more env than `WEBHOOK_SECRET`, supply the same minimal set
`scripts/dev-local.sh` uses; the point is that migrate-at-boot succeeds as
the `lastlight` user on the real image.

## 3. npm packaging

`apps/server/package.json` `files` is currently `["dist", "config",
"workflows", "skills", "agent-context", "deploy", "sandbox.Dockerfile",
"docker-compose.yml", ".claude-plugin", "plugins"]` — **`drizzle` is
absent** (verified). Add it:

```json
"files": [ "dist", "drizzle", "config", ... ]
```

Also confirm the generation scripts exist (Phases 1/4 should have added
them; if not, add now):

```json
"db:generate:sqlite": "drizzle-kit generate --config drizzle-sqlite.config.ts",
"db:generate:pg": "drizzle-kit generate --config drizzle-pg.config.ts",
```

### Path trace (why `../../` is right — do not "fix" it to `../../../`)

`apps/server/tsconfig.json` has `rootDir: src`, `outDir: dist`, so
`src/state/db.ts` compiles to `dist/state/db.js`. From `dist/state/db.js`,
`new URL("../../drizzle/sqlite", import.meta.url)` climbs `dist/state` →
`dist` → package root → `drizzle/sqlite`:

| Context | db.js location | resolves to |
|---|---|---|
| dev (tsx) | `apps/server/src/state/db.ts` | `apps/server/drizzle/sqlite` ✓ |
| built repo / docker | `/app/dist/state/db.js` | `/app/drizzle/sqlite` ✓ |
| npm install | `node_modules/lastlight-core/dist/state/db.js` | `node_modules/lastlight-core/drizzle/sqlite` ✓ |

Two parent hops, all three contexts. `../../../` would escape the package.

### Verify

```bash
# from apps/server/ (the lastlight-core package root)
pnpm --filter lastlight-core exec npm pack --dry-run 2>&1 | grep drizzle
# expect drizzle/sqlite/0000_baseline.sql, drizzle/sqlite/meta/*, drizzle/pg/*

# Packed-tarball smoke — the migrator must find migrationsFolder from dist/:
SCRATCH=$(mktemp -d)
( cd apps/server && npm pack --pack-destination "$SCRATCH" )
cd "$SCRATCH" && mkdir smoke && cd smoke && npm init -y >/dev/null \
  && npm i ../lastlight-core-*.tgz
node --input-type=module -e "
  const { StateDb } = await import('lastlight-core/dist/state/db.js');
  const db = await StateDb.open(':memory:');
  console.log('packed-tarball migrate OK');"
```

If that import path isn't the public shape after 2b, use whatever the evals
harness would (`lastlight-core/dist/*` is an exported subpath) — the
assertion is solely "migrations resolve from the installed package".

## 4. Docs

### `spec/10-state.md` — section-by-section rewrite

- **Frontmatter / Purpose / split rule / JSONL sections** — unchanged.
- **"SQLite tables" intro** — schema source of truth is now
  `apps/server/src/state/schema/sqlite.ts` (with
  `apps/server/src/state/schema/pg.ts` as the name-parity Postgres mirror);
  the shown DDL stays as illustration but cite the generated baseline
  `apps/server/drizzle/sqlite/0000_baseline.sql`. Eight tables (incl. the
  issue-#205 `users` identity table): the two messaging tables are now
  schema-owned — `session-manager.ts` no longer self-migrates. Delete the
  "`ALTER TABLE ADD COLUMN` wrapped in try/catch" sentence.
- **Migrations section** — full rewrite: idempotent hand-edited baseline
  (no-op on existing DBs) + `__drizzle_migrations` journal; the
  `legacy-sqlite.ts` pre-step (PRAGMA `table_info`-guarded column adds for
  pre-baseline operators + the messaging `UNIQUE(platform,…)` rebuild, kept
  one release — **floor-version note**: the shim ships in the migration
  release (v0.11) and is removed after v0.12, so messaging-era deployments
  older than that must pass through a v0.11/v0.12 release first); boot
  pragmas `journal_mode=WAL` +
  `busy_timeout=5000`; future migrations via
  `pnpm --filter lastlight-core run db:generate:sqlite` / `db:generate:pg`.
  **Delete the stale claim** that
  `PRAGMA foreign_keys = ON` is set at connect (it never was — the sole
  legacy pragma was WAL).
- **New: dialect posture** — sqlite/libsql is the production store; the PG
  schema + PGlite leg is CI-only proof; `StateDb.open` throws on
  `postgres://`; the parity test pins name-level schema sync.
- **New: async API** — `StateDb.open(url)` async factory, all store methods
  async; note `database.url` / `DATABASE_URL` resolution.
- **New: wire contract** — `/admin/api/executions` (and dashboard list
  routes) serve **snake_case** (`trigger_id`, `started_at`, `duration_ms`,
  `success` as 1/0/null), re-serialized from Drizzle's camelCase records and
  pinned by a routes test.
- **"Current implementation" table** — replace the `BaseDb` row (**stale —
  delete the BaseDb interface claim**) with `StateDb` async factory +
  `client.ts`/`dialect.ts` seam; replace the `migrate.ts` row with
  `schema/*.ts` + `drizzle/` + `legacy-sqlite.ts`.
- **Rebuild notes** — update the issue-#97 bullet: store-per-table over one
  shared Drizzle client with a dialect seam (not "a shared `BaseDb`
  interface"); keep "migrate additively", adding "…and journal it".

### `apps/server/CLAUDE.md`

- Repo-layout entry for `state/db.ts`: describe the Drizzle layer —
  `schema/` (sqlite + pg mirrors), async `StateDb.open`, the four stores
  (incl. `UserStore`) — and add a top-level `drizzle/` line (generated
  migrations, shipped in npm + docker artifacts).
- Environment: extend the `DB_PATH` bullet with `DATABASE_URL` and the
  resolution order from §1.
- Add the schema-change workflow (Commands or a short "State schema" note):
  **schema change = edit BOTH `apps/server/src/state/schema/sqlite.ts` AND
  `apps/server/src/state/schema/pg.ts`, regenerate BOTH dialects
  (`pnpm --filter lastlight-core run db:generate:sqlite &&
  pnpm --filter lastlight-core run db:generate:pg`), and the parity test
  enforces the two stay in sync.**

### docs-sync

**Run the `docs-sync` skill before committing this phase** — `src/state/**`
is in its trigger map (→ `spec/10-state.md`), and it also covers the
separate lastlight-www site, which mirrors the spec.

## 5. Prod cutover runbook (verbatim-usable)

Prod data lives in the docker volume **`lastlight_agent-data`** — NOT
`/home/lastlight/lastlight/data`.

```bash
ssh root@85.9.213.18

# 1. Locate + back up the live DB (install sqlite3 if missing: apt-get install -y sqlite3)
DB=/var/lib/docker/volumes/lastlight_agent-data/_data/lastlight.db
ls -l "$DB"*
sqlite3 "$DB" "PRAGMA wal_checkpoint(TRUNCATE);"
sqlite3 "$DB" "VACUUM INTO '/root/lastlight-pre-drizzle-$(date +%Y%m%d).db';"
# VACUUM INTO is transactionally consistent even with the agent live; the
# checkpoint folds the WAL first so the snapshot is complete.

# 2. Deploy (main must already carry the merged phases)
sudo -u lastlight -i lastlight server update

# 3. Post-deploy checks
sudo -u lastlight -i lastlight server logs agent --tail 200
#    expect: legacy pre-step log + migrator applying/recording the baseline; no errors
# Journal columns are (id, hash, created_at) — there is NO `tag` column
# (the tag lives only in meta/_journal.json), and `id` may be NULL on sqlite:
sqlite3 "$DB" "SELECT hash, created_at FROM __drizzle_migrations;"   # exactly one row
# Dashboard https://lastlight.drizby.com — historical workflow runs AND chat
# threads listed (proves old rows read through Drizzle).
# From your laptop, trigger a trivial workflow end-to-end:
#   lastlight triage cliftonc/lastlight#<open-issue>   # watch it complete
```

**Rollback story.** The baseline is schema-neutral on current prod — every
CREATE no-ops; the only addition is the `__drizzle_migrations` table, which
the old code ignores. So the previous image reads the same file unchanged:
as `lastlight`, `git -C ~/lastlight checkout <previous release tag>`
(v0.10.1 at last verification — use whatever prod ran before the cutover),
`docker compose build agent`, `docker compose up -d agent`. Restoring the
`VACUUM INTO` backup (stop agent → copy over `lastlight.db`, delete
`-wal`/`-shm` → start) is optional belt-and-braces, needed only if post-cutover
writes must be discarded.

## 6. Release (npm — required)

The workflow-execution path changed, so per the npm-release-policy the
`lastlight/evals` barrel consumers need a release. **Minor bump.**

> **Corrected 2026-08-18 — this is now a FIVE-package release, not one.**
> The original text bumped `lastlight-core` alone. Locked decision 13 changes
> `packages/workflow-engine`, and the workspace graph is
> `lastlight-workflow-engine ← lastlight-shared ← {lastlight (cli),
> lastlight-core} ← lastlight-evals`. A graph-aware bump therefore cascades
> through **every** published package except `agentic-pi` (which has no
> workspace deps and is on its own release stream).
>
> Follow [`docs/RELEASING.md`](../../RELEASING.md) for the bump order — it is
> the canonical runbook and it already encodes the graph. Do not hand-roll the
> order from this doc.
>
> **Version anchor**: current version at reconciliation time is **`0.25.9`**,
> so the migration ships as **`v0.26.0`** (not the `v0.11.0` the examples below
> still say — substitute throughout). That also **re-anchors the
> `TODO(remove after v0.12)` markers** the plan specifies for
> `legacy-sqlite.ts`'s messaging rebuild: they become
> **`TODO(remove after v0.27)`**. Getting this wrong either deletes the shim
> while deployments still need it, or keeps dead code forever.
>
> Verify before bumping:
> `node -p "require('./apps/server/package.json').version"`.

Transcribed from CLAUDE.md "Cutting a release" — on a clean, up-to-date
`main`:

```bash
# bump lastlight-core's version (a bare `pnpm --filter … version` bumps
# NOTHING — use `exec npm version`); updates apps/server/package.json.
pnpm --filter lastlight-core exec npm version minor --no-git-tag-version
# THIRD file, manual, lockstep:
#   apps/server/plugins/lastlight/.claude-plugin/plugin.json
#   → set "version" to the same X.Y.Z
pnpm --filter lastlight-core build
git add apps/server/package.json pnpm-lock.yaml \
  apps/server/plugins/lastlight/.claude-plugin/plugin.json
git commit -m "chore(release): v0.11.0"
git tag -a v0.11.0 -m "v0.11.0"             # annotated — lightweight tags rejected
git push origin main --follow-tags
gh release create v0.11.0 --title "v0.11.0 — Drizzle state layer" --latest \
  --notes "<highlights + compare link v0.10.1...v0.11.0>"
# Creating the release fires publish.yml → typecheck+test+build+npm publish.
# NEVER run `npm publish` manually; no OTP prompts.
gh run watch <run-id> --exit-status
npm view lastlight@0.11.0 version --prefer-online   # no `v` prefix on npm
```

## Verification

- `pnpm --filter lastlight-core build && pnpm --filter lastlight-core test`
  green; `pnpm --filter @lastlight/dashboard typecheck`.
- Config: new tests pass; boot with `DATABASE_URL=file:/tmp/x.db` uses it;
  boot with nothing behaves exactly as before; dashboard `/config` shows
  `database.url` with correct provenance.
- Docker: image builds with the trimmed apt line; throwaway-container smoke
  from §2 passes (libsql loads, migrator runs as UID 10001).
- Packaging: `(cd apps/server && npm pack --dry-run) | grep drizzle`
  non-empty; packed-tarball smoke prints `packed-tarball migrate OK`.
- Docs: spec/10-state.md contains no `BaseDb` / `foreign_keys=ON` /
  `migrate.ts` claims; docs-sync run clean.
- Prod: runbook executed; `__drizzle_migrations` has the baseline row;
  dashboard history intact; one trivial workflow ran end-to-end.
- Release: `npm view lastlight@0.11.0` returns the version.

## Risk watch-items

- **The classic trap — `drizzle/` missing from exactly ONE of the three
  ships:** npm `files`, Dockerfile COPY, or the `migrationsFolder` URL
  resolution. All three are verified above (`npm pack --dry-run`, the docker
  boot smoke, the packed-tarball smoke). Do not skip any of the three; each
  catches a different miss and each failure mode is a boot-time crash in a
  different artifact.
- `npm version` only touches two of the **three** version files — the plugin
  manifest is manual and easy to forget.
- The dashboard `/config` view echoes `database.url` (no redaction match) —
  harmless for `file:` URLs, a credential leak the day PG lands; the code
  comment from §1 is the tripwire.
- Removing the toolchain breaks the build if any transitive dep still
  node-gyps on install — the docker build itself is the test; if it fails,
  find the dep before reaching for `python3` again.
- Prod backup commands run as root against the volume path; double-check
  `$DB` exists before the deploy step — an empty path means you're on the
  wrong host or the volume name drifted.

## Done criteria

- [ ] `database: { url?: string }` in `LastLightConfig`; DATABASE_URL →
      overlay → default → `file:` + dbPath resolution implemented at the
      `src/index.ts` construction site; config tests cover precedence.
- [ ] `config/default.yaml` ships `database.url: null`; `.env.example`
      documents `DATABASE_URL`.
- [ ] Dockerfile: `python3 make g++` removed from **BOTH** the build stage
      (≈22-25) and the runtime stage (≈68-74); sandbox Dockerfiles left
      untouched; `COPY drizzle/ drizzle/`
      added; throwaway-container smoke passed.
- [ ] `apps/server/package.json` `files` includes `"drizzle"`; pack dry-run +
      packed-tarball migrator smoke passed.
- [ ] `spec/10-state.md` rewritten per outline; `CLAUDE.md` updated
      (state layer, DATABASE_URL, both-dialects regen workflow); docs-sync
      skill run before commit.
- [ ] Prod cutover executed per runbook, checks green, backup retained.
- [ ] v0.11.0 released (or the drifted-forward equivalent): three files in
      lockstep, annotated tag, GitHub release, publish.yml green,
      `npm view` confirms.
- [ ] Phase 5 checkbox ticked in README.md; deviations recorded below.
