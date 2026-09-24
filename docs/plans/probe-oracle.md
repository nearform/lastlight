# The probe oracle — state, and what to run next

Written 2026-09-21 to be picked up cold. Sibling docs: [`deterministic-pr-levers.md`](deterministic-pr-levers.md) (the pipeline's design record) and `~/work/nearform-evals/research-notes.md` (the rung-by-rung journal, incl. rungs 0–4 from this pass).

Branch `evals/persist-pipeline-artifacts`, ~28 commits, **nothing pushed**. Gate green (26/26).

## What shipped

| | |
|---|---|
| `7f7562e2` | Deleted `internalFloor` + the six per-family thresholds. They gated on `confidence`, measured **AUROC 0.228** (inverted) over 516 findings, and `say-gap` showed **zero** gold ever lost to any boundary filter. Non-breaking: `loadConfig` has no unknown-key rejection, so stale overlay pins are simply unread (a `log.warn` now names them). |
| `0c82debf` | `review.analysis.probes` is tri-state `off \| static \| full`. **`static` runs the oracle with `--no-install`**; a bare `true` coerces to `static`, so no deployment gains an install by upgrading. Default stays `off`. |
| `1248acdc` | **The execution gate.** A `reproduced`/`refuted` verdict must name a command that the transcript's first line records. `unprobed` stays free (an unsatisfiable gate breeds dishonesty). Plus `models.review-falsify` with an explicit `{{#if}}` fall-through. |
| `4a66b087` | Warn (and name the findings) when a finding's `existingCode` matches nothing in the file it cites. |
| `5140c2ec`, `d63d9db2` | Dashboard: session lanes named from the phase stamp; the per-family funnel drills into obligations → hypotheses → dispositions. |
| new scripts | `say-gap`, `anchor-forensics`, `deletion-risk`, `facts-obligations` — all $0, all read-only. `audit-internal-pairs` now speaks all three artifact layouts and has `--dry-run`. |

## What the two 8-case arms established

`2026-09-21_130604` (probes `static`, Sonnet oracle) vs `2026-09-21_151448` (probes off). Same binaries, one key apart. **7 shared cases / 20 gold** — arm 2's `1667` died on a connection error and is excluded; scoring it as zero is how the first (wrong) read of this pair was produced.

```
micro-recall  0.400 → 0.450   +3/−2 paired, McNemar p=0.500 one-sided — INDISTINGUISHABLE
SNR           0.471 → 0.818   posted 25→20, matched 8→9
precision     0.303 → 0.629 (per-case mean)
canary 1641   4 false positives → 0
cost          $23.83 → $31.77 (+33%)
```

**Precision improved and recall did not pay for it** — the first time in this campaign, after five reproductions of the opposite. That is the shape the no-compile oracle literature predicts (Tencent 94–98% FP elimination, arXiv:2601.18844; LLM4PFA 72–96% losing 3 of 45 TPs, arXiv:2506.10322).

Mechanism findings, which are the trustworthy half:

- **The oracle's model is the binding constraint.** On five hypotheses probed by both, Haiku returned `reproduced` via `git show | grep` on all five and was wrong — it confirmed the constants were duplicated without testing whether their values diverged. Sonnet executed `node` probes, found them identical, and refuted all five. Tier 4 vs tier 2 of the ladder.
- **First legitimate deletions in the project's history.** 13 across 8 cases, **13/13 transcript-backed**, the conservation floor correctly leaving them standing. Paired worst case: **1 gold** loss attributable to a deletion, and that is co-location, not causation.
- **Neither model used tier 1** — `differential: false` on every verdict in both arms. Nobody ran the same input against base and head, the form a PR uniquely affords.

## The blocker on every per-gold number — audited 2026-09-21, and worse than it looked

`audit-internal-pairs.ts` over both arms, all seven gold-bearing cases, 14 MATCH calls, **$0.15**, every credited pair then hand-adjudicated against the full gold and finding text. The audit reproduces the production judge exactly — both arms ran `judgeWithDiff: false` and `anthropic/claude-sonnet-4-6`, which is what the script invokes. Journal: `~/work/nearform-evals/research-notes.md` §"Rung 5".

**11 of 30 credited pairs are wrong, 3 more arguable.** Corrected internal recall over all 25 gold: `static` 0.56 → **0.28**, off 0.64 → **0.36**. Over the six shared cases the reported numbers tie at 11/20 and the adjudicated numbers tie at 6/20 — the correction halves both arms and reorders nothing, so the probes arm's case still rests on precision and nothing internal argues against it.

Two distinct defects, roughly even:

- **Wrong-subject (6/11)** — the transposition. `1667` gold #3 was credited the finding that is gold #4's claim; gold #4 then reads MISS. Marginals unchanged, both rows wrong.
- **Polarity (5/11)** — a *verification report* credited to the gold it refutes. `1587-r3` gold #0 ("nothing flips the app into a logged-in state") got *"Login state … is correctly driven by the JWT cookie"*. `INTERNAL_MATCH_SYSTEM` (`apps/evals/src/grade.ts:435`) already forbids precisely this, in its own constant, added for precisely this reason on 2026-08-24. **That clause is measured-insufficient** — this is its first audit and it fails a third of the time on the population it was written for.

**The sharpest cut is by tier of the credited finding:** posted (`inline`/`body`) credits are 15/20 sound; **`internal` (withheld) credits are 1 of 10.** That withheld half is the whole reason internal recall exists as a separate instrument, and the "found it but didn't say it" headroom it reports is, on this pair, **one finding** (`1667` gold #4).

Consequences: `deletion-risk --vs` stays unreadable and its "2 gold lost to a deletion" headline is now positively withdrawn — both credits it rested on are wrong. `varianceRollup`'s unions and `pairedBand` index the same per-gold vector and inherit the same ⅓ error. Posted recall uses a *different* judge, with an EXTRACT stage that filters praise before MATCH sees it, and audits sound here; no published posted number moves.

### Fixed the same day — a CONFIRM pass, validated 30/30

MATCH ranks candidates and must choose *something* for every gold it can reach; CONFIRM is asked one closed question about one pair and may answer no to all of them. That difference, not another clause, is the fix. `gradeInternalRecall` now runs MATCH, then a second call over only the pairs MATCH credited (`INTERNAL_CONFIRM_SYSTEM`, `apps/evals/src/grade.ts`) — ~$0.02 a case instead of ~$0.01, and `--no-confirm` on the audit script reproduces the old grader exactly.

Additive on purpose, not an edit to `INTERNAL_MATCH_SYSTEM`: that prompt is pinned by every back-filled run, and `internalGold` stores MATCH's reply verbatim, so the archive can be re-judged without re-running MATCH. A run now records `internalMatchedPreConfirm` (its presence is the marker that `internalMatched` is confirm-filtered; absent on everything before 2026-09-21), `internalConfirmRejected` (the dropped pairs — a correction nobody can review is its own bad instrument) and `internalConfirmUngraded` (CONFIRM failed ⇒ the count is raw MATCH and says so).

**Validated by re-running the audit with it on and scoring its 30 decisions against the hand adjudication: 30/30 agree.** It also corrected one of mine — `1680-r2` gold #1 is an `AGENTS.md` paragraph about the shared `NodeCache` key space, and the finding credited to it is "the PR description says 120s, the code says 600s"; I had passed that, CONFIRM rejected it on both arms.

```
internal recall, all 25 gold      reported   adjudicated   CONFIRM
probes static                     0.56       0.28          0.24 (6/25)
probes off                        0.64       0.36          0.28 (7/25)
six shared cases (20 gold)        0.55/0.55  0.30/0.30     0.25/0.25
```

**The one judgement call — a dismissal counts as a find.** The first prompt rejected `1667` gold #1, where the pipeline generated the gold's exact mechanism (*"a caller who sends `{"dryRun": 0}` gets a 400 before they see a 401"*) and then dismissed it on impact. Rejecting that folds a **triage** failure back into the **discovery ceiling**, which is the collapse internal recall exists to undo. So: a finding that states the same thing is wrong and argues it is low-impact, out of scope, pre-existing or already mitigated **is** a match; one that asserts the code is correct, or never states the defect, is not. It is also the sharpest surviving instance of found-but-withheld, and the sharpest argument for #399's typed-attribute work — the adjudicator had the defect and argued itself out of it in prose.

**Caveat CONFIRM does not fix: MATCH is not stable run to run.** Between two audit passes over identical artifacts at temperature 0, the credited pairs differed on four of fourteen targets. CONFIRM rejected the wrong pair in every version, so corrected numbers are stable where raw ones are not — but a per-gold vector from one MATCH call is a draw, not a measurement.

## Next evals, cheapest first

1. ~~**The judge audit** (~$0.20)~~ — **done, $0.15**; see the section above. It gates per-gold numbers, and it now also gates #399's guardrail.
2. **Repeats on the pair** (~$110 for 2×2). Today's arms are n=1; historical bands ran 0.04–0.14 and one arm swung 0.320→0.080 across identical runs. Nothing here can order arms until this exists.
3. **An INSTALL oracle arm — `probes: full`, done cheaply.** The open question: Sonnet reached tier 2 with no dependencies; what does it reach with them? Only an install makes `tsc`, `eslint`, the framework's own runner and a single test file available, and those are the probes that settle the claims a grep cannot.
   - **Confound to design around:** `prepare` runs *before* `facts`, so an install also moves DISCOVERY — measured, tier-1 cases 21→5 and contract deltas 73→19 without it (`packages/code-facts/src/prepare.ts:29-35`). A `full` arm therefore changes two things at once. Either accept it and say so, or add a mode that installs for probes only (after `facts`), which is a workflow reordering, not a new capability.
   - **Making it fast, which is the whole objection.** `--ignore-scripts` is already the default and is most of the CPU and all of the arbitrary-code risk. Beyond that: a **warm shared package store** (pnpm's content-addressable store hardlinks, so 8 cases pay the download once — the `lastlight_pkg-cache` docker volume already exists for this), `--prefer-offline`, and the fact that warm workspaces already keep `node_modules` across reviews (`git clean -fdx -e node_modules`), so only the first review of a repo pays.
   - **The genuinely shallow option, untried:** let the oracle install *only what a probe needs* — `npm i --no-save eslint` when it wants to run eslint — rather than the whole tree. Smallest possible install per probe, no tree-wide cost, and it fits the existing ladder as a new tier between 2 and 3. Needs a CLI affordance and a disk/time budget; **there is no disk guard anywhere today** and warm `node_modules` persists.
4. **A differential arm.** Tier 1 is unused by both models. The prompt already prefers it and `origin/<base>` is already fetched. Possibly just a prompt/ladder emphasis change, so cheap to try.

## Build queue — #399 is BUILT (2026-09-21) and MEASURED (2026-09-22)

Both halves landed behind one config key, `review.analysis.adjudicate: legacy | dossier`, default `legacy` so no deployment moves before the arm runs.

- **Input** — a deterministic `dossier` phase (`lastlight-facts dossier`, `packages/code-facts/src/adjudicate-render.ts`) joins every hypothesis, probe verdict + transcript, the conservation ledger and the review pass's findings, with **every quote already resolved against the tree**. Delivered as prompt bytes via `{{phaseOutputs.dossier}}`, never as a path.
- **Output** — the adjudicator writes `claim` / `category` / `fix`; a pure `computeTier()` (`review-poster.ts`) derives the tier. No `tier`, no `confidence`. A derived withholding records `reason: "computed"` in `disposition.json`.
- **Instrument** — `apps/evals/scripts/phase-turns.ts`, `$0`. The issue said bash calls and turns were "already recorded per phase"; they are not, so the baseline was read by hand once and now is not. **Pre-#399: 137 bash calls / 141 turns across 8 adjudications, mean 17.1 bash, stress case 30.**
- **Arm** — `overlays/wp3-minimal-d2ab-probes-sonnet-dossier`, one key off `2026-09-21_130604-a312c19`.

Two things the wiring got wrong first, both now pinned by tests, and both silent failures rather than loud ones:

- **`all_success` does not tolerate a skipped dependency.** `skip_if` sets `skipped`; `evaluateTriggerRule` wants `succeeded`. `adjudicate` depending on a skipped `dossier` under the default rule would have skipped the **adjudicator** on every deployment left on `legacy` — the whole pipeline going quiet with nothing failing. It is `none_failed_min_one_success`, which still refuses a failed review.
- **A command phase's stdout is a plain string.** `{{phaseOutputs.dossier.output}}` — the spelling the engine schema's own doc comment suggests — walks off the end of a string and renders empty, delivering the "everything you need is attached below" preamble with nothing attached.

Still to do on it: idea 2 (a System-1 classifier over the dossier, on the category axis only) and idea 3's turn cap, both of which wanted the dossier to exist first.

### The arm, run clean at `--concurrency 1`: `2026-09-22_023026-2057708` vs `2026-09-21_130604-a312c19`

Two false starts before the real run. (1) The first attempt used the **globally-installed** `lastlight-evals` (npm `0.10.0`/core `0.26.0`, a month stale) — it has no idea `review.analysis.adjudicate` exists, so it silently fell back to the vanilla two-phase `review`/`post-review` workflow (`phases: [review, post-review]` only, no facts/hypotheses/probes at all) and "finished" in under an hour with avgRecall 0.21 and a broken dashboard (that build's stale bundled `dashboard/dist`). **Moved to `.stale-cli-runs/`, not a real data point.** Always invoke the monorepo's own `apps/evals/src/run.ts` via `npx tsx` when measuring anything built on this branch — the installed CLI tracks published releases, not working-tree code. (2) The retry crashed at 6/8 (dead process, no error) — restarted clean.

**Mechanism (#399's actual target) confirmed on the full 8/8, concurrency-insensitive:** `adjudicate` phase mean per case — bash calls **17.1 → 4.0**, turns **17.6 → 8.3**, cost **$0.93 → $0.77**. `phase-turns.ts` output archived; the dossier does what it was built to do.

**Internal recall (the CONFIRM-corrected instrument) is a tie.** The comparator predates the CONFIRM pass, so its scorecard shows raw MATCH (14/25 = 0.56) — but this doc's own audit of that *exact* run already hand-corrected it to 6/25 = 0.24 (see the CONFIRM table above). The new dossier run natively records CONFIRM and lands at the same 6/25 = 0.24. Same six confirmed finds, both arms — the rewrite cost no discovery.

**Posted recall/precision both dropped:** micro-recall 0.48→0.36, precision 0.52→0.35, SNR 1.09→0.53 (full 25 gold, posted judge — the *other* judge-sound instrument, per the audit above). Same six confirmed internal finds, fewer reaching a posted comment the judge credits. **Not attributable to the dossier change on n=1** — survey/seed are stochastic per run and the repeat-variance section below already measured swings of this size on an unchanged config. Needs the repeats (next item) to separate signal from noise.

**Cost/duration are confounded the other way.** The comparator ran at concurrency 3, this arm at concurrency 1 — and the "Traps" section already established that concurrency 3 alone inflates per-case duration via contention (613s → 2731s on an identical case/phase). This arm reading faster per-case than the comparator is consistent with that contention effect, not evidence of a dossier speedup. No clean duration read exists yet between the two shapes.

### The falsify-loop bug, found and fixed the same day

A second, unrelated bug surfaced while watching this arm run: the `falsify` loop nearly always burned its full `max_iterations: 2`. `packages/code-facts/src/probes.ts`'s gate required a `reproduced`/`refuted` verdict's transcript to open with a line that *contains* the verdict's whole `command` string. `review-falsify.md` told the model to record a **differential** probe (base vs. head — tier 1, previously unused, now apparently common) as one `command` string labelled `BASE: … HEAD: …`, but the model runs the two invocations as two separate bash calls, so the transcript's actual first line only ever had the `BASE` half — the gate then read the verdict as unexecuted and failed the phase's `until_bash` check, forcing a second full iteration on nearly every case with a differential probe in it. Confirmed on `1587-r1`/`spec-004` in the arm's preserved workspace.

**Fixed.** `checkProbes` now splits a `"BASE: … HEAD: …"` command into its two halves and checks each against wherever it actually landed — `BASE` still has to open the transcript, `HEAD` only has to appear in it — rather than demanding both, concatenated, on line one. Falls through to the old exact-match behaviour for a non-differential command or a differential probe that genuinely ran as one invocation. `review-falsify.md` updated to describe the real two-line shape instead of implying both belong on one line. Six new cases in `probes.test.ts` (30/30 passing); `code-facts`'s full suite (712 tests) and `tsc --noEmit` both clean.

**Validated against the arm's own preserved workspaces**, re-running the rebuilt gate over every one of the 8 cases' final `verdicts.jsonl`/transcripts: every differential probe that previously needed the second iteration now satisfies the gate on the first (`1641-r2` 2/2 iterations → would be 1; `1641`, `1587-r2`, `1587-r3`, `1667` all clean). One hypothesis (`1587-r1`/`spec-004`) still correctly fails — a *different* defect, the model's `command` field paraphrased the grep pattern it actually ran rather than copying it verbatim, which the gate is supposed to catch. Not touched; loosening further would re-admit the "code inspection" problem the gate exists to prevent.

### The dossier itself is the cost, not the static prompt — and a fifth of it is provably discardable

Asked separately: the 545-line `review-adjudicate.md` template is not where the money is. Across the same 8 preserved dossiers: **390,453 bytes total**, of which quote/anchor blocks already known `NOT FOUND` in the tree — `locateExcerpt` has already determined the excerpt matches nothing, so it cannot anchor an inline comment either way — are **78,889 bytes, 20.2% of every byte in every dossier**, at a mean size 3x a verified block's (426 vs 146 bytes) because a stale guessed excerpt tends to be a bigger guess than a confirmed one-liner. `renderEntry` (`adjudicate-render.ts`) fences the full wrong text anyway. Not yet changed — the fix (render a short preview instead of the full wrong excerpt when `excerpt.kind !== "resolved"`) is straightforward and low-risk, but landing it means re-measuring the arm again, and item 2 below is the more interesting thing to spend that re-measurement on.

### Idea 2, screened: a System-1 call per hypothesis, fed the dossier's evidence

#399 explicitly left `jev-with-evidence` un-ruled-out: blind *correctness* adjudication over 2,145 labelled AACR comments is measured-dead (keep-all F1 0.825 beats Haiku 0.803 / GLM 0.745 / **Jev 0.789**, AUC 0.534), but the same Jev probabilities asked the *category* axis instead hit **AUC 0.897** — on bare comments, with none of this pipeline's own evidence attached. Idea 1 (the dossier) had to land first so a per-row classifier wasn't fed by thirty shell calls; it now has.

**Built and run for real, not simulated.** `lastlight-facts dossier` gained a `--json` mode (`buildEntries`, already what the Markdown renderer used internally, now exported) so a consumer reads the same structured per-hypothesis rows Sonnet's dossier does without a second `.jsonl` parser. `apps/evals/scripts/jev-hypothesis-probe.ts` sends **one TypeSafe `systemOne` call per hypothesis** — not per finding: 260 hypotheses vs. a few dozen posted findings across this arm, and per-hypothesis is the volume a System-1 primitive is for — with a `choice` question over the same five categories `review-adjudicate.md` uses (`defect` / `correctness-risk` / `maintainability` / `nit` / `verification`), fed the dossier's evidence (claim, both mechanism ends, probe verdict/command/transcript) minus the falsify pass's own reasoning and `confidence` — same two exclusions the dossier itself makes — plus one more: a mismatched anchor/quote is reported as a status line, never the full wrong excerpt (the previous section's finding, applied here first because jev's own accuracy is measured to fall as unrelated text grows around the decision).

**Result, across the 8-case arm (260 hypotheses, 250 with a Sonnet category to compare against): 209/250 = 83.6% agreement with Sonnet's own category call, on the identical evidence. Cost: $0.0053.**

```
jev's distribution:  verification 201 · correctness-risk 27 · maintainability 22 · defect 5 · nit 5
confusion (rows Sonnet, cols jev), the two rarest/hardest classes:
  correctness-risk →  defect 3 · correctness-risk 4 · maintainability 1 · verification 2   (4/10 = 40%)
  defect           →  defect 1 · correctness-risk 1 · verification 1                        (1/3 = 33%)
```

Two caveats, both load-bearing:

- **This is agreement with Sonnet, not accuracy against gold.** High agreement says jev could plausibly pre-tier what Sonnet currently reads one row at a time; it says nothing about whether Sonnet's own call was right — the audit earlier in this doc already found Sonnet's own dispositions wrong often enough to matter. Comparing against gold is the follow-on, not done here.
- **The aggregate hides the failure shape.** Agreement is strongest on the class that dominates the distribution (`verification`, 187/217 = 86%) and weakest on the two rarest, highest-stakes classes (`correctness-risk` 40%, `defect` 33% recall against Sonnet) — exactly where a wrong pre-tier costs the most. One disagreement (`1680-r2`/`spec-001`, the "PR says 120s, code uses 600s" claim already flagged elsewhere in this doc as a CONFIRM-rejected credit) has Sonnet saying `correctness-risk` and jev saying `defect`, and neither is obviously the right label for what is really a stale-PR-description nit — a reminder that 83.6% agreement between two models is not 83.6% correctness.

Not wired into the pipeline. Next, cheapest first: repeat the probe over the same artifacts to see if jev's own call is stable (untested — everything this doc has learned about run-to-run variance so far is about the *big* multi-phase pipeline, not a single System-1 call); then score a sample against gold rather than against Sonnet; only then consider using it as a pre-tier gate ahead of `adjudicate` (skip the big-model turn entirely on a high-confidence `verification` row) or as a second opinion recorded beside Sonnet's own call.

## The gold ceiling — how much of the 25 is reachable at all (2026-09-22, $0)

Nobody had established what fraction of the 25 gold a diff-reading pipeline could find *in principle*, so every ratio in this document has been quoting a denominator nobody checked. Hand-classified all 25 against the preserved diffs of run `2026-09-22_023026` (the `dossier` arm, the last complete 8-case run), then tested the classification against what that run actually matched.

**First, a mechanical fact that kills the obvious hypothesis.** 24 of the 25 gold sit *literally inside a changed hunk* — same file, line within an `@@` range — and the 25th (`1680-r1` #4, "no test covers the new `finally` purge") carries no file at all because it is an absence. So nothing is missed for want of *locating* it. Reachability here is never about where the defect is; it is about whether the defect can be **judged** from what the pipeline can see.

Four buckets, by what a reader needs beyond the diff:

| bucket | what it needs | n | ever found? |
|---|---|---|---|
| **A. in-tree** | the diff + the head checkout, nothing else | **19** | all 9 matches are here |
| **B. dependencies on disk** | `node_modules` source, or a real runner to execute | 3 | never |
| **C. public external knowledge** | third-party API / release semantics absent from the repo | 1 | never |
| **D. non-repo facts** | live production state, or org process | 2 | never |

**B** is `1587-r3` #1 (the proof is react-cookie 8.0.1 / universal-cookie internals), `1641-r2` #1 (ESLint 10 freezes the rule context — the Proxy-invariant `TypeError`), and `1667` #3 (the Slack SDK's `WebClient.js:478-483` turning a 429 into a `p-retry` `AbortError`). Every one of these is decidable by *execution* and undecidable by reading, and every one is out of reach today because `probes/env.json` reports `install: skipped` / `installed: false` on all eight cases. **This is the bucket the probe ladder was built for and cannot currently enter.** It is also the bucket that produced the 7.5-hour hang: the agent reached for `npx eslint --inspect-config` on `1641-r2` precisely because eslint was not on disk.

**C** is `1680-r1` #3 (`includeItemsFromAllDrives` / `supportsAllDrives` on shared drives) — Google Drive API semantics, in public documentation but not in this repo. **D** is `1587-r3` #4 (whether any live account is not exactly `@nearform.com` — the finding's own ask is "confirm against the live roster") and `1680-r2` #3, which says outright *"my remaining concern is not the code"* and asks for a committed runbook.

**The classification separates cleanly against the evidence, which is the only reason to trust it.** All 9 matched gold are in bucket A; nothing in B, C or D has ever been matched by any arm. One gold moved *because* of that test: `1587-r2` #5 (Directory API and the NetSuite tab are two different populations) was classified as needing domain knowledge, then found — so it is in-tree after all, and its twin `1587-r3` #2 moved with it.

**So the denominator is 19, not 25.** On this run that reads **9/19 = 47%** of the reachable ceiling rather than 9/25 = 36%, and the honest target is the **10 in-tree gold still missed**, not 16. The headline "19 of 25 never discovered" was carrying two different errors in the same direction: it counted 6 gold nothing could have found, and it measured a different arm.

**One judgement call, recorded because it is arguable.** `1680-r2` #2 — the `AGENTS.md` paragraph asserting "all photo access goes through authenticated routes" while `/api/images/:set/:id` and `/api/images/thumb/:driveid` share one `NodeCache` key space — was the example originally offered for "a project-convention defect no diff-reading pipeline finds". It is classified **A**: the `AGENTS.md` line is in the diff, the code contradicting it is in the tree, and auditing a prose claim against unchanged code needs no outside information. It is brutally hard, not unreachable, and putting it in D would deflate the denominator on a technicality. It has never been found.

**What this does not measure.** These 9 are *posted and matched*. The separate claim that survey never *discovers* most gold is about hypotheses, not postings, and needs gold-to-hypothesis correspondence — that is the Phase 3 characterisation, not this.


## Survey, characterised — it is not a coverage problem (2026-09-22, $0)

The premise going in was that `survey` is 41% of spend, carries the run-to-run variance, and is the phase responsible for the gold nothing ever finds — so the question was whether the five branches are the right five and whether pooling more samples raises the ceiling. Measured over preserved artifacts, **that premise is wrong in a specific and useful way.**

### Variance: the count is stable, the content is not, and neither changes the outcome

Three runs of `1667` at an identical config (`080542`, `084524`, `091734`) — same overlay, same commit, same case:

| run | rows | needsProbe | cost | posted | matched |
|---|---|---|---|---|---|
| `080542` | 21 | 1 | $2.88 | 1 | 1/5 |
| `084524` | 25 | 3 | $2.98 | 3 | 1/5 |
| `091734` | 21 | 2 | $3.67 | 1 | 1/5 |

Hypothesis *counts* barely move. Hypothesis *subjects* move a lot, and unevenly: Jaccard is **0.91** between `080542` and `091734` but **0.33–0.38** against `084524`, and only **9 of 27** distinct subjects appear in all three. So the variance is bimodal — two near-identical draws and one divergent one — not smooth noise. Cost spreads 28% for the same work.

**And all three matched the same 1/5.** The content churn buys nothing: the four missed gold are missed identically every time. For this case survey is a **ceiling** problem, not a variance problem, and the churn is in rows that were never going to become findings.

### The actual failure: right site, wrong direction

This is the finding that redirects the work. On `1667`, survey reaches the exact code of **four of the five gold** — and writes a verification at each one:

- gold #5 (the page-cap guard cannot distinguish truncation) → `contract-002`, *"fetchUserIdsByEmail returns incomplete roster when MAX_USER_PAGES is hit, without signaling incompleteness to caller"* — essentially the gold, `Important`, `needsProbe: true`. **This one worked end to end**: falsify `reproduced` it with an isolated probe at `mockPages=26`, adjudicate tiered it `inline`, and it is the single posted match. Meanwhile `enforcement-003` and `contract-004`, in the same run, call `MAX_USER_PAGES` *"properly enforced"*.
- gold #2 (auth runs after `preValidation`, so an unauthenticated caller reaches body validation) → `security-001` describes that exact ordering — `strictDryRun` first, `bearerTokenAuth` second — and calls it correct. `Minor`, no probe.
- gold #3 (429 handling removed) → `contract-001`, *"createSlackClient sets explicit retry and 429 handling"*. Actively false, discharged as fine.
- gold #1 / #4 → `spec-001` and `contract-012` assert `strictDryRun` validates correctly; `state-003` describes the dry-run early return and calls it correct.

`1587-r3` (0/4) repeats it. `enforcement-008` says `SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS` *"is read by consumer code that enforces the age check"* — the gold on the sibling round is that **nothing** enforces it. `spec-009` describes `LoginPage` showing the Sign In button as correct fallback behaviour, which is the literal symptom of gold #1. `spec-006` narrates the `@nearform.com` gate neutrally.

### The shape of the output explains why

Across all 8 cases of the `dossier` arm: **275 hypotheses, 200 `Minor` (73%), 29 `Important`, 8 `Critical`, 38 with no severity at all, and only 43 (15.6%) asking for a probe.** Survey is mostly writing *discharge records*, not claims.

And posted recall tracks `Important`/`Critical` density, not row count. `1587-r3` has the **most** rows of any case (56) and found **nothing**; `1587-r1` has 50 rows but 9 `Important` and went 3/3. More hypotheses is not more findings.

### What this means for the lever

The queued question — are the branches the right five, is coverage or hypothesis precision binding, does pooling raise the ceiling — is answerable now, and the answer is **none of those**. Coverage is not the binding constraint: survey already stands at the defect. Pooling more samples buys more rows at the same direction, which is what the variance measurement shows costs money and changes nothing.

The binding constraint is that **a branch that reaches a defect and writes "verified correct" is unrecoverable downstream.** Nothing after survey re-opens a discharged row: falsify probes only `needsProbe` + `Critical`, so a `Minor` discharge is never executed against, and adjudicate is right to withhold a claim that says the code is fine. The one gold that survived is precisely the one where survey wrote a *claim* rather than a *verification* — and then the cheap machinery worked perfectly.

So the lever to test is the **discharge threshold**, not the branch count: what survey must do before it is allowed to write "verified", and whether `needsProbe` should be driven by the *site* (is this in a changed hunk with a non-trivial control-flow or normalisation change?) rather than by the branch's own confidence in its own verdict. That also connects to the ceiling section above: bucket **B** — the three gold that only *execution* can settle — is exactly the population a probe-first discharge rule would route into falsify, and the population `install: skipped` currently locks out.


## Why it came before the paid repeats

**[#399](https://github.com/nearform/lastlight/issues/399) — `adjudicate` assembles its own context with 30 bash calls.** Measured on `1587-r2`: 35 assistant turns, **30 of them `bash`**, one `write`, ~10 min and $1.27–1.34 uncontended — **about a third of case cost**. The calls are clerical: `cat` every `hypotheses/*.jsonl`, `cat` every probe transcript, `findings --ledger` twice, then dozens of `sed -n '<N>p'` re-reading source lines to verify quotes it was handed. All of it is already parsed by `readHypothesisSet`, `checkProbes` and `buildFindingsLedger`.

Three reasons this is the next *build*, not a nice-to-have:

1. **It is a third of the eval bill.** Item 2 below (repeats, ~$110) is mostly adjudicate. Paying for repeats of a phase you are about to rewrite is buying a baseline you will discard.
2. **It should land with the say-side typed-attribute work, not after it.** #399 fixes adjudicate's *input* (a rendered dossier instead of thirty shell calls); the typed-attribute change — adjudicator emits `claim`/`category`/`fix` and a pure `computeTier()` decides, dropping `confidence` — fixes its *output*. Both change the same phase's measured surface, so shipping them together costs **one** comparability break with the archive instead of two. That was the reason the output half was gated on a fresh collection arm; the same arm can validate both.
3. **Idea 1 is a prerequisite for Idea 2.** The System-1 / Jev exploration in #399 only makes sense once the dossier exists — a per-row classifier fed by thirty shell calls inherits the problem. And the evidence is specific: blind *correctness* adjudication is measured-dead (keep-all F1 **0.825** vs Jev 0.789, Haiku 0.803, GLM 0.745), but the same probabilities separate Code Defect from Maintainability at **AUC 0.897**. So the shape to test is typed attributes on the category axis, never "is this finding correct" — and `jev-with-evidence` was explicitly left un-ruled-out.

Success criteria are already recorded per phase and need no new plumbing: **bash calls and assistant turns per adjudication** (35/30 is the stress case), then cost and duration **at `--concurrency 1`**. The guardrail — "internal recall first, then posted" — survives, but only with the CONFIRM pass on: raw `internalMatched` is ~⅓ noise and cannot gate anything. Read `internalMatched` only where `internalMatchedPreConfirm` is present beside it.

Revised order: ~~judge audit~~ (done, $0.15) → ~~#399 + the typed-attribute output change~~ (built, $0) → ~~the #399 arm at `--concurrency 1`~~ (run, mechanism confirmed / quality inconclusive on n=1) → ~~the falsify differential-probe gate fix~~ (done, $0) → **repeats on whichever shape wins** → the install-oracle arm.

## Traps this pass re-learned

- **A finished run holds its dashboard server open forever** — that is why `--repeats` implies `--no-open`. Chaining a second arm on "no run process alive" deadlocks.
- **`--concurrency N` contaminates latency only** (cost, verdicts and recall are fine). The same case/phase ran 613s at concurrency 1 and 2731s at 3.
- **An errored case is not a zero.** `diff-runs` excludes it; hand-rolled `jq` will not.
- **Artifact layouts differ** — archive `<run>/<instance>/pr-review` vs eval-run `sessions/<case>__<arm>/trial-N/pr-review`. Resolve via `pipelineArtifactRel`, never by reconstruction; a wrong layout reads as "no artifacts".
- **A globally-installed `lastlight-evals` silently measures the wrong code.** It's npm-versioned and separate from a working-tree checkout; running it against a branch with unreleased config keys (`review.analysis.adjudicate: dossier`) doesn't error — it just ignores the key and falls back to whatever the installed version supports. Its `meta` lacks the `RunProvenance` block a current build stamps (`overlay`, `harness.version`, `core.root`, `toolchain`, `argv`) — check for those fields before trusting a run measured anything new. Always run the monorepo's own `apps/evals/src/run.ts` via `npx tsx` when the thing under test lives on an unreleased branch.

## Open issues

- **[#399](https://github.com/nearform/lastlight/issues/399)** — planned; see *Build queue* above.
- Dropped obligations' **text is not recorded** — `obligations.json`'s `dropped[]` is `{reason, count}` only, so "which questions were never asked" is unanswerable from disk. Not yet filed.
- A **release is required** before any of this reaches a deployment (`config/default.yaml`, workflows and prompts all changed).
