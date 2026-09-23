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
| **`spec` is unsupported** | its obligations are built harness-side, not seeded to `obligations/spec.md`. An empty block would read as a clean family rather than an unrunnable one. |
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

## Levers to test, ranked

1. **Severity stability.** Now ahead of the discharge rule: severity decides whether a finding is *posted at all*, it swings by ±20 points across identical arms, and it collapsed on the precision canary. Questions: is the trust-boundary bar in `survey-pass/SKILL.md` doing any work? Should severity be **derived** (from probe verdict + category + mechanism completeness) rather than model-assigned? Would a two-value scale be more stable than three? Per-severity counts and a spread line are now emitted per repeat.
2. **Why the discharge rule is inert.** It is read and ignored. Before rewriting it again, find out whether the model treats it as inapplicable (most rows are genuinely not in a changed hunk?) or simply overrides it. The micro-eval dumps every claim, so this is readable rather than inferable.
3. **Model choice.** A screen across 8 models (3 Anthropic + 5 current Fireworks — `glm-5p3`, `kimi-k3`, `deepseek-v4p1-flash`, `qwen3p8-max`, `minimax-m3`) is the first real use. Screen at 3 repeats to separate *works* from *broken*, then 8–10 on survivors. Note `evals/models.json` is stale — it still lists `glm-5p2` / `deepseek-v4-pro` / `gpt-oss-120b`.
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
