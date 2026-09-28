# Unit pr-review — is the survey a hallucination machine?

Status: **screens 1–3 run 2026-09-27, results folded into
[`adjudicate-falsify-replay.md`](adjudicate-falsify-replay.md#is-the-survey-signal-real-three-0-screens)**
— support beats every null model (9 vs ≤ 6.1 gold in the top 5, random 2.9);
votes are echoes but distinct-unit support still ranks (8.7); units' 14 gold
is mostly volume (~10 truly assert). Screen 4 (stability) and 5 (grounding
the generator) not run. Companion to [`unit-survey.md`](unit-survey.md).

## The worry

The unit survey is rapid-fire, non-agentic model calls over deterministic
units. It cannot open files, run install, typecheck or lint. How does it decide
anything is an issue, and is the first half of the pipeline just a poker
machine whose "recall" is volume?

## What a unit call actually sees (verified in code)

- **The unit** — the changed function or module region, read from the head
  commit, plus its import lines (`packages/code-facts/src/units.ts`).
- **CALLERS** — a location and ONE clipped line of the call site
  (`units-render.ts:465-478`).
- **CALLEES** — a name and `declaredAt` only: no body, no signature
  (`units-render.ts:481-485`).
- **Obligations** from `seed` (both ends of a possible defect, unverified).
- **No types, no diagnostics, no test results.** `prepare --typecheck` does
  produce `typecheckDiagnostics` in `env.json` (`prepare.ts:375-414`), but only
  when probes are on, and only probes read it. drizby runs probes OFF.
- The prompt tells the model "you cannot open files… answer `unknown`"
  (`survey-unit.md:16`) and excludes "anything a compiler or linter catches" —
  which it has no way of knowing.

## How it decides something is an issue

Mostly it does not, by design: "Doubt is not a reason to leave a defect out"
(`survey-unit.md:23`). Measured over the 16 v7 fixtures: **1,794 rows → 14
gold, ~0.8% row precision**, 20–33 derived Criticals per case. That is a
hypothesis generator, and it is only acceptable if a grounded step disposes of
the hypotheses afterwards.

## Verdict

**As a candidate generator it is defensible.** Generate broadly, then verify
grounded, is the shape every high-precision system uses, and recall cannot be
recovered after generation — the agent survey asserted 3 gold where this
asserts 14.

**As a source of signal it is, today, close to a poker machine**, for three
reasons:

1. **Recall is bought with volume.** 100–230 claims per PR hit gold by
   coverage, and a judge matching gold against a pool that size favours
   whoever throws more darts. 14 vs 3 is not volume-matched, n is tiny (25
   gold × 2 arms), and this pipeline's run variance is already known to be
   large (wp3 recall 0.320 → 0.080 across identical runs).
2. **The "support vote" may not be independent.** Cursor Bugbot's votes are 8
   shuffled independent passes. Ours are one model re-reading the same lines:
   a unit over 40 changed lines splits into up to six family siblings, and
   overlapping units repeat lines. So site support may measure "a big changed
   function" — which `adjudicate-falsify-replay.md` already concedes ("support
   rewards big functions").
3. **Nothing grounded disposes yet.** The only step that sees real code with
   tools is `falsify`, capped at `maxProbes: 8` and off in prod. Without it
   the pipeline is text generation judged by text, and our own record says
   that does not separate: stated confidence AUROC 0.228, keep-all beats every
   blind adjudicator.

The missing tooling feedback is real but secondary, and fixable with
deterministic inputs rather than a smarter model.

## Proposed screens ($0 first, per the eval spend gate)

1. **Null-model ranking — the key test ($0).** Add `--order` modes to
   `apps/evals/scripts/cluster-screen.ts` that use NO model output: sites
   ranked by changed-line density, by caller count, by untouched-caller count.
   Same 16 fixtures, same gold map, ±20. If a deterministic order also puts
   ~9/14 gold in the top 5, the survey adds recall but no ranking signal.
2. **Volume-matched comparison ($0).** Gold per row, and gold at matched top-N
   rows, units vs the agent survey. Hand-read the 14 gold→row matches in the
   cached gold map (`eval-results/phase-replay/.gold-cache/`): does each row
   assert the defect, or merely sit near it?
3. **Independence check ($0).** Recompute support with a split unit's family
   siblings (`splitOf`) collapsed into ONE voter, so only distinct units vote.
   If gold falls out of the top 5, the vote was an echo.
4. **Stability (replay tier, Haiku, cache bypassed).** Re-ask the same units
   twice: Jaccard of the site sets, and whether gold sites persist.
5. **Ground the generator (only if 1–4 hold up).** Callee signatures and types
   from tsgo (already loaded by `facts`); the tsc diagnostics this PR
   *introduced* (a base→head delta) given as facts, not guessed; then drop the
   "compiler catches" exclusion from the prompt.

## Files involved

- `apps/evals/scripts/cluster-screen.ts` (new orders),
  `packages/code-facts/src/site-cluster.ts` (voter key)
- Later: `packages/code-facts/src/units.ts` / `units-render.ts` (callee
  signatures, diagnostics block), `prepare.ts` (diagnostic delta)

## How to verify

- From the evals workspace:
  `npx tsx <monorepo>/apps/evals/scripts/cluster-screen.ts --order <mode> --windows 20`,
  compared against support-first's 9 / 12 / 12 gold in the top 5 / 10 / 20.
- `pnpm --filter lastlight-code-facts test` for any clustering change.
