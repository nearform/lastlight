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
- `src/state/db.ts` exposes async `StateDb.open(pathOrUrl)` that: accepts
  `:memory:`, `file:` URLs, AND bare filesystem paths (normalizing per
  locked decision 9), resolves `migrationsFolder` via
  `new URL("../../drizzle/sqlite", import.meta.url)`, and **throws** an
  informative error on `postgres://` URLs (Phase 4).
- This phase begins by **merging the `drizzle-migration` branch to `main`**
  (locked decision 6) — do the merge, verify green on `main`, then proceed;
  the prod cutover runbook below runs promptly after the merge so `main`
  doesn't sit in the "carries the engine, prod not yet backed up/cut over"
  window any longer than necessary.
- `better-sqlite3` is gone from `package.json` (Phase 2b).
- Repo green: `npm run build && npx vitest run`.

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

2. **Env layer** — in `buildEnvConfigLayer` (~line 549), one line alongside
   the other env→path mappings:

   ```ts
   if (env.DATABASE_URL) layer.database = { url: env.DATABASE_URL };
   ```

3. **File normalization** — in `normalizeFileConfig` (~line 392): add
   `database: { url?: string }` to the return type and:

   ```ts
   const databaseRaw = isPlainObject(raw.database) ? raw.database : {};
   const databaseUrl =
     typeof databaseRaw.url === "string" && databaseRaw.url.trim()
       ? databaseRaw.url.trim()
       : undefined;   // yaml `url: null` and absent both land here
   ```

   Then in `loadConfig`'s config literal (~line 348), next to the existing
   `dbPath: process.env.DB_PATH || join(stateDir, "lastlight.db")` (line 355
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

Current state (`Dockerfile:10-16`): the apt line installs
`python3 make g++` solely for better-sqlite3's node-gyp build, per the
comment on line 11. **`drizzle/` is not copied by any existing COPY** — the
COPY set is `package*.json`, `dashboard/package.json`, `tsconfig.json`,
`src/`, `dashboard/`, `deploy/`, `config/`, `skills/`, `agent-context/`,
`workflows/`, `CLAUDE.md`. Without a new COPY the migrator dies at boot.

1. Drop the toolchain — replace lines 10-16 with:

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

`package.json` `files` is currently `["dist", "config", "workflows",
"skills", "agent-context", "deploy", "sandbox.Dockerfile",
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

`tsconfig.json` has `rootDir: src`, `outDir: dist`, so `src/state/db.ts`
compiles to `dist/state/db.js`. From `dist/state/db.js`,
`new URL("../../drizzle/sqlite", import.meta.url)` climbs `dist/state` →
`dist` → package root → `drizzle/sqlite`:

| Context | db.js location | resolves to |
|---|---|---|
| dev (tsx) | `<repo>/src/state/db.ts` | `<repo>/drizzle/sqlite` ✓ |
| built repo / docker | `/app/dist/state/db.js` | `/app/drizzle/sqlite` ✓ |
| npm install | `node_modules/lastlight/dist/state/db.js` | `node_modules/lastlight/drizzle/sqlite` ✓ |

Two parent hops, all three contexts. `../../../` would escape the package.

### Verify

```bash
npm pack --dry-run 2>&1 | grep drizzle
# expect drizzle/sqlite/0000_baseline.sql, drizzle/sqlite/meta/*, drizzle/pg/*

# Packed-tarball smoke — the migrator must find migrationsFolder from dist/:
SCRATCH=$(mktemp -d) && npm pack --pack-destination "$SCRATCH"
cd "$SCRATCH" && mkdir smoke && cd smoke && npm init -y >/dev/null \
  && npm i ../lastlight-*.tgz
node --input-type=module -e "
  const { StateDb } = await import('lastlight/dist/state/db.js');
  const db = await StateDb.open(':memory:');
  console.log('packed-tarball migrate OK');"
```

If that import path isn't the public shape after 2b, use whatever the evals
harness would (`lastlight/dist/*` is an exported subpath) — the assertion is
solely "migrations resolve from the installed package".

## 4. Docs

### `spec/10-state.md` — section-by-section rewrite

- **Frontmatter / Purpose / split rule / JSONL sections** — unchanged.
- **"SQLite tables" intro** — schema source of truth is now
  `src/state/schema/sqlite.ts` (with `src/state/schema/pg.ts` as the
  name-parity Postgres mirror); the shown DDL stays as illustration but cite
  the generated baseline `drizzle/sqlite/0000_baseline.sql`. Seven tables:
  the two messaging tables are now schema-owned — `session-manager.ts` no
  longer self-migrates. Delete the "`ALTER TABLE ADD COLUMN` wrapped in
  try/catch" sentence.
- **Migrations section** — full rewrite: idempotent hand-edited baseline
  (no-op on existing DBs) + `__drizzle_migrations` journal; the
  `legacy-sqlite.ts` pre-step (PRAGMA `table_info`-guarded column adds for
  pre-baseline operators + the messaging `UNIQUE(platform,…)` rebuild, kept
  one release — **floor-version note**: the rebuild shim is removed after
  v0.11, so messaging-era deployments older than that must pass through a
  0.10/0.11 release first); boot pragmas `journal_mode=WAL` +
  `busy_timeout=5000`; future migrations via `npm run db:generate:sqlite` /
  `db:generate:pg`. **Delete the stale claim** that
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

### `CLAUDE.md`

- Repo-layout entry for `state/db.ts` (~line 178): describe the Drizzle
  layer — `schema/` (sqlite + pg mirrors), async `StateDb.open`, stores —
  and add a top-level `drizzle/` line (generated migrations, shipped in npm
  + docker artifacts).
- Environment: extend the `DB_PATH` bullet (~line 517) with `DATABASE_URL`
  and the resolution order from §1.
- Add the schema-change workflow (Commands or a short "State schema" note):
  **schema change = edit BOTH `src/state/schema/sqlite.ts` AND
  `src/state/schema/pg.ts`, regenerate BOTH dialects
  (`npm run db:generate:sqlite && npm run db:generate:pg`), and the parity
  test enforces the two stay in sync.**

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
sqlite3 "$DB" "SELECT tag FROM __drizzle_migrations;"     # baseline row present
# Dashboard https://lastlight.drizby.com — historical workflow runs AND chat
# threads listed (proves old rows read through Drizzle).
# From your laptop, trigger a trivial workflow end-to-end:
#   lastlight triage cliftonc/lastlight#<open-issue>   # watch it complete
```

**Rollback story.** The baseline is schema-neutral on current prod — every
CREATE no-ops; the only addition is the `__drizzle_migrations` table, which
the old code ignores. So the previous image reads the same file unchanged:
as `lastlight`, `git -C ~/lastlight checkout v0.9.0` (previous tag),
`docker compose build agent`, `docker compose up -d agent`. Restoring the
`VACUUM INTO` backup (stop agent → copy over `lastlight.db`, delete
`-wal`/`-shm` → start) is optional belt-and-braces, needed only if post-cutover
writes must be discarded.

## 6. Release (npm — required)

The workflow-execution path changed, so per the npm-release-policy the
`lastlight/evals` barrel consumers need a release. **Minor bump**: verify
the current version first (`node -p "require('./package.json').version"` —
`0.9.0` at planning time → `0.10.0`; if it has drifted, bump minor from
whatever it is).

Transcribed from CLAUDE.md "Cutting a release" — on a clean, up-to-date
`main`:

```bash
npm version minor --no-git-tag-version      # package.json + package-lock.json
# THIRD file, manual, lockstep: plugins/lastlight/.claude-plugin/plugin.json
#   → set "version" to the same X.Y.Z
npm run build
git add package.json package-lock.json plugins/lastlight/.claude-plugin/plugin.json
git commit -m "chore(release): v0.10.0"
git tag -a v0.10.0 -m "v0.10.0"             # annotated — lightweight tags rejected
git push origin main --follow-tags
gh release create v0.10.0 --title "v0.10.0 — Drizzle state layer" --latest \
  --notes "<highlights + compare link v0.9.0...v0.10.0>"
# Creating the release fires publish.yml → typecheck+test+build+npm publish.
# NEVER run `npm publish` manually; no OTP prompts.
gh run watch <run-id> --exit-status
npm view lastlight@0.10.0 version --prefer-online   # no `v` prefix on npm
```

## Verification

- `npm run build && npx vitest run` green; `cd dashboard && npx tsc -b`.
- Config: new tests pass; boot with `DATABASE_URL=file:/tmp/x.db` uses it;
  boot with nothing behaves exactly as before; dashboard `/config` shows
  `database.url` with correct provenance.
- Docker: image builds with the trimmed apt line; throwaway-container smoke
  from §2 passes (libsql loads, migrator runs as UID 10001).
- Packaging: `npm pack --dry-run | grep drizzle` non-empty; packed-tarball
  smoke prints `packed-tarball migrate OK`.
- Docs: spec/10-state.md contains no `BaseDb` / `foreign_keys=ON` /
  `migrate.ts` claims; docs-sync run clean.
- Prod: runbook executed; `__drizzle_migrations` has the baseline row;
  dashboard history intact; one trivial workflow ran end-to-end.
- Release: `npm view lastlight@0.10.0` returns the version.

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
- [ ] Dockerfile: `python3 make g++` removed, `COPY drizzle/ drizzle/`
      added; throwaway-container smoke passed.
- [ ] `package.json` `files` includes `"drizzle"`; pack dry-run +
      packed-tarball migrator smoke passed.
- [ ] `spec/10-state.md` rewritten per outline; `CLAUDE.md` updated
      (state layer, DATABASE_URL, both-dialects regen workflow); docs-sync
      skill run before commit.
- [ ] Prod cutover executed per runbook, checks green, backup retained.
- [ ] v0.10.0 released: three files in lockstep, annotated tag, GitHub
      release, publish.yml green, `npm view` confirms.
- [ ] Phase 5 checkbox ticked in README.md; deviations recorded below.
