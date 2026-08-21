# WP3 — obligations and the survey phase

**Goal.** Turn the WP1 facts into **mechanism-complete obligations**, and run a
generative pass that discharges them into an append-only hypothesis union.

**Depends on:** [WP1](01-code-facts.md), [WP2](02-sandbox-image.md).

This is the work package that most directly targets the measured bottleneck.
Everything before it is plumbing; everything after it is filtering.

## The one rule that governs the obligation format

> **A seed naming one end of a defect mechanism is worse than no seed.**

IRIS's ablation, in numbers: CodeQL sources + LLM sinks = +9 over CodeQL alone;
**LLM sources + CodeQL sinks = −3, actively harmful**; both ends = +28, roughly
2× recall ([00-evidence §5](00-evidence.md)). Independently, v3 found the same
thing at the level of prompt phrasing: *"check this area"* earns an honest
CLEAN, *"quote the line that enforces THIS constant"* produced the Critical.

So the schema **structurally requires both ends**. Not by convention — a
one-ended obligation must fail validation and be dropped by the seeder with a
counted reason, so it can never reach the model.

## `obligations.json`

Written by `lastlight-facts seed` to `.lastlight/pr-review/obligations.json`.

```jsonc
{
  "version": 1,
  "coverage": "full",           // inherited from the facts envelope
  "degraded": [],
  "families": ["contract", "enforcement", "security", "state", "tests", "spec"],
  "obligations": [{
    "id": "O-014",
    "family": "enforcement",
    "mechanism": "a value is set on one side of a boundary and never checked on the other",
    "introducedAt": { "path": "src/config.ts", "line": 12,
                      "quote": "export const MAX_TOKEN_AGE = 900;" },
    "enforcedAt":   { "candidates": ["src/server/auth.ts"], "found": false },
    "question": "Quote the server-side line that compares a token's issue time against MAX_TOKEN_AGE, or state that no such line exists.",
    "evidence": [ { "type": "constant", "ref": "facts.constants[3]" } ],
    "discharge": "quote" | "probe" | "either"
  }]
}
```

Field notes:

- **`introducedAt` and `enforcedAt` are both mandatory.** `enforcedAt.found:
  false` with a `candidates` list is a *valid* second end — "we looked here and
  found nothing" is a mechanism, and it is the one that converted. What is
  invalid is omitting the field.
- **`question` must be answerable by quoting a specific line**, not by forming
  a judgement about a region. This is v3's lesson 1 encoded in the schema.
- **`discharge: "probe"`** marks an obligation the survey may not settle by
  reading — it must hand it to [WP4](04-probe-oracle.md). Use it for
  behaviour-of-code questions (library semantics, framework lifecycle, runtime
  option interactions) — the `1641-r2` class.
- **`family`** is the fan-out partition. One family per survey pass.

### The families

| Family | Seeded from | Asks |
|---|---|---|
| `contract` | `facts` + `contracts` | a producer's shape moved; does every consumer outside the diff still satisfy it? |
| `enforcement` | `constants` | a value is defined/validated on one side; who checks it on the other? |
| `security` | `patterns` + `facts` | attacker-controlled input reaching a changed sink; auth/authz checks moved |
| `state` | `facts` (impact cone) | cache invalidation, lifecycle, ordering, concurrency on a changed symbol |
| `tests` | `mutants` | the PR changed this expression and no test distinguishes it from a mutation |
| `spec` | PR body, linked issue, changed tests | **does the change do what was asked?** |

### The `spec` family is issue #271's fix 6

All nine "what to check" items in `skills/code-review/SKILL.md` are
standards-flavoured. Nothing asks whether the change does what the issue asked.
It was proposed in #271, never implemented, and is **orthogonal to everything
the investigation tried** — every candidate to date targeted the Standards axis
([00-evidence §7](00-evidence.md)).

> **Corrected 2026-08-21 ([10-design-review.md](10-design-review.md) §E2), and
> moved out of this WP.** It is **not** nearly free, and it no longer lives
> here. `prBody` appears nowhere in `apps/server/src` — it is a
> `TemplateContext` field that is never populated — and the linked issue is not
> projected either (`closingIssuesReferences` exists in `github.ts:1040` but its
> only consumer is `repo-digest.ts`). The `spec` family therefore needs real
> plumbing: `PrState` gains the body and `closes[]`, and `renderContext`
> projects them.
>
> Because it needs none of this plan's infrastructure and is the only untried
> axis, it was **pulled forward as WP0** (§D7) — landing after WP8 and before
> WP1, as ablation rung 0.5, so its effect is attributable on its own.

The seeder turns acceptance criteria into obligations whose second end is the
changed-file list from `git diff` — **not** prose, and not the implementing
symbol from `facts`, which WP0 does not have. IRIS's ablation is the reason: a
one-ended seed is *actively harmful* (−3, worse than no seed).

### Bounds

`maxObligations` (default 40) is a **budget**, so the seeder must rank. Rank by:
mechanism class first (`contract` and `enforcement` convert; `tests` is
mechanical and cheap), then by `referencesInDiff / referenceCount` — a symbol
whose consumers are mostly *outside* the diff is the cross-file bug that is
invisible file-by-file. Record what was dropped and why in the file; a silently
truncated list repeats the failure locked decision 6 exists to prevent.

## The survey phase

### Shape — six declared phases

> **Rewritten 2026-08-21 ([10-design-review.md](10-design-review.md) §D4).** The
> `generic_loop` form this section used to specify **did not work**. `until_bash`
> rejects template markers (`phase-executor.ts:86-91`) and the only env a phase
> receives is `LL_OUT_<PHASE>` (`:105`), so `$LL_FAMILY` was never set: the gate
> tested `hypotheses/.jsonl`, always failed, and the loop ran to
> `max_iterations` with a gate that meant nothing — the dependency-cruiser
> failure mode locked decision 6 exists to prevent. Worse, `families` has six
> entries and `surveyPasses` defaulted to **3**, so half of them never ran, and
> nothing said which half. `enforcement` produced the only gold match in the
> investigation and could have been one of the three that never executed.

One phase per family, chained:

```yaml
  - name: survey_contract
    label: Survey · contract
    prompt: prompts/survey-contract.md
    model: "{{models.review-survey}}"
    depends_on: [seed]
    on_soft_failure: { retries: 1, then: complete }   # §D12
    generic_loop:
      max_iterations: 1
      until_bash: |
        test -s .lastlight/pr-review/hypotheses/contract.jsonl
  # …survey_enforcement, survey_security, survey_state, survey_tests, survey_spec
```

This needs **no engine change and no [WP5](05-parallel-phases.md)** — the
scheduler already runs ready nodes one at a time. It buys **literal** gates (no
templating needed, so the gate is real rather than decorative), all six
families, per-family `timeout_seconds`, individual ledger rows, individual
retryability, and a visible dashboard node each. Separate phases never share a
transcript, so the context isolation `fresh_context` was there for comes free.

**Prompt layout is fixed now, not later.** The shared prefix — skill bundle,
`AGENTS.md`, diff summary — goes **first**; the family-specific obligations go
**last**. Prompt caching is provider-side and keyed on the request prefix
(sandboxes and sessions are irrelevant to it), so six passes then share one
cached prefix. Free if decided now, expensive to retrofit.

[WP5](05-parallel-phases.md) is **parked** (§D5): the YAML above is identical
sequential or parallel, so enabling concurrency later is `maxPhasesPerRun` plus a
scheduler change with no prompt or measurement rework.

### The union is append-only, and that is structural

Each pass appends to `.lastlight/pr-review/hypotheses/<family>.jsonl`. **No pass
ever reads, rewrites or reconciles another's file.**

Our own note that "LLM-mediated merge destroys recall" is contradicted by
SWR-Bench Self-Agg (13.9 → 30.4% at n=10) and c-CRAB's four-tool union (41.5%
vs 32.1% best single) — the number was most likely an artifact of a
consensus-collapsing merge prompt ([00-evidence §6](00-evidence.md)). Appending
to disjoint files makes collapse **impossible by construction** rather than by
instruction, and disjoint paths are also what makes the phases safe to
parallelise later ([WP5](05-parallel-phases.md)).

### Hypothesis record

```jsonc
{ "id": "H-021", "obligation": "O-014", "family": "enforcement",
  "claim": "Token expiry is never enforced server-side.",
  "bothEnds": { "introducedAt": "src/config.ts:12",
                "enforcedAt": null },
  "quotes": [{ "path": "src/server/auth.ts", "line": 73,
               "text": "const { issuedAt } = decode(token);" }],
  "needsProbe": true,
  "severity": "Critical",
  "confidence": 0.6 }
```

`quotes` must be real text at real lines — the five-line existence gate in
[WP6](06-adjudicate.md) checks the file exists and is non-empty; the adjudicator
checks the quotes resolve. v3's lesson 3: **two runs claimed "N obligations
discharged" in prose without writing the file at all.** v2's full quote
validator is overkill; existence plus a spot-check is what earned the gold.

### Prompt — `workflows/prompts/review-survey.md`

New, forkable. It receives one family's obligations and must:

1. Discharge **every** obligation with either a quote or a `needsProbe: true`
   hypothesis. "Nothing to report" is a valid discharge **only** with the quote
   that refutes it.
2. Never reason about obligations outside its family.
3. Never post, never write `findings.json`, never call
   `github_create_pull_request_review`.
4. Over-produce. The instruction is explicitly recall-first: *a plausible
   mechanism you cannot yet refute is a hypothesis, not noise — the oracle and
   the adjudicator decide what survives.* This is the deliberate inversion of
   today's confidence gate, and it is safe only because
   [WP4](04-probe-oracle.md) and [WP6](06-adjudicate.md) exist.

### Model

`models.review-survey`, defaulting to Haiku 4.5. It **beats** Sonnet 4.6 on
review recall on two independent evals (41.2% vs 22.1% on Martian) and costs a
fraction — which is what buys the fan-out inside the 2–3× budget. Phases 1–3
spend no model at all.

## Skill changes

### `skills/pr-review/SKILL.md`

- **Remove the prohibition**: *"Do not install dependencies, build, or run
  tests — that is CI's job"*. It is the single line most opposed to the probe
  oracle, and v3 showed affordance gaps read as instructions. Replace with a
  pointer to the probe affordance and its evidence requirement.
- **Keep** §1 stop conditions, §2 prior discussion, §2b the re-derive ledger
  (Fixed / Still open / Pinned by a test / Withdrawn), the workspace layout, and
  the findings contract.
- The procedure sections move into the phase prompts; the skill becomes the
  *contract* document.

### `skills/code-review/SKILL.md`

- **Keep** the rubric, the finding tiers, and the "gate cuts both ways" table —
  the rubric is not the problem.
- **Rebalance the global confidence gate.** AutoCommenter (Google Critique)
  found a global `t=0.98` catastrophic, with **~80% of below-threshold
  predictions still correct**; per-check thresholds raised recall without hurting
  precision. Our prompts contain exactly that global "only report if confident"
  language. Per-check calibration lands in [WP6](06-adjudicate.md); WP3's job is
  to stop the *survey* from self-censoring before the oracle has run.

## Config

`apps/server/config/default.yaml`, off by default so the change is inert:

```yaml
review:
  analysis:
    enabled: false        # false ⇒ today's two-phase review, byte-for-byte
    surveyPasses: 3
    maxObligations: 40
```

Repo-clampable **add-only** (a repo may ask for more analysis, never less than
the operator's floor), following the `approval` precedent in
`packages/shared/src/repo-config-schema.ts`. `models.review-survey` joins the
models map.

## Acceptance criteria

1. With `enabled: false`, `pr-review` produces **byte-identical** behaviour to
   today. Pin it with a golden test in the style of
   `apps/server/src/workflows/golden-build.test.ts`.
2. A one-ended obligation fails schema validation and is dropped **with a
   counted reason** in the file.
3. Each survey pass writes only its own family's file; a test asserts no pass
   opens another's.
4. `coverage: "degraded"` propagates from facts → obligations → the prompt, so
   the model is told what was not analysed.
5. **Measurement gate:** on the train split, micro-recall exceeds the **shipped
   baseline's 0.040**, and the `1641` empty-gold canary holds at 1.00. This is
   the plan's first model spend. The comparator is `2026-08-20_074355`, not
   candidate v3 — see [08-evals.md](08-evals.md) → "the ablation ladder".

## Non-goals

- **No probe execution.** `needsProbe` is recorded, not acted on — [WP4](04-probe-oracle.md).
- **No adjudication, no `findings.json` write, no posting** — [WP6](06-adjudicate.md).
- **No parallel phases** — [WP5](05-parallel-phases.md).
- **No repo memory** — [WP7](07-review-memory.md). The obligation schema leaves
  room (`evidence[]` accepts a `memory` type) but nothing populates it yet.
