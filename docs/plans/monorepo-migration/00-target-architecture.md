# Target architecture — Last Light monorepo

Read together with [README.md](README.md) (locked decisions + fences + hard
constraints). This doc is the destination picture the phases converge on; the
full rationale lives in
[`docs/monorepo-migration-design.md`](../../monorepo-migration-design.md).

## Current state (what we're migrating from)

- **`lastlight`** (this repo) — npm package `lastlight` v0.15.0: the harness
  (`dist/index.js`), the CLI bin (`dist/cli/cli.js`), the `./evals` barrel
  (`src/evals-api.ts`), shipped asset dirs (`config workflows skills
  agent-context deploy`), the Claude plugin (`plugins/ .claude-plugin/`), the
  Docker stack (4 images), and a nested npm-workspace dashboard
  (`workspaces: ["dashboard"]`, one root `package-lock.json`).
- **`lastlight-www`** (`~/work/lastlight-www`) — Astro static site →
  `lastlight.dev` (static-assets Worker, manual `npm run deploy`). Reads
  core's `spec/*.md` at build time via the sibling path `../lastlight/spec`
  (`scripts/sync-spec.mjs`), with committed fallback copies.
- **`lastlight-evals`** (`~/work/lastlight-evals`) — npm package
  `lastlight-evals` v0.7.1 → `evals.lastlight.dev`. Depends on core as
  published `lastlight ^0.9.0` (a 6-minor-version lag): imports from
  `"lastlight/evals"` in three files and locates core's shipped assets via
  `require.resolve("lastlight/package.json")` (`src/bootstrap.ts:34`,
  `LASTLIGHT_CORE_DIR` override). Its `dashboard/` is a separate nested npm
  project with its own lockfile.

Four lockfiles, three checkouts, sibling-path assumptions, version lag.

## Target workspace layout

The monorepo **is** `nearform/lastlight`. Core `git mv`s into `apps/server`;
siblings arrive by `git subtree add`.

```
lastlight/                          # repo root (.git), private root package
├── pnpm-workspace.yaml  turbo.json  tsconfig.base.json  pnpm-lock.yaml  .nvmrc
├── package.json                    # private, orchestration scripts only
├── instance/                       # deployment overlay — STAYS at repo root
├── docs/                           # cross-cutting docs (this plan) — stays at root
├── .github/workflows/              # ci / publish / deploy-www / deploy-evals
├── apps/
│   ├── server/                     # @lastlight/core — harness + server + Docker + ./evals barrel
│   │   ├── package.json            # name @lastlight/core, exports ./evals, files:[assets…]; NO bin
│   │   ├── tsconfig.json           # Node16; keeps the package-local #src/* alias
│   │   ├── src/  config/  workflows/  skills/  agent-context/  deploy/  spec/  sandbox/
│   │   ├── Dockerfile  sandbox-base.Dockerfile  sandbox.Dockerfile  sandbox-qa.Dockerfile
│   │   ├── docker-compose.yml  docker-bake.hcl  Caddyfile  CLAUDE.md
│   │   ├── scripts/dev-local.sh    # moves with core
│   │   ├── tests/                  # server test suite moves with core
│   │   └── dashboard/              # @lastlight/dashboard (admin SPA) — nested (F3)
│   ├── www/                        # lastlight-www (Astro) → lastlight.dev
│   │   ├── scripts/sync-spec.mjs   # spec source → ../server/spec (apps-relative)
│   │   └── src/content/spec/       # committed fallback copies stay
│   └── evals/                      # lastlight-evals → evals.lastlight.dev
│       ├── package.json            # name lastlight-evals; dep @lastlight/core: workspace:*
│       ├── wrangler.jsonc  scripts/build-site.ts  datasets/  examples/
│       └── dashboard/              # @lastlight/evals-dashboard — nested
└── packages/
    ├── cli/                        # published "lastlight" — LEAN global bin + host-local server cmds
    │   ├── package.json            # bin.lastlight → dist/cli.js; ships plugins/ + .claude-plugin/
    │   ├── src/  plugins/  .claude-plugin/
    │   └── tests/
    ├── shared/                     # @lastlight/shared — light modules used by cli + core
    │   └── src/                    # providers, oauth, overlay-bootstrap, overlay-assets,
    │                               # core-pin, workflow loader (+ the config types it needs)
    └── workflow-engine/            # @lastlight/workflow-engine — core/ ports/ test-support/
```

`pnpm-workspace.yaml` (final form):

```yaml
packages:
  - "apps/*"              # @lastlight/core, lastlight-www, lastlight-evals
  - "apps/*/dashboard"    # @lastlight/dashboard, @lastlight/evals-dashboard
  - "packages/*"          # lastlight (cli), @lastlight/shared, @lastlight/workflow-engine
```

## Dependency graph (workspace edges only)

```
@lastlight/workflow-engine   (zod only — light)
        ▲            ▲
@lastlight/shared    │       (fs/yaml/zod + @clack/prompts/chalk + pi-ai/oauth — light)
   ▲        ▲        │
   │        │        │
lastlight   @lastlight/core  (heavy: better-sqlite3, slack, octokit, hono, otel, agentic-pi…)
  (cli)            ▲
                   │ workspace:*
             lastlight-evals
```

Invariants: **no edge ever points from `shared`/`workflow-engine` back to
`core`** (dep-cruiser gate, Phase 3); **the CLI never gains an edge to
`core`** (F4). Both dashboards are leaves consumed only by their app's build.

## Tooling

- **pnpm** everywhere; one `pnpm-lock.yaml`. Strict `node_modules` — phantom
  deps become install errors (declare them, don't hoist around them).
- **Turborepo** tasks (`turbo.json`): `build` (`dependsOn: ["^build"]`,
  outputs `dist/**`, `dist-site/**`, `dashboard/dist/**`), `typecheck` + `test`
  (`dependsOn: ["^build"]`), `deploy` (`dependsOn: ["build"]`,
  `"cache": false`, always `--filter`ed to one app).
- Root `package.json`: `private: true`, `packageManager: pnpm@<pinned 9.x>`,
  `engines.node: ">=22.12"`, scripts delegating to `turbo run …`. `.nvmrc` =
  `22` (locked decision 4).

## TypeScript strategy

- `tsconfig.base.json`: shared flags only (`target ES2022`, `strict`,
  `esModuleInterop`, `skipLibCheck`, `resolveJsonModule`, declarations +
  sourcemaps). **No `module`/`moduleResolution` in the base** — set per
  package.
- **Node16** module resolution for `@lastlight/core`, `lastlight-evals`,
  `packages/{cli,shared,workflow-engine}` (the `exports` maps and
  `require.resolve` fences depend on real Node resolution). **Bundler** for
  `apps/www` (Astro) and both dashboards (Vite).
- `#src/*` paths alias stays inside `apps/server/tsconfig.json` only.
- Build ordering comes from Turbo `^build`, not TS project references.

## Publish contract (four packages)

| Package | Dir | Publishes | Key fields |
|---|---|---|---|
| `lastlight` (CLI) | `packages/cli` | npm, public | `bin.lastlight: dist/cli.js`; deps: chalk, @clack/prompts, cli-table3, yaml, zod, `@earendil-works/pi-ai` (oauth subpath), workspace: shared + workflow-engine; `files: [dist, plugins, .claude-plugin]` |
| `@lastlight/core` | `apps/server` | npm, public | `main: dist/index.js`; `exports: {".", "./evals", "./dist/*", "./package.json"}`; **no bin**; `files: [dist, config, workflows, skills, agent-context, deploy, sandbox.Dockerfile, docker-compose.yml]` (plugin dirs removed — they move to the CLI) |
| `@lastlight/workflow-engine` | `packages/workflow-engine` | npm, public | `core/` + `ports/` + `test-support/` exports; zod-only runtime deps |
| `lastlight-evals` | `apps/evals` | npm, public | unchanged name/bin; dep `@lastlight/core: workspace:*` (rewritten to a concrete range on publish) |

**`@lastlight/shared` publishes as a fifth package** (README locked decision
14): it is a runtime `workspace:*` dependency of two *published* packages
(`lastlight` and `@lastlight/core`), and pnpm rewrites `workspace:*` to a
concrete version range on pack — which must be installable from npm. It
carries no API-stability promise (internal surface, versioned manually like
the rest — decision 15). This corrects the design doc's "four published
packages".

Private: the root package, `@lastlight/dashboard`,
`@lastlight/evals-dashboard`, `lastlight-www`.

**F1 both ways:** locally, `workspace:*` symlinks
`node_modules/@lastlight/core → apps/server`, whose directory holds the asset
dirs exactly as the published tarball root does — this is **why the asset dirs
must stay directly under `apps/server/`** and why core must be built before
evals runs (Turbo `^build`). Published, pnpm rewrites `workspace:*` to
concrete ranges and the barrel + `require.resolve` are npm-standard.

## Runtime paths that must not break

- **Admin SPA (F3):** `serveStatic({ root: "dashboard/dist" })` is
  cwd-relative. Runtime cwd is `/app` in the image (= the deployed core
  package root) and `apps/server` locally. Never edit the string.
- **Docker (F2):** image build context = repo root; the agent Dockerfile does
  a pnpm workspace install filtered to `@lastlight/core` +
  `@lastlight/dashboard`, builds engine → shared → core → dashboard, then
  `pnpm --filter @lastlight/core deploy --prod /app` so `/app` is shaped like
  today's image (dist/, dashboard/dist/, config/, workflows/, skills/,
  agent-context/, deploy/, node_modules/). Entrypoint, UID 10001, gosu,
  volumes, EXPOSE, GIT_SHA/BUILD_DATE args unchanged.
- **`lastlight server` (F5):** `home` (git root, `instance/`, override
  symlink, `readCorePin`) stays the repo root; `serverDir = <home>/apps/server`
  is the compose/asset root. Compose runs as
  `docker compose -f <serverDir>/docker-compose.yml -f
  <home>/docker-compose.override.yml --project-directory <home> <cmd>`
  (explicit `-f` disables auto-override loading, hence the second `-f`).
  `--project-directory <home>` keeps `build.context: .` = repo root and
  `./instance` = `<home>/instance`. `enumerateOverlayAssets` gets
  `coreRoot: serverDir`.
- **Evals asset discovery (F1):** `require.resolve("@lastlight/core/package.json")`
  → `apps/server/package.json` via the workspace symlink; asset dirs are its
  siblings. `LASTLIGHT_CORE_DIR` override unchanged.
- **CLI package-root helpers (F4):** `skills-install.ts` / `fork-cli.ts`
  resolve the package root relative to `import.meta.url`; in `packages/cli`
  the compiled entry is `dist/cli.js` (one level deep, not two) — helpers
  updated + regression-tested (locked decision 12).

## CI / publish (target, Phase 7)

- `ci.yml` (PR + push + `workflow_call`): pnpm install → `turbo run typecheck
  test build`. Turbo content-hashing does per-package skipping.
- `publish.yml` (GitHub Release + `workflow_dispatch`): `checks → images`
  only. `images` = `docker buildx bake --push core` then `sandbox-qa`
  (dockerfiles under `apps/server/`, context repo root). **npm publishing is
  manual** (decision 15): after the images land, the operator publishes in
  dependency order (engine → shared → core → cli → evals;
  `pnpm -r publish --access public` is topological; pnpm rewrites
  `workspace:*` on pack). Documented in `docs/RELEASING.md` (Phase 7).
- `deploy-www.yml`: push to `main` touching `apps/www/**` or
  `apps/server/spec/**` → build + `wrangler deploy` (new automation — www has
  no CI today; needs `CLOUDFLARE_API_TOKEN`).
- `deploy-evals.yml`: push touching `apps/evals/**` → `build:site` +
  `wrangler deploy` (eval-results stay gitignored; the baked site ships with
  an empty `data/` in CI — results population stays a manual step).
