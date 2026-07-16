# Phase 7 — Consolidated CI, manual publish flow, Cloudflare deploys, end of the release freeze

Risk: **medium** — the danger is breaking the **images-before-npm** ordering
guarantee (GHCR images for a version must exist before the CLI that pulls
them goes live on npm). Read [README.md](README.md) and
[00-target-architecture.md](00-target-architecture.md) first — this doc
executes locked decisions 5 (release freeze ends here), 13 (version
continuity), 14 (`@lastlight/shared` publishes) and 15 (**manual npm
publishing** — no Changesets; the operator runs the publishes).

## Goal

Finish the operational consolidation: one root CI that turbo-skips untouched
packages, a **documented manual versioning/publish flow** for the five
published packages (`lastlight`, `@lastlight/core`, `@lastlight/shared`,
`@lastlight/workflow-engine`, `lastlight-evals`), new Cloudflare deploy
Actions for www and evals, the docs pass, and the **end-of-freeze runbook**
that takes prod off its pre-migration pin. Then archive the two standalone
repos.

Facts this phase relies on (verified 2026-07-14):

- Pre-migration `ci.yml`: triggers `pull_request`, `push` to `main`, and
  **`workflow_call`** (optional input `ref`); one `check` job (was Node 24 →
  Node 22 since Phase 1). Pre-migration `publish.yml`: triggers
  `release: [published]` + `workflow_dispatch` (input `tag`); ordered jobs
  `checks` (uses `./.github/workflows/ci.yml` with `ref`) → `images`
  (`needs: checks`; GHCR login + buildx; `docker buildx bake --push core`
  with env `GIT_SHA=github.sha`, `BUILD_DATE`, `TAG`, `PUSH_LATEST`; then
  `docker buildx bake --push sandbox-qa` with `continue-on-error: true`) →
  `npm` (`needs: images`, `if: github.event_name == 'release'`).
  Permissions: `contents: read, packages: write, id-token: write`.
  `PUSH_LATEST` only on real non-prerelease releases.
- `docker-bake.hcl` targets already point at `apps/server/*.Dockerfile` with
  `context = "."` (Phase 2); `GIT_SHA`/`BUILD_DATE` flow as build args to the
  `agent` target only.
- www has **no CI/CD at all today** (manual `npm run deploy`); evals' old
  `ci.yml`/`publish.yml` were deleted in Phase 6.
- `apps/evals/scripts/build-site.ts`: copies `dashboard/dist` → `dist-site/`,
  copies `eval-results/` → `dist-site/data` **only if it exists**
  (existsSync-guarded), and bakes `dist-site/api/index` via `buildIndex`
  from `src/report.js`. `eval-results/` is **gitignored** — absent in CI.
- Prod topology (local agent memory): both overlay repos
  (`cliftonc/lastlight-instance` → drizby, `nearform/lastlight-nearform` →
  nearform) auto-run `lastlight server update` on push to main; the hosts'
  **global CLI is versioned separately** and must be updated *before* a
  deploy that changes CLI behaviour.

## Preconditions

- Phases 1–6 ticked; repo green from a clean clone.
- Both prod overlays still pinned to the pre-migration release (pre-flight);
  release freeze still in effect.
- Repo admin access (secrets, releases, archiving) for the manual steps.

## Files created / modified

| File | Change |
|---|---|
| `.github/workflows/ci.yml` | finalize: turbo cache step; keep `workflow_call` + `ref` input; keep the Phase 3 dep-cruiser gate |
| `.github/workflows/publish.yml` | **remove the `npm` job** (publishing is manual, decision 15); keep `checks → images` + both triggers |
| `.github/workflows/deploy-www.yml` | **new** — push-to-main deploy, path-filtered |
| `.github/workflows/deploy-evals.yml` | **new** — push-to-main deploy, path-filtered |
| `docs/RELEASING.md` | **new** — the manual version-bump + publish-order runbook |
| `apps/evals/scripts/build-site.ts` | only if needed: tolerate missing `eval-results/` in `buildIndex` |
| Docs (`CLAUDE.md`s, `apps/server/spec/*`, `packages/cli/plugins/lastlight/skills/*`) | path/layout updates — checklist step 6 |

## Steps

1. **Finalize `ci.yml`.** Keep the trigger surface exactly (`pull_request`,
   `push` to `main`, `workflow_call` with optional `ref` — `publish.yml`
   depends on it). Body: checkout (ref-aware) → `actions/setup-node` (Node 22,
   from `.nvmrc`) → pnpm via corepack → `pnpm install --frozen-lockfile` →
   restore/save `actions/cache` on `.turbo` (key:
   `turbo-${{ runner.os }}-${{ github.sha }}`, restore-keys
   `turbo-${{ runner.os }}-`) → `pnpm turbo run typecheck test build`. Keep
   the dependency-cruiser boundary gate added in Phase 3 (it runs as part of
   a package's `test`/`lint` task — confirm it executes in the turbo run, do
   not silently drop it).

2. **Write `docs/RELEASING.md` — the manual publish flow** (decision 15: the
   operator publishes by hand; no Changesets, no CI npm job). Contents:
   - **Version bumps are manual and graph-aware.** When `@lastlight/shared`
     or `@lastlight/workflow-engine` changes, bump the dependents that pick
     it up (`@lastlight/core`, `lastlight`, and `lastlight-evals` via core) —
     this is the step manual flows historically get wrong, so RELEASING.md
     carries an explicit dependency-order table. Baselines were set in
     Phase 4 (cli + core at 0.16.0, engine + shared at 0.1.0); evals
     continues its 0.7.x line. Keep
     `packages/cli/plugins/lastlight/.claude-plugin/plugin.json` in version
     lockstep with the CLI (manual, same as today).
   - **Publish order** (dependency order — pnpm rewrites `workspace:*` to
     concrete ranges at pack time, so a dep must be live before its
     dependent): `@lastlight/workflow-engine` → `@lastlight/shared` →
     `@lastlight/core` → `lastlight` → `lastlight-evals`. In practice
     `pnpm -r publish --access public` handles the topological order in one
     command; per-package `pnpm --filter <name> publish --access public`
     works when only some packages changed.
   - **Images before npm** (the old chain's guarantee, now procedural): tag +
     GitHub Release first → `publish.yml` builds/pushes the `vX.Y.Z` GHCR
     images → `gh run watch` until green → *then* run the npm publishes.
     Never publish a `lastlight` version whose images aren't in GHCR yet.

3. **Trim `publish.yml` to `checks → images`.** Delete the `npm` job
   entirely (its Phase 1 pnpm-swap kept it valid during the freeze; it is
   now superseded by the manual flow). The `checks` and `images` jobs are
   already correct (pnpm setup from Phase 1, bake paths from Phase 2) —
   **do not** reorder them. Both triggers stay: `release: [published]` and
   `workflow_dispatch` (input `tag`) are now both images-(re)build paths.
   Drop the now-unused `id-token: write` permission if nothing else needs it.

4. **Cloudflare deploy Actions** (new automation — www had none; keep them
   deploy-only leaf jobs, never part of shared CI):

   `deploy-www.yml`: `on: push` to `main`, `paths: ["apps/www/**",
   "apps/server/spec/**"]` (spec edits re-render the docs pages). Job:
   pnpm setup → `pnpm install --frozen-lockfile` → `pnpm --filter
   lastlight-www build` → `pnpm exec wrangler deploy` with
   `working-directory: apps/www` and `CLOUDFLARE_API_TOKEN` from secrets.

   `deploy-evals.yml`: `on: push` to `main`, `paths: ["apps/evals/**"]`. Job:
   pnpm setup → install → `pnpm --filter lastlight-evals... run build:site`
   (the `...` builds workspace deps first — core must exist for the harness
   build inside `build`) → `pnpm exec wrangler deploy` in
   `working-directory: apps/evals`.

   **Manual sub-step:** create the `CLOUDFLARE_API_TOKEN` repo secret (a
   token scoped to Workers deploys on the `lastlight.dev` zone account).

   **The evals data nuance:** `eval-results/` is gitignored, so CI bakes a
   site with an empty `data/`. That is by design — the Action keeps the SPA
   **shell** current; publishing refreshed results remains the manual local
   `npm run deploy` from a machine holding `eval-results/` (see the
   evals-live-dashboard memory). Before enabling the Action, confirm
   `build-site.ts` tolerates a missing `eval-results/`: the `cpSync` is
   existsSync-guarded; check `buildIndex(resultsRoot, …)` (imported from
   `src/report.js`) handles a nonexistent root — if it throws, patch it to
   return an empty index instead. Caution: a shell-only CI deploy after a
   manual data deploy resets `/data` to empty — accepted for now; note it in
   the workflow file's header comment.

5. **Docs pass.** Run the **docs-sync** skill against the migration's full
   diff, with this checklist as the floor:
   - Root `CLAUDE.md`: create a thin monorepo orientation file (workspace
     map, where the old guide went); the full dev guide moved to
     `apps/server/CLAUDE.md` in Phase 2 — sweep it for stale root-relative
     paths (`src/…` → still correct *within* apps/server; commands like
     `npm run dev` → `pnpm --filter @lastlight/core dev`).
   - `apps/server/spec/*.md` pages that describe repo layout, build, deploy.
   - The Claude Code skills shipped with the CLI
     (`packages/cli/plugins/lastlight/skills/lastlight-{server,overlay,evals,client}/`)
     teach checkout layouts and `lastlight server` behaviour — update paths
     (`apps/server`, compose `-f` invocation, `LASTLIGHT_CORE_DIR` example)
     and the `plugin.json` version (kept in lockstep with the CLI — a manual
     bump; it is in RELEASING.md's checklist).
   - `docs/monorepo-migration-design.md`: mark superseded-by-this-plan where
     drifted (e.g. four→five published packages).

6. **End-of-freeze runbook** — ordered; steps marked ✋ require explicit human
   confirmation before executing:
   1. Land steps 1–5 on `main`; CI green.
   2. Cut the first post-migration release per RELEASING.md: bump the five
      package versions (dependency-aware) + `plugin.json`, commit, tag
      `vX.Y.Z`, create the GitHub Release → `publish.yml` pushes the
      `vX.Y.Z` images to GHCR; `gh run watch` until green. ✋ Then publish to
      npm manually in dependency order (engine → shared → core → cli →
      evals; `pnpm -r publish --access public` — skip any already published
      manually at Phase 4). Confirm with
      `npm view lastlight@X.Y.Z version --prefer-online`.
   3. ✋ On **each** prod host (drizby, nearform), update the global CLI
      **first**: `npm i -g lastlight@X.Y.Z`. The old CLI runs bare
      `docker compose` with cwd = repo root and cannot drive the
      `apps/server` layout — the CLI-before-deploy rule is load-bearing here,
      not hygiene.
   4. ✋ Bump `deploy.version: vX.Y.Z` in **both** overlay repos and push —
      the overlay auto-deploy Actions run `lastlight server update`, which
      converges the core checkout to the tag (now a monorepo checkout) and
      pulls the `vX.Y.Z` images.
   5. Verify each host: `lastlight server status` (pinned vX.Y.Z, services
      up), `curl http://127.0.0.1:8644/health`, dashboard loads `/admin`
      (F3 in production), one live workflow run.
   6. ✋ Archive the standalone repos: push a final README pointer commit to
      `nearform/lastlight-www` and `nearform/lastlight-evals` ("moved into
      nearform/lastlight — apps/www | apps/evals"), then
      `gh repo archive nearform/lastlight-www` and
      `gh repo archive nearform/lastlight-evals`.
   7. The release freeze is over — normal releases follow RELEASING.md from
      here.

## Verification

```bash
# CI + build integrity from nothing
git clone <repo> /tmp/ll-clean && cd /tmp/ll-clean
corepack enable && pnpm install --frozen-lockfile
pnpm turbo run typecheck test build

# The five public packages pack correctly with workspace:* rewritten
pnpm -r publish --dry-run --access public --no-git-checks
# expect exactly: lastlight, @lastlight/core, @lastlight/shared,
# @lastlight/workflow-engine, lastlight-evals (private pkgs skipped);
# spot-check a tarball's package.json shows concrete ranges, not workspace:*

# Release chain dry-run (no npm publish): images-only dispatch
gh workflow run publish.yml -f tag=<existing-tag> && gh run watch

# Path filters behave
#  - push a docs-only change → deploy-www / deploy-evals must NOT trigger
#  - push an apps/server/spec/*.md change → deploy-www MUST trigger
gh run list --workflow=deploy-www.yml --limit 3
```

Plus the runbook's own production checks (step 6.5).

## Rollback

- Until runbook step 6.4, prod remains on the pre-migration pin — every
  earlier step is a plain git revert of workflow/config files.
- If the first post-migration deploy fails on a host: re-pin the overlay's
  `deploy.version` to the pre-migration tag and push (auto-deploy converges
  back — the old images are still in GHCR), and `npm i -g lastlight@<old>`
  to restore the matching CLI.
- Repo archiving is last precisely because it is the only step with external
  visibility; it is reversible (`gh repo unarchive`).

## Out of scope

- Turbo remote caching, npm trusted publishing migration.
- Changesets (or any publish automation) — deliberately dropped, decision 15:
  the operator publishes manually. Revisit only if the manual graph-aware
  bumping proves error-prone in practice.
- Backfilling www CI (typecheck/lint for Astro) beyond the deploy job.
- Automating eval-results publication (stays manual by design).

## Deviations

- **`docker buildx bake` path asserted by inspection, not executed.** The build
  host has no buildx plugin, so the `images` job's bake path (and the deploy
  Actions' actual Cloudflare deploy) could not be run locally. Correctness was
  verified by careful reading: `apps/server/docker-bake.hcl` targets already use
  `context = "../.."` + `dockerfile = "apps/server/*.Dockerfile"` (Phase 2/4
  deviation, preserved — NOT reverted to `context = "."`), and `publish.yml`
  invokes them unchanged with `-f apps/server/docker-bake.hcl`. The `checks →
  images` chain is intact after removing the `npm` job (`images` still
  `needs: checks`).
- **`ci.yml` kept `pnpm/action-setup@v4` + `setup-node cache: pnpm`** (the
  Phase 1 shape) rather than switching to a raw corepack step as the doc's prose
  suggested — the existing setup already provides pnpm and a store cache; only
  the `.turbo` cache step was added (path `.turbo`, which is where Turbo 2.10.5
  writes its local cache and which `.gitignore` already excludes).
- **The dep-cruiser boundary gate was already wired into `typecheck`**, not a
  separate `test`/`lint` task: `apps/server` and `packages/workflow-engine` both
  run `tsc --noEmit && pnpm run lint:boundaries` as their `typecheck` script, so
  `pnpm turbo run typecheck` (already in `ci.yml`) executes it. No change needed
  to keep it — confirmed it still runs in the turbo graph.
- **`build-site.ts` needed no patch.** `buildIndex` (imported from `src/report.ts`)
  already returns `{ generatedAt, tiers: [] }` when the results root is missing
  (report.ts:581), and the `cpSync` of `eval-results/` is `existsSync`-guarded.
  A local `pnpm --filter lastlight-evals... run build:site` with `eval-results/`
  absent produced an empty `/api/index` and no `/data` — exactly the shell-only
  CI behaviour deploy-evals.yml documents.
- **`publish.yml` `id-token: write` permission dropped.** It existed only for
  npm provenance on the removed `npm` job; nothing else needs it. `packages:
  write` (GHCR push) is retained.
- **Root `CLAUDE.md` was created fresh, not edited.** Phase 2 `git mv`'d the
  original root guide into `apps/server/CLAUDE.md`, leaving no root file — so the
  thin monorepo-orientation `CLAUDE.md` is a new file pointing at
  `apps/server/CLAUDE.md` for the full guide. (The `# claudeMd` project-context
  block still shows the pre-move full guide; that is a stale cache, not a
  tracked root file.)
- **Docs-sync pass is partial (deliberately scoped).** The load-bearing,
  low-risk doc items were done in-phase: the thin root `CLAUDE.md` and the
  "four→five published packages" superseded marker in
  `docs/monorepo-migration-design.md`. The broader step-5 sweep — path updates
  across `apps/server/spec/*.md` and the CLI-shipped Claude Code skills
  (`packages/cli/plugins/lastlight/skills/*`), plus the `plugin.json` version
  bump — is left for a dedicated docs-sync commit at release time: it is not
  load-bearing for the CI/publish/deploy config this phase lands, `plugin.json`
  is bumped as part of RELEASING.md's release checklist (not now, during the
  freeze), and the skill/spec path edits are a large surface best reviewed on
  their own rather than bundled into the workflow-config change.
- **`pnpm -r publish --dry-run` does not list all five** because it consults the
  registry and skips versions already published: `lastlight@0.16.0` and
  `lastlight-evals@0.7.1` already exist on npm (the pre-migration standalone
  packages), so only the three new scoped names (`@lastlight/{core,shared,
  workflow-engine}`) show as "would publish". This is correct — and is the guard
  that forces the first post-migration `lastlight` version above 0.16.0
  (decision 13). Full five-package pack correctness (including `workspace:*` →
  concrete-pin rewrite, and zero `workspace:` leakage) was proven with
  registry-free `pnpm pack` per package instead.
