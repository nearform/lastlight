# pr-review: units, sites and the pair — what we tried and where we landed

The record of the `feat/unit-survey` branch (2026-09-21 → 2026-09-29): how Last Light's evidence-pipeline review went from a five-agent survey, through a unit survey that found more and an adjudicator that could not cope with it, to **units + sites** as the only analysis path, and finally to a **paired investigator** per site. Every number here is measured; each section says on what, and how far to trust it.

It replaces five working docs (`unit-survey.md`, `unit-pr-review-revise.md`, `adjudicate-falsify-replay.md`, `pr-review-units-sites-only.md`, `site-review-recall.md`), which are in git history. Code comments cite this doc by section label — "stage 5", "D2", "H3 audit", "screen 1", "H6" — and those labels are headings below.

## Contents

1. [Where we landed](#where-we-landed)
2. [The starting point](#the-starting-point)
3. [Act 1 — The unit survey](#act-1--the-unit-survey)
4. [Act 2 — Nothing downstream could absorb it](#act-2--nothing-downstream-could-absorb-it)
5. [Act 3 — Is the approach broken?](#act-3--is-the-approach-broken)
6. [Act 4 — Is the survey signal real? (screens 1–3)](#act-4--is-the-survey-signal-real-screens-13)
7. [Act 5 — Sites](#act-5--sites)
8. [Act 6 — The sites engine, end to end](#act-6--the-sites-engine-end-to-end)
9. [Act 7 — Fixing the investigators (H1–H4)](#act-7--fixing-the-investigators-h1h4)
10. [Act 8 — One analysis path](#act-8--one-analysis-path)
11. [Act 9 — The final round: pairing, coverage, context](#act-9--the-final-round-pairing-coverage-context)
12. [Key learnings](#key-learnings)
13. [Open decisions and next steps](#open-decisions-and-next-steps)
14. [Method, datasets and caveats](#method-datasets-and-caveats)
15. [Appendix A — The unit survey's file contract](#appendix-a--the-unit-surveys-file-contract)
16. [Appendix B — Reproduction: fixtures, runs, commands](#appendix-b--reproduction-fixtures-runs-commands)

## Where we landed

**The pipeline.** With `review.analysis.enabled: true` there is one analysis path:

```
triage? → facts → seed → units → survey-units → units-ingest
        → site-plan → site-review (investigators) → merge → select → site-finalize
        → reconcile → post-review
```

- **The unit survey** cuts the PR into deterministic units (a changed function, a module's changed regions) and asks one bounded, non-agentic model call per unit. Its rows are *hypotheses*, not findings: ~1% of them are real.
- **Sites** turn rows into a volume signal. Rows cluster by location; where many independent units point is where an investigator looks. The top `siteTop` sites (5, up to 8) each get one agentic **investigator** that reads the code, runs probes and writes 1–3 grounded findings or an earned `none`. Test-file sites rank last and fill only free slots.
- **`select`** — one agent call over ~5–20 findings — merges duplicates, sets importance and writes the comments. It reads the PR's prior discussion so it does not repeat a point already raised.
- Removed on the way: the five-branch agent survey, the adjudicator, `dossier`, `jev-classify`, and the `surveyEngine` / `reviewEngine` switches.

**The numbers.** On the Martian held-out set (18 PRs, 5 languages, 54 gold), judge gold on the *posted* review, two repeats each:

| arm | gold matched | micro-recall | micro-precision | comments/PR | $/PR |
|---|---|---|---|---|---|
| sites, Haiku investigators (old prompt; 16 cases) | 13/44 | 0.30 | 0.35 | 2.3 | 1.37 |
| sites, luna investigators (h13) | 24 / 19 | 0.44 / 0.35 | 0.47 / 0.40 | 2.6 | 0.38 / 0.37 |
| sites, deepseek-v4-flash investigators (h13) | 26 / 28 | 0.48 / 0.52 | 0.37 / 0.41 | 3.8 | 0.62 / 0.61 |
| **sites, luna + deepseek pair (h13)** | **28 / 28** | **0.52 / 0.52** | 0.37 / 0.32 | 4.2 / 4.7 | 0.69 / 0.71 |

For scale: the old agent-survey pipeline cost ~$2–4 and 23–47 minutes per PR; the adjudicator once spent $2.39 to post nothing.

**The open decision.** The pair is the best and steadiest on recall, but on judge gold it is roughly deepseek alone plus comments. Whether its extra comments are real defects that gold misses, or noise, decides between pair, deepseek and luna — and that needs the posted comments graded ([Open decisions](#open-decisions-and-next-steps)).

## The starting point

The evidence pipeline (`docs/plans/deterministic-pr-levers.md`) ran `facts` → `seed` → a **five-branch agent survey** (contract, enforcement, security, state, spec) → `falsify` (probes) → `adjudicate` → `post-review`.

- The survey was **~75% of case spend and ~90% of branch-seconds**. Each branch is an agent session that spends minutes re-deriving, with bash, context `facts`/`seed` already computed. Wall clock is the slowest branch; on gondolin/smol/kubernetes the branches run serially.
- Discovery was the bottleneck: across the earlier evals, 417 gold were never found against 104 found-but-not-said.

[perch](https://github.com/lakeday-org/perch) showed a faster shape: deterministic units (methods) + call graph, **one bounded, non-agentic request per unit** carrying every question at once, units in parallel, verdicts derived by arithmetic, readings cached by request hash. We copied the shape, not the dependency, and kept a normal LLM (Jev's correctness axis had measured dead at AUC 0.534, and the adjudicator needed claim text).

## Act 1 — The unit survey

### Design

```
facts ─► seed ─► units (bash) ─► survey-units (in-process) ─► units-ingest (bash) ─► …
                                  └ one model call per unit
```

- **Deterministic work lives in `lastlight-code-facts`**: the unit assembler, the rendered request text, reply validation, hypothesis rows. It runs as bash phases like every other `lastlight-facts` step and is testable without a model; the evals harness uses the same code.
- **Core does only model I/O.** Core does not depend on code-facts (it would drag tsgo + ast-grep natives into the agent image). The `survey-units` handler reads `units.json` from the host checkout — which is why `review.analysis.enabled` is refused on kubernetes (no host checkout).
- **What a unit is:** one `symbol` unit per changed function; at most one `module` unit per file for the changed regions no symbol holds; small changed functions (≤ 15 lines) folded in; one `pr` unit for obligations no unit holds. Each request carries the unit's source, imports, callers (one clipped line each), callees (name and location only), and the `seed` obligations.
- **Large units are surveyed once per family** (units-v6): a unit with more than 40 touched lines becomes one request per family. The v5 audit found defects/unit flat at 0.31–0.41 whatever the unit's size, and 81% of 100+-line units returning nothing.
- **Cache-friendly by construction:** every request starts with a byte-identical ~7.4k-char shared prefix (task, legend, questions, response shape), so a provider's prefix cache pays for it once. Replies are cached on disk by endpoint + thinking level + request hash, so a re-review re-asks only changed units.
- **Degrade, don't fail.** Every path inside `survey-units` succeeds with a loud summary; a red phase would post nothing and re-arm the 30-minute review sweep. The full contract is [Appendix A](#appendix-a--the-unit-surveys-file-contract).

### Breadth, not a bar (units-v1 → v7)

The single most consequential prompt decision. Measured over 8 skillspro cases × 2 arms, 50 gold, judge-credited:

| version | what it asked | rows | gold credited |
|---|---|---|---|
| v1 | over-produce, no bar | 1,246 (482 answers, 764 defects) | **11** |
| v4 / v5 | a DEFECT BAR + count prior | ~154 defects | 6, then **3** |
| v6 | no count prior, family split | — | Haiku 5, luna-low 6 |
| **v7** | **breadth; typed `trigger` field; demote `code_change` in code** | 1,794 over 16 case-arms | **14** |

In v1, 320 of the defects were "only after a future edit" (0 credited) and 157 were spec nitpicks about tests or comments (0 credited); the ~419 input/state/unknown defects carried 8. So v7 asks for **every defect a changed line causes or makes reachable**, with doubt explicitly not a reason to omit, and labels the known noise with a typed field (`trigger: "code_change"`) that `units-ingest` demotes **in code** — no prose filter. v5's audit had also shown 48% of answers restating the obligation and 89% leaving `consequence` null; v7 requires the claim to be the model's own verdict.

### Evals — stages 1–3

The plan written before any run, and the decision rule for making units the default:

1. **Stage 1, $0 coverage audit** — `facts`/`seed`/`units` only: the share of gold lines inside some unit, units per PR.
2. **Stage 2, replay** — `survey-units` + `units-ingest` over preserved workspaces of an agent-survey run: hypothesis-level gold recall, hypotheses per PR, survey wall clock, $. (The table below.)
3. **Stage 3, paid A/B**, ≥ 2 runs per arm — agent vs units, independent review on vs off — quality, speed, $.

Decision rule: make units the default only if its recall is within the agent baseline's run-to-run range and case wall clock drops substantially. `apps/evals/scripts/unit-survey-replay.ts` runs stages 1–2. Stage 3 never ran (Act 2); units became the only survey through the sites results instead.

### What it bought

Over the 16 case-arms, Haiku 4.5, units-v7 against the agent survey:

| | agent survey | unit survey |
|---|---|---|
| gold asserted | 3 | **14** (≈10 truly — see screen 2) |
| model cost | $23.54 | **$8.69** |
| call time | 3,453 s | **627 s** |
| hypothesis rows | 482 | **1,794** (39–234 per case) |
| derived Criticals per case | 0–2 | 20–33 |

Discovery was fixed. A new problem replaced it: everything after the survey now had to turn 100–200 rows into ≤ 5 inline + ≤ 5 body comments.

## Act 2 — Nothing downstream could absorb it

**Stage 3 — the paid whole-pipeline A/B — was stopped (2026-09-27)**, because the first units arm showed the two phases after the survey could not absorb its volume, and a whole-pipeline A/B measures neither:

- **`adjudicate`** on Sonnet 4.6 took 8.7 min and ~29k output tokens to write dispositions for 52 rows, and was still inside its first turn at 12 min on 173. It writes a disposition per row it is shown, so cost scales with input. The three 1587 replays, at 130–220k-char dossiers, never finished.
- **`falsify`**: the probe gate owed 21 rows on one case and the agent probed one — its prompt keyed on a literal `"severity": "Critical"` field that a unit row never carries (severity is derived).

Two deterministic stopgaps were built, both reading only the typed evidence record (the standing rule: **no rule reads claim prose**):

- **`probe-plan`** — the owed set computed with the gate's own `requiresProbe`, ranked, and capped at `maxProbes` (8).
- **`dossier --admit`** — which rows the adjudicator weighs; the rest filed `internal`.

And **phase replays** (`micro-falsify`, `micro-adjudicate`): re-run ONE phase over preserved workspaces, with an `--audit` mode that stops at the deterministic decision for $0, and a gold map (gold → the row that asserts it) judged once per fixture with 3 votes and cached so its noise never reads as an arm difference.

What the admission audits found (16 v7 fixtures, 1,794 rows, 14 gold-mapped):

| admission rule | rows filed | gold filed |
|---|---|---|
| `jev:verification@0,jev:nit@0,jev:maintainability@0` | 473 | 0 |
| `top:40` | 1,155 | **7 of 14** |
| `no-consequence` | 330 | 1 |
| `no-clean-quote` | 197 | 1 |
| `no-code-change` | 54 | 0 |

The safe rules barely cut volume; the one that cut volume threw away half the gold, because its rank carried no gold signal. The one adjudication that ran to completion over the admit-all dossier (1587-r2, Sonnet 4.6, 175 rows) took 854 s, 41 turns, 42k output tokens and $2.39 — and **promoted nothing**: 11 findings, all `internal`, 0 of 5 gold posted.

## Act 3 — Is the approach broken?

Half of it. We reached the end with hundreds of candidates even for a small diff and asked one agent to choose which flow through. Checked against published systems and the ranking / alarm-triage literature:

**The broken half — one LLM choosing ~5 from hundreds.** No high-precision system does this.

- Long-list judges fail predictably: "lost in the middle" (20–30 point drops mid-list, [Liu et al.](https://arxiv.org/abs/2307.03172)); position bias is worst when candidates are similar ([Shi et al.](https://arxiv.org/abs/2406.07791)) — a dossier of near-duplicate rows.
- LLM severity/correctness judges add little: Greptile found a 1–10 severity judge "nearly random" ([blog](https://www.greptile.com/blog/make-llms-shut-up)); Atlassian's correctness judge had "minimal impact" in ablation ([RovoDev](https://arxiv.org/abs/2601.01129)).
- Our own record agreed: stated confidence measured **AUROC 0.228**; on the older posted-comment set every blind adjudicator (F1 0.745–0.803) scored below **keep-all (0.825)**.

**The half that is not broken — broad generation.** Anthropic, Qodo, Cloudflare and Ellipsis run parallel specialist generators, and the benchmarks say recall cannot be recovered after generation (SWR-Bench: every tool < 10% precision at 11–28% recall, [paper](https://arxiv.org/abs/2509.01494); CR-Bench, [paper](https://arxiv.org/abs/2603.11078)).

**What the high-precision systems do instead** (50–75% precision or acceptance):

1. **Collapse before judging** — group candidates, use group size as a free vote. Cursor Bugbot bucketed 8 shuffled passes and majority-voted ([blog](https://cursor.com/blog/building-bugbot)); BitsAI-CR clusters and keeps one per cluster ([paper](https://arxiv.org/abs/2501.15134)).
2. **Verify each candidate in isolation, grounded.** Anthropic Code Review verifies "against actual code behavior" ([docs](https://code.claude.com/docs/en/code-review)); OpenAI frames verification as targeted hypothesis checks ([blog](https://alignment.openai.com/scaling-code-verification/)); RepoAudit validates each candidate's dataflow (78% precision, [paper](https://arxiv.org/abs/2501.18160)); per-alarm LLM triage removes 85–98% of static-analysis false positives ([2411.03079](https://arxiv.org/abs/2411.03079), [2510.02534](https://arxiv.org/abs/2510.02534), [2601.18844](https://arxiv.org/abs/2601.18844)) — at a cost: one agentic filter also suppressed 22% of real vulnerabilities ([2601.22952](https://arxiv.org/html/2601.22952v1)).
3. **Select the last few by small comparisons**, never one listwise pass ([PRP](https://arxiv.org/abs/2306.17563), [Setwise](https://arxiv.org/abs/2310.09497)).
4. **The largest wins are filters learned from outcomes** (was the comment resolved, was the line changed): Atlassian +15–20 pp, Greptile 19% → 55% address rate, Google AutoCommenter 54% → 80% useful ([paper](https://arxiv.org/abs/2405.13565)). They need thousands of labels only production can supply.

Target shape: **the survey proposes, grounded verification disposes, a small comparison selects.** Two earlier failures bound it: "verification-as-filter" halved F1, and "dropping unprobed claims" was built and reverted — both dropped rows that had not been *proven* wrong.

## Act 4 — Is the survey signal real? (screens 1–3)

The worry (it had its own doc): the unit survey is rapid-fire, non-agentic calls with no types, no diagnostics, no tools — callers are one clipped line, callees a name only. At ~0.8% row precision, is it a poker machine whose "recall" is volume? Three $0 screens over the 16 fixtures, sites clustered at ±20 lines:

**Screen 1 — null-model ranking.** The same sites, ordered by signals that use no model output (shuffled modes average 200 seeds):

| order | gold in each case's top 5 / 10 / 20 sites |
|---|---|
| **support (rows)** | **9 / 12 / 12** |
| severity | 8 / 10 / 12 |
| callers | 6.1 / 9.0 / 10.0 |
| lines-mid (changed lines, fixed window) | 3.7 / 8.6 / 11.0 |
| untouched-callers | 3.9 / 5.2 / 7.2 |
| lines (changed lines in the home unit) | 3.0 / 3.8 / 8.0 |
| random | 2.9 / 5.2 / 8.0 |

No clean null model reaches support. The signal is many rows landing within a few dozen lines of each other — not the size of the diff or the function.

**Screen 3 — independence.** Counting distinct units (split siblings collapsed) instead of rows: **8.7 / 10.9 / 12.8**. The votes are heavy echoes (12 rows from one unit at one gold site) but the echo inflates counts without creating the ranking. Distinct voters became the rank.

**Screen 2 — volume vs quality.** Units wrote 1,390 defect claims to the agent survey's 87 (16×; 395 of the agent's 482 rows were "verified correct" reassurances). Per claim, the agent survey is 3.4× more precise. Cut to the agent's row budget, units find 8–9 gold against a 5.0 chance baseline and the agent's 3. By hand, the 14 unit matches: **10 assert the defect**, 3 are adjacent, 1 is wrong. The agent survey reached 40 of 50 gold sites and mostly wrote the defect off as correct; units do not write things off, and that is their recall.

**Reading:** a hypothesis generator (~1% per row) whose *agreement* ranks sites far better than chance. Quote unit recall as ~10 of 14. Everything rests on a grounded step after it.

## Act 5 — Sites

### Clustering (the $0 screen)

`clusterSites` (`packages/code-facts/src/site-cluster.ts`): rows in one file whose anchor lines fall within ±w of each other (single linkage, across families), ranked by support.

| window | sites (collapse) | gold collisions | gold in top 5 / 10 / 20 |
|---|---|---|---|
| ±0 | 1,381 (×1.30) | 0 | 5 / 5 / 7 |
| ±10 | 700 (×2.56) | 0 | 6 / 8 / 11 |
| ±15 | 559 (×3.21) | 0 | 8 / 9 / 12 |
| **±20** | **471 (×3.81)** | **0** | **9 / 12 / 12** |
| ±25 | 429 (×4.18) | 1 | 10 / 12 / 12 |
| ±40 | 357 (×5.03) | 1 | 11 / 12 / 12 |

- **Cross-family agreement is the signal.** Keyed on (family, path) the ±15 screen drops to 3 / 7 / 7.
- **Severity cannot order unit rows** — it is nearly flat (91–119 `Important` per case).
- The two gold outside the top 20 are lone rows — the known cost of any vote — which is why a site outside the top k is filed `internal`, never deleted.

### Falsify per site (a pilot that did not pay)

The first idea kept falsify and changed its unit of work: one session per site. The $0 audit was striking — today's falsify probed **1 of 14** gold rows; `sites:5` probed 10, `sites:10` probed 12 (at ~14× the rows). The paid pilot (1587-r2, `sites:10`, Haiku): 29 refuted, 64 corroborated, 13 reproduced, 17 unprobed; **$6.38, 21 min, 769 turns** for one case; 5 of 11 sites unsatisfied after 2 rounds.

- **Safe:** the one "gold refuted" was a correct refutation of a *false* row the judge had mis-matched to gold. The real gold survived.
- **Wrong unit of work:** per-row verdicts turned the verifier into a bookkeeper (23–110 serial turns per site, one command per turn) and anchored it on each row's framing — it spent its time disproving a false row instead of finding the real defect beside it. 81 rows still stood; selection was still undone.

### Site review: rows as volume, not items

The redesign. Rows stop being the verifier's input and become **a priority signal** (sites ranked by distinct-unit votes, span capped at 60 lines so one function cannot chain into a 125-line site, test files skipped). A per-site **investigator** — a new prompt, not falsify — gets the site and writes **findings**: a defect at `file:line` with mechanism, consequence and the probe that shows it, up to three; it may write none, and it may report something no row named. Rows are never deleted; they stay `internal` as the volume record.

**Leads or not?** Arm A: the site only. Arm B (subject leads) was dropped — subjects barely deduplicate, ~1 lead per row. Arm C: one non-agentic call per site *summarises* its rows into concerns; v2 merges and never filters (v1's `noise` bucket had swallowed 4 of 11 gold rows).

Skillspro, 10 gold case-arms, `sites:5`, Haiku, judge counts: A 24 findings / 4 gold / 30 of 50 sites `none` / $13.84; C 17 / 3 / 34 of 50 / $11.16. Both closed 60–68% of sites `none` **on reading alone** — on one case the investigator stood at the JSON.parse gold with the concern in its brief and wrote `none` without running the four-line probe.

### Human grades on arms A/C

All 41 findings, graded by the user:

| | A: no leads | C: summarised leads |
|---|---|---|
| real / graded | **17/24 (71%)** | 7/17 (41%) |
| must-fix / worth-mentioning / nit | **9 / 6 / 2** | 2 / 3 / 1 |
| linked to gold | 5 | 3 |

1. **Leads out.** Summaries halved precision and found a sixth of the must-fix: rows are a site-selection signal only.
2. **Gold misses over half of what matters.** 4 of A's 9 must-fix are in no gold (a storage key not reset on failed validation; a URL replaced on a substring match; write ordering that blocks retries; a pagination guard stopping one page early, capping at 4,800 users). Gold-only scoring would more than halve A.
3. **The false positives are hypothetical-environment robustness** (storage blocked, quota, non-atomic writes), and the grader's notes were domain facts the investigator cannot see ("a user will never open 11 tabs"). That became a **realistic-operation rule** in the prompt, not a filter.
4. Evidence strength barely predicts real: reproduced 2/3, corroborated 12/21, read 6/14.
5. Duplicates are real (one crash appeared 4× in different words): selection must merge.

**A `none` must be earned.** A `none` now carries `checked` suspicions, each with a command and its transcript, at least one an *execution* (`node`, a differential `git show`/`git diff`; grep and `sed -n` are reads). The gate enforces it. Its limit showed at once: on the 120s-TTL gold site the investigator ran `node` to confirm the cache accepts a TTL — never whether 120 s outlives the fetch. **The gate forces execution, not the right question.**

### Decided: stop tuning on skillspro; grade by hand; hold out Martian

Skillspro's 8 cases are ≈ 9 distinct gold from 4 PRs in one repo — every choice risked overfitting it — and gold is the wrong final judge (it mis-matches, it is incomplete, and "matches gold" ≠ "worth posting"). So:

- **A grading view** (`#/grade` in the evals dashboard): every finding graded REAL? (yes / no / unsure) × IMPORTANCE (must-fix / worth-mentioning / nit), keyed so repeats reuse grades. **Human grades are the primary score**; gold recall is secondary.
- **Martian as held-out:** 18 PRs (6 cal.com, 4 grafana, 3 keycloak, 3 sentry, 2 discourse; 54 gold), fixtures built with no agent run (`seed-fixtures.ts`).
- **Fable as a pre-grader** — checked against the user's 41 skillspro grades: 66% agreement, kappa 0.39. Fable's "yes" never contradicted the user (0 of 16 user-"no"), but it rejected 12 of the user's 24 real findings, including three non-gold must-fix; importance agreement 1 in 12. **A Fable "yes" is safe to accept; a Fable "no" needs a human; its importance is ignored.** Proposals show in `#/grade` as suggestions and never count as human grades.

**Martian, arm A v2** (no leads, earned `none`, realistic-operation rule, Haiku): 63 findings, 17 of 54 gold stated, 29 of 85 sites `none`, $20.26 (~$1.13/PR). Twice the investigator stated gold the survey never mapped a row to — *sites, not rows, carry it.* Graded (60 of 63 Fable proposals bulk-accepted, 3 by hand): **34/63 real (54%)**, a lower bound given Fable's rejections.

## Act 6 — The sites engine, end to end

Built into `pr-review.yaml` (2026-09-28), then made the only path:

```
… units-ingest
  → site-plan      bash    lastlight-facts sites --plan     rank sites, one brief per slot
  → site-review    fanout  one investigator per slot        gated by sites --check <slot>
  → merge          bash    lastlight-facts sites --merge    pool findings F1…Fn, PROPOSE duplicates
  → select         agent   one call → sites/selected.json   gated by sites --check-select
  → site-finalize  bash    lastlight-facts sites --finalize → findings.json
→ reconcile → post-review
```

- **Static fan-out, slot-generic prompt.** *(Superseded by #423: `site-review` is now a `branches_from:` fan-out over `sites/branches.json`, one branch per real site, and there are no empty slots.)* The engine had no dynamic fan-out, so `site-review` declared static branches that share one byte-identical prompt (`review-site.md`, so they share a cached prefix); everything per-slot arrives last, in the brief `site-plan` wrote, via `context_file`. An empty slot's brief says so and its gate accepts one `empty` line.
- **The gate lives in code-facts** (`lastlight-facts sites --check`), and `on_branch_gate_failure: { retries: 1 }` re-runs a failing branch with the gate's output appended — the round-2 feedback the replay built by hand. The replay and the pipeline run the same gate, so they cannot drift.
- **`merge` proposes, never decides.** Same file, lines within ±10 → a candidate group. "Same defect" versus "two defects on neighbouring lines" needs prose, and no rule reads prose.
- **`select` is safe at this size.** It sees ~5–20 findings, not hundreds — the long-list failure does not occur. Every pooled finding must land in exactly one item (conservation): it may merge and demote, never drop. `site-finalize` maps must-fix → Important, worth-mentioning → Minor, nit → internal; a failed `select` falls back to one item per pooled finding, so it still posts.

### The first end-to-end arm: plumbing holds, recall is poor

Martian held-out, Haiku investigators, stopped at 16/18 on purpose: **13 of 44 gold** posted (micro-recall 0.30), $1–1.9/PR. On the overlapping cal.com cases, the plain shipped whole-diff reviewer matched 4/8 and sites 2/8. The integration was faithful (3 gold against the replay's 5 on the first 7 PRs — inside run variance), and **`select` was not the loss**: nearly everything pooled was posted.

**Where the gold died** — a $0 classification of every gold in the 16 cases:

| where the gold was | matched | missed |
|---|---|---|
| inside a top-5 site whose investigator reported a finding | 10 | 6 |
| inside a top-5 site closed `none` | 0 | 5 |
| in a test file, which site selection skipped | 0 | 4 |
| in a changed file, but ranked 6–9 or near no site | 1 | 5 |
| unattributable (no anchor, or anchor error) | 2 | 11 |

**11 of the 20 attributable misses sat inside investigated sites; 9 were never investigated.** Of 80 slots: 40 sites wrote exactly one finding, 6 wrote two or three, 27 closed `none`.

## Act 7 — Fixing the investigators (H1–H4)

### Hypotheses

- **H1 — one and done.** Once an investigator finds a defect, it writes it up and stops. The 6 misses inside reporting sites were each a *second* defect next to the reported one (a wrong variable reported at L143, the dayjs `===` at L119 missed). The prompt pushed toward it: "the strongest first", "~20 tool calls, then write", "None is a normal answer".
- **H2 — a `none` answers only the investigator's own suspicions.** The gold was a class it never asked about (a compile question when it probed time windows; a race when it probed side effects). Some dismissals rested on assumed intent ("stubs are intentionally non-functional") — possibly licensed by the realistic-operation rule.
- **H3 — five vote-ranked sites cover too little.** 9 misses were never investigated: 4 in test files, 5 below the cut. The shipped reviewer reads the whole diff.
- **H4 — Haiku vs Sonnet** confounds the comparison with the shipped reviewer.

### The replays: h12, h13, and cheaper models

Replays over the e2e run's own kept workspaces: **10 sites holding 11 in-site misses** plus 3 gold the run had matched. Three prompts — `control`; `h12` (H1 + H2: sweep every changed statement against a fixed list of defect classes, one finding does not close the site, the realistic-operation rule narrowed to environment not intent); `h13` (h12 + **two tests before any finding**: the PR caused it — compare with `origin/<base>` — and a real caller reaches it; model a missing library; a confirmed read is still a finding). Every finding graded blind by Fable against the checkout.

| arm | findings | real | not real | must-fix | distinct gold | $ (10 sites) |
|---|---|---|---|---|---|---|
| control · Haiku | 6 | 4 | 2 | 0 | 3 | 3.03 |
| h12 · Haiku | 10 | 4 | 6 | 0 | 3 | 3.06 |
| h13 · Haiku | 5 | 3 | 2 | 0 | 3 | 2.75 |
| control · luna/low | 6 | 5 | 1 | 1 | 3 | 0.05 |
| h12 · luna/low | 7 | 6 | 1 | 2 | 3 | 0.04 |
| control · luna/medium | 9 | 8 | 1 | 2 | 3 | 0.09 |
| h12 · luna/medium | 14 | 13 | 1 | 4 | 4 | 0.12 |
| **h13 · luna/medium** | **14** | **14** | **0** | **5** | **5** | **0.12** |

(luna = `openai/gpt-6-luna`.)

- **h12 fixed one-and-done — and on Haiku it added only noise** (4 extra findings, all not real: code unchanged from base, callers that do not exist). **h13's two tests removed that noise** (Haiku 6 not-real → 2; luna 1 → 0).
- **luna is not faster per turn** (~4–5 s vs Haiku's 5–6 s); it batches reads and stops sooner (9–17 turns per site vs Haiku's 30–45). Haiku also broke the prompt's rules (absolute `cd`, probes in `/tmp`).
- **The two models find disjoint gold** — the seed of the pair (Act 9).
- **The top defects were outside the gold:** a date-override day that returns before the busy check, so booked times show as free (cal-com-8330); a device refused at the limit that gets in on the next reload within the cache TTL (grafana-79265). Gold-only scoring would have called both noise.
- **Repeats:** three identical h13 luna draws recovered 3, 2 and 5 of the 11 in-site misses — Fable-graded 14/14/5/5, 10/10/3/3, 14/13/2/6 (findings / real / must-fix / gold). Recall swings; precision held at 93–100%.

**h13 became the shipped `review-site.md`.** None of its four changes is tuned to a case.

**Open models** (h13, medium, 10-site replay, Fable-graded): deepseek-v4-flash 13 findings / 11 real / 7 distinct gold / $0.36; glm-5.3-flash 16 / 12 / 4 / $0.31; qwen3.8-flash stopped for speed (the only arm to state the dayjs `===` gold). Every open model found `ResizeEmoji` still calling the changed `downsize` signature — which the judge had not matched.

### End to end: cheap investigators beat Haiku

Martian 18, judge gold on the posted review, 2 repeats each:

| arm | posted | matched (of 54) | micro-P | micro-R | $/PR | wall/PR |
|---|---|---|---|---|---|---|
| sites-haiku (control prompt, 16 cases) | 37 | 13/44 | 0.35 | 0.30 | 1.37 | 8.3 min |
| sites-luna r1 / r2 (h13) | 47 / 48 | 24 / 19 | 0.47 / 0.40 | 0.44 / 0.35 | 0.38 / 0.37 | 5.5 min |
| sites-dsv4flash r1 / r2 (h13) | 68 / 68 | 26 / 28 | 0.37 / 0.41 | 0.48 / 0.52 | 0.62 / 0.61 | 9.5 min |

luna: fewest comments (2.6/PR), best precision, cheapest, fastest. deepseek: most recall, reaching gold luna never does (cal-com-8330, cal-com-14943, keycloak-37634), at 3.8 comments/PR and ~1.6× the cost. The plain shipped reviewer still beat every sites arm on the 6 cal.com cases (9/18 for $5.70). One early deepseek band died on OpenCode Zen's account budget (429 on every call) and was repeated.

**Gold no arm reaches, and why:** grafana-79265 #2 ("won't compile") looks wrong — xorm's `Exec(...interface{})` accepts `args...`; grafana-94942 #1 is contested (the PR disables SQL expressions for a CVE — the stubs *are* the fix); cal-com-22345's gold is a guard unchanged on main (h13's "the PR caused it" correctly excludes it). So judge-gold recall under-reads h13: Martian gold includes pre-existing bugs in touched code and intended behaviour.

## Act 8 — One analysis path

With units + sites the best path measured, the branch removed the rest (stages 0–4, 6, 7 built 2026-09-28). Two survey engines and two review engines had cost a large test and docs surface and many `skip_if` combinations — one already broken:

**Stage 0 — the light re-review bug, fixed first.** A light re-review under `sites` posted nothing and failed: the light harvest cleared the scratch flag, but `review` also skipped on a *context* flag the harvest did not touch, and `site-finalize`/`reconcile` skipped on the light guard — so nothing wrote `findings.json`. A golden test pinned it; `review` now skips only on `scratch.reviewTriage.skipReview`.

**Decisions:**

- **D1** — `analysis.enabled: false` survives: `review` keeps its `light` and `baseline` arms (the zero-config fallback, and still the best on cal.com); only its `deep` arm went.
- **D2** — **where falsify attaches.** (a) before `site-plan`, so sites form on surviving suspicion; (b) after `select`, as a precision gate on ≤ 10 posted findings; (c) keep the phases, unwired. Chosen: **(c)** during removal — `prepare`, `probe-plan`, `falsify` skip on `falsifyAttached`, which nothing projects — and **(b)** as a separate, measured **stage 5**.
- **D3** — `review.analysis.enabled` is refused at boot on kubernetes.
- **D4** — `models.review-site` stays unset in `default.yaml` (a default must be a provider every deployment has a key for); overlays pin it.
- **D5** — removed keys (`surveyEngine`, `reviewEngine`, `independentReview`, `adjudicate`, `jevModel`, `admit`, `jevTimeoutSeconds`, `surveyPasses`) are *accepted, ignored and warned* (`REMOVED_ANALYSIS_KEYS`), so an overlay that pins one keeps booting. `surveyConcurrency` became `siteConcurrency`, the old name still read.

**Removed:** the agent survey (phase, six prompts, the `survey-pass` skill, `seed --blocks`), the adjudicator (`adjudicate`, its prompt and skill), `dossier` and `jev-classify` (their code-facts modules, CLI verbs, the TypeSafe dependency), and the evals scripts only they used. Kept and generic: the `fanout` handler, the `survey-units` handler and cache, `post-review`, `reconcile`, `facts`/`seed`/`units`/`units-ingest`, and the `sites` code.

## Act 9 — The final round: pairing, coverage, context

### The research: ensembles, and union over vote

SWR-Bench ([2509.01494](https://arxiv.org/abs/2509.01494)), Cursor Bugbot, c-CRAB ([2603.23448](https://arxiv.org/abs/2603.23448)) and "Wisdom and Delusion of LLM Ensembles" ([2510.21513](https://arxiv.org/abs/2510.21513)) point at one lever with measured evidence: **sample more than once and take the union.** Repeated runs overlap little, and heterogeneous models overlap less than one model's repeats. Majority vote throws each model's unique finds away. Our 3/2/5-of-11 luna draws were that effect.

### H5 — pair two investigators per site

**$0 union screens.** On the 10 recall sites (Fable grades; gold = judge ∪ Fable): luna alone 4 / 3 / 6 distinct gold; luna × 2 (same model) 4–6; **luna + deepseek 8 / 7 / 9** at 0.89–0.93 real-rate; luna + glm 6–8. At the posted level (an oracle union of whole e2e bands — an upper bound, since each re-ran its own survey): luna + luna 26 of 54, luna + deepseek 30–33, deepseek + deepseek 35.

**The paid replay** (10 recall sites, 3 fresh draws per new arm, every finding Fable-graded, bands over all draw combinations):

| arm | distinct gold | real-rate | findings | $ / 10 sites |
|---|---|---|---|---|
| luna × 1 | 4.3 [3–6] | 0.98 | 12.7 | 0.12 |
| luna + PR context × 1 | 4.3 [3–6] | 0.95 | 13.0 | 0.12 |
| deepseek × 1 (provider-default thinking) | 6.0 [6–6] | 0.84 | 15.5 | 0.53 |
| deepseek × 1, `low` | 4.3 [3–5] | 0.67 | 9.0 | 0.23 |
| luna × 2 | 5.3 [4–6] | 0.97 | 25.3 | 0.24 |
| **luna + deepseek** | **8.2 [7–10]** | **0.90** | 28.2 | **0.65** |
| luna + deepseek-low | 6.6 [4–9] | 0.84 | 21.7 | 0.35 |
| deepseek × 2 | 8.8 [8–10] | 0.84 | 31.0 | 1.05 |
| luna + deepseek × 2 | 10.4 [9–12] | 0.88 | 43.7 | 1.17 |

- **Pair luna with deepseek:** nearly double luna's gold at 0.90 real-rate, and 93% of deepseek × 2's gold for 62% of the cost at higher precision.
- **deepseek's thinking is what it is paid for.** pi-ai maps deepseek-v4-flash's `medium` to *no* reasoning-effort parameter — the provider default, ~75% of output tokens as reasoning. `low` cut $ by 60% and wall by 55% but dropped gold 6.0 → 4.3 and real-rate 0.84 → 0.67; its extra wrong findings rest on false premises. Never pin `low`.
- **PR context is neutral** (H6). Giving investigators the PR title, body and closed issues changed neither gold nor precision; its visible effect is grafana-94942, where luna now closes the contested site `none` 3/3. Kept, as a claim to check — not a lever.

### H3 audit — coverage

`micro-site-review --audit` over the 18 Martian surveys, 25 gold-mapped rows:

| selection | sites/PR | gold rows in a site |
|---|---|---|
| top 5, tests skipped (shipped then) | 4.7 | 16 |
| **top 8, tests skipped** | 6.7 | **21** |
| top 5 + tests | 4.8 | 15 |
| top 8 + tests | 7.2 | 20 |
| top 12 + tests | 10.1 | 21 |
| every site | 18.2 | 25 |

Top 8 costs ~2 more investigators per PR (≈ +$0.02 on luna). **Ranking tests with the rest hurts at a fixed cap** — they displace better sites. And **29 of the 54 gold map to no survey row at all**: no selection or investigator change reaches them.

### What was built

- **`models.review-site-pair`** — a second investigator, on that model, on every selected site (slots 9–16 re-briefed ranks 1–8; since #423 the pair slot is `site-00N-b`). `merge` proposes the two investigators' duplicates; `select` merges them. Off unless set.
- **`review.analysis.siteTop`** (1–8, default 5).
- **16 static branches with `skip_satisfied_branches`** *(superseded by #423's dynamic fan-out)*. `site-plan` writes every unused slot's `empty` line itself; the fan-out runs each branch's gate *before* its agent and starts no session for a branch already satisfied. A PR with two sites no longer pays for fourteen agents writing one line each.
- **Test-file sites fill free slots.** They rank after every other site (`clusterSites`' `demotePath`) instead of being dropped: they cannot displace a code site, and they recover slots that sat empty on small PRs (9 of one smoke case's 17 rows were in test files, and rank 5 was empty). Not a config key.
- **`{{prIntent}}`** for the investigators (title, body, closed issues — framed as a claim to check, never a reason to close) and **`{{priorDiscussion}}`** for `select` (reviews, inline threads with resolution, comments — one GraphQL read): an item that repeats an already-raised point is marked `alreadyRaised` and filed internal.

### The end-to-end pair band

**Smoke** (keycloak-40940): 4 sites → 8 of 16 branches ran (4 luna, 4 deepseek), 8 skipped with no session; `merge` grouped one luna and two deepseek findings and `select` merged them into **one** comment. Posted 1, gold 1/2, $0.34.

**The band** (Martian 18 × 2, `overlays/sites-pair`: luna + deepseek, h13, top 5):

| arm | matched (of 54) | micro-R | micro-P | posted/PR | $/PR |
|---|---|---|---|---|---|
| **sites-pair r1 / r2** | **28 / 28** | **0.52 / 0.52** | 0.37 / 0.32 | 4.2 / 4.7 | 0.69 / 0.71 |
| sites-luna r1 / r2 | 24 / 19 | 0.44 / 0.35 | 0.47 / 0.40 | 2.6 / 2.7 | 0.38 / 0.37 |
| sites-dsv4flash r1 / r2 | 26 / 28 | 0.48 / 0.52 | 0.37 / 0.41 | 3.8 / 3.8 | 0.62 / 0.61 |

Per case (gold matched, r1 r2):

| case | gold | pair | luna | deepseek | pair posted |
|---|---|---|---|---|---|
| cal-com-10967 | 5 | 2 1 | 2 1 | 2 2 | 7 7 |
| cal-com-11059 | 5 | 4 5 | 4 3 | 5 4 | 9 10 |
| cal-com-14943 | 2 | 1 2 | 0 0 | 1 1 | 4 4 |
| cal-com-22345 | 2 | 0 0 | 0 0 | 0 0 | 2 1 |
| cal-com-22532 | 2 | 1 0 | 1 0 | 0 0 | 6 6 |
| cal-com-8330 | 2 | 2 2 | 0 0 | 1 2 | 7 7 |
| discourse-graphite-1 | 3 | 2 2 | 3 2 | 2 3 | 5 7 |
| discourse-graphite-10 | 4 | 1 2 | 1 2 | 2 2 | 3 6 |
| grafana-79265 | 5 | 2 3 | 2 2 | 2 2 | 4 4 |
| grafana-90045 | 3 | 2 2 | 2 2 | 2 2 | 5 6 |
| grafana-94942 | 2 | 1 1 | 2 2 | 2 1 | 1 1 |
| grafana-97529 | 2 | 2 1 | 1 1 | 0 2 | 3 4 |
| keycloak-37634 | 4 | 1 1 | 0 0 | 1 3 | 6 5 |
| keycloak-38446 | 2 | 1 1 | 1 0 | 1 1 | 5 5 |
| keycloak-40940 | 2 | 1 1 | 1 1 | 1 1 | 1 2 |
| sentry-80168 | 2 | 1 1 | 1 0 | 1 0 | 1 1 |
| sentry-greptile-1 | 4 | 2 3 | 2 2 | 3 2 | 3 5 |
| sentry-greptile-94376 | 3 | 2 0 | 1 1 | 0 0 | 4 4 |

- **Best and steadiest recall yet:** 28 in both repeats (luna swung 24 → 19). It keeps deepseek's cal.com wins (cal-com-8330 2/2 twice, where luna scored 0) and luna's where deepseek slips.
- **But on judge gold it is deepseek × 1 plus comments:** the same recall as deepseek's better repeat, 0.4–0.9 more comments per PR, precision at deepseek's level (~10 points under luna), ~$0.09/PR more. `select` merges the pair's duplicates but still posts more.
- **Cost:** $0.70/PR on average; over ~$1 only on cal-com-10967 ($1.31/$1.32) and keycloak-37634 ($1.15/$1.20).

### What running it taught us (operational)

- **A branch failure used to fail a posted review.** One deepseek pair slot hit an OpenCode Zen "404 status code (no body)" (`error_agent`, never retried), and the scheduler failed the workflow on any failed row — so the run was recorded `failed` although it had posted and was graded. In production that leaves the head unassessed (only succeeded runs count), and the 30-minute review sweep would re-post. **Fixed:** a provider error re-runs its branch once; a failed branch in a fan-out that succeeded is `tolerated` — visible as failed, not a workflow failure.
- **Concurrency is a provider problem, not a host one.** The in-process fan-out ceiling was 6 (a paired top-5 PR ran in two waves); it is now 16 on `none`, 6 on `docker` (production, memory-capped). But at 12 cases × up to 16 sites (~97 sessions in flight), deepseek slowed from 8.3 to **12.4 s per turn** (p90 12.7 → 18.7) while its turn count barely moved (25 → 28); luna moved 6.4 → 7.2 s. The host sat at load 6–9 on 18 cores. Deepseek sets wall time (each PR waits for its slowest investigator); more concurrency buys less than it looks and risks bursts of errors. Run pair arms at `--concurrency 3`.
- **Laptops sleep.** The band's laptop clamshell-slept on battery for ~90 minutes mid-run; one `select` call returned 111 minutes later, and pair slots died with "Connection error." on wake. The five cal.com instances in flight were re-run under `caffeinate -i` and spliced in. It also exposed that **the in-process backend never passes the agent timeout to agentic-pi** — a hung call on `none`/gondolin runs until it returns (production is docker).

## Key learnings

1. **Recall is decided at generation; precision can be bought later.** The unit survey's breadth (14 gold vs 3) could never have been recovered downstream. Asking for everything — doubt is not a reason to omit — and removing the *typed* noise in code beat every "defect bar".
2. **Never ask one model to pick 5 from hundreds.** Every attempt failed: the adjudicator didn't converge, admission by rank threw away half the gold, and blind judges lose to keep-all. Collapse first, verify in isolation, select from a handful.
3. **Agreement is the signal; count it honestly.** Where many independent units point is where defects are (9 of 14 gold in the top 5 sites vs 2.9 at random). Votes echo, so count distinct units; clustering across families matters — per-family clusters destroy it.
4. **Rows are a volume signal, not items.** Per-row verification turned the verifier into a bookkeeper and anchored it on false framings. Giving the investigator a *place* and letting it write findings worked; giving it summarised leads halved precision.
5. **A `none` must be earned — and that is not enough.** Requiring an executed probe stopped dismissal-by-reading, but it forces execution, not the right question. A fixed sweep over defect classes (h12) plus two tests before any finding (h13) is what raised recall without the noise.
6. **Cheaper models make better investigators.** gpt-6-luna and deepseek-v4-flash beat Haiku on recall *and* precision at ¼–½ the cost: they batch reads, stop sooner, and follow the rules.
7. **Different models, different blind spots.** luna and deepseek find disjoint gold; the union beats either model twice. Don't majority-vote an ensemble — union it and let a small selection pass merge.
8. **Gold is incomplete and sometimes wrong.** Half of the human-graded must-fix findings were in no gold; at least one gold entry is disproved by the code; Martian rewards pre-existing bugs and intended behaviour. Human grades are the primary score; a pre-grader's "yes" is usable, its "no" is not.
9. **Variance is large; read bands.** Identical runs swung 2–5 of 11 recoveries and 24 → 19 matched. Nothing here rests on one draw except where it says so.
10. **Measure cheaply first.** Almost every decision was made by a $0 audit or a cents-level replay over preserved workspaces before a paid end-to-end arm. The spend gate — hygiene → free → replay → paid — is why the branch could try this many ideas.
11. **Plumbing matters as much as prompts.** A single transient provider error was turning a posted review into a failed run (and a re-post in production); the concurrency ceiling silently halved throughput; a sleeping laptop invalidated five cases.

## Open decisions and next steps

**The ship decision.** Rule (written before the band): ship the pair if *posted real findings per PR rise over `sites-luna` with real-rate no more than 10 points below it, ≤ ~$1/PR, and no `post-review` failures*; else ship `sites-luna` (h13, `models.review-site` pinned) and pick up the verifier. Cost and failures pass; the real-rate is **not yet read**.

Next, in order:

1. **Grade the posted comments** of `sites-pair`, `sites-dsv4flash` and `sites-luna` (both repeats): Fable pre-grades, blind to the arm, into `eval-results/labels/proposals-fable.jsonl`; the user confirms in `#/grade`. This is what decides pair vs deepseek vs luna.
2. **H3 audit, test fill:** `micro-site-review --audit --tests last` against `--tests skip` ($0), to separate the test fill from top 8.
3. **`sites-pair-top8`** at `--concurrency 3` under `caffeinate`, only if the pair survives step 1.
4. **Release and roll out** (stage 8): prod-facing, so a release; pin `models.review-site` (and the pair, if chosen) in each overlay; watch cost per PR, comments per PR and `post-review` failures on the first reviews.

**Deferred — one variable at a time:**

- **Stage 5 — falsify as a precision gate** (D2 (b)): probe the ≤ 10 selected findings before `site-finalize`, if the pair's posted precision slips. Replay on the 10 recall sites first, then end to end.
- A `preExisting` finding flag, so pre-existing bugs in touched code are reported at a low tier (what Martian gold rewards).
- A `none` that records which defect classes it asked of each changed statement, with concurrency required on a site that writes shared state (the H2 residue — cal-com-14943).
- The in-process agent timeout (`none`/gondolin).
- **Outcome logging in production** (was each comment resolved, was its line changed within 7 days) — the only route to a learned ranker, the largest measured win in the literature.

## Method, datasets and caveats

- **skillspro** (8 cases, 25 gold): the development set until 2026-09-27 — ≈ 9 distinct gold from 4 PRs in one repo, so not tuned on after that.
- **Martian held-out** (18 PRs, 54 gold): cal.com, grafana, keycloak, sentry, discourse. Import pinned to the old cache (137 gold upstream; a fresh import desyncs the committed anchors). Anchors are lexical and sometimes wrong (keycloak-37634's gold 0 is anchored in `OAuth2GrantType.java`; the real defect is in `AccessTokenContext.java`) — hence the "unattributable" misses.
- **Scores:** judge gold (Sonnet, 3 votes, on the posted review) is secondary; human grades (real × importance) are primary; Fable proposals pre-fill grading.
- **Variance:** always two repeats or more for an end-to-end claim; bands, not points.
- **Spend gate:** no paid arm until the $0 audits and screens are green.

## Appendix A — The unit survey's file contract

All under `.lastlight/pr-review/`. The deterministic halves live in `lastlight-code-facts`; core's `survey-units` handler does model I/O only.

### `spec-obligations.json` (written by the `units` node)

One obligation per acceptance criterion in the linked issue or PR body — `{ id: "S-n", criterion, source, candidates: [changed files, best first], changedFileCount, found: false, question }` — projected by `specContext` as one line of JSON (`specObligationsJson`) and written through a quoted heredoc (`{{` inside a string is emitted as `{{`, because `validateShellCommand` rejects `{{` in a rendered command). No set ⇒ no file. `units` attaches each to ONE unit: the first candidate file with a unit, and within it the unit holding the most touched lines; else the `pr` unit. Malformed input is a `degraded[]` entry, never a crash.

### `units.json` (`lastlight-facts units --dir .lastlight/pr-review --repo .`)

`version`, `generatedAt`, `baseSha`/`headSha`, `promptVersion` (`units-v7`; bump when rendering changes), `sharedPrefix` + its sha256, `coverage` (`full | degraded | none`), `degraded[]`, `responseSchema`, `skipped[]`, `specObligations[]`, and `units[]`: `{ id ("u-001", or "u-001-contract" for a family sibling), kind (symbol | module | pr), file, symbol, lines, language, families, obligationIds, request (the COMPLETE user message, verbatim: sharedPrefix + the unit part), requestSha256, truncated, family?, splitOf? }`. Every request is the shared prefix (task, line-tag legend, the always-asked questions, NOT FINDINGS, evidence record, response shape, rules, ending `=== THIS UNIT ===`) followed by UNIT, SOURCE, IMPORTS, CALLERS, CALLEES, OBLIGATIONS. With nothing to survey it writes `coverage: "none"` and exits 0 under `--never-fail`; with missing inputs it fails loud (exit 2). The shell fallback (process died without writing) is itself a valid `coverage: "none"` document; ingest reads it as *not surveyed*, never as clean.

### `units/responses/<unitId>.json` (the core handler)

`{ unitId, model, systemPromptSha256, requestSha256, ok, cached, attempts, raw, error, usage, durationMs }`. The reply rule is owned by code-facts (`src/unit-response.ts`) and mirrored case for case in the handler (core cannot import code-facts): `findUnitObject` takes every balanced top-level JSON object in the reply (then those inside fences, then one level of nesting) and picks the first whose `unitId` matches; `isUsableUnitReply` requires `answers` and `defects` arrays. `ok` and a cache write only when both hold, after one retry. Around it:

- **The call:** system = the phase prompt + the shared prefix (so pi-ai's cache marker makes it a cross-unit hit); user = the rest. Thinking level from `variants.review-survey`. A reply cut at the output cap is `ok: false` and not retried.
- **The cache** (`<stateDir>/unit-survey-cache/<owner>/<repo>/`) keys on the resolved endpoint, thinking level and the hashes of the text sent; entries a previous ingest marked invalid are evicted.
- **The deadline:** one `AbortController` for the whole phase (`surveyUnitsTimeoutSeconds`, 600), also tripped by a run cancel; unfinished units are `ok: false`.
- **Degrade, don't fail:** every path succeeds with a loud `SURVEY DEGRADED …` summary.
- **Transcript:** one virtual session per phase (a `survey_unit` tool call per unit), wrapped in `runLedgeredPhase` so an `executions` row carries its cost.

### The model's reply

One JSON object: `unitId`, one entry per listed obligation (each exactly once), then any unprompted defects. Each entry: `family`, `claim` (the model's own verdict — never the question restated), `line` (from the request's line tags) and the `SurveyEvidence` record. **No `severity`, no `needsProbe`** — both derived in code (`deriveVerdict`). When no shown control holds, `consequence` must say what goes wrong.

### `units-ingest` (`lastlight-facts units-ingest --dir .lastlight/pr-review`)

Validates every reply and writes `hypotheses/<family>.jsonl` in the existing row shape plus `source: "units"` and `unitId`, and `units/ingest.json` (per unit: rows, errors, warnings, `consequenceGaps`, `demoted`). **Demotion** is on one typed field: an *unprompted* defect with `evidence.trigger === "code_change"` is kept out of `hypotheses/` and recorded in full in its unit's `demoted` list; an obligation's answer is never demoted, and no prose is read. A unit with no usable reply still gets a row per obligation it owned, saying the survey could not answer it, stamped `needsProbe: true`. Exit 0 on every path under `--never-fail`.

## Appendix B — Reproduction: fixtures, runs, commands

**Fixtures** (outside the repo; derived files, never committed):

- `~/lastlight-micro-fixtures/2026-09-27-units-v7-haiku/` — the 16 skillspro case-arms.
- `~/lastlight-micro-fixtures/2026-09-27-martian-units-v7-haiku/` — the 18 Martian fixtures (22 GB; seeds in `martian-seed/`), with `martian-instances-anchored.json` (gold placed at its first anchored line).
- `~/lastlight-micro-fixtures/2026-09-28-sites-e2e-workspaces/` — the 9 cases holding an in-site miss, with `target-sites.txt` (the 10 recall sites).
- `~/lastlight-micro-fixtures/2026-09-28-site-recall-prompts/` — `control`, `h12`, `h13`, `score.py`, and every Fable batch; `2026-09-29-union-screen/` — `union.py`, `union2.py`.
- Fable proposals: `eval-results/labels/proposals-fable.jsonl`; human labels: `eval-results/labels/findings.jsonl`.

**Overlays** (`~/work/nearform-evals/overlays/`): `sites-haiku`, `sites-luna`, `sites-dsv4flash`, `sites-pair`, `sites-pair-top8`. `variants.site-review` sets the investigators' thinking level (a fan-out resolves `variants[<phase name>]`).

**End-to-end bands** (`eval-results/pr-review-martian-config/`):

| arm | runs |
|---|---|
| sites-haiku | `2026-09-28_050504-4dd91f8` (16/18) |
| sites-luna | `2026-09-28_081311-4dd91f8`, `…_084709-…` |
| sites-dsv4flash | `2026-09-28_161438-4dd91f8`, `…_171802-…` |
| sites-pair | `2026-09-29_075200-4dd91f8`, `…_075201-…` (13 non-cal.com instances) + `2026-09-29_103239-4dd91f8`, `…_103240-…` (the 5 cal.com, re-run after the laptop sleep) |

**Commands** (from `~/work/nearform-evals`, with `.env` loaded):

```bash
# End-to-end band: the 18 Martian cases (--instance takes a comma list;
# without it pr-review-martian runs all 50), 2 repeats
IDS=$(ls ~/lastlight-micro-fixtures/2026-09-27-martian-units-v7-haiku | grep prreview__ | paste -sd, -)
caffeinate -i npx tsx ~/work/lastlight/apps/evals/src/run.ts run pr-review-martian --mode config \
  --overlay overlays/sites-pair --instance "$IDS" --repeats 2 --concurrency 3 --keep-workspace

# Replay chosen sites with one prompt/model (investigators only)
npx tsx ~/work/lastlight/apps/evals/scripts/micro-site-review.ts <fixtures…> \
  --instances <anchored instances> --sites prreview__cal-com-8330:1,… \
  --model openai/gpt-6-luna --thinking medium [--pr-context] [--tests last|skip|mix]

# $0 selection audit
npx tsx ~/work/lastlight/apps/evals/scripts/micro-site-review.ts <fixtures…> \
  --instances <anchored instances> --audit --top-sites 8

# Cluster screens (null-model orders, distinct voters)
npx tsx ~/work/lastlight/apps/evals/scripts/cluster-screen.ts --order support|callers|random --windows 20 [--voters unit]
```

**Gotchas:** OpenCode Zen enforces an account budget — when it runs out every call returns 429 and the run is unusable, so smoke one case before a long arm. A band with `--repeat-concurrency` runs without its live dashboard; start `run.ts serve` to browse it. The eval runs the *built* packages (`dist`): rebuild `lastlight-core`, `lastlight-workflow-engine` or `lastlight-code-facts` before a run that needs a change, and never mid-run.
