# Review pipeline — the first production run, and what it argues for

Companion to [`deterministic-pr-levers.md`](deterministic-pr-levers.md), which is the design doc and the measurement journal for the review evidence pipeline. That doc's evidence is entirely from the eval harness against gold. This one is about the pipeline's **first run on a real PR in production**, what that run establishes, and the four things it exposes. Everything here is n=1 and must be read against `review-pipeline-run-variance`: recall swung 0.320 → 0.080 across three byte-identical wp3 runs. A single run cannot justify a change; it can only tell you which arm to buy.

The run: `1e3b69b7-7e3f-41c8-8b32-0c840e581cfd` on the `drizby` deployment (v0.27.0, `sandbox.backend: docker`, `review.analysis.enabled: true`, `obligationContract: minimal`, `mint: all-in-diff,registrations`, surveys on `openai/gpt-5.4-mini`, `probes: false`), reviewing `cliftonc/drizzle-cube#937` — human-authored, 2627 additions / 14 deletions, 32 files, a dbt→Drizzle codegen feature.

## What it establishes

**The pipeline produces postable, verifiable, non-noisy findings on a real PR.** Nine findings, `event: REQUEST_CHANGES`, verdict failing on both axes; seven would have posted (five inline, two body), two tiered `internal`. All seven verified true against source at that head — exact line numbers, verbatim quoted code, no hallucinated paths. This is the first time the pipeline's output has been checked line-by-line against a repo nobody built gold for, and it survived.

**It beat the review it replaced, on the same head.** The prior two-phase APPROVE claimed a violation of `src/cli/CLAUDE.md`, a file that did not exist at that ref. `adjudicate` searched for it, failed, and withdrew the concern — the pipeline caught a hallucinated citation in its own predecessor. That is the anti-speculation and verbatim-anchoring machinery (WP6) doing exactly the job it was built for, on evidence the eval harness cannot produce because gold sets do not contain the bot's own past mistakes.

**Zero clean quotes reached the maintainer.** The two verification reports tiered `internal` at confidence 0.18 and 0.01. `tierFindings` (`apps/server/src/engine/github/review-poster.ts:711-755`) checks explicit-internal, then clean-discharge, then `internalFloor` (0.15) — before any per-family threshold. The 0.01 finding was below the floor; the 0.18 one never reached a threshold at all, because the earlier rules fired first. The attention boundary is working as designed at the one place its failure would be most visible.

**Two Criticals were executably reproduced** — the security branch ran the generator under `tsx` and demonstrated attacker-controlled dbt metadata splicing into emitted TypeScript identifier positions. Note what that means mechanically: `probes: false`, so `prepare` and `falsify` were both skipped, and this reproduction happened **inside a survey branch**. The design separates generator from checker deliberately (`falsify` "must not see the reasoning it checks") — here the generator ran its own oracle. That is simultaneously the strongest argument yet for E4 (reproduction converted the run's two best findings) and evidence that the separation is a property of the *phase graph*, not of what a branch is able to do.

One further first: this is the first pipeline run at `sandbox.backend: docker`, where `BACKEND_MAX_CONCURRENT` is 6 (`apps/server/src/workflows/handlers/fanout.ts:68-74`), so the survey fan-out actually ran wide. `deterministic-pr-levers.md` warns that eval wall-clock does not transfer to a gondolin deployment; on docker it does.

**The methodological caveat, stated once and loudly**: there is no gold for `drizzle-cube#937`. Seven-of-seven verified is a precision statement with **no recall denominator**. Nothing below may be read as a recall result.

## What the run exposes

### 1. Obligation allocation is inverted (sharpest)

`obligations.json` for a 32-file / 2627-line PR: contract **12**, enforcement **1**, security **0**, state **0**, tests **0**. Contract simultaneously hit its ceiling — `dropped[]` carrying `"over the per-family ceiling of 12 for contract"` (`packages/code-facts/src/seed.ts:809`) — *and* dropped real obligations, while three families seeded nothing at all.

The budget cannot move. `FAMILY_CAPS` (`packages/code-facts/src/seed.ts:346-352`) is contract 12 / enforcement 12 / state 8 / security 8 / tests 8, and `maxObligations: 48` is their sum by construction (`seed.ts:227-232`; `apps/server/config/default.yaml:388-391` documents it as a backstop that "cannot bind on a shipped configuration"). So 35 of 48 slots went unclaimed while the one family with demand was refused. That is not a bug — the ceilings were built on 2026-08-25 precisely to stop cross-family ranking, and they measurably fixed the mechanics (byte-identical 12/12/12 on heavy cases vs the floors era's 17/15/8). But the shape they produce on a large single-feature PR is a document that is starved and capped at the same time.

### 2. The best findings came from the family with no obligations

Security seeded zero, took the freeform charter, self-directed a probe, and produced both reproduced Criticals. Enforcement got its single obligation — about a usage string — and returned one Minor non-finding in 36 s. On this run the deterministic seeding steered effort *away* from the defects.

Do not over-read this. `deterministic-pr-levers.md` records the opposite result twice: LD3's IRIS ablation measured half-mechanism seeds as **actively harmful** (−3), and the `obligationContract: full` experiment took discharge compliance 0/33 → 33/33 while matched gold on the same cases went 4-of-5 to **zero**. The tension between reliable seeding and discovery is old, documented, and unresolved; this run is one more data point on it, from the discovery side, at n=1. It is not a refutation of seeding.

Two things do follow. First, the zero-mint path is *designed* to be productive — `renderFamilyBlock` writes "not a licence to skip the family … Work the diff for this family's question directly" plus the staged diff (`packages/code-facts/src/seed-render.ts:482-497`) — and it worked. Second, there is a **confound the run cannot separate**: security is also the only branch with a bespoke skill (below). Freeform-vs-seeded and third-skill-vs-not moved together.

### 3. Every family reads (nearly) the same generic skills

`apps/server/workflows/pr-review.yaml:293` declares `skills: [pr-review, code-review]` at the fan-out phase. Four of the five branches override only `prompt:` and `context_file:`. **The brief for this doc was wrong on one point: `security` already overrides, at line 395, with `[pr-review, code-review, security-review]`** — committed in `ce5929ab`, the pipeline's own merge.

So per-branch skills are not merely supported (`apps/server/src/workflows/CLAUDE.md:199-220`; `fanout.ts:812-813` resolves `branch.skills ?? phase.skills`, and `fanout.ts:771-774` keys the staging bundle on the branch label so `.lastlight-skills/<label>/` cannot collide) — they are already in use. The question is not whether to enable them but what should go in them.

Be honest about the answer. The family prompts already carry 99–143 lines of family-specific instruction each (`apps/server/workflows/prompts/survey-*.md`), and the brief carries the family's obligations. A per-family skill that restates its prompt is pure token cost. There are exactly three things a skill can carry that a prompt cannot, and only two of them apply today:

- **Subtraction.** `code-review`'s "What to check" (`apps/server/skills/code-review/SKILL.md:114-155`) is a ten-axis checklist — correctness, contracts, edge cases, security, complexity, duplication, type safety, regression risk, test coverage, fit. Every survey branch reads all ten. LD9 says specialists are separated by *question*; this hands each specialist the whole question set. That is the one clear win, and it is a subtraction, not an addition.
- **Progressive disclosure via `references/`.** The pattern exists (`skills/pr-review/references/findings-schema.md`, `skills/security-review/references/issue-format.md`): material too long to inline, loaded on demand. A per-family question catalogue is exactly this shape — and question catalogues are the intervention that bought G1.
- **Nothing else.** For `contract`, `enforcement` and `state`, the prompt already says what a skill would say. Writing them a skill today buys tokens and no signal.

The one bespoke skill that does exist is the wrong one. `security-review`'s frontmatter describes a *cron scan* — "Files one dated summary issue with a task-list of findings … Use on a security cron" (`apps/server/skills/security-review/SKILL.md:1-6`), and its body's contract is "File **one summary issue per run**". None of that is what a survey branch does. The branch that produced this run's two best findings is reading a skill written for a different workflow, and we cannot tell whether it helped, hurt, or was ignored.

One caveat that is not stylistic. `pr-review.yaml:285-289` and `fanout.ts:463-468` both pin the invariant that the shared prompt head — skills, AGENTS.md, diff summary — stays **byte-identical across branches** so six passes share one provider-side cached prefix. Per-family skills break that by construction. It is a cost claim, not a correctness one, and `security` already voids it today, so the honest move is to measure the cache-read delta rather than treat it as blocking.

### 4. Severity inflation

All three Criticals were `Important` in the surveys; `adjudicate` promoted them. For a local CLI parsing the user's own dbt artifacts, "a malicious manifest injects code" is codegen robustness, not a security boundary — the supplier of the input already has the capability the finding grants.

The mechanism is in the rubric: `code-review` defines "**Critical** — security issues, data loss, breaking changes" (`SKILL.md:100-101`). Membership in the security *category* is sufficient. There is no trust-boundary predicate anywhere in the definition, so any input-shaped hazard is Critical by construction. Severity is not decorative the way confidence is — it feeds `rankOf` and therefore inline ordering under `maxInlineComments`, so miscalibration spends the maintainer's top slots.

## Deliberate exclusions, so nobody "fixes" them

**The `tests` family has no survey branch on purpose.** The reason is recorded at `apps/server/workflows/pr-review.yaml:406-416`: the family is dead at both ends — no seeder function exists in `code-facts`, and the `coverage` extractor it would read needs a report only `prepare` can produce. Measured: 0 artifacts across 50 corpus cases and all 8 gate cases, in every run ever taken. Running it paid a sixth of the fan-out to write NOT MEASURED. Reinstating it is a seeder plus that entry, and it should ride E4 or not happen. (The in-repo reason is this, not sandbox memory — worth knowing which argument is the load-bearing one if it is ever revisited.)

Two harmless leftovers, confirmed: `obligations/tests.md` **is** still written on every run — `cli.ts:493` loops `SEEDABLE_FAMILIES`, which includes `tests` (`seed.ts:75`), and `renderFamilyBlock` returns a non-empty NOT MEASURED block (`seed-render.ts:472-480`), so the `if (block)` guard never suppresses it. And `apps/server/workflows/prompts/survey-tests.md` (99 lines) is referenced by nothing under `workflows/` or `src/`. Neither is read by any branch. Leave them; the `measured: false` row is what keeps the instrument reporting `notMeasured` rather than "did not convert".

## Proposals

**R1 — split `code-review` into a shared core plus per-axis fragments, and give each survey branch core + its own axis.** The core keeps what is genuinely shared: finding tiers, "Not findings", Calibration, and the multi-pass gate carve-out (`SKILL.md:49-72`, which already correctly tells a survey pass that the precision gate does not fire on it). The fragments are the ten "What to check" axes, redistributed to the families that own them. This is subtraction — it removes eight axes from each branch's context, not adds anything — so it is cheap, reversible, and it is what LD9 actually asks for. Risk: prefix-cache fragmentation (above), and the possibility that cross-axis reading is *why* branches find things outside their family, which would show up as an internal-union loss.

**R2 — rewrite `security`'s branch skill for the job it is doing.** It is the only branch already paying the cache cost of an override, and it is paying it for a cron-scan skill. Replace it with a PR-diff-scoped security fragment (untrusted-input inventory, trust boundaries, the "who already has this capability" test from R4). Zero net token cost, and it removes the confound in Problem 2.

**R3 — do not add a skill to `contract`, `enforcement`, `state` or `spec` yet.** Their prompts already carry the family question. Revisit only when there is a question catalogue too long to inline — that is what `references/` is for, and catalogues are the one prompt intervention with a recorded new-gold win (G1).

**R4 — put a trust-boundary predicate in the Critical definition.** "Security issue" alone should not reach Critical; the finding must name a boundary the input crosses and a capability the supplier does not already have. Drafting is $0, but it changes what gets posted and what ranks first, so it ships behind an arm.

**R5 — a smarter family ceiling. Three mechanisms; only one survives its own risk.**

- *Reallocation* — sweep each family's unclaimed slots (`cap − minted`) into a pool and redistribute by rank to families at their ceiling. **Reject as stated.** It reinstates exactly the cross-family ranking of incommensurable mechanism classes that the ceilings were built to kill, and on this run it would have handed the surplus to `contract` — the family that produced nothing — while the three zero-mint families would have contributed their budget and received nothing back. It optimises in the wrong direction.
- *Shape-sizing* — make each cap a function of the diff (contract's from `consumersOutsideDiff` breadth, security's from scanner hits and new-file count) rather than a constant. Risk: the cap becomes a function of the same signal that already ranks *within* the family, so it double-counts it; and it is unfalsifiable without a per-family conversion rate we have never measured.
- *Global pool with per-family floors* — the pre-2026-08-25 shape. Already tried, already superseded: floors let the same family swing 17/15/8 on near-identical envelopes because its share depended on where other families' ranks fell.

  **What survives is smaller and closer to the evidence: keep the caps, and first make ceiling pressure visible.** The seeder already writes per-family `dropped[]` reasons (`seed.ts:800-820`), so "family at ceiling while N families minted zero" is computable **for free** over stored envelopes — the same $0 replay that validated the floors. Ship the instrument before the mechanism. If pressure turns out to be rare, this whole problem is a one-PR artifact; if it is common, the measurement tells you which direction to size in, which no amount of reasoning from n=1 will.

**R6 — treat the survey-branch probe as the E4 argument.** The run's two strongest findings came from executing code, in a phase not designed to execute anything, with the oracle disabled. E4 (turning `prepare` on) is already on the lever board; this is the first production evidence that reproduction converts. It also raises a design question worth answering before E4: if survey branches can and do run code, is the generator/checker separation still real, or only nominal?

## What must be measured, and how

Nothing above ships on this run. n=1, no gold, no recall denominator, and `review-pipeline-run-variance` puts the repeat band above most effects worth arguing about.

**Free first ($0, no sign-off):**

1. Replay the seeder over stored envelopes across the 8-case gate set and the Martian tier; report per-family mint, cap-binding and `dropped[]` reasons. Answers "is Problem 1 general or is `937` an outlier?" with no model calls. Same technique that validated the floors.
2. Mine this run's own transcripts: what did the `security` branch read from `security-review`, and did anything it wrote trace to that skill? Answers whether R2 is a fix or a no-op.
3. Sweep stored `disposition.json` for severity distribution and for how often a Critical occupied an inline slot ahead of a lower-severity finding. Bounds R4's blast radius before spending on it.

**Then arms, internal-recall-first per LD1** (posted recall is downstream of discovery; read the discovery number before the posted one, every time):

| Arm | Question | Read |
|---|---|---|
| R1 skill split | Does removing eight off-family axes cost discovery? | internal union first; then survey branch-seconds and cache-read tokens |
| R2 security fragment | Does a PR-scoped security skill beat a cron-scan skill on the branch? | security-family internal recall on `1667` (2 of 5 gold are security-family) |
| R4 severity predicate | Does a trust-boundary gate cost gold? | matched-gold severity distribution and inline occupancy; precision is the win, recall is the guardrail |

Standard discipline from `deterministic-pr-levers.md` applies without exception: 8 cases × 2 repeats minimum, `--keep-workspace`, verify the arm rather than reading its label (`disposition.json` present with the arm's pinned budgets), one variable per arm or say in the write-up that it is a bundle, and paired per-gold comparison (`pairedBand`) over mean deltas. Every arm is human-authorised spend.

The one thing this run argues for that needs no arm at all: **do this again**. Line-by-line verification of a production review against a repo with no gold is the only instrument that has ever caught a hallucinated citation, and it cost nothing but attention.
