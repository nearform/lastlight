# Phase 1 — Tooling skeleton: pnpm + Turborepo, NO file moves

Risk: **low**. Read [README.md](README.md) and
[00-target-architecture.md](00-target-architecture.md) first — this doc assumes
their locked decisions (pnpm + Turborepo, Node 22 pin, release freeze, prod
pre-flight pin).

## Goal

Convert the existing npm workspace to **pnpm** and introduce **Turborepo**
without moving a single source file. At the end of this phase the repo builds,
typechecks, tests, and docker-builds exactly as today — same file layout, same
package name (`lastlight` at the repo root), same npm tarball — but with one
`pnpm-lock.yaml`, a pinned Node 22 toolchain, and `turbo.json` in place for
Phase 2 to hang real packages off. The gate is **parity with today's CI**, not
turbo purity: at this phase the root package *is* the main package, so turbo's
caching value is limited until Phase 2 creates `apps/*`.

Nothing here changes runtime behaviour. The npm tarball contents, the built
image contents, and every `dist/` path are byte-identical in intent.

## Preconditions

- The **pre-flight** checkbox in [README.md](README.md) is ticked: both prod
  overlays pin `deploy.version` to the last pre-migration release, and the
  release freeze is in effect.
- The repo is green on `main`: `npm ci && npm run build && npm run
  build:dashboard && npx tsc --noEmit && npx tsc -b dashboard && npx vitest
  run` all pass on a clean checkout.

## Files created / modified

| File | Change |
|---|---|
| `pnpm-workspace.yaml` | **new** — `packages: ["dashboard"]` |
| `pnpm-lock.yaml` | **new** — seeded via `pnpm import` from the npm lockfile |
| `package-lock.json` | **deleted** (554 KB root npm lockfile) |
| `package.json` | add `packageManager` + `engines.node`; remove `workspaces`; swap `-w dashboard` script invocations to `pnpm --filter`; add `turbo` devDep |
| `.nvmrc` | **new** — `22` |
| `turbo.json` | **new** — build/typecheck/test task graph |
| `.gitignore` | add `.turbo/` |
| `.github/workflows/ci.yml` | npm ci → pnpm install; Node 24 → 22 |
| `.github/workflows/publish.yml` | same swap in the `npm` job (stays valid; frozen) |
| `Dockerfile` | minimal install-step swap to pnpm — **no restructure** |
| `scripts/agentic-pi-pin.sh` | re-source the pin from `pnpm-lock.yaml` (was `package-lock.json`) |
| `tests/agentic-pi-pin.test.ts` | drift-guard reads `pnpm-lock.yaml` |

No file under `src/`, `dashboard/src/`, `workflows/`, `skills/`,
`agent-context/`, `config/`, or `deploy/` changes in this phase (except the
pin script/test above, which are build tooling).

## Steps

1. **Capture the baseline.** On a clean checkout of `main`, run the
   precondition commands and record `npm pack --dry-run` output (the shipped
   file list) to `/tmp/pack-baseline-phase1.txt`. This is the tarball fence
   used here and re-used in Phase 2.

2. **Pin the toolchain.** Create `.nvmrc` containing `22`. In the root
   `package.json` add:
   ```json
   "packageManager": "pnpm@9.x.y",
   "engines": { "node": ">=22.12" }
   ```
   Use the latest stable pnpm 9 at execution time and record the exact pin in
   Deviations. Enable it locally with `corepack enable`.

3. **Seed the pnpm lockfile from the npm one.** From the repo root:
   ```bash
   pnpm import          # reads package-lock.json → writes pnpm-lock.yaml
   git rm package-lock.json
   ```
   `pnpm import` preserves today's resolved versions, so this phase does not
   double as a dependency upgrade.

4. **Declare the workspace.** Create `pnpm-workspace.yaml`:
   ```yaml
   packages:
     - "dashboard"
   ```
   Remove `"workspaces": ["dashboard"]` from the root `package.json` —
   `pnpm-workspace.yaml` is now the single source of truth. (Phase 2 rewrites
   the globs to `apps/*` etc.)

5. **Swap npm-workspace script syntax for pnpm.** In root `package.json`
   scripts, the dashboard is addressed by its package name
   `@lastlight/dashboard` (from `dashboard/package.json`):
   - `build:dashboard`: `npm run build -w dashboard` →
     `pnpm --filter @lastlight/dashboard build`
   - `build:all`: `npm run build && npm run build -w dashboard` →
     `pnpm run build && pnpm --filter @lastlight/dashboard build`
   - `dev:dashboard`: `npm run dev -w dashboard` →
     `pnpm --filter @lastlight/dashboard dev`
   - `dev`: inside the `concurrently` line, replace `"npm run dev -w
     dashboard"` with `"pnpm --filter @lastlight/dashboard dev"`.
   Leave `build`, `test`, `start`, `cli`, `dev:server`, `test:watch`,
   `typecheck:test` untouched (they don't use `-w`).

6. **Install and fix phantom deps.** Run `pnpm install`. pnpm's strict
   `node_modules` layout no longer hoists transitive deps, so any import in
   `src/` or `dashboard/src/` of an undeclared package now fails at
   build/typecheck time. Fix by **declaring the dependency** in the package
   that imports it (never by loosening pnpm hoisting config), and record each
   one in Deviations. Known skew that is *fine*: the dashboard pins
   `agentic-pi ^0.2.4` while the root pins `^0.2.16` — under pnpm each package
   gets its own copy; do **not** force-align them in this phase.

7. **Add Turborepo.** `pnpm add -D turbo` at the root. Create `turbo.json`:
   ```json
   {
     "$schema": "https://turbo.build/schema.json",
     "tasks": {
       "build": { "dependsOn": ["^build"], "outputs": ["dist/**", "dashboard/dist/**"] },
       "typecheck": { "dependsOn": ["^build"] },
       "test": { "dependsOn": ["^build"] }
     }
   }
   ```
   Add `.turbo/` to `.gitignore`. Do not rewire the root scripts through turbo
   yet — with only two packages (root + dashboard) the direct pnpm scripts are
   the gate; Phase 2 makes `turbo run` the canonical entry.

8. **Re-source the agentic-pi pin from the pnpm lockfile.**
   `scripts/agentic-pi-pin.sh` regenerates `sandbox/agentic-pi.pin` (version +
   sha512 integrity, currently `0.2.16`) from `package-lock.json`, and
   `tests/agentic-pi-pin.test.ts` drift-guards the pin against the lockfile.
   Both must now read `pnpm-lock.yaml` (the agentic-pi entry carries the same
   `version` and `resolution.integrity` fields). Port both; the committed
   `sandbox/agentic-pi.pin` file itself must come out **byte-identical**
   (same version, same integrity hash — `pnpm import` preserved the
   resolution). If the test is not lockfile-coupled after inspection, note
   that in Deviations and skip the port.

9. **CI: `.github/workflows/ci.yml`.** In the `check` job:
   - after checkout, add `pnpm/action-setup@v4` (no explicit version — it
     reads `packageManager`);
   - `setup-node@v6`: `node-version: 22` (was 24), `cache: pnpm` (was npm);
   - `npm ci` → `pnpm install --frozen-lockfile`.
   Keep the three check steps (`npx tsc --noEmit`, `npx tsc -b dashboard`,
   `npx vitest run`) and the `workflow_call` surface (the optional `ref`
   input) exactly as they are — `publish.yml`'s `checks` job reuses this
   workflow.

10. **CI: `.github/workflows/publish.yml`.** In the `npm` job only: same
    pnpm/action-setup + Node 22 + `cache: pnpm` + `pnpm install
    --frozen-lockfile` swap; keep `npm run build` → `pnpm run build` and leave
    `npm publish --provenance --access public` as-is (publish needs no
    lockfile; the registry auth comes from setup-node's `registry-url`). The
    release freeze means this won't fire before Phase 7, but it must stay
    syntactically valid — it is re-verified there.

11. **Dockerfile: minimal pnpm swap.** Keep the single-stage structure and
    COPY ordering; change only the install/build mechanics:
    - after the base `FROM node:22-slim` setup, add `RUN corepack enable`;
    - `COPY package.json package-lock.json* ./` →
      `COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./`
      (keep the adjacent `COPY dashboard/package.json dashboard/package.json`);
    - `RUN npm install` → `RUN pnpm install --frozen-lockfile`;
    - `RUN npm run build && npm run build:dashboard` →
      `RUN pnpm run build && pnpm run build:dashboard`.
    Everything else (system deps, `useradd -u 10001`, asset COPYs, `VOLUME`,
    `ARG GIT_SHA`/`BUILD_DATE`, `ENTRYPOINT`, `CMD`) is untouched — the
    restructure to a multi-stage workspace build is Phase 2.

12. **Full local pass + image build** (see Verification), then commit as
    focused commits, e.g. (a) lockfile + workspace conversion, (b) turbo +
    nvmrc, (c) CI swap, (d) Dockerfile swap, (e) pin script port.

## Verification

All from a clean checkout of the phase branch:

```bash
corepack enable
pnpm install --frozen-lockfile          # must succeed with no lockfile drift
pnpm run build                          # tsc + cli chmod, as today
pnpm run build:dashboard                # vite build via --filter
npx tsc --noEmit                        # server typecheck (CI parity)
npx tsc -b dashboard                    # dashboard typecheck (CI parity)
pnpm test                               # vitest run — includes the ported agentic-pi pin test
npm pack --dry-run                      # file list identical to /tmp/pack-baseline-phase1.txt
docker buildx bake agent                # agent image still builds (or: docker compose build agent)
git status --short                      # package-lock.json deleted, pnpm-lock.yaml added
```

Also confirm `git diff main -- sandbox/agentic-pi.pin` is empty (the pin is
byte-identical) and that CI on the PR is green with the pnpm steps.

## Rollback

Single `git revert` of the phase commits restores `package-lock.json` and the
npm scripts; nothing was published and prod is pinned (pre-flight), so there
is no deploy-side exposure. If a phantom-dep fix (step 6) revealed a genuine
missing dependency, keep that commit — it is a latent bug fix, not part of the
conversion.

## Out of scope

- Any file move (`apps/`, `packages/` do not exist yet) — Phase 2.
- Rewiring root scripts through `turbo run` — Phase 2.
- The multi-stage Docker rewrite, bake/compose repoints — Phase 2.
- CI consolidation, the manual publish flow (RELEASING.md), Cloudflare deploy
  jobs — Phase 7.
- Aligning the dashboard/root `agentic-pi` version skew — backlog.

## Deviations

None yet.
