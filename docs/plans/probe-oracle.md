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

**The cheap fix is spent.** What remains is structural — the judge never sees a finding's `tier` or disposition, only `title — body` flattened by `internalJudgeInputs` (`review-pipeline-stats.ts:591`) — or procedural, a confirm call per credited pair. Both move a measured instrument, so both need a decision before a keystroke.

## Next evals, cheapest first

1. ~~**The judge audit** (~$0.20)~~ — **done, $0.15**; see the section above. It gates per-gold numbers, and it now also gates #399's guardrail.
2. **Repeats on the pair** (~$110 for 2×2). Today's arms are n=1; historical bands ran 0.04–0.14 and one arm swung 0.320→0.080 across identical runs. Nothing here can order arms until this exists.
3. **An INSTALL oracle arm — `probes: full`, done cheaply.** The open question: Sonnet reached tier 2 with no dependencies; what does it reach with them? Only an install makes `tsc`, `eslint`, the framework's own runner and a single test file available, and those are the probes that settle the claims a grep cannot.
   - **Confound to design around:** `prepare` runs *before* `facts`, so an install also moves DISCOVERY — measured, tier-1 cases 21→5 and contract deltas 73→19 without it (`packages/code-facts/src/prepare.ts:29-35`). A `full` arm therefore changes two things at once. Either accept it and say so, or add a mode that installs for probes only (after `facts`), which is a workflow reordering, not a new capability.
   - **Making it fast, which is the whole objection.** `--ignore-scripts` is already the default and is most of the CPU and all of the arbitrary-code risk. Beyond that: a **warm shared package store** (pnpm's content-addressable store hardlinks, so 8 cases pay the download once — the `lastlight_pkg-cache` docker volume already exists for this), `--prefer-offline`, and the fact that warm workspaces already keep `node_modules` across reviews (`git clean -fdx -e node_modules`), so only the first review of a repo pays.
   - **The genuinely shallow option, untried:** let the oracle install *only what a probe needs* — `npm i --no-save eslint` when it wants to run eslint — rather than the whole tree. Smallest possible install per probe, no tree-wide cost, and it fits the existing ladder as a new tier between 2 and 3. Needs a CLI affordance and a disk/time budget; **there is no disk guard anywhere today** and warm `node_modules` persists.
4. **A differential arm.** Tier 1 is unused by both models. The prompt already prefers it and `origin/<base>` is already fetched. Possibly just a prompt/ladder emphasis change, so cheap to try.

## Build queue — and why it comes before the paid repeats

**[#399](https://github.com/nearform/lastlight/issues/399) — `adjudicate` assembles its own context with 30 bash calls.** Measured on `1587-r2`: 35 assistant turns, **30 of them `bash`**, one `write`, ~10 min and $1.27–1.34 uncontended — **about a third of case cost**. The calls are clerical: `cat` every `hypotheses/*.jsonl`, `cat` every probe transcript, `findings --ledger` twice, then dozens of `sed -n '<N>p'` re-reading source lines to verify quotes it was handed. All of it is already parsed by `readHypothesisSet`, `checkProbes` and `buildFindingsLedger`.

Three reasons this is the next *build*, not a nice-to-have:

1. **It is a third of the eval bill.** Item 2 below (repeats, ~$110) is mostly adjudicate. Paying for repeats of a phase you are about to rewrite is buying a baseline you will discard.
2. **It should land with the say-side typed-attribute work, not after it.** #399 fixes adjudicate's *input* (a rendered dossier instead of thirty shell calls); the typed-attribute change — adjudicator emits `claim`/`category`/`fix` and a pure `computeTier()` decides, dropping `confidence` — fixes its *output*. Both change the same phase's measured surface, so shipping them together costs **one** comparability break with the archive instead of two. That was the reason the output half was gated on a fresh collection arm; the same arm can validate both.
3. **Idea 1 is a prerequisite for Idea 2.** The System-1 / Jev exploration in #399 only makes sense once the dossier exists — a per-row classifier fed by thirty shell calls inherits the problem. And the evidence is specific: blind *correctness* adjudication is measured-dead (keep-all F1 **0.825** vs Jev 0.789, Haiku 0.803, GLM 0.745), but the same probabilities separate Code Defect from Maintainability at **AUC 0.897**. So the shape to test is typed attributes on the category axis, never "is this finding correct" — and `jev-with-evidence` was explicitly left un-ruled-out.

Success criteria are already recorded per phase and need no new plumbing: **bash calls and assistant turns per adjudication** (35/30 is the stress case), then cost and duration **at `--concurrency 1`**. The guardrail needs re-specifying, though: it was "internal recall first, then posted", and the audit above leaves internal recall ⅓ noise with its withheld half 1-for-10 — it cannot gate this rewrite until the judge is fixed or the guardrail moves to posted recall alone.

Revised order: judge audit (~$0.20) → **#399 + the typed-attribute output change** ($0 to build) → repeats on the new shape → the install-oracle arm.

## Traps this pass re-learned

- **A finished run holds its dashboard server open forever** — that is why `--repeats` implies `--no-open`. Chaining a second arm on "no run process alive" deadlocks.
- **`--concurrency N` contaminates latency only** (cost, verdicts and recall are fine). The same case/phase ran 613s at concurrency 1 and 2731s at 3.
- **An errored case is not a zero.** `diff-runs` excludes it; hand-rolled `jq` will not.
- **Artifact layouts differ** — archive `<run>/<instance>/pr-review` vs eval-run `sessions/<case>__<arm>/trial-N/pr-review`. Resolve via `pipelineArtifactRel`, never by reconstruction; a wrong layout reads as "no artifacts".

## Open issues

- **[#399](https://github.com/nearform/lastlight/issues/399)** — planned; see *Build queue* above.
- Dropped obligations' **text is not recorded** — `obligations.json`'s `dropped[]` is `{reason, count}` only, so "which questions were never asked" is unanswerable from disk. Not yet filed.
- A **release is required** before any of this reaches a deployment (`config/default.yaml`, workflows and prompts all changed).
