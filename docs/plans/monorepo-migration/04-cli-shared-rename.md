# Phase 4 — Lean CLI + `@lastlight/shared` + the `@lastlight/core` rename

Risk: **HIGH** — this phase reassigns the published `lastlight` name from the
server package to the new CLI package. Read [README.md](README.md) and
[00-target-architecture.md](00-target-architecture.md) first — this doc
executes locked decisions 3, 11, 12, 13, 14 and proves fence **F4**.

## Goal

Three moves, executed as **one phase** because they are atomic (the `lastlight`
name can attach to the lean CLI *or* the heavy server package, never both):

1. **Create `@lastlight/shared`** (`packages/shared`) — the ~6 light modules
   the CLI reaches into, so it never drags core's heavy deps.
2. **Create `packages/cli`** — published as **`lastlight`** (v0.16.0): the
   global bin + host-local `server` lifecycle commands + the Claude plugin
   dirs. Lean by construction; F4 proves it.
3. **Rename `apps/server`'s package `lastlight` → `@lastlight/core`** — no
   `bin`, keeps the `./evals` barrel + shipped asset dirs.

After this phase: `npm i -g lastlight` (once published, Phase 7) is lean with
**no `better-sqlite3` native compile**; the server package is addressable as
`@lastlight/core` (evals flips to it in Phase 6).

## Preconditions

- Phases 1–3 ticked. `@lastlight/workflow-engine` exists at
  `packages/workflow-engine` (the CLI and shared both import the workflow
  schema from it).
- The Phase 3 fences are green: `evals-contract.test.ts` (barrel surface pin),
  `state-store-contract.test.ts`, `lint:boundaries`.
- The Phase 2 `npm pack --dry-run` baseline file list is recorded (in Phase
  2's Deviations/notes) — this phase diffs against it.
- Release freeze in force (README pre-flight): **nothing here is published**;
  prod hosts are pinned.

## Verified import graph (why this split is safe)

The CLI's only imports crossing out of `src/cli/` (verified 2026-07-14):

| CLI file | Cross-boundary import | Goes to |
|---|---|---|
| `cli-server.ts` | `../config/overlay-bootstrap.js`, `../config/overlay-assets.js`, `../config/core-pin.js` | `@lastlight/shared` |
| `fork-cli.ts` | `../workflows/loader.js`, `../workflows/schema.js`, `../config/overlay-assets.js` | shared (loader) + `@lastlight/workflow-engine` (schema) |
| `oauth-cli.ts` | `../engine/oauth.js` | `@lastlight/shared` |
| `setup.ts` | `../config/overlay-bootstrap.js`, `../providers.js` | `@lastlight/shared` |

The six shared modules import only: node built-ins, `yaml`,
`@clack/prompts`, `chalk`, `@earendil-works/pi-ai/oauth` (subpath), and
`workflows/schema.js` (zod-only, now in the engine). `providers.ts` has zero
imports. The one link into heavy config is **type-only**
(`loader.ts:13` — `import type { DisabledConfig, RouteConfig } from
"../config/config.js"`), severed below by moving the types (decision 11).
None of `better-sqlite3` / `@slack/bolt` / `octokit` / `hono` / `croner` /
`agentic-pi` are reachable.

## Files created / modified

| File | Change |
|---|---|
| `packages/shared/package.json` | **new** — `@lastlight/shared` 0.1.0, publishable (decision 14) |
| `packages/shared/tsconfig.json` | **new** — extends base, Node16 |
| `packages/shared/src/{providers,oauth,overlay-bootstrap,overlay-assets,core-pin,workflow-loader,config-types}.ts` | **moved** from `apps/server/src/` (git mv, then import rewrites) |
| `packages/cli/package.json` | **new** — name **`lastlight`** 0.16.0, `bin.lastlight: dist/cli.js`, `files: [dist, plugins, .claude-plugin]` |
| `packages/cli/tsconfig.json` | **new** — extends base, Node16 |
| `packages/cli/src/*.ts` | **moved** from `apps/server/src/cli/` (9 files) |
| `packages/cli/plugins/`, `packages/cli/.claude-plugin/` | **moved** from `apps/server/` |
| `packages/cli/plugins/lastlight/.claude-plugin/plugin.json` | version → 0.16.0 (lockstep rule) |
| `packages/cli/tests/package-root.test.ts` | **new** — decision 12 regression test |
| `apps/server/package.json` | **rename** → `@lastlight/core` 0.16.0; **delete `bin`**; `files` drops `plugins`, `.claude-plugin`; deps `@lastlight/shared: workspace:*` |
| `apps/server/src/evals-api.ts` | re-export sources repoint to `@lastlight/shared` (symbol set unchanged) |
| `apps/server/src/config/config.ts` | `DisabledConfig`/`RouteConfig` declarations removed; imported from shared |
| `apps/server/src/**` (sweep) | imports of the six moved modules → `@lastlight/shared` |
| `apps/server/Dockerfile` | `pnpm --filter lastlight …` → `--filter @lastlight/core`; `pnpm deploy` filter likewise |
| root `package.json` | scripts' `--filter lastlight` → `--filter @lastlight/core`; `cli` script → `pnpm --filter lastlight cli` (now the CLI package) |
| `pnpm-lock.yaml` | install side effect |

## Steps

### Group 1 — `@lastlight/shared`

1. Scaffold `packages/shared`: `package.json` (`name: "@lastlight/shared"`,
   `version: "0.1.0"`, `type: "module"`, `main`/`types` → `dist/index.js`,
   `files: ["dist"]`, exports `.` + `./package.json`; deps: `yaml`,
   `@clack/prompts`, `chalk`, `@earendil-works/pi-ai`,
   `"@lastlight/workflow-engine": "workspace:*"`); `tsconfig.json` extending
   `../../tsconfig.base.json` with Node16. **Not private** — it's a runtime
   dep of two published packages (decision 14).
2. `git mv` the six modules (own commit, before rewrites):
   - `apps/server/src/providers.ts` → `packages/shared/src/providers.ts`
   - `apps/server/src/engine/oauth.ts` → `packages/shared/src/oauth.ts`
   - `apps/server/src/config/overlay-bootstrap.ts` → `packages/shared/src/overlay-bootstrap.ts`
   - `apps/server/src/config/overlay-assets.ts` → `packages/shared/src/overlay-assets.ts`
   - `apps/server/src/config/core-pin.ts` → `packages/shared/src/core-pin.ts`
   - `apps/server/src/workflows/loader.ts` → `packages/shared/src/workflow-loader.ts`
3. **Sever the type-only link (decision 11):** create
   `packages/shared/src/config-types.ts` holding the `DisabledConfig` and
   `RouteConfig` type declarations (moved out of
   `apps/server/src/config/config.ts`). `workflow-loader.ts`'s type-only
   import repoints there; `apps/server/src/config/config.ts` now imports the
   two types **from `@lastlight/shared`**. No shared→core edge ever exists.
4. Fix the movers' own imports: `workflow-loader.ts`'s `./schema.js` →
   `@lastlight/workflow-engine`; `oauth.ts`'s `../providers.js` →
   `./providers.js`. Barrel them in `packages/shared/src/index.ts`.
5. Rewire core. Sweep:
   ```bash
   grep -rn "providers\.js\|engine/oauth\.js\|overlay-bootstrap\.js\|overlay-assets\.js\|core-pin\.js\|workflows/loader\.js" apps/server/src apps/server/tests
   ```
   Replace each with an `@lastlight/shared` import (add
   `"@lastlight/shared": "workspace:*"` to `apps/server/package.json`).
   Leave one-line re-export shims **only if** the sweep shows >20 call sites
   for a module; otherwise rewrite directly (prefer direct — shims here would
   outlive their purpose).
6. Repoint `apps/server/src/evals-api.ts` re-export sources:
   `getWorkflow` / `configureWorkflowAssets` / `WorkflowAssetConfig` (from
   shared's loader) and `detectGh` / `bootstrapOverlayRepo` /
   `scaffoldOverlayFiles` / `OVERLAY_GITIGNORE` / `OVERLAY_CONFIG_PLACEHOLDER`
   / `OVERLAY_ENV_EXAMPLE` / `OVERLAY_README` / `GhStatus` / `ScaffoldResult`
   / `BootstrapOpts` (from shared). **The exported symbol set must not change**
   — the Phase 3 `evals-contract.test.ts` fence guards this; run it now.

### Group 2 — `packages/cli` (published `lastlight`)

7. Scaffold `packages/cli/package.json`:
   ```json
   {
     "name": "lastlight",
     "version": "0.16.0",
     "type": "module",
     "bin": { "lastlight": "dist/cli.js" },
     "files": ["dist", "plugins", ".claude-plugin"],
     "dependencies": {
       "chalk": "…", "@clack/prompts": "…", "cli-table3": "…",
       "yaml": "…", "zod": "…", "@earendil-works/pi-ai": "…",
       "@lastlight/shared": "workspace:*",
       "@lastlight/workflow-engine": "workspace:*"
     }
   }
   ```
   (copy the version ranges from `apps/server/package.json`; **nothing
   else** may appear in `dependencies` — F4 audits this). Build script mirrors
   core's: `tsc && node -e "require('fs').chmodSync('dist/cli.js', 0o755)"`.
8. `git mv apps/server/src/cli/* packages/cli/src/` (all 9 files: `cli.ts`,
   `cli-config.ts`, `cli-format.ts`, `cli-server.ts`, `cli-timeline.ts`,
   `fork-cli.ts`, `oauth-cli.ts`, `setup.ts`, `skills-install.ts`) and
   `git mv apps/server/plugins apps/server/.claude-plugin packages/cli/`
   (own commit). Sibling `./*.js` imports survive the move unchanged;
   `cli.ts`'s lazy `import()`s are siblings too.
9. Rewrite the cross-boundary imports per the table above
   (`@lastlight/shared` / `@lastlight/workflow-engine`).
10. **Path-depth fix (decision 12).** The compiled entry moves from
    `dist/cli/cli.js` (two levels below package root) to `dist/cli.js` (one):
    - `skills-install.ts` `bundleRoot()`: `path.resolve(dirname(fileURLToPath(import.meta.url)), "../..")` → `".."`.
    - `fork-cli.ts` `bundledAssetRoot()`: same `"../.."` → `".."`.
    - `cliVersion()` (grep for it — it reads `package.json` relative to the
      compiled file): same one-level fix.
    Both source (`src/*.ts`) and compiled (`dist/*.js`) now sit exactly one
    level below package root, so the helpers are correct in dev (`tsx`) and
    installed modes alike.
11. **Remove `fork-cli`'s bundled-asset fallback.** `resolveCoreRoot(...)`
    keeps its candidate walk (cwd overlay / server home), but when no
    candidate contains `workflows/` + `skills/` it now **errors** with a
    message pointing at `--home <server checkout>` — the CLI no longer ships
    `workflows/skills/agent-context` (the old fallback would resolve to a
    package root that lacks them). `skills-install.ts` is unaffected: it ships
    and resolves `plugins/lastlight/` from the CLI package root.
12. Add `packages/cli/tests/package-root.test.ts`: asserts the resolved
    package root contains a `package.json` with `name === "lastlight"` and a
    `plugins/lastlight/` dir; asserts `fork-cli`'s no-candidate path throws
    the `--home` error rather than falling back. Move any existing CLI tests:
    ```bash
    grep -rln "cli-server\|fork-cli\|skills-install\|oauth-cli\|cli-config\|cli-format" apps/server/tests
    ```
    — relocate what exists to `packages/cli/tests/` and fix imports. Give the
    package a `test` script (`vitest run`) + a minimal `vitest.config.ts` if
    needed.
13. `plugins/lastlight/.claude-plugin/plugin.json` `version` → `0.16.0`
    (the release-dance lockstep rule now binds plugin.json to the **CLI**
    package version).
14. Root `package.json` script `cli` → `pnpm --filter lastlight cli` (which
    runs `tsx src/cli.ts` in `packages/cli`). Sweep docs/CLAUDE.md snippets
    referencing `dist/cli/cli.js` or `npm run cli` and update (do not rewrite
    prose beyond the paths).

### Group 3 — rename `apps/server` → `@lastlight/core`

15. `apps/server/package.json`: `name` → `"@lastlight/core"`, `version` →
    `"0.16.0"`, **delete `bin`**, `files` → `["dist", "config", "workflows",
    "skills", "agent-context", "deploy", "sandbox.Dockerfile",
    "docker-compose.yml"]` (plugin dirs gone), `exports` unchanged
    (`"."`, `"./evals"`, `"./dist/*"`, `"./package.json"`). Drop the
    `chmodSync('dist/cli/cli.js')` tail from its `build` script (no bin left).
16. Update every `--filter lastlight` that meant the server package:
    - root `package.json` scripts (dev/build/test delegations from Phase 1/2),
    - `apps/server/Dockerfile` (`pnpm install --filter`, `pnpm --filter …
      build`, `pnpm --filter … deploy --prod /app` — from Phase 2's rewrite),
    - any turbo `--filter` invocations in docs/scripts.
    `--filter lastlight` now selects the **CLI** package — every stale one is
    a silent wrong-target, so sweep exhaustively:
    ```bash
    grep -rn -- "--filter[= ]lastlight\b" --include="*.{json,yml,yaml,sh,md}" . | grep -v node_modules
    ```
17. Self-reference sweep: `grep -rn '"lastlight"' */*/package.json
    package.json` — the only remaining `"name": "lastlight"` must be
    `packages/cli/package.json`. Do **not** touch the docker image names
    (`lastlight-agent`, `lastlight-sandbox*` — fixed local names in
    `apps/server/src/sandbox/images.ts`), the `lastlight-evals` name, or CLI
    user-facing strings.

## Verification

### Workspace green

```bash
pnpm install
pnpm turbo run typecheck test build
pnpm --filter lastlight test              # the CLI package's own suite
pnpm --filter @lastlight/core exec vitest run tests/workflows/evals-contract.test.ts
pnpm --filter @lastlight/core run lint:boundaries
```

### Pack-list fence (core)

```bash
cd apps/server && npm pack --dry-run
```
Diff against the Phase 2 baseline: identical **minus** `plugins/**`,
`.claude-plugin/**`, and `dist/cli/**`. Any other delta is a regression.

### F4 — lean global install (the phase gate)

**The pre-publish trap:** the packed CLI tarball depends on
`@lastlight/shared` + `@lastlight/workflow-engine` at concrete versions that
must be resolvable from the registry, so a naive
`npm i -g lastlight-0.16.0.tgz` in a clean container fails until they exist.

**Primary path (locked decision 15 — manual publishes are allowed for the
new scoped packages):** ✋ the operator publishes
`@lastlight/workflow-engine@0.1.0` and `@lastlight/shared@0.1.0` to the
**real npm registry** now (fresh names, zero consumers — publishing them
mid-freeze is harmless; only the `lastlight` name itself stays frozen):

```bash
pnpm --filter @lastlight/workflow-engine publish --access public
pnpm --filter @lastlight/shared          publish --access public
pnpm --filter lastlight pack --pack-destination /tmp   # → /tmp/lastlight-0.16.0.tgz
```

Then in a **clean** container:

```bash
docker run --rm -v /tmp/lastlight-0.16.0.tgz:/tmp/cli.tgz node:22-slim bash -lc '
  set -e
  npm i -g --foreground-scripts /tmp/cli.tgz 2>&1 | tee /tmp/install.log
  ! grep -Ei "node-gyp|gyp ERR|prebuild|python" /tmp/install.log      # no native compile
  for p in better-sqlite3 @slack/bolt octokit hono croner agentic-pi; do
    npm ls -g "$p" 2>/dev/null | grep -q "$p@" && { echo "HEAVY DEP: $p"; exit 1; }
  done
  lastlight --help
  lastlight server status || true   # must fail GRACEFULLY (no home), not crash on import
  du -sh "$(npm root -g)"
'
```

Assert: install exit 0; no native build markers; the six heavy deps absent;
`--help` works; `server status` prints its no-home error (not a module-load
stack). Record the `du -sh` figure in Deviations; **flag** (don't fix) if
`@earendil-works/pi-ai` dominates — vendoring its oauth submodule is the
design's noted follow-up, out of scope here.

**Fallback (if the operator prefers not to publish engine/shared yet):** run
a throwaway local registry — `docker run -d --name verdaccio -p 4873:4873
verdaccio/verdaccio:6`, `pnpm --filter <pkg> publish --registry
http://localhost:4873 --no-git-checks` for engine, shared, and cli, then the
same clean-container assertions with `npm i -g --registry
http://host.docker.internal:4873 lastlight` (Linux: `--network host` +
`127.0.0.1`). Tear down with `docker rm -f verdaccio`.

### Barrel still importable

```bash
node -e "import('@lastlight/core/evals').then(m => console.log(Object.keys(m)))" \
  --experimental-vm-modules 2>/dev/null || \
  (cd /tmp && npm init -y >/dev/null && pnpm add ~/work/lastlight/apps/server && \
   node -e "import('@lastlight/core/evals').then(m=>console.log(Object.keys(m)))")
```
(or simpler: a tiny `tsx` script inside the repo importing
`@lastlight/core/evals` through the workspace symlink and logging the symbol
set — compare to the evals-contract fence list.)

## Rollback

Revert the phase's commits (`git revert` the range; the `git mv` commits
revert cleanly). The npm `lastlight` name still points at 0.15.x from before
the freeze; no external consumer saw any of this. If engine/shared were
published to npm for the F4 gate, they can stay (fresh names, zero
consumers) or be `npm deprecate`d — versions cannot be reused, so an
abandoned attempt just bumps their next publish to 0.1.1.

## Out of scope

- Publishing `@lastlight/core`, the `lastlight` CLI, or `lastlight-evals`
  (Phase 7's runbook — the manual flow, decision 15). The engine + shared
  publishes above are the one sanctioned exception (fresh names, no
  consumers), done by the operator, not CI.
- Flipping evals to `@lastlight/core` (Phase 6 — evals isn't imported yet).
- Vendoring `@earendil-works/pi-ai`'s oauth submodule (flagged follow-up).
- CI workflow edits (Phase 7).
- Any behavior change to the `server` lifecycle commands beyond what Phase 2
  already did (F5 is proven and stays proven — the CLI code moves, its logic
  doesn't).

## Deviations

Executed 2026-07-16. Verified green: `pnpm turbo run typecheck test build`
(all packages), `pnpm --filter lastlight test` (7 files, 83 tests incl. the new
`package-root.test.ts`), core `evals-contract` + `lint:boundaries`, the core
`npm pack --dry-run` list, and the F4 clean-container gate.

- **loader + oauth kept re-export shims (not direct rewrites).** The plan's
  step 5 allows shims for >20-call-site modules; both qualify AND — decisively —
  the test suite `vi.mock("#src/workflows/loader.js")` (×5: runner, phase-executor,
  post-review, router) and `vi.mock("#src/engine/oauth.js")` (×2: chat-runner,
  agent-executor). A direct rewrite would move the real import to
  `@lastlight/shared`, so those mocks would no longer intercept the code under
  test. Kept thin shims at the original paths (`src/workflows/loader.ts` →
  `export * from "@lastlight/shared/workflow-loader"`, `src/engine/oauth.ts` →
  `@lastlight/shared/oauth`), preserving both the mock targets and the loader's
  process-global singleton identity. The consequence: those two moved files show
  as add-in-shared + modified-shim rather than pure `git mv` renames (the origin
  path is reused by the shim); the other four modules are clean renames.

- **Shared exposes per-module subpath exports; core imports narrow subpaths,
  never the barrel.** `@lastlight/shared`'s barrel `export *`s every module, so
  importing e.g. `PROVIDER_ENV_KEYS` from the barrel eagerly evaluates
  `overlay-bootstrap` (which imports `child_process` + `@clack/prompts` + `chalk`)
  — pulling interactive-CLI deps into the harness runtime and tripping
  `runner.test`'s partial `child_process` mock. Fixed by adding subpath exports
  (`./providers`, `./oauth`, `./overlay-bootstrap`, `./overlay-assets`,
  `./core-pin`, `./workflow-loader`, `./config-types`) and pointing every core
  importer + core test at the specific subpath. The barrel remains for the CLI
  (which legitimately uses the interactive modules).

- **CLI dependency set is the minimal imported closure, not the plan's superset.**
  The plan's step 7 lists `yaml`, `zod`, and `@earendil-works/pi-ai` among the
  CLI deps, but no CLI source imports them directly (oauth/loader/schema now
  arrive via `@lastlight/shared` / `@lastlight/workflow-engine`). Declared only
  the actually-imported set — `chalk`, `@clack/prompts`, `cli-table3`,
  `@lastlight/shared`, `@lastlight/workflow-engine` — which satisfies the plan's
  "nothing else may appear" ceiling and keeps the install leanest (pi-ai still
  arrives transitively via shared's oauth, as F4 anticipates). Correspondingly
  removed the now-unused `chalk` / `@clack/prompts` / `cli-table3` from
  `@lastlight/core`'s deps (provably unused in the harness after the CLI moved).

- **Fixed a latent Phase-3 Dockerfile gap (in scope — the Dockerfile is retargeted
  here anyway).** Phase 3 added `@lastlight/workflow-engine` as a core workspace
  dep but never updated `apps/server/Dockerfile` to copy/build it, so the image
  build could not resolve or build the workspace link. Beyond the mandated
  `--filter lastlight → @lastlight/core` retarget, the build now `COPY`s
  `packages/{workflow-engine,shared}/package.json` before the filtered frozen
  install and their source before an explicit dependency-ordered build
  (engine → shared → core → dashboard), so `pnpm --filter @lastlight/core deploy`
  bundles their built dist into `/app`.

- **F4 gate ran against a throwaway verdaccio, not real npm.** The release-freeze
  carve-out forbids publishing under the frozen names, and the operator-publish
  of the new scoped names was not performed here. Instead: `@lastlight/workflow-engine`
  + `@lastlight/shared` were published to a local `verdaccio:6` container, the
  `lastlight` CLI packed with `pnpm pack` (rewriting `workspace:*` → `0.1.0`), and
  installed via `npm i -g` in a clean `node:22-slim` pointed at the local registry.
  Note: `shared` must be published from a `pnpm pack` tarball (or `pnpm publish`)
  — a plain `npm publish` leaves its `@lastlight/workflow-engine: workspace:*`
  unrewritten and the downstream install fails; the real Phase-7 flow uses
  `pnpm -r publish`, which rewrites, so this is a gate-setup nuance only.

  **F4 result:** install exit 0, no native-compile markers, all six audited heavy
  deps absent (`better-sqlite3`, `@slack/bolt`, `octokit`, `hono`, `croner`,
  `agentic-pi`); `lastlight --help` works; `lastlight server status` fails
  gracefully with its no-home pointer (not a module-load crash). **Measured global
  install ≈ 153M total, of which the `lastlight` subtree is ≈ 134M.** **Flagged:**
  `@earendil-works/pi-ai`'s transitive provider-SDK tree dominates — `@mistralai`
  25M, `@opentelemetry/*` (pi-ai's own API, not core's sdk stack) 15M, `openai`
  14M, `@google/genai` 14M, `@aws-sdk`+`@smithy` ~17M, `@anthropic-ai` 6.7M — even
  though the CLI only uses pi-ai's `oauth` subpath. Vendoring that submodule is
  the design's noted follow-up (out of scope here). `@opentelemetry/api` is
  therefore present transitively via pi-ai; core's heavy otel stack
  (`@opentelemetry/sdk-node`/exporters) is absent.
