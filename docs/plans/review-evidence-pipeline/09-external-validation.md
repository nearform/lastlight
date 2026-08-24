# WP9 — external validation (mandatory)

**Goal.** Establish whether anything this plan builds generalises beyond eight
PRs from one private repository.

**Depends on:** [WP6](06-adjudicate.md), and — **new, 2026-08-21** — **WP1c,
Stage 2 grammars** (below). **Blocks:** any external claim about review quality,
and any decision to enable the pipeline by default.

> **Re-ordered 2026-08-21, on landing [WP1b](01b-code-facts-hardening.md).**
> Grammars were drafted as a WP1 follow-on and read as a WP3 blocker. They are
> not. **WP3's and WP4's gates are read on `skillspro`, which is TypeScript,
> where facts already work.** Grammars move the **Martian** corpus — 40 of its
> 50 cases are not TypeScript — so they raise the **generality claim**, which is
> this work package, not the shipping path. The deployment's managed repos are
> predominantly TypeScript too. **Stage 2 is therefore a WP9 dependency, not a
> WP3 blocker**, and the plan's order changed to match
> ([README.md](README.md), [HANDOFF.md](HANDOFF.md)).

> **And WP9 got cheaper.** §D6 rejected Martian tier 1 as the *gate* instrument
> partly on cost — *"~$35–120/arm vs $6–19"* — and that costing assumed model
> spend for all of it. It no longer is: `apps/evals/scripts/facts-corpus.ts`
> runs the whole deterministic half over the same 50 PRs off bare-mirror
> worktrees, free and repeatable, in **under 30 s per case at the worst
> observed**. Only the generative and adjudication rungs cost money now. The
> $35–120 figure still stands for a **full** tier-1 arm and should be re-derived
> before it is quoted again.

## Why this is mandatory and not optional

The eight `skillspro` cases are an excellent **architecture-development**
instrument and an inadequate basis for a **general quality claim**. Specifically:

- **n = 8 cases, 25 gold findings, one repository, one team's review style.**
  One case (`1641`) has empty gold and exists to catch precision regressions, so
  the recall set is seven cases.
- **Rounds of the same PR are correlated.** `1587-r1/r2/r3` are one PR; so are
  `1680-r1/r2` and `1641/1641-r2`. There are really **four PRs**, not eight
  independent samples.
- **The blind split is three cases.** A single case moving swings it by 33%. The
  baseline was decisive at n=1 only because it was saturated at zero; nothing
  above zero will be.
- **We have been iterating against it for four candidates.** Even with the
  train/blind discipline, the *architecture* has been shaped by this repo's
  defect profile. That is selection on the instrument, and it is invisible from
  inside.
- **One language, one framework, one house style.** The obligation families were
  derived from what converts here.

Every number in [08-evals.md](08-evals.md) is a **development signal**. WP9 is
what turns it into a claim.

## The validation set

Three tiers, in increasing order of independence.

### Tier 1 — the in-repo Martian set (available today)

`apps/evals/datasets/pr-review/` already imports Martian's **Code Review Bench**:
50 PRs across Sentry, Grafana, Cal.com, Discourse and Keycloak, with a
`martian-leaderboard.json` sidecar carrying per-tool tp/fp/fn so our arm can be
slotted in among their tools.

Two caveats, both already recorded in that dataset's README and both binding:

- **Martian's gold set is incomplete by their own methodology**, which
  *understates* precision. That is why the default is F1 rather than F0.5 —
  do not "fix" it.
- `instances.json` is gitignored and generated locally by
  `scripts/import-martian.ts`. Regenerate rather than assuming it is present.
  **And PIN the import** (`--repo` at upstream `949e4a1`): upstream regrouped
  its gold after PR #44 (137 → 173 findings), and an unpinned import silently
  desyncs the committed sidecar and anchors. The pinned tier lives in the eval
  workspace as `pr-review-martian` (importer `--tier`, added 2026-08-24), with
  a README stating the pin.

**Tier 1 RAN 2026-08-24 — the TypeScript slice (10 cal.com cases, 31 gold),
once, on the frozen §2l configuration.** The full record is RESTART.md §2l;
the headline: baseline (shipped reviewer, Sonnet) recall 0.484 / F1 0.462 /
rank 12 of 23; pipeline (Haiku surveys, Sonnet review+adjudicate, D2 mints +
anti-speculation) recall **0.581 in both repeats**, paired **+7/−0 gold,
p=0.008** — the recall claim generalised — at precision 0.26–0.28, F1
0.356–0.379, rank 17–20. The contamination caveat applies in full: the
baseline's 0.484 against its 0/25 on skillspro is exactly the "public result
dramatically better than private" signature §"The threat" warns about.
**AC5's cost re-derivation, measured**: the 10-case TS slice costs ~$8.40
(baseline) / ~$25 per pipeline repeat — call it **~$2.50/case for a pipeline
arm**, so the full 50-case tier-1 gate is ~$125/arm, not the stale $35–120
range (it lands mid-range, and the deterministic half stays free via
`facts-corpus.ts`).

### Tier 2 — a second private repository

The generality question we actually care about commercially is *"does this work
on a repo we did not design against?"* — which needs a private repo with a real
human reviewer, built the same way the `skillspro` set was built
(`lastlight-evals add-case --pr <url> --review`, gold curated per comment id,
anti-spoil check, base commit pinned and asserted).

`nearform/techbase` is the obvious candidate — it is already a managed repo on
the same deployment. **Curating it is a human task with human sign-off**, per
[HANDOFF.md](HANDOFF.md).

### Tier 3 — published benchmarks

CR-Bench and c-CRAB give directly comparable public numbers
([00-evidence §5](00-evidence.md)) — CR-Bench GPT-5.2 at 27.0% recall / 3.6%
precision, c-CRAB Claude Code at 32.1%. Running against these is how we answer
"are we good" rather than "did we improve".

Those two are **papers**: we can compare against their published numbers but we
cannot run them. **AACR-Bench is the runnable one**, and it changes what tier 3
costs.

#### AACR-Bench — added 2026-08-22

[`Alibaba-Aone/aacr-bench`](https://huggingface.co/datasets/Alibaba-Aone/aacr-bench)
on Hugging Face, published alongside
[`alibaba/open-code-review`](https://github.com/alibaba/open-code-review)
(Apache-2.0, Go, 21k stars). **50 popular open-source repositories, 200 real
pull requests, 10 languages, cross-validated by 80+ senior engineers.** Against
that, decision #13's "eight cases from one private repo" is 25 gold findings and
really four PRs.

**Two corrections to how this was first written up here, both found by
inspecting the artifact rather than the README (2026-08-22).**

- **It is 2,145 rows, not 1,505.** The published `dataset.json` carries **1,505
  `label=1`** (expert-verified correct) and **640 `label=0`** (expert-verified
  incorrect). 1,505 is the leaderboard's recall *denominator*, which is why
  `301/1505` appears in the table above. The 640 are invisible to that
  denominator and are the more useful half for us: a labelled **negative** set
  is something we have never had.
- **1,597 of the 2,145 comments are machine-authored** (`is_ai_comment: true`,
  with the generating model named in `source_model`); only **548 are
  human-authored**. This is the single most load-bearing fact about the corpus
  and it changes what a number from it means: the gold is "an expert agreed this
  AI comment was valid", not "a human reviewer raised this". It therefore
  over-represents defects AI reviewers already find, which is a survivorship
  bias pointing the wrong way for a recall claim. **Report the two authorship
  populations separately and never pool them.**

The dataset was built to evaluate *reflection* models — "the extent to which a
model can intercept low-quality review comments" — which is [WP6](06-adjudicate.md)'s
job, not the reviewer's. That makes it usable in two distinct ways, and the
cheap one is available now:

| | What it measures | Cost | Depends on |
|---|---|---|---|
| **Use B — adjudicate** | Hand the arm a comment; can it tell `label=1` from `label=0`? | No clone, no checkout, no review run | nothing — **built**, see below |
| **Use A — reconstruct** | Group by `pr_url`, `label=1` as `review_gold` → a 196-case `pr-review` tier | ~38 GB of mirrors; ~92% of historical head SHAs still fetchable | WP3 + WP4 to mean anything |

**Use B is built**: `apps/evals/scripts/aacr-adjudicate.ts`, with
`datasets/aacr-bench/README.md`. It is a measurement script, not a test. The
floor to beat is pinned and costs nothing to reproduce: the null adjudicator
(`--arm keep-all`, which is *what production does today*, there being no
`adjudicate` phase) scores **retention 100.0% (1505/1505), interception 0.0%
(0/640), precision 70.2%, F1 0.825**. Any WP6 adjudicator that does not beat
0.825 while holding retention is worse than not having one.

**First results, 2026-08-22: neither model beats the floor.** Haiku 4.5 scores
F1 **0.803** (retention 91.3%, interception 15.4%); GLM-5.2-fast with reasoning
disabled scores **0.745** (76.3% / 33.0%). Haiku's confidence axis is inert —
no threshold on the sweep beats `keep-all`. Both judge machine-written comments
better than human-written ones, GLM discarding 43% of valid *human* review
comments, which is the corpus's authorship bias biting in the direction that
matters least to us. Full table, confusion matrices and reading in
[06-adjudicate.md](06-adjudicate.md) §"Measured 2026-08-22".

Two limits of that instrument, stated so they are not quoted past:

- It measures whether an arm can judge a comment **when handed the comment**. It
  says nothing about whether our reviewer would ever have generated it, so it is
  **not review recall** and is not comparable to the leaderboard above.
- **It cannot supply SNR.** [08-evals.md](08-evals.md) §2 defines SNR over a
  *generated* review (`matched ÷ (posted − matched)`); with no generation step
  it degenerates to a restatement of precision. WP6's acceptance criteria name
  SNR as a gate — that gate has to be read on our own eval, not on this one.

**Use A** additionally needs the `pr_source_commit` gotcha recorded: it is
`base.sha` (verified 12/12 against `gh`), **not** the head, and
`pr_target_commit` is a *historical* head that no longer matches `head.sha` in
11 of 12 sampled PRs. `seed.ts`'s `ensurePrCommitsInCache` already handles that
exact case with its bare-SHA fallback, so the runtime needs no change; the
importer is the only new code.

It also ships a **14-entry leaderboard** whose two most important rows are the
same model under two harnesses:

| Harness | Model | F1 | Precision | Recall | Time | Tokens |
|---|---|---|---|---|---|---|
| Open Code Review v1.3.1 | Claude-4.6-Opus | **25.10%** | **33.90%** (301/889) | 20.00% (301/1505) | 1m23s | 385K |
| Claude Code v2.1.169 (a skill) | Claude-4.6-Opus | 11.57% | 7.23% (435/5980) | **28.90%** (435/1505) | 13m6s | 5,664K |

Read the raw counts, not the percentages. The skill posts 5,980 findings and
catches 435 real ones. The deterministic hybrid posts 889 and catches 301: it
**discards roughly 5,100 findings to buy precision, and loses 134 real defects
doing it.** Their README states the trade openly — *"its Recall is lower than
general-purpose agents, a deliberate trade-off favoring precision over noise."*

Three things follow, and they are why this belongs in the plan rather than in a
research note.

1. **Third independent corroboration of locked decision #1.** A filtering
   deterministic layer cost 8.9 points of recall against the unfiltered agent,
   on a 1,505-issue set. That is the same shape as our own v2 result (1/25 →
   2/25, F1 halved, reverted) and BitsAI-CR's ReviewFilter (precision 54.5 →
   67.1, recall 45.5 → 39.8), now from a third direction. **Their determinism
   routes prompts; ours generates facts.** That distinction is the whole bet,
   and it is still the unproven part.
2. **It is also the strongest available warning.** This is 29k lines of Go with
   57k lines of tests behind it, and its determinism did not raise recall.
   Nothing on the board exceeds **28.9%** recall. Whatever we claim after WP3
   and WP4, it is claimed into a field whose ceiling is roughly one defect in
   four.
3. **It gives us a same-class baseline to sanity-check our own harness
   against.** A plain Claude Code skill scores 28.9% recall here. We score
   0.040 micro-recall on skillspro. The datasets and the graders differ so the
   numbers are not comparable, but the gap is large enough to be worth
   excluding a mundane cause before an exotic one: their stated failure mode of
   general agents is *"on larger changesets, agents cut corners, selectively
   reviewing only some files"*, and "posted nothing at all on five of seven
   recall cases" is that failure mode. See
   [03-seed-and-survey.md](03-seed-and-survey.md) §"Coverage is a frozen
   denominator".

**Caveats, to be carried into any write-up.**

- The leaderboard is maintained by the vendor whose product tops it. Quote our
  own run; cite theirs as a claim, not as ground truth.
- Their grading is their own (annotated issues plus a matcher). Either map
  micro-recall / SNR onto their scoring or adopt theirs and report both, but
  **say which**, and never mix the two denominators (`01b` house rule).
- These are public repositories, so the contamination threat below applies to
  AACR-Bench exactly as it does to the Martian set. It is a *contaminated,
  large, public* set, complementary to a *clean, tiny, private* one. Report
  unpooled.
- 10 languages means it exercises the non-TS half, where evidence coverage is
  2.7%. Read acceptance criterion 6 before reading any headline from it.

## WP1c — Stage 2 grammars: justified, and SCOPED

**Added 2026-08-21.** Tier 1 is 40 non-TypeScript cases out of 50, and today the
extractors reach **2 of their 73 anchored gold findings — 2.7%**, both of which
are `.tsx` files mislabelled by Martian's PR-level `derived.language`. A tier-1
arm run against that is a measurement of the corpus's language mix. So grammars
are justified. **They are also the most gameable thing in this plan**, and the
scope below is what the measurements say, not what the ambition says.

`packages/code-facts/scripts/name-match-gate.ts` is the instrument: TypeScript is
the only language where **both** engines exist, so it is the only place a
name-matched reference set can be *measured* rather than argued about. Run
ts-morph and `src/syntactic.ts` over the same symbols in the same repo and diff
the two reference sets.

### What the gate measured

- **Recall of a name-matched set is 93–99%** on three of four cases, and it is
  nearly free. A name-matched set essentially never *misses* a type-resolved
  reference. Its blind spot is **aliasing**: `import Foo from "./bar.js"` where
  the class is `Bar` is invisible to name matching (cal-com-11059: 7 class
  symbols, 9 real references, **0 found**).
- **Precision is dominated by SCOPE, not by ambiguity.** Restricting the match
  to the declaration's own program takes this repo from **20.5% → 85.7%**,
  because tier 1's reference queries never leave their own program either — a
  hit in a sibling package is not a false positive, it is a reference ts-morph
  was never in a position to find. On the two cal.com cases the same correction
  is worth only ~20 points, and there the imprecision is real.
- **The sharper cut is SYMBOL KIND.** Module-level names hold up and members do
  not: `interface` / `type` / `class` **100%**, `variable` **97%**, `function`
  **87%** — against `interface-method` **70%** and **`property` 5%**.
  `LoggerPort.error`, `Visualize.yAxis`, `handler` (nameAmbiguity **145** on
  cal.com) offer hundreds of sites for one or two real ones.
- **`nameAmbiguity` is a RANK signal, not a gate.** It sorts well on this repo
  (90 / 73 / 57% at ambiguity 1 → 2-3 → 4-10) and on sentry (53 / 24 / 4%), but
  cal-com-10967 is only **52.5% at ambiguity 1** — so a threshold on it would
  have thrown away good references on one repo while admitting noise on another.
  It is data the seeder ranks by; it is never a filter, because filtering here
  deletes evidence nothing downstream could recover.

### The direct test of the prescription

Run on the corpus's **non-TS half**, with a crude column-0 proxy for
"module-level declaration" — *not* tree-sitter, so treat it as an order of
magnitude rather than a figure:

| prescription | EC-strict, non-TS | density |
|---|---|---|
| today (no grammars) | 2/73 — 2.7% | 1.13 / 100 names |
| **module-level declarations only** | **23/73 — 31.5%** | **2.34** / 100 names |
| any identifier | 60/73 — 82.2% | **0.14** / 100 names |

The middle row is the prescription and the third row is why it is a
prescription: **11.5× the hits at HIGHER density** versus **17× worse density**
for the row that looks best. Indexing every identifier is the "names everything,
scores 1.0" failure the pool denominator exists to catch
([08-evals.md](08-evals.md) §7) — it would hand the seeder a set that matches
any gold finding and means nothing.

**So Stage 2 ships module-level declarations, constants and their references —
and does not ship members.** That is not a staging convenience; `property` at 5%
is a seed that names one end of a mechanism wrongly, which IRIS measures at −3,
worse than no seed.

### Packaging — three constraints, all measured

- **`optionalDependencies`.** The grammars are per-platform native modules; a
  hard dependency makes every install of the `lastlight` CLI fail on a platform
  with no prebuild.
- **+36.5 MB upstream** for four grammars, on a CLI already measured at ~22 MB
  installed (§D1). The **per-platform payload is only 3.28 MB** — a later
  optimisation with a trigger, not something to build first.
- **`registerLanguages()` MUST `existsSync(libraryPath)` before the native
  call.** A missing prebuild **aborts the process** via a Rust panic across FFI,
  which `--never-fail` cannot catch — the same class as the OOM pinned by
  `tests/oom.test.ts`, and reachable on any platform whose optional dependency
  did not install. Under §D12 that is a 30-minute re-dispatch loop, so the check
  is load-bearing rather than defensive.

`src/langs/` is already shaped for this: a `LanguageDescriptor` is a **table** of
node kinds plus three predicates, and `register.ts` is a literal array — **not a
plugin system**, on purpose, because a dynamically-discovered language is a
language that can silently fail to load.

## The threat this set introduces: contamination

Tiers 1 and 3 are **public repositories**, and the PRs predate current model
training cutoffs. A model may have seen the fix, the issue, or the review
discussion.

This cuts the opposite way from the `skillspro` set's weakness, which is why both
are needed:

| | `skillspro` (private) | Martian / CR-Bench (public) |
|---|---|---|
| Contamination | none — private repo | **plausible** |
| Selection | we designed against it | independent |
| Style match | one team | many |

**Report them separately and never pool them.** A pooled number hides both
biases. If the public-set result is dramatically better than the private-set
result, suspect contamination before celebrating.

## Protocol

1. **Freeze the architecture first.** WP9 runs on a fixed candidate. It is not an
   iteration loop, and it is **not** a place to tune thresholds — that is what
   the train split is for. Tuning on WP9 destroys exactly the property it exists
   to provide.
2. **Run once per released architecture**, not per change.
3. **Report the full metric set** from [08-evals.md](08-evals.md) — internal
   recall, posted recall, SNR, comments/PR, latency, cost — per tier, unpooled.
4. **Compare against the shipped baseline on the same tier**, not against the
   `skillspro` numbers.
5. **Publish the gap honestly.** If the pipeline gains +15 micro-recall on
   `skillspro` and +2 on Martian, that is the finding, and it means the obligation
   families are repo-shaped. That is actionable — it points at
   [WP7](07-review-memory.md) as the generalisation mechanism rather than at more
   families.

## Acceptance criteria

1. Tier 1 runs end to end against both the shipped baseline and the candidate,
   with results slotted into the Martian leaderboard ranking.
2. Results are reported **per tier, unpooled**, with the contamination caveat
   stated in the summary rather than a footnote.
3. No threshold, prompt or obligation family is changed as a result of reading
   WP9. If something obviously wants changing, it goes back to the train split
   and WP9 is re-run afterwards.
4. Tier 2 exists, or its absence is recorded as a known limitation on any
   external claim.
5. Cost and wall clock for a 50-case tier-1 arm are measured and recorded before
   it becomes a routine gate — at ~2–3× baseline per case this is not free, and
   it should run per release, not per commit. **Re-derive the number**: the
   deterministic half is now free (`facts-corpus.ts`), so the $35–120 estimate
   §D6 rejected tier 1 on is stale.
6. **Added 2026-08-21.** Evidence coverage is reported for the tier-1 arm
   **before** it is run, split TS/JS from non-TS with the candidate pool beside
   it ([08-evals.md](08-evals.md) §7). A non-TS recall result read without its
   naming ceiling beside it is uninterpretable — 2.7% today.
7. **Added 2026-08-21.** WP1c ships module-level declarations only, and the
   `name-match-gate` numbers are re-measured on the shipped grammars rather than
   carried over from the TypeScript proxy they were derived on.
8. **Added 2026-08-22.** A tier-3 **AACR-Bench** arm runs for the shipped
   baseline and the candidate, and the **`lastlight` skill's own score is
   reported beside Claude Code's published 28.90% recall on the same set**.
   That row is a harness self-check, not a product claim: a score far below it
   indicts our coverage, not our review quality, and must be chased before any
   pipeline result from WP3/WP4 is believed.
9. **Added 2026-08-22.** Grading provenance is stamped on every AACR-Bench
   result — whose matcher, whose denominator — and our number and theirs are
   never averaged, pooled or presented in the same column.

## Non-goals

- **Not a development loop.** See protocol 1.
- **No new private dataset beyond tier 2** in this work package.
- **No fine-tuning on any of it.** These are evaluation sets; using them as
  training data destroys them.
