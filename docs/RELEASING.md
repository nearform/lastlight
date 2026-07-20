# Releasing Last Light

The monorepo publishes **six** npm packages plus **four** Docker images.
Publishing is **automated**: cutting a GitHub Release fires `publish.yml`, which
runs CI checks → builds+pushes the GHCR images → publishes **five** of the six
npm packages (engine → shared → core → cli → evals) in dependency order via npm
**OIDC trusted publishing** (no `NPM_TOKEN` secret, provenance attestations on).
The sixth, **`agentic-pi`, is NOT published by `publish.yml`** — it has its own
independent npm stream (`agentic-pi-npm.yml`, fired by an `agentic-pi-v*` tag),
because its trusted-publisher entry on npmjs.com is scoped to that workflow, not
`publish.yml`. So a release that bumps agentic-pi needs **two** tags: the
`vX.Y.Z` release tag (five packages + images) **and** an `agentic-pi-vA.B.C` tag
(agentic-pi). The operator's job is to bump versions, tag, and cut the Release;
the pipeline does the rest. (The manual `pnpm -r publish` sequence below is kept
as the bootstrap/fallback path — e.g. the one-time first publish of a brand-new
package name, which OIDC trusted publishing can't do until the package exists.)

This document is the runbook. Read it end-to-end before your first release.

## When to release

**Essentially any prod-facing change.** `lastlight server update` deploys by
*pulling* the `ghcr.io/nearform/lastlight-*` images, and only a GitHub Release
builds them — so a harness / dashboard / asset / `config/default.yaml` change
reaches prod only once it's released and the overlay's `deploy.version` is bumped
to the tag. (`server update --local`, which builds from source on the host, is
the sole no-release path — for deploying un-released `main` or local edits.) A
**CLI**-only or `lastlight/evals` barrel (`apps/server/src/evals-api.ts`) change
also needs a release so the published npm packages pick it up: the standalone
`lastlight-evals` repo consumes core via npm, so a change to how those symbols
run workflows (the workflow runner, phase executor, sandbox port, config
resolution) must be published even when the CLI is untouched. When in doubt,
release it. Semver: patch = fix/refactor/doc, minor = new user-facing capability,
major = break.

## What ships

**npm (public):**

| Package | Dir | Line | Notes |
|---|---|---|---|
| `lastlight-workflow-engine` | `packages/workflow-engine` | 0.1.x | zod-only; leaf of the graph |
| `lastlight-shared` | `packages/shared` | 0.1.x | light modules used by cli + core |
| `agentic-pi` | `packages/agentic-pi` | 0.2.x | the coding-agent harness; consumed by core/evals/dashboard via `workspace:*`, and **vendored** into the sandbox image from the workspace (a `pnpm deploy` bundle built in `sandbox*.Dockerfile` — no npm round-trip). Own semver line + its own `image-v*` VM-image release stream (`agentic-pi-image.yml`) + independent npm publish (`agentic-pi-npm.yml`, for external consumers). No `exports` map on purpose (evals deep-imports `dist/`). |
| `lastlight-core` | `apps/server` | 0.16.x | the harness + server + `./evals` barrel + shipped assets |
| `lastlight` | `packages/cli` | 0.16.x | the lean global CLI (`bin.lastlight`); ships `plugins/` + `.claude-plugin/` |
| `lastlight-evals` | `apps/evals` | 0.7.x | eval harness; dep `lastlight-core: workspace:*` |

Everything else is `private: true` and never publishes: the root package
(`lastlight-monorepo`), `lastlight-www`, `@lastlight/dashboard`,
`@lastlight/evals-dashboard`.

**Docker (GHCR, `ghcr.io/nearform/lastlight-*`):** `agent`, `sandbox-base`,
`sandbox` (the required trio, built as one bake graph) + `sandbox-qa`
(non-fatal). Built and pushed by `publish.yml`'s `images` job.

## The dependency graph (why order matters)

```
lastlight-workflow-engine   (zod only)      agentic-pi   (own leaf, no workspace deps)
        ▲            ▲                         ▲     ▲
lastlight-shared    │                         │     │
   ▲        ▲        │        ┌────────────────┘     │
   │        │        │        │                      │
lastlight   lastlight-core ◀──┘                      │
  (cli)            ▲                                  │
                   │ workspace:*                      │
             lastlight-evals ◀────────────────────────┘  (workspace:* dev + peer range)
```

`agentic-pi` is a second leaf: it has no workspace dependencies, and
`lastlight-core`, `lastlight-evals`, and the private `@lastlight/dashboard`
consume it via `workspace:*`. So it must publish **before** core and evals — but
it publishes from a **separate workflow** (`agentic-pi-npm.yml`), so this
ordering is a **cross-workflow** constraint: when a release bumps agentic-pi, get
the new `agentic-pi@A.B.C` live on npm (push its `agentic-pi-vA.B.C` tag and let
`agentic-pi-npm.yml` finish) **before** `publish.yml`'s `npm` job packs core/evals.

pnpm rewrites every `workspace:*` dep to a **concrete version range at pack
time**. So a dependency's new version must be **live on npm before** its
dependent is published — otherwise the dependent's tarball pins a range npm
can't satisfy. That is the entire reason the publish order below is fixed.

## Version bumps are manual and graph-aware

This is the step manual flows get wrong. When you change a package, bump **it
and every package that consumes it**, transitively:

| You changed… | Also bump (they pick up the change) |
|---|---|
| `lastlight-workflow-engine` | `lastlight-core`, `lastlight-shared` (if it consumes engine), `lastlight` (cli), `lastlight-evals` (via core) |
| `lastlight-shared` | `lastlight-core`, `lastlight` (cli), `lastlight-evals` (via core) |
| `agentic-pi` | `lastlight-core`, `lastlight-evals` (both consume it via `workspace:*`). Bump `lastlight-evals`'s `peerDependencies` range to match too. The sandbox picks up the change automatically on the next image build (it vendors agentic-pi from the workspace — no pin to bump). |
| `lastlight-core` | `lastlight-evals` (its `workspace:*` dep) |
| `lastlight` (cli) | — (nothing depends on the cli) |
| `lastlight-evals` | — (nothing depends on evals) |

Rules:

- **`plugin.json` lockstep.** Keep
  `plugins/lastlight/.claude-plugin/plugin.json`'s `version` equal
  to the `lastlight` CLI version. Manual — bump it in the same commit as the CLI
  bump. (This is the direct successor of the old three-files-in-sync rule.)
- **Semver intent.** patch = fix/refactor/doc, minor = new user-facing
  capability, major = break. The CLI and core continue the 0.x line together for
  legibility; engine + shared are on 0.1.x; evals continues 0.7.x.
- **Baselines** (set in Phase 4 of the migration): `lastlight` **0.16.0**,
  `lastlight-core` **0.16.0**, `lastlight-workflow-engine` **0.1.0**,
  `lastlight-shared` **0.1.0**, `lastlight-evals` **0.7.1**. The first
  post-migration release is strictly greater than the last frozen `lastlight`
  release (`v0.16.0` was the pre-migration tag; the CLI's first published
  version must exceed it — e.g. `0.17.0`).

Bump a package with `pnpm --filter <name> exec npm version <patch|minor|major>
--no-git-tag-version` (or edit `package.json` directly), then re-run
`pnpm install --lockfile-only` so `pnpm-lock.yaml` reflects the new versions.

> **Do NOT use `pnpm --filter <name> version …`** — pnpm reads the bare word
> `version` as an npm **script** name, finds none, and aborts with "None of the
> selected packages has a 'version' script" *without bumping anything*. Route it
> through `exec npm version` (runs in the package dir) or edit `package.json`
> directly.

## Publish order (dependency order)

Always: **engine → shared → agentic-pi → core → cli → evals.** The `publish.yml`
`npm` job does this for **all but agentic-pi** on every Release (agentic-pi ships
from `agentic-pi-npm.yml`); the commands below are the **manual fallback** (a
bootstrap first-publish, or recovering a half-published release). agentic-pi
still slots in at its graph position — publish it (or let its own workflow
publish it) before core/evals.

```bash
# From a clean `main`, in sync with origin, after the version bumps are committed
# and the images for this tag are already in GHCR (see next section).

# Verify what WILL publish (private packages are skipped; workspace:* is shown
# rewritten to concrete ranges in the packed tarball):
pnpm -r publish --dry-run --access public --no-git-checks

# Publish everything, topologically ordered by pnpm in one command:
pnpm -r publish --access public

# …or, when only some packages changed, publish just those (still in dep order):
pnpm --filter lastlight-workflow-engine publish --access public
pnpm --filter lastlight-shared          publish --access public
pnpm --filter agentic-pi                 publish --access public
pnpm --filter lastlight-core            publish --access public
pnpm --filter lastlight                  publish --access public
pnpm --filter lastlight-evals            publish --access public
```

`pnpm -r publish` walks the workspace graph and publishes in topological order,
skipping any package whose current version already exists on npm — so it is safe
to re-run, and safe when only a subset changed. Confirm each landed:

```bash
npm view lastlight@X.Y.Z version --prefer-online          # note: no leading `v` on npm
npm view lastlight-core@X.Y.Z version --prefer-online
# …etc for each package you bumped.
```

## Images before npm (enforced by job-chaining)

`publish.yml` chains the `npm` job **after** `images` (`npm` needs `images`), so
the CLI can never reach npm before its images exist:

> A `lastlight` CLI version only publishes to npm once the `:vX.Y.Z` GHCR images
> for that version are already pushed.

Why it matters: a deploy host runs `npm i -g lastlight@X.Y.Z && lastlight server
update`, which **pulls** `ghcr.io/nearform/lastlight-*:vX.Y.Z`. If the CLI were
on npm before the images existed, that pull would fail. The chain guarantees the
order automatically — no manual sequencing needed.

## agentic-pi specifics

`agentic-pi` moved into the monorepo (from the standalone `nearform/agentic-pi`)
but stays a public npm package. Three things are unique to it:

- **Publishes from its OWN workflow, `agentic-pi-npm.yml` (not `publish.yml`).**
  OIDC trusted publishing is scoped to a repo **+ workflow filename**.
  `agentic-pi`'s trusted-publisher entry on npmjs.com is `nearform/lastlight` +
  `agentic-pi-npm.yml`, so **only** that workflow can publish it — `publish.yml`
  is deliberately *not* in the loop (it would 403/404). To ship an agentic-pi
  bump to npm, push an **`agentic-pi-vA.B.C` tag** (matching
  `packages/agentic-pi/package.json`); that fires `agentic-pi-npm.yml`. Because
  core/evals pin agentic-pi's concrete version at pack time, do this **before**
  cutting (or re-running the `npm` job of) the `vX.Y.Z` release.

- **The sandbox vendors agentic-pi from the workspace — there is no pin to
  regenerate.** `sandbox*.Dockerfile` builds agentic-pi from source in a builder
  stage (`pnpm deploy --prod`, lockfile-pinned) and COPYs the bundle in, so the
  sandbox always runs exactly the committed agentic-pi + the tree the lockfile
  resolved. Any change — bumping agentic-pi's version or one of its deps + `pnpm
  install` — flows into the sandbox on the next image build with no extra step.
  This deliberately decouples the sandbox from the npm publish (previously the
  sandbox installed the *published* tarball via a committed pin, and a caret
  transitive could drift to whatever npm resolved at build time). The independent
  `agentic-pi` npm publish (`agentic-pi-npm.yml`) is now for external consumers
  only.

- **VM image is a separate `image-v*` stream.** The gondolin VM sandbox image is
  built by `.github/workflows/agentic-pi-image.yml` on `image-v*` tags, wholly
  independent of the `vX.Y.Z` npm release. Consumers pick up a new image only
  when `packages/agentic-pi/src/sandbox/images/manifest.ts`'s baked URL/sha is
  bumped and a new `agentic-pi` npm version ships. (They point at the
  `nearform/lastlight` `image-v0.1.0` release assets, built by this workflow.)

## Cutting a release — the full sequence

Run on a clean `main`, up to date with origin.

1. **Land the change** in its own commit(s) first (code/docs/assets), CI green.

2. **Bump versions** (graph-aware, per the table above) + `plugin.json` in
   lockstep, refresh the lockfile, and commit as a dedicated release commit:

   ```bash
   # bump each changed package + its dependents (example: a core-only change).
   # NOTE: `exec npm version` — a bare `pnpm --filter … version` is read as a
   # missing "version" SCRIPT and bumps nothing.
   pnpm --filter lastlight-core exec npm version minor --no-git-tag-version
   pnpm --filter lastlight-evals exec npm version patch --no-git-tag-version   # picks up core
   # edit plugins/lastlight/.claude-plugin/plugin.json if the CLI bumped
   pnpm install --lockfile-only
   git add -A
   git commit -m "chore(release): vX.Y.Z"
   ```

3. **Tag + push.** Tags here are **annotated** (the repo's git config rejects
   lightweight tags; `tag.gpgsign` is on, so it is SSH-signed):

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   # If this release bumped agentic-pi, ALSO tag its independent stream so
   # `agentic-pi-npm.yml` publishes it (publish.yml no longer does). Push this
   # tag first / let its run finish before the release npm job packs core+evals:
   git tag -a agentic-pi-vA.B.C -m "agentic-pi-vA.B.C"
   git push origin main --follow-tags
   ```

   `vX.Y.Z` is the **CLI/core** version — it names the GHCR image tag hosts pull.
   `agentic-pi-vA.B.C` is agentic-pi's own version (only push it when agentic-pi
   changed).

4. **Create the GitHub Release** on that tag — this fires `publish.yml`:

   ```bash
   gh release create vX.Y.Z --verify-tag --title "vX.Y.Z — <summary>" \
     --latest --notes "<highlights + compare link vPREV...vX.Y.Z>"
   ```

   `publish.yml` runs `checks` (reuses `ci.yml`) → `images` (`docker buildx bake
   --push core`, then `sandbox-qa` non-fatal) → `npm` (publishes the five
   non-agentic-pi packages in dependency order via OIDC trusted publishing;
   agentic-pi ships separately from `agentic-pi-npm.yml`, step 3's second tag).
   `:latest` moves only for a real, non-prerelease Release.

   The same Release also fires the two Cloudflare site deploys —
   `deploy-www.yml` (→ lastlight.dev, re-rendering `apps/server/spec`) and
   `deploy-evals.yml` (→ evals.lastlight.dev, the SPA + the vendored
   `sample-results/`). Both are now release-gated (not push-to-main); use their
   `workflow_dispatch` button for an out-of-band deploy between releases, and
   note that a release deploy of the evals site resets its `/data` back to the
   sample — re-run the manual `npm run deploy` afterward to restore real
   results.

5. **Watch the release run** (`checks → images → npm`) to green:

   ```bash
   gh run watch <run-id> --exit-status
   ```

6. **Confirm npm published** (the `npm` job did it automatically):

   ```bash
   npm view lastlight@X.Y.Z version --prefer-online   # note: no leading `v`
   npm view lastlight-core@X.Y.Z version --prefer-online
   # …each package you bumped
   ```

   For an annotated tag, `git rev-parse vX.Y.Z` returns the tag object, not the
   commit — use `git rev-parse 'vX.Y.Z^{commit}'` to confirm it points at the
   release commit.

## Rolling a release out to prod

Prod hosts (drizby, nearform) auto-deploy via each overlay repo's "Deploy
overlay" Action on push to `main`. **You do not SSH in or run `npm i -g`
manually** — the Action handles both the CLI and the images:

1. Bump `deploy.version: vX.Y.Z` in **both** overlay repos
   (`cliftonc/lastlight-instance` → drizby, `nearform/lastlight-nearform` →
   nearform) and push. That's the whole rollout.

   The Action's forced-command `ci-deploy.sh` runs a full deploy on any
   `deploy.version` change: it first **pins the host's global CLI** to the tag
   (`npm install -g lastlight@vX.Y.Z`) — because the global CLI is versioned
   separately from the agent image and a stale CLI silently uses the old code
   path — then runs `lastlight server update`, which converges the core checkout
   to the tag and **pulls** the `:vX.Y.Z` GHCR images. CLI + images land together.

2. Verify each host (from the dashboard, or SSH if you want): `lastlight server
   status` (pinned vX.Y.Z, services up), `curl http://127.0.0.1:8644/health`,
   `/admin` loads.

Rollback: re-pin the overlay's `deploy.version` to the previous tag and push —
the Action re-pins the CLI and re-pulls the old images (still in GHCR).

**Manual deploy (only for a hand-run deploy, or a host without the Action):**
update the global CLI *first*, then run the deploy —
`npm i -g lastlight@X.Y.Z && lastlight server update`.

## Cutting the FIRST post-migration release

The first release after the monorepo migration ends the release freeze. It is
the general sequence above with three extras:

1. **Baselines are already set** (Phase 4): pick the first CLI/core version
   strictly greater than the last frozen tag `v0.16.0` (e.g. `v0.17.0`). Bump
   all five packages you're publishing (dependency-aware) + `plugin.json`.
2. **Skip anything already published manually.** Per migration decision 5's
   carve-out, the operator may have already published the fresh scoped names
   (`lastlight-workflow-engine`, `lastlight-shared`) during their phases.
   `pnpm -r publish` skips versions already on npm, so re-running is safe — but
   bump them if they changed since.
3. **CLI-before-deploy is load-bearing here, not hygiene.** The pre-migration
   CLI still on the hosts runs bare `docker compose` with cwd = repo root and
   **cannot drive the `apps/server` layout**. You MUST `npm i -g lastlight@X.Y.Z`
   on each host before bumping the overlay `deploy.version` off its pre-migration
   pin. Then archive the two standalone repos (`nearform/lastlight-www`,
   `nearform/lastlight-evals`) with a README pointer — they now live at
   `apps/www` / `apps/evals`.

After that, the freeze is over and normal releases follow the sequence above.
