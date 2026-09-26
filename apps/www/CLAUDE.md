# lastlight-www

The public marketing + docs site → **lastlight.dev**. Private
(`lastlight-www`), an **Astro** app deployed to **Cloudflare** (`wrangler.jsonc`,
`.github/workflows/deploy-www.yml`).

## Structure (`src/`)

```
pages/          Astro routes: index, comparisons, faq, run-it, releases,
                llms.txt.ts, plus docs/ and spec/ and evals/ sections.
content/        Content collections (see content.config.ts).
components/     Astro/UI components.
layouts/        Page layouts.
data/           Static data feeding the pages.
scripts/        Build helpers — sync-spec.mjs pulls the rebuild spec in;
                sync-releases.mjs pulls the GitHub Releases in;
                generate-md.mjs emits Markdown mirrors.
```

## Spec sync — important

The `/spec/` pages are **generated from `apps/server/spec/`**:
`scripts/sync-spec.mjs` copies it into `src/content/spec/` (gitignored) via the
`prepare` / `predev` / `prebuild` npm hooks. Don't hand-edit the synced files —
edit the source spec and let the sync run. The `/docs/` pages under
`src/pages/docs/` are **hand-written** `.astro` files (sidebar in
`src/data/docs-nav.ts`), so they drift unless updated with the code. Keeping
both aligned with the code is the job of the
[`docs-sync`](../../.claude/skills/docs-sync/SKILL.md) skill.

## Releases sync

`/releases` is the changelog, rendered from the **GitHub Release bodies** —
there is no CHANGELOG file. `scripts/sync-releases.mjs` fetches every non-draft
`v*` release into `src/content/releases/` (gitignored), linking bare `#123`
refs, on `predev` / `prebuild` (never `prepare`, so installs stay offline). A
failed fetch warns and keeps the existing files; `RELEASES_REQUIRED=1` (set by
`deploy-www.yml`, which also passes `GITHUB_TOKEN`) makes it fatal so a deploy
can't ship an empty changelog. Since `deploy-www.yml` fires on every published
Release, the page updates itself — to fix an entry, edit the Release on GitHub
and redeploy.

## Commands

```bash
pnpm --filter lastlight-www dev        # astro dev (runs sync-spec first)
pnpm --filter lastlight-www build      # astro build + generate-md
pnpm --filter lastlight-www deploy     # build + wrangler deploy (Cloudflare)
```
