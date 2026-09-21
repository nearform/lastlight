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

## The runs table is grouped by ARM, not by model column

`src/lib/runGroups.ts` turns `/api/index` runs into the overview's table rows.
Two rules it exists to enforce:

- **A model is not a column.** The table used to grow one column per model id
  seen anywhere in the folder, so most cells were `—` and the *same* model
  appeared twice — `Claude Haiku 4.5` (the `models.json` label) and the raw
  `anthropic/claude-haiku-4-5-20251001` the runs were actually launched against.
  `modelDisplay`/`modelKey` (`src/lib/format.ts`) collapse a pinned snapshot id
  onto its registry label and keep the full id in a `title`. The arm — overlay
  basename + model — is one cell of the run's own row.
- **A repeat band is one row.** Runs fold on `meta.repeat.group`; each repeat is
  a chip, and the mean ± band appears only once `of` repeats have landed (an
  in-flight band shows its landed chips plus an `n of m` spinner). `band` is
  `max − min`, the same definition as the harness's `VarianceRollup.band`.
  Nothing is grouped heuristically — the stamp is the only evidence, and
  guessing would fold a baseline in with the candidates it is the control for
  (the preserved 2026-08-22 runs carry no `repeat`/`overlay` meta at all and
  must stay ungrouped single rows).

`IndexRun` carries `models` / `overlay` / `repeat` for this, straight off
`meta` in the harness's `buildIndex` (`../src/report.ts`) — so the live `serve`
index and the baked static manifest (`../scripts/build-site.ts`) are the same
shape and the same component renders both.

## The funnel drill-down reads the pipeline's own artifacts

`src/lib/pipelineArtifacts.ts` + `src/components/FamilyDrilldown.tsx` turn each
row of the per-family funnel into the evidence behind it — the obligations, the
hypotheses, and what became of each. It is the **first UI to read
`results[].pipelineArtifactRel`**, which only exists because
`persistPipelineArtifacts()` now copies `.lastlight/pr-review/` into the run
directory unconditionally; before that the evidence lived in a `$TMPDIR`
workspace the OS reaped (216 of 237 recorded paths resolved, not one still held
a file). `src/serve.ts` already serves the run dir at `/data/*`, so there is no
new endpoint — the four documents are fetched lazily on open, via TanStack
Query, keyed on the artifact dir.

Three rules are mirrored from the harness's reader
(`../../src/review-pipeline-stats.ts`, which cannot be imported here — it opens
with `node:fs`) and pinned in `src/lib/pipelineArtifacts.test.ts`, because
getting any of them wrong renders a confident wrong answer rather than failing:

- **Hypothesis identity is POSITIONAL** — `<family>-NNN` from the FILENAME plus
  append order. The model-declared `id` is an alias at best; a torn line
  consumes no ordinal, a scalar line does.
- **The findings ↔ disposition join is `path + title`, never `line`** (the
  boundary re-anchors lines; keying on the line lost 10 of 32 findings).
- **Absent ≠ zero**, in four places the UI renders distinctly: a run with no
  artifacts ("artifacts not retained"), a missing `hypotheses/<family>.jsonl`
  (the survey never ran) vs an empty one, a missing `findings.json` (nothing is
  known about what became of the rows — *not* a conservation failure), and
  `notMeasured` vs 0. `spec` declares `measured: false` meaning "cannot COUNT"
  while its survey runs, so it is **not** marked notMeasured; `tests` declares
  it and writes only the tombstone, so it is.

One thing the artifacts cannot answer: `obligations.json`'s `dropped[]` is
`{reason, count}` with no ids, no text and no family field, so a dropped
obligation's *question* is nowhere on disk. The per-family dropped count is
`minted − obligations` (`families[]`), and the panel says so rather than
implying the questions are recoverable.

## Testing

`vitest.config.ts`, `environment: "node"` — everything worth testing here is pure
logic, and the highest-value test has to import the harness's Node-side
`report.ts`. Only reach for jsdom if you actually render components (`prismjs`,
pulled in by the diff viewer, needs a DOM at import time).

`src/__fixtures__/repeat-group.json` is the real three-run repeat group
(`2026-08-22_{184650,194234,201607}`) reduced to the per-gold judge verdicts. Its
published band — 0.320 / 0.080 / 0.200, union 0.440, intersection 0.040 — is
asserted in `src/lib/repeats.test.ts`.
