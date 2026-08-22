# WP3 — obligations and the survey phase

**Goal.** Turn the WP1 facts into **mechanism-complete obligations**, and run a
generative pass that discharges them into an append-only hypothesis union.

**Depends on:** [WP1](01-code-facts.md) and
[WP1b](01b-code-facts-hardening.md). **Not** [WP2](02-sandbox-image.md) —
*corrected 2026-08-21 (§D1)*: `code-facts` ships inside the `lastlight` CLI, so
the image is no longer what makes the tools exist and WP2 left the critical
path.

> **Corrected 2026-08-21: the 2 GB agent cap no longer blocks this WP.** This
> paragraph used to end *"it also depends on a human decision about the 2 GB
> agent cap ([HANDOFF.md](HANDOFF.md) sign-off item 9)"*, because this is the WP
> that wires `lastlight-facts all` into a phase. That decision is settled by
> measurement rather than taken — see
> [01b-code-facts-hardening.md](01b-code-facts-hardening.md) → "Where the memory
> actually goes". Peak RSS is dominated by `node_modules`, not by `--max-files`,
> and a `resolutionHost` with an allow-list computed from the changed files'
> imports (`--resolution changed`) fits the cap at **zero type-fidelity cost
> across 499 contract entries**. None of the three levers a human was being
> asked to choose between is needed.
>
> **What this WP must not do is assume a bare workspace.** Every memory number
> quoted anywhere in this plan before today was measured on a workspace with no
> `node_modules`, which is what `pr-review.yaml` produces today only because it
> has no install phase — an accident, not an invariant.
> [WP4](04-probe-oracle.md)'s `prepare` ends it permanently (`git clean -fdx -e
> node_modules` keeps the install across runs), and at the old `--resolution
> full` default the same commits cost **3699–4430 MB, one of them an OOM**. So
> the `facts` phase must be measured on an *installed* workspace, not only the
> bare one, and must **name its resolution tier explicitly** rather than
> inheriting whatever the default is that week — or WP3 ships a memory profile
> that WP4 silently invalidates.

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
| `tests` | ~~`mutants`~~ → `coverage` | this changed line is executed by zero tests. **Inert until [WP4](04-probe-oracle.md)** — see below |
| `spec` | PR body, linked issue, changed tests | **does the change do what was asked?** |

> **Two rows corrected 2026-08-21, on landing
> [WP1b](01b-code-facts-hardening.md).** Both were falsified by measurement, and
> both change what the seeder should do rather than merely how a row reads.
>
> **`tests` is seeded from `coverage`, not `mutants`** (§D13 cut mutation
> seeding), **and the `coverage` extractor is structurally dead today**: **0
> artifacts across all 50 corpus cases**, because it *reads* an existing report
> and nothing in the pipeline produces one. The `tests` family therefore cannot
> convert at all until [WP4](04-probe-oracle.md)'s `prepare` lands. That is a
> **hard ordering constraint**, not a preference — a WP3 gate read on six
> families is really a gate read on five, and a per-family attribution table
> that shows `tests` at zero would be measuring an absent artifact, not an
> unproductive family. Label it **"not measured"**, per §D2's rule for the
> scanners.
>
> **`patterns` is spent as a DISCOVERY route, and the counterfactual proves
> it.** With both binaries installed and the YAML fixed, the corpus produces
> **13 real findings and +0 EC-loose** — not one of them points at a place any
> gold finding is about. The `security` family's scanner half is **evidence
> *for* questions, not a mechanism for *finding* them**, which is the
> distinction [WP1](01-code-facts.md) already draws about `patterns`
> ("evidence, not findings") applied one level up: it is also not a *seed*.
> **WP3's family design should stop treating scanners as a discovery axis.**
> That does not delete the `security` family — `facts` still supplies the sink
> half — but the family's both-ends shape has to be built from the impact cone,
> with a scanner hit as corroboration when one happens to exist.

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

### Read evidence coverage BEFORE spending on an arm

**Added 2026-08-21 ([WP1b](01b-code-facts-hardening.md)).** [WP8](08-evals.md)
§7 is a free, deterministic upper bound on what facts-seeding could ever
contribute: *does the envelope even name the identifier the human talked about?*
If it does not, no obligation about that identifier can be produced **from
facts**, whatever this WP's prompts say.

On the WP1b corpus that bound is **12/26 = 46.2% on TS/JS and 2/73 = 2.7% on
non-TS** — and both non-TS hits are `.tsx` files, so the honest non-TS figure is
lower still. That is not a reason to delay WP3; the gates are read on
`skillspro`, which is TypeScript. It is a reason to **run the instrument first
and read it per family**: a family whose identifiers the envelope never names
cannot convert, and finding that out costs nothing where finding it out on an
arm costs $6–19.

Adopt it as a **precondition**, not a gate: a WP3 arm that reports a family
converting at zero must say whether evidence coverage for that family was ever
above zero, so "did not convert" and "was never nameable" stay distinguishable.
That is locked decision 6's requirement, applied to the seeder instead of the
extractor.

### Measured 2026-08-22 — the precondition, read on both populations

AC6 discharged before any spend. `facts-evidence.ts` grew a per-family table
(surfaces → families, TS/JS split derived from the envelope's own `languages[]`
rather than the dataset's PR-level label). Two corpora, both on the **tsgo**
engine: Martian's 50 and — the one that matters — the eight `skillspro` cases
the gates are actually read on.

**On the gate set: anchor rate 25/25 (100%), discovery ceiling 76.0%,
EC-strict 52.0%, all eight cases tier 1.**

| family | entity (strict) | + file (loose) | only this family | on Martian (strict) |
|---|---|---|---|---|
| `contract` | 11/25 44.0% | 18/25 72.0% | 0 | 14/28 50.0% |
| `enforcement` | 4/25 16.0% | 4/25 16.0% | **1** | **0/28 0.0%** |
| `security` | 11/25 44.0% | 11/25 44.0% | 0 | 14/28 50.0% |
| `state` | 11/25 44.0% | 18/25 72.0% | 0 | 14/28 50.0% |
| `tests` | notMeasured | | | notMeasured |
| `spec` | notMeasured | | | notMeasured |

Four things follow, and three of them change what this WP should do.

**1. `enforcement` reads 0 on Martian and 16% on the gate set, and the zero is
about the corpus.** `constants` emits **0 constants across all 50 Martian
cases** — on *both* engines, so it is not the swap. The extractor requires a
module-level `const` with a **literal initializer whose declaration line is
itself inside a changed hunk**, and across 50 real PRs that never happens. On
`skillspro` it fires richly (13 / 14 / 17 constants on the three `1587` cases).
A family that cannot be measured on one corpus and converts on another is not a
weak family; it is a family whose corpus was wrong.

**2. `1587-r2`'s Critical is named mechanically, and by `constants`
specifically.** The gold the whole investigation turns on is hit through
`SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS` — 2 references, 1 hard-coded duplicate,
in the envelope, with no model. AC5 asks whether the O6 → Critical conversion
reproduces mechanically; its **deterministic precondition now holds**. And
`enforcement` is the only family with an exclusive finding (`1587-r3#3`, reached
by no other surface), which is the measured form of the argument that it earns
its own pass.

**3. `sides` is INERT on the gate repo and the seeder must not depend on it.**
Every reference partitions to `shared` — `client: 0, server: 0` on all 14
constants of `1587-r2` — because `--sides` is a heuristic path prefix nobody
configured for this repo. The `1587-r2` mechanism is *"referenced client-side,
never compared server-side"*, which is exactly what `sides` would express and
exactly what it does not. **Build the `enforcement` both-ends from the
subtraction (`references` vs `hardCodedDuplicates`), which is populated, and
treat `sides` as a ranking hint that is frequently absent.**

**4. The engine swap is evidence-coverage neutral — and the instrument is blind
to what it did cost.** Scored against the ts-morph run, *nothing moved*: TS/JS
EC-strict 46.2% both ways, EC-loose 41.9%, ALL 14.1%, zero per-finding moves.
The TS/JS candidate pool fell 214 → 186, so it is the same naming from a
smaller pool. But underneath:

| | ts-morph | tsgo |
|---|---|---|
| tier-1 cases | 21 | **5** |
| contract deltas, corpus-wide | 73 | **19** (−74%) |
| `cal-com-10600` | tier 1, 15 symbols `type-aware`, 4 contracts, 1 degraded | tier 2, 22 symbols `name-match`, **0 contracts**, 16 degraded |

One cause, verified on all 16 demoted cases: a tsconfig that `extends` a **bare
package specifier** (`@calcom/tsconfig/react-library.json`, `@grafana/tsconfig`)
does not resolve on a bare corpus tree with no `node_modules`. tsgo reports a
config parsing error and — correctly, per its rule 3 — **excludes** the project
rather than degrading it; the case drops to tier 2 and `contracts` emits
nothing. ts-morph recovered from the same unresolvable `extends` and stayed
tier 1.

**Evidence coverage cannot see this, by construction**: tier 2's name-match
still populates `facts.symbols[].name`, so naming survives a tier demotion
intact. Nor could the swap's fidelity gate have caught it — that was read on
*this* repo at `HEAD~1..HEAD` **with `node_modules` installed**, where every
`extends` resolves. The population where it shows is bare monorepo checkouts,
which is what a review workspace is.

> **So `contract` joins `tests` as a family gated on [WP4](04-probe-oracle.md)'s
> `prepare`** — on any repo whose tsconfigs extend a package, which is the
> normal monorepo shape. Installing dependencies makes the `extends` resolve and
> the project load. The gate set is unaffected (`skillspro` is 8/8 tier 1), so
> this does not block WP3's arm; it bounds what a `contract` result generalises
> to, and it is a second measured instance of the same ordering constraint
> §D13 already recorded for `coverage`.

Two caveats to carry: the `skillspro` anchor labels are **unaudited** (the hand
audit is 20 PENDING, against Martian's audited 0/20 spurious), so they have no
error bar; and 88% of them are `diffuse` against a median 58 matched lines,
which is why the entity-level bar is the only one read.

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

### Coverage is a frozen denominator

**Added 2026-08-22, from `alibaba/open-code-review` (Apache-2.0). Prior art, not
speculation** — see [09](09-external-validation.md) §"AACR-Bench" for why that
project's *conclusions* are the opposite of ours while this *mechanism* is worth
taking wholesale.

The blocker this addresses is the plainest one in
[00-evidence](00-evidence.md): the shipped reviewer **posted nothing at all on
five of seven recall cases**. Open Code Review names the same failure as the
first of three it built its architecture against — *"on larger changesets,
agents tend to cut corners, selectively reviewing only some files and missing
others"* — and the fix is not a prompt.

**The rule.** A run cannot report what it did not look at, and it must not be
able to *silently* look at less than it was given. So:

1. **Register before dispatch.** Every planned item (here: every obligation, and
   every changed file an obligation names) is registered into a `selected` set
   before any model call.
2. **Seal it.** After sealing, registration fails. The denominator cannot grow
   to match what was actually achieved — which is the only way it can lie.
3. **Mark, never re-register.** Items move to `reviewed` / `failed` / `waived`
   by transition, keyed on a **content-independent item id** so a resume that
   changes diff content does not silently mint a second identity and no-op the
   transition. (Open Code Review keys transitions on `ItemID(operation, mode,
   oldPath, newPath)` and keeps the content-sensitive `Fingerprint` as a
   *separate* field used only for checkpoint matching. Two keys, two jobs. We
   have already been bitten by the general shape of this at resume boundaries —
   see the `skip_if` and `phaseOutputs` traps in [HANDOFF](HANDOFF.md).)
4. **The terminal state is derived from coverage alone.** Not from finding
   count, not from warnings:

   ```
   run_failure set        -> failed
   selected == 0          -> skipped      (NOT success)
   failed == 0            -> complete
   failed == selected     -> failed
   otherwise              -> partial
   ```

This is the missing half of **§D12**. D12 says *fail loud means loud in the
artifact, never fatal to the run*, because `cron-review.yaml` re-dispatches a
failed run every 30 minutes forever. What D12 did not give us was a way to be
loud about **partial** work. `partial` is exactly that state: the run succeeded,
`assessedHeadShaByWorkflow` is written, the re-dispatch loop stays shut, and the
artifact still says which obligations were never surveyed and why.

It is also the same invariant `code-facts` already enforces one level down —
**`null` means nobody looked, `[]` means looked and found none**
([01](01-code-facts.md), and the M6 bug in the package's `CLAUDE.md`). A sealed
coverage set is that distinction applied to the review rather than to a fact.
`APPROVE` with zero findings and `terminal_state: complete` is a claim.
`APPROVE` with zero findings and `terminal_state: partial` is the bug we have
been shipping for months without being able to see it.

**Where it lives.** The survey phases produce it, `adjudicate` reads it
([06](06-adjudicate.md)), and `post-review` must refuse to emit `APPROVE` on a
`partial` or `skipped` run. The eval harness reads it too: a case whose coverage
is `partial` is `notMeasured`, never a zero
([08-evals.md](08-evals.md) — *"a missing analyser is not a null result"*).

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
5. **Measurement gate:** the **mechanism** metrics of §D6 — obligations
   generated and well-formed, discharge rate, the per-family funnel obligations
   → hypotheses → posted → matched, and whether `1587-r2`'s O6 → Critical
   conversion reproduces mechanically. Micro-recall is **reported** beside the
   shipped baseline's 0.040 with its paired McNemar p, and the `1641` empty-gold
   canary holds at 1.00, but neither is gated on: one extra finding is p = 0.50.
   This is the plan's first model spend. The comparator is `2026-08-20_074355`,
   not candidate v3 — see [08-evals.md](08-evals.md) → "the ablation ladder".

   > **Corrected 2026-08-21 ([10-design-review.md](10-design-review.md) §D6).**
   > As originally written — *"micro-recall exceeds the shipped baseline's
   > 0.040"* — this gate is satisfied by **one** extra finding, at p = 0.50. §D6
   > re-expressed WP3's and WP4's gates as mechanism gates for exactly that
   > reason and the criterion had not been updated to match.
6. **Added 2026-08-21.** Evidence coverage ([08-evals.md](08-evals.md) §7) is
   read and recorded **per family** before the arm is run, so a family
   converting at zero is never confused with a family that was never nameable.

## Non-goals

- **No probe execution.** `needsProbe` is recorded, not acted on — [WP4](04-probe-oracle.md).
- **No adjudication, no `findings.json` write, no posting** — [WP6](06-adjudicate.md).
- **No parallel phases** — [WP5](05-parallel-phases.md).
- **No repo memory** — [WP7](07-review-memory.md). The obligation schema leaves
  room (`evidence[]` accepts a `memory` type) but nothing populates it yet.
