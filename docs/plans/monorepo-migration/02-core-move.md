# Phase 2 — Move core into `apps/server` (fences F2, F3, F5)

Risk: **HIGH**. Read [README.md](README.md) and
[00-target-architecture.md](00-target-architecture.md) first — this doc assumes
their locked decisions (rename-only commit for history, docker context = repo
root, the `home`/`serverDir` split, `instance/` stays at the repo root, F3's
`dashboard/dist` string is never edited).

## Goal

`git mv` the entire core package from the repo root into `apps/server/`,
leaving the repo root as a private orchestration package — and keep all three
fences intact:

- **F2** — `docker buildx bake core` still builds all images and the agent
  image boots, serves `/health` + `/admin`, with the asset dirs at `/app/`.
- **F3** — the admin SPA still serves via the cwd-relative
  `serveStatic({ root: "dashboard/dist" })` (`src/admin/index.ts:58,61,62`
  pre-move). The string is **not edited**; the runtime cwd is controlled
  instead (`/app` in the image, `apps/server` locally).
- **F5** — the host-local `lastlight server` commands keep working after
  `home` (git root) and the compose/asset root split apart.

The server package **keeps the name `lastlight`** and its `bin` in this phase
— the rename to `@lastlight/core` and the CLI extraction are Phase 4. The npm
tarball file list must remain identical to the 0.15.0 baseline.

Intermediate commits within this phase need not be green (the rename-only
commit cannot also create the new root files); the phase end must be.

## Preconditions

- Phase 1 checkbox ticked: pnpm + turbo skeleton in place, CI green on pnpm,
  `pnpm-lock.yaml` is the only lockfile.
- Pre-flight pin confirmed still active on both prod hosts (`lastlight server
  status` shows `pinned vX.Y.Z`) — an old global CLI **cannot** drive the
  post-move layout (it runs bare `docker compose` with cwd = repo root), so
  prod must not converge to this commit range until Phase 7's runbook.
- Baseline captured: `cd <repo root> && npm pack --dry-run >
  /tmp/pack-baseline-phase2.txt` on the pre-move commit, and `docker buildx
  bake core` verified green.

## Files created / modified

| File | Change |
|---|---|
| ~everything at the repo root | **`git mv` → `apps/server/`** (rename-only commit; full list in step 1) |
| `package.json` (root) | **new** — private orchestration package (the old one moved) |
| `tsconfig.base.json` | **new** — shared flags only |
| `apps/server/tsconfig.json` | extends `../../tsconfig.base.json`; keeps Node16 + `#src/*` |
| `pnpm-workspace.yaml` | globs → `["apps/*", "apps/*/dashboard"]` |
| `pnpm-lock.yaml` | importer keys move (`.` → `apps/server`, `dashboard` → `apps/server/dashboard`) |
| `turbo.json` | outputs confirmed; `turbo run` becomes the canonical entry |
| `apps/server/Dockerfile` | **rewritten** — multi-stage pnpm workspace build (F2) |
| `apps/server/docker-bake.hcl` | every target: `dockerfile = "apps/server/<name>.Dockerfile"`, context stays `"."` |
| `apps/server/docker-compose.yml` | build.dockerfile repoints; Caddyfile mount repoint |
| `apps/server/sandbox.Dockerfile` | COPY paths → `apps/server/...` (pin at line 32 pre-move) |
| `apps/server/sandbox-qa.Dockerfile` | COPY paths → `apps/server/...` (pin at line 123 pre-move) |
| `apps/server/sandbox-base.Dockerfile` | no COPYs from the repo — likely untouched; verify |
| `apps/server/src/cli/cli-server.ts` | the F5 split: explicit `-f` + `--project-directory`; `coreRoot` repoint |
| `apps/server/package.json` | scripts adjusted for in-package paths; `typecheck` script added |
| `apps/server/dashboard/package.json` | `typecheck` script added (for turbo) |
| `.github/workflows/ci.yml` | check steps → `pnpm turbo run typecheck test build` |
| `.dockerignore` | audit paths for the new layout (context stays repo root) |
| `apps/server/CLAUDE.md` | one-line "paths predate the move" banner at top — no rewrite |
| new test (e.g. `apps/server/tests/cli/compose-argv.test.ts`) | pins the composed docker-compose argv (F5) |

## Steps

### Step 0 — baselines

Record on the pre-move commit: `npm pack --dry-run` file list (tarball fence),
`docker buildx bake core` green, and `git rev-parse HEAD` (for `git log
--follow` spot checks later).

### Step group 1 — the rename-only commit

1. Create `apps/server/` and `git mv` into it, **renames only, no content
   edits, no new files in this commit**:
   - dirs: `src/ tests/ config/ workflows/ skills/ agent-context/ deploy/
     spec/ sandbox/ dashboard/ scripts/ plugins/ .claude-plugin/`
   - files: `Dockerfile sandbox-base.Dockerfile sandbox.Dockerfile
     sandbox-qa.Dockerfile docker-compose.yml docker-bake.hcl Caddyfile
     tsconfig.json package.json CLAUDE.md CONTEXT.md` plus any core-owned
     dotfiles/configs found at the root (`tsconfig.test.json`,
     `vitest.config.*`, `.env.example` — check `git ls-files` for stragglers).
   - **stays at the root:** `instance/`, `docs/`, `.github/`, `README.md`,
     `LICENSE`, `.gitignore`, `.dockerignore`, and the Phase-1 files
     (`pnpm-workspace.yaml`, `turbo.json`, `.nvmrc`, `pnpm-lock.yaml`).
   - `plugins/` + `.claude-plugin/` move **with core** now and move again to
     `packages/cli` in Phase 4 — two hops is deliberate (keeps this commit
     pure renames).
2. Commit as e.g. `refactor(monorepo): git mv core into apps/server
   (rename-only)`. Fence: `git log --follow --oneline
   apps/server/src/index.ts | tail -3` shows pre-move commits.

### Step group 2 — root package + workspace rewiring

3. Create the new root `package.json`: `"name": "lastlight-monorepo"`,
   `"private": true`, the `packageManager`/`engines` fields from Phase 1
   (remove them from `apps/server/package.json` if duplicated — root wins),
   and move the `turbo` devDep here. Scripts delegate:
   ```json
   {
     "build": "turbo run build",
     "typecheck": "turbo run typecheck",
     "test": "turbo run test",
     "dev": "pnpm --filter lastlight dev",
     "cli": "pnpm --filter lastlight cli"
   }
   ```
4. Update `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - "apps/*"
     - "apps/*/dashboard"
   ```
5. Create root `tsconfig.base.json` with **shared flags only** — `target
   ES2022`, `strict`, `esModuleInterop`, `skipLibCheck`, `resolveJsonModule`,
   `declaration`, `sourceMap`. **No `module`/`moduleResolution`** (set per
   package — Node16 for the server, Bundler for Vite/Astro packages).
6. Rewrite `apps/server/tsconfig.json` to `"extends":
   "../../tsconfig.base.json"`, keeping locally: `module`/`moduleResolution
   Node16`, `outDir dist`, `rootDir src`, `paths {"#src/*": ["./src/*"]}`,
   `include ["src/**/*"]`, `exclude ["node_modules","dist","skills","deploy"]`.
   Leave `apps/server/dashboard/tsconfig*.json` untouched (Vite/Bundler; it
   can adopt the base later).
7. Add per-package `typecheck` scripts so `turbo run typecheck` has targets:
   `apps/server`: `"typecheck": "tsc --noEmit"`; `apps/server/dashboard`:
   `"typecheck": "tsc -b"`. Adjust any `apps/server/package.json` scripts that
   assumed the repo root (they now run with cwd = `apps/server`, which is what
   they always assumed relative to themselves — expect little to no change;
   `cli`/`build:issue`'s `tsx src/cli.ts` path still resolves).
8. `pnpm install` — the lockfile importer keys move to the new paths; commit
   the lockfile change. Then update `.github/workflows/ci.yml`'s three check
   steps to the canonical entry: `pnpm turbo run typecheck test build`
   (keeping the pnpm/action-setup + Node 22 steps from Phase 1, and the
   `workflow_call` surface).

### Step group 3 — Docker (F2)

9. Rewrite `apps/server/Dockerfile` to a multi-stage pnpm workspace build,
   **build context = repo root**. Skeleton (filters use the *current* package
   names — `lastlight` and `@lastlight/dashboard`; Phase 4 updates them to
   `@lastlight/core`):
   ```dockerfile
   FROM node:22-slim AS build
   RUN corepack enable
   WORKDIR /repo
   COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
   COPY apps/server/package.json apps/server/package.json
   COPY apps/server/dashboard/package.json apps/server/dashboard/package.json
   RUN pnpm install --frozen-lockfile --filter lastlight... --filter @lastlight/dashboard...
   COPY apps/server/ apps/server/
   RUN pnpm --filter lastlight build && pnpm --filter @lastlight/dashboard build
   RUN pnpm --filter lastlight deploy --prod /app

   FROM node:22-slim
   # UNCHANGED from today's runtime half: apt system deps (git ripgrep curl jq
   # gosu python3 make g++), docker CLI install, useradd -u 10001 lastlight
   WORKDIR /app
   COPY --from=build /app /app
   # pnpm deploy packs per the `files` field — restore anything it omits:
   COPY --from=build /repo/apps/server/dashboard/dist /app/dashboard/dist
   COPY --from=build /repo/apps/server/CLAUDE.md /app/CLAUDE.md
   VOLUME ["/app/data"]
   ENV STATE_DIR=/app/data LASTLIGHT_SESSIONS_DIR=/app/data/agent-sessions NODE_ENV=production
   ARG GIT_SHA="" 
   ARG BUILD_DATE=""
   ENV LASTLIGHT_GIT_SHA=$GIT_SHA LASTLIGHT_BUILD_DATE=$BUILD_DATE
   EXPOSE 8644
   ENTRYPOINT ["/app/deploy/entrypoint.sh"]
   CMD ["node", "dist/index.js"]
   ```
   **Critical:** `pnpm deploy` selects files per the package `files` field
   (`dist config workflows skills agent-context deploy sandbox.Dockerfile
   docker-compose.yml .claude-plugin plugins`) — it will omit
   `dashboard/dist/` and `CLAUDE.md`. **Do not widen `files`** (the npm
   tarball list is a fence); add explicit `COPY --from=build` lines instead,
   as above. Native deps: `better-sqlite3` compiles during `pnpm install` in
   the build stage — if the runtime stage's node ABI matches (both
   `node:22-slim`), the copied `node_modules` works; keep python3/make/g++ in
   the runtime stage anyway (today's image has them and sandbox tooling may
   rely on them).
10. **Image inventory check** (part of Verification but designed here): the
    built image's `/app` must contain `dist/ dashboard/dist/ config/
    workflows/ skills/ agent-context/ deploy/ plugins/ .claude-plugin/
    CLAUDE.md node_modules/ package.json`. `/app` cwd + those dirs is exactly
    what F3 (`dashboard/dist`) and the asset loaders assume.
11. `apps/server/docker-bake.hcl`: for all four targets (`agent`,
    `sandbox-base`, `sandbox`, `sandbox-qa`) set `dockerfile =
    "apps/server/<name>.Dockerfile"` and keep `context = "."`. The
    `contexts { sandbox-base = "target:sandbox-base" }` linkage and
    `BASE_IMAGE` args are unchanged. Note bake runs from the **repo root**
    now: `docker buildx bake -f apps/server/docker-bake.hcl core` (the
    `publish.yml` invocation gains the `-f`; update it in this phase so the
    frozen workflow stays truthful).
12. Sandbox Dockerfiles — repoint the repo-relative COPYs (context is the
    repo root):
    - `sandbox.Dockerfile` (pin COPY was line 32 pre-move):
      `COPY sandbox/agentic-pi.pin` → `COPY apps/server/sandbox/agentic-pi.pin`;
      `COPY agent-context/` → `COPY apps/server/agent-context/`;
      `COPY deploy/sandbox-entrypoint.sh` → `COPY apps/server/deploy/sandbox-entrypoint.sh`.
    - `sandbox-qa.Dockerfile` (pin COPY was line 123 pre-move): same three
      repoints.
    - `sandbox-base.Dockerfile` has no repo COPYs — confirm and leave alone.
13. `apps/server/docker-compose.yml`: for the `agent`, `sandbox-base`,
    `sandbox`, `sandbox-qa` services set `build.dockerfile:
    apps/server/<name>.Dockerfile` (contexts stay `.` — they resolve against
    `--project-directory`, i.e. the repo root). `./instance:/app/instance:ro`
    is **unchanged** (resolves to `<home>/instance`). Locate the `caddy`
    service's Caddyfile mount and repoint `./Caddyfile` →
    `./apps/server/Caddyfile`. Audit every other `./`-relative volume the same
    way (they now mean repo-root-relative).
14. Audit `.dockerignore` (stays at the repo root — the context does):
    rewrite `dashboard/node_modules`-style entries to `apps/server/...` and
    add `apps/server/dashboard/node_modules`, `**/.turbo`, `**/dist` where
    appropriate (but NOT `apps/server/dashboard/dist` exclusions that would
    break the build-stage COPY — the build stage copies sources and builds
    dists itself, so ignoring local dist dirs is safe and keeps the context
    small).
15. Verify `apps/server/scripts/agentic-pi-pin.sh` +
    `apps/server/tests/agentic-pi-pin.test.ts` still resolve
    `pnpm-lock.yaml` — it now lives **two levels up** from the package. Fix
    the relative path (or resolve upward until found) as part of this phase.

### Step group 4 — the F5 split in `cli-server.ts`

Pre-move line references: compose-binary resolution at
`src/cli/cli-server.ts:150-164`, `runStep` cwd at `:177`, `composeRun` at
`:186-189`, `ensureOverrideSymlink` at `:218-236`, `requireHome` at `:332`,
`enumerateOverlayAssets` call at `:655`.

16. Introduce the split near the home helpers:
    ```ts
    const serverDir = (home: string) => path.join(home, "apps", "server");
    ```
    `home` remains the **git root** (all `git -C home` operations, the
    `instance/` clone target, `readCorePin(home/instance)`, and
    `ensureOverrideSymlink(home)` are untouched).
17. Centralize the compose invocation in `composeRun` so no callsite changes:
    build an argv prefix
    ```ts
    function composeFileArgs(home: string): string[] {
      const args = ["-f", path.join(serverDir(home), "docker-compose.yml")];
      const override = path.join(home, "docker-compose.override.yml");
      if (fs.existsSync(override)) args.push("-f", override);
      args.push("--project-directory", home);
      return args;
    }
    ```
    and splice it between the compose binary's `pre` args and the command
    args. Rationale (from the design): explicit `-f` **disables compose's
    auto-override loading**, so the override symlink must be passed as a
    second `-f` when present; `--project-directory <home>` keeps the compose
    file's `build.context: .` = repo root and `./instance` = `<home>/instance`.
18. Repoint `enumerateOverlayAssets` (the `:655` callsite in `serverStatus`):
    `coreRoot: home` → `coreRoot: serverDir(home)` — the built-in
    `workflows/skills/agent-context` now live under `apps/server/`.
    `overlayRoot: path.join(home, "instance")` is unchanged.
19. Extract the argv assembly into a pure, exported helper and pin it with a
    unit test (F5 regression fence), e.g. asserting
    `composeArgv(home, ["up","-d"])` deep-equals
    `["compose","-f",".../apps/server/docker-compose.yml","--project-directory",home,"up","-d"]`
    with and without the override file present.
20. Grep for any other repo-root assumptions in the CLI:
    `rg -n '"docker-compose|Dockerfile|docker-bake' apps/server/src/cli/` —
    e.g. the `server build` GIT_SHA lookup (`git rev-parse HEAD`, cwd=home) is
    fine; anything reading compose/bake files by path must go through
    `serverDir()`.

### Step group 5 — dev workflow + docs banner

21. `apps/server/scripts/dev-local.sh` moved with core; its
    `PROJECT_ROOT="$SCRIPT_DIR/.."` now equals `apps/server` — **relocation
    only, no logic change**. Consequences to note in the doc/commit message:
    the dev `.env`, `data/`, and `secrets/` it creates now live under
    `apps/server/`, and the harness runs with **cwd = `apps/server`**, which
    is exactly what preserves F3 locally (`dashboard/dist` resolves).
    Developers move their local `.env` once: `git mv` doesn't cover untracked
    files — mention `mv .env apps/server/.env` in the PR description.
22. Root scripts already delegate (step 3). Confirm `pnpm dev` (concurrently:
    dev-local.sh + dashboard vite) works from the root via
    `pnpm --filter lastlight dev`.
23. Add a two-line banner at the top of `apps/server/CLAUDE.md`: paths in the
    file predate the monorepo move; the full docs-sync pass (CLAUDE.md, spec/,
    lastlight-www) happens in Phase 7. **Do not rewrite CLAUDE.md now.**

## Verification

```bash
# Workspace green (canonical entry from this phase on)
pnpm install && pnpm turbo run typecheck test build

# Tarball fence — file list identical to /tmp/pack-baseline-phase2.txt
cd apps/server && npm pack --dry-run

# F2 — images build from the new layout
docker buildx bake -f apps/server/docker-bake.hcl core

# F2/F3 — boot the agent image and probe it (dummy env is fine; the probe is
# that the process starts, /health responds, and /admin serves the SPA)
docker run --rm -d --name ll-probe -p 8644:8644 --env-file <dev .env> lastlight-agent
curl -fsS http://127.0.0.1:8644/health
curl -fsSI http://127.0.0.1:8644/admin | head -1        # 200, text/html
docker exec ll-probe ls /app                            # inventory: dist dashboard config workflows skills agent-context deploy plugins CLAUDE.md node_modules package.json
docker rm -f ll-probe

# F5 — host-local CLI against home = repo root
pnpm --filter lastlight run cli -- server status --home "$PWD"   # compose ps + drift + overrides listing
pnpm --filter lastlight run cli -- server build --home "$PWD"    # exercises the compose -f/--project-directory path end-to-end
npx vitest run apps/server/tests/cli/compose-argv.test.ts        # the argv fence

# History fence
git log --follow --oneline apps/server/src/index.ts | tail -3    # shows pre-move commits
```

## Rollback

Revert the phase branch (the rename-only commit reverts cleanly as a rename
back). Nothing is published (release freeze) and prod hosts are pinned to the
pre-migration tag, so no deployed system references the new layout. If the
phase must be abandoned mid-way after partial merge, restoring green means
reverting through the rename commit — do not try to hotfix a half-moved
layout.

## Out of scope

- Renaming the package to `@lastlight/core`, removing its `bin`, moving
  `plugins/`/`.claude-plugin/` — Phase 4.
- The workflow-engine extraction — Phase 3.
- Importing www/evals — Phases 5–6.
- CI consolidation beyond keeping `ci.yml` green, the publish flow, deploy jobs,
  the docs-sync pass over CLAUDE.md/spec — Phase 7.
- Any edit to `src/admin/index.ts` (F3 is preserved by cwd, never by editing
  the `dashboard/dist` string).

## Deviations

Executed 2026-07-15 (commits `4772140`…; rename-only commit is `4772140`,
376 renames, `git log --follow` verified). Deviations from this doc:

1. **F2 gate ran on `docker compose build`, not `docker buildx bake`** — the
   build host's docker CLI (29.5.2) has no buildx plugin (same as Phase 1).
   All four images were built from the new layout via the split invocation
   (`docker compose -f apps/server/docker-compose.yml --project-directory .
   build …` + `lastlight server build --home <repo root>`), and the agent
   image was booted and probed (`/health` 200, `/admin` 200 text/html,
   `/app` inventory complete). The bake file itself could not be executed
   locally; it is exercised next by `publish.yml` in CI.
2. **`docker-bake.hcl` uses `context = "../.."`, not the doc's "keep
   `context = "."`"** — buildx bake resolves relative paths against the
   *bake file's directory* (documented behaviour), so `"."` would have meant
   `apps/server/`, not the repo root. `dockerfile` paths are context-relative
   (`apps/server/<name>.Dockerfile`), and cwd of the bake invocation no
   longer matters. `publish.yml` gained `-f apps/server/docker-bake.hcl` on
   both bake steps as planned.
3. **`publish.yml` npm job also updated** (beyond the doc's bake-only
   mention): the `npm publish` step gained `working-directory: apps/server`
   — the root package is now `private: true` and would have failed/been
   wrong. Keeps the frozen workflow truthful; the real publish flow is
   Phase 7's.
4. **`engines` kept in `apps/server/package.json`** (only `packageManager`
   was removed as duplicated). `engines` is part of the published package's
   contract and keeping it preserves the 0.16.0 tarball's package.json
   semantics; the root also declares it.
5. **Tarball fence:** post-move `npm pack --dry-run` = baseline minus three
   stale `dist/engine/executors/backends.*` files — stale artifacts in the
   old root `dist/` with no matching `src/` file (the fresh build rightly
   omits them); the lists are otherwise identical. `apps/server/README.md`
   (new, brief pointer) and `LICENSE` (copy of the root one) were added
   because npm auto-includes both and the baseline tarball shipped them.
6. **Pre-existing breakage fixed:** the `cli`/`build:issue` scripts ran
   `tsx src/cli.ts`, which hasn't existed since the `src/cli/` regroup
   (`fa2e12b`) — the doc's claim that the path "still resolves" had drifted.
   Repointed to `src/cli/cli.ts` (the F5 verification depends on the
   script).
7. **`.dockerignore`:** dockerignore patterns are context-root-anchored
   (unlike gitignore), so the audit added `**/` forms rather than relying on
   unanchored entries — including a hardening pass for `**/.env`, `**/*.pem`,
   `**/secrets/` now that the build stage COPYs `apps/server/` wholesale.
   Dead legacy (Hermes-era) entries were left as-is.
8. **Step-20 grep fixes beyond `cli-server.ts`:** `setup.ts`'s preflight now
   recognizes a checkout by `apps/server/docker-compose.yml` (root compose
   kept as a pre-monorepo fallback), and `fork-cli.ts`'s `resolveCoreRoot`
   prefers `<candidate>/apps/server` so `fork --home <git root>` reads the
   checkout's built-ins instead of silently falling back to the CLI's
   bundled assets. (Both are reworked anyway in Phase 4.)
9. **Pre-existing, left alone:** `npm run typecheck:test`
   (`tsc -p tsconfig.test.json`) fails in `tests/notify/transports.test.ts`
   (vitest mock-call tuple typings). Verified present without this phase's
   edits; CI has never run that script. `turbo run typecheck test build` is
   green.
10. **Verification-command drift:** `pnpm --filter lastlight run cli --
    server status …` forwards the literal `--` to the CLI (pnpm behaviour)
    and misroutes to the remote `status` command; the F5 gates were run as
    `npx tsx src/cli/cli.ts server status|build --home <repo root>` from
    `apps/server` instead.
11. **`secrets/.gitignore`** was moved as a single tracked file; untracked
    local `secrets/` contents (and the root `.env`, `data/`, stale `dist/`)
    stayed at the repo root — developers move them into `apps/server/`
    manually, per step 21. The untracked `deploy/slack/` directory traveled
    on disk with `deploy/` to `apps/server/deploy/slack/` and remains
    untracked.
