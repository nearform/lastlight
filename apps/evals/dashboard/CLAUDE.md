# @lastlight/evals-dashboard

The results explorer for the eval harness → **evals.lastlight.dev**. Private
(`@lastlight/evals-dashboard`), a **React + Vite + Tailwind** SPA.

It renders the eval-run artifacts produced by `lastlight-evals` (model comparisons,
per-tier scores, transcripts). The live site is deployed via the evals package's
Cloudflare `deploy` flow (**not** gh-pages, which is stale) and bakes in local
`eval-results/` at build time.

## Commands

```bash
pnpm --filter @lastlight/evals-dashboard dev        # vite dev server
pnpm --filter @lastlight/evals-dashboard build      # vite build → dist/
pnpm --filter @lastlight/evals-dashboard typecheck  # tsc --noEmit
```

See [`apps/evals/CLAUDE.md`](../CLAUDE.md) for the harness, the release dance, and
how results are generated + deployed.
