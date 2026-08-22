# NEXT — start a clean session here

Written 2026-08-22 at the end of the re-baseline day. This is the short,
self-contained entry point: what we know, what the artifacts say, and four small
experiments that are worth running before anything ambitious.

[RESTART.md](RESTART.md) remains the operational reference — tree state, the
commands, and §4's traps (all ten of which have already cost money). Read §2b
there for the measured numbers. This file is what to *do*.

## The state in five lines

- The pipeline works end to end and is **off by default**; `false` reproduces the
  shipped review byte-for-byte.
- It finds gold the shipped reviewer never finds — **10 of 50 gold-instances
  pooled across two runs, against the baseline's 0 of 25** — and has never lost a
  baseline hit.
- **How much it finds on any given run is wildly unstable**: 0.320 and 0.080 from
  an identical configuration.
- Everything is committed. Both repos clean.
- Nothing here has been validated outside eight `skillspro` cases. Any external
  claim is still [WP9](09-external-validation.md)'s, unmade.

## The three runs — KEEP THESE IDS

All in `~/work/nearform-evals/eval-results/pr-review/`.

| Run id | Arm | Result |
|---|---|---|
| `2026-08-22_183835-00cc469` | **baseline** | 0 of 25, 1 posted, $2.28 |
| `2026-08-22_184650-00cc469` | **wp3 run 1** | 8 of 25 (μrec 0.320), 47 posted, $15.65 |
| `2026-08-22_194234-00cc469` | **wp3 run 2** | 2 of 25 (μrec 0.080), 23 posted, $17.55 |

Run 1 kept its workspaces, and `TMPDIR` is purged periodically, so its pipeline
artifacts are **copied out** to:

```
~/lastlight-run-artifacts/2026-08-22_184650-wp3-run1/<instance_id>/pr-review/
  facts.json  obligations.json  obligations/*.md  hypotheses/*.jsonl
  findings.json  disposition.json
```

Run 2 was run without `--keep-workspace` — **a mistake worth not repeating.** The
one run we most want to diff against run 1 is the one whose evidence we did not
keep. Always pass it.

## What the deep scan of run 1 found

Read off the preserved artifacts and both scorecards. No model spend.

**1. `prepare` and `falsify` were skipped 8/8 — in both runs.** The probe oracle
has *still* never been executed by a model, so the adjudicator's delete power is
inert by construction, exactly as [TLDR.md](TLDR.md) gap 2 says. This is not a
regression; it has never run. Two consequences follow, and the second is the
expensive one.

**2. The `tests` family is structurally dead, and says so.** Every case reports
`tests: measured: false — "no coverage artifact was read, so uncovered changed
lines are UNKNOWN rather than none — nothing produces one until WP4's prepare"`.
One of six families contributes nothing because the phase that would feed it is
skipped. The envelope is honest about it; nobody had read the envelope.

**3. Obligation supply collapses on exactly the cases we do worst on.**

| Case | Split | Obligations | Gold | Matched (run 1) |
|---|---|---|---|---|
| `1587-r3` | train | **40** | 4 | 1 |
| `1587-r2` | train | **33** | 5 | 3 |
| `1587-r1` | train | **31** | 3 | 1 |
| `1641` / `1641-r2` | train | 11 / 11 | 0 / 1 | — / 1 |
| `1667` | blind | 7 | 5 | **0** |
| `1680-r1` | blind | **1** | 4 | 1 |
| `1680-r2` | blind | **1** | 3 | 1 |

The three blind cases draw **1, 1 and 7** obligations against the train cases'
31–40. Blind micro-recall was 0.167 in *both* runs while train swung 0.462 →
0.000. The deterministic layer is nearly silent on precisely the PRs we are
worst at, which makes "the blind split is harder" and "the blind split is
under-seeded" indistinguishable on present evidence. **Distinguishing them is the
single most valuable thing to do next**, and it costs no model spend to start.

**4. Identical effort, wildly different yield.** Per-phase totals across the two
runs are within ~10–20% everywhere (`survey_branch_contract` 1399 s vs 1382 s;
`adjudicate` 1551 s vs 1872 s; total $15.65 vs $17.55). The runs worked equally
hard and concluded differently. **The variance is in what the surveys decided,
not in how much they did** — which rules out "it ran out of budget" as the story.

**5. The funnel barely narrows.** Hypotheses → findings is close to lossless
(`1641`: 32 → 32; `1641-r2`: 30 → 25; `1587-r2`: 42 → 37). Almost all the
selection happens in the attention boundary's tiering, not in adjudication. On
`1641` — the zero-gold case — all 32 findings landed `internal` in run 1 and
nothing posted, which is the boundary working exactly as designed.

**6. `coverage: degraded` on all 8 cases**, every one a `tsgo` complaint that
some base-view files are covered by no `tsconfig` and were analysed in an
inferred project. Unquantified. It may be nothing; it is also the kind of thing
that silently costs an extractor its precision.

**7. The spec axis is genuinely live** — its hypotheses cite `S-1`/`S-2`
obligations with `QUOTE` claims. Note that spec obligations do **not** appear in
`obligations.json` or `obligations/`: they are built harness-side by
`review-spec.ts`, and `obligations.json` explicitly records why. Counting
families out of that file alone will make the spec axis look dead when it is not.
It looked exactly like [RESTART.md](RESTART.md) §4 trap 4 for about ten minutes.

## Four experiments, cheapest first

Deliberately small. Each answers one question, and the first two spend nothing.

### E1 — Why do the blind cases draw one obligation? ($0)

Read `facts.json` for `1680-r1` and `1680-r2` in the preserved artifacts against
`1587-r2`'s. All the inputs are on disk. The question is narrow: is the diff
genuinely thin, or is an extractor bailing? `coverage: degraded` and the
`no tsconfig` complaint are the first suspects, and `1680`'s changed files
include `packages/backend/strip-public-photo-permissions.ts` — a **root-level
script**, precisely the kind of file a `tsconfig`-driven project layout misses.

**If that is it, it is the highest-leverage bug in the plan**: 12 of 25 gold sit
behind it, and no amount of prompt work reaches a file the fact layer never
analysed.

### E2 — Put an error bar on the band (~$17 per repeat)

Three to five more wp3 repeats, unchanged, **with `--keep-workspace`**. Nothing
below is interpretable until the spread is known — every lever in
[RESTART.md](RESTART.md) §3b is plausibly a smaller effect than the noise we
just measured. Run them detached and sequential; do not overlap them with a
build (§4 trap 6).

The cheap version if that is too much spend: repeat **one** case 5× rather than
8 cases 3×. Same question, a quarter of the money, and `1587-r2` (5 gold, the
most matched) is the natural subject.

### E3 — Turn `prepare` on ($ ~1 arm)

It is skipped 8/8 today, which means the probe oracle is inert *and* the `tests`
family is dead. Turning it on is the only change that could plausibly move a
family from "structurally silent" to "contributing". Measure it as its own arm,
one variable.

### E4 — Reshape `review` when the pipeline is on (~1 arm)

[RESTART.md](RESTART.md) §3b lever f4, still unbuilt and still the most obviously
wasteful thing in the DAG: `review` runs a full independent review costing ~$2.30
per arm while 40+ hypotheses sit unread beside it. It cannot simply be skipped —
`post-review` depends on it with `all_success` — so change its brief under
`{{#if analysisEnabled}}`.

**Do E4 after E2.** It is the one most likely to be swamped by variance.

## The guardrails that still apply

- **Never seed a bot review over gold** ([RESTART.md](RESTART.md) §4 trap 9).
  `prreview__skillspro-1641` is the one sanctioned exception and its gold must
  stay empty.
- **A fixture replays the moment the review happened.** Everything after it is
  the future, and the gold review lands *after* ours.
- **If any lever shows precision up and recall down, that is locked decision 1
  reproducing for the fifth time**, not a tuning opportunity.
- **Gate on mechanism metrics** — obligations, discharge rate, the per-family
  funnel, conservation. Report micro-recall; do not steer on it. The detection
  floor is ≈0.24 and we now know the run-to-run spread straddles it.
- **Every eval arm is human-authorised spend.** A sub-agent never runs one
  unprompted.

## The honest summary, for anyone tempted to quote a number

The pipeline finds real defects that the shipped reviewer misses entirely, at
roughly 7× the cost, with run-to-run variance wide enough that a single arm
cannot tell you how well it works. The mechanism is sound and measured; the
magnitude is not yet established; the generality is not even in evidence.
