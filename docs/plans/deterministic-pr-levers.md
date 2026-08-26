# Deterministic PR levers

This is the successor to `docs/plans/review-evidence-pipeline/` (18 files, ~8,900 lines), which was removed on this branch after the pipeline shipped: the WP-by-WP history had become noise around a built system. This doc keeps everything still load-bearing — the design, the decisions, the evidence with run ids, the operational traps, and the live lever plan. For the full forensics (`RESTART.md` §2b–§2m measurement journal, `PIPELINE-SPEC.md`, the WP docs), read the removed folder out of git history: `git log --oneline -- 'docs/plans/review-evidence-pipeline/'` and `git show <sha>:docs/plans/review-evidence-pipeline/RESTART.md`.

The problem this pipeline exists to solve, in one number: the shipped two-phase reviewer posted **1 finding across 8 real PRs carrying 25 human-confirmed defects** (micro-recall 0.040, blind split 0.000), and production showed 58 of 59 approvals with zero inline findings. Three theories were falsified by measurement — verification (v2 halved F1), prompts (three rounds, checklists acknowledged then skipped), bigger models (Haiku 4.5 beats Sonnet 4.6 on review recall, 41.2% vs 22.1%). The thesis that survived: **discovery is the ceiling — the model's question set does not contain the human's questions** — so a deterministic layer now mints the questions.

## The shipped pipeline

Nine phases in `apps/server/workflows/pr-review.yaml`, all with explicit `depends_on` (chain synthesis disabled; every edge deliberate):

```
prepare → facts → seed → survey (fanout ×5) → falsify → review ─┬→ adjudicate → reconcile
                                                                └→ post-review
```

| Phase | Kind | What it does |
|---|---|---|
| `prepare` | bash (gated on `probesEnabled`) | Installs deps so probes and tier-1 type resolution are possible. Lifecycle scripts off by default. |
| `facts` | bash | `lastlight-facts all` — deterministic facts at the **merge base** (never the base tip): impact cone, contract delta, constants (references minus literals), dep delta, scanner patterns, changed-line coverage. Also stages the diff once under `.lastlight/pr-review/diff/` (lever f1). |
| `seed` | bash | Mints **obligations** — two-ended questions (decision LD3) — ranks them under `maxObligations` with per-family floors, seals the coverage set before any model call, renders one brief per family from code. |
| `survey` | `type: fanout`, 5 branches | A cheap model deliberately over-produces hypotheses, one obligation family per branch, fresh context, append-only `hypotheses/<family>.jsonl`. Briefs attach via `context_file` (never a path the model must resolve). Branch gate: `lastlight-facts discharge`. |
| `falsify` | agent loop (gated on `probesEnabled`) | The executable oracle — the only phase that runs anything; writes `probes/verdicts.jsonl`. Structurally inert until `prepare` is enabled (E4). |
| `review` | agent (both modes) | Two-mode `prompts/review.md`: pipeline-off = the classic skill pass; pipeline-on = one fast independent PR-level pass, forbidden from reading `hypotheses/` (lever f4, built 2026-08-24). |
| `adjudicate` | agent loop, `fresh_context` | Ranks and tiers survivors. May demote; may **not** delete without a probe transcript on disk. Sibling of `post-review`, never upstream of it. |
| `reconcile` | bash, `all_done` | Model-free conservation floor: `lastlight-facts findings --repair` — every hypothesis gets exactly one disposition; silence is not a disposition. |
| `post-review` | handler | The attention boundary: anchor cascade, then the 8-step tiering in `tierFindings()` (`review-poster.ts`) into inline / body / internal; writes `disposition.json`. |

Everything is off by default (`review.analysis.enabled: false`, LD8); the gate key is *absent*, not false, on a non-opted-in deployment, and `evalSkipIf` coerces absent → false, so any typo fails towards "the analysis does not run". Every deterministic phase exits 0 on every path (a hard failure would strand the PR in a 30-minute re-dispatch loop); `facts`/`prepare` carry shell-level `||` fallbacks writing a schema-valid `coverage: "none"` envelope because `--never-fail` cannot survive OOM/segfault.

## Decisions

Two numbering systems survive from the plan era and are still cited from code comments: **LD1–LD14** (the locked decisions) and **D1–D13** (the pre-implementation design review, which wins over any WP it contradicts).

| # | Decision (one line) |
|---|---|
| LD1 | **The deterministic layer generates hypotheses; it does not filter them.** Every measured ranking intervention bought precision with recall (v2 F1 halved; BitsAI-CR precision 54.5→67.1 for recall 45.5→39.8). |
| LD2 | **Over-generate; SNR is the guardrail, not precision** (frontier precision on this task is 3–5%). |
| LD3 | **An obligation names both ends of the mechanism or it is not emitted** (IRIS ablation: half-mechanism seeds are actively harmful, −3). |
| LD4 | Facts are recomputed per run, not indexed. |
| LD5 | The toolchain is pinned in the image / CLI bundle and never resolves `typescript` from the repo under review. |
| LD6 | **Every tool fails loud; an empty result is an error, never a pass** (`null` ≠ `[]` — an unmeasured field is `null` plus a `degraded[]` entry). |
| LD7 | CodeQL never in the product path (licence); the scanner slot is Opengrep, not Semgrep. |
| LD8 | The whole pipeline is off by default; `false` reproduces the two-phase review. |
| LD9 | Specialists are separated by *question* (obligation family), not by tool access. |
| LD10 | Parallelism shipped as `type: fanout` (one DAG node, N sessions); the scheduler was never touched. |
| LD11 | Never re-derive what CI said; `prepare` (cheap affordance) is split from running suites (expensive). |
| LD12 | **Internal recall and user attention are separate budgets** — three tiers (inline / body / internal), nothing deleted for being noisy. |
| LD13 | Eight cases from one private repo cannot support a general claim; external validation is mandatory and reported unpooled. |
| LD14 | TypeScript-first: TS/JS evidence coverage 46.2% vs non-TS 2.7%; grammars are a generality (WP9) dependency, not a shipping blocker. |

Design-review decisions still cited by number: **D1** — `code-facts` ships inside the `lastlight` CLI, not only in the sandbox image, because the eval harness runs `--sandbox none` on the host and an image-only toolchain would be unmeasurable (this is why `lastlight-code-facts` is a published package). **D5** — WP5 (scheduler-level parallel phases) is parked until measured latency justifies it; see [Parked: parallel phases (WP5)](#parked-parallel-phases-wp5). **D7** — the `spec` obligation axis (acceptance criteria mined from the PR description/linked issues, built harness-side in `review-spec.ts`, riding `{{specObligations}}`) was pulled forward as WP0; it is the sixth family, the only one not seeded by `code-facts`. **D12** — fail loud means loud *in the artifact*, never fatal to the run.

## Evidence base

All run artifacts live in the separate eval workspace `~/work/nearform-evals` (`eval-results/` per tier; preserved workspaces under `$TMPDIR/ll-eval-*`; copied-out keepers in `~/lastlight-run-artifacts/`; transcripts under `<run>/sessions/`). The gold set: 8 `nearform/skillspro` cases / 25 gold findings, checksum by case 3,5,0,4,3,5,4,1 (`1641` is a zero-gold precision canary; blind split = `1667`, `1680-r1`, `1680-r2`). Every eval arm is human-authorised spend.

**Keeper runs whose identity exists only here** (their scorecards carry no overlay metadata): `2026-08-22_183835-00cc469` = the **baseline** (0/25 matched, 1 posted, $2.28); `2026-08-22_184650-00cc469`, `194234-00cc469`, `201607-64862d5` = wp3 runs 1–3 (recall **0.320 / 0.080 / 0.200** — same code, fixtures, model, command).

What the campaign established, condensed:

- **Variance is the first-order phenomenon.** Union across the three wp3 runs 0.440, intersection **0.040** — one gold in 25 found reliably; the measured band equalled the detection floor (0.24). The seed is byte-identical across runs; the variance lives in the surveys (hypothesis volume swings up to 2.4×) and, unattributed for a long time, in the **attention boundary** (posted 30/8/7 from near-identical generation). Single-case n=3 arms carry bands of 0.2–0.6 — wider than any effect they were used to decide. Never read one arm as a result.
- **Internal vs posted recall separate discovery from saying.** Runs that posted 0.320 and 0.200 had *identical* internal recall (0.480) — the recall band is downstream of discovery. Current shape: internal union 21/25 vs posted union 17/25. **The found→said gap is now bigger than the discovery gap.**
- **The adjudicator is not the thief.** After the internal judge was fixed to match on claim direction (it had been crediting verification reports against gold asserting the opposite), exactly one credited match sat on the internal tier. The clean-discharge demotion is built and is a verified no-op under `obligationContract: minimal` (0 clean discharges), unmeasured under `full` (where 17 verification reports posted at confidence 1.00). Confidence is decorative — median 0.95–1.00, no threshold binds.
- **Prompt revisions bought reliability, catalogues bought new gold.** The adjudicator prompt revision took a 1-case band from 0.600 to 0.000 at flat recall; the question catalogues found G1 (never before found). The 8-case confirm vs the keepers: mean recall 0.260→0.320 (INDISTINGUISHABLE by band), but precision +30–60% and SNR +37–71%; the posted union *rotated* (+8/−10, p=0.76), it did not grow. The blind split is **contaminated** for the catalogue claims (questions were derived from never-matched gold including blind cases').
- **The two significant results on record:** D2 (`mint: all-in-diff,registrations`) paired internal **+10/−1, p=0.006** (internal union 21/25, posted 17/25, mean posted recall 0.400); Martian cal.com external tier paired posted **+7/−0, p=0.008** (recall 0.484→0.581 on gold the prompts never saw) — at 3× cost, and with **F1 below the baseline** (ranks 17–20 of 23 vs 12) because the boundary is untuned.
- **f4 (review reshape) validated 2026-08-24**: review phase −50% cost / −25% latency, recall band 0.000, G5 found internally 3/3 (never before) — but case total went **up** 8% because the surveys grew (+21% cost, +45% branch-seconds). **Surveys are ~75% of case spend and ~90% of branch-seconds.** Caveat: the arm ran at `maxBodyComments: 0` because the overlay's funnel pin was inert (trap 13).
- **AACR external floor for adjudication:** keep-all scores F1 0.825 over 2,145 labelled comments; neither Haiku (0.803) nor GLM-5.2-fast (0.745) beats it — Haiku destroys 131 valid comments to intercept 98. No adjudicator has ever beaten keeping everything (LD1, again).
- **`maxBodyComments` shipped at 0, then moved to 5 on 2026-08-25** ($0 sweep over stored dispositions: cap 0 bought Martian precision 0.263→0.492 / F1 0.362→0.479 under a Sonnet adjudicator, but under Haiku-everywhere the body tier carries most matched gold — posted recall 0.42→0.12 — while mid caps kept most of it: skillspro cap 4 = 0.300, cap 8 = 0.380; Martian cap 8 = 0.581 at better precision than unlimited. 5 is the recall-preserving compromise pending real boundary tuning; `maxInlineComments` went 8→10 at the same time, near-inert since measured inline volume is 1–5/PR and overflow goes to body. **Eval overlays still pin `maxBodyComments: null` explicitly** to measure the full funnel).

### The gpt-5.4-mini result (2026-08-24, previously unrecorded)

Runs `2026-08-24_150406/150407-878bc1b`: the D2 arm (`wp3-minimal-d2ab`), all 8 cases, `--model openai/gpt-5.4-mini`, n=2 — never written up in the plan era:

| 25 gold | gpt-5.4-mini r1 / r2 | Haiku D2 `114322` / `114323` |
|---|---|---|
| posted recall | **0.400 / 0.400 (band 0.000)** | 0.360 / 0.440 |
| precision | **0.769 / 0.455** | 0.161 / 0.183 |
| F1 | **0.526 / 0.426** | 0.222 / 0.259 |
| posted volume | 13 / 22 | 56 / 60 |
| cost | $13.13 / $15.55 | $16.90 / $16.91 |

It matches Haiku's recall at a quarter of the volume and roughly double the F1, **by generating less (~35% fewer hypotheses), not by filtering** — the one shape LD1 does not forbid. Its internal union equals its posted union (13 = 13: found ≈ said), where Haiku finds 21 and says 17 — so **the found→said gap is model-shaped**, not just prompt-shaped, and the untried lever is a mixed arm (Haiku surveys for over-production, gpt-5.4-mini for the saying phases). Caveats: n=2, the same blind-split contamination as every catalogue-era arm, and OpenAI token accounting differs (cache reporting), so the $ comparison is provider-conditional.

## Code-facts (WP1) and hardening (WP1b)

`packages/code-facts` — leaf package, published (D1), `CLAUDE.md` there is the reference. Extractors: `facts` (symbols ↔ hunks, `referencesInDiff` vs `referenceCount` — the most productive field), `contracts` (signature/nullability/`@throws` delta base-vs-head, `consumersOutsideDiff`), `constants` (**references minus literals** — the subtraction is the insight, and the only fact shape that has ever converted a gold finding), `deps`, `patterns` (opengrep + gitleaks scoped to the diff), `coverage` (reads a report, never runs a suite), plus `prepare` / `discharge` / `probes` / `findings` / `seed` / `toolchain`. Language tiers: 1 = TS/JS with a resolvable project, 2 = project load failed, 3 = other; tiers 2–3 emit `coverage: "degraded"` with populated `degraded[]`.

The seven WP1b hardening bugs, kept because other docs cite them by number — six were "a wrong or absent answer that looked like a clean result": **1** `canonicalType` counted the `>` of `=>` as a closing bracket; **2** `stripImportPaths` matched only the qualified form; **3** the diff range was two-dot, not the merge base; **4** monorepo tsconfig blindness (`--max-files` interaction); **5** `@throws {ValidationError} when …` recorded `"when"`; **6** `rules/review.yaml` had never been valid YAML (no machine running the suite had opengrep — LD6's origin story reproduced); **7** ast-grep refuses a whole rule naming a node kind its grammar lacks. The memory finding: peak RSS is dominated by `node_modules` binding (ts.Program bound 9,647 files, 8,947 under `node_modules`), not `--max-files`; `--resolution changed` fits the cap at zero type-fidelity cost across 499 contract entries; the sandbox cap was raised to 8g. `src/selfcheck.ts` is the independent oracle; `tests/fail-loud.test.ts` / `tests/oom.test.ts` / `tests/compiler-isolation.test.ts` pin the loudness table and the compiler isolation (only `src/tsgo.ts` may import `typescript/unstable/*`, pinned exactly at 7.0.2).

## Seed and survey (WP3)

`seed` mints obligations from the facts envelope (five families: `contract`, `enforcement`, `security`, `state`, `tests`) plus the harness-built `spec` axis. **The four mint rules are four different conditions**, not one: `state` mints on out-of-diff references to changed symbols, `contract` on `consumersOutsideDiff.length > 0 && change !== "added"`, `enforcement` on candidate count, `security` on a scanner hit in the same file. Additional mints behind `review.analysis.mint`: `all-in-diff`, `registrations` (both shipped — the D2 arms). Ranking under the `maxObligations` budget (40) is mechanism-class-first with truncation counted in `dropped[]`, never silent, **with per-family floors so a high-volume family cannot starve a low-volume one** (measured: `contract` minted 89 across 8 cases while `security` minted 3, and 35 obligations dropped unchecked). The coverage set is sealed before any model call — a run cannot grow its own denominator.

Briefs are rendered from code (`src/seed-render.ts`), never a prompt template (a 17-row ledger was once honestly discharged into zero findings), and reach branches via the fan-out's `context_file` key: measured, 27 of 133 first-turn obligation reads against a prompt-supplied path resolved against the wrong root and hit ENOENT, and 23 branches never recovered — so the harness reads and appends, and an unreadable file appends a loud NOT AVAILABLE notice. Relative paths inside briefs are safe (98/98 succeeded); workspace-root-absolute paths are not (0/27). Each brief carries its own discharge contract (`obligationContract: minimal` shipped; `full` produced 23–25 clean-discharge quotes per case — half to two-thirds of survey output was "I looked, it's fine"). The `tests` branch is deliberately absent from the fan-out (no seeder exists, no coverage artifact is ever produced); the seeder still emits its `measured: false` row so the instrument reports `notMeasured`, never "did not convert". Acceptance criteria for the phase are pinned by `apps/server/tests/workflows/pr-review-survey.test.ts` and `golden-pr-review.test.ts`.

## Probes (WP4)

`prepare` installs dependencies (the probe affordance and a precondition for tier-1 `contract` facts); `falsify` executes probes against hypotheses and writes `probes/verdicts.jsonl` (`reproduced`/`refuted`/`unprobed`), separated from the surveys because a checker must not see the reasoning it checks. The adjudicator's delete power requires a probe transcript on disk. **Both are structurally inert today**: `prepare` was skipped 8/8 in every measured run (`probes` config off), so `falsify` has never run under a model — turning them on is lever E4. `coverage` only ever runs a script the repo itself named. `prepare` has a disk guard (D9). Phase contract pinned by `tests/workflows/pr-review-probes.test.ts`.

## Parked: parallel phases (WP5)

Scheduler-level DAG concurrency stays parked (D5): the survey fan-out shipped instead as `type: fanout` — one DAG node, one `withSandbox`, N sessions, one dispose, one `executions` row per branch — so none of WP5's blockers (B1 "one workspace per run" — two agents in one checkout share one `.git/index` — plus the provisioning-cost blockers D1–D3) had to be solved; they are inapplicable by construction to a fanout that shares a single workspace. What WP5 would still buy is per-family DAG *nodes*. Note for any latency claim: `surveyConcurrency` is a **ceiling clamped per backend** (`BACKEND_MAX_CONCURRENT` in `fanout.ts`: `none`/`docker` 6, `gondolin`/`smol`/`kubernetes` 1) — on a stock gondolin deployment the branches run serially, so eval wall-clock numbers do not transfer to production until that clamp lifts (or gondolin is removed, which is slated).

## Adjudication and the attention boundary (WP6)

`adjudicate` runs fresh-context, reads the ledger first (`lastlight-facts findings --ledger`, deliberately uncapped), and obeys: a verification report is always `internal`; a speculative hazard is always `internal` (the anti-speculation rules closed the `1641` canary's "nothing prevents a future developer from…" false-positive genre at both ends); confidence prices the defect, not the model's certainty; anchoring is by verbatim excerpt; demote freely, delete never without a probe transcript. The conservation gate (`until_bash: lastlight-facts findings`) requires every hypothesis id to appear with exactly one disposition, checked against colliding ids (an early gate passed falsely at 5/5 while the honest count was 2/30). `reconcile` (`all_done`) repairs: uncovered hypotheses → `internal`; `dropped` without a transcript → promoted back to `internal`. `models.review-adjudicate` falls through to `models.review` via an explicit `{{#if}}` pair (a bare unset reference would render empty and fall to the *default* model). Phase contract pinned by `tests/workflows/pr-review-adjudicate.test.ts`.

`post-review` builds the `AttentionBoundary` (`post-review.ts`) and tiers via `tierFindings()` (`review-poster.ts`): explicit internal → clean-discharge → `internalFloor` (0.15, the one tier that costs recall, deliberately low) → anchorability (off-diff → body) → explicit body → per-family thresholds (documented **initial guesses, untuned**: contract .35, enforcement .35, security .30, state .50, tests .60, spec .45) → `maxInlineComments` (10; overflow → body, never costs recall) → `maxBodyComments` (5; the one budget that filters — demotions recorded as `body-budget`) applied last over the final body list. It writes `disposition.json` — **whose absence means the boundary never ran** (a mandatory arm-verification check). The boundary reads its four budgets off the run context first (`specContext` projects them; presence-tested atomically), falling back to runtime config — because the eval harness populates the context, not the process-global config, and the same shape bit twice (`analysisEnabled` first, then the four budgets: "a precision number describing a deployment that does not exist").

## Review memory (WP7)

Not started. D10 splits it in three, with disposition recording already live (`recordDisposition` in `post-review.ts` → `review_findings`), so a future memory has data from day one.

## The instrument (WP8)

Lives in `apps/evals` (`review-metrics.ts`, `review-pipeline-stats.ts`, `grade.ts`). Three numbers, three denominators, never quoted alone: **anchor rate** (can the gold be attached to the diff at all), **discovery ceiling** (is the mechanism visible in the facts), **EC-strict** (did an obligation actually cover it). Micro-recall over the pooled gold is the headline; SNR (matched / posted) is the guardrail (LD2); the **detection floor** bounds what any single arm can resolve. Posted matching uses an EXTRACT→MATCH judge; internal matching uses `INTERNAL_MATCH_SYSTEM`, which requires **claim-direction agreement** (its predecessor matched on topic and credited verification reports against gold asserting the opposite). `readPipelineStats` reads the run's own artifacts deterministically ($0, back-fillable onto preserved workspaces); `boundaryMetrics`/`familyFunnels` key off `review.pipeline` in the scorecard. `bandVerdict` compares a mean delta to a repeat band and is ~3× more conservative than the **paired per-gold** comparison (`pairedBand`), which is the preferred read. Tools: `scripts/diff-runs.ts` (split-aware, emits REVERT — OVERFIT), `band.ts`, `rescore.ts`, `mine-failures.ts`, `audit-internal-pairs.ts`, `backfill-pipeline.ts`. The arm's `review:` policy is part of the **arm** (like `models`), threaded through core's own `renderContext` — never a dataset edit.

## External validation (WP9)

Three tiers. **Tier 1 ran** (Martian TypeScript slice, 10 cal.com cases / 31 gold, pinned to upstream `949e4a1` — a fresh import silently desyncs the committed sidecar): pipeline +7/−0 paired posted p=0.008, recall 0.581 both repeats, F1 below baseline (boundary untuned), suspect contamination before crediting the baseline's 0.484. **Tier 2** (fresh private cases via `add-case`, human-signed-off, held blind) does not exist yet — until it does, catalogue-derived recall gains are fits, not generalisation. **Tier 3** is an AACR-Bench arm. **WP1c** (module-level-only tree-sitter grammars for non-TS) is the generality lever: measured prescription takes non-TS EC-strict from 2/73 to 23/73 at *higher* density, where "any identifier" reaches 60/73 at 17× worse density.

## Money traps

Every one of these silently produced a green, gradable, wrong measurement at least once:

1. The `pr-review` skill's `--depth 50` re-shallows its own checkout mid-run (9 of 50 corpus PRs fork further back).
2. Pre-2026-08-22 conservation results are void (the gate passed falsely on colliding ids).
3. A globally-installed `lastlight-evals` silently runs the **baseline** — the tell is one agent call and ~$0.21/case. Verify `core → 0.27.0-dev (working tree)` in the run banner.
4. The `spec` family ran nowhere for its first weeks (`maxSpecObligations` was 6 and silently bound; now 40).
5. An arm whose boundary never ran reports precision *and* recall for a deployment that does not exist — check `disposition.json` exists, and that it records the arm's pinned budgets.
6. A measurement must never overlap a rebuild — **contention counts** (a `none`-backend run recorded 1933 s beside a full test gate), and `workflows/*.yaml`, prompts, and `skills/**` are read **live**: "no build" does not freeze a measurement.
7. `--never-fail` does not survive a hard crash (exit 134, no envelope, 30-minute re-dispatch forever) — hence the shell-level `||` envelope fallbacks.
8. The gold dataset is uncommitted in the eval workspace; a `git checkout` once destroyed 5 of 8 cases. Checksum after any dataset operation: 3,5,0,4,3,5,4,1 = 25.
9. Fixtures that seed the bot's own prior review suppress the review being measured (an arm graded 0 posted across 7 cases).
10. Fixtures that tell the agent the PR is closed gate the gold silently (4 of 8 cases once did, gating 13 of 25 gold).
11. The harness logs UTC; your shell prints BST.
12. `--mode config` runs stamp fanout branch rows with the arm's default model — read config-run models off the session envelopes, not the scorecard.
13. An eval overlay's `review:` pins only reach `post-review` via the run context (`specContext`) — a knob read from `getRuntimeConfig()` alone is invisible to every eval arm (this bit twice: `analysisEnabled`, then the four boundary budgets).

Running an arm (condensed): build `lastlight-code-facts` and `lastlight-core` first; cwd `~/work/nearform-evals`; run `apps/evals/src/run.ts` via the monorepo's tsx with `LASTLIGHT_FACTS_BIN` set; `--repeats N` implies `--keep-workspace`. Verify the arm, don't read its label: within the first minute the workspace must hold `facts.json`, a populated `obligations.json`, per-family briefs, and the staged `diff/`; by the end, `disposition.json` with the arm's pinned boundary. Every arm is human-authorised spend.

## Backlog

Open items carried forward: an eval fixture with real base divergence (the gate is structurally blind to diff-range corruption); pin the `--ledger` mechanism in a test; dashboard `processMessages` pairs tool calls by array order; the evals dashboard has no test infrastructure; "Where the time went" sums concurrent branch durations (~3× overstatement); `rescore.ts` cannot recover `durationMs`; `add-case` doesn't capture linked issues; a finding may invent an obligation family outside the six-family partition; fingerprint collisions silently drop findings; `patterns` scopes to changed files, not hunks; `facts`/`contracts` read head off the filesystem while the changed set comes from git (a dirty tree silently invalidates the comparison); `surveyPasses` is dead config (the workflow's branch list is the authority). Backlog #24 ("`review.analysis.maxObligations` is dead on the workflow path") turned out to be **stale when checked in this pass**: both halves of the wiring landed in `e83059e3` (`specContext` projects it as a string; the seed phase reads it into a shell variable with a `:-40` default so an absent key can't swallow the next flag) — what was missing was any test pinning either half, now added (`pr-decisions.test.ts`, `pr-review-survey.test.ts`).

## The levers

Status of the four approved quality levers: **f1** (stage the diff once — ~30 of 93 survey bash calls re-derived a fixed range `facts.json` already held) — **built in this pass**; **f2** (thinking effort — the survey phases declare no `variant:`) — unbuilt; **f3** (`models.review-adjudicate`) — built; **f4** (two-mode review brief) — built and validated.

The remaining inventory, ordered roughly by expected value per dollar:

| Lever | State | What the data says |
|---|---|---|
| Boundary tuning (per-family thresholds, `maxBodyComments`, budgets) | Untuned guesses; overlay-tunable only since the context fix | The F1 lever on Martian (pipeline wins recall, loses F1). $0-sweepable over stored `disposition.json` first. LD1 guardrail: read internal recall first, every time |
| Model shape for the saying phases | Only Haiku-everywhere and Sonnet-via-fallthrough measured | gpt-5.4-mini's found ≈ said vs Haiku's 21-found/17-said: the gap is model-shaped. The mixed arm (Haiku surveys + gpt say-side) is untried |
| f2 thinking effort on surveys | Unbuilt | Cheap to wire; needs its own arm |
| E4: turn `prepare` on | Skipped 8/8 in every run | Un-inerts `falsify` (the adjudicator's delete power) and the coverage artifact in one move |
| `tests` family | Dead at both ends (no seeder, no coverage artifact) | Build the seeder with E4, or keep the branch dropped |
| Per-family obligation floors | **Built in this pass** | `security` minted 3 across 8 cases while `contract`'s 89 ate the budget; two of `1667`'s five gold are security-family |
| Per-family obligation *ceilings* (replace the pooled budget) | **Built + validated 2026-08-25** (superseded the floors the same day) | The pooled cap is shaped wrong twice over: cost is per-branch (each family's brief feeds one survey branch, and `survey_branch_contract` at 25 KB **is** the survey span — the parallel fan-out's wall clock is the max branch), and cross-family ranking prices incommensurable mechanism classes against each other, entrenching a self-fulfilling prophecy (families that never got slots never convert, so they never rank). The `spec` axis already has its own separate cap (`maxSpecObligations`), proving the pattern. Something like contract 12 / enforcement 12 / state 8 / security 8 / tests 8 would replace both the pool and the floors with one cleaner mechanism. Decide after reading this pass's arm: if floors fix minting but the contract branch still dominates span/cost, that is the data case |
| Question-shape mining | Catalogues bought G1 | `1587-r1` G2 (email `.toLowerCase()`) is 0/6 ever found yet is the same normalisation class the catalogue already cracked — the question exists and doesn't fire. Free transcript mining |
| H-A2 clean-discharge demotion | Built; no-op under `minimal` | Only measurable under a `full`-contract arm |
| H-A5 making confidence real | Confidence is decorative | Until it carries signal, every threshold lever pushes on a rope |
| WP1c non-TS grammars | Not started | The generality lever (2/73 → 23/73 EC-strict prescription) |
| WP9 tier 2 fresh blind gold | Not started | The credibility lever — decontaminates the blind split |
| WP7 review memory | Not started | Disposition recording is already live |

## This pass (2026-08-25)

Landed together, then measured as a bundle: **f1** (the `facts` stage stages the diff once under `.lastlight/pr-review/diff/` — an index plus per-file patches — and the briefs point at it by checkout-relative path instead of branches re-running `git diff`); **the production model default** (`models.review-survey` set to Haiku in `config/default.yaml` — previously unset, so an operator enabling the pipeline ran six Sonnet phases where every measurement assumed Haiku surveys); **per-family obligation floors** in seed ranking (each family that minted anything is guaranteed min(5, minted) slots via a round-robin reserve inside the budget; output stays rank-ordered and deterministic, `dropped[]` accounting kept) plus pinning tests for the `maxObligations` wiring (#24 was stale — already wired in `e83059e3`, previously untested). Note the floors also move `contract`'s share *down* (~40→35 on a starving PR) as `security`'s comes up — one more reason the comparison arm is a bundle read. Floors validated free by replaying the seed over stored envelopes before any paid run.

Then one Haiku comparison arm: 8 cases × 2 repeats on `wp3-minimal-d2ab`, comparator `114322/114323`. This measures the **bundle** (boundary-pin fix + f1 + floors + defaults), not any single lever — the one-variable discipline is deliberately traded for speed here, and the write-up must say so. Read internal recall first; then posted recall/precision, survey bash-call counts and branch-seconds (vs f4's ~1300 s), security-family obligation counts, and cost per case.

### Measured (2026-08-25, runs `030141/030142-33afc93`, $28.66)

**The arm is valid**: `disposition.json` present ×16 with the overlay pin recorded — `maxBodyComments: null` reached the boundary for the first time (end-to-end proof of the context fix). One comparability caveat: `maxInlineComments` flowed in as 10 (the overlay doesn't pin it) vs D2's 8; body is unlimited in both, so posted recall is unaffected by that delta.

**Wins, consistent everywhere**: cost $16.90 → $14.33/repeat (−15%), p50 787 → 616 s (−20%); best-ever Haiku precision (0.292 r1) and F1 (0.286 r1); the `1641` canary dropped from 7/5 FPs to **0/2**; blind `1667` posted 3/3 matched in r2 (precision 1.0, its best result on record — the security floor held its 5 slots, the family the floors were built for). **f1 landed behaviorally**: survey bash calls 848 → 399 (−53%), git range re-derivation 292 → **16** (−95%), 405 staged-diff reads; economically it's −8% on the survey branches, with the case-level saving mostly f4's review reshape. **Floors work as designed** (byte-identical family sets across repeats, budget respected, reserve-aware `dropped[]`).

**The loss, and it is the guardrail number**: posted recall 0.400 → 0.260 mean (band 0.040, so the −0.14 move is real at this resolution), and **internal union fell 21/25 → 12/25 — a discovery regression, not a boundary one**, concentrated in the heavy-mint train cases (`1587-r2` collapsed from 4/5 to ~0; G5 unfound after the f4 arm had it 3/3; one repeat's internal grade lost to a judge flake). Precision up + recall down is the shape LD1 has reproduced four times, and the bundle has two confounded suspects it cannot separate: (a) the floors displaced ~5 `contract` slots from exactly the family converting on those cases (contract 17–20 → 13 on `1587-r2`); (b) the staged diff halved survey bash activity — branches that read patches instead of exploring may discover less. `1587-r1` G2 is now 0/8 ever found.

**Next**: two one-variable decomposition arms (floors-off vs stage-diff-off, ~$28 each, needs sign-off) before believing either suspect; n=2 also argues one more repeat pair of this same shape. If the floors are the culprit, per-family *ceilings* (above) supersede them; if the staged diff is, the brief's instruction needs to permit exploration beyond the patch rather than replace it.

### Measured round 2 (2026-08-25, runs `035047/035048-33afc93`, $32.96) — reword + ceilings

Both suspects were addressed at once (user's call, bundle again): the staged-diff instruction reworded from prohibition to affordance across all three surfaces (prompts, briefs, `index.md` header — "the patch is your STARTING POINT, not your scope"), and the floors replaced by **per-family ceilings** (`FAMILY_CAPS`: contract 12 / enforcement 12 / state 8 / security 8 / tests 8; `maxObligations` demoted to a 48 backstop that binds on nothing at the defaults).

- **Discovery recovered — the guardrail number moved back**: internal union 11 → **18**/25 (D2: 21), consistent across both repeats' vectors. **`1587-r1` G2 was found internally for the first time in 9 arms**; `1587-r2` G5 came back. The reword did what it was designed to do: survey exploration recovered (+39% bash, greps 3 → 24) while range re-derivation stayed dead (41 calls vs D2's 559).
- **Ceilings are strictly better mechanics than the floors**: heavy-case contract reads a byte-identical 12/12/12 (floors era: 17/15/8 — the same family on near-identical envelopes swung 2× with where other families' ranks fell), `security` keeps 7–8 slots, per-family `dropped[]` reasons.
- **But posted recall fell further** (μ 0.260 → 0.180) at a quarter of D2's posted volume (17/27 vs 56/60): found 18, said 4–5, internal tiers swollen to 242/227. Body cap pinned `null`, so this is not the boundary — **the found→said gap is now decisively the binding constraint**, the same conclusion the gpt-5.4-mini arm reached from the other side (found ≈ said under a different say-side model). Canary near-clean (2/1 FPs vs D2's 7/5); cost $32.96 ≈ D2's $33.81 with far better SNR-shape.
- Two `internalUngraded` judge flakes (one per arm, deterministic re-read only would not fix them); n=2 supports the internal-union direction, not fine posted distinctions.

**The next lever is therefore the say side, not discovery**: the mixed-model arm (Haiku surveys + gpt-5.4-mini `review`/`adjudicate`) is now the highest-expected-value experiment on the board, with adjudicate-prompt work ("post what the ledger found") as its $0-design sibling. Boundary tuning stays second — the findings are landing `internal` at the adjudicator, before any threshold sees them.

### The say-side ladder (2026-08-25, ten arms × 2 repeats on the 4-case subset, $174)

Subset: `1587-r2`/`1667`/`1680-r1`/`1641` (14 gold, 2 blind + the canary). All arms ran Haiku surveys via `--mode config` overlays except `gpt-ref` (gpt-5.4-mini everywhere, models mode). Screening instrument only — the subset ranks the field and locates mechanisms; it does not produce headline numbers.

**Thinking mechanics, established empirically along the way** (after two wrong readings, both corrected): *unset* variant → the model's server-side **adaptive default** (Sonnet 4.6 and Haiku 4.5 think by default; gpt-5.4-mini reasons at OpenAI's default medium); `variants.review: "off"` → thinking **genuinely disabled** (0 blocks in every say-side session of both off arms); `minimal` caps it; `high` raises it. Every historical arm ran at adaptive-default thinking. `variants.review` reaches both `review` and `adjudicate`; the survey phases still have no `variant:` wiring (f2 remains unbuilt there).

League table (posted recall over 14 gold; intU/postU = internal/posted union; f→s = posted-of-found conversion):

| Say side | recall μ | band | precision | intU | postU | f→s | $/rep |
|---|---|---|---|---|---|---|---|
| **gpt-5.4-mini everywhere** | **.393** | .071 | .625/.600 | 8 | **7** | **.88** | **6.14** |
| gpt-5.4-mini (surveys Haiku) | .286 | .143 | **.833/.750** | 9 | 6 | .67 | 7.84 |
| Sonnet 4.6 (adaptive) | .286 | **.000** | .500/.571 | **11** | 7 | .64 | 10.21 |
| Kimi K3 fast | .286 | **.000** | .500/.667 | 7 | 5 | .71 | 10.62 |
| Sonnet 4.6 minimal | .286 | .143 | .333/.167 | 9 | 7 | .78 | 8.31 |
| Haiku high | .286 | .286 | .316/.167 | 11 | 7 | .64 | 8.05 |
| Sonnet 4.6 thinking-off | .314¹ | .229 | .500/.222 | 9 | 7 | .78 | 11.18 |
| gpt on adjudicate only | .250 | .071 | .500/.667 | 7 | 4 | .57 | 8.17 |
| Haiku thinking-off | .179 | .071 | .375/.133 | 10 | 4 | .40 | 8.20 |
| GLM-5.2 fast | .143 | .000 | .667/.500 | 7 | 2 | **.29** | 8.46 |

¹ one judge-flaked ungraded case inflates this μ (graded over 10 gold in one repeat).

**What it established** (n=2 everywhere): (a) **the say-side model barely moves discovery** (internal union 7–11 across all arms, same surveys) — **it moves conversion (.29–.88) and precision**; (b) **adjudicate is most of the lever, not all** — gpt-on-adjudicate-only captures most of the precision win but converts worst-but-one; (c) on Sonnet, **adaptive thinking is a selectivity knob, not a recall knob** (recall flat across off/min/default; precision peaks at default; posted volume balloons when thinking is capped or off); Haiku-high is the ladder's most erratic arm (band .286); (d) GLM reproduces its AACR bury-everything character exactly (f→s .29) and Kimi K3 fast is Sonnet-quality at a $22.50/M-output price — no case for either; (e) **the ensemble posted union across ten arms is 13/14** — the pipeline collectively can say nearly everything it finds; each single configuration says about half; (f) Haiku surveys still discover marginally more than gpt's own (intU 9–11 vs 8) — gpt-everywhere's league-leading posted recall is pure conversion. Historic per-gold movement: `1667` G2 (the found-not-said case) was finally POSTED by three arms; `1667` G4 is the last never-said holdout (found by 3, posted by none).

**Adjudicator forensics (same day)**: the dominant found→said thief is not model quality but two prompt rules — (1) findings *phrased as* verification/discharge reports self-tier `internal` even when they CONFIRM a defect ("spec asked 503, code returns 500 … this discharges S-8" → buried; 2 of 2 gold demotions in the examined arm), and (2) one measured case of reviewer-silence-as-evidence ("since the prior reviewer didn't block it…"). Both fixed in `prompts/review-adjudicate.md` (the claim-DIRECTION carve-out; the silence-is-not-evidence boundary) — **landed, untested**. The judge also gained a one-retry on unparseable replies (three flakes in one day each cost a case its grade).

**Next (needs sign-off, ~$30–35 each)**: two 8-case confirm arms on current code including the prompt fixes — (1) **gpt-5.4-mini everywhere** (ladder leader, cheapest, and its pre-fix 8-case baseline exists for a direct fix-effect read), (2) **the shipped Haiku shape** (the fixes target exactly its measured failure mode; if conversion recovers toward the 18/25-found ceiling, Haiku-discovery + fixed-conversion may retake the lead at lower cost). The subset's screening job is done — no further subset arms before those confirms.
