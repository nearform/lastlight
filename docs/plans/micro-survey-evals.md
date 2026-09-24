# Micro-survey evals — what we know, and the levers left to test

> **Status: 2026-09-23.** The tool exists and works (`apps/evals/scripts/micro-survey.ts`, shipped in `559a7fa6` with its dashboard page). This file is the context that is expensive to re-derive: what it measures, the traps its metrics carry, what has already been measured with it, and what is worth measuring next. Numbers here are cited to the run that produced them so a later reader can check rather than trust.

## Why it exists

A full `pr-review` eval case runs ~13 phases and took **23–47 minutes** at `--concurrency 3` (arms `2026-09-22_191307` / `2026-09-22_201815`). So the feedback loop on a survey-prompt or skill edit was a ~$30, hour-long, 8-case arm — whose run-to-run band is **wider than most effects being tested**. Those two arms were identical in every input and scored **12/25 and 8/25**.

Almost none of that machinery bears on the question that actually moves recall: **does a survey branch, standing at a real defect, write the RISK or the REASSURANCE?** The CONFIRM audit of `1587-r3` (2026-09-22) found the pass reaching two gold and recording them as *"Dual-roster race condition **resolved**"* and *"Nonce max-age **enforced** server-side"* — right lines, opposite verdict.

So: replay ONE branch, on the SAME workspace the arm ran on, with the same prompt + obligations + model. **~2 minutes, ~$0.25.**

```bash
npx tsx apps/evals/scripts/micro-survey.ts \
  --fixture ~/lastlight-micro-fixtures/arm2/prreview__skillspro-1587-r3 \
  --family enforcement --instances evals/datasets/pr-review/instances.json \
  --repeats 8 --label my-candidate
```

Reports stream to `eval-results/micro-survey/` after every repeat → the dashboard's `/api/micro` (`#/micro-survey`).

## The fixtures — and why they are not in `$TMPDIR`

`~/lastlight-micro-fixtures/{arm1,arm2}/<instance_id>/` — 16 preserved workspaces (1.1 GB) copied out of the two 2026-09-22 arms. **macOS purges `/var/folders`**, and the campaign already lost 216 of 237 preserved workspaces that way. Regenerating one costs a full arm (~$30, an hour). Copy new ones out of `--keep-workspace` runs before they evaporate.

A fixture holds the checkout, the staged diff, the seeded obligations *and their discharge contract*, and the frozen `.lastlight-skills/` bundle. Everything upstream of the branch is deterministic — the plan records the seed as byte-identical across runs — so replaying it removes the upstream half of the variance and leaves the half under test.

## Fidelity rules, each learned by getting it wrong

| rule | what breaks without it |
|---|---|
| **Copy the TASK dir, not the checkout** | the composed `AGENTS.md` (12,540 chars of operational rules) is a **sibling** of the repo, and Pi auto-loads the first `AGENTS.md` walking **up** from cwd. Copying only the checkout silently runs the agent with no persona or rules at all. |
| **Stage the skill fresh from core**, never the fixture's frozen bundle | iterating on `skills/survey-pass/SKILL.md` is the entire point; the bundle is a snapshot of the old one. |
| **Ambient skill discovery follows core** (`noSkills: true` since `559a7fa6`) | pre-fix, Pi's discovery added whatever was on the host. `--ambient-skills` reproduces that, and exists ONLY to re-derive an archived number. |
| **`spec` needs `--spec-from`** | its obligations are built harness-side, not seeded to `obligations/spec.md`, so they exist only inside a preserved transcript. Without the flag the prompt renders its *"no obligations were attached"* branch and measures a pass that never ran — so the script refuses instead. |
| **Verify a claim about the agent's context against the run, not the code** | see "ambient skills" below — the doc comment and the reality disagreed twice, in both directions. |

## The metrics, and the traps in them

### `fireRate` is the headline, because `needsProbePct` is bimodal

On `enforcement`, a run marks either ~5 rows `needsProbe` or **none** — 0% or 41.7% of 12 rows, almost nothing between. A per-run percentage is therefore Bernoulli trials in a continuous disguise, and **a mean over them is meaningless**. `fireRate` = repeats that asked for at least one probe ÷ repeats done.

**Measured:** Haiku 4.5 on identical config scored **1/3 then 3/3** (reports `claude-haiku-4-5-20251001` and `screen-claude-haiku-4-5-20251001`, ~40 minutes apart). Combined 4/6.

**So: 3 repeats cannot rank anything.** `MICRO_RANKABLE_REPEATS = 8` is enforced in the UI rather than left to discipline. Three repeats can tell you a model is *broken*; they cannot tell you one is *better*.

### `reassuranceShaped` is a lexical tripwire, not a judge

A regex over claim text. It cannot tell a true "this is fine" from a missed defect, and a prompt edit that merely teaches the model to avoid the word "correctly" would move it while changing nothing. **Read the dumped claims.**

### The heartbeat must tick independently of repeats

A repeat takes 2–5 minutes; the dashboard's staleness bar is 90 s. A heartbeat written only *between* repeats goes stale mid-repeat and a healthy run reads as killed. There is now a 15 s ticker. (The inverse failure — silence reading as progress — is why `microStatus` exists at all.)

## What has been measured

### The two arms (2026-09-22, the last measurements of the pre-`noSkills` pipeline)

| | arm 1 `191307` | arm 2 `201815` | baseline |
|---|---|---|---|
| matched /25 | 12 (0.48) | 8 (0.32) | 9 (0.36) |
| precision / F1 | 0.48 / 0.48 | 0.38 / 0.35 | 0.40 / 0.41 |
| $/case | 3.69 | 4.41 | 3.87 |
| blind / train | 7/12 · 5/13 | 5/12 · 3/13 | — |

**The baseline sits inside both bands: no detectable change in recall or cost.** Arm 1 alone read as a win and was retracted by arm 2 — the canonical example of why one arm is never a result.

**Union/intersection is the stable read.** Across the two arms: union **14/25 (0.56)**, intersection **6/25 (0.24)**, 8 gold found by exactly one arm, 11 by neither. Against the archived wp3 triple (union 0.440, intersection 0.040) — and union grows with more runs while intersection shrinks, so 0.56 from **two** runs beating 0.44 from **three** is the robust half of that comparison. Capability improved; single-arm recall could not see it.

On the corrected denominator (19 of 25 gold are in-tree reachable; the other 6 need `node_modules`, external API semantics, or non-repo facts), union is **14/19 = 0.74** against single arms of 0.42–0.63.

### The discharge lever (`c4810269`) is inert

`needsProbe` ran at **11.5%** (arm 1) and **12.7%** (arm 2) against a **15.6%** baseline — it was designed to *raise* that by ~5 rows/case. Both arms below. The rule is present in the skill and read by all five branches (verified: the new wording appears 5× per case in the transcripts); it simply does not change behaviour.

### Ambient skills reached the agent — but were never used

Pre-fix, **69 of 69** agent sessions recorded `"noSkills": false`. Of the operator's 20 personal skills, **8 were `modelInvocable`** (`tdd`, `codebase-design`, `diagnosing-bugs`, `domain-modeling`, `drizzle-orm`, `editor`, `find-skills`, `grilling`) and so were in the reviewer's system prompt; the other 12 set `disable-model-invocation` and were hidden. **Zero tool calls ever read any of them** — the cost was catalogue entries and whatever the names steered.

Fixed in `559a7fa6` on all four backends. Verified empirically, not from a comment: with `noSkills: true` **and** an explicit `skillPaths`, `skills_status` reports `discovered: 1`, `survey-pass`, `modelInvocable: true`. Explicit paths still load.

**This breaks comparability with the whole archive**, which was measured with those 8 present.

### Severity is the most unstable thing measured so far

Severity is **the only ranking input** to what reaches a maintainer: `review-poster.ts` ranks on `SEVERITY_WEIGHT = { critical: 3, important: 2, minor: 1 }` alone (`confidence` was dropped from `rankOf` at AUROC 0.228, inverted; the per-family thresholds and internal floor are gone), then `maxBodyComments` trims the tail. Three distinct values means document order decides most of the cut.

It is assigned by the model, per hypothesis, from the `"severity": "Critical|Important|Minor"` slot in the obligations block (`code-facts/src/seed-render.ts`) with the vocabulary defined in `survey-pass/SKILL.md`'s **Finding tiers** table. Across the two arms, same cases, identical config:

| case | Critical arm1 → arm2 | Imp+Crit share |
|---|---|---|
| `1587-r1` | 0 → **5** | 18.0% → 38.0% (**+20.0**) |
| `1587-r3` | 1 → **6** | 17.6% → 28.0% (+10.4) |
| `1587-r2` | 3 → **8** | 16.0% → 26.0% (+10.0) |
| **`1641`** (empty-gold canary) | **9 → 0** | 40.9% → **2.9%** (**−38.0**) |
| `1667` | 0 → 0 | 23.8% → 7.1% (−16.7) |

Two distinct problems. **`Critical` is a lottery on the `1587` family** — 0→5, 1→6, 3→8 on identical input, which is a mechanical channel for posting a different set independent of what was *found*. And **`1641` graded 9 of 22 rows `Critical` on a PR with zero gold** in arm 1 versus 0 in arm 2 — the anti-speculation rule holding in one run and collapsing in the other, on the one case built to catch exactly that.

Also: **`unknown` severities exist** (4–8 rows on several cases). They do not drop out — `rankOf` reads a missing/unrecognised severity as `important` (weight 2), so they land mid-rank by default rather than by judgement.

### The model screen (2026-09-23) — parked, and what it settled

Nine models, `enforcement` on `1587-r3`, 3 repeats each. **Screening only** — 3 repeats cannot rank (see `fireRate` above).

| model | fired | cost / 3 repeats |
|---|---|---|
| `glm-5p3-flash` | 3/3 | **$0.089** |
| `haiku-4-5` (incumbent) | 3/3 | $0.67 |
| `glm-5p3` | 3/3 | $1.279 |
| `sonnet-4-6` | 2/2 (3rd killed by operator error) | $1.34 |
| `sonnet-5` | 3/3 | $1.51 |

`kimi-k3`, `deepseek-v4p1-flash`, `qwen3p8-max`, `minimax-m3` were queued and not reached.

**What it settled:** every model tested drives the agent loop and holds the discharge contract — there is no "this model cannot do the task" result hiding here. And `glm-5p3-flash` matched its full-size sibling on fire rate, row count and severity mix at **1/14th the cost**, which makes it the obvious iteration model and a serious candidate for the five-branch fan-out (survey is ~40% of pipeline spend).

**What it did not settle, and why it was parked:** nothing about *quality*. Fire rate separates broken from working, not better from worse, and at 3 repeats the bands overlap completely. Pushing to 8–10 repeats per model would cost hours to answer a question that is not the bottleneck. Severity is.

Also: `models.json` is stale — it still lists `glm-5p2`, `deepseek-v4-pro`, `gpt-oss-120b`. The live Fireworks registry is the source of truth.

## The severity experiment (SUPERSEDED 2026-09-23 — kept for the measurements)

> **This thread is closed.** It asked whether a prompt change could make severity stable, and the answer turned out to be that the question was wrong: severity is now DERIVED from an evidence record in code, so no prompt decides it. Read the next two sections for what shipped. What follows is kept because the MEASUREMENTS are expensive and still true — the blow-up rates, the per-family failure modes, and the `1641` canary baseline — and because the candidate levers it lists were tested and their outcomes are recorded below.

**The question.** Severity is the only ranking input to what a maintainer sees, and it is neither stable nor discriminating. Can a prompt change make it either?

### Why `1641` / `spec` is the right fixture

`1641` is the campaign's **empty-gold precision canary** — a PR with **zero** gold findings. So *any* row graded above `Minor` is wrong **by construction**, which makes the metric deterministic, judge-free and free to score. Target is **0**.

Arm 1 graded **9 of 22 rows `Critical`** on it; arm 2 graded 0 Critical / 1 Important. And the nine came from exactly one branch:

| family | rows | above-Minor |
|---|---|---|
| `spec` | 10 | **9** (all Critical) |
| `state` | 8 | 0 |
| `contract` / `enforcement` / `security` | 1 / 2 / 1 | 0 (all severity-less) |

So the case-level instability is **one family mis-grading**, not diffuse drift.

### The claims say what is wrong

> `[Critical] The PR replaces the four .eslintrc* files (root, backend, sheets-scripts, forms-scripts) with …`
> `[Critical] Apps Script globals (DriveApp, FormApp, Logger, MailApp, etc.) are restored for sheets-scripts/ …`
> `[Critical] The prettier/prettier rule remains enabled and require-extensions is configured for the backend, …`

These are **restatements of the intended change**, not findings. Two rules already forbid this and neither bound: the skill's *"Not findings"* table (*"If the diff is doing X on purpose, 'this does X' is a restatement, not a finding"*) and its `Critical` bar (*name the boundary the input crosses and a capability the supplier does not already have*).

**So the first question is not "what rule do we add" but "why are two existing rules not binding on this branch."** `survey-spec.md`'s own job — checking the PR description's claims against the code — is inherently restatement-adjacent, and may be undercutting them.

### Running it

`spec` is the one family with no `obligations/spec.md`: its obligations are built harness-side and rendered into the prompt as `{{specObligations}}`. `--spec-from <NN-survey_branch_spec.jsonl>` recovers them from a preserved transcript — rendering the CURRENT template with a sentinel, splitting on it, and slicing the recorded prompt between the same anchors. The surrounding prompt stays editable (that is the experiment) while the obligations stay byte-identical to what the arm discharged. **It refuses rather than splices** when an anchor fails to match, because a silent miss would render the "no obligations were attached" branch and measure a pass that never ran.

```bash
T=eval-results/pr-review-config/2026-09-22_191307-e014b96/sessions/prreview__skillspro-1641__*/trial-1/08-survey_branch_spec.jsonl
npx tsx apps/evals/scripts/micro-survey.ts \
  --fixture ~/lastlight-micro-fixtures/arm1/prreview__skillspro-1641 \
  --family spec --spec-from $T \
  --instances evals/datasets/pr-review/instances.json \
  --repeats 8 --model fireworks/accounts/fireworks/models/glm-5p3-flash \
  --label spec-canary-<candidate>
```

~$0.03/repeat, so 8 repeats is ~$0.25 and minutes. Read `severity.critical + severity.important`; **target 0**.

### Rules for this experiment

- **Tuning on `glm-5p3-flash` may not transfer to Haiku**, which is what the pipeline runs. Flash is for iteration speed; any candidate that wins gets one confirmation run on Haiku before it is believed.
- **A zero on the canary is necessary, not sufficient.** Grading everything `Minor` scores perfectly here and destroys the ranking signal — which is exactly what Sonnet-5 and `glm-5p3-flash` already do on `enforcement` (12/13/12 and 14/15 rows all `Minor`). **Any candidate must be checked against a case WITH gold** so it is not rewarded for refusing to use the top tiers at all. This is the trap that makes the canary alone misleading.
- The obligations block tells the pass *"write it at `severity: "Minor"` and let a later phase decide what is worth posting"* (`code-facts/src/seed-render.ts`), while the skill's tier table asks for a real judgement. **These pull in opposite directions** and that tension is a prime suspect for both failure modes — the all-`Minor` collapse and the false Criticals.
- `unknown` severities are not harmless: `rankOf` reads a missing or unrecognised severity as `important` (weight 2), so they land mid-rank by default. Three of the five families on `1641` emitted rows with no severity at all.

### Baseline measured (2026-09-23) — `1641` / `spec`, post-`noSkills`

**Haiku 4.5 — the model the pipeline runs, and the one that exhibits the failure.** 4 repeats, $1.40 (`spec-canary-haiku`):

| repeat | rows | Critical | Important | Minor | above-Minor |
|---|---|---|---|---|---|
| 1 | 10 | 0 | 1 | 9 | 1 |
| 2 | 10 | **4** | **5** | 1 | **9** ← blow-up |
| 3 | 20 | 0 | 2 | 18 | 2 |
| 4 | 10 | 0 | 1 | 9 | 1 |

**Blow-up rate 1/4.** Spreads: `critical 0/4/0/0`, `minor 9/1/18/9`. Three repeats are well-behaved and one **inverts completely** — this is an occasional total collapse of tier discipline, not a drift. Row count moves independently (10/10/20/10): repeat 3 produced twice the rows and stayed calm, so "more rows ⇒ more Criticals" is not the mechanism.

This also explains the arms: arm 1 hit the collapse on `1641` and arm 2 did not. Two samples of one bimodal process, not two behaviours.

**`glm-5p3-flash` — 0/6 blow-ups, and that is NOT a pass.** 6 repeats, $0.344: 61 rows, **zero `Critical` ever**, two `Important` in total. That is the all-`Minor` collapse, the same one Sonnet-5 shows on `enforcement` (12/13/12 rows all `Minor`). A model that never uses the top tiers cannot mis-grade a zero-gold PR *and* cannot rank a real finding above a trivial one — which is severity's only job. **So flash cannot be the iteration model for this experiment**, despite being 4× cheaper. Iterate on Haiku (~$0.36/repeat).

### All five families are implicated, in three different ways

On `1641` (arm 1), severity failed differently per family — so a fix aimed only at `spec` would leave two other failure modes untouched:

| family | rows | what went wrong |
|---|---|---|
| `spec` | 10 | **over-grading** — 9 `Critical` on a zero-gold PR |
| `state` | 8 | **all-`Minor` collapse** — 8/8, no discrimination |
| `contract` / `enforcement` / `security` | 1 / 2 / 1 | **no severity at all** — every row `unknown` |

The third is the quietest and arguably the worst: `rankOf` reads a missing or unrecognised severity as **`important`** (weight 2), so those rows land mid-rank *by default rather than by judgement*, and nothing anywhere reports it.

## NEXT STEPS — landing this, then the full run

The severity thread is no longer "rewrite the prompt until it ranks consistently". The verdict is derived in code (next section), and what remains is finishing the seam and measuring it. In order:

### 1. Decide the one open design question: who owns severity at POSTING time

Derivation currently reaches the dossier and stops. `adjudicate-pass/SKILL.md` gives the adjudicator its **own** two-value vocabulary (`Critical` / `Important`) and it re-decides severity for every finding it keeps; `review-poster.ts` then ranks that. So the survey's derived severity bounds what the adjudicator *sees*, and does not determine what is *posted*.

Three options, and this is a judgement call rather than a mechanical edit:

- **(a) The adjudicator inherits.** Findings resolving to a hypothesis keep the derived severity; the adjudicator may drop a finding but not re-rank it. Fully deterministic. **Cost:** the adjudicator sees probe results the survey never had, so it is strictly better informed — this throws that away.
- **(b) The adjudicator may only DEMOTE.** It inherits, and may lower a severity when a probe contradicted the row, never raise one. Keeps the new information, keeps the ceiling deterministic, matches the one-way direction `EDIT_CONDITIONAL` already uses.
- **(c) Leave it.** Accept that posting-time rank is a model judgement and that survey-level stability does not transfer.

**(b) is the recommendation** — it is the only one that keeps both properties — but it needs sign-off before implementation because it changes what the adjudicator is allowed to do.

### 2. The five families — MEASURED 2026-09-23, and what it caught

All four runnable families now write evidence on 100% of rows, fire probes in 3/3 repeats, and produce **zero `Critical` in twelve repeats**:

| family | rows | evidence | probes | derived severity |
|---|---|---|---|---|
| `contract` | 12 | 12/12 × 3 | 75 / 58 / 75% | 12 Minor × 3 (stable) |
| `security` | 8 | 8/8 × 3 | 62 / 62 / 37% | 8 Minor (spread 1) |
| `state` | 8 | 8/8 × 3 | 87.5% × 3 | 6/4/4 Important · 2/4/4 Minor |
| `spec` | 10 | 10/10 × 3 | 100 / — / 80% | 1/0/1 Important · 9/10/9 Minor |

**`tests` cannot be run at all** — `pr-review.yaml` declares no branch for it (the AC3 test pins that), so the family is seeded with obligations that nothing ever discharges and `survey-tests.md` is dormant. Its evidence section is untested and will stay that way until a branch exists.

**The first attempt at this failed, and the failure is the lesson.** Only `enforcement` had been iterated on, and only its prompt carried a worked example with the record inline; the others had a pointer. Under a replay — frozen obligations block, still prescribing the old row shape — three of four followed the block and wrote no evidence, `severityOf` fell back to the pass's own guess, and `spec` graded **ten of ten rows `Critical`** on the zero-gold canary while every other number looked ordinary. Fixed by giving every family its own worked row plus an explicit "ignore the block's `severity`/`needsProbe`", and by making `missingEvidence` a reported fact.

**Still unresolved:** `contract` returns 12 Minor and `security` 8 Minor in every repeat. That is either correct for this PR or the all-Minor flattening, and **this fixture cannot tell them apart** because its gold sits on the enforcement axis. Before trusting either family, run one case with known `contract` or `security` gold.

### 3. Then the full `pr-review` run

Not before 1 and 2. A full arm is ~$30 and an hour, and its ranking is the thing under test — running it while posting-rank is still undecided measures a configuration we do not intend to ship.

**Config to run it with, as currently believed correct:** Haiku 4.5 on the survey branches, the `full` contract, declared skills only (`noSkills: true`), `review.analysis.enabled`, probes ON. Record the config in the arm label. And per the house rules, **two arms minimum** — one arm has never been a result in this campaign.

### 4. Known gaps to close while you are in here

- **`apps/evals/scripts/` is not typechecked.** The package tsconfig has `include: ["src/**/*"]`, so `micro-survey.ts` is invisible to `tsc`; a deletion that removed three live functions passed typecheck and failed at runtime. Either widen the include or give scripts their own tsconfig.
- **The declared-vs-derived signal goes silent in production.** The pass no longer writes `severity`/`needsProbe`, so `verdict.agrees` — which caught BOTH rule bugs in this thread — will have nothing to compare once the new contract ships. Replays still show it because a fixture's contract is frozen. Decide whether to keep asking purely as telemetry.
- **`confidence` is no longer asked for**, but `findings.ts` still passes one through when a row carries it. That is deliberate (audit data, and the internal record exists to carry the row), not an oversight.

## The first full arm on the derived verdict (2026-09-23, `2026-09-23_150604-e014b96`)

Config byte-identical to `wp3-minimal-d2ab-probes-sonnet-dossier` below `models:` — `overlays/verdict-derived` in the evals workspace. Nothing in the config is the variable; the change is entirely core.

| arm | matched /25 | precision | recall | $/case |
|---|---|---|---|---|
| `191307` | 12 | 0.48 | 0.48 | 3.69 |
| `201815` | 8 | 0.38 | 0.32 | 4.41 |
| **`150604` (this)** | **11** | 0.38 | 0.44 | **3.49** |

Inside the band on every axis, cheapest of the three, 8/8 behavioural. **One arm against two orders nothing** — it can only fall inside or outside that band, and it fell inside.

### The probe result is the finding, and it kills the budget plan

| arm | probes | reproduced | refuted | **unprobed** |
|---|---|---|---|---|
| `191307` | 45 | 18 | 24 | 3 (7%) |
| `201815` | 95 | 39 | 50 | 6 (6%) |
| **`150604`** | 87 | **4** | **18** | **65 (75%)** |

The reassurance-verification clause did exactly what it was built to do — it routed clean discharges to the oracle — and **the oracle cannot settle three quarters of them.** `unprobed` ("nothing you could run would decide this") went from ~6% to 75% of verdicts.

**So hypothesis 7's premise was wrong.** The question is not *which* reassurances to probe but that reassurances are largely unprobeable AS A CLASS: a clean discharge asserts "I read the line and it is fine", and there is often no differential experiment that contradicts that. The 50%-refutation figure mined from the archive (165 of 332) came from probes on rows the model itself FLAGGED — suspicions — and **it does not transfer to reassurances.** That was foreseeable and was not flagged hard enough before the run.

Yield: 4 reproduced + 18 refuted against 65 dead ends, versus ~90% actionable in both comparators. Not free either — 87 attempts is comparable to `201815`'s 95, which ran at $4.41/case.

**Two candidate responses, neither measured:**

- **Narrow the trigger** so it fires only where a probe could bite — require `cannot_distinguish != "nothing"` even on a changed hunk, that being the field naming a testable ambiguity. Likely collapses probe count toward the old rate while keeping the contradictable rows.
- **Keep it, change the consumer** — treat an `unprobed` reassurance as a signal in its own right (a claim nothing can verify) rather than spending an oracle turn to discover that.

Either way the next arm should test one of them, and a second arm on THIS config is still owed before 11/25 or the 75% is treated as stable.

## Hypotheses for further tightening — untested, in rough order of expected value

Each is a candidate **deterministic normalisation over the evidence**, which is the lever this thread discovered: once the verdict is derived, a bad verdict is fixed by reading what the pass wrote, not by another paragraph. All are testable for free against the persisted rows under `eval-results/micro-survey/rows/` before any spend.

1. **The borderline `consequence` decision is the whole remaining spread.** Measured over 8 repeats on one fixture, 4 of 12 rows are perfectly stable and the variance is one binary question — *does this constant's situation constitute a consequence?* — on duplicated-constant rows that flip 7-1 or 6-2, not 50/50. **Hypothesis:** a row whose `consequence` names no runtime behaviour, only a divergence between two copies of a value, is a duplication note. Detectable from the text, and it is the same family of tell as `EDIT_CONDITIONAL`.
2. **`crosses_boundary` is asserted far more often than it is earned.** It is a free `true` today. **Hypothesis:** require it to be justified by a *named* boundary, i.e. treat `crosses_boundary: true` with an empty or generic `capability_gained` as `false`. One-way, demote-only.
3. **`cannot_distinguish: "nothing"` is the single most load-bearing claim in the record** — it is what lets a clean discharge escape a probe — and it is unverifiable. **Hypothesis:** it is also the cheapest thing to probe. Rather than tightening it, route it: a `"nothing"` on a changed hunk already forces a probe, so measure how often the probe contradicts it. If it contradicts often, the field is not trustworthy and the clause should widen to untouched code too.
4. **`unknown` may be underused.** `authority: unknown` and `order_ok: unknown` both force a probe, so they are honest and cheap — but a model that dislikes saying "I do not know" will round to `binding`/`true` and escape verification. **Hypothesis:** count `unknown` usage per repeat; near-zero across many repeats is evidence of rounding, not of clarity.
5. **Row count is suspiciously constant** (12/12 on every repeat of every arm, matching the obligation count exactly). The pass discharges its list and adds nothing. **Hypothesis:** the obligations are acting as a ceiling on discovery, not a floor — which would cap recall regardless of how good the verdict is, and would explain why a gold defect within reach of an obligation is reassured away rather than missed.
6. **The gold row asserts a consequence in 1 of 8 repeats.** Probes now fire on it regardless (clean discharge over a changed hunk), so the verdict path is doing its job; what is not happening is *discovery*. **Hypothesis:** this is a sampling problem, not a prompt problem, and it is the same conclusion the union-vs-intersection analysis reached. No normalisation will fix it.

7. **The reassurance-verification clause has no budget.** `QUOTE && in_changed_hunk ⇒ probe` is what rescued the probe rate from 0/0/0, and it is unbounded: on the zero-gold canary every one of ten rows was a clean discharge over a touched file, so it asked for ten probes that can find nothing. Measured probe rates are now 37–100% of rows per repeat, against ~16–42% before. **Hypothesis:** the rule is right and needs a cap — probe the N highest-value clean discharges per family, or narrow the trigger from "any touched file" to "a hunk the obligation itself names". This is the one tightening that is about COST rather than correctness, and it should be measured before the full run rather than discovered in its bill.


## The verdict is derived in code now — and one half is still outstanding

**Done (2026-09-23).** `severity` and `needsProbe` are no longer asked of the survey. A pass fills a typed `evidence` record — `control_site`, `control_text`, `authority` (`binding|advisory|unknown`), `order_ok`, `cannot_distinguish`, `bypass`, `in_changed_hunk`, `consequence`, `trigger` (`input|state|code_change|unknown`), `crosses_boundary`, `capability_gained` — and `deriveVerdict()` in `packages/code-facts/src/survey-verdict.ts` computes the verdict from it. The fields are named for the shape all six families share (a mechanism, and a line that closes it), so one record serves every pass: a comparison closes a value's boundary, a sanitiser closes a tainted path, an invalidation closes a cache, an assertion closes an untested line, an implementation closes a criterion. Each prompt fixes only what *closing* means for it.

It is applied once, in `readHypothesisSet`, which records the derived verdict **and** what the row declared, plus `agrees: {severity, needsProbe}` — the disagreement is prompt telemetry, and flattening it would destroy the only signal that says a pass is not doing what it was asked. `apps/evals/scripts/micro-survey.ts` imports the same function rather than keeping a copy (which is why `apps/evals` now depends on `lastlight-code-facts`); two authorities over one rule is the bug this whole thread is about.

Two rules were corrected BY the measurement and are pinned in `packages/code-facts/tests/survey-verdict.test.ts`. Absence alone must not force a probe — it demanded probes for harmless never-compared constants, and the model was right to refuse. And `Critical` needs `trigger in (input, state)`: without it, a consequence of the form *"if this constant is later changed…"* gets promoted, though whoever makes that edit already holds every capability it would grant.

### STILL OUTSTANDING — the downstream half

Nothing on the **posting** path reads the derived verdict yet.

- `adjudicate-render.ts`, `jev-classify.ts`, `findings.ts` and `probes.ts` now go through `severityOf(row)` (derived, falling back to whatever the row declared), so the dossier and the probe priority are correct.
- But `review-poster.ts` ranks `ReviewFinding.severity` off `findings.json`, which the **adjudicator model** writes. The value that actually decides what a maintainer sees is still a model's judgement, one stage later. Deriving the survey's severity bounds the input to that stage; it does not make its output deterministic.
- **The change to make:** carry the derived verdict through adjudication so a finding's rank is a function of evidence, or have the poster rank on the hypothesis verdict wherever a finding resolves to one. Until that lands, **ranking is not deterministic in production** and the stability measured at survey level does not transfer to what gets posted.

Smaller, same thread: `confidence` is no longer asked for anywhere, but `findings.ts` still reads `row.confidence` and will now always see `null`. Harmless — it measured AUROC 0.228, inverted, and `rankOf` already ignores it — but a field that can only ever be null should be deleted rather than left being read.

## Contamination removed from the shipped prompts

The `full` discharge contract used to ship a worked exemplar built from a real defect in a repository whose PRs are **in this eval set**, so any arm measured against it was handed a worked answer to a neighbouring case. Both exemplars (`EXAMPLE_ROW` in `seed-render.ts`, `SPEC_EXAMPLE_ROW` in `review-spec.ts`) are now invented — a fictional upload route — and teach the same lesson: a real line, really quoted, that still does not close the mechanism because it runs on the side the other party controls. Every rendered string naming a dataset symbol, repository or issue number is gone. Code comments recording *which run measured what* are provenance and stay.

**For anyone replaying:** a fixture's obligations block is **frozen**, so a replay renders the contract as it stood when the arm ran. Changes to `seed-render.ts` / `review-spec.ts` are therefore not measurable through `micro-survey.ts` at all — only the prompt and the skill are.

## Open, and unresolved

- **The replay does not reproduce the arm.** The preserved arm wrote **0%** `needsProbe` on `enforcement`/`1587-r3`; the faithful replay wrote **41.7% three times running** from the same workspace, prompt, obligations, model and skill — same 12 rows. Something still differs. **Until this is reconciled the micro-eval can compare its own arms (it clearly can) but cannot be trusted to predict the full pipeline.** This is the first thing to chase.
- **Two instruments disagree on `1587-r3`.** The posted scorecard credits arm 1 with 2 matched; the internal CONFIRM audit credits 0. Different judges over different artifacts (review text vs pipeline findings). Resolve before treating either as load-bearing.
- **`1667` is a genuine discovery miss**, not a saying miss: arm 2's misses on the auth-ordering and rate-limiting gold are `MISS` at the *internal* level — never generated. No prompt lever recovers those; only sampling or a different model would.
- **Repeated survey sampling is ruled out on latency grounds** (operator decision, 2026-09-23) even though union ≫ single-arm recall. Any "harvest the variance" design has to fit inside the current wall clock.

## Open-model screens, and the quality view they forced (2026-09-24)

Five models screened on two fixtures, 8 repeats each, all via OpenCode Zen except the reference: GLM 5.3 Flash, DeepSeek V4.1 Flash, DeepSeek V4 Flash, MiniMax M3, and Haiku 4.5 on current code (`haiku-current`). Fixtures: `arm2/1680-r1` · `enforcement` (seeded with **zero** checks — open discovery) and `arm2/1667` · `contract` (12 seeded checks). Reports live in `nearform-evals/eval-results/micro-survey/2026-09-24T03-43-39-*` and `…T03-58-*`/`…T04-*`.

### The instrument changed first — counts are not quality

`needsProbe%` and `fireRate` count probe requests. A pass that finds nothing and asks to verify every row scores 100% — measured: GLM 5.3 Flash on `1667` scored 100% on repeats whose rows were **10–12 clean discharges** (`verify`) and 0–2 real risk claims. So the report now also carries, per repeat:

- **the gold overlay** — per gold: *found it* (the internal-recall judge, MATCH + CONFIRM, credits a row), *looked, said fine* (a row cites within ±15 lines of the anchor but asserts nothing wrong), *never looked*; and probes split on-gold / off-gold. Plus an F1: recall = gold found ÷ the case's gold, precision = credited claims ÷ claims, where a *claim* is a row with derived severity Important+ that is not a clean discharge, or any row the judge credited.
- **the seed ledger** — the discharge gate's own `checkDischarge`: seeded / answered (by back-pointer — under `minimal` no code exists) / skipped / own rows / **lines lost** (unparseable) / gate.
- **per-row view** — the check each row answers and why it probes: `verify` (clean discharge over a changed hunk), `risk`, `gap`, `unknown` — from `probeReasonOf`, beside `deriveVerdict`.

The baseline's gold overlay is judged ONCE per fixture by a 3-vote majority and cached (`.judge-cache/`): five single-pass judgements of the same stored rows came back 0/4 three times and 1/4 twice, at temperature 0.

### A dead fixture: `1587-r3`

Every CONFIRM-era full Haiku arm (`023026`, `094738`, `191307`, `201815`, `150604`) found **0 of its 4 gold across all families**, and so did every model in a screen. It measures cost and nothing else. `1680-r1` enforcement and `1667` contract are the informative pairs — full arms found gold through those families.

### What the screens found (each is now enforced or visible)

1. **A prompt contradiction made Haiku skip unseeded families.** The family tables said *"NOT MEASURED → record that and stop"*, the skill comment said *"does not substitute a judgement for a measurement"*, and the seed block said *"not a licence to skip"*. Haiku wrote one `NOT MEASURED` row and stopped on 2 of 3 repeats of `1680-r1` ($0.43 each). Fixed in the prompts and skill (record it, THEN work the diff); `tests` alone keeps *stop*, because without coverage it can observe nothing. After the fix Haiku skipped 0 of 8 — and GLM went from gold in 1/8 repeats to 3/8 on the same fixture.
2. **The gate passed a placeholder-only pass**, and under `minimal` (the shipped default) passed anything with one row. `checkDischarge` now fails, under either contract: a zero-obligation family with no real claim; a seeded check no row names; a claim row with no `evidence` record. Measured case for the last two: **MiniMax M3 on `1667` answered 4 of 12 checks with no evidence on any row**, and the gate read only `fileState`.
3. **Multi-line / pretty-printed JSON loses rows silently — in prod too.** GLM (repeat 5, 72 lines) and DeepSeek V4 Flash (repeat 3) wrote ~9 KB of real rows the line reader dropped; and the preserved *full Haiku arm* on `1680-r1` lost 33 lines the same way. The ledger now shows `lines lost`. **Not yet fixed**: `hypotheses.ts` still parses line by line — it should parse a JSON object stream and count recovered objects.
4. **The seeder is blind to literals.** `1680-r1` enforcement seeded 0 because `constants` found no named constant: the TTL is a bare `120` passed to `imgCache.set`, the MIME filter an inline string, and the key file is in no tsconfig ("ended up in no program at all"). **Not yet fixed.**
5. **Seed location ≠ seed question.** `scripts/seed-questions.ts` (a judge per fixture) over 20 gold: 11 have a seeded question that would surface the defect, 4 are seeded but asked wrong, 5 are not seeded. Location recall alone (±15 lines) is 17/25 and flatters it.
6. **Unseeded markers need a defined shape.** Models write the "ran unseeded" first row as an ordinary claim (derived Minor), which reads as a finding and slips past a prefix test. Proposed: one marker row `{"id":"<family>-unseeded","unseeded":true,"surveyed":[…]}`, no claim.

### Standings (8 repeats each; repeats that found ≥1 gold)

| model | `1680-r1` enforcement (unseeded) | `1667` contract (seeded) | cost / repeat |
|---|---|---|---|
| DeepSeek V4.1 Flash | **6/8** | 6/8 | ~$0.08 |
| GLM 5.3 Flash | 3/8 | **7/8** | ~$0.02 |
| MiniMax M3 | 3/8 | 7/7 judged of 8 — gate fails 3/8 (no evidence r1; 2/12, 3/12 checks answered r2, r4) | ~$0.22 |
| DeepSeek V4 Flash | 0/8 | 7/8 | ~$0.03 |
| Haiku 4.5 (current code) | 1/8 | 5/8 | ~$0.28 |
| baseline (preserved arm) | G1 | G5 | — |

The continuation — process, tooling, backlog and run order for the full arms — is [`open-model-evals.md`](open-model-evals.md).

Read with the house rules below: 8 repeats rank a fire rate, not a gold rate, and two fixtures are two fixtures. What it does support: on **open discovery** DeepSeek V4.1 Flash is the only model that finds gold most of the time; on **seeded checks** the cheap models (GLM, DeepSeek V4 Flash) match or beat Haiku at a tenth of the cost; and Haiku on today's prompts is not the recall winner it was measured as on the Martian corpus.

### The full arms that followed (2026-09-24)

The screens' two survey picks, run through the whole pipeline beside the Anthropic baseline — runs `2026-09-24_054639-bc10db3` (`verdict-derived`, `oc-centre`, `oc-survey-glmf`) and `2026-09-24_105043-bc10db3` (`oc-survey-glmf-noprobes`), 8 cases / 25 gold each:

| arm | survey | matched | posted | P | R | F1 | $/case | min/case |
|---|---|---|---|---|---|---|---|---|
| `verdict-derived` (Anthropic) | Haiku 4.5 | 9/25 | 25 | 0.36 | 0.36 | 0.36 | $3.71 | 25.4 |
| `oc-centre` | DeepSeek V4.1 Flash | **20/25** | 63 | 0.32 | **0.80** | 0.45 | $2.33 | 45.9 |
| `oc-survey-glmf` | GLM 5.3 Flash | 18/25 | 47 | **0.38** | 0.72 | **0.50** | $1.96 | 29.7 |
| `oc-survey-glmf-noprobes` | GLM 5.3 Flash, no falsify | 16/25 | 47 | 0.34 | 0.64 | 0.44 | **$1.95** | **23.7** |

The screens held up at full scale: GLM 5.3 Flash's seeded-check strength carried it to the best F1, DeepSeek V4.1 Flash's discovery edge showed up as 2 more gold at 16 more posts, and both beat Haiku by far more than the screens implied. Precision did not move (0.32–0.38 everywhere) — the recall came with volume. Conclusions, caveats and next steps: [`open-model-evals.md` → "The finding"](open-model-evals.md#the-finding-2026-09-24--open-weights-beat-the-anthropic-stack-on-recall-at-half-the-cost).

## House rules this file encodes

- Never report one arm, or one repeat, as a result.
- A count is not a quality number. `needsProbe%` beside the gold overlay, always — and a fixture where nothing ever finds gold (`1587-r3`) measures cost only.
- Never show a mean or an SD of a bimodal metric; show every repeat plus a range, and `fireRate` as the aggregate.
- Always print the baseline beside the replay — a replay number alone is meaningless.
- A harness fault must never be reportable as a model result. (`timeout` does not exist on macOS; a first sweep reported 8 model "failures" that were entirely that.)
