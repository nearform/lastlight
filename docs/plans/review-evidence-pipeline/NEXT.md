# NEXT — start a clean session here

Written 2026-08-22 at the end of the re-baseline day. This is the short,
self-contained entry point: what we know, what the artifacts say, and five small
experiments that are worth running before anything ambitious.

[RESTART.md](RESTART.md) remains the operational reference — tree state, the
commands, and §4's traps (all ten of which have already cost money). Read §2b
there for the measured numbers. This file is what to *do*.

## The state in five lines

- The pipeline works end to end and is **off by default**; `false` reproduces the
  shipped review byte-for-byte.
- It finds gold the shipped reviewer never finds — **15 of 75 gold-instances
  pooled across three runs, against the baseline's 0 of 25** — and has never lost
  a baseline hit.
- **How much it finds on any given run is wildly unstable**: 0.320, 0.080 and
  0.200 from an identical configuration. The mean is 0.200.
- **The seed layer is deterministic** — obligations are byte-identical across
  runs. All the variance is in the survey models.
- Everything is committed. Both repos clean.
- Nothing here has been validated outside eight `skillspro` cases. Any external
  claim is still [WP9](09-external-validation.md)'s, unmade.

## The four runs — KEEP THESE IDS

All in `~/work/nearform-evals/eval-results/pr-review/`.

| Run id | Arm | Result |
|---|---|---|
| `2026-08-22_183835-00cc469` | **baseline** | 0 of 25, 1 posted, $2.28 |
| `2026-08-22_184650-00cc469` | **wp3 run 1** | 8 of 25 (μrec 0.320), 47 posted, $15.65 |
| `2026-08-22_194234-00cc469` | **wp3 run 2** | 2 of 25 (μrec 0.080), 23 posted, $17.55 |
| `2026-08-22_201607-64862d5` | **wp3 run 3** | 5 of 25 (μrec 0.200), 44 posted |

`TMPDIR` is purged periodically, so the kept workspaces are **copied out** to:

```
~/lastlight-run-artifacts/2026-08-22_184650-00cc469-wp3-run1/    (run 1)
~/lastlight-run-artifacts/2026-08-22_201607-64862d5-wp3-run3/    (run 3)
  └── <instance_id>/pr-review/
        facts.json  obligations.json  obligations/*.md
        hypotheses/*.jsonl  findings.json  disposition.json
```

Run 2 was run without `--keep-workspace` — **a mistake worth not repeating.**
Always pass it.

### Three runs, and the shape of the noise

| | run 1 | run 2 | run 3 | mean |
|---|---|---|---|---|
| arm | 0.320 | 0.080 | 0.200 | **0.200** |
| train (13 gold) | 0.462 | 0.000 | 0.154 | 0.205 |
| blind (12 gold) | 0.167 | 0.167 | 0.250 | 0.194 |

**Pooled: 15 of 75 gold-instances, against the baseline's 0 of 25.** Never a
baseline hit lost, in any run.

## What the deep scan of runs 1 and 3 found

Read off the two preserved workspaces and the four scorecards. No model spend.

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

**3. The seed layer is DETERMINISTIC, and all the variance is downstream of it.**
*Established by run 3, and it retires the leading hypothesis of an hour earlier.*

Comparing run 1 and run 3 obligation-for-obligation: **byte-identical on all
eight cases** — same ids, same families, same mechanisms, same counts. `facts`
and `seed` do exactly what they are supposed to do.

The same eight cases then produced **wildly different hypothesis volumes from
that identical brief**:

| Case | Obligations (both runs) | Hypotheses r1 → r3 |
|---|---|---|
| `1587-r1` | 31 | 18 → **43** |
| `1667` | 7 | 10 → **23** |
| `1680-r1` | 1 | 10 → **19** |
| `1587-r3` | 40 | 45 → 45 |
| `1587-r2` | 33 | 42 → 39 |

**So the variance is entirely in what the survey models do with a fixed input** —
up to 2.4× the hypothesis volume from the same obligations. That is a much
sharper target than "the pipeline is noisy", and it points every remaining lever
at the survey stage rather than at the deterministic layer.

**4. Obligation supply does NOT predict recall — the under-seeding theory is
dead.** Written after run 1, it looked compelling: the blind cases drew 1, 1 and
7 obligations against the train cases' 31–40. Three runs kill it.

- `1680-r1` has **one** obligation and matches **1/2/1** across the three runs.
- `1667` has **seven** and matches **0/0/0** — it has never been cracked.
- `1587-r3` has **forty** and matches **1/0/0**.

And the split means are **train 0.205, blind 0.194** — statistically the same.
The "blind is worse" reading was itself noise from a single run; blind is in fact
the *more stable* half (0.167 / 0.167 / 0.250 against train's 0.462 / 0.000 /
0.154). Do not build on it.

**The one durable per-case signal is `1667`: 5 gold, zero matched in all three
runs, and 3/0/4 posted.** That is not noise, and it is the only case where a
consistent story can be read off three data points.

**5. Identical effort, wildly different yield.** Per-phase totals across the two
runs are within ~10–20% everywhere (`survey_branch_contract` 1399 s vs 1382 s;
`adjudicate` 1551 s vs 1872 s; total $15.65 vs $17.55). The runs worked equally
hard and concluded differently. **The variance is in what the surveys decided,
not in how much they did** — which rules out "it ran out of budget" as the story.

**6. The funnel barely narrows.** Hypotheses → findings is close to lossless
(`1641`: 32 → 32; `1641-r2`: 30 → 25; `1587-r2`: 42 → 37). Almost all the
selection happens in the attention boundary's tiering, not in adjudication. On
`1641` — the zero-gold case — all 32 findings landed `internal` in run 1 and
nothing posted, which is the boundary working exactly as designed.

**7. `coverage: degraded` on all 8 cases**, every one a `tsgo` complaint that
some base-view files are covered by no `tsconfig` and were analysed in an
inferred project. Unquantified. It may be nothing; it is also the kind of thing
that silently costs an extractor its precision.

**8. The spec axis is genuinely live** — its hypotheses cite `S-1`/`S-2`
obligations with `QUOTE` claims. Note that spec obligations do **not** appear in
`obligations.json` or `obligations/`: they are built harness-side by
`review-spec.ts`, and `obligations.json` explicitly records why. Counting
families out of that file alone will make the spec axis look dead when it is not.
It looked exactly like [RESTART.md](RESTART.md) §4 trap 4 for about ten minutes.

## Five experiments, cheapest first

Deliberately small. Each answers one question, and **the first two spend nothing** —
do those before authorising any arm.

### E1 — Why has `1667` never been cracked? ($0)

**The replacement for the dead under-seeding question, and still free.** `1667`
is 5 gold, `0/0/0` matched, 7 obligations, and it posted 3/0/4 — so the surveys
*are* producing output, it is simply never the right output. Two workspaces hold
its full evidence chain.

Read, in order: its five gold findings; its seven obligations; then
`hypotheses/*.jsonl` in both runs. The question is which link breaks —

- **no obligation names the right code** → a seeding gap, and the fix is in
  `code-facts`;
- **an obligation names it but no hypothesis forms** → the discovery failure
  [TLDR.md](TLDR.md) is about, and the fix is in the survey briefs;
- **a hypothesis forms but is not posted** → a tiering/adjudication problem,
  and `disposition.json` will say so outright.

Its gold is the auth-ordering and rate-limit material (auth running *after* body
validation; a rate-limit "fix" that removes 429 retry while raising concurrency
fivefold) — cross-cutting reasoning rather than anything a single-file fact names.
That is a prediction worth checking rather than assuming.

### E2 — Why does one brief produce 18 hypotheses once and 43 the next? ($0 first)

Finding 3 is the sharpest lead in this file, and the first pass costs nothing:
`1587-r1` has identical obligations in both runs and 18 → 43 hypotheses. Diff the
two `hypotheses/*.jsonl` sets and the two survey transcripts. Is the extra volume
*more of the same* (dilution), or genuinely different questions (in which case
running the surveys twice and unioning is a legitimate, if expensive, recall
lever)?

**If unioning helps, that is measurable before it is built** — the union of run 1
and run 3's matched gold per case is already computable from the three
scorecards, and it is a ceiling on what any sampling strategy could buy.

### E3 — Put an error bar on the band (~$17 per repeat)

Three runs give 0.320 / 0.080 / 0.200 — a mean of 0.200 and a range that
straddles the ≈0.24 detection floor. Two more would make the mean meaningful;
until then no lever below a large effect is measurable. Always
`--keep-workspace`. Sequential, never overlapping a build ([RESTART.md](RESTART.md)
§4 trap 6).

Cheap variant: repeat **one** case 5× instead of 8 cases 3×. `1587-r2` (5 gold,
the best-performing case at 3/0/2) is the natural subject.

### E4 — Turn `prepare` on ($ ~1 arm)

It is skipped 8/8 today, which means the probe oracle is inert *and* the `tests`
family is dead. Turning it on is the only change that could plausibly move a
family from "structurally silent" to "contributing". Measure it as its own arm,
one variable.

### E5 — Reshape `review` when the pipeline is on (~1 arm)

[RESTART.md](RESTART.md) §3b lever f4, still unbuilt and still the most obviously
wasteful thing in the DAG: `review` runs a full independent review costing ~$2.30
per arm while 40+ hypotheses sit unread beside it. It cannot simply be skipped —
`post-review` depends on it with `all_success` — so change its brief under
`{{#if analysisEnabled}}`.

**Do E5 after E3.** It is the one most likely to be swamped by variance.

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
