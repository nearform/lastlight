# lastlight-www

The public marketing + docs site → **lastlight.dev**. Private
(`lastlight-www`), an **Astro** app deployed to **Cloudflare** (`wrangler.jsonc`,
`.github/workflows/deploy-www.yml`).

## Structure (`src/`)

```
pages/          Astro routes: index, how-it-works, comparisons, faq, run-it,
                llms.txt.ts, plus docs/ and spec/ and evals/ sections.
content/        Content collections (see content.config.ts).
components/     Astro/UI components.
layouts/        Page layouts.
data/           Static data feeding the pages.
scripts/        Build helpers — sync-spec.mjs pulls the rebuild spec in;
                generate-md.mjs emits Markdown mirrors.
```

## Spec sync — important

The `docs/` and `spec/` content is **generated from `apps/server/spec/`** by
`scripts/sync-spec.mjs`, which runs automatically via the `prepare` / `predev` /
`prebuild` npm hooks. Don't hand-edit the synced pages — edit the source spec and
let the sync run. Keeping the site aligned with the code is the job of the
[`docs-sync`](../../.claude/skills/docs-sync/SKILL.md) skill.

## Commands

```bash
pnpm --filter lastlight-www dev        # astro dev (runs sync-spec first)
pnpm --filter lastlight-www build      # astro build + generate-md
pnpm --filter lastlight-www deploy     # build + wrangler deploy (Cloudflare)
```
