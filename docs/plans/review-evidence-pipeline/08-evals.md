# WP8 — the instrument

**Goal.** Make the eval harness able to *see* a recall-first architecture, and
fix the metric that will otherwise mislead every gate in this plan.

**Depends on:** nothing. **Run this early** — every other work package's gate is
read on it.

## Why the current metric is wrong for this plan

`gradeReview` (`apps/evals/src/grade.ts`) computes precision, recall and F-beta,
defaulting to **β = 1** to match Martian's leaderboard. That is the right default
for comparing against Martian and the wrong one for steering this work.

Two reasons:

1. **We are deliberately over-generating.** Frontier precision on this task is
   3–5% ([00-evidence §5](00-evidence.md)). An F1 that weights precision equally
   will penalise exactly the intervention we intend, and an arm that surfaces
   four extra correct findings and two wrong ones can score *worse*.
2. **The arm average is already misleading.** `1641` has **empty gold**, so
   posting nothing scores 1.00 and flatters every average. The baseline's arm F1
   of 0.188 contains that free point.

## Changes

### 0. Back-fill the baseline first — no spend

`InstanceResult.review` already carries `posted`, `gold`, `matched`,
`falsePositives`, `falseNegatives` and the full `ReviewTrace` (judge model,
review text, extracted findings with `matchedGold` indices, gold with
`matchedFinding` indices, both raw replies). Everything below is arithmetic over
those, so **the existing baseline scorecard can be re-scored offline**.

Verified against `2026-08-20_074355-8049410`:

```
posted=2  gold=25  matched=1   →  micro-recall 0.040, micro-precision 0.500
```

which reproduces the published headline exactly. Ship a small offline re-score
path (a script, or `report.ts` recomputing from stored fields) so old runs gain
the new columns without a re-run. **Do this before adding the metrics**, so there
is a verified reference the moment the first candidate arm lands.

### 0b. The detection floor — write it down before anything is gated on it

**Added 2026-08-21 ([10-design-review.md](10-design-review.md) §D6).** This is
the number that tells a reader how to interpret every other number in this file,
and its absence is how a team talks itself into shipping on a coin flip.

Paired (McNemar) over the 25 gold findings, keeping the baseline's one hit and
adding *k* new ones:

| Candidate | Micro-recall | New hits | One-sided p | Two-sided p |
|---|---|---|---|---|
| 2/25 | 0.080 | 1 | 0.50 | 1.00 |
| 3/25 | 0.120 | 2 | 0.25 | 0.50 |
| 5/25 | 0.200 | 4 | 0.063 | 0.125 |
| 6/25 | 0.240 | 5 | **0.031** | 0.063 |
| 7/25 | 0.280 | 6 | 0.016 | **0.031** |

**Detection floor ≈ 0.24–0.28 micro-recall** — at or above CR-Bench's GPT-5.2
(27.0%). *This instrument cannot distinguish a real improvement from chance until
we are at the field frontier.* And that is the optimistic read: it assumes the 25
items are independent (they cluster inside four PRs), zero run-to-run variance
(never measured — run `--runs 3` on one arm to find out), and a clean judge
(agreement 0.44–0.62, §5 below).

Consequence, and it is binding: **WP3's and WP4's gates are mechanism gates**, not
recall gates. Obligations generated and well-formed (~40 × 8 = 320 units),
discharge rate, the per-family funnel obligations → hypotheses → posted →
matched, and whether `1587-r2`'s O6 → Critical conversion reproduces
mechanically. Those have the power that micro-recall does not. Micro-recall is
still reported at every rung — just never gated on until [WP9](09-external-validation.md).

### 1. Micro-recall as the headline

Recall over the **25 gold findings**, not the mean of per-case recalls. Report it
at arm and split level, beside F1 rather than instead of it — the Martian
comparison still needs F1.

Surface it in `ModelSummary` (`apps/evals/src/report.ts`) and in
`scripts/diff-runs.ts`'s per-split table.

### 2. Signal-to-noise ratio

CR-Bench's SNR is the guardrail that replaces precision when over-generating: it
is the number that degrades when a recall intervention goes wrong. CR-Bench
reports Reflexion improving recall +5.75pts while SNR fell 5.11 → 1.95 — that
trade is visible in SNR and invisible in F1.

Add it to `gradeReview`'s output and to the run summary. Define it explicitly in
the code comment (findings posted per gold finding matched, or the CR-Bench
formulation — pick one, write it down, never change it silently).

### 2b. Two boundaries, measured separately

[WP6](06-adjudicate.md) introduces an explicit user-attention boundary: findings
land **inline**, in the **body**, or **internal** (recorded, not posted). Recall
and attention are therefore different budgets and must be different numbers:

| Measured over | Metric |
|---|---|
| everything the pipeline **generated** (hypotheses ∪ findings) | **internal recall** — did we find it at all? |
| everything **posted** (inline + body) | posted recall, posted precision, SNR |
| everything **inline** | attention cost — comments/PR, inline precision |

Without this split, an intervention that finds more and shows less reads as a
regression. With it, that is exactly what it looks like — which is the point.

Requires the evidence packet's `tier` and `family` fields; degrade cleanly to
posted-only for arms that emit neither (the baseline).

### 2c. Utility metrics, from day one

Detection quality is not the whole story, and adding these later means having no
history when they matter. Record per case and per arm from the first candidate
run:

| Metric | Source | Why |
|---|---|---|
| **comments per PR** (inline / body / total) | posted review | the attention bill. Graphite scored 100% precision at 8.8% recall — a reviewer that says nothing looks perfect on precision alone |
| **wall-clock latency** per phase and per run | `durationMs`, already collected | the pipeline is 6–8 phases; a review nobody waits for is not a review |
| **probe executions** — attempted, succeeded, reproduced, refuted | `falsify` transcripts | the oracle's own hit rate. If probes rarely settle anything, [WP4](04-probe-oracle.md) is not paying |
| **model cost** per case, per arm, per phase | `costUsd`, already collected — but only if `drainSessions()` runs before `collectMetrics()` | the 2–3× budget is a real constraint, not an aspiration |
| **tokens in/out, cached** | already collected | where the cost actually goes |
| **author response** (later) | [WP7](07-review-memory.md)'s `review_outcomes` | the only ground truth that matters: did the code change? |

The last one closes the loop and is why WP7 is in the plan at all. It cannot be
measured on historical eval cases — it is a **production** metric, read off
`review_outcomes` once WP7 lands. State that explicitly rather than pretending
the eval covers it.

### 3. Per-family attribution

The obligation `family` ([WP3](03-seed-and-survey.md)) rides on each finding's
evidence packet. Group matched/unmatched by family in the scorecard, so a
measurement answers *"which kind of reasoning got better"* rather than *"the
number moved"*. This is what makes the ablation ladder below legible.

### 4. Bug-taxonomy tags on the gold set

Tag each of the 25 gold findings with its class — local / cross-function /
cross-file / stateful / concurrency / data / security / performance /
specification. One-off curation, in
`~/work/nearform-evals/evals/datasets/pr-review/`. Without it, a recall
improvement cannot be attributed to a mechanism.

### 5. Keep the judge honest

`gradeReview` uses a two-step LLM judge (extract, then match) at temperature 0
with a model deliberately independent of the ones under test. Keep that. But:

- **LLM-judge / developer agreement is only 0.44–0.62.** Use it for triage, not
  for a final accept/reject on an architecture.
- `ReviewTrace` already records the judge model, the review text read, the
  extracted findings and both raw replies. **Read the session transcripts**
  (`sessions/<instance>/trial-1/full.jsonl`) before accepting or rejecting a
  candidate. Every diagnosis in the investigation came from there, not from the
  scorecard.
- A judge failure sets `error` and leaves the case **ungraded, never a silent
  zero**. Preserve that property.

### 6. Optional: test-based grading

c-CRAB grades a review as a hit iff a test that failed pre-revision passes
post-revision. That removes the "was this the same finding?" judgement from
scoring entirely, at the cost of only grading behaviourally-observable defects.
Worth importing **after** [WP4](04-probe-oracle.md), since the probe transcripts
are most of the machinery. Not a WP8 requirement.

### 7. Evidence coverage — a deterministic gate the plan did not have

**Added 2026-08-21, on landing [WP1b](01b-code-facts-hardening.md).** Every
metric above is downstream of a model. This one is not: it costs **no model
spend**, it is repeatable, and it bounds [WP3](03-seed-and-survey.md)
**upstream** of the mechanism metrics. The question it answers is prior to every
question §0b poses:

> **Does the deterministic envelope even NAME the thing the human talked
> about?**

If it does not, no seeder can produce an obligation about that identifier *from
facts*, whatever the prompt says. So the naming rate is a **ceiling on the
recall attributable to `code-facts` as a seeder** — and a ceiling is exactly
what §D6 says this instrument is short of.

`apps/evals/scripts/facts-evidence.ts` scores a `facts-corpus` run against
`datasets/pr-review/anchors.json` — frozen, versioned deterministic anchor
labels (tokenizer `v1`) built by `scripts/facts-anchors.ts` with no model
anywhere. The artifact stamps its tokenizer, so a better tokenizer ships as `v2`
rather than silently rewriting past numbers.

#### Three numbers, three denominators. Never quote one alone

| | | on the 50-PR Martian corpus |
|---|---|---|
| **anchor rate** | anchored / **all** gold — a property of the gold **text**, not of `code-facts` | 99/137 = **72.3%** |
| **discovery ceiling** (EC-loose) | EC-loose / **all** gold — what any identifier-level layer could point at | 15/137 = **10.9%** |
| **evidence coverage** (EC-strict) | EC-strict / **anchored** — conditional on the finding being anchorable at all | 14/99 = **14.1%** |

EC-strict is a match on an *entity* the envelope has something to say about — a
`facts.symbols[].name` (or its last dotted segment), a `contracts[].symbol`, a
`constants[].constant` or `[].value`, a `deps.changes[].name`. EC-loose adds
file-level pointing: the basename of a changed file, a `patterns` hit, or a
`coverage` file with uncovered changed lines. The envelope names the *place* but
not the thing.

#### Split TS/JS from non-TS. Never pool them

A pooled score measures the **corpus's language mix**, not the extractors — 40
of the 50 cases are a language the ts-morph extractors structurally cannot see.

| | cases | anchor rate | EC-loose | **EC-strict** | pool | density |
|---|---|---|---|---|---|---|
| TS/JS | 10 | 26/31 | 13/31 | **12/26 = 46.2%** | 214 | **5.61** / 100 names |
| non-TS | 40 | 73/106 | 2/106 | **2/73 = 2.7%** | 177 | **1.13** / 100 names |

#### Carry every caveat in the text, not in a footnote

Each of these is load-bearing, and each was measured rather than assumed:

- **Score at ENTITY or FILE level, never line level.** `anchors.json` carries
  `anchoredLines` and it is tempting to treat them as per-line ground truth.
  They are not sound as such: only **32 of the 99** anchored findings match a
  single file, **34 span more than three**, and **2 of the 20** hand-audited are
  `localized: "diffuse"` — the right entity is named but the matched line is
  never the site the human meant. A line-level score would hand out credit for
  facts about the wrong code.
- **Quote the audit as "≤~14% false-match, 0 observed in 20"**, never 0%. The
  hand audit read 20 uniformly-sampled anchored findings and found zero
  spurious; the honest statement is the **95% upper bound on 0/20**, and it is
  the metric's error bar.
- **Martian's `derived.language` is PR-level, not file-level**, so the non-TS
  2.7% is not even real: both of its two hits are in **`.tsx` files**
  (`grafana-106778` is labelled Go). Per-language cells are approximate and the
  TS/JS vs non-TS split inherits the same slack.
- **Always print the candidate pool beside coverage, and the hit-density
  diagnostic.** An envelope that names *everything* scores 1.0 trivially —
  exactly the way an F1 is gamed by over-posting. On the WP1b run, corpus-wide
  coverage went **×2.00** (7 → 14) while the pool went **×2.09** (187 → 391), so
  hit density **FELL, 3.74 → 3.58 per 100 names**. The gain was *more names, not
  better names*, and catching that is precisely what the denominator is for.

#### What it proves, and what it does not

It proves an **upper bound** on the recall attributable to `code-facts` as a
seeder. It is **not recall, not precision**, and naming is **necessary but not
sufficient** — an envelope that names `parseTimeout` has not noticed that
`parseTimeout` returns milliseconds where the caller wants seconds. It has only
put the word on the table.

Read it before spending on a WP3 arm: a family whose identifiers the envelope
never names cannot convert, and that is knowable for free.

## The measurement protocol

> **Added 2026-08-22 by [WP11](11-speed.md) — a per-phase latency and cost
> instrument.** `PhaseMetric` now carries `durationMs` (the measured phase
> window), `agentMs` (summed result envelopes) and `costUsd`, so a run is
> readable off `scorecard.json` instead of by hand out of transcripts. Three
> properties worth knowing before reading one:
>
> - **Absent `durationMs` means the phase never started** (it was skipped), not
>   that it was instant. But `scripts/rescore.ts` can only back-fill `agentMs`,
>   so on a **back-filled** run every row lacks `durationMs` and a phase that ran
>   is indistinguishable from one that skipped (task #21).
> - **Attribution is by a `phase` stamp on the session envelope**, not by the
>   clock. The old rule — the last phase whose window opened at or before this
>   session's first line — is a point lookup and cannot express concurrency; six
>   fan-out branches opening within 35ms all resolved to whichever opened last.
>   Unstamped (pre-2026-08-22) sessions still take the window rule, so archived
>   runs reproduce their published numbers exactly.
> - **Rows sharing a `<phase>_branch_<name>` parent ran concurrently** and must be
>   combined with `max`, not `sum`. Six branches sum to ~708s across ~234s of real
>   time (task #20).
>
> The harness also gained **`--concurrency N`** (default 1, a no-op by
> construction), which is what makes an 8-case arm an hour rather than four.

The harness runs **the real production workflow** against a **real repo working
tree** — `seedWorkspacePrReview` (`apps/evals/src/seed.ts`) bare-clones the real
repo, checks out the PR head, and creates a **local bare `origin`** carrying both
base and head so `git diff origin/<base>...HEAD` works fully offline. The agent's
cwd *is* the checkout, with `AGENTS.md` and `.lastlight-skills/` as siblings —
production's exact layout.

> **Corrected 2026-08-21 ([10-design-review.md](10-design-review.md) §E1/§D1).**
> "Exercises unmodified" was **false for anything living in the sandbox image.**
> `apps/evals/src/run.ts:461-479` defaults to `--sandbox none` (in-process, on
> the host); `docker`/`smol` are **rejected** because they break the in-process
> GitHub mock; `gondolin` needs `/dev/kvm` and `sandbox-preflight.ts` refuses on
> darwin. **No eval configuration on a Mac can see `/opt/lastlight/`.** That is
> why `code-facts` ships inside the `lastlight` CLI and resolves
> `LASTLIGHT_FACTS_BIN` → `PATH` → the baked path, and why the eval preflight
> verifies tool versions against `toolchain.json` and refuses on a mismatch
> (§D3). Tools resolved from host `PATH` is a **third** deviation from
> production, taken deliberately against this harness's own one-invariant rule.

So every new phase, `prepare` and `falsify` included, exercises unmodified. Two
consequences worth stating:

- `prepare` will do a **real dependency install** in the eval sandbox, and unlike
  production there is no warm per-PR workspace to reuse. Budget the wall clock,
  and make the first WP4 measurement a single-case run. **Run the eval overlay
  with `probes: true` even though production defaults to `false`** — buying the
  measurement is the whole point of the ablation.
- `bootstrapAssets()` must run before any `getWorkflow`/`runWorkflow`, and
  `drainSessions()` before `collectMetrics()` — otherwise cost silently reports
  0. Both are existing traps; do not remove them.

### The discipline

From `plugins/lastlight/skills/lastlight-evals-loop/`:

- **Split is fixed for the whole loop.** Train: `1587-r1`, `1587-r2`, `1587-r3`,
  `1641`, `1641-r2`. Blind: `1680-r1`, `1680-r2`, `1667`. **Never diagnose on
  held-out ids.**
- **Held-out is consumed once per round, not once per candidate** — otherwise
  max-of-K selection bias creeps in.
- **One change kept per round.** v3's attribution problem (changes 2–4 shipped
  stacked; only O6→Critical cleanly attributed) is the cost of ignoring this.
- Single-case train runs are the cheap iteration unit (~$1–2.5, 10–30 min)
  versus a full arm (~$6–19, 45+ min). Use them for diagnosis; use full arms for
  gates.
- **Do not measure against `./instance`** — it is `cliftonc/lastlight-instance`
  (gpt-5.1, forked skills) and the wrong deployment. `skillspro` is served by
  `nearform/lastlight-nearform` (sonnet-4-6, no forked skills). Use
  `overlays/baseline` and `overlays/candidate`.
- **Do not trust a `diff-runs.ts` verdict on an incomplete run** — a missing case
  silently changes the split denominator, as it did once already.

### The ablation ladder

Run the same cases against each rung, so a gate answers *which* component earned
the movement:

| Rung | Arm | Cost |
|---|---|---|
| 0 | **the shipped `pr-review`** — ~~`2026-08-20_074355`, already measured~~ **must be RE-RUN, 2026-08-22.** Four changes moved what a run measures; every pre-2026-08-22 number sits on a different machine ([RESTART.md](RESTART.md) §4) | one baseline arm |
| 1 | + `facts`/`contracts`/`constants` obligations ([WP3](03-seed-and-survey.md)) | first spend |
| 0.5 | + the `spec` axis and split verdict (**WP0**, §D7) | first spend; no infrastructure |
| 2 | + `prepare` + `falsify` ([WP4](04-probe-oracle.md)) | ★ expected step change |
| ~~2b~~ | ~~+ `suite` + `mutants`~~ | **CUT** (§D13) — the rung whose only purpose was to decide whether `mutants` earned its keep cannot return a readable answer on a 25-finding gold set. Coverage takes the `tests` family's place |
| 3 | + N-way survey union | |
| 4 | + adjudicator, per-family thresholds, attention boundary ([WP6](06-adjudicate.md)) | |
| 5 | + repo memory ([WP7](07-review-memory.md)) | |

**Rung 1 → 2 is the "is the oracle worth it?" question**, and rung 2 → 2b is the
separate, weaker question "is mutation seeding worth a full test run?". Keeping
them apart is why [WP4](04-probe-oracle.md) has three config switches instead of
one. Production defaults both to off; the answer comes from these rungs, not from
an opinion.

**Rung 0 needs no re-run.** The baseline scorecard stores `posted` / `gold` /
`matched` per case, so micro-recall and SNR are arithmetic over data we already
have — see "back-fill" below. Every Δ in this plan is measured **against the
shipped reviewer**, not against a prototype.

**Candidates v1/v2/v3 are not rungs.** v1 moved train Δ ≈ 0.000, v2 was reverted
and deleted, and v3 is a regex prototype of the mechanism rung 1 builds properly.
Measuring v3 at arm scale would cost ~$15–19 to characterise a machine we are
deleting. Its single-case result stands as *evidence for a design choice*
([00-evidence §3](00-evidence.md)); the hypothesis gets validated at arm scale by
rung 1 itself.

## Acceptance criteria

1. Micro-recall and SNR appear in the scorecard, in `ModelSummary`, and in
   `diff-runs.ts`'s per-split output.
2. The empty-gold case (`1641`) is visibly flagged in the report as a precision
   canary, so nobody reads the arm mean as a recall number again.
3. Per-family attribution renders for an arm that emits evidence packets, and
   degrades cleanly for one that does not (the baseline).
4. `apps/evals/src/mechanism.test.ts` stays green — it is AI-free and in the
   default `npm test` suite.
5. Re-grading the existing baseline scorecard reproduces its published F1
   exactly. **If it does not, the metric change has altered history and must be
   versioned rather than applied in place.**
6. **Added 2026-08-21.** Evidence coverage reports all three numbers with all
   three denominators, **split** TS/JS from non-TS, with the candidate pool and
   hit density beside every coverage cell. A run that prints a pooled coverage
   figure alone fails this criterion.

## Non-goals

- **No change to the LLM judge's prompts.** Comparability with the existing
  baseline run is worth more than a prompt improvement here.
- **No new eval cases.** The 8-case set is the instrument; growing it is a
  separate, deliberate exercise with its own anti-spoil checks.
- **No change to `--judge-with-diff`'s default** (off, for Martian-offline
  parity).
