# Phase 5 — Import `lastlight-www` into `apps/www`

Risk: **low**. Read [README.md](README.md) and
[00-target-architecture.md](00-target-architecture.md) first — this doc assumes
their locked decisions (git subtree with full history, decision 2; `spec/`
lives at `apps/server/spec`, decision 8; Bundler tsconfig for Astro stays
package-local, §TypeScript strategy).

## Goal

Bring the Astro marketing/docs site (`nearform/lastlight-www` →
`lastlight.dev`) into the monorepo at `apps/www` with its history preserved,
fold its npm lockfile into `pnpm-lock.yaml`, and re-point its spec sync from
the sibling-checkout hack (`../lastlight/spec`) to the in-repo
`apps/server/spec`. Deploys stay **manual** (`deploy` script run locally) until
Phase 7 adds the Cloudflare Action. Nothing about the published site changes.

Facts this phase relies on (verified 2026-07-14 against
`~/work/lastlight-www`):

- `package.json`: name `lastlight-www` v0.0.2, `type: module`,
  `engines.node >= 22.12.0`; scripts `predev`/`prebuild`/`sync-spec` all run
  `node scripts/sync-spec.mjs`; `build` = `astro build && node
  scripts/generate-md.mjs`; `deploy` = `npm run build && wrangler deploy`.
  Deps: `astro ^6.1.3`, `@astrojs/sitemap ^3.7.2`; devDeps include
  `wrangler ^4.95.0`. **No `packageManager` field, npm `package-lock.json`
  present, no `.github/` directory at all.**
- `scripts/sync-spec.mjs` `resolveSource()`: (1) `SPEC_SRC` env var, absolute
  path, warn-and-ignore if missing (lines 24-28); (2) the sibling path
  `resolve(REPO_ROOT, '..', 'lastlight', 'spec')` (line 29); (3) no source →
  `console.warn('[sync-spec] no spec source found; leaving src/content/spec
  as-is')` + `process.exit(0)` (lines 46-49) — the committed copies in
  `src/content/spec/` are the CI safety net. `DEST = join(REPO_ROOT,
  'src/content/spec')` (line 22); nested paths flatten with `__`; `README.md`
  skipped.
- `wrangler.jsonc`: static-assets Worker (`assets.directory: "./dist"`, no
  `main`), route `lastlight.dev` custom domain.

## Preconditions

- Phases 1–4 ticked in [README.md](README.md): pnpm+Turbo skeleton exists,
  core lives at `apps/server` (so `apps/server/spec/` exists), the CLI/shared
  extraction is done. `pnpm turbo run typecheck test build` green on `main`.
- **Clean working tree** — `git subtree add` refuses to run with uncommitted
  changes.
- Push access to read `git@github.com:nearform/lastlight-www.git`.

## Files created / modified

| File | Change |
|---|---|
| `apps/www/**` | **new** — the entire `lastlight-www` repo, imported by subtree merge |
| `apps/www/package-lock.json` | **deleted** — folds into root `pnpm-lock.yaml` |
| `apps/www/package.json` | add `"private": true` (never published to npm) |
| `apps/www/scripts/sync-spec.mjs` | sibling candidate `../lastlight/spec` → `../server/spec` |
| `pnpm-lock.yaml` | gains the `apps/www` importer |

Nothing else. Astro's own `tsconfig.json` (Bundler resolution) is **not**
re-based onto `tsconfig.base.json`; `wrangler` stays a devDep; the committed
fallback copies in `apps/www/src/content/spec/` stay committed.

## Steps

1. **Import with history.** From the repo root, on a clean tree:

   ```bash
   git remote add www-origin git@github.com:nearform/lastlight-www.git
   git fetch www-origin
   git subtree add --prefix=apps/www www-origin main
   ```

   This creates a merge commit joining the full `lastlight-www` history
   (no `--squash`). `git log apps/www` shows the original commits afterwards.
   Do not rebase this merge away.

2. **Fold the lockfile.** Delete `apps/www/package-lock.json` (the
   `pnpm-workspace.yaml` glob `apps/*` already matches the new directory),
   then run `pnpm install` at the root so `pnpm-lock.yaml` gains the
   `apps/www` importer. Commit both together.

3. **Mark it private.** Add `"private": true` to `apps/www/package.json` —
   the site was never published to npm and must be skipped by the manual
   publish flow (`pnpm -r publish` skips private packages).

4. **Re-point the spec source.** In `apps/www/scripts/sync-spec.mjs`, change
   the sibling candidate (line 29 at import time):

   ```js
   // before — sibling checkout of the standalone core repo:
   resolve(REPO_ROOT, '..', 'lastlight', 'spec')
   // after — in-repo core package (REPO_ROOT is now apps/www, so '..' is apps/):
   resolve(REPO_ROOT, '..', 'server', 'spec')
   ```

   **Keep** the `SPEC_SRC` env override (first in the resolution order) and
   the warn-and-keep committed-fallback behaviour (lines 46-49) exactly as
   they are — the fallback is what keeps a checkout without a built sibling
   (or a future partial clone) building.

5. **Confirm the lifecycle hook still fires.** The spec sync runs via the
   `prebuild` script. pnpm runs `pre`/`post` scripts for explicitly invoked
   run-scripts by default in current versions, but verify it:

   ```bash
   pnpm --filter lastlight-www build
   ```

   must print the `[sync-spec]` output before Astro starts. If it does not,
   add `enable-pre-post-scripts=true` to the root `.npmrc` and record it in
   Deviations.

6. **No turbo.json changes needed.** `lastlight-www` exposes a `build` script,
   so `turbo run build` picks it up through the workspace; it has no
   `typecheck`/`test` scripts, so those tasks skip it (fine — `@astrojs/check`
   adoption is backlog, not this migration).

## Verification

```bash
# 1. Workspace integrity
pnpm install                       # lockfile updates cleanly, no peer errors

# 2. The site builds AND the spec sync reads apps/server/spec
rm -rf apps/www/src/content/spec/*.md          # force a fresh sync (git restore after)
pnpm --filter lastlight-www build              # [sync-spec] copies, astro build emits dist/
ls apps/www/dist/index.html
git status apps/www/src/content/spec           # synced files match apps/server/spec content
git restore apps/www/src/content/spec          # if the sync produced no diff, tree is clean anyway

# 3. Fallback still safe: with the spec source hidden, build must still succeed
SPEC_SRC=/nonexistent pnpm --filter lastlight-www build   # warns, uses committed copies

# 4. Repo-wide green
pnpm turbo run typecheck test build
```

Manual deploy stays available exactly as before (from `apps/www`:
`pnpm run deploy`) — do **not** deploy as part of this phase (release freeze,
README locked decision 5, covers releases; a www deploy is content-only and
allowed, but nothing here requires one).

## Rollback

The subtree add is a merge commit plus your follow-up commits on top. To back
out: `git revert -m 1 <subtree-merge-sha>` plus reverts of the follow-ups (or
reset the branch if unpushed). The standalone `nearform/lastlight-www` repo is
untouched until Phase 7 archives it, so the old world keeps working
throughout.

## Out of scope

- The Cloudflare deploy Action (`deploy-www.yml`) — Phase 7.
- Archiving the standalone repo — Phase 7.
- Adopting `tsconfig.base.json`, `@astrojs/check` in CI, or any content work.

## Deviations

None yet.
