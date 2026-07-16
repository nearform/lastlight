# Monorepo migration — implementation plan index

Re-architect the three sibling repos (`lastlight`, `lastlight-www`,
`lastlight-evals`) into one **pnpm + Turborepo** monorepo, extracting
`@lastlight/workflow-engine` and a **lean CLI published as `lastlight`** along
the way. Each app keeps publishing/deploying independently (npm + Cloudflare +
GHCR).

This directory is the executable plan for
[`docs/monorepo-migration-design.md`](../../monorepo-migration-design.md). Each
phase doc is self-sufficient: an agent with no prior context should be able to
execute its phase from that doc plus this README and
[00-target-architecture.md](00-target-architecture.md) alone.

## Status / todo list

Execute strictly in this order — each phase depends on the previous one and
each must leave the repo green before the next starts.

- [x] **Pre-flight** — [see below](#pre-flight-protect-prod-before-phase-2)
  — pin both prod overlays to the last pre-migration release; declare the
  release freeze. *(verified 2026-07-15: both overlays already pin
  `deploy.version: v0.16.0`, the last pre-migration release; release freeze
  declared in the migration PR description)*
- [x] **Phase 1 (A)** — [01-tooling-skeleton.md](01-tooling-skeleton.md) —
  pnpm + Turborepo skeleton, NO file moves; convert the npm workspace, swap
  CI + Dockerfile installs to pnpm *(risk: low)*
- [x] **Phase 2 (B)** — [02-core-move.md](02-core-move.md) — `git mv` core
  into `apps/server`; Docker context/bake/compose repoint; the `lastlight
  server` home/serverDir split — fences **F2 F3 F5** *(risk: HIGH)*
  *(done 2026-07-15; F2 gated via `docker compose build` — no buildx on the
  build host; see the phase doc's Deviations)*
- [x] **Phase 3 (C)** — [03-workflow-engine.md](03-workflow-engine.md) —
  extract `@lastlight/workflow-engine` per
  [workflow-engine-extraction-design.md](../../workflow-engine-extraction-design.md)
  (Milestone A in-repo, Milestone B package lift) *(risk: medium)*
  *(done 2026-07-16; step 1 landed by a prior agent as 20fa7b6; engine now at
  `packages/workflow-engine`, workspace:* dep, dep-cruiser boundary gates green,
  turbo ^build orders engine→core; see the phase doc's Deviations)*
- [x] **Phase 4 (D)** — [04-cli-shared-rename.md](04-cli-shared-rename.md) —
  extract `packages/cli` (published `lastlight`) + `@lastlight/shared`; rename
  the server package to `@lastlight/core` — fence **F4** *(risk: HIGH)*
  *(done 2026-07-16; F4 gated via a throwaway verdaccio registry — pnpm/npm
  publish to real npm stays frozen; clean-container install 134M, all six heavy
  deps absent, pi-ai's provider-SDK tree dominates as flagged. loader + oauth
  kept re-export shims; core imports narrow shared subpaths. Also fixed a latent
  Phase-3 Dockerfile gap. See the phase doc's Deviations.)*
- [x] **Phase 5 (E)** — [05-import-www.md](05-import-www.md) — subtree-import
  `lastlight-www` into `apps/www`; re-point `sync-spec.mjs` *(risk: low)*
  *(done 2026-07-16; history-preserving subtree merge df7861c; folded npm
  lockfile into pnpm-lock, marked private, re-pointed spec sync to
  ../server/spec. Declared a phantom `zod` devDep pnpm's strict linking
  surfaced. `pnpm --filter lastlight-www build` emits dist/ with spec pages
  from apps/server/spec; workspace green. See the phase doc's Deviations.)*
- [x] **Phase 6 (F)** — [06-import-evals.md](06-import-evals.md) —
  subtree-import `lastlight-evals` into `apps/evals`; flip its dep to
  `@lastlight/core` — fence **F1** *(risk: HIGH)*
  *(done 2026-07-16; history-preserving subtree merge 4276964; dep flipped to
  `@lastlight/core: workspace:*`, four barrel/resolver references retargeted to
  `@lastlight/core`, both nested npm lockfiles + inert `.github/` deleted,
  dashboard scripts switched to `pnpm --filter`. F1 resolution proven both ways
  through the workspace symlink; live-model eval half not run — no provider key.
  See the phase doc's Deviations.)*
- [x] **Phase 7 (G)** — [07-ci-publish-deploys.md](07-ci-publish-deploys.md)
  — consolidated CI, the manual publish flow (RELEASING.md), Cloudflare
  deploy jobs; end the release freeze; archive the old repos *(risk: medium)*
  *(done 2026-07-16; ci.yml gained a `.turbo` cache step; publish.yml trimmed
  to `checks → images` — the `npm` job + `id-token` permission removed;
  deploy-www.yml + deploy-evals.yml added (path-filtered leaf deploys, need
  the `CLOUDFLARE_API_TOKEN` repo secret); `docs/RELEASING.md` authored (manual
  graph-aware publish flow + end-of-freeze runbook); thin root `CLAUDE.md`
  created. `pnpm pack` proves all five publishables rewrite `workspace:*` to
  concrete pins; `pnpm -r publish --dry-run` registry-skips `lastlight@0.16.0`
  + `lastlight-evals@0.7.1` (already on npm) — the exact guard forcing the
  first post-migration CLI bump > 0.16.0. build-site.ts already tolerates a
  missing `eval-results/` (no patch). The end-of-freeze runbook steps
  (publish, host CLI update, overlay unpin, repo archive) are DOCUMENTED, not
  executed — they are post-merge operator actions. See the phase doc's
  Deviations.)*

**All seven phases complete.** The consolidated monorepo is green from a clean
checkout; the release freeze remains in effect until the operator runs the
Phase 7 end-of-freeze runbook (07-ci-publish-deploys.md §6, and
`docs/RELEASING.md`) after this branch merges to `main`.

Architecture reference (read before any phase):
[00-target-architecture.md](00-target-architecture.md).

## How to work a phase

1. Read this README and [00-target-architecture.md](00-target-architecture.md),
   then your phase doc end-to-end before touching code.
2. Verify the phase's **preconditions** (previous phases' checkboxes ticked).
3. Execute the steps. The phase docs cite file paths and line numbers that were
   accurate when written (verified against source on 2026-07-14) — if a
   reference has drifted, trust the described pattern over the line number and
   note the drift.
4. Run the phase's **verification** section. Every phase must end green:
   `pnpm install && pnpm turbo run typecheck test build` from a clean checkout,
   plus the phase's own gates (Docker gates where flagged).
5. Tick the checkbox above, and record any deviations from the doc (what and
   why) in a short **Deviations** section appended to the phase doc itself.
6. Commit the phase as one or more focused commits; do not start the next phase
   in the same commit. Phase 2's `git mv` MUST be its own rename-only commit
   (history preservation depends on it).

## Pre-flight: protect prod BEFORE Phase 2

Prod hosts run `lastlight server update`, which (a) converges the core checkout
to `main` unless the overlay pins `deploy.version`, and (b) runs **bare
`docker compose` with cwd = repo root** — which Phase 2 breaks (the compose
file moves to `apps/server/`). Both overlay repos auto-deploy on push. So:

1. Confirm the latest pre-migration release tag (e.g. `v0.15.x`).
2. Set `deploy.version: <that tag>` in **both** overlay repos
   (`cliftonc/lastlight-instance` → drizby, `nearform/lastlight-nearform` →
   nearform) and push. The auto-deploy Action converges each host to the pin.
3. Verify with `lastlight server status` on each host (`pinned vX.Y.Z`).
4. Declare the **release freeze** (below).

Unpinning happens in Phase 7, after the new CLI is published and installed on
the hosts (`npm i -g lastlight@<new>` BEFORE bumping the pin — the old CLI
cannot drive the new layout).

## Locked decisions (do not relitigate)

1. **pnpm + Turborepo.** One `pnpm-lock.yaml` replaces all four npm lockfiles.
   Turbo `dependsOn: ["^build"]` provides graph ordering; **no TS project
   references** (turbo is the only build graph).
2. **History preserved.** Core stays at the repo root and `git mv`s into
   `apps/server` as a distinct rename-only commit (`git log --follow` works).
   Siblings import via `git subtree add --prefix=apps/{www,evals}`. The two
   standalone GitHub repos are archived read-only (Phase 7) with a README
   pointer.
3. **Name reassignment.** The published `lastlight` becomes the lean CLI
   (`packages/cli`). The server package is renamed **`@lastlight/core`** and
   evals' dep/imports flip in the same repo (atomically, across Phases 4+6 —
   no external consumer of the barrel exists besides evals). Published
   packages: `lastlight`, `@lastlight/core`, `@lastlight/workflow-engine`,
   `lastlight-evals`, and `@lastlight/shared` (see decision 14). Everything
   else `private: true`.
4. **Node pinned to 22.** `.nvmrc` = 22, root `engines.node >= 22.12`,
   CI moves from Node 24 → 22. Rationale: the agent image is `node:22-slim`
   and `@types/node` is `^22` — the runtime wins; CI was the outlier.
5. **Release freeze** from the start of Phase 2 until Phase 7 completes. No
   GitHub Release, no overlay `deploy.version` bump, and no publish under an
   **existing** npm name (`lastlight`, `lastlight-evals`) in the window. Prod
   stays on the pre-flight pin. The first post-migration release is cut by
   the Phase 7 doc's runbook (new CLI installed on hosts first). Carve-out:
   the operator MAY manually publish the **new** scoped names
   (`@lastlight/workflow-engine`, `@lastlight/shared`) as soon as their phase
   lands — fresh names with zero consumers; Phase 4's F4 gate uses this.
6. **`#src/*` stays package-local** to `@lastlight/core` (compile/test-time
   alias, never in `dist/`). New cross-package imports are real workspace
   imports (`@lastlight/shared`, `@lastlight/workflow-engine`).
7. **Both dashboards stay nested** in their consuming app. The admin
   `serveStatic({ root: "dashboard/dist" })` string
   (`src/admin/index.ts:58,61,62`) is **never edited** — F3 is preserved by
   keeping runtime cwd = the server package root (`/app` in the image,
   `apps/server` locally).
8. **`instance/` stays at the repo root** (prod hosts + overlay auto-deploy
   Actions unchanged). `spec/` moves with core to `apps/server/spec/` (www
   re-points to it in Phase 5).
9. **Docker build context = repo root**; compose is invoked with explicit
   `-f <serverDir>/docker-compose.yml -f <override> --project-directory <home>`
   (the F5 home/serverDir split). Prod hosts pull prebuilt GHCR images, so the
   context change only affects local rebuilds (`server build` /
   `update --local`).
10. **Workflow-engine extraction executes its own design doc**
    ([workflow-engine-extraction-design.md](../../workflow-engine-extraction-design.md))
    — Phase 3 here is the monorepo bridge (where files land, what the package
    lift looks like), not a restatement. That doc's fences apply verbatim.
11. **The loader's type-only config link is cut by moving the types.**
    `workflows/loader.ts`'s `import type { DisabledConfig, RouteConfig } from
    "../config/config.js"` moves those two type declarations into
    `@lastlight/shared`; core re-imports them from shared. No shared→core
    dependency ever exists.
12. **CLI package-root helpers get updated + tested.** `bundleRoot()`
    (`skills-install.ts`), `bundledAssetRoot()` (`fork-cli.ts`) and
    `cliVersion()` hard-assume the compiled file sits at `dist/cli/*.js`, two
    levels below a package root holding `plugins/` + asset dirs. In
    `packages/cli` the bin becomes `dist/cli.js` (one level); the helpers are
    updated and a regression test pins the resolution. `fork-cli`'s
    bundled-asset fallback is removed (the CLI no longer ships
    `workflows/skills/agent-context`; it reads them from the server home and
    errors with a `--home` pointer when absent).
13. **Version continuity.** The CLI package continues the `lastlight` 0.x line
    (first publish ≥ 0.16.0, strictly greater than the last frozen release).
    `@lastlight/core` starts at the same number for legibility;
    `@lastlight/workflow-engine` starts 0.1.0; `lastlight-evals` continues its
    own 0.7.x line.
14. **`@lastlight/shared` publishes** (correcting the design doc's "four
    published packages"): it is a runtime `workspace:*` dep of the published
    `lastlight` CLI and `@lastlight/core`, and pnpm rewrites `workspace:*` to
    a concrete range on pack — the range must be installable from npm. No
    API-stability promise; internal surface only.
15. **npm publishing is manual** (operator-performed — no Changesets, no CI
    npm job). `publish.yml` keeps only `checks → images`; a GitHub Release
    builds/pushes the GHCR images, then the operator publishes to npm in
    dependency order (engine → shared → core → cli → evals;
    `pnpm -r publish --access public` is topological). The images-before-npm
    guarantee becomes procedural: never publish a `lastlight` version whose
    images aren't in GHCR. Version bumps are manual and graph-aware
    (a shared/engine change bumps its dependents), documented in
    `docs/RELEASING.md` (created in Phase 7), including the
    `plugin.json`-lockstep rule.

## Regression fences (CI-enforced; gate the phase that proves them)

- **F1 — evals barrel + asset discovery** *(Phase 6)*. `apps/evals` imports
  workflow-driving symbols from the core barrel and calls
  `require.resolve("lastlight/package.json")`
  (`lastlight-evals/src/bootstrap.ts:34`) to find core's shipped asset dirs.
  Both must resolve identically via the `workspace:*` symlink and the
  published tarball. Post-rename address: `@lastlight/core/evals` +
  `require.resolve("@lastlight/core/package.json")`; the `LASTLIGHT_CORE_DIR`
  env override still applies.
- **F2 — the Docker build** *(Phase 2)*. `docker buildx bake core` (agent +
  sandbox-base + sandbox) still builds from the new layout and the image
  boots, serves `/admin` + `/health`, and holds the asset dirs at `/app/`.
- **F3 — admin dashboard runtime path** *(Phase 2)*. The cwd-relative
  `serveStatic({ root: "dashboard/dist" })` (`src/admin/index.ts:58-62`)
  keeps working. Do not touch the string; control the cwd.
- **F4 — lean global install** *(Phase 4)*. `npm i -g <packed lastlight
  tarball>` in a clean container installs with NO heavy runtime deps and NO
  native compile (assert `better-sqlite3`, `@slack/bolt`, `octokit`, `hono`,
  `agentic-pi`, `croner`, `@opentelemetry/*` absent from the tree). Measure
  install size; flag if `@earendil-works/pi-ai` dominates.
- **F5 — `lastlight server` host-local commands** *(Phase 2)*. `server
  build|start|stop|restart|update|status` keep working after the split of
  `home` (git-root, stays repo root) from `serverDir` (compose/asset root,
  `apps/server`).

## Hard constraints (verified against source, 2026-07-14)

- **Core root `package.json`** (v0.15.0): `bin: {lastlight: dist/cli/cli.js}`;
  exports `.`, `./evals`, `./dist/*`, `./package.json`; `files: [dist, config,
  workflows, skills, agent-context, deploy, sandbox.Dockerfile,
  docker-compose.yml, .claude-plugin, plugins]` — note it does **not** ship
  `Dockerfile`, `sandbox-base.Dockerfile`, `sandbox-qa.Dockerfile`, or
  `docker-bake.hcl`. `workspaces: ["dashboard"]` already exists (single root
  `package-lock.json`; the dashboard has **no** own lockfile).
- **The CLI import graph is verified lean.** The only non-`src/cli` imports
  are: `config/overlay-bootstrap.ts`, `config/overlay-assets.ts`,
  `config/core-pin.ts`, `providers.ts` (zero imports), `engine/oauth.ts`
  (→ `@earendil-works/pi-ai/oauth` subpath), `workflows/loader.ts` (fs/yaml +
  `./schema.js` [zod-only] + a **type-only** config import). None reach
  `better-sqlite3` / `@slack/bolt` / `octokit` / `hono` / `croner` /
  `agentic-pi`.
- **`cli-server.ts` compose coupling**: `composeRun(home, …)` spawns bare
  `docker compose <args>` with `cwd = home`; the override symlink
  `<home>/docker-compose.override.yml → instance/docker-compose.override.yml`
  is auto-loaded only because of that bare invocation. `enumerateOverlayAssets`
  is called with `coreRoot: home` (`cli-server.ts:655`).
- **Sandbox Dockerfiles** COPY exactly three repo paths:
  `sandbox/agentic-pi.pin`, `agent-context/`, `deploy/sandbox-entrypoint.sh`
  (sandbox-qa additionally its Playwright layers). `docker-bake.hcl` targets
  all use `context = "."` and link sandbox/sandbox-qa to `target:sandbox-base`
  via `contexts`.
- **www** (`~/work/lastlight-www`): no `.github/` at all — deploys are manual
  `npm run deploy` (build + `wrangler deploy`, static-assets Worker on
  `lastlight.dev`). `sync-spec.mjs` resolves `SPEC_SRC` env →
  `../lastlight/spec` sibling → warn-and-keep committed fallback copies.
- **evals** (`~/work/lastlight-evals`, v0.7.1): dep `lastlight ^0.9.0`;
  peer + dev dep `agentic-pi ^0.2.11`; three files import from
  `"lastlight/evals"` (`bootstrap.ts:16`, `init.ts:28`,
  `run-instance.ts:25-31`); nested `dashboard/` is an independent npm project
  (own `package-lock.json`, installed via `npm --prefix`) named
  `@lastlight/evals-dashboard`; it has its own `ci.yml` + `publish.yml` which
  become inert under `apps/evals/.github/` after subtree import (delete them
  in Phase 6).
- **agentic-pi version skew** exists today: core `^0.2.16`, admin dashboard
  `^0.2.4`, evals `^0.2.11` peer. pnpm's strict linking will make each
  package's own declaration authoritative — align opportunistically but do not
  let it block a phase (record in Deviations).
- **Node version skew** exists today: CI 24, agent image 22, sandbox-base 20
  (+ fnm 22/24), `@types/node` 22. Decision 4 resolves the CI/tooling side;
  container base images are out of scope.

## Out of scope (backlog — do not do in any phase)

Shared `@lastlight/dashboard-ui`; an `@lastlight/assets` package; resolving the
admin SPA path off `import.meta.url`; migrating `#src/*` to a Node `imports`
field; further core extractions (connectors/EventEnvelope, sandbox port,
state); container base-image Node unification.
