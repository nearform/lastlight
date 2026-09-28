# Adjudicate, falsify and phase replay — after the unit survey

Status: **in flight on `feat/unit-survey`, 2026-09-27. Nothing here is a
default.** Follow-on to [`unit-survey.md`](unit-survey.md), whose plan stopped at
stage 3 (the paid whole-pipeline A/B). Everything that happened after stage 3
stopped was not written down anywhere except a short note at the end of that
doc's Evals section; this doc is the record, and it names the next decision.
It absorbs [`unit-pr-review-revise.md`](unit-pr-review-revise.md) (the
"is the survey a hallucination machine?" critique, whose screens 1–3 ran here).

## Status log (newest first)

- **Next (planned, separate piece of work): the `sites` review engine in
  the workflow** — site-plan → site-review fan-out → merge → select, behind
  `review.analysis.reviewEngine`. See
  [Pipeline integration](#pipeline-integration-the-sites-review-engine-planned-not-built).
- **Machine proposals on the grade page (2026-09-28).** `/api/findings` now
  attaches each `eval-results/labels/proposals-<grader>.jsonl` proposal to its
  finding and returns per-grader agreement with the human labels (n, real
  agreement, Cohen's kappa, importance/gold agreement when both say real,
  human × grader confusion) — `agreementMetrics` in `apps/evals/src/labels.ts`.
  Proposals never feed `gradedMetrics`; `#/grade` shows them in a muted
  "suggested by …" box with an explicit accept (`a`) that saves them as the
  human's own label.
- **Martian held-out fixtures (2026-09-27).** 18 Martian PRs (6 cal.com,
  4 grafana, 3 keycloak, 3 sentry, 2 discourse; 54 gold) built with no agent
  run by the new `apps/evals/scripts/seed-fixtures.ts` (the harness's own
  `seedWorkspacePrReview` from the PINNED `~/work/lastlight-evals/.eval-cache`,
  v7 seed flags: minimal / all-in-diff,registrations / 40), then units-v7 on
  Haiku via `unit-survey-replay --keep`. Fixtures:
  `~/lastlight-micro-fixtures/2026-09-27-martian-units-v7-haiku/` (22 GB;
  seeds in `martian-seed/`, 31 GB, whose `origins/` the checkouts' remotes
  point at). Stage 1 ($0, against the derived
  `martian-instances-anchored.json`: gold placed at its first anchored
  line, never commit it): 504 units, 49/49 locatable gold shown (46 on a
  changed line; 5 unanchored). Anchors are diff tokens, so that coverage is
  near-tautological. Stage 2: $4.39 survey (plus the Sonnet judge,
  unmetered), 869 rows, 25 of 54 gold asserted (committed instances,
  location-free gold). Audit (`--leads subjects`, `sites:5`): 16 of 25
  gold-mapped rows sit inside a selected site. Reports
  `…19-34-18-827Z-martian-v7-haiku.json`,
  `…19-51-32-591Z-site-review-martian-v7-audit-subjects.json`.
- **Site review: `none` must be earned; realistic-operation rule
  (2026-09-27).** A `none` line now carries `checked`
  `[{suspicion, command, transcript, outcome}]` — 2 entries (1 on a ≤ 3-row
  site: a thin echo holds one suspicion, and demanding two would make the
  investigator invent one), each transcript echoing its command, at least
  one an EXECUTION by falsify's `isReadOnlyCommand` (grep/cat/`sed -n`/facts
  are reads; `node`, differential `git show`/`git diff` execute). The gate
  enforces it; round 2's feedback names the gap. `review-site.md` adds a
  realistic-operation rule (no hostile/unusual environments, no inputs the
  codebase already constrains — check callers first), with the graded
  counts in an HTML comment beside it; budget ~20 calls, ~25 when closing
  `none`. `--leads` defaults to `none` (arm A). Smoke (1680-r1, 5 sites,
  Haiku, $1.53, 234 turns): 4 nones, all carrying probes — 2 ran `node`,
  2 cleared the bar only with a differential `git diff`/`git show` — but the 120s-TTL gold site closed `none` again: it ran
  `node` to confirm `NodeCache.set` accepts a TTL and that `finally` runs,
  never whether 120s outlives the Slides fetch. The gate forces execution,
  not the RIGHT question. site-003 ended UNSAT after round 2 (transcripts
  without the echoed command). Report
  `…19-39-08-478Z-site-review-smoke-none-gate-1680r1.json`.
- **Grading view built (2026-09-27).** `#/grade` in the evals dashboard
  lists every site-review finding (arms A and C so far) for hand grading;
  labels land in `eval-results/labels/findings.jsonl` and each arm reads
  human precision and real-important findings. See
  [Human grading](#human-grading).
- **Arm C v2: merge, never filter; summaries-only pass, $0.25.** v1 had a
  `noise` bucket and a flat cap of 5; it put 4 of 11 gold rows in `noise`.
  v2 drops the bucket, scales the cap with the site and names each concern's
  most specific row. Now 9 of 11 gold rows sit in a real concern (8 as its
  specific row) and 2 in the synthetic unmerged concern. None are dropped.
  See [Arm C](#arm-c-summarised-leads).
- **Martian arm A v2 graded** (60 of 63 = Fable proposals bulk-accepted at
  the user's request, note "bulk-accepted fable suggestion"; 3 hand-graded):
  **34/63 real (54%)**, 14 must-fix + 20 worth-mentioning, 24 of the real
  linked to gold. By repo (real/findings): cal.com 11/20 (9 must-fix),
  grafana 8/14, sentry 8/11, discourse 4/9, keycloak 3/9. A LOWER BOUND:
  Fable rejected half the user's real findings on skillspro, so the true
  real rate is likely higher (skillspro, human-graded: 71%).
- **Fable pre-grades (blind), vs the user's 41 skillspro grades:** 66%
  agreement on real, kappa 0.39. Fable's "yes" never contradicted the user
  (0 of 16 user-"no"), but it rejected 12 of the user's 24 real findings,
  including three non-gold must-fix (ATTEMPTED_STORAGE_KEY reset, storage
  ordering, pagination guard); importance agreement 1/12. So a Fable "yes"
  is safe to accept, a Fable "no" must be human-graded, and its importance
  is ignored. On Martian it proposes 34 real (14 must-fix / 20
  worth-mentioning), 26 not, 3 unsure (`labels/proposals-fable.jsonl`,
  shown as suggestions in `#/grade`; never counted as human grades).
- **Martian held-out, arm A v2** (no leads, probe-backed `none`,
  realistic-operation rule, `sites:5`, Haiku; 18 PRs, 5 languages): **63
  findings, 17 of 54 gold stated (judge), 29 of 85 sites closed `none`,
  $20.26** (~$1.13/PR). By language (judge gold): cal.com 4, discourse 2,
  grafana 6, keycloak 1, sentry 4. Twice the investigator stated gold the
  survey never mapped a row to (grafana-90045 ×2, sentry-80168) — sites, not
  rows, carry it. Awaiting human grades (`#/grade`). Report
  `…19-54-04-253Z-site-review-martian-armA-v2-sites5.json`.
- **Human grades on arms A/C** (all 41 findings graded by the user,
  `eval-results/labels/findings.jsonl`):

  | | A: no leads | C: summarised leads |
  |---|---|---|
  | real / graded | **17/24 (71%)** | 7/17 (41%) + 1 unsure |
  | must-fix / worth-mentioning / nit | **9 / 6 / 2** | 2 / 3 / 1 (+1 unrated) |
  | real-important (must-fix + worth-mentioning) | **15** | 5 |
  | human-linked to gold | 5 | 3 |

  (1) **Leads out**: C halves precision and finds a sixth of the must-fix;
  rows are a site-selection signal only. (2) **Gold misses over half of what
  matters**: of A's 9 must-fix, 4 are in no gold (ATTEMPTED_STORAGE_KEY not
  reset on failed validation; URL replaced on a substring match; storage
  write ordering blocks retries; 1667's pagination guard stopping one page
  early, capping at 4,800 users) — gold-only scoring would more than halve A.
  (3) **The false positives are hypothetical-environment robustness** —
  storage blocked / SecurityError, quota, non-atomic storage writes,
  type-guard edge cases — and the user's notes are domain facts the
  investigator cannot see ("email is guaranteed a string elsewhere", "a user
  will never open 11 tabs", "this app doesn't allow consumer accounts"): a
  realistic-operation rule in the prompt + per-repo context, not a filter.
  (4) Evidence strength barely predicts real: reproduced 2/3, corroborated
  12/21, read 6/14. (5) Duplicates: the JSON.parse crash appears 4× in
  different words — the selection step must merge. (6) Three findings the
  judge matched to gold (1667 `'dryRun' in body` on a primitive body; 1680
  120s TTL vs Slides fetch ×2) were first graded NOT real — the user
  confirmed the golds are right and regraded them; the table includes that.
  Human grading is hard even with the code in view, so one grader's labels
  carry noise too.
- **Site-review arms A/C done** (10 gold case-arms, `sites:5`, Haiku; judge
  counts, not yet hand-graded):

  | | A: no leads | C: summarised leads |
  |---|---|---|
  | findings | 24 | 17 |
  | gold stated (judge) | 4 | 3 |
  | sites closed `none` | 30/50 | 34/50 |
  | $ / turns | $13.84 / 1,788 | $11.16 / 1,577 |

  Leads did not help: C dismissed more and found no more. Both arms close
  60–68% of sites `none` on READING alone, and 7 of the 10 gold rows inside
  the selected sites never surfaced in either. $1.1–1.4 per case (pilot
  $6.38): right unit of work, wrong disposition. Next: a `none` must carry a
  probe transcript per concern it dismisses. Reports
  `…18-39-57-158Z-site-review-armA-noleads-sites5.json`,
  `…-armC-summary-sites5.json`; all 41 findings are in the `#/grade` queue.
- **Decided (2026-09-27): stop tuning on skillspro alone; grade by hand.**
  Skillspro's 8 cases are 5 PRs (1587 ×3 re-runs) × 2 arms — ≈ 9 distinct
  gold from 4 PRs in one repo — so every choice so far risks overfitting it.
  And gold is the wrong final judge: the judge mis-matches (`contract-003`),
  ~4 of 14 unit credits were generous, Martian's own gold is incomplete, and
  "matches gold" ≠ "worth posting". Next: (1) a dashboard **grading view** —
  the user grades every flagged finding REAL? (yes/no/unsure) × IMPORTANCE
  (must-fix/worth-mentioning/nit), labels keyed so arms/repeats reuse them;
  arms scored on human-graded precision and real-important findings, gold
  recall secondary. (2) **Martian as held-out** — check preserved workspaces
  ($0), then unit-survey 15–20 language-diverse PRs (~$10). (3) Prod outcome
  logging, unchanged. The A/C arms below finish and become the first graded
  batch; no more skillspro-only paid arms.
- **Site review arms A/C running — early read:** the investigator dismisses
  by READING. On arm C 1587-r1 it stood at the JSON.parse gold with the
  concern in its brief and wrote `none` ("fail safely if pending is
  empty") without running the four-line probe. A `none` is the new lossy
  step; the next gate must require a probe transcript to close a concern,
  mirroring falsify's "only a transcript may refute".
- **Decided: run arms A (no leads) vs C (summarised leads), 5 sites, on the
  10 gold case-arms** (1587 ×3, 1667, 1680-r1, both arms), ~$8–20 per arm.
  Arm B (raw subject leads) was dropped: exact-subject dedup barely merges
  (about 1 lead per row), so B is the row list minus prose, not a summary.
  Arm C = one non-agentic call per site distilling its rows into ≤ 5 concerns
  (+ `noise`), validated for coverage in code. In build, with a
  `--summaries-only` pass (cents) to read the concerns before any
  investigator runs.
- **`micro-site-review` built** (investigator prompt `review-site.md`,
  findings gate with round-2 gap feedback — deliberately unlike core — judge
  over findings, `site-review` report kind + dashboard). $0 audit at
  `sites:5` (unit voters, span 60, tests skipped): **11 of 14** gold rows inside
  the selected sites. The arm1 nonce gold (`enforcement-003`) drops to rank
  10–14: its site is 7 rows from ONE unit (an echo), rank 9 even by rows.
  Smoke: two runs wandered to the 12-min deadline (~$0.41), fixed with a
  ~20-tool-call budget and a stay-on-site rule; run 3 = 21 turns, $0.15.
- **Site selection + leads landed** (`site-cluster.ts`): `clusterSites`
  options `voters: "unit"` (with `units` from `units.json` so split siblings
  collapse), `maxSpan`, `skipPath` (`isTestPath`); `siteLeads` (deduplicated
  `evidence.subject`); `renderSiteBrief`. Default `"row"` ranking unchanged
  (still 9/12/12 at ±20). `micro-site-review` (the replay) in build.
- **Site review, in build.** Hypothesis rows become a volume signal only.
  Sites are ranked by distinct-unit votes, capped in span, and test files are
  skipped. A per-site *investigator* gets the site plus deduplicated `subject`
  leads, and writes findings rather than per-row verdicts. Two arms: no leads,
  and subject leads. See [Site review](#site-review-rows-as-volume-leads-not-items).
- **Falsify-per-site pilot (1 case, $6.38):** safe but poor yield. No real gold
  was lost, the real gold was corroborated, and only 24% of probed rows were
  removed. It cost 769 turns, and grouping rows into claims barely
  compressed anything. See [the pilot](#falsify-per-site-pilot-arm2-1587-r2).
- **Survey-signal screens ($0):** agreement ranks sites well above chance and
  above every null model. The votes are echoes, but the ranking survives
  counting distinct units. Units' 14-vs-3 gold is mostly volume, and roughly
  10 of the 14 matches truly assert the defect. See
  [the screens](#is-the-survey-signal-real-three-0-screens).
- **Falsify per site built** (`micro-falsify --plan sites:<k>`). The $0 audit:
  today's falsify probes **1 of 14** gold rows; `sites:10` probes 12.
- **Site clustering screen ($0):** ±20 across families, support-first, puts
  9/12/12 of 14 gold in each case's top 5/10/20 sites; `top:40` keeps 7.
- **Research:** one LLM call choosing ~5 from hundreds is the pattern no
  high-precision reviewer uses. See [Is the approach broken?](#is-the-approach-broken).

## Where we are

The unit survey fixed the discovery problem it was built for and created a new
one. Over 16 case-arms (8 skillspro cases × 2 arms), Haiku v7:

- asserted **14 gold** where the agent survey asserted 3, at $8.69 against
  $23.54 and 627 s against 3,453 s of calls;
- wrote **1,794 hypothesis rows** — 39–234 per case, 175–234 on the 1587 cases,
  3.3× the agent survey, with 20–33 derived Criticals per case against 0–2.

Of the 1,794 rows, 14 are gold-matched (the cached gold→row map; the
`review.analysis.admit` comment in `config/default.yaml` says 13 — the map in
`2026-09-27T13-24-47-496Z-adjudicate-audit-top:40.json` holds 14). Everything
after the survey exists to turn ~100–200 rows into ≤5 inline + ≤5 body
comments, and every attempt to do that has failed in its own way.

## Why stage 3 was stopped

The first unit-survey arm showed the two phases after the survey could not
absorb its volume, and a whole-pipeline A/B measures neither:

- **`adjudicate`** on Sonnet 4.6 took 8.7 min and ~29k output tokens to write
  dispositions for 52 rows, and was still inside its first turn at 12 min on
  173. It writes a disposition per row it is shown, so its cost scales with the
  input. The three 1587 replays at 130–220k-char dossiers never finished
  (`1587-r2-sonnet-admit-all-live`: first message ~208k chars, still `running`).
- **`falsify`**: the `probes` gate owed 21 rows on `1587-r1` and the agent
  probed one — its prompt keyed on a literal `"severity": "Critical"` field that
  a unit row never carries (severity is derived).

## What was built instead

Two deterministic decisions, both in `lastlight-code-facts`, both reading only
the typed evidence record — **no rule reads claim prose** (the standing
constraint: no regex or wording filters; see `adjudicate-admit.ts:12-15`):

- **`probe-plan`** (`packages/code-facts/src/probe-plan.ts`, phase before
  `falsify`) — the owed set is computed once with the gate's own
  `requiresProbe`, ranked (Critical, then ABSENT/PARTIAL/QUOTE, then order) and
  cut at `review.analysis.maxProbes` (default 8, provisional: 16–25 are owed on
  the 1587 cases). Falsify reads `probes/plan.md`; the gate reads
  `probes/plan.json`. A row past the cap reaches adjudicate unprobed, as before.
- **`dossier --admit`** (`packages/code-facts/src/adjudicate-admit.ts`,
  `review.analysis.admit`, default `null` = every row) — which rows adjudicate
  weighs. Rules: `no-clean-quote`, `no-consequence`, `no-code-change`,
  `jev:<category>@<p>`, `top:<n>`. A row a probe executed is always admitted.
  Filed rows land at `internal` via `findings --repair`, named with the rule.

## The phase-replay harnesses, and how to read them

`apps/evals/scripts/micro-falsify.ts` and `micro-adjudicate.ts` re-run ONE phase
over preserved fixtures (`~/lastlight-micro-fixtures/<date>-<arm>/`) on a scratch
copy, and report to the evals dashboard's `#/phase-replay`.

- **`--audit`** stops at the deterministic decision (the plan, the admission):
  no model, $0 beyond the gold map. Read it first, always.
- **The gold map** (gold → the one hypothesis row that asserts it) is judged
  once per fixture with 3 votes and cached under
  `eval-results/phase-replay/.gold-cache/`, so two arms over one fixture share
  it and its noise never reads as a difference between arms.
- **micro-falsify**: the number that matters is **gold rows refuted** — a
  backed refutation is a permanent deletion, the one path by which the pipeline
  can lose a real defect. Owed / selected / deferred says what the cap cost.
- **micro-adjudicate**: `goldFiled` (gold a rule filed before the model saw it)
  is the admission's cost; P/R/F1 from `gradeReview` and deterministic
  `goldPromoted` are the adjudication's; output tokens are the cost lever.

## Results so far

Admission audits over the 16 v7 fixtures (1,794 rows):

| Rule | Rows filed | Gold filed |
|---|---|---|
| `jev:verification@0,jev:nit@0,jev:maintainability@0` | 473 | 0 |
| `top:40` | 1,155 | 7 of 14 |
| `no-consequence` | 330 | 1 |
| `no-clean-quote` | 197 | 1 |
| `no-code-change` | 54 | 0 |

- The jev rule is safe (0 gold) but removes only a quarter of the rows.
- `top:40` gets the volume down and throws away half the gold: its rank (probe
  strength, consequence, crosses_boundary, order) carries no gold signal.
- Adjudicate over the admit-all dossier does not converge on the 1587 cases.
  The one that ran to completion (`1587-r2`, arm1, Sonnet 4.6, 175 rows
  admitted, `…-adjudicate-1587-r2-sonnet-admit-all-live.json`) took 854 s, 41
  turns, 42k output tokens and $2.39, and promoted **nothing**: 11 findings,
  all `internal`, gate satisfied, 0 of 5 gold posted.

None of these is measured end to end.

## Is the approach broken?

Half of it. The question asked on 2026-09-27: we reach the end with hundreds of
candidates even for a small diff and ask one agent to choose which flow
through. Researched against published industrial systems and the ranking /
alarm-triage literature:

**The broken half — one LLM choosing ~5 from hundreds.** No system that reports
high precision does this.

- Long-list judges fail predictably: "lost in the middle" (20–30 point drops
  mid-list, [Liu et al.](https://arxiv.org/abs/2307.03172)); position bias is
  systematic and worst when candidates are of similar quality
  ([Shi et al.](https://arxiv.org/abs/2406.07791)) — which describes a dossier
  of near-duplicate rows.
- LLM severity / correctness judges add little: Greptile found a 1–10 severity
  judge "nearly random" ([blog](https://www.greptile.com/blog/make-llms-shut-up));
  Atlassian's LLM factual-correctness judge had "minimal impact" in ablation
  ([RovoDev](https://arxiv.org/abs/2601.01129)).
- Our own record agrees: stated confidence measured AUROC 0.228; on the older
  posted-comment set every blind adjudicator (F1 0.745–0.803) scored below
  keep-all (0.825). That is evidence that text-only judging does not separate
  good from bad — not a proposal to post everything.

**The half that is not broken — broad generation.** Anthropic, Qodo,
Cloudflare and Ellipsis all run parallel specialist generators, and the
benchmarks say recall cannot be recovered after generation (SWR-Bench: every
tool < 10% precision at 11–28% recall, [paper](https://arxiv.org/abs/2509.01494);
CR-Bench: pushing an agent to find more trades signal-to-noise for recall,
[paper](https://arxiv.org/abs/2603.11078)). Our discovery gap (417 gold never
found vs 104 found-but-not-said, `deterministic-pr-levers.md`) says the same.
The unit survey's recall is worth keeping.

**What the high-precision systems do instead** (50–75% precision or acceptance):

1. **Collapse before judging.** Group candidates by location/category and use
   group size as a free vote. Cursor Bugbot bucketed 8 shuffled passes and
   majority-voted ([blog](https://cursor.com/blog/building-bugbot)); BitsAI-CR
   clusters by embedding and keeps one per cluster
   ([paper](https://arxiv.org/abs/2501.15134)).
2. **Verify each candidate in isolation, grounded, trying to refute it.** One
   finding + targeted context per call, in parallel, with a required `file:line`
   citation. Anthropic Code Review verifies candidates "against actual code
   behavior" ([docs](https://code.claude.com/docs/en/code-review)); OpenAI frames
   verification as "targeted hypothesis generation and checks"
   ([blog](https://alignment.openai.com/scaling-code-verification/));
   RepoAudit validates each candidate's dataflow before reporting (78% precision,
   [paper](https://arxiv.org/abs/2501.18160)). Per-alarm LLM triage of
   static-analysis warnings removes 85–98% of false positives (LLM4FPM
   [2411.03079](https://arxiv.org/abs/2411.03079), ZeroFalse
   [2510.02534](https://arxiv.org/abs/2510.02534), Tencent
   [2601.18844](https://arxiv.org/abs/2601.18844)). Known cost: an agentic
   filter also suppressed 22% of real vulnerabilities
   ([2601.22952](https://arxiv.org/html/2601.22952v1)).
3. **Select the final few by small comparisons, never one listwise pass.**
   Pairwise ranking ([PRP](https://arxiv.org/abs/2306.17563)) and setwise
   heap top-k ([Setwise](https://arxiv.org/abs/2310.09497)) match or beat
   listwise ranking with O(n log k) calls of 2–9 items, run in both orders to
   cancel position bias.
4. **The largest measured wins are filters learned from outcomes** (was the
   comment resolved / was the line changed): Atlassian's ModernBERT ranker on
   50k+ labelled comments (+15–20 pp), Greptile's per-team embedding filter
   (address rate 19% → 55%), Google AutoCommenter's per-rule thresholds and
   suppressions (54% → 80% useful, [paper](https://arxiv.org/abs/2405.13565)).
   They need thousands of labels; only the production deployments can supply
   them.

Cursor then replaced its multi-pass pipeline with one investigating agent. We
should not copy that step: our agent survey is the low-recall arm (3 gold vs 14).
The target shape is **the survey proposes, verification disposes, a tournament
selects.**

## Proposed shape

| Today | Proposed | Fits our constraints because |
|---|---|---|
| `dossier --admit`, `top:<n>` | Deterministic **site clustering**: rows in one file whose anchor lines are within ±w lines (single linkage, across families), ranked by support (rows in the cluster) then strongest derived severity | Reads the anchor (path, line) and the evidence record only — no prose |
| `falsify` capped at `maxProbes: 8`, one session | **`falsify` per site**: the top-k sites plus the rows probe-plan owes that no site holds, one parallel session each, the rows grouped into claims (`claim` on each verdict) | Core's falsify prompt, verdicts and gate, unchanged: a row is deleted only on a refuting transcript. Not a new phase — a different selection and a different unit of work |
| One `adjudicate` over 130–220k chars | **Setwise tournament** over surviving sites (3–5 per call, both orders), then adjudicate writes claim / category / fix for the ~5–10 winners only | No call sees more than a handful of sites; output tokens scale with winners, not rows |
| — | **Outcome logging** in prod: was each posted comment resolved, was its line changed within 7 days (BitsAI's "outdated rate") | The label source for a learned ranker later |

**Two earlier failures this must not repeat.** "Verification-as-filter (v2)"
halved F1, and "dropping unprobed claims" was built and reverted. Both dropped
rows that had not been *proven*. Here only a *refuted* claim is dropped; an
unverified site still enters the tournament on its support and severity.

**A cluster is a site, not a finding.** The largest ±20 clusters hold 11–37
rows — several distinct claims about one function. The site session must return
a verdict per claim (or per distinct claim it merges), not one per site;
otherwise clustering reintroduces the "one call, many rows" shape at a smaller
scale.

## The $0 screen: does site clustering work? (2026-09-27)

`apps/evals/scripts/cluster-screen.ts`, over the 16 v7 fixtures, gold from the
`top:40` audit's cached map. It clusters with `clusterSites`
(`packages/code-facts/src/site-cluster.ts`), the module the pipeline would run.
Run from the evals workspace:

```bash
npx tsx <monorepo>/apps/evals/scripts/cluster-screen.ts --order support --windows 0,10,15,20,25,40
```

Across families, support-first:

| Window | Sites (collapse) | Gold collisions | Gold sites in each case's top 5 / 10 / 20 |
|---|---|---|---|
| ±0 | 1,381 (×1.30) | 0 | 5 / 5 / 7 |
| ±10 | 700 (×2.56) | 0 | 6 / 8 / 11 |
| ±15 | 559 (×3.21) | 0 | 8 / 9 / 12 |
| **±20** | **471 (×3.81)** | **0** | **9 / 12 / 12** |
| ±25 | 429 (×4.18) | 1 | 10 / 12 / 12 |
| ±40 | 357 (×5.03) | 1 | 11 / 12 / 12 (13 in top 40) |

Against `top:40`, which keeps 7 of the 14 gold. (A first draft of the screen
anchored only on a row's first quote and found 544 sites and 10 / 12 / 12 at
±20; the module also falls back to `bothEnds.introducedAt` and requires a
quote's path to match, which anchors more rows. One gold, `spec-019`, moved
from 5th to 6th.)

- **Support is the signal.** At ±20, 9 of 14 gold sit in their case's top-5
  sites, of 6–53 sites per case. Picking 5 at random would find about 2.
  When several units and families all flag the same few lines, that agreement
  is the "vote" Bugbot bought with 8 passes, and the unit survey hands it over
  for free.
- **Splitting clusters by family destroys it.** Keyed on (family, path),
  severity-first, the ±15 screen puts only 3 / 7 / 7 gold in top 5 / 10 / 20.
  Cross-family agreement is where the signal lives.
- **Severity-first ordering is worse at small k.** At ±20, severity-first puts
  8 / 10 / 12 gold in the top 5 / 10 / 20, against 9 / 12 / 12 support-first.
  Severity is nearly flat on unit-survey rows (91–119 `Important` per
  1587/1667 case), so it cannot order them.
- **The ×5 collapse bar I set is not met** without a gold collision (±40 reaches
  ×5.03 with one). The bar was the wrong one: the useful number is how many
  gold sit in the top-k sites, and at k = 10 per case that covers 12 of 14 with
  ≤ 10 site sessions per case.
- **Caveats.** n = 14 gold from 8 cases, each case counted twice (two arms), so
  this is a screen, not a result. Support also rewards big functions, and the
  1587 cases (many rows) dominate.

**The two gold outside the top 20, read by hand.** Both are lone rows, the
known cost of any vote:

- `contract-008` (arm1 1667, rank 23): the only row at `slackService.ts:90`;
  its nearest neighbour is at line 65, 25 lines away. It derives `Important`,
  like 91 other rows in the case. On arm2 the same gold's row is ranked 1.
- `state-026` (arm2 1587-r2, rank 21): one of two rows in `routes/users.ts`
  (the other is at line 92, a `Minor` about hook order). It also derives
  `Important`, one of 119.

Neither is recoverable by severity or by a wider window short of a collision.
Both are why a site outside the top k must be filed `internal`, never deleted.

## Falsify per site (2026-09-27)

Not a new phase. A separate "refute" pass would have duplicated falsify: the
same verdicts, the same transcript rule. What changes is **which rows** and
**in what unit**. `planProbeSites` (`packages/code-facts/src/site-cluster.ts`)
takes the top-k sites by support, plus every row `probe-plan` would have
selected that none of them holds, as a single-row site. The second keeps
today's Critical and survey-asked probes, and it is the only way a lone row
(support's blind spot) reaches the oracle. Every row is in at most one site,
so the sites run in parallel with one verdict writer per row.

`micro-falsify --plan sites:<k>` runs one falsify session per site, each on
its own scratch copy with that site's `plan.md` and `plan.json`. The prompt
and gate are core's, unmodified. The only new text is the site header in
`plan.md`: it names the site and asks for rows to be grouped into claims, with
`"claim": "C1"` on each verdict line. The sites' verdicts are merged and the
gate runs once over the union.

**Why parallel sites rather than falsify beside a second pass:** both would
probe the same rows, the Criticals that sit inside big sites. They would write
the same `verdicts.jsonl`, burn CPU twice, and on gondolin/smol/kubernetes the
fan-out runs serially anyway. Folding falsify's own owed rows in as single-row
sites gives the parallelism without the overlap.

**$0 audit, 16 v7 fixtures** (gold from the cached map):

| Plan | Rows probed | Gold rows probed |
|---|---|---|
| `rows` (today: probe-plan, cap 8) | 89 | **1 of 14** |
| `sites:5` | 891 | 10 of 14 |
| `sites:10` | 1,209 | 12 of 14 |

Today's falsify probes almost none of the gold, because its rank is derived
Critical / ABSENT, and that carries no gold signal on unit-survey rows. Sites
probe most of it, but at about 14× the rows. The top 10 sites hold 111–128
rows on each 1587 case, two-thirds of the set. Whether grouping keeps that
affordable (claims per site, not rows per site, should set the cost) is what
the paid pilot measures.

## Is the survey signal real? Three $0 screens

From `unit-pr-review-revise.md`'s worry: the unit survey is non-agentic calls
over deterministic units, with no types, diagnostics or tools. Is its recall
just volume, and is site support just "a big changed function"? Run
2026-09-27 over the same 16 fixtures and gold map, at ±20.

**Screen 1: null-model ranking.** The same sites (`clusterSites`), re-ordered
by signals that use no model output
(`cluster-screen.ts --order lines|lines-local|lines-mid|extent|callers|untouched-callers|random`;
the shuffled modes average 200 seeds):

| Order | Gold in top 5 / 10 / 20 |
|---|---|
| support (rows) | **9 / 12 / 12** |
| severity | 8 / 10 / 12 |
| callers | 6.1 / 9.0 / 10.0 |
| untouched-callers | 3.9 / 5.2 / 7.2 |
| lines (changed lines in the home unit) | 3.0 / 3.8 / 8.0 |
| lines-mid (changed lines, fixed window) | 3.7 / 8.6 / 11.0 |
| random | 2.9 / 5.2 / 8.0 |

No clean null model reaches support. `extent` (10) and `lines-local` (9) do,
but both measure the site's width, and width is made of rows. So the signal is
many rows landing within a few dozen lines of each other, not the size of the
diff or the function.

**Screen 3: independence** (`--voters unit`). Counting distinct voters (a row's
`unitId`, with split siblings collapsed to `splitOf`) instead of rows gives
8.7 / 10.9 / 12.8 with random tie-breaks. The votes are heavy echoes: 12 rows
from one unit at one gold site, and 31 rows from 5 units at the biggest. But
the echo inflates the counts without creating the ranking. Distinct voters is
the honest measure and costs about 0.3 gold in the top 5.

**Screen 2: volume versus quality.** The stage-2 report labels gold per row on
both sides with the same judge.

- Units wrote 1,390 defect claims where the agent survey wrote 87: 16× the
  claims, not 3.3×. 395 of the agent's 482 rows are "verified correct"
  reassurances.
- Per claim, the agent survey is 3.4× more precise.
- Cut to the agent's claim budget, units find 2–4 gold against its 3. Cut to
  the agent's row budget, units find 8–9 against a 5.0 chance baseline and
  the agent's 3.
- Hand-read of the 14 unit gold matches: 10 ASSERTS the defect (3 of them
  partial or weak), 3 ADJACENT, 1 WRONG. The WRONG one is `contract-003` on
  arm2 1587-r2, which claims no `toLowerCase()` where line 313 has one. The
  agent side's 3 include one WRONG as well. Honestly, that is about 10 vs 2 at
  unequal volume.
- The agent survey reached 40 of 50 gold sites and mostly wrote the defect off
  as correct. Units do not write things off, and that is their recall gain.

**Reading.** The survey is a hypothesis generator (~1% precision per row) whose
*agreement* ranks sites far better than chance. Quote unit recall as about 10
of 14, not 14. Everything rests on the grounded step after it.

## Falsify-per-site pilot (arm2 1587-r2)

`micro-falsify --plan sites:10`, Haiku, 4 sites at a time: 11 sessions (10
support sites plus one owed row) over 123 rows. Report
`2026-09-27T16-28-53-694Z-falsify-pilot-sites10-1587r2.json`.

| | |
|---|---|
| Verdicts | 29 refuted · 64 corroborated · 13 reproduced · 17 unprobed |
| Cost / wall | $6.38 · 21 min · 769 turns · 385k output tokens |
| Gate | unsatisfied on 5 of 11 sites (18 gaps) after 2 rounds; 8 of 11 ran round 2 |
| Claim grouping | 13 rows → 12 claims, 10 → 7, 9 → 5; 5 sites wrote no labels |

- **The one "gold refuted" is a correct refutation.** `contract-003` claims a
  missing `toLowerCase()`, and a `node` probe showed line 313 applies it. The
  judge matched this false row to a gold about the *export* side, which no row
  asserts (screen 2's WRONG). Nothing real was lost. But a "gold refuted"
  count must be hand-read before it is believed.
- **The real gold survived.** `enforcement-003` (nonce `issuedAt` never
  checked) was `reproduced` on `sed` reads in round 1. The gate rejects that
  on a behavioural claim (`read-not-reproduction`), and round 2 rewrote it as
  `corroborated`, backed by a `node` probe. Round 2 is not always wasted: the
  prompt states the rule even though the gap list never reaches the agent.
- **Where the time went.** Turns, not probes: the commands are greps, `sed -n`
  and tiny `node` scripts. The cost is 23–110 serial turns per site at about
  5–7 s each, and turns do not track rows (13-row sites took 106–110 turns;
  the 38-row site took 55). The session writes a probe, a transcript and a
  verdict per row, one command per turn.
- **The sites themselves.** Site-001 chained across lines 1–125 of one file
  (38 rows). Three of the ten were `*.test.ts` files (30 rows, and one
  refuted all 10 of its rows).
- **The loop.** Core's `generic_loop` re-renders the same prompt after a
  failed `until_bash` gate, and the gap list is never injected. The replay now
  records the gate's gaps per round per site (`gapsByRound`, `gateNotes`), so
  the next run shows exactly what the gate rejected.
- **Harness fixes from the pilot:** in-flight entries per running site, each
  with its own live log. The old entry pointed at site-001's log after it had
  finished.

**Reading.** Safe, but the wrong unit of work. Per-row verdicts make the
verifier do bookkeeping, and they anchor it on each row's framing:
`contract-003` was spent disproving a false row rather than finding the real
defect beside it. 81 rows still stand, so selection is still undone.

## Site review: rows as volume, leads not items

The redesign (2026-09-27). Rows stop being the verifier's input and become:

1. **A priority signal.** Sites are ranked by distinct-unit votes, with a cap
   on span (no 1–125 chains) and test files skipped. These are structural
   rules; no rule reads prose.
2. **Leads.** Each site gets a short deduplicated list of the typed
   `evidence.subject` field ("SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS expiry
   enforcement…"). This is deterministic, needs no summary call, and reads no
   claim prose.

A per-site **investigator**, a new prompt and not falsify, gets the site and
its leads. It writes **findings**: a defect at `file:line`, with its mechanism
and consequence and the probe that shows it, up to a few per site. It may
write none, and it may report something no lead named. **Rows are never
deleted.** They stay `internal` as the volume record, and a site's findings
supersede them. So the "only a transcript may refute" rule has nothing to
guard.

Why leads and not nothing: screen 2's agent survey stood at 40 of 50 gold
sites with no specific suspicion and wrote the defect off. The rows' value is
a *pointed* mechanism. The experiment tests whether that value is real:

- **Arm A:** the site only, no leads.
- **Arm B:** the site plus subject leads.

Both at `sites:5`. Score: gold defects stated in findings (judged, then
hand-read), findings per site, $ and turns per case, against the pilot's $6.38.

- If B keeps the nonce-expiry gold at a fraction of the cost, it replaces
  falsify per site.
- If A matches B, the rows only ever mattered as volume.

Build: code-facts selection options and a leads/brief renderer
(`site-cluster.ts`), then a `micro-site-review` replay with its own prompt,
gate, report kind and dashboard view.

**Built** (`apps/evals/scripts/micro-site-review.ts`). The prompt is
`apps/server/workflows/prompts/review-site.md`, which no workflow references
yet. The gate is `checkSiteFindings` (`apps/evals/src/site-review.ts`): the
file parses, it holds one `none` line or 1–3 findings, each points at a real
file and line, and a `reproduced`/`corroborated` finding has a transcript that
echoes its command. Unlike core's `generic_loop`, round 2's prompt carries the
gaps from round 1. Findings are judged against gold with the gold map's own
judge (3 votes), which gives gold stated and precision. The report kind is
`site-review` on `#/phase-replay`. Run from the evals workspace:

```bash
# $0 audit: selection and gold coverage only
npx tsx <monorepo>/apps/evals/scripts/micro-site-review.ts \
  ~/lastlight-micro-fixtures/2026-09-27-units-v7-haiku/arm1 \
  ~/lastlight-micro-fixtures/2026-09-27-units-v7-haiku/arm2 \
  --instances evals/datasets/pr-review/instances.json \
  --audit --leads subjects --judge-model anthropic/claude-sonnet-4-6
# Arm A (no leads) and arm B (subject leads), sites:5
npx tsx --env-file=.env <monorepo>/apps/evals/scripts/micro-site-review.ts \
  <same fixtures> --instances evals/datasets/pr-review/instances.json \
  --leads none --top-sites 5 --judge-model anthropic/claude-sonnet-4-6 --label armA-sites5
npx tsx --env-file=.env <monorepo>/apps/evals/scripts/micro-site-review.ts \
  <same fixtures> --instances evals/datasets/pr-review/instances.json \
  --leads subjects --top-sites 5 --judge-model anthropic/claude-sonnet-4-6 --label armB-sites5
```

Defaults: ±20 window, `--voters unit`, `--max-span 60`, test files skipped,
Haiku, 2 rounds, 4 sites at a time, a 12-minute deadline per site.

**$0 audit (16 v7 fixtures, `sites:5`):** 11 of the 14 gold-mapped rows sit
inside a selected site. The three outside are `enforcement-003` (arm1
1587-r2), `contract-008` (arm1 1667) and `state-026` (arm2 1587-r2). Subject
leads barely deduplicate: most sites list about one lead per row (55 leads for
55 rows on 1587-r1), so arm B's brief is close to the row list, minus prose.

### Arm C: summarised leads

Arm B is not a summary, so arm C makes one. Each selected site gets ONE
non-agentic call (`--summary-model`, Haiku by default) over its rows: id,
family, anchor line, claim, and the evidence record's `subject`,
`consequence` and `cannot_distinguish`. It MERGES them into concerns, one per
suspected defect mechanism, each with its rows. The investigator reads the
numbered concerns instead of the rows, and a finding's `leads` cite concern
numbers. Rows stay a volume signal.

**A summary merges; it never filters.** Every site row lands in exactly one
concern, and there is no bucket for weak rows. The cap scales with the site,
min(8, max(2, ⌈rows / 2⌉)), computed in code and stated per site in the call.
Each concern also names its `specific` row: the row whose mechanism is most
specific. The brief prints that row's `subject` verbatim under the concern,
so a broad merge cannot lose the exact call or condition.

The reply is checked in code (`apps/evals/src/site-summary.ts`), never
trusted. It must parse, stay within the cap, and cite only the site's rows,
each once. Each `specific` must be one of its concern's rows. Rows the reply
leaves out go into a synthetic final concern, "Other suspicions (unmerged)",
whose rows' subjects the brief lists, and they are counted as `uncovered`.
Anything else malformed retries once, with the rejection in the message,
since at temperature 0 a bare retry returns the same reply. A second failure
falls back to arm B's leads for that site (`fallback`). Replies are cached on
disk by model + prompt + rows, so a prompt edit is a new entry, and repeats
and later arms pay once. The prompt is
`apps/server/workflows/prompts/review-site-summary.md`, beside
`review-site.md` and, like it, in no workflow.

```bash
# Summaries only: selection + one call per site, no investigator (cents)
npx tsx --env-file=.env <monorepo>/apps/evals/scripts/micro-site-review.ts \
  <same fixtures> --instances evals/datasets/pr-review/instances.json \
  --only <ids> --leads summary --summaries-only \
  --judge-model anthropic/claude-sonnet-4-6
# Arm C with the investigator
npx tsx --env-file=.env <monorepo>/apps/evals/scripts/micro-site-review.ts \
  <same fixtures> --instances evals/datasets/pr-review/instances.json \
  --leads summary --top-sites 5 --judge-model anthropic/claude-sonnet-4-6 --label armC-sites5
```

Why v2: v1 had a `noise` bucket and a flat cap of 5. It put 4 of the 11
gold rows in `noise`, all on sites filled to the cap ($0.23).

**Summaries-only pass, v2 (10 gold case-arms: 1587-r1/r2/r3, 1667, 1680-r1 ×
arm1/arm2; `sites:5`), $0.25.** 50 sites, 518 rows → 286 concerns, synthetic
ones included, with no fallback. Haiku still leaves rows out: 83 (16%) went to
the unmerged concern, as many as 9 of 18 on one site. Where the 11 gold-mapped
rows inside a site landed:

- 9 in a real concern, 8 of them as its `specific` row. The v1 merge that
  blurred arm1 1587-r1 `security-037` now reads "JSON.parse(pendingRaw) at
  line 44 parses untrusted sessionStorage data…". The 9th, arm2 1667
  `contract-008`, sits in a 3-row concern whose text keeps its mechanism
  (`rejectRateLimitedCalls: true`, 429s thrown, not retried).
- 2 in the synthetic unmerged concern: arm1 1587-r3 `spec-016` and arm1 1667
  `contract-005`. Both were `noise` in v1. The brief still shows them, as
  subjects under "Other suspicions".

Reading: no gold is lost before the investigator now. The cost is a longer
brief: about 5.7 concerns per site against 3.9. The model's omissions are the
remaining weakness, and the synthetic concern catches them. Arm C is ready
for the investigator run against arm A.

### Human grading

The first graded batch is arms A and C. The dashboard's `#/grade` page
(`apps/evals/src/labels.ts`, `labels-node.ts`) shows every finding a
site-review report flagged, with its mechanism and consequence (joined from
the `findings.jsonl` beside each site's session), a ±8-line excerpt from the
fixture, and the case gold. The grader marks REAL? (yes / no / unsure) and,
when real, IMPORTANCE (must-fix / worth-mentioning / nit), with an optional
"same as gold N" link and a note.

A label is keyed on the PR (the instance id minus `-r<N>`, so the three 1587
re-runs share grades), the path, a seven-line bucket and the normalised
title + mechanism. The key errs tight: a reworded finding on the next repeat
gets its own key and is offered the graded neighbour as a one-click copy,
because a loose key would let one grade silently cover two claims. Per arm,
`gradedMetrics` gives findings, graded, real, real-important (must-fix +
worth-mentioning), human precision (real ÷ graded, unsure in the
denominator) and gold-linked.

## Pipeline integration: the `sites` review engine (planned, not built)

Written 2026-09-28 so it can be picked up separately. It replaces the tail of
today's pipeline, from `probe-plan` through `adjudicate`. The front (`facts`
through `units-ingest`) and the back (`reconcile`, `post-review`) are
unchanged. It sits behind a new key,
`review.analysis.reviewEngine: adjudicate | sites`. Under `sites`, the phases
`probe-plan`, `falsify`, `jev-classify`, `dossier` and `adjudicate` skip. The
`adjudicate` chain stays for the `agent` survey engine.

```
facts → seed → units → survey-units → units-ingest        (unchanged)
  → site-plan      bash    lastlight-facts sites --plan
  → site-review    fanout  slot1…slot5, one investigator per site
  → merge          bash    lastlight-facts sites --merge
  → select         1 LLM call over the merged list → findings.json
→ reconcile → post-review                                  (unchanged)
```

1. **`site-plan` (deterministic, $0).** `clusterSites` with distinct-unit
   votes (`units` from `units.json`), `maxSpan: 60` and
   `skipPath: isTestPath`, top 5. It writes `sites/plan.json` and one brief
   per slot (`sites/slot-1.md` … `slot-5.md`, via `renderSiteBrief`, no
   leads). When a PR has fewer than 5 sites, the empty slot's brief says "no
   site; write empty and stop", and the gate accepts an `empty` line only
   when the plan has no site for that slot.
2. **`site-review` (`type: fanout`, 5 static branches `slot1`…`slot5`).** The
   engine has no dynamic fan-out, but the top 5 fits static branches
   exactly.
   - Each branch runs `review-site.md` with its slot brief as
     `context_file`, and writes `sites/slot-N.findings.jsonl`. Output paths
     are disjoint, which is the fan-out's isolation model.
   - `until_bash: lastlight-facts sites --check slot-N` is the gate, moved
     from `apps/evals/src/site-review.ts`: 1–3 grounded findings, or a
     `none` backed by executed probes.
   - `on_branch_gate_failure: { retries: 1 }` appends the gate's output to
     the retry prompt. That is the round-2 gap feedback the replay built by
     hand, and fan-out branches already get it, unlike `generic_loop`.
   - Branches run concurrently on `docker`/`none` (ceiling 6) but serially
     on gondolin/smol/kubernetes (ceiling 1): about 5 × 6 min ≈ 30 min per
     PR there.
3. **`merge` (deterministic, $0).** Pools every slot's findings and
   proposes candidate duplicate groups: same file and lines within ±10, or
   overlapping sites. It does not decide. "Same defect" versus "two defects
   on neighbouring lines" needs the prose, and no rule here reads prose.
   Duplicates come mostly from neighbouring sites: the span cap splits one
   function into two sites, and both see the same bug. (Across arms the
   JSON.parse crash appeared 4× in different words.)
4. **`select` (one non-agentic LLM call).** The input is about 3.5
   findings per PR (Martian), at most about 15, each with its excerpt and
   the candidate groups. It merges true duplicates, keeping the most
   specific wording, orders by importance, and writes `findings.json` in the
   shape `post-review` already reads: `claim`, `category`, `fix`, tier.
   must-fix → inline; worth-mentioning → inline when the budget allows,
   else body; nit → internal. One call is safe at this size: the long-list
   failure that motivated this doc does not occur at about 15 items.

`reconcile` (`findings --repair`) then files every hypothesis row as
`internal` — the rows are the volume record — so conservation holds.
`post-review` keeps `maxInlineComments: 5` / `maxBodyComments: 5`.

**Other changes it needs**

- **An investigator `importance` field** (must-fix / worth-mentioning /
  nit), so `select` starts from the investigator's own call. Human grades
  show importance drives the value. Fable's importance matched the user's
  only 1 time in 12, so calibrate against labels.
- **`lastlight-facts sites --plan|--check|--merge` in `lastlight-code-facts`.**
  Core reaches code-facts only through the CLI in the sandbox, never by
  import. The evals harness then calls the same code, so replay and
  pipeline cannot drift.
- **Config and docs.** `reviewEngine` in `config/default.yaml` +
  `config-types.ts` (+ the repo-config schema if per-repo), spec
  `02-configuration.md` / `07-phases-and-prompts.md`, and the docs site
  (the `docs-sync` skill).

**How to evaluate before shipping ($0–cents)**

1. Replay `merge` + `select` over the site-review output that already exists
   (skillspro arms A/C, Martian arm A v2).
2. Score the posted set on the existing human and Fable labels. Posted-set
   precision and must-fix retention come straight from the grades on what
   `select` keeps.
3. The risks to measure: `select` merging two distinct real defects, or
   dropping a must-fix.
4. Then run one end-to-end arm per dataset through the real workflow with
   `reviewEngine: sites`, and grade it.

**Expected cost and latency per PR:** about $1.1 for the investigators
(measured) plus cents for `select`, and about 6–10 min of wall clock on
docker. Today's agent-survey pipeline costs about $2–4 and takes 23–47 min,
and `adjudicate` spent $2.39 to post nothing on 1587-r2.

## The open decision

The note at the end of `unit-survey.md` left two options open: admit fewer
rows, or split adjudicate into per-family chunks. The screen argues against
both:

- **Admit fewer rows** means some rank over rows, and the only rank over rows
  we have measured (`top:40`) loses half the gold. Site support is a better
  rank, but it ranks sites, and cutting to sites is the proposal.
- **Per-family chunks** keep "one call, many rows" at a smaller scale, and they
  cut exactly the cross-family agreement the screen found to be the signal.

**Recommendation (revised after the pilot): site clustering (±20, across
families, distinct-unit votes, span cap, tests skipped) → a site-review
investigator for the top 5 with subject leads → setwise selection of the
posted 5.**
Next steps, each gated on the one before (the eval spend gate:
$0 → replay → paid):

1. ~~Read the two misses by hand, then land clustering as a
   `lastlight-code-facts` module~~ — done: `clusterSites`
   (`packages/code-facts/src/site-cluster.ts`, tests in
   `tests/site-cluster.test.ts`). Not yet a CLI verb or a phase.
2. ~~**Per-site falsify replay**~~ — pilot done (above): safe, poor yield,
   $6.38/case. Superseded by **3a**. Originally (`micro-falsify --plan sites:10`) on the 1587
   fixtures: gold sites refuted (must be 0), claims per site verified,
   $/case, wall clock.
3a. **Site-review replay**, arms A (no leads) and B (subject leads), `sites:5`.
3. **Tournament replay**: setwise top-5 over the surviving sites, scored by the
   posted-review grader (`gradeReview`) and `goldPromoted`, against
   admit-all-then-adjudicate where that finishes.
4. **Outcome logging in prod** (resolved / line changed within 7 days) —
   independent of 1–3, and the only path to a learned ranker.

## Decision rule for `surveyEngine: units` (carried over from stage 3)

Unchanged from `unit-survey.md`: flip `surveyEngine: units` only if its recall
is within the agent baseline's run-to-run range and case wall clock drops
substantially. What is new is the order: the whole-pipeline A/B (≥ 2 runs per
arm, baseline / units, review on/off) runs only after the replays above show
that the post-survey phases can absorb unit-survey volume. Until then, a
units arm measures adjudicate's non-convergence, not the survey.
