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
pnpm --filter @lastlight/evals-dashboard test       # vitest run (node env)
```

See [`apps/evals/CLAUDE.md`](../CLAUDE.md) for the harness, the release dance, and
how results are generated + deployed.

## Import the harness's arithmetic — do not mirror it

`src/types.ts` and `src/lib/summarize.ts` used to be hand-kept copies of the
harness's `src/schema.ts` / `src/report.ts`. The copy drifted silently: it omitted
`micro`, `boundaries` and `families`, so the dashboard fetched a scorecard
carrying micro-recall and threw it away, and showed the per-case F-beta mean as
the `pr-review` headline while every planning document reasoned in micro-recall.
Nothing failed; the UI just reported a different quantity from the one under
discussion.

So:

- **Result-shaped types are imported**, not re-declared —
  `import type { InstanceResult } from "../../src/schema.js"`. That module is
  types-only at runtime, so Vite erases it.
- **Metric arithmetic is imported** from `../../src/review-metrics.ts`, which is
  pure and has no Node APIs. `summarizeModels` in `src/lib/summarize.ts` remains a
  mirror **only** because the harness's copy lives in `src/report.ts`, which reads
  the filesystem — and `src/lib/summarize.test.ts` runs the harness function in
  Node and asserts field-for-field agreement, so the remaining copy cannot drift
  unnoticed.
- `tsconfig.json` therefore has `"node"` in `types` (the harness type graph
  reaches `node:fs`). Node globals consequently type-check in this browser app;
  don't use them.

## Testing

`vitest.config.ts`, `environment: "node"` — everything worth testing here is pure
logic, and the highest-value test has to import the harness's Node-side
`report.ts`. Only reach for jsdom if you actually render components (`prismjs`,
pulled in by the diff viewer, needs a DOM at import time).

`src/__fixtures__/repeat-group.json` is the real three-run repeat group
(`2026-08-22_{184650,194234,201607}`) reduced to the per-gold judge verdicts. Its
published band — 0.320 / 0.080 / 0.200, union 0.440, intersection 0.040 — is
asserted in `src/lib/repeats.test.ts`.
