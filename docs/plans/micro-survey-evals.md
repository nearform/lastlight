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

## The severity experiment (open — this is the active thread)

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

## NEXT STEPS — the plan for a fresh session

The baseline above is accepted as sufficient to start from (operator decision, 2026-09-23). Do not re-derive it.

**1. Write a new version of the survey prompts + skill, targeting severity across ALL FIVE families** — not `spec` alone. The three failure modes above are one problem (severity is not being decided) wearing three faces. Prime suspects, in order:

- **The two instructions contradict each other.** `code-facts/src/seed-render.ts` tells the pass *"write it at `severity: "Minor"` and let a later phase decide what is worth posting"*, while `survey-pass/SKILL.md`'s tier table asks for a real judgement with a trust-boundary bar on `Critical`. **One of them should own severity.** This is the most likely single cause of both the all-`Minor` collapse and the blow-ups.
- **`spec`'s brief is restatement-adjacent** — its job is checking the PR description's claims — and the blow-up rows are restatements of the intended change, which the skill's "Not findings" table already forbids. That rule is not binding on this branch.
- **Nothing forces a severity to be written at all**, hence the `unknown` rows. Consider making it non-optional in the discharge contract, or deriving it.

**2. Run 8 repeats per arm on Haiku**, baseline vs candidate, on `1641`/`spec`:

```bash
T=eval-results/pr-review-config/2026-09-22_191307-e014b96/sessions/prreview__skillspro-1641__*/trial-1/08-survey_branch_spec.jsonl
npx tsx apps/evals/scripts/micro-survey.ts \
  --fixture ~/lastlight-micro-fixtures/arm1/prreview__skillspro-1641 \
  --family spec --spec-from $T \
  --instances evals/datasets/pr-review/instances.json \
  --repeats 8 --model anthropic/claude-haiku-4-5-20251001 \
  --label spec-canary-<candidate>
```

~$3 per arm, ~40 min. Read `severity.critical + severity.important`; a repeat is a **blow-up** above 2 on a zero-gold PR. Compare blow-up rate against the 1/4 baseline. **If the comparison is not decisive, run more repeats rather than concluding** — 8 vs 4 on a ~25% rate is still weak, and the house rule is that an indecisive result is indecisive, not a pass.

**3. Check the other families too** — `state` (all-`Minor`) and any of `contract`/`enforcement`/`security` (missing severity) on the same fixture, which need no `--spec-from`.

**4. The counterpart case is MANDATORY before accepting any candidate.** The canary measures precision only, and grading everything `Minor` scores a perfect 0 — which `glm-5p3-flash` already demonstrates. Pick a fixture WITH gold (e.g. `1667`, 5 gold, or `1587-r3`, 4 gold) and check that real findings are lifted above `Minor`. A candidate that improves the canary while flattening the gold case has made things worse.

### Candidate levers, untested

1. **Reconcile the two instructions** — the seed-render default-to-`Minor` line vs the skill's tier table. One of them should own severity.
2. **Make `spec` inherit the "Not findings" restatement rule explicitly**, since its brief invites restatement.
3. **Derive severity rather than ask for it** — from probe verdict + category + mechanism completeness — which is what `computeTier` already does for the adjudicator's output.
4. **Collapse to two tiers.** Three values with one ranking input may be more precision than the model can hold; `Important` vs `Minor` might be more stable.



1. **Severity stability — ACTIVE, see "The severity experiment" above.** Ahead of the discharge rule: severity decides whether a finding is *posted at all*, it swings by ±20 points across identical arms, and it collapsed on the precision canary.
2. **Why the discharge rule is inert.** It is read and ignored. Before rewriting it again, find out whether the model treats it as inapplicable (most rows are genuinely not in a changed hunk?) or simply overrides it. The micro-eval dumps every claim, so this is readable rather than inferable.
3. **Model choice — PARKED**, see the model screen above. Everything works; `glm-5p3-flash` is 14× cheaper than its full sibling and is now the iteration model. Resume only if a quality question needs it.
4. **`AGENTS.md` ablation** (`--no-agents-md`). Never measured in isolation; it is 12.5 KB of rules in every branch.
5. **The cost of closing the ambient-skills hole.** Preliminary and inconclusive (bands overlap): ambient ON 41.7/41.7/41.7 vs OFF 16.7/0.0/41.7 and 0.0/0.0/41.7. At 8+ repeats this is answerable.
6. **Temperature — blocked upstream.** `pi-ai` exposes `temperature?: number`, but `agentic-pi` builds its agent through `pi-coding-agent`'s `createAgentSession({ cwd, model, thinkingLevel, … })`, which does **not** surface it. Needs an upstream change. And survey runs under extended thinking, where Anthropic pins temperature to 1 — so it is only a live variable for non-thinking runs or non-Anthropic models.

## Open, and unresolved

- **The replay does not reproduce the arm.** The preserved arm wrote **0%** `needsProbe` on `enforcement`/`1587-r3`; the faithful replay wrote **41.7% three times running** from the same workspace, prompt, obligations, model and skill — same 12 rows. Something still differs. **Until this is reconciled the micro-eval can compare its own arms (it clearly can) but cannot be trusted to predict the full pipeline.** This is the first thing to chase.
- **Two instruments disagree on `1587-r3`.** The posted scorecard credits arm 1 with 2 matched; the internal CONFIRM audit credits 0. Different judges over different artifacts (review text vs pipeline findings). Resolve before treating either as load-bearing.
- **`1667` is a genuine discovery miss**, not a saying miss: arm 2's misses on the auth-ordering and rate-limiting gold are `MISS` at the *internal* level — never generated. No prompt lever recovers those; only sampling or a different model would.
- **Repeated survey sampling is ruled out on latency grounds** (operator decision, 2026-09-23) even though union ≫ single-arm recall. Any "harvest the variance" design has to fit inside the current wall clock.

## House rules this file encodes

- Never report one arm, or one repeat, as a result.
- Never show a mean or an SD of a bimodal metric; show every repeat plus a range, and `fireRate` as the aggregate.
- Always print the baseline beside the replay — a replay number alone is meaningless.
- A harness fault must never be reportable as a model result. (`timeout` does not exist on macOS; a first sweep reported 8 model "failures" that were entirely that.)
