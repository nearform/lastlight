# Last Light Monorepo Migration — Design Spec

> **Scope.** Re-architect the three sibling repos (`lastlight`, `lastlight-www`,
> `lastlight-evals`) into one **pnpm + Turborepo** monorepo. Two package
> extractions land in this effort: `@lastlight/workflow-engine` (per
> [`workflow-engine-extraction-design.md`](./workflow-engine-extraction-design.md),
> folded in as a phase by reference) and a **lean CLI** published as `lastlight`.
> Each app still publishes/deploys independently (npm + Cloudflare + GHCR).
>
> **Executable plan:** [`docs/plans/monorepo-migration/`](./plans/monorepo-migration/README.md)
> — the phased implementation plan (README with locked decisions + pre-flight
> prod protection, a target-architecture reference, and one self-sufficient
> phase doc per phase below, written to be executed by sub-agents). The plan
> supersedes §9 for execution detail; this doc remains the design rationale.

## Context

Last Light spans **three sibling repos** developed together but living apart:

- **`lastlight`** — the core product (agent, CLI, admin dashboard, Docker stack).
  Publishes to npm as **`lastlight`** (the global `bin` + the `lastlight/evals`
  barrel + shipped asset dirs + the Claude plugin marketplace).
- **`lastlight-www`** — Astro marketing/docs site → `lastlight.dev` (Cloudflare).
  Build-time-copies core's `spec/*.md` via a sibling-path hack
  (`scripts/sync-spec.mjs` reading `../lastlight/spec`).
- **`lastlight-evals`** — evals harness + its own dashboard → `evals.lastlight.dev`
  (Cloudflare). Publishes as **`lastlight-evals`**; depends on core only via the
  `lastlight/evals` barrel + a runtime `require.resolve("lastlight/package.json")`
  to read core's shipped assets.

**Why change:** cross-repo work means three checkouts, four lockfiles, sibling-path
assumptions (`../lastlight/spec`), and a published-version lag (evals pins
`lastlight ^0.9.0` while core is `0.15.0`). Goal: one **pnpm + Turborepo monorepo**
that (a) improves DX, (b) extracts core logic into independently testable packages,
and (c) still **publishes/deploys each app separately**.

**Two extractions in scope:**
1. `@lastlight/workflow-engine` — the port-driven engine per the existing
   extraction design (folded in as a phase, not duplicated).
2. **A lean CLI as the published `lastlight`.** The CLI's whole import graph is light
   (`chalk`, `@clack/prompts`, `cli-table3`, `yaml`, `zod`, the tree-shakeable
   `@earendil-works/pi-ai/oauth` subpath) and reaches **none** of the heavy runtime
   deps (`better-sqlite3`, `@slack/bolt`, `octokit`, `hono`, `@opentelemetry/*`,
   `agentic-pi`, `croner`) — it never imports `src/index.ts` or boots the server.
   Extracting it makes `npm i -g lastlight` lean and **kills the `better-sqlite3`
   native compile** that global install triggers today. Because the `lastlight` name
   can attach to the lean CLI **or** the heavy evals barrel but not both, the server
   package is **renamed to `@lastlight/core`** and evals updates its import
   in-lockstep.

**Decisions (locked):** preserve git history on import (git subtree); pnpm +
Turborepo; extract workflow-engine **and** the lean CLI (backlog the rest); archive
the standalone www/evals repos after import; the lean CLI owns the published
`lastlight` name; **npm publishes are manual** (operator-run, dependency order —
no Changesets; CI builds only the GHCR images).

---

## Regression fences (CI-enforced, gate every phase)

- **F1 — the evals barrel + asset discovery.** `apps/evals` imports the workflow
  driving symbols from the core barrel and calls
  `require.resolve("<core>/package.json")` (`lastlight-evals/src/bootstrap.ts:34`) to
  locate core's *shipped* asset dirs. Both must resolve identically via a
  `workspace:*` symlink and the published tarball. After the rename the address
  becomes `@lastlight/core/evals` + `require.resolve("@lastlight/core/package.json")`
  (the `LASTLIGHT_CORE_DIR` override still applies) — updated atomically in-repo.
- **F2 — the Docker build.** `docker buildx bake` (4 GHCR images) must still build and
  `lastlight server update` must still pull-and-run them after the layout move.
- **F3 — the admin dashboard runtime path.** The Hono server serves
  `serveStatic({ root: "dashboard/dist" })` — **cwd-relative**
  (`src/admin/index.ts:58-62`). Preserve by keeping the SPA nested + cwd=`apps/server`;
  **do not touch the string.**
- **F4 — lean global install.** `npm i -g lastlight` (the CLI package) must install
  with **no heavy runtime deps and no native compile**. Fence: a clean-container
  `npm i -g` of the packed CLI tarball, asserting `better-sqlite3` et al. are absent
  from its tree, and measuring install size (watch the pi-ai footprint — see §4).
- **F5 — the `lastlight server` host-local commands.** `server build/update/status`
  currently treat one dir (`home`) as git-root **and** compose-root **and** asset-root.
  The move splits those; the CLI must keep working (see §6).

F2+F3 prove in the core-move phase; F4+F5 in the CLI-extraction phase; F1 in the
evals-import phase.

---

## 1. Target workspace layout

The monorepo **is** `nearform/lastlight`. Core `git mv`s into a subdir (rename-only
commit → `git log --follow` history preserved).

```
lastlight/                          # nearform/lastlight repo root (.git here), private root pkg
├── pnpm-workspace.yaml   turbo.json   tsconfig.base.json   pnpm-lock.yaml   .nvmrc
├── package.json                    # private root, orchestration only
├── instance/                       # deployment overlay (prod host clones here; stays at repo root)
├── .github/workflows/              # consolidated ci / publish / deploy-www / deploy-evals
├── apps/
│   ├── server/                     # package @lastlight/core — heavy harness + server + Docker + evals barrel
│   │   ├── package.json            # name:"@lastlight/core", exports("./evals"), files:[assets…]; NO bin
│   │   ├── tsconfig.json           # Node16 ; keeps #src/* alias
│   │   ├── src/ config/ workflows/ skills/ agent-context/ deploy/ spec/
│   │   ├── Dockerfile  sandbox-base.Dockerfile  sandbox.Dockerfile  sandbox-qa.Dockerfile
│   │   ├── docker-compose.yml  docker-bake.hcl  Caddyfile
│   │   ├── scripts/dev-local.sh    # run-from-source dev path (moves with core; see §6)
│   │   └── dashboard/              # @lastlight/dashboard (admin SPA) — stays NESTED (F3)
│   ├── www/                        # lastlight-www (Astro) → lastlight.dev
│   │   ├── scripts/sync-spec.mjs   # spec source re-pointed to apps/server/spec
│   │   └── src/content/spec/       # committed fallback copies stay
│   └── evals/                      # lastlight-evals → evals.lastlight.dev
│       ├── package.json            # name:"lastlight-evals"; dep @lastlight/core:workspace:*
│       ├── wrangler.jsonc  scripts/build-site.ts  datasets/ examples/
│       └── dashboard/              # @lastlight/evals-dashboard — stays NESTED
└── packages/
    ├── cli/                        # package "lastlight" (published, LEAN) — the global bin + host-local server cmds
    │   ├── package.json            # name:"lastlight", bin.lastlight → dist/cli.js, lean deps, ships plugins/ + .claude-plugin/
    │   └── src/ plugins/ .claude-plugin/
    ├── shared/                     # @lastlight/shared — light modules used by cli + core + barrel
    │   └── src/  (providers, engine/oauth, config/overlay-bootstrap, overlay-assets, core-pin, workflow loader)
    └── workflow-engine/            # @lastlight/workflow-engine (core/ + ports/ + test-support/) incl. schema
```

`pnpm-workspace.yaml`:
```yaml
packages:
  - "apps/*"              # server(@lastlight/core), www, evals
  - "apps/*/dashboard"    # @lastlight/dashboard, @lastlight/evals-dashboard (nested)
  - "packages/*"          # lastlight(cli), @lastlight/shared, @lastlight/workflow-engine
```

**Why this shape:**
- **Heavy server → `apps/server`, renamed `@lastlight/core`.** Primarily a deployed
  product (server + Docker) that also exposes the `./evals` library barrel + ships
  asset dirs. Its `bin` moves to the CLI package.
- **CLI → `packages/cli`, keeps the published name `lastlight`.** Lean, publishable
  binary + host-local `server` lifecycle commands (which shell out to docker/git, so
  they stay light).
- **`@lastlight/shared`** holds the ~7 light modules the CLI reaches into so it never
  drags core's heavy deps: `providers.ts`, `engine/oauth.ts` (imports only the
  tree-shakeable `pi-ai/oauth` subpath), `config/overlay-bootstrap.ts`,
  `config/overlay-assets.ts`, `config/core-pin.ts`, and a light workflow **loader**
  (the `loader→config` link is type-only, erased at compile). The workflow **schema**
  lives in `@lastlight/workflow-engine` (its core is also light: zod-only) and both
  CLI and shared import it from there. `@lastlight/core` imports these same modules
  from `shared`/`workflow-engine` (no duplication).
- **Both dashboards stay nested** in their consuming app (F3 for admin;
  `build-site.ts` reads `../dashboard/dist` for evals).
- **`spec/` + `instance/`**: spec stays in `apps/server` (www re-points to it);
  `instance/` overlay stays at the repo root (unchanged for prod hosts + overlay
  auto-deploy Actions — see §6).

Five **published** packages result: `lastlight` (CLI), `@lastlight/core`,
`@lastlight/workflow-engine`, `lastlight-evals`, and `@lastlight/shared` —
shared must publish because it is a runtime `workspace:*` dep of the published
CLI and core, and pnpm rewrites `workspace:*` to a concrete range on pack
(no API-stability promise; internal surface). Everything else is `private`.

---

## 2. Tooling — pnpm workspace + Turborepo

- **pnpm** replaces npm everywhere; one `pnpm-lock.yaml` replaces four package-locks
  (core, www, evals, evals' nested dashboard). Strict `node_modules` also surfaces the
  phantom-dep risk the evals `peerDependencies: agentic-pi` hides.
- **Turborepo** over plain `pnpm -r`:
  - **Content-hash caching** → per-package CI skipping, correct across the dep graph
    (a `shared`/`workflow-engine` change invalidates `core`, `cli`, `evals`).
  - **Graph ordering** via `dependsOn: ["^build"]` (engine/shared → core → evals).
  - **Deploys stay leaf tasks** (`"cache": false`, `--filter`), never in shared build.

`turbo.json` tasks: `build` (`dependsOn ^build`, outputs `dist/**`,`dist-site/**`,
`dashboard/dist/**`), `typecheck`/`test` (`dependsOn ^build`), `lint`, `deploy`
(`dependsOn build`, `cache:false`). Root `package.json`: private,
`packageManager: pnpm@9.x`, `engines.node >=22.12`, scripts delegate to `turbo run …`
+ `deploy:www`/`deploy:evals`. `.nvmrc` pins one shared Node (unify core's CI Node-24
vs the others' 22).

---

## 3. TypeScript strategy

- **`tsconfig.base.json`** holds only shared flags (`target ES2022`, `strict`,
  `esModuleInterop`, `skipLibCheck`, `resolveJsonModule`, decl/maps). It **omits
  `module`/`moduleResolution`** — set per runtime.
- **Node16** for `@lastlight/core`, `apps/evals`, `packages/{cli,shared,workflow-engine}`
  (needed so `exports` maps + `require.resolve` resolve at runtime; Bundler would break
  F1/F4). **Bundler** for `apps/www` (Astro) + both dashboards (Vite).
- **Keep the `#src/*` alias package-local** in `@lastlight/core` — compile/test-time
  only (never in `dist/`), so zero churn to the ~75 files that use it. New cross-package
  imports (`core`→engine/shared, `cli`→shared/engine) become real workspace imports.
- **Turbo ordering, NOT TS project references** (avoid a second hand-maintained graph);
  `dependsOn: ["^build"]` guarantees upstream `dist/`+`.d.ts` exist first.

---

## 4. Publish contract across four packages

> **Superseded — five packages, not four.** `@lastlight/shared` also publishes
> (it is a runtime `workspace:*` dep of two published packages, rewritten to a
> concrete range on pack). See the migration plan's locked decision 14 and
> `docs/RELEASING.md` for the authoritative publish contract + manual flow.


- **`lastlight` (CLI, `packages/cli`)** — `bin.lastlight` → `dist/cli.js`; lean
  `dependencies` (chalk, @clack/prompts, cli-table3, yaml, zod,
  `@earendil-works/pi-ai` for the oauth subpath) + workspace deps `@lastlight/shared`,
  `@lastlight/workflow-engine`. `files:` ships `dist` + `plugins/lastlight/` +
  `.claude-plugin/` (required by `skills-install.ts`, which resolves them at its own
  package root via `import.meta.url`). `fork-cli.ts` reads
  `workflows/`/`skills/`/`agent-context/` from the **server home** at runtime (its
  normal `--home`/server-home path) — so the CLI need not ship the full asset trees.
  **F4 verification:** pack the CLI, `npm i -g` it in a clean container, assert no
  better-sqlite3/native build, measure size. If `@earendil-works/pi-ai`'s full install
  footprint dominates (npm installs the whole package even for a subpath import),
  evaluate vendoring the small oauth submodule or a lighter dependency — flagged, not
  blocking.
- **`@lastlight/core` (`apps/server`)** — `main: dist/index.js`,
  `exports["./evals"]: ./dist/evals-api.js`, **no `bin`**. `files:` ships `dist`,
  `config`, `workflows`, `skills`, `agent-context`, `deploy`, `sandbox.Dockerfile`,
  `docker-compose.yml`. `tsc` runs inside `apps/server` → emits `apps/server/dist/**`.
  **Fence:** `pnpm pack --dry-run` file list stays stable (minus the moved `bin` +
  plugin dirs). The barrel re-exports getWorkflow/configureWorkflowAssets (from the
  shared loader), runWorkflow (from core's runner), overlay-bootstrap symbols (from
  shared) — same symbol set as today.
- **`@lastlight/workflow-engine`** — published public (matches the extraction doc's
  reuse goal; keeps core's build a plain `tsc`). Core depends on it `workspace:*`.
- **`lastlight-evals`** — unchanged name; dep flips to `@lastlight/core: workspace:*`;
  imports `from "@lastlight/core/evals"`; `require.resolve("@lastlight/core/package.json")`.

**F1 both ways:** locally, `workspace:*` symlinks `node_modules/@lastlight/core` →
`apps/server`, whose dir holds the asset dirs exactly as the tarball root does (**why
they must stay directly under `apps/server/`**); requires core built first (Turbo
`^build`). Published: pnpm rewrites `workspace:*` → concrete ranges on pack; barrel
+ `require.resolve` are npm-standard.

Note on the name change: the *published* `lastlight` becomes the CLI (no `/evals`
subpath). Existing `lastlight-evals` releases pinned to old `lastlight` still resolve
against the already-published 0.15.x tarball; going forward evals depends on
`@lastlight/core`. The rename is a breaking change to the barrel's *address*, done
atomically in-repo (both sides move together), so no live consumer breaks.

---

## 5. Dashboards

- **Admin (F3):** preserve the cwd-relative `dashboard/dist` by running the server with
  **cwd = `apps/server`** (local + Docker). Don't touch `src/admin/index.ts`.
  `build:dashboard` → `pnpm --filter @lastlight/dashboard build`; output
  `apps/server/dashboard/dist/**` is a Turbo output + in the Docker context.
- **Evals:** stays nested at `apps/evals/dashboard`; `build-site.ts` reads
  `join(root,"dashboard","dist")` unchanged. Build switches from `npm --prefix
  dashboard …` to `pnpm --filter @lastlight/evals-dashboard build`; the nested
  `dashboard/package-lock.json` is deleted (folds into `pnpm-lock.yaml`).

---

## 6. Docker + the `lastlight server` host-local path split (F2, F5)

**Docker image build context → repo root** (pnpm needs the workspace + lockfile); the
built package is `@lastlight/core`.
- **`docker-bake.hcl` + compose:** each target/service → `context = "."` (repo root),
  `dockerfile = "apps/server/<name>.Dockerfile"`. Sandbox Dockerfiles repoint their few
  `COPY` paths (`sandbox/agentic-pi.pin`, `agent-context/`) under `apps/server/`.
- **Rewrite the agent `Dockerfile`** to a pnpm workspace install + prune-to-server
  (context = repo root), replacing today's single-package `COPY package.json …` +
  `npm run build && npm run build:dashboard`:
  ```dockerfile
  FROM node:22-slim AS build
  RUN corepack enable
  WORKDIR /repo
  COPY pnpm-workspace.yaml pnpm-lock.yaml package.json turbo.json tsconfig.base.json ./
  COPY apps/server/package.json apps/server/package.json
  COPY apps/server/dashboard/package.json apps/server/dashboard/package.json
  COPY packages/*/package.json packages/  # workflow-engine + shared manifests (core deps)
  RUN pnpm install --frozen-lockfile --filter @lastlight/core... --filter @lastlight/dashboard...
  COPY apps/server/ apps/server/
  COPY packages/    packages/
  RUN pnpm --filter @lastlight/workflow-engine --filter @lastlight/shared build \
   && pnpm --filter @lastlight/core build \
   && pnpm --filter @lastlight/dashboard build
  RUN pnpm --filter @lastlight/core deploy --prod /app   # isolated node_modules + files → /app

  FROM node:22-slim
  # same system deps (git ripgrep gosu python3/make/g++ for better-sqlite3), useradd -u 10001, docker CLI
  WORKDIR /app
  COPY --from=build /app /app        # /app = core package: dist/ dashboard/dist/ config/ workflows/ skills/ agent-context/ deploy/ node_modules
  # VOLUME /app/data, ENV, ARG GIT_SHA/BUILD_DATE, EXPOSE 8644, entrypoint — unchanged
  CMD ["node", "dist/index.js"]
  ```
  `pnpm deploy --filter @lastlight/core --prod /app` prunes to one deployable package;
  `/app` ends up shaped like today's — **cwd `/app` → F3's `dashboard/dist` resolves.**
  Keep python3/make/g++ (better-sqlite3), UID 10001, egress-init (`/app/dist/...`),
  entrypoint, GIT_SHA/BUILD_DATE. (Alt: `turbo prune --scope=@lastlight/core` for
  better layer caching.)

**The `lastlight server` CLI (F5) — the key change.** Today `cli-server.ts` treats
`home` (`LASTLIGHT_HOME`, default `~/lastlight`) as git-root **and** compose-root
**and** asset-root: all `docker compose` runs with `cwd=home` + bare `docker compose`
(auto-discovering `home/docker-compose.yml` + the override symlink), and
`enumerateOverlayAssets` reads `home/{workflows,skills,agent-context}`. The move splits
these — `.git` stays at the repo root, but compose files + assets live under
`apps/server/`. Resolution:
- **Keep `home` = repo root** (git ops `git -C home …`, clone target, `readCorePin` on
  `home/instance` — all unchanged). **Keep `instance/` at the repo root** (unchanged
  for prod hosts + overlay auto-deploy Actions).
- **Introduce `serverDir = <home>/apps/server`.** Run compose explicitly:
  `docker compose -f <serverDir>/docker-compose.yml -f <override> --project-directory
  <home> <cmd>` (cwd=home). `--project-directory <home>` makes the compose file's
  `build: context: .` = repo root (what the Dockerfile rewrite needs), `./instance` =
  `home/instance` (overlay unchanged), `./Caddyfile` → move Caddyfile with core or
  reference `apps/server/Caddyfile`. Note: with explicit `-f`, auto-override loading is
  off, so pass the override `-f` explicitly (the existing `home/docker-compose.override.yml`
  symlink → `instance/docker-compose.override.yml` still works as a second `-f`).
- **Repoint `enumerateOverlayAssets` `coreRoot`** from `home` → `serverDir` so `server
  status` overrides listing finds the built-in `workflows/skills/agent-context`.
- **`dev-local.sh`** moves into `apps/server/scripts/`; its `PROJECT_ROOT="$SCRIPT_DIR/.."`
  then equals `apps/server` (still holds `src/index.ts`) — relocation only, no logic
  change. `npm run dev` becomes `pnpm --filter @lastlight/core dev`.
- **`server update` GHCR-pull path** is unaffected (it `docker pull`s + re-tags to
  local names, then the recreate step uses the same explicit compose invocation).

Prod hosts *pull* prebuilt images, so the context change only bites the rare local
rebuild (`server build` / `update --local`). These CLI changes live in the (now lean)
`packages/cli`.

---

## 7. CI / publish consolidation

One root `.github/workflows/`:
- **`ci.yml`** (PR + push, `workflow_call`-able): `pnpm install --frozen-lockfile` →
  `turbo run typecheck test build`. Turbo content-hashing gives per-package skipping
  (better than `paths:` — correct across the graph).
- **`publish.yml`** (on GitHub Release + `workflow_dispatch`): trimmed to
  **`checks → images`**. `checks` reuses `ci.yml`; `images` = `buildx bake`
  (dockerfiles under `apps/server/`). **npm publishing is manual** (plan
  decision 15 — no Changesets, no CI npm job): after the release's images land
  in GHCR, the operator publishes in dependency order
  (`@lastlight/workflow-engine` + `@lastlight/shared` before `@lastlight/core`
  + `lastlight` before `lastlight-evals`; `pnpm -r publish --access public` is
  topological) — pnpm rewrites `workspace:*` → concrete ranges. Version bumps
  are manual and graph-aware (bump `@lastlight/core` + `lastlight` when
  shared/engine change); the flow lives in `docs/RELEASING.md`. The
  images-before-npm guarantee becomes procedural: never publish a `lastlight`
  version whose images aren't in GHCR yet.
- **Cloudflare deploy jobs** (`deploy-www.yml`, `deploy-evals.yml`), git
  `paths:`-filtered (deploys are per-app + side-effecting):
  - `deploy-www`: push to `main` touching `apps/www/**` **or `apps/server/spec/**`** →
    `pnpm --filter lastlight-www build && wrangler deploy`.
  - `deploy-evals`: push touching `apps/evals/**` → `pnpm --filter lastlight-evals...
    build:site && wrangler deploy`. `dist-site` bakes in gitignored `eval-results/`
    (CI has none) — automate the shell deploy, keep results population manual. Needs
    `CLOUDFLARE_API_TOKEN`.

---

## 8. Git history import (git subtree — preserve history)

Core stays at the repo root with full history, then `git mv`s into `apps/server` (a
distinct rename-only commit → history follows). Siblings import via `git subtree add`:
```bash
git remote add www-origin  git@github.com:nearform/lastlight-www.git
git remote add evals-origin git@github.com:nearform/lastlight-evals.git
git fetch www-origin && git fetch evals-origin
git subtree add --prefix=apps/www   www-origin   main
git subtree add --prefix=apps/evals evals-origin main
```
`git log apps/www/...` then shows original commits. (If pristine cross-boundary blame
on evals matters more than simplicity, `git-filter-repo` + `--allow-unrelated-histories`
merge is the alternative; subtree is the recommended default.) Archive the two GitHub
repos read-only with a README pointer.

---

## 9. Phase ordering (green + shippable at every step)

> Each phase now has an executable doc under
> [`docs/plans/monorepo-migration/`](./plans/monorepo-migration/README.md):
> A→`01-tooling-skeleton.md`, B→`02-core-move.md`, C→`03-workflow-engine.md`,
> D→`04-cli-shared-rename.md`, E→`05-import-www.md`, F→`06-import-evals.md`,
> G→`07-ci-publish-deploys.md`. The plan README adds a **pre-flight step**
> (pin both prod overlays + release freeze) that must precede phase B, and
> locks **manual npm publishing** (no Changesets — see plan decision 15).

**A — Tooling skeleton, NO moves.** Add `pnpm-workspace.yaml` (root + `dashboard`),
`turbo.json`, root `package.json`, `.nvmrc`, `packageManager`; convert the existing
npm-workspace to pnpm; generate `pnpm-lock.yaml`; delete `package-lock.json`. **Gate:**
`turbo run typecheck test build` reproduces today's CI; Docker still builds. *Risk: low.*

**B — Move core into `apps/server`** (still published as `lastlight` for now); update
bake/compose/Dockerfile paths + the `server` CLI path split (§6). **Gates (F2/F3/F5):**
`pnpm pack --dry-run` file list stable; `docker buildx bake core` builds + image serves
`/admin` + runs `node dist/index.js`; asset dirs at `/app/`; `lastlight server
build|status` work against `home=repo root`, `serverDir=apps/server`. *Risk: HIGH.*

**C — Extract `@lastlight/workflow-engine`** per
[`workflow-engine-extraction-design.md`](./workflow-engine-extraction-design.md) (its
Milestone A in-repo module + dep-cruiser gate, then Milestone B lift to
`packages/workflow-engine`, core deps `workspace:*`). **Gates:** that doc's fences
(`runWorkflow.length===9`, `StateDb satisfies WorkflowStateStore`, golden-build,
dep-cruiser). Publish the engine (§4). *Risk: medium.*

**D — Extract the lean CLI + shared package + rename core** (F4). Create
`@lastlight/shared` (the ~7 light modules); create `packages/cli` (`name:"lastlight"`,
bin, lean deps, ships `plugins/`+`.claude-plugin/`, host-local `server` cmds); **rename
`apps/server` package `lastlight` → `@lastlight/core`, remove its `bin`**, keep the
`./evals` barrel + asset `files`. Update the Docker/image references to
`@lastlight/core`. **Gates:** F4 clean-container `npm i -g lastlight` = lean + no native
compile; `@lastlight/core` still emits barrel + assets; `pnpm --filter lastlight test`
green; server image unchanged behaviourally. *Risk: HIGH — the rename + name reassignment.*

**E — Import www** (`git subtree add --prefix=apps/www`). Re-point
`scripts/sync-spec.mjs`'s sibling fallback `../lastlight/spec` → `apps/server/spec`.
**Gate:** `pnpm --filter lastlight-www build`. *Risk: low.*

**F — Import evals + wire to `@lastlight/core`** (F1). `git subtree
add --prefix=apps/evals`; dep → `@lastlight/core: workspace:*`; imports →
`@lastlight/core/evals`; `require.resolve("@lastlight/core/package.json")`; delete the
nested dashboard lock; `build:dashboard` → `pnpm --filter @lastlight/evals-dashboard
build`. **Gate:** the harness runs a workflow against `@lastlight/core`'s built `dist/`
with mocked GitHub — barrel imports AND asset discovery resolve through the symlink.
*Risk: HIGH.*

**G — Consolidate CI + deploys + the manual publish flow** for the published
packages + the two Cloudflare deploys (§7). *Risk: medium — keep the
images-before-npm ordering, now procedural.*

**H — Backlog** (non-blocking): shared `@lastlight/dashboard-ui` (both SPAs share
daisyui/tailwind/marked/prismjs), an `@lastlight/assets` package if CLI/core asset
duplication grows, resolving the admin SPA path off `import.meta.url`, migrating
`#src/*` to a Node `imports` field, further core-module extractions (connectors/
`EventEnvelope`, sandbox port, state).

**Fences → phases:** F2+F3+F5 in **B**; workflow-engine fences in **C**; F4 in **D**;
F1 in **F** (with C's type-level contract tests already in place).

---

## Critical files

- `package.json` — split: `bin`+plugin dirs → `packages/cli` (`lastlight`);
  barrel+assets → `apps/server/package.json` (`@lastlight/core`).
- `src/cli/*` → `packages/cli/src/*`; the 7 shared imports (`providers`,
  `engine/oauth`, `config/overlay-bootstrap`, `overlay-assets`, `core-pin`,
  `workflows/loader`+`schema`) → `@lastlight/shared` / `@lastlight/workflow-engine`.
- `src/cli/cli-server.ts` + `src/config/overlay-assets.ts` — the F5 `home` vs
  `serverDir` split (compose `-f`/`--project-directory`, `coreRoot` repoint).
- `Dockerfile` + `docker-bake.hcl` + `docker-compose.yml` — pnpm workspace build +
  context/dockerfile repoint to `apps/server/` (F2).
- `src/admin/index.ts:58-62` — cwd-relative `dashboard/dist` (F3).
- `lastlight-evals/src/bootstrap.ts:34` + `src/{run-instance,init}.ts` — barrel address
  + `require.resolve` retarget to `@lastlight/core` (F1).
- [`docs/workflow-engine-extraction-design.md`](./workflow-engine-extraction-design.md)
  — Phase C, by reference.
- `lastlight-www/scripts/sync-spec.mjs` — spec-source repoint (Phase E).
- `.github/workflows/{ci,publish}.yml` — the ordered chain to preserve.

---

## Verification (per phase, end-to-end)

- **A:** `turbo run typecheck test build` green at root; `docker buildx bake core` still
  builds.
- **B:** `pnpm pack --dry-run` (apps/server) file list stable; build + run the agent
  image, hit `/admin` + `/health`; `lastlight server status`/`build` work with
  `home`=repo root.
- **C:** `pnpm --filter @lastlight/core test` green incl. the engine fences; dep-cruiser
  boundary passes.
- **D:** in a clean container, `npm i -g <packed lastlight cli>` → no better-sqlite3, no
  native compile; `lastlight --help` + a host-local `server status` work; measure install
  size (flag if pi-ai dominates); `@lastlight/core` barrel still importable.
- **E:** `pnpm --filter lastlight-www build` emits `dist/`; spec pages render from
  `apps/server/spec`.
- **F:** one eval case end-to-end vs mocked GitHub through the `workspace:*` symlink —
  `@lastlight/core/evals` + asset discovery resolve; `pnpm --filter lastlight-evals test`
  green.
- **G:** dry-run the release (images-only `workflow_dispatch`); confirm Cloudflare deploy
  jobs fire only on their app's paths; `pnpm -r publish --dry-run` packs exactly the
  published packages with `workspace:*` rewritten.
- **Cross-cutting:** from a clean clone, `pnpm install --frozen-lockfile` + `pnpm -r
  build && pnpm -r test` green.
