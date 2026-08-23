# RESTART — pick this plan up in a new session

> **Starting fresh on 2026-08-23 or later? Read [NEXT.md](NEXT.md) first.** It is
> two pages: the four run ids that are now the comparators, what a no-spend deep
> scan of the artifacts found, and five small experiments in cost order. This
> file stays the operational reference — tree state, the commands, and §4's ten
> traps — and §2b below carries the measured numbers.

Say *"restart the plan in `docs/plans/review-evidence-pipeline/`"* and start
here. This file is the operational entry point: what state the tree is in, what
is built, what to do next, and which traps will silently waste money.

For *why* the architecture looks like this, read [README.md](README.md) (thesis +
locked decisions) and [TLDR.md](TLDR.md) (one page). For the execution protocol
and the human sign-off list, [HANDOFF.md](HANDOFF.md).

> **Rewritten 2026-08-22.** The previous version was 716 lines of accumulated
> archaeology, most of it describing work now done or premises since falsified.
> Everything cut is still in git history.

## 0. Tree state — READ THIS FIRST

> **2026-08-23, later: that work is COMMITTED**, as `5fa06da1` ("the
> deterministic seed was decorative"). The warning below stands as a standing
> rule rather than a description of today: `facts`/`contracts` read head off the
> **filesystem** while the changed set comes from git, so a dirty tree silently
> invalidates §1's `selfcheck` and makes the base view partly a claim about
> somebody's edits. Check before trusting any `git`-based comparison.

```bash
git -C ~/work/lastlight status --porcelain | wc -l   # expect 0 ONLY on a clean tree
git -C ~/work/lastlight log --oneline -1
```

## 1. Prove the tree is sane

```bash
cd ~/work/lastlight
pnpm turbo run typecheck test build            # expect 25/25 (2026-08-23: 3769 tests)
pnpm --filter lastlight-code-facts selfcheck   # 31 of 31 analysed, exit 0
```

`selfcheck` is the fastest honest signal on the deterministic layer. It is
deliberately **not** in CI — `actions/checkout` defaults to `fetch-depth: 1`, so
`HEAD~1` does not exist on a runner. **Run it against a clean tree**:
`facts`/`contracts` read head off the filesystem, so on a dirty tree the default
`HEAD~1..HEAD` invocation compares old blobs to new files and is meaningless.

**At `1cbc1f9d` the bare invocation FAILS, and it is not a defect.** WP11 is a
large commit; it lands **48 contract deltas** against `MAX_CONTRACTS = 40`. That
ceiling is calibrated on an ordinary commit (WP1 landed 19) and is an alarm on
*extraction* going wrong, not a budget on commit size — the census is all added
exports in `apps/evals/dashboard/src/lib/session.ts`, `format.ts` and
`src/metrics.ts`, which is what that commit did. The two conditions that would
mean something — a **phantom removal** and the **90 s wall clock** — both passed.
Read the census before believing either verdict, and confirm against a
normal-sized commit:

```bash
cd ~/work/lastlight/packages/code-facts
npx tsx scripts/selfcheck.ts --repo ../.. --base 87bf7f13~1 --head 87bf7f13  # OK
```

**Environment the measurements assume.** `opengrep` 1.27.1 and `gitleaks` 8.21.2
on `PATH`, or the whole `patterns` family is stamped `missing` and silently
contributes nothing. `lastlight-facts toolchain` prints what actually resolved.

## 2. What is built

The whole pipeline is **off by default** (`review.analysis.enabled: false`), and
`false` reproduces the shipped two-phase review byte-for-byte.

```
prepare → facts → seed → survey (6 branches, CONCURRENT) → falsify
        → review → adjudicate → reconcile → post-review
```

| WP | Status |
|---|---|
| WP0 spec axis, WP1/1b code-facts, WP8 the eval instrument | landed earlier |
| WP3 seed + six surveys · WP4 prepare + falsify · WP6 adjudicate | landed earlier |
| **WP11 speed + the correctness defects it uncovered** | landed 2026-08-22, committed `1cbc1f9d` — [11-speed.md](11-speed.md) |
| WP2 sandbox image | not started — **blocks production, not measurement** |
| WP5 parallel phases | **PARKED**, and its carve-out was taken — [05-parallel-phases.md](05-parallel-phases.md) |
| WP7 review memory · WP1c grammars · WP9 external validation | not started |

**WP2 is what stops this reaching production at all**: `lastlight-facts` is not
in the sandbox image, so the pipeline can be *measured* (the eval runs
`--sandbox none` on the host) but not *switched on*.

### What WP11 changed, in one list

- **`type: fanout`** — the six surveys are one DAG node running six concurrent
  agent sessions in one `withSandbox`, with per-branch ledger rows
  `<phase>_branch_<name>`. Backend ceiling `none`/`docker` 6, everything else 1.
- **A per-phase instrument** — `durationMs` / `agentMs` / `costUsd` on every
  `PhaseMetric`, so a run is readable off `scorecard.json` instead of by hand out
  of transcripts.
- **`--concurrency N`** on the eval harness (default 1, a no-op by construction).
- **Family-namespaced hypothesis ids** `<family>-NNN`, assigned deterministically
  at ingest.
- **`lastlight-facts findings --ledger`** — the conservation checklist the
  adjudicator runs for itself.
- **The `pr-review` skill no longer re-shallows the checkout** (§4, trap 1).
- **The spec axis works for the first time ever** (§4, trap 4).

### Measured, `prreview__skillspro-1587-r1`, Haiku, one case each

| | before WP11 | run C | run D | run E |
|---|---|---|---|---|
| total | **29m13 / $2.49** | 11m59 / $2.01 | 11m43 / $2.05 | **11m36 / $2.34** |
| six surveys | 851s (chained) | 242s span | 211s | 234s |
| `adjudicate` | 426s **+ 274s retry** | 272s, no retry | 328s, no retry | 311s, no retry |
| gold / posted | — | 1 of 3 / 3 | 1 of 3 / 7 | 1 of 3 / 4 |

Run C's survey span came from the harness log, not its scorecard — run C
predates the attribution fix, so its branch rows carry no durations. D and E read
off the scorecard.

**Conservation passed on the first attempt in all three runs, twice against the
honest 30-id gate.** That is the WP11d claim, and it is the one quality-adjacent
result here that is solid.

**Nothing in that table is a recall result.** One case, one run per
configuration. The detection floor is ≈0.24–0.28 micro-recall on a 25-finding
gold set; a single gold moving is McNemar **p = 0.50**.

## 2b. THE RE-BASELINE — the first result that clears the floor

**Run 2026-08-22, 8 cases each, Haiku, `--concurrency 4`, on fixtures repaired
the same evening (§4 traps 9 and 10). These are the comparators. Everything
before them is void.**

**The wp3 arm was run THREE times, identically. Read every column or you will
misreport this.**

| | baseline `183835` | run 1 `184650` | run 2 `194234` | run 3 `201607` | mean |
|---|---|---|---|---|---|
| **micro-recall, arm** | 0.000 | **0.320** | **0.080** | **0.200** | **0.200** |
| train (13 gold) | 0.000 | 0.462 | 0.000 | 0.154 | 0.205 |
| blind (12 gold) | 0.000 | 0.167 | 0.167 | 0.250 | 0.194 |
| matched | 0 of 25 | 8 | 2 | 5 | — |
| posted | 1 | 47 | 23 | 44 | — |
| SNR | — | 0.205 | 0.095 | 0.128 | — |
| cost | $2.28 | $15.65 | $17.55 | ~$17 | — |

**Train and blind are the same to within noise (0.205 vs 0.194).** The run-1
reading that blind was the weaker half did not survive two more runs; blind is
actually the *steadier* half. See [NEXT.md](NEXT.md) for the artifact-level
scan, including the finding that **obligations are byte-identical across runs**,
so every bit of this spread is downstream of `seed`.

Same code, same fixtures, same model, same command every time. **Matched gold
went 8 → 2 → 5.** All eight workflows succeeded in all three. `diff-runs` returns
**KEEP** on run 1 and **REVERT** on runs 2 and 3 — from one configuration.

**So the honest claim is a band, not a point.** Pooled across all three runs the
pipeline matched **15 of 75** gold-instances (0.200) against the baseline's
**0 of 25**, and it has never lost a baseline hit (`−0 lost` in every run).
*That* is the result: **the pipeline finds gold the shipped reviewer never
finds, and how much it finds on any given run is wildly unstable.** Neither
0.320 nor 0.080 is "the" number, and 0.320 was a favourable draw — it is the one
that cleared the ≈0.24 floor, and its repeat did not come close.

Per-case, run 1 → run 2: `1587-r2` 3/15 → 0/5, `1680-r2` 1/8 → 0/0, `1667` 0/3 →
0/0, `1680-r1` 1/4 → **2/7**. Even the *direction* is per-case random.

**`1641` is a precision-canary hit worth its own line.** Gold 0, and run 2 posted
**2 findings on a clean PR** where run 1 posted none — F1 1.000 → 0.000 on that
case, and the whole of `REGRESSED(train)`. The zero-gold case is doing exactly
the job [review-metrics.ts](../../../apps/evals/src/review-metrics.ts) keeps it
for.

**What this still does NOT establish**, beyond the instability above:

1. **The blind split has never been significant** — +2 of 12 in both runs,
   McNemar **p = 0.500**, and 0.167 is *below* the floor. Generality is
   [WP9](09-external-validation.md)'s unmade claim.
2. **6.9–7.7× the cost**, 23–47 posted against 25 gold. SNR 0.095–0.205: between
   one true finding per four false and one per ten.
3. **n = 3 is still small** for a spread this wide, and the mean (0.200) sits
   *below* the ≈0.24 floor while one draw sat above it. The next honest step is
   more repeats, not another lever — you cannot detect a lever's effect inside
   this much noise.

The baseline half is its own result: **the shipped reviewer posted one finding
across eight PRs carrying 25 real defects**, on clean fixtures, and matched none
of them. That is lower than the dead 0.040 comparator, and it is the honest floor
this plan is measured against.

## 2c. 2026-08-23 — three defects, and a REGRESSION that explains the design

**Read this before §3. It changes what the next experiment is.**

### The instrument, first

The union/intersection reading is now the honest one, and it supersedes the
"pooled 15 of 75" framing above — that was a *mean* wearing a pooled coat.
Recomputed from the three stored judge traces at zero spend:

| | recall over the 25-gold set |
|---|---|
| per-run mean | 0.200 |
| **union across the three runs** | **0.440** (11 of 25) |
| **intersection — found by all three** | **0.040** (1 of 25) |

**One gold finding in twenty-five was found by every run.** Discovery is
near-disjoint run to run. And the measured band (0.240) is the **detection floor**
(0.24) to two decimals: the noise on three identical runs is exactly the size of
the smallest effect this gold set can resolve, so no single-arm comparison can
ever detect anything smaller than the whole band. `varianceRollup`
(`apps/evals/src/review-metrics.ts`) computes all of it and is pinned against
these numbers; `--repeats N` runs a whole arm N times as sibling run dirs.

### Three defects, all measured, all in the seed→model path

1. **19–24% of survey branches never read their obligations.** Across 120
   non-spec branches in the three stored runs, 133 obligation reads split
   *totally*: 98 relative reads succeeded, **27 workspace-root-absolute reads
   ENOENT'd, 0 succeeded**, 8 checkout-absolute succeeded. The agent's first turn
   joins the prompt's relative path onto the only absolute base it has been
   handed — its skill bundle, one level above the checkout. The branch then took
   the prompt's *"if the file does not exist, work the diff directly"* escape
   hatch and free-styled. **A seeded pass silently became an unseeded one.**
   Fixed by `FanoutBranch.context_file`: the harness reads the block at
   `hostAgentCwd` and appends it, so the model resolves no path at all.
   `gondolin` (the production default) is structurally immune; `none`/`docker`/
   `smol`/`kubernetes` were all affected, so **WP2 is what would have shipped
   this to production**.
2. **The discharge contract was never EXPRESSIBLE.** `seed-render.ts` demanded
   one of QUOTE/ABSENT/PARTIAL/PROBE per obligation and its prescribed row shape
   **had no field to record one in**. Measured across both preserved runs, all 8
   cases, every family: **0 of every obligation ever carried a code — 0/31, 0/34,
   0/40.** Not non-compliance; impossibility. Fixed (a `discharge` field, plus
   `failureScenario` and a worked exemplar), and an obligation's own requirement
   label was renamed `discharge:` → `expects:` because a model copying it wrote
   `either`, which grades `bad-code` and would have made the gate unsatisfiable
   forever.
3. **`spec` prescribed no row shape at all**, so the model invented one per run
   (`verdict` on 2026-08-23, a nested `obligations[]` form before). Unified with
   its five siblings. Note `discharge --family spec` **passes always** today —
   `seed.ts` writes a `spec` row at `measured: false`, so the gate takes the NOT
   MEASURED branch and returns satisfied with no `spec.jsonl` on disk. It is
   therefore *weaker* than `test -s`, which is why `spec` keeps `test -s`.

### The regression — and it is the most informative result in this plan

One case, `prreview__skillspro-1587-r2`, `--repeats 3`, $7.00:

| | old code (3 runs) | 2026-08-23 (3 repeats) |
|---|---|---|
| matched | 3 / 0 / 2 | **0 / 0 / 0** |
| union | **4 of 5** | **0 of 5** |
| posted | 15 / 5 / — | 6 / 8 / 7 |

Obligation discharge went from 0/33 to **33/33** and recall went to zero. The
mechanism is legible in the artifacts:

- **Every gold missed is a *"what does the code fail to check"* question** — a
  lower-cased key compared against a non-normalised set; `issuedAt` parsed and
  used only as a sort key, never compared against
  `SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS` (*the one gold this project has ever
  converted*); `user?.email` from a decode that never checks expiry.
- **Every one of the six findings posted instead is a *"where else does this
  value appear"* question** — a constant fragmented across three modules, a
  hardcoded `OAUTH_URL`, storage keys redefined in tests.

**The `enforcement` family has become a constant-duplication detector.** It
answers *"where is this constant referenced?"* — mechanically satisfiable, always
answerable, never a defect — instead of *"what does the code fail to compare?"*
It posted "domain constant fragmented across three modules" while the gold
sitting on the very constant the new exemplar is about went unreported.

**Two causes, and this run cannot separate them, because two variables were
changed at once — the one-at-a-time rule, broken, with the predicted result.**

- **C1 — the obligations ask the wrong question.** Making a wrong question
  *mandatory* and mechanically satisfiable reorients the pass from hunting to
  clearing a checklist. 23 of 33 discharges were `QUOTE` (= "found a line, it is
  fine").
- **C2 — the seed itself may suppress discovery.** Uncomfortable, and live: the
  branches that *lost* their obligations free-styled off the diff, and the old
  recall may have been coming from exactly the failure that got fixed. Seed loss
  went ~24% → 0% and union went 4/5 → 0/5 in the same change.

Both are worth fixing and they are not exclusive. C1 is the one the evidence
names directly; C2 is the one that would overturn the plan's thesis, so it needs
a control rather than an argument.

## 2d. 2026-08-23, later — the gates were never wired, and what the funnel says

**Read this before §3. It changes what X1 should measure.**

### The mechanism gates have never produced a value

§0b of [08-evals.md](08-evals.md) is unambiguous: *"WP3's and WP4's gates are
mechanism gates"* — obligations, discharge rate, the per-family funnel — and
micro-recall is *"reported at every rung, never gated on"*. The mechanism gates
were **declared and consumed but never produced**.

`ReviewPipelineStats` (`apps/evals/src/schema.ts`) is read by `boundaryMetrics()`
and `familyFunnels()` (`apps/evals/src/review-metrics.ts`), both of which begin
by filtering for `review.pipeline`. **No run has ever carried one.** Verified
against all four keeper runs: no `pipeline` key on any result. So both functions
have returned `undefined` for their whole existence, internal recall has never
been measured on anything, and every decision in this plan fell back to posted
micro-recall — the number this file says is unusable below 0.24.

Compounding it: `varianceRollup` / `bandVerdict` / `groupRepeats` are
implemented and tested and **nothing calls them**. Union and intersection existed
only inside the dashboard, as a second implementation. `run.ts`'s own help text
claimed `scripts/rescore.ts` rolls up a band; it does not.

Both are now wired (`apps/evals/src/review-pipeline-stats.ts` — a deterministic
read of the artifacts the run already writes, plus one MATCH-only judge call per
case for internal recall), read headlessly by `apps/evals/scripts/band.ts`, and
back-filled onto every preserved run by
`apps/evals/scripts/backfill-pipeline.ts` (`--no-judge` refreshes the free half
without re-spending; the judged half is carried across and the write refuses if
it moves).

### And the first thing internal recall said

**Both 8-case runs discovered 12 of 25 — the same number — and said 8 and 5.**

| | run 1 `184650` | run 3 `201607` |
|---|---|---|
| internal recall | **0.480 (12/25)** | **0.480 (12/25)** |
| …on a posted tier | 9 | 9 |
| …withheld by the boundary | 1 | 3 |
| …tier unknown (no `disposition.json`) | 2 | 0 |
| credited by the posted-review judge | 8 | 5 |
| posted recall | 0.320 | 0.200 |

The 0.240 band this plan has spent pages characterising as *"the pipeline is
noisy"* is **downstream of discovery**, and discovery was identical. Note also
that the boundary is not the main channel: nine matched findings were on a posted
tier in both runs and the judge credited eight and five, so **something loses a
true finding between "tiered for posting" and "recognised in the review text"**.
Two candidates — the body buries it among anti-findings (run 3 posted 44; rep1
posted 27 body bullets of which 17 were clean discharges), or grader noise
between two matching passes. `rescore.ts --repeat-judge N` separates them and is
the cheapest open question in this plan. See [NEXT.md](NEXT.md).

**This retires §3c as written.** *"Both misses were discovery failures … the
filters demonstrably kept their hands off gold"* was traced on one run's three
gold; over 25 it does not hold.

### The funnel, read off the preserved workspaces at zero spend

Reproduces [NEXT.md](NEXT.md)'s independently hand-counted hypothesis volumes
exactly (run 1 → run 3: 18→43, 10→23, 10→19, 45→45, 42→39), which is what says
the reader is honest.

`prreview__skillspro-1587-r2`, the comparator case:

| | 08-22 run 1 | 08-22 run 3 | 08-23 rep1 | rep2 | rep3 |
|---|---|---|---|---|---|
| obligations | 33 | 33 | 33 | 33 | 33 |
| hypotheses | 42 | 39 | 45 | 48 | 46 |
| **carrying a discharge code** | **0** | 6 | **33** | **36** | **41** |
| **clean discharges** (QUOTE + `failureScenario: null`) | 0 | 0 | **23** | **25** | **23** |
| findings | 37 | 36 | 32 | 25 | 16 |
| posted (inline+body) | 14 | 7 | **30** | 8 | 7 |
| — of which trace to a clean discharge | 0 | 0 | **17** | 0 | 0 |
| internal | 22 | 29 | **2** | 17 | 9 |

**A clean discharge requires `failureScenario` PRESENT and explicitly `null`,
not merely absent**, and the distinction decides whether any of this is
measurable. Under the minimal contract the field did not exist and the `spec`
pass's invented row shape has nowhere to record one, so 37 rows across the
preserved 2026-08-22 runs are `QUOTE` with no key at all. Reading absence as
"clean" marks those as anti-findings on the strength of a field nobody asked
for — 28 findings across 4 of 16 instances, measured. On the strict reading the
count is **0 across all sixteen minimal-era instances** and 71 across the three
full-contract repeats. The eval instrument
(`apps/evals/src/review-pipeline-stats.ts`) and the attention boundary
(`apps/server/src/engine/github/review-poster.ts`) key on the same predicate and
resolve citations through the same canonical `<family>-NNN` identity; they have
to, or the instrument reports a demotion that did not happen.

Two claims, and only one of them generalises:

- **Robust — generation.** Half to two-thirds of everything the surveys now
  produce is a clean quote: *"I looked, I quote the line, it is fine."* Same in
  all three repeats. This is **C1's mechanism measured on a number** rather than
  inferred from prose, and it is the strongest single piece of evidence in the
  C1/C2 question.
- **NOT robust — posting.** The boundary held those back in rep2 and rep3 and let
  17 through in rep1. It is not *inert*; it is **wildly variable** — 30 / 8 / 7
  posted from near-identical generation. Confidence is uniformly ≥0.7 (median
  0.95 → 1.00, minimum 0.75), so `internalFloor: 0.15` and the family thresholds
  (0.30–0.60) rarely bind on their own merits and the tier lands nearly at
  random. **The attention boundary is itself a large, previously unattributed
  variance source**, which is more useful than "it is inert".

### Three smaller findings from the same read

1. **`1587-r3` in keeper run 1 has no `disposition.json`** — and `reconcile` and
   `post-review` both ran, and it posted 9 findings including a gold match. By
   §5's own rule that means the attention boundary never ran on one of the eight
   comparator cases. Same class as §4 trap 5, sitting undetected inside a run
   this file treats as a baseline.
2. **Conservation is checked in one direction only** — every hypothesis must
   reach a finding, nothing requires the reverse — so a finding citing no
   hypothesis is invisible to the discharge histogram. Measured it is **rare**:
   0 on rep1, 1 each on rep2 and rep3. (An earlier draft of this section said
   "8 of 32 on rep1", which was an artifact of a hand-written probe that resolved
   citations against `row.id` only — `spec` rows carry no `id`, so eight findings
   citing `S-*` looked unprovenanced. Resolve through the canonical
   `<family>-NNN` identity, as `hypotheses.ts` does, and they resolve fine.)
3. **`disposition.json` re-anchors line numbers** (`APIContext.tsx:1042` →
   `:1063`) so GitHub can hang a comment on a changed line. Any tool joining
   `findings.json` to `disposition.json` on `path:line` silently loses ~a third
   of the findings, and a failed join is indistinguishable from "never tiered".
4. **§2c defect 3's fix has never been exercised.** `spec.jsonl` in all three
   08-23 repeats still carries the invented `{verdict, rationale}` shape — the
   renderer unification landed in `5fa06da1` at 07:21, after those runs at
   05:33–05:54. No measured run has ever used the unified spec row.

## 3. What to do next

**Superseded 2026-08-23.** The old §3a ("more repeats before any lever") is
discharged — the band exists, and `--repeats` makes it cheap. The ordering below
replaces it.

### 3a. The next experiments — in this order, one variable each

Every one is on `prreview__skillspro-1587-r2` with `--repeats 3` (~$7, ~30 min)
unless it says otherwise. That case now has a **hard comparator on both sides**:
old code 3/0/2 with union 4/5, 2026-08-23 code 0/0/0 with union 0/5. A single
case is normally unreadable; a union that moves 4 → 0 → back is not.

**X1 — separate C1 from C2. The control, and it comes first.** Run with
`context_file` ON (branches all receive their obligations) but the obligations
themselves rendered as the pre-2026-08-23 block: `--contract minimal`. That is
the seed delivered reliably, asking the OLD question.

**`minimal` is NOT "no discharge contract", and describing it that way will make
you misread the arm.** The four codes and *"Reading a file is not a discharge"*
are older than the regression — `5fa06da1` added exactly **three lines** to that
block. What `minimal` removes is those three lines (the pointer to the row's
`discharge` field and to the id checklist), the un-truncated id checklist itself,
the `failureScenario` requirement, and the worked exemplar. The block still
demands a discharge and gives the survey nowhere to record one, which is exactly
why compliance measured 0/31, 0/34 and 0/40 under it — and reproducing that
faithfully is the point. `DISCHARGE_MINIMAL` is byte-identical to `5fa06da1^`,
verified both directions; `full` is byte-identical to today.

The selection travels as a field on `obligations.json`, not as a render
argument, so the block a survey was handed, the contract `checkDischarge` graded
it against, and the artifact read three weeks later cannot disagree.
`checkDischarge` degrades to the `test -s` floor under `minimal` — grading a
field nobody was told to write would make five of six branches record
`condition_not_met` on every run of the control arm, a pipeline-failure
signature the arm would then have to be read around.
- Recovers to ~4/5 union ⇒ **C1 confirmed**: the discharge contract is what cost
  the recall, and the fix is the question, not the delivery.
- Stays at 0/5 ⇒ **C2 is live**: reliable seeding itself suppresses discovery,
  and the free-styling branches were carrying the old recall. That would overturn
  this plan's thesis and is worth knowing before another lever is built.

**Read X1 on INTERNAL recall, not posted recall** (§2d). Posted recall on this
case now runs through a boundary that put 30 findings on the PR in one repeat and
7 in the next from near-identical generation; reading a discovery question
through that much attention-layer noise is how the last three arms got their
spread. Internal recall — gold matched by anything the pipeline *generated*,
tiered or not — is the discovery number, and it is what C1-vs-C2 is actually
about. Both are now on the scorecard.

**A clean-discharge rule is structurally inert under `minimal`, so anything
bundled into X1 that keys on discharge is NOT measured by X1 and must not be
reported as if it were.** The mechanism is not "no row carries a code": of 447
minimal-era rows, **74 carry a `discharge`/`status` string and 43 of those are
one of the four codes**. It is that a clean discharge requires `failureScenario`
present and `null`, and the minimal row shape has no such field — measured,
`cleanIds` is **0 across all sixteen** minimal-era instances and the tiering is
byte-identical. The demotion needs a **`full`-contract arm** to be measured at
all.

**And the other 31 invented a fifth code.** `N/A` ×11, `enforced` ×6,
`needs_investigation` ×4, `hypothesis` ×3, `met_with_caveat`, `backend_only`,
`enforced_by_http`, `potential_future_issue`. So the minimal block fails in two
ways at once — it asks for a discharge with nowhere to write one, *and* the
models that do answer largely answer off-vocabulary. `N/A` being the most common
is why `SPEC_DISCHARGE` carries a *"THERE IS NO FIFTH CODE"* paragraph. Read
X1's discharge histogram with that in mind: `none` there is two different
failures added together.

**X2 — rewrite what the obligations ASK** (blocked on X1 only if X1 says C2).
The catalogue is drafted in [NEXT.md](NEXT.md) from the `1667` forensics. The
shape of the cure, and it is one line per family:

> Stop asking whether the line exists. Ask **which two distinct situations that
> line treats identically.**

`enforcement` currently asks *"quote the line that enforces THIS constant"* — and
**any use of the constant satisfies it**, which is exactly how the one converted
gold in this project's history was discharged `QUOTE` against a line that
mentions the constant and compares nothing. `state` asks about untouched call
sites, which points *away* from the changed body where 4 of 5 of `1667`'s gold
live. Both are answerable without looking at the defect.

**X3 — read the survey prompts as prose, not as plumbing.** Recorded because a
human read them on 2026-08-23 and judged them *"not well structured"*, and that
is a distinct claim from any measurement here. The five family prompts are
57 lines of which ~50 are byte-identical boilerplate; the family-specific content
is one paragraph, and the actual contract lives in the block emitted by
`seed-render.ts`. So the prompt is mostly preamble and the load-bearing text is
somewhere else — worth restructuring on its own merits, but **it must not be
bundled with X2**: two prompt changes in one arm is candidate v1's
four-changes-as-one, and this file already carries one instance of that mistake
made on 2026-08-23.

**X4 — the `1667` question catalogue, applied.** Only after X2 shows the shape
works on a case that has a comparator. `1667` is 0/5 in every run ever recorded
and its gold is cross-cutting ordering and rate-limit material; it is the
hardest case in the set and the wrong one to iterate against.

**X5 — re-establish the 8-case band.** `--repeats 3` on all eight (~$50). Only
worth spending once a one-case arm has recovered its union; until then it buys a
precise measurement of a known regression.

**Do NOT run an 8-case arm to decide any of X1–X4.** The one-case comparator is
~7× cheaper and, for these questions, strictly more informative — the union on
one case with a known before/after moves; a micro-recall delta on eight cases
sits inside the 0.24 band.

### 3b. The quality levers — approved, designed, UNBUILT

All four were approved and none were built; WP11 went into speed and into the
correctness defects that surfaced. Each needs its own arm, one variable at a
time.

| # | Lever | Why it is worth it |
|---|---|---|
| **f1** | **Stage the diff once** | 93 bash calls across the six surveys, ~30 re-deriving one fixed range that `facts.json` (137 KB) already holds. `survey_branch_contract` at 234s **is** the whole survey span, and it is the branch doing the most re-derivation. Cuts turns, which cuts latency *and* spend |
| **f4** | **Reshape `review` when the pipeline is on** | It still runs a full independent review — 137s and $0.30 — and in run A produced `APPROVE` with **zero findings while 41 hypotheses sat unread beside it**. **It cannot simply be skipped**: `post-review` depends on it with `all_success`, and a skipped node is not `succeeded`. **Note the `review` node declares no `prompt:` at all** (`pr-review.yaml`), so it hits the skill-only fallback in `phase-executor.ts` — f4 means ADDING a prompt (or editing `skills/pr-review/SKILL.md`), not editing one. `{{#if analysisEnabled}}` does not exist anywhere in the repo either; the gating idiom here is `skip_if: "analysisEnabled != true"` |
| **f3** | **A stronger adjudicator** | `models.review-adjudicate`, falling through to `models.review`. Haiku-beats-Sonnet is a *recall* result about *discovery*; adjudication is ranking over an already-generated set, a different task |
| **f2** | **Thinking effort** | The survey phases declare **no `variant:` at all**, so they inherit agentic-pi's default. Wire `{{variants.review-survey}}` through and measure |

**The guardrail on all four.** If any shows precision up and recall down, that is
the fifth reproduction of locked decision 1, not a tuning opportunity. No
adjudicator has ever beaten keeping everything (AACR F1 0.825, two models, 2,145
labelled comments, neither beat it).

**Two structural facts that bound what any of these can buy**, both confirmed
2026-08-23 by reading the source rather than the plan:

- **`tests` has no seeder.** `SEEDABLE_FAMILIES` lists five and only four
  seeder functions exist — there is no `seedTests` in `packages/code-facts/src/seed.ts`.
  Combined with `prepare` being skipped 8/8 (so no coverage artifact is ever
  produced), that family is dead at both ends. **One of the six fan-out branches
  cannot produce anything**, and has not in any measured run. Build the seeder or
  drop the branch; running it is paying for a sixth of the survey to write
  `NOT_MEASURED`.
- **The four mint rules are four different conditions, not one.** The
  `referenceCount − referencesInDiff > 0` shorthand this plan uses describes only
  `state` — and even there the code filters the **capped** `references[]` array
  and additionally requires `changedHunks.length > 0`. `contract` mints on
  `consumersOutsideDiff.length > 0 && change !== "added"`, `enforcement` on
  candidate count, `security` on a scanner hit in the same file. "Widen the
  minting rule" is four decisions with four different failure modes.

**And `models.review-adjudicate` does not exist** — `adjudicate` resolves
`{{models.review}}`. Every measured run was `runType: "models"` with Haiku
**forced on every phase**, adjudicate included, so f3 has never been tested even
by accident.

### 3c. Where the evidence says quality actually lives

**Seeding, not tiering.** Forensics on run C traced all three gold end to end:
both misses were **discovery failures**. `dropped: []`; no gold-bearing finding
was demoted, tiered `internal`, or deleted. The filters demonstrably kept their
hands off gold.

The sharpest single data point in this whole plan: for gold G2, the survey agent
**read the code containing the exact asymmetry the finding is about** — two maps,
one lowercased and one not — and never formed the question. That is not an
affordance gap and not a filter problem. It is [TLDR.md](TLDR.md)'s thesis at
close range: *the model's question set does not contain the human's questions.*

Tiering is not exonerated (run A cannot be read on it — see §4 trap 5), but it is
not implicated either.

### 3d. Open backlog

Tracked as tasks; none blocking.

- **#6** the same `--depth` hazard in `skills/demo/SKILL.md:123` and
  `workflows/prompts/demo.md:62`. Lower stakes — demo does not review forked PRs.
- **#8** an eval fixture with **real base divergence**. Today the gate is
  structurally blind to diff-range corruption (§4 trap 1).
- **#9** pin the `--ledger` mechanism in a test — nothing asserts the adjudicate
  prompt still instructs it, so a prompt edit could silently drop it.
- **#11** the dashboard's `processMessages` pairs a tool call with the next
  matching result *after it in the array*; it survives concurrency only because
  `tool_use_id` happens to be globally unique — a property of the id generator,
  not of that code.
- **#15** the evals dashboard has **no test infrastructure at all**. Two real
  bugs today were caught only by hand-inspecting live data.
- **#20** "Where the time went" sums branch durations; six branches sum to ~708s
  across ~234s of wall clock, a ~3× overstatement. Concurrent siblings need max.
  Rows sharing a `_branch_` parent are the signal — no new field needed.
- **#21** `rescore.ts` cannot recover `durationMs` (it sums result envelopes), so
  back-filled runs conflate "skipped" with "un-instrumented".
- **#23** `add-case` does not capture linked issues, so every new pr-review case
  reintroduces the dead spec axis.
- **#24** `review.analysis.maxObligations` is **dead config on the workflow
  path.** The `seed` phase never passed `--max-obligations`, so the operator's
  value has never reached the seeder — `code-facts`' own default applies, and it
  happens to be the same 40, so this is inert-but-dead rather than wrong. Thread
  it the way `--contract` now is. Found 2026-08-23; deliberately not fixed
  mid-experiment, because changing the effective budget would confound X1.
- **#25** A finding may **invent an obligation family**. One backfilled run
  carries a `correctness` row — a family outside the six-family partition,
  self-declared by the finding. Hypothesis families come from the FILENAME and
  cannot drift; `posted`/`matched` come from the finding's own `family` field and
  can. Decide whether an unknown family is a fact to record or a value to reject.

Longer-standing, from WP1b and unchanged: fingerprint collisions silently drop
findings (13 corpus findings → 11 fingerprints); `patterns` scopes to changed
*files*, not hunks; `facts`/`contracts` read head off the filesystem while the
changed set comes from git, which diverges silently on a dirty tree.

## 4. Traps that silently waste money

Every one of these has already cost something. **Three of five attempts at
running an arm measured the wrong thing, and none of them failed loudly.**

**1. The `pr-review` skill used to re-shallow the checkout — and the eval cannot
see it.** `skills/pr-review/SKILL.md` instructed `git fetch origin <base>
--depth 50`. A depth fetch writes `.git/shallow` **even into a complete clone**,
re-cutting history at 50 commits and severing the merge base `ensureBaseAvailable`
had just paid to build — in **6 of 7 agent phases per review**. Corpus: 9 of 50
real PRs fork further back than that; one is 6125 files two-dot against 3 at the
merge base. **Fixed** (check-then-repair, deepening both sides — unshallowing the
base alone leaves HEAD with no reachable ancestor, which recurred twice in
production). **The 8-case gate is structurally blind to this class**: `add-case`
pins `base_commit` to the *merge base*, so two-dot ≡ three-dot in every fixture
and a depth cut cannot sever a tip. Task #8.

**2. Any conservation result from before 2026-08-22 is void.** Hypothesis ids
collided across families — `contract.jsonl` and `security.jsonl` both emitted
`H-001..` — so covering five strings "accounted for" eight hypotheses and the
gate reported **0 uncovered, exit 0**. After the fix the same artifacts report
**2 of 30, exit 3**. Compounding it: only **8 of 30** hypotheses carried an `id`
at all, so 22 were structurally invisible to the gate.

**3. The globally-installed `lastlight-evals` silently runs the BASELINE.** It
carries the same version string as the working tree. `--overlay overlays/wp3`
completes happily, at baseline cost, with every analysis phase skipped, and
reports itself as the wp3 arm. **One agent call and ~$0.21 is the tell**;
eight-to-nine is a real pipeline case. Run from source (§5).

**4. The spec family was worse than inert.** With no obligations it did not
no-op — it fell back to generic analysis and emitted 7 hypotheses in the
**contract family's shape**, counted as coverage while duplicating another axis.
Fixed: both ends now come from core's own `resolveSpecContext` against the fake,
the fixtures carry real linked-issue bodies (generator-derived), and
`maxSpecObligations` went 6 → 40 because it had become the binding constraint on
five of six linked cases the moment the axis started working.

**5. Run A (`2026-08-22_123348`) cannot be compared against.** Its `post-review`
read the process-global config while every gated phase keyed off the run context,
so the attention boundary was **inert**: the split verdict stripped, every
`internal`-tier finding posted, no inline cap. Fixed in `321634ec`. Its two gold
matches sat at ranks **#7 and #19 of 20 posted** — under a working boundary a
19th-ranked finding would very plausibly never have been posted. **Both its
precision and its recall describe a deployment that does not exist.**

**6. A measurement must never overlap a rebuild of what it measures.** A 50-case
corpus run was invalidated when `dist/cli.js` landed mid-flight. **Contention
counts**: a `none` run that should take seconds recorded **1933 s** beside a full
test gate. Sequence them, or say which half of a contaminated measurement you are
standing on.

**7. `--never-fail` does not survive a hard crash.** It is an in-process
try/catch; an OOM or a native segfault exits 134 with no envelope. A phase that
fails hard writes no `assessedHeadShaByWorkflow`, and `cron-review.yaml`
re-dispatches every 30 minutes **forever**. Hence the shell-level `||` fallbacks
in `pr-review.yaml`. Do not simplify them away.

**8. The gold dataset is uncommitted and one keystroke from erasure.** On
2026-08-22 an agent ran `git checkout` on `instances.json` in
`~/work/nearform-evals` — a file with uncommitted work — destroying **5 of 8
cases, 25 gold findings down to 8**. It was recovered only because
`scripts/build-skillspro-cases.mjs` happened to exist, and verified against an
independently-recorded checksum. Backup:
`~/lastlight-prod-snapshots/instances-25gold-*.json`.

> **Checksum for that dataset: gold per case `3,5,0,4,3,5,4,1` = 25, across 8
> cases.** Verify it after anything that regenerates the fixtures.

**Never run `git checkout` / `restore` / `stash` / `reset` on a file without
first checking it for uncommitted work — and be deliberate about which repo you
are in.** Fixture data belongs in the **generator**, not hand-written into
`instances.json`: the linked-issue work was lost the first time precisely because
a regeneration silently dropped it.

**9. The fixtures seeded the bot's own prior review, and it suppressed the
review being measured.** *Found 2026-08-22, mid-arm.* `build-skillspro-*.mjs`
deliberately seeded every review before ours — bot ones included, with the login
remapped to `last-light[bot]` so that *"the skill's self-recognition behaves as in
prod"*. It behaved exactly as designed and that was the defect: handed its own
`CHANGES_REQUESTED` on `1680-r1`, the reviewer replied **"Review Complete: PR
#1680 — Skipped … A `last-light[bot]` review already exists on this PR"**,
restated the two `app.ts` findings it had been given, and posted nothing of its
own. **The arm graded 0 posted across all 7 cases.** The bodies are worse than
inert — `1680-r1`'s opens *"…all correct. The one problem is the `app.ts`
change"*, asserting the correctness of the backfill script and the TTL change,
which is where **3 of that case's 4 gold findings live**. An anti-hint.

The shipped `add-case` never had this bug — `add-case.ts:397` states the rule
(*"Anti-spoil: the review goes ONLY into `review_gold`. We never populate
`pr.reviews`/`pr.review_comments` — the fake GitHub would serve those to the
agent, handing it the answer"*). The bespoke generators overrode it. They now
strip bot-authored reviews and comments and **assert it on the artifact before
writing**, which also covers the cases a run preserves verbatim rather than
rebuilds. Human prior review context is kept: a real reviewer sees it, and the
multi-round cases need it.

**The one sanctioned exception is `prreview__skillspro-1641`**, whose gold is
empty and whose entire question — does a re-review account for the review it
already posted? — is unaskable without the prior review. So the rule is not
*never seed a bot review*, it is **never seed one over gold**.

**The general form of the rule is a clock, not an author.** A fixture replays
**the moment before we reviewed that head**, and everything after it is the
future — most sharply the gold review itself, which by this tier's premise lands
*after* ours. Two holes were closed on the way: the cutoff fell back to
`Infinity` when the bot's review could not be located, which would have seeded
every review on the PR *including the answer key*, and it now throws instead;
and the inline comments were filtered by **review-id membership**, which is not a
proxy for time — a threaded reply posted days later carries its own review id.
Both generators now filter on `created_at` as well. **Verified against the live
API**: all 32 seeded human reviews/comments across the three human-bearing cases
predate their case's moment, so the strip did not need a regeneration.

Residual, unfixed: `pr.body` and the `linked_issues` bodies are fetched **as they
are today**, not as of the review moment. If a description was edited afterwards
to describe the fix, that is hindsight the fixture hands over.

**10. Four of eight cases told the agent the PR was closed.** Same session, same
fixtures, independent cause. The generator mirrored the PR's state *today*
(`view.state === "MERGED" ? "closed" : "open"`), so the four since-merged cases
said `closed` — with no `merged` flag beside it, which reads as **abandoned**.
`1680-r1`'s *first* stated reason for skipping was *"This PR is closed and was not
merged, so it falls outside the scope of open PR reviews."* That gate sat in
front of **13 of the tier's 25 gold findings**. A fixture replays **the moment
the review happened**, and at that moment every one of these PRs was open; the
two sibling generators had always hardcoded `open`. Now all three do, and the
pre-write assertion covers it.

> **Both of these produced a clean, green, fully-graded run.** `workflowSucceeded:
> true`, `post-review` succeeded, a scorecard written. Nothing errored. The only
> visible symptom was a number — 0 posted — that looks like a model result.

**11. "No build" does NOT freeze a measurement.** Added 2026-08-23, after an
agent edited `workflows/prompts/survey-spec.md` while an arm was in flight. Core
is consumed as built `dist`, so *"do not run `build`"* is the instruction people
give — but **`workflows/*.yaml`, `workflows/prompts/*.md` and `skills/**` are
read LIVE from source** by the asset loader, and `packages/code-facts/dist` is
read live too via `LASTLIGHT_FACTS_BIN`. That run escaped contamination by about
one minute (prompts are loaded when a branch starts, and the edit landed after
all six had taken their copy) — luck, not design. **Freeze the whole tree for the
duration of an arm, or run it from a separate checkout.**

**12. The harness logs UTC; your shell prints local time.** Also 2026-08-23, and
it produced two wrong conclusions inside ten minutes — first "the prompt edit
did not overlap the run" (right answer, wrong reasoning), then "adjudicate has
been hung for 64 minutes" (it had been running four). Envelope timestamps are
`…Z`; `stat`, `ps -o etime` and `date` are BST in summer. Normalise before
comparing, and prefer `meta.heartbeat` — it is stamped in the same clock as the
log.

## 5. Running an arm

Run from source, cwd in the eval workspace. Both matter: `LASTLIGHT_CORE_DIR`
must be `apps/server` (the monorepo root has no `workflows/`, and it fails at $0
with *"Workflow not found"*), and a cwd inside `apps/evals` finds no provider key
— the `.env` lives in the eval workspace.

```bash
# Build BOTH first — core is consumed as built dist, and `discharge` lives in
# code-facts' dist/cli.js. Then do not touch the tree until the arm is done (§4
# trap 11 — the YAML, prompts and skills are read LIVE from source).
pnpm --filter lastlight-code-facts build && pnpm --filter lastlight-core build

cd ~/work/nearform-evals
EVAL_INSTANCE=prreview__skillspro-1587-r2 \
LASTLIGHT_FACTS_BIN=~/work/lastlight/packages/code-facts/dist/cli.js \
  ~/work/lastlight/apps/evals/node_modules/.bin/tsx \
  ~/work/lastlight/apps/evals/src/run.ts run pr-review \
  --overlay overlays/wp3 --model anthropic/claude-haiku-4-5-20251001 \
  --repeats 3
```

It prints `core → 0.27.0-dev (working tree)` when it is reading local source —
**check for that line**, it is what distinguishes this from §4 trap 3's
globally-installed harness silently running the baseline.

**`--repeats N` is how a result is reported now** (§2c): N sequential runs of the
whole arm as sibling run dirs, tagged `meta.repeat = {group, index, of}`, folded
into a band with union/intersection recall by `varianceRollup`. It **implies
`--keep-workspace` and `--no-open`**. Add `--concurrency 4` only for a full
8-case arm; a one-case arm does not need it.

**Follow it on a standalone dashboard**, started once and left up — a `run`
without `--no-open` holds its own server open forever, and seven of them
accumulated overnight on 2026-08-22 before being killed:

```bash
cd ~/work/lastlight/apps/evals
LASTLIGHT_EVALS_OUT=~/work/nearform-evals/eval-results \
  npx tsx src/run.ts serve --port 4400
```

`resultsRoot()` is cwd-relative, so `LASTLIGHT_EVALS_OUT` is what points it at
the eval workspace rather than `apps/evals/eval-results`. Discovery is
on-the-fly, so repeats appear as they land. Pin `--port`: the default is 4319 and
`EADDRINUSE` falls back **silently** to an ephemeral one.

> **VERIFY THE ARM, DO NOT READ ITS LABEL.** Within the first minute the
> `--keep-workspace` path must hold `facts.json`, a populated `obligations.json`
> and per-family blocks under `obligations/`; by the end it must hold
> **`disposition.json`**, whose absence means the attention boundary never ran.
> Both checks are free and each one has caught a wasted arm.

The kept workspace is at
`<tmpdir>/sandboxes/<taskId>/<repo>/.lastlight/pr-review/` — note the two levels
of nesting; the artifacts are not at the workspace root.

**Every eval arm is human-authorised spend** ([HANDOFF.md](HANDOFF.md) §sign-off).
A sub-agent must never run one unprompted.

## 6. Driving sub-agents on this work

What produced results, worth reusing close to verbatim:

- **"A failing test is more likely a new bug than a bad assertion — investigate
  before you adjust."** Four of WP1b's seven bugs surfaced this way.
- **"Report anything in this brief you found to be wrong."** This repeatedly
  caught errors in the *brief*. On 2026-08-22 it corrected three load-bearing
  premises: the survey-time `git fetch` was an instruction and not a symptom;
  `seed` does not mint hypothesis ids (the survey models do, at runtime); and the
  eval-seed hypothesis for the dead spec axis was wrong.
- **"A measured *this does not work* is a successful outcome of this task."**
- **Hand them the measured numbers.** Agents made to rediscover context spend
  their budget on exploration.
- **Explicit, disjoint file ownership.** Six agents ran concurrently on
  2026-08-22 with no merge conflicts because each was given a directory.

**Disjoint files are not a disjoint contract.** The one real defect of that day
came from two agents whose files never overlapped: one wired a new `onPhaseEnd`
the eval had never passed, the other added a phase handler that did not fire it.
Result: six branch rows with no duration and **61% of the case cost
unattributed**, rendering as if the phases had been skipped. When parallel agents
touch **two ends of one contract**, name the contract in both briefs.

Two further cautions:

- **Never run a measurement agent concurrently with an agent that rebuilds what
  it measures** — including the full turbo gate, which is ~115s of CPU.
- **A repo can have more than one writer, and `git status` does not name them.**
  An agent was once killed for "scope creep" that belonged to a concurrent human
  session. Check a change against the files you actually gave it before acting.
