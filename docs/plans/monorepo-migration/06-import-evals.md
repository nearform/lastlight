# Phase 6 — Import `lastlight-evals` into `apps/evals` + wire to `@lastlight/core` (fence F1)

Risk: **HIGH** — this phase proves fence **F1** (the evals barrel + asset
discovery). Read [README.md](README.md) and
[00-target-architecture.md](00-target-architecture.md) first — this doc assumes
their locked decisions (subtree import, decision 2; the atomic barrel-address
rename, decision 3; asset dirs stay directly under `apps/server/`, §Publish
contract).

## Goal

Bring the evals harness (`nearform/lastlight-evals` → `evals.lastlight.dev`,
npm package `lastlight-evals`) into the monorepo at `apps/evals` with history,
fold its two npm lockfiles into `pnpm-lock.yaml`, and flip its core dependency
from the published `lastlight ^0.9.0` (six minor versions stale) to
`@lastlight/core: workspace:*` — completing the name reassignment Phase 4
started. After this phase, evals develops against core's working tree instead
of a lagging tarball.

Facts this phase relies on (verified 2026-07-14 against
`~/work/lastlight-evals`):

- `package.json`: name `lastlight-evals` v0.7.1, `bin: {"lastlight-evals":
  "dist/run.js"}`, `files: ["dist","datasets","examples","models.json",
  "dashboard/dist"]`. Deps: `@clack/prompts ^1.2.0`, `chalk ^5.6.2`,
  **`lastlight ^0.9.0`**, `yaml ^2.5.0`. **Peer** dep `agentic-pi ^0.2.11`
  (also a devDep). Scripts use `npm --prefix dashboard …` for the nested
  dashboard.
- Exactly **three files** import from `"lastlight/evals"`:
  `src/bootstrap.ts:16` (`configureWorkflowAssets`), `src/init.ts:28`
  (`detectGh`, `bootstrapOverlayRepo`), `src/run-instance.ts:25-31`
  (`getWorkflow`, `runWorkflow`, types `ExecutorConfig`, `TemplateContext`,
  `RunnerCallbacks`).
- `src/bootstrap.ts:34`: `return dirname(require.resolve("lastlight/package.json"));`
  — locates core's shipped asset dirs (`workflows/`, `skills/`,
  `agent-context/`, `config/`). Overridden by `LASTLIGHT_CORE_DIR`
  (lines 30-35). `src/init.ts` documents `LASTLIGHT_CORE_DIR=/path/to/lastlight`
  in generated help text (lines ~117 and ~149).
- `dashboard/` is an independent nested npm project: name
  `@lastlight/evals-dashboard`, `private: true`, **own
  `dashboard/package-lock.json`**, installed today via `npm --prefix`.
- `.github/workflows/` in the old repo: `ci.yml` (Node 24, `npm ci` →
  typecheck → vitest) and `publish.yml` (release-published → `npm publish
  --provenance`). After subtree import these land at `apps/evals/.github/`
  where **GitHub never reads them**.
- Tests: vitest collects only `src/mechanism.test.ts` — deterministic, AI-free
  (fake GitHub + `github_*` tool seam guard). It imports
  `agentic-pi/dist/extensions/github/client.js` directly, so agentic-pi must
  be installed as a real (dev) dep — pnpm's strict `node_modules` will not
  satisfy it via a hoisted phantom.
- The eval CLI (`tsx src/run.ts run` → `runInstance` in `src/run-instance.ts`)
  runs workflows against `startFakeGitHub()` — no GitHub token needed, only a
  provider API key.

## Preconditions

- Phases 1–5 ticked. In particular Phase 4 is done: the package at
  `apps/server` is **already named `@lastlight/core`** with the `./evals` and
  `./package.json` exports intact, and `pnpm turbo run build` produces
  `apps/server/dist/evals-api.js`.
- Clean working tree; read access to
  `git@github.com:nearform/lastlight-evals.git`.

## Files created / modified

| File | Change |
|---|---|
| `apps/evals/**` | **new** — the entire `lastlight-evals` repo, subtree merge |
| `apps/evals/package-lock.json` | **deleted** |
| `apps/evals/dashboard/package-lock.json` | **deleted** |
| `apps/evals/.github/` | **deleted** — inert after import; root CI takes over |
| `apps/evals/package.json` | dep flip `lastlight ^0.9.0` → `@lastlight/core: workspace:*`; scripts `npm --prefix dashboard …` → `pnpm --filter @lastlight/evals-dashboard …` |
| `apps/evals/src/bootstrap.ts` | line 16 import + line 34 `require.resolve` retarget to `@lastlight/core` |
| `apps/evals/src/init.ts` | line 28 import retarget; help text `LASTLIGHT_CORE_DIR` example updated |
| `apps/evals/src/run-instance.ts` | lines 25-31 import retarget |
| `pnpm-lock.yaml` | gains `apps/evals` + `apps/evals/dashboard` importers |

## Steps

1. **Import with history.** From the repo root, clean tree:

   ```bash
   git remote add evals-origin git@github.com:nearform/lastlight-evals.git
   git fetch evals-origin
   git subtree add --prefix=apps/evals evals-origin main
   ```

2. **Post-import cleanup** (one commit):
   - Delete `apps/evals/package-lock.json` and
     `apps/evals/dashboard/package-lock.json` — the workspace globs `apps/*`
     and `apps/*/dashboard` already match both packages; one `pnpm install`
     at the root folds them into `pnpm-lock.yaml`.
   - Delete `apps/evals/.github/` entirely. GitHub only evaluates the root
     `.github/`; the imported `ci.yml`/`publish.yml` would sit there as dead
     config. Root CI covers evals from this phase (its `typecheck`/`test`
     scripts are picked up by turbo); npm publishing migrates to the
     consolidated `publish.yml` in Phase 7.

3. **The dependency flip (F1's subject).** In `apps/evals/package.json`:
   - `dependencies`: replace `"lastlight": "^0.9.0"` with
     `"@lastlight/core": "workspace:*"`.
   - Keep `agentic-pi ^0.2.11` as **both** peer and devDependency, exactly as
     today — `mechanism.test.ts` deep-imports
     `agentic-pi/dist/extensions/github/client.js`, and under pnpm the local
     devDep is what satisfies it. Do not rely on `auto-install-peers`. (The
     skew vs core's `^0.2.16` is a known constraint — README "hard
     constraints"; align opportunistically only if tests stay green, else
     record in Deviations.)

4. **Import rewrites** — exactly three files import the barrel, plus the
   resolver:

   ```ts
   // src/bootstrap.ts:16
   import { configureWorkflowAssets } from "@lastlight/core/evals";
   // src/init.ts:28
   import { detectGh, bootstrapOverlayRepo } from "@lastlight/core/evals";
   // src/run-instance.ts:25-31
   import { getWorkflow, runWorkflow, type ExecutorConfig,
            type TemplateContext, type RunnerCallbacks } from "@lastlight/core/evals";
   // src/bootstrap.ts:34
   return dirname(require.resolve("@lastlight/core/package.json"));
   ```

   The `LASTLIGHT_CORE_DIR` env override (bootstrap.ts:30-35) stays
   byte-identical in behaviour. Update its comment and the generated help
   text in `src/init.ts` (lines ~117 and ~149) so the example reads
   `LASTLIGHT_CORE_DIR=/path/to/lastlight/apps/server` (the monorepo core
   package dir, not the repo root).

   Grep to confirm completeness — there must be **zero** remaining references
   to the old address:

   ```bash
   grep -rn '"lastlight/evals"\|lastlight/package.json' apps/evals/src apps/evals/scripts
   ```

5. **Script rewrites** in `apps/evals/package.json` — the nested dashboard is
   now a workspace member, so `--prefix` installs are wrong (they'd write a
   fresh npm lockfile):
   - `build:dashboard`: `npm --prefix dashboard install --no-audit --no-fund
     && npm --prefix dashboard run build` → `pnpm --filter
     @lastlight/evals-dashboard build`.
   - `typecheck`: `tsc --noEmit && npm --prefix dashboard run typecheck` →
     `tsc --noEmit && pnpm --filter @lastlight/evals-dashboard typecheck`.
   - `dev:dashboard`: `npm --prefix dashboard run dev` → `pnpm --filter
     @lastlight/evals-dashboard dev`.
   - `build`, `build:harness`, `build:site`, `deploy`, `eval*`, `serve`,
     `init`, `test` stay as-is (`deploy` remains a manual local action until
     Phase 7).

6. **Install + build the graph.** `pnpm install`, then `pnpm turbo run build`
   — turbo's `^build` ordering builds engine → shared → core → evals, which
   is what makes the workspace symlink resolvable (next section).

## Verification

**Why F1 holds locally:** `workspace:*` symlinks
`node_modules/@lastlight/core` → `apps/server`. `require.resolve` follows the
symlink to the real directory, which holds `workflows/`, `skills/`,
`agent-context/`, `config/` as first-class siblings of `package.json` —
exactly the shape of the published tarball root. That is the load-bearing
reason the asset dirs live directly under `apps/server/` (00-target §Publish
contract) and why core must be built first (`dist/evals-api.js` must exist
for the `./evals` export).

```bash
# 0. Everything builds in graph order
pnpm install && pnpm turbo run build

# 1. (a) The deterministic seam guard — fake GitHub, no AI, no token
pnpm --filter lastlight-evals test          # mechanism.test.ts green

# 2. (b) Asset discovery through the symlink
node -e '
  const { createRequire } = require("node:module");
  const { dirname, join } = require("node:path");
  const { existsSync, realpathSync } = require("node:fs");
  const req = createRequire(process.cwd() + "/apps/evals/src/bootstrap.ts");
  const root = dirname(req.resolve("@lastlight/core/package.json"));
  console.log("resolved:", root, "->", realpathSync(root));
  for (const d of ["workflows","skills","agent-context","config"]) {
    if (!existsSync(join(root, d))) throw new Error("missing asset dir: " + d);
  }
  console.log("F1 asset discovery OK");
'

# 3. (d) The publishable file set is unchanged
pnpm --filter lastlight-evals exec pnpm pack --out /tmp/evals-pack.tgz
tar -tzf /tmp/evals-pack.tgz | sort | head -50   # dist/ datasets/ examples/ models.json dashboard/dist/

# 4. Repo-wide green
pnpm turbo run typecheck test build
```

**(c) Recommended, not blocking** (needs a provider API key): run one real
eval case end-to-end against mocked GitHub through the symlinked core —

```bash
cd apps/evals && pnpm exec tsx src/run.ts run   # against an examples/ instance
```

— and confirm the workflow drives core's built `dist/` (barrel) while reading
prompts/skills from `apps/server/` (asset discovery). Record the case used.

## Rollback

`git revert -m 1 <subtree-merge-sha>` plus reverts of the cleanup/flip
commits (or branch reset if unpushed). The standalone repo and the published
`lastlight-evals@0.7.1` (pinned to old `lastlight ^0.9.0`, still resolvable
against the published 0.15.x tarballs) keep working — nothing external breaks
during rollback.

## Out of scope

- Archiving `nearform/lastlight-evals` — Phase 7 (after the first
  post-migration publish).
- Publishing `lastlight-evals` from the monorepo, the Cloudflare deploy
  Action — Phase 7.
- Re-basing evals' tsconfig onto `tsconfig.base.json` (it is already
  Node16-compatible; churn without payoff — backlog).
- Resolving the agentic-pi version skew (^0.2.11 vs core's ^0.2.16) — only if
  free (see step 3).

## Deviations

None yet.
