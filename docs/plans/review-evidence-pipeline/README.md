# PR review as a program-analysis system — design

> **Picking this up in a new session? Start at [RESTART.md](RESTART.md)** — tree
> state, the three commands that prove it is sane, what is next, and how to
> drive sub-agents on it. This file is the *why*; that one is the *how*.

Turn `pr-review` from **one agent turn over a diff** into a pipeline where
deterministic program analysis constructs the world the model reasons in, and an
executable oracle decides which of its hypotheses survive.

The thesis is not new to us. It is what our own measurements have been saying
for three failed and one partially-successful candidate, and it independently
matches what the external literature and the commercial leaders converge on.
The evidence — ours and theirs — is in [00-evidence.md](00-evidence.md). **Read
that first.** Several decisions below are direct consequences of it, and two of
them run *against* the obvious advice.

## The problem, in one number

On eight real `nearform/skillspro` PRs where a named human reviewed the exact
head SHA we had just approved, the shipped reviewer caught **1 of 25** gold
findings. Micro-recall **0.040**. The blind split scored **0.000**. It posted
nothing at all on five of seven recall cases.

In production over the same period: 94 `pr-review` runs across 43 PRs, **71%
APPROVE**, and **58 of 59 approvals carried zero inline findings**.

It is not failing from lack of effort. It runs 54–68 turns, writes a genuine
cross-file trace, and then concludes "no findings" and discards it.

## What is actually blocking it

`pr-review.yaml` is two phases: one agent turn (`skills: [pr-review,
code-review]`, one model, a full checkout, `grep`/`read`/`git`) and one
deterministic poster (`type: post-review`). There is no static analysis, no AST,
no symbol index, no fan-out and no judge anywhere in the path. The entire
cross-file capability is a sentence in a prompt:

> *"grep the repo for its consumers and open them"* — `skills/pr-review/SKILL.md`

Four things stop it, in the order they bite:

| # | Blocker | Evidence |
|---|---|---|
| 1 | **The model's question set does not contain the human's questions.** Discovery, not verification, is the ceiling | Candidate v2 fixed verification outright — every disposition became quote-backed and machine-checked — and micro-recall moved 1/25 → 2/25. [00-evidence §2](00-evidence.md) |
| 2 | **Seeds one abstraction level too high get discharged at that level.** "Check this area" earns an honest CLEAN | v3 iter 1–2: 22-item checklist acknowledged in one sentence and skipped; a 17-row ledger honestly discharged, 0 findings. [00-evidence §3](00-evidence.md) |
| 3 | **Affordance gaps read as instructions.** The reviewer cannot open what is not on disk | The seeded workspace has no `node_modules`, so "open the library source" was *structurally impossible*. Staging it turned that into a one-`read` action and the model then quoted implementation lines. [00-evidence §3](00-evidence.md) |
| 4 | **No oracle.** Some defects are settled by running code, not by reading it | `1641-r2`: every mechanical fix worked, the model stood at the defect site with the dependency source open, and judged the buggy Proxy shim correct. The human settled the same question by *running ESLint with a probe file*. [00-evidence §4](00-evidence.md) |

None of these are prompt-quality problems, and three rounds of prompt work is
the evidence for that. They are missing machinery.

## Locked decisions

Recorded with reasoning because four were decided **against** the obvious
answer, and two contradict standard advice we would otherwise have followed.

| # | Decision | Why |
|---|---|---|
| 1 | **The deterministic layer generates hypotheses; it does not filter them** | The reverse — a static-analysis feed into a ruthless judge — is what v2 built and reverted. BitsAI-CR's ReviewFilter independently raised precision 54.5→67.1 and **cut recall 45.5→39.8**. Verification only *raises* recall where the oracle is cheap enough that generation is deliberately re-tuned to over-produce against it |
| 2 | **We deliberately over-generate, and precision is not the guardrail** | Frontier precision on this task is **3–5%** (CR-Bench GPT-5.2: 27.0% recall / 3.6% precision). We post ~2 findings per 8 PRs. Our instinct to protect precision is the opposite of what the field does. The guardrail becomes CR-Bench's **signal-to-noise ratio**, which is what degrades when a recall intervention goes wrong |
| 3 | **Every obligation names BOTH ends of the defect mechanism** | IRIS's ablation: CodeQL sources + LLM sinks = +9; **LLM sources + CodeQL sinks = −3, actively worse than no seed**; both ends = ~2× recall. A half-mechanism seed is not a weak seed, it is a harmful one |
| 4 | **Code facts are recomputed per run, not indexed** | We already have the checkout, and `pr-review` is in `PER_TARGET_REUSE_WORKFLOWS` so `node_modules` stays warm per PR. A persistent cross-repo symbol index buys invalidation, storage and multi-tenant scoping against *private customer repos* for a benefit we have not yet measured a need for. SCIP stays on the shelf as the escape hatch |
| 5 | **The analysis toolchain is pre-baked and pinned in the sandbox image, and never resolves `typescript` from the repo under review** | **TypeScript 7 has no programmatic compiler API** (`tsgo` is CLI+LSP only). `ts-morph@28` vendors its own compiler and has no `typescript` dependency. A toolchain that resolved the target repo's TS would break on every TS-7 repo, which is now most of them |
| 6 | **Every tool fails loud; an empty result is an error, never a pass** | We have already been burned by exactly this: dependency-cruiser refused to parse TS≥7 and **exited 0 anyway**, so the import-boundary gate went green while seeing nothing (root `CLAUDE.md`). A silently-empty obligation list is that bug with a green pipeline |
| 7 | **CodeQL is never in the product path** | Its CLI licence forbids non-open-source codebases without paid GHAS. Legal in the eval harness over public gold PRs; **illegal against `nearform/skillspro`**. The engine slot is **Opengrep**, not Semgrep — Semgrep's registry rules moved to a licence that plausibly excludes a review product |
| 8 | **The whole pipeline is off by default** (`review.analysis.enabled: false`) | `false` reproduces today's two-phase review byte-for-byte. Every phase lands dark and is switched on per deployment once it has been measured |
| 9 | **Specialists are separated by *question*, not by tool access** | There is no per-phase tool allow/deny in `PhaseDefinitionSchema`, and that gap already killed one proposed architecture (a "cold review" phase denied the GitHub tools). It is not needed: obligation family + prompt is the axis that matters. Adding tool gating stays an optional, separate enabler |
| 10 | **Parallel phases are restored, not invented** | Issue #7 built a `Promise.allSettled` DAG fan-out; issue #94 **deliberately removed it** to collapse two forked schedulers into one, because no production workflow used `depends_on`. #7's own build-it criterion was *"users are creating multi-reviewer workflows"* — which is now the case. See [05-parallel-phases.md](05-parallel-phases.md) |
| 11 | **We never re-derive what CI already said; we do want a runnable tree** | Those are different things, and an earlier draft conflated them. `checksState` / `ciSection` are already in the run context, so re-running the suite for a red/green verdict is pure duplication of a matrix build we cannot match. What execution buys is a **probe**, and that needs an install, not a test run. Hence `prepare` (cheap, the affordance) is split from `suite` (expensive, gated on `mutants` alone). See [04-probe-oracle.md](04-probe-oracle.md) |
| 12 | **Internal recall and user attention are separate budgets** | A candidate is never deleted for being noisy — but not every survivor earns an inline comment. Three tiers: **inline** (capped by `maxInlineComments`), **body** (posted, unbounded), **internal** (recorded to `review_findings`, never posted, auditable). *"Does AI Code Review Lead to Code Changes?"* (22k+ comments): concise hunk-level actionable findings are substantially likelier to cause a change. Twenty inline comments is not twenty times the signal of eight. See [06-adjudicate.md](06-adjudicate.md) |
| 13 | **Eight cases from one private repo cannot support a general claim** | They are an architecture-development instrument — and really **four PRs**, since rounds of the same PR are correlated, with a three-case blind split. External validation is a **mandatory** round, reported unpooled because the private set risks selection bias and the public sets risk contamination. See [09-external-validation.md](09-external-validation.md) |
| 14 | **TypeScript-first: prove the pipeline helps on TypeScript before buying polyglot** | **Added 2026-08-21, on a day of measurement.** WP3's and WP4's gates are read on the `skillspro` eval set, which is TypeScript, where the facts already work — TS/JS evidence coverage is **46.2%** against **2.7%** on the corpus's non-TS half. Grammars move the **Martian** corpus (40 of 50 cases non-TS), so they raise the **generality claim**, not the shipping path, and the deployment's managed repos are predominantly TypeScript. **Stage 2 grammars therefore become a [WP9](09-external-validation.md) dependency, not a [WP3](03-seed-and-survey.md) blocker.** See [01b](01b-code-facts-hardening.md) for the measurement and [09](09-external-validation.md) → WP1c for the scoped prescription |

## The target pipeline

```
                    the checkout we already have
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  DETERMINISTIC — no model spend                       │
   │                                                       │
   │  facts    diff hunks · changed symbols · impact cone   │
   │           contract delta · constants-minus-literals    │
   │           dependency delta + staged source · patterns  │
   │  prepare  install deps — the probe affordance, not CI    │
   │           (suite: only when mutation seeding is on)     │
   │  seed     obligations.json — BOTH ends, every time     │
   │           + diff-scoped surviving mutants              │
   │           + review-memory recalls                      │
   └──────────────────────────┬───────────────────────────┘
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  GENERATIVE — cheap model, deliberately over-produces  │
   │                                                       │
   │  survey   one obligation family per pass, fresh        │
   │           context, APPEND-ONLY union                   │
   └──────────────────────────┬───────────────────────────┘
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  ORACLE — makes over-generation affordable             │
   │                                                       │
   │  falsify  write a probe · RUN it · capture transcript  │
   └──────────────────────────┬───────────────────────────┘
                              │
   ┌──────────────────────────┴───────────────────────────┐
   │  ADJUDICATION — strong model, fresh context            │
   │                                                       │
   │  adjudicate  rank · tier · split verdict               │
   │              may DEMOTE; may not DELETE without a      │
   │              counter-transcript                        │
   └──────────────────────────┬───────────────────────────┘
                              │
   post-review   unchanged — one formal review, inline-anchored
   record        evidence packet → review memory
```

Every box has an existing mechanism in the codebase. Nothing here needs a new
engine concept:

- `type: script` / `type: bash` phases already run deterministic code in the
  sandbox and expose stdout downstream.
- `PhaseTypeHandler` (`packages/workflow-engine/src/ports/ports.ts`) is the
  registered escape hatch `post-review` already uses.
- `generic_loop` + `fresh_context` already gives per-pass context isolation.
- `until_bash` already gives machine-checked phase gates.
- Skill bundles are already staged **per phase**, with the comment *"Keyed by
  phase so concurrent phases in one workspace never touch each other's
  bundle"* (`src/engine/executors/shared.ts`).

## Phases

Each file below is a **self-contained work package**: goal, evidence, files,
contracts, acceptance criteria, tests, and an explicit non-goals list. They are
written to be handed to a sub-agent one at a time. The execution protocol —
ordering, prerequisites, what each agent must read first, and what it must never
do — is [HANDOFF.md](HANDOFF.md).

> **Amended 2026-08-21.** A structured design review took thirteen decisions
> before implementation, four of which correct load-bearing claims in the work
> packages below that turned out to be false. **Read
> [10-design-review.md](10-design-review.md) alongside this file** — where it
> contradicts a WP, it wins. Headlines: `code-facts` ships in the CLI (the eval
> harness cannot reach the sandbox image); the survey fan-out is six declared
> phases, not a loop; the `spec` axis is pulled forward as WP0; `mutants` and
> `suite` are cut; and "fail loud" must never fail the run, because the 30-minute
> review sweep re-dispatches anything that did not succeed.

> **Amended again 2026-08-21, after a day of measurement.** WP8, WP0 and WP1
> landed, and then **WP1b** — hardening `code-facts` against itself — found
> seven bugs, six of them the same species: *a wrong or absent answer that
> looked like a clean result.* Read
> [01b-code-facts-hardening.md](01b-code-facts-hardening.md). Headlines: the
> diff range must be the **merge base**, not the base branch tip (a production
> shape, not a dataset artefact); one `Project` **per tsconfig**, because the
> tier is not the coverage; there is a new **deterministic, zero-spend
> evidence-coverage gate** ([08-evals.md](08-evals.md) §7) that bounds WP3
> *upstream* of the mechanism metrics; the `coverage` extractor is **inert until
> WP4**; `patterns` is **spent as a discovery route**; and locked decision 14
> makes the plan explicitly **TypeScript-first**, moving Stage 2 grammars from a
> WP3 blocker to a WP9 dependency.

| WP | File | Delivers | Depends on |
|---|---|---|---|
| — | [00-evidence.md](00-evidence.md) | What we measured, what is falsified, calibration against the field | — |
| — | [10-design-review.md](10-design-review.md) | The thirteen pre-implementation decisions + four corrections | — |
| 0 | [10-design-review.md](10-design-review.md) §D7 | The `spec` axis + split verdict + the PR-body/linked-issue plumbing | — |
| 1 | [01-code-facts.md](01-code-facts.md) | `packages/code-facts` — the deterministic fact extractors | — |
| 1b | [01b-code-facts-hardening.md](01b-code-facts-hardening.md) | The independent oracle, the sensitivity proofs, the 50-PR corpus, the anchor labels — **the record of what measurement found** | 1 |
| 1c | [09-external-validation.md](09-external-validation.md) → WP1c | Stage 2 tree-sitter grammars, **scoped to module-level declarations** | 1b |
| 2 | [02-sandbox-image.md](02-sandbox-image.md) | The pinned toolchain vendored into the sandbox image | 1 |
| 3 | [03-seed-and-survey.md](03-seed-and-survey.md) | `obligations.json`, the `survey` phase, the append-only union | 1 |
| 4 | [04-probe-oracle.md](04-probe-oracle.md) | `prepare` (incl. the coverage artifact) + `falsify` — the executable oracle | 3 |
| 5 | [05-parallel-phases.md](05-parallel-phases.md) | Bounded-concurrency scheduler (Track B) | — |
| 6 | [06-adjudicate.md](06-adjudicate.md) | Adjudicator, evidence packet, split verdict, per-check calibration | 3, 4 |
| 7 | [07-review-memory.md](07-review-memory.md) | Review-memory tables, the `record` phase, the mining cron | 6 |
| 8 | [08-evals.md](08-evals.md) | Micro-recall, SNR, utility metrics, **evidence coverage**; the measurement protocol | — |
| 9 | [09-external-validation.md](09-external-validation.md) | **Mandatory** external-validation round before any general claim | 6, 1c |

WP3's dependency on WP2 was dropped by §D1 — `code-facts` ships in the CLI, so
the image is no longer what makes the tools exist.

### The revised order

```
WP3 → WP4 → WP6 → [ship-capable on TypeScript]
  → WP1c Stage 2 grammars (scoped) → WP9 → [R] release → WP7c
  ;  WP2 parallel  ;  WP5 PARKED
```

> **Corrected 2026-08-21.** This line began `memory decision (2 GB cap) →`. That
> decision is **settled by measurement rather than taken** — peak RSS is
> dominated by `node_modules`, not by `--max-files`, and a changed-file-scoped
> module allow-list fits the 2 GB cap losslessly. Nothing blocks WP3 now. See
> [01b-code-facts-hardening.md](01b-code-facts-hardening.md) → "Where the memory
> actually goes", and [HANDOFF.md](HANDOFF.md) sign-off item 9.

The re-ordering is locked decision 14, and it is a **claim about which gate each
piece of work moves** rather than an estimate of effort: everything left of
"ship-capable" is read on `skillspro`, which is TypeScript; everything to the
right of it is read on Martian, which is 80% not.

WP5 and WP8 are independent of the chain. **WP8 went first** — it is the
instrument every other gate is read on, it costs no model spend, and its first
task was to back-fill the new metrics onto the baseline we already had. WP5 can
run at any time but must not jump ahead of WP4.

**There is no measurement run before code.** The comparator is the shipped
`pr-review`, already measured at micro-recall 0.040, and the new metrics
recompute from its stored scorecard offline. The first **model spend** in this
plan is still WP3's gate.

That is not the same as no measurement. WP1b added three deterministic
instruments that cost nothing and run over 50 real PRs — `facts-corpus.ts`,
`facts-evidence.ts` and `pnpm selfcheck` — and every number in
[01b](01b-code-facts-hardening.md) came from them. **Spend nothing before you
have read the free instrument**; it is the cheapest way to discover that a
family could not have converted. See [HANDOFF.md](HANDOFF.md).

## What this is not

- **Not a precision project.** Nothing here is justified by "the reviewer is too
  noisy". It is not. See locked decision 2.
- **Not a prompt rewrite.** Three rounds of prompt work moved recall by one
  finding. The prompt changes in WP3/WP6 exist to consume new machinery, not to
  replace it.
- **Not a model upgrade.** The Opus probe is dead twice over: Haiku 4.5 beats
  Sonnet 4.6 on review recall on two independent evals (41.2% vs 22.1% on
  Martian), and Martian shows a ~28-point *scaffolding* gap at fixed model class.
- **Not multi-language yet — and that is now a locked decision, not a
  concession** (#14). TypeScript/JavaScript is first-class; everything else
  degrades to the language-agnostic subset **and says so in the obligations
  file** rather than emitting nothing. Measured: evidence coverage 46.2% on
  TS/JS against 2.7% on the corpus's non-TS half, where both of the two hits are
  `.tsx` files mislabelled by Martian's PR-level language field. Grammars are
  scoped and deferred to [WP1c](09-external-validation.md), not abandoned.
