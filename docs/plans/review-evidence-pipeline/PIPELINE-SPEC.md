# The PR-review evidence pipeline

Deterministic program analysis mints **obligations** — two-ended questions
about defect mechanisms — from a pull request's diff. Five seeded survey
passes, one per live obligation family, run concurrently and deliberately over-produce
**hypotheses**; a probe oracle falsifies what can be executed against; one
fresh-context adjudicator ranks and tiers the survivors under a mechanical
**conservation gate** that makes silent omission impossible; and an **attention
boundary** prices what a maintainer actually sees, recording — never dropping —
everything it withholds. The whole pipeline is off by default: every analysis
phase is gated on `review.analysis.enabled`, the gate key is *absent* (not
false) on a deployment that has not opted in, and with the pipeline off the
review that posts is byte-identical to the two-phase reviewer — no cap, no
thresholds, no `internal` tier, no split verdict.

## The DAG

`apps/server/workflows/pr-review.yaml`. Nine phases, declared with explicit
`depends_on` (which disables chain synthesis for the whole file, so every edge
below is deliberate):

```
prepare → facts → seed → survey (fanout ×5) → falsify → review ─┬→ adjudicate → reconcile
                                                                └→ post-review
```

| Phase | Type | Gate(s) | Trigger rule | Timeout |
|---|---|---|---|---|
| `prepare` | bash | `analysisEnabled`, `probesEnabled` | — (root) | `probePhaseTimeoutSeconds` (default 300) |
| `facts` | bash | `analysisEnabled` | `all_done` on `prepare` | 300 s |
| `seed` | bash | `analysisEnabled` | `all_done` on `facts` | 120 s |
| `survey` | fanout | `analysisEnabled` | `all_done` on `seed` | per branch |
| `falsify` | agent + `generic_loop` | `analysisEnabled`, `probesEnabled` | `all_done` on `survey` | — |
| `review` | agent | — | `all_done` on `falsify` | — |
| `adjudicate` | agent + `generic_loop` | `analysisEnabled` | `all_success` on `review` | — |
| `reconcile` | bash | `analysisEnabled` | `all_done` on `adjudicate` | 120 s |
| `post-review` | post-review | — | `all_success` on `review` | — |

Three edges carry invariants:

- **`review` and `post-review` use `all_done` / `all_success` deliberately.**
  `review` depends on `falsify` with `all_done` because on every deployment
  that has not enabled the pipeline the analysis phases *skip*, and a skipped
  node is not `succeeded` — with the default rule the shipped reviewer would
  vanish. `post-review` keeps the default `all_success` on `review`: **a
  failed review must not post.**
- **`adjudicate` is a SIBLING of `post-review`, not a link in its chain.**
  `trigger_rule` is per-node and applies to every dependency, so
  `post-review: depends_on [review, adjudicate]` could not say "all_success
  w.r.t. review, all_done w.r.t. adjudicate" — it would have to relax to
  `all_done` and lose the failed-review invariant. Declared above
  `post-review`, so the sequential scheduler (earliest-declared ready node)
  runs it first; unreachable from `post-review`'s dependency set, so it can
  never stop a review from posting.
- **`reconcile` uses `all_done` on `adjudicate`** because the conservation
  floor must apply precisely when the adjudicator failed or was cut short —
  that is when there is something to repair.

### The off switch, structurally

Every analysis phase carries `skip_if: "analysisEnabled != true"`. The key
reaches the template context from exactly one place — `specContext()` in
`src/engine/pr-decisions.ts`, which returns `{}` when
`review.analysis.enabled` is false — and `evalSkipIf` coerces an absent
variable to `false`, so `!= true` matches and the phase skips. The failure
direction of a typo anywhere in the block is therefore "the analysis does not
run", never "an unmeasured pipeline runs on a deployment that did not ask for
it". `probesEnabled` is a second, separate key, projected only when the
operator set `review.analysis.probes` as well as `enabled`; `prepare` and
`falsify` require both. A deployment with the pipeline on and probes off runs
the surveys and the adjudicator against read-only evidence.

`review.analysis` is **operator-only** in the per-repo config layer: a managed
repo's `.lastlight/` may not set it (it is spend, with no more-conservative
direction to clamp towards).

### The FACTS binary

Every bash phase and every `until_bash` gate resolves the `lastlight-facts`
CLI through one chain, expressed in shell because core has no import edge to
`lastlight-code-facts` and must not grow one:

```
${LASTLIGHT_FACTS_BIN}  →  command -v lastlight-facts (PATH)  →  /opt/lastlight/bin/lastlight-facts
```

### Fail-loud without failing the run

The deterministic phases exit 0 on every path. A phase that fails hard records
no `assessedHeadShaByWorkflow` and is re-dispatched by `cron-review.yaml`
every thirty minutes, forever — so loudness lives in the **artifact**, not the
exit code. `facts` and `prepare` carry a shell-level `||` fallback (not just
the CLI's `--never-fail`, which is an in-process try/catch and cannot cover a
process that dies): when the analysis process is killed, the phase itself
writes a schema-valid `coverage: "none"` envelope naming the reason, so
downstream phases print "nothing was analysed" instead of reading silence as
clean. An empty result and an unavailable analyser are never
indistinguishable, at any layer.

## `prepare` — the probe environment

`type: bash`, gated on both switches, first in the DAG because it is a
precondition for two families, not just an affordance for probes: on a bare
checkout a tsconfig that `extends` a bare package specifier does not resolve,
the compiler excludes the project, the case drops to tier 2 and the `contract`
family sees nothing. Installing dependencies restores tier-1 analysis.

It runs `lastlight-facts prepare --repo . --out
.lastlight/pr-review/probes/env.json --never-fail`, appending
`--lifecycle-scripts` / `--typecheck` / `--coverage` only when the
corresponding config switch is the literal string `"true"` in the context —
absent means off, so the failure direction of every sub-switch is "do the
cheap thing", never "run a stranger's postinstall". Three properties of
`prepare` are contract:

- **Lifecycle scripts are off by default.** The install runs at a pull request
  head — code the PR author wrote, on the operator's machine — and resolving a
  package-extending tsconfig needs the files, not their scripts.
- **`--coverage` runs only a command the repo itself named** (a `coverage` /
  `test:coverage` script). It never guesses. A red suite still counts:
  coverage needs no green baseline.
- **Every step distinguishes "could not" from "found nothing"**, and
  `installed` is read off the filesystem at the end — a dead process still
  leaves whatever it managed to unpack, and that is the only question a later
  phase asks.

The phase timeout is the *phase's* ceiling — the sum of the enabled steps'
budgets plus slack, computed in `specContext` (`probePhaseTimeoutSeconds`) —
not the install budget, because a phase killed part-way through a coverage run
writes no `env.json` at all. On process death the shell fallback writes a
degraded `env.json` whose `installed` is read from `node_modules` presence.

## `facts` — the deterministic layer

`type: bash`. Resolves the **merge base** (`git merge-base
origin/<baseBranch> HEAD`) — never the base branch tip, whose two-dot delta
contains commits the author did not write — and runs `lastlight-facts all
--repo . --base <mergeBase> --head HEAD --out .lastlight/pr-review/facts.json
--never-fail`. A base that cannot be resolved (unrelated histories, a clone
too shallow to share one) is a loud `coverage: "none"` envelope, never a
silent fallback to `HEAD~1`: analysing the wrong range and reporting success
is the exact shape the pipeline exists to stop.

`facts.json` is the `AllDocument` envelope (schema version 2): `generatedAt`,
`repo`, `baseSha` (the merge base actually compared), `headSha`, `tier`,
`engine`, `languages[]` (per-language changed/parsed counts — a machine-
checkable silence detector), `coverage: full | degraded | none`, `degraded[]`
(one entry per extractor that could not run, with the reason), a `toolchain`
stamp of what actually resolved, and one payload per extractor (`facts`,
`contracts`, `constants`, `deps`, `patterns`, `coverage`). Throughout the
envelope, `null` means *nobody looked* and `[]` means *looked, found none* —
the two are never collapsed.

## `seed` — obligations

`type: bash`. Runs `lastlight-facts seed --facts facts.json --out
obligations.json --contract <obligationContract> --blocks
.lastlight/pr-review/obligations`, producing one `obligations.json` plus one
rendered markdown **block per seedable family**. The `--contract` value is
read into a shell variable and defaulted there (an absent context key renders
as the empty string, and `--contract --out` would swallow the next flag). The
phase runs `|| true` and then prints a per-family **manifest** — one log line
per block, or a loud `MISSING` line — so "the seeder wrote nothing for this
family" and "the block never reached the consumer" are two different lines
rather than one silence. It also creates `hypotheses/`.

### The seeding rule

**An obligation names both ends of a mechanism or it is not emitted.** A seed
naming only one end of a defect mechanism is worse than no seed at all, so
`introducedAt` (a quotable `path:line` plus the line's text) and `enforcedAt`
are both required, a one-ended candidate fails validation, and every drop is
counted with a reason in `dropped[]` — never silently. `enforcedAt` is typed
`{ candidates: string[], found: false }`: the literal `false` is the claim —
*nothing has been checked* — not a placeholder, and no caller can emit a
half-verified obligation by flipping it.

Every `question` is answerable by quoting one line, or by stating that no such
line exists. An obligation one abstraction level too high is discharged at
that level while the defect lives below it.

### The six families and their mint conditions

Four families mint from the envelope, under four different conditions:

- **`enforcement`** — a value is defined on one side of a boundary; who checks
  it on the other? Built from constants, two mechanisms in priority order:
  (1) the value is **hard-coded elsewhere** — every duplicate is a site a
  change to the constant does not reach — minted only for a *discriminating*
  value (a string of six or more characters; numbers and booleans recur
  everywhere for unrelated reasons, so their duplication is arithmetic, not a
  boundary); (2) the value is **referenced but never compared** — the
  candidates are the reference sites themselves. Rank rises with duplicate
  count, or with *how few* references a bound has (one or two references is
  what "nothing compares this" looks like).
- **`contract`** — a producer's exported shape moved (`changed` or `removed`;
  an `added` export has no prior shape for a consumer to have depended on, so
  it never mints); minted only when `consumersOutsideDiff` is non-empty. The
  consumer the diff did not touch is the one that reads correctly in isolation
  and is wrong in composition — what a file-by-file review structurally cannot
  see.
- **`state`** — a symbol changed in the diff (non-empty `changedHunks`) and is
  referenced at sites the diff did not touch. Ranked by the *ratio* of
  outside-diff references to total references — forty callers of which two
  were touched is a different risk from two of two, and a raw count cannot
  tell them apart. A `name-match`-resolved symbol discharges `either`
  (hypothesis-grade sites are worth asking about and not worth asserting
  from).
- **`security`** — a changed symbol in a file a scanner (`patterns`:
  opengrep + gitleaks) also flagged, with a non-empty reference set. The
  scanner hit is **corroboration on an obligation that already exists, never
  the reason one exists** — the sink half comes from the impact cone exactly
  as `state`'s does.
Two further rules are **opt-in via `review.analysis.mint`** (a comma-list;
threaded to the CLI as `seed --mint <spec>`, refused on any unknown token, and
stamped into `obligations.json` as `minting: {allInDiff, registrations}`).
They exist because every rule above requires references *outside* the diff, so
a defect wholly inside a new hunk was invisible to all four — 4 of 14
never-matched gold in the 8-case set sat in files no obligation touched:

- **`all-in-diff`** (mints into `contract`) — a changed **runtime** symbol
  (`function` | `method` | `variable` | `class`; a pure type has no runtime
  line a caller can be surprised by) whose every reference is also inside the
  diff, predicated on the **uncapped counts**
  (`referencesInDiff === referenceCount`, never the capped `references[]`
  array, where `.every(inDiff)` can be vacuously true). Candidates are the
  in-diff reference sites; zero-reference symbols mint nothing (the validation
  gate enforces the second end). Rank base 45 — between `security` and
  `state`, far below `contract`'s 90 — so the budget truncates this family
  first and displacement is auditable in `dropped[]`. The question carries its
  own anti-speculation clause: a hazard that requires a future edit is a clean
  discharge, not a finding (measured in — see the adjudicate section).
- **`registrations`** (mints into `security`) — a symbol whose body registers
  routes/hooks in a fixed order, from the tier-1-only `registrations` fact
  (`SymbolFact.registrations`; `null` = nobody looked — tier 2 and every
  pre-D2 document — and `null ≠ []` as everywhere in the package). Extraction
  is deliberately conservative: hook methods (`addHook`/`on`/…) need a
  string-literal first argument, route verbs need a `/`-prefixed literal path,
  `use`/`register` are unconstrained — so `map.get("x")` and
  `emitter.on(handler)` never mint. Module-level registrations outside any
  declaration attach to no symbol (documented limitation). The obligation
  orders the registrations and asks for the earliest line that rejects an
  unauthenticated caller.

- **`tests`** has **no mint rule**. The family is enumerated in
  `SEEDABLE_FAMILIES` and always receives a rendered block, but no seeder
  function contributes obligations for it: its evidence is the `coverage`
  extractor, which *reads* an existing report and never runs a suite, and no
  report exists unless `prepare` ran with `probeCoverage`. When no coverage
  artifact was read, the family's row in `obligations.json` is `measured:
  false` with a `notMeasuredReason`, its block renders `NOT MEASURED`, and a
  not-measured family must never be reported as "did not convert" — nor as
  clean. **The family has no survey branch**: the fan-out omits it, because a
  branch over a NOT MEASURED block is a paid pass that can only transcribe the
  block's own words. The seeder's block and `obligations.json` row keep the
  family visible to the instrument; reinstating it is a branch entry plus a
  seeder function.
- **`spec`** is not produced by the seeder at all. It is built **harness-side**
  (`review-spec.ts` / `buildSpecObligations`) from the PR body and the linked
  issues — which the code-facts package cannot see — capped by
  `maxSpecObligations`, rendered by `renderSpecObligations` under the same
  contract switch as its five siblings, and delivered inline to its survey
  branch as `{{specObligations}}`. It has no block on disk by design.

A mechanism both of whose ends sit inside the test suite takes a rank
**penalty** (enough to lose every tie), never a filter: a fixture that no
longer matches production is a real defect, so it goes to the back of the
budget, not off the list.

Candidates are ranked (family weight — `enforcement` and `contract` strongest —
plus per-family signals), truncated at `maxObligations` with the truncation
counted per dropped obligation, and the survivors are numbered `O-001…`. The
**coverage set is sealed**: every kept id is registered in
`coverageSet.selected` before any model call and the denominator is frozen, so
a run cannot grow its denominator to match what it achieved. `coverage` and
`degraded[]` are inherited from the facts envelope, never recomputed — a
seeder that recomputed coverage could report `full` over a `none` envelope.

### The rendered block and the discharge contract

`renderFamilyBlock` (`packages/code-facts/src/seed-render.ts`) emits each
family's block **from code, never from a prompt template**: the instruction
and the mechanism it governs must not be separable, so a fork that keeps the
obligations cannot drop the rule for answering them. Two block shapes exist,
selected by `ObligationsDocument.contract` — the seeder stamps the mode into
the document so the renderer, the gate and the artifact read one field and
cannot disagree. **The shipped default is `minimal`.**

Both blocks carry the same four discharge codes:

- `QUOTE` — `path:line` and the line's text that answers the question. The
  only clean discharge.
- `ABSENT` — every candidate was read and no line answers it. **That is a
  finding**: raised, anchored to the closest changed line, naming the
  mechanism.
- `PARTIAL` — answered on some paths and not others: the line *and* the gap.
- `PROBE` — settlable only by running something; recorded with what would be
  run.

Both say *"Reading a file is not a discharge. Summarising the code is not a
discharge. Quote a line, or say it is absent."* — and both end with the
over-produce instruction: a later phase probes and a stronger model
adjudicates, both can only remove, and nothing downstream can recover a
mechanism a survey declined to write down.

Under **`full`**, the prescribed hypothesis row carries a `discharge` field
(one of the four codes, machine-graded by the `discharge` gate) and a
`failureScenario` field — required on every row that claims a defect, and
explicitly `null` on a clean QUOTE, which is what makes "I looked and it is
fine" a recorded self-report rather than silence. The block lists **every** id
that needs a discharge, wrapped and never truncated (a truncated checklist
reproduces the omission it exists to prevent), points the survey at
`lastlight-facts discharge --ledger --family <family>`, and closes with one
worked exemplar row — a real `PARTIAL`, chosen because a line that *mentions*
a constant and compares nothing against it is the distinction between a
discharge and an anti-finding. The obligation's own `discharge: quote | probe
| either` requirement prints as **`expects:`**, because it is a hint about
what the question is likely answerable by, not one of the four codes, and
`either` copied into a row's `discharge` can never satisfy the gate.

Under **`minimal`**, the same codes and the same rules are stated, but the
prescribed row has no `discharge` field and no `failureScenario`, there is no
id checklist and no exemplar, the header asks for one object *per hypothesis*
rather than *per obligation*, and the per-obligation label stays `discharge:`.
The `discharge` gate correspondingly degrades (below).

**A block is never empty.** Every seedable family always gets one — an
obligations block, a "no obligations could be built, work the diff directly"
block, or a `NOT MEASURED` block — so a *missing file* has exactly one
meaning: something between the seeder and the reader broke. When coverage is
not `full`, the block says so and lists what was missed, because the absence
of an obligation about a file that was not analysed is not evidence the file
is clean.

## `survey` — five branches, one fan-out

`type: fanout` — one node running five agent sessions concurrently in **one
provisioned workspace** (one clone, one AGENTS.md, one artifact harvest, one
dispose), with one `executions` row per branch (`survey_branch_<name>`), so
per-family cost, resume and the dashboard column all survive. The families
are pairwise disjoint by construction — five append-only
`hypotheses/<family>.jsonl`, no pass reading or writing another's — so there
is no ordering constraint between them, only concurrency.

- **Model**: `{{models.review-survey}}` on every branch. **Skills**:
  `pr-review` + `code-review`; the `security` branch alone adds
  `security-review`.
- **`max_concurrent`**: `{ from: surveyConcurrency, default: 6 }` — a
  *ceiling* the run clamps again per backend: `none` and `docker` take up to
  6; `gondolin`, `smol` and `kubernetes` pin to 1 (each branch would be a
  micro-VM inside the harness process), which runs the branches as a chain,
  byte-identical to sequential phases.
- **Soft failure**: `on_branch_soft_failure: { retries: 1, then: complete }` —
  the fan-out's own key (distinct from `generic_loop.on_soft_failure`, which
  zod would strip at phase level). One degenerate turn retries once and then
  completes the branch rather than hard-failing the whole review.
- **Prompt order is fixed and load-bearing**: the shared prefix (skills,
  AGENTS.md, diff summary) goes first and the family's obligations last,
  because provider-side prompt caching is keyed on the request prefix — five
  concurrent passes share one cached prefix.

### `context_file` — the seed is attached, not addressed

Five branches declare `context_file:
.lastlight/pr-review/obligations/<family>.md`. The **harness** reads the file
— resolved against `ProvisionResult.hostAgentCwd`, the host end of the very
cwd the `seed` phase's shell wrote in — and appends its contents to the
branch's prompt. The producer and the consumer resolve against one base by
construction, and **the model resolves no path at all** (the only absolute
path a branch holds by its first turn is its skill bundle, which sits one
directory *above* the checkout — the wrong base). When the read fails, the
harness appends a loud `NOT AVAILABLE` notice instead of nothing, so a lost
seed can never be mistaken for a family with genuinely nothing to check. The
survey prompts tell each branch the same thing from the other side: the
obligations arrive attached under a fixed heading; do not go looking for them
on disk.

Each survey prompt carries the family's question in one line, the hard limits
(do not post; do not write `findings.json`; do not touch another family's
file), a family-specific catalogue of **questions an innocent quote cannot
answer** — phrased so a quoted line is the only honest answer ("quote the
enforcing line, then name the two situations it treats identically") — and the
output contract: append one JSON object per line to
`hypotheses/<family>.jsonl`, creating the file even with nothing to record, so
"surveyed and found nothing" and "never ran" stay distinguishable.

The `spec` branch has no `context_file`; its obligations render inline via
`{{specObligations}}`, with an explicit unseeded protocol when the block is
absent (record that first, then work the PR body and linked issues directly).

### The branch gates

Five branches gate on `lastlight-facts discharge --dir .lastlight/pr-review
--family <family>`; `spec` keeps `test -s hypotheses/spec.jsonl` (its
obligations never reach `obligations.json`, so the discharge gate would be
vacuous there). The gate answers one question — *did every obligation this
family owns get a recorded discharge?* — reading rows through the shared
`hypotheses.ts` reader (the family is the **filename's**, never the row's
self-report; `discharge` and `status` are both accepted,
case-insensitively). Exit codes: `0` satisfied (or the family has no
obligations, or it is NOT MEASURED — failing a family for the absence of the
thing it audits would take the run down), `3` something outstanding, `2`
nothing to grade. It is pure: it manufactures nothing, judges nothing, and
checks only that the work was *recorded*, per obligation. The prose of a row
is never scanned for obligation ids — that would restore "one line of any
content passes" through the back door.

Two deliberate degradations, one mechanism: with **no readable
`obligations.json`** (the seed phase runs `|| true` and writes nothing over a
`coverage: "none"` envelope), or under **`contract: "minimal"`** (whose block
gives a row no field to record a code in), the gate degrades to the `test -s`
floor it otherwise replaces — one parsed row passes — and says in its output
that it graded nothing. A gate an agent cannot satisfy burns every iteration
it has; a gate must never grade a contract the block did not issue. An
unknown `--family` is the opposite case and stays fatal: nothing an agent
writes can fix a misspelled flag.

On a fan-out, branch gates run **after the join and sequentially** (the
in-process backend's `runCommand` blocks the event loop), and they are
**observational**: each runs once and records `condition_met` /
`condition_not_met` on the branch's own `_check` ledger row without re-running
the branch.

`lastlight-facts discharge --ledger` is the same reading for the other
audience: a `[x]`/`[ ]` checklist of every obligation and its question,
uncapped, always exit 0 — inside an agent's bash tool a non-zero would read as
a tool failure.

### Hypothesis identity

Canonical identity is assigned **at ingest, not minted by the model**: every
row is `<family>-NNN` — family from the filename, ordinal from position in the
append-only file — via the one reader (`hypotheses.ts`) that `discharge`,
`probes`, `findings` and the attention boundary all share, so no two gates can
disagree about which claims exist. A model-declared `id` is honoured as an
**alias**, but only when it is unambiguous and shadows no canonical id: an id
two families minted resolves to *neither* and is reported as ambiguous naming
both claimants, and a canonical id always beats an alias, so a row declaring
another row's canonical name cannot capture its citations. The block tells
the survey the same rule: ids are numbered within the family, because the
passes append to disjoint files none of which can see another's, and a bare
`H-001` collides with whatever another family minted.

## `falsify` — the probe oracle

Agent phase, gated on both switches, `generic_loop` with `max_iterations: {
from: probeRounds, default: 2 }` and `on_soft_failure: { retries: 1, then:
complete }` *inside* the loop (at phase level the key is stripped and the
policy silently reverts to fail-hard). Model `{{models.review-survey}}`,
prompt `prompts/review-falsify.md`.

It is the only phase that **runs** anything, and it is a separate phase rather
than a seventh survey because a checker must not see the reasoning that
produced the claim it is checking: it reads the hypothesis *records* and the
code, never an earlier pass's transcript. It writes
`probes/verdicts.jsonl` — one verdict per probed hypothesis: `reproduced`,
`refuted`, or `unprobed` — plus transcripts under `probes/`.

The gate, `lastlight-facts probes --dir .lastlight/pr-review`, is an
existence check, not a validator: it reads no transcript and judges no
verdict. It requires a verdict for every hypothesis that must be probed
(`needsProbe: true`, or `Critical` severity regardless), and it enforces the
one rule with money on it: **a `reproduced` or `refuted` verdict must name a
transcript that exists on disk.** Evidence may be added and confidence
lowered; a hypothesis may not be dropped without a counter-transcript. The
gate is satisfiable in one pass without lying: a hypothesis that genuinely
cannot be executed against — no runner, no dependencies, no toolchain for the
language — is recorded `unprobed`, which closes the gate for it and carries
the claim forward to adjudication at lowered confidence. `unprobed` is not a
refutation and nothing downstream may treat it as one. Malformed lines are
counted, never silently skipped.

## `review` — the shipped reviewer

The unchanged two-phase reviewer's first half: skills `pr-review` +
`code-review`, model `{{models.review}}`, variant `{{variants.review}}`. The
agent does not submit anything; it writes review *content* — `{ skip?,
summary, event, findings[] }` — to `.lastlight/pr-review/findings.json`. With
the pipeline off, this phase and `post-review` are the entire workflow.

## `adjudicate` — one ranked, tiered review

Agent phase, prompt `prompts/review-adjudicate.md`, `generic_loop` with
`max_iterations: 2`, `on_soft_failure: { retries: 1, then: complete }` inside
the loop, and **`fresh_context: true`** — each iteration carries no prior
transcript, because agents shown the reasoning that produced a false report
overwhelmingly fail to reject it. The retry mechanism *is* the fresh re-run:
iteration 2 learns what is left from the ledger, not from stale plumbing.

**Model**: its own key, `models.review-adjudicate` — ranking an
already-generated set is a different task from survey discovery, so an overlay
must be able to move it without moving `review`. Unset, it falls through to
`models.review` via an explicit `{{#if}}` pair in the YAML; the pair is
load-bearing, because a bare `{{models.review-adjudicate}}` renders empty when
unset and the model resolver would then fall back to the *default* model, not
to `models.review`. Variant: `{{variants.review}}`, shared with `review`.

The adjudicator is the funnel's exit — the consumer of everything the earlier
phases append. Its contract:

- **It may re-rank, re-tier, merge, and demote a finding into the review
  body. It may DELETE only when a probe transcript refutes the claim**, named
  by path, and that path must exist. A model's judgement that a claim "feels
  weak" is not a deletion ground; demotion is the tool for doubt, and
  demotion is not suppression — a body finding is still posted.
- **First command: the ledger.** `lastlight-facts findings --dir
  .lastlight/pr-review --ledger` prints every declared hypothesis id by
  family with its obligation, severity and path, marked `[x]`/`[ ]` — the
  same code as the gate, so the checklist and the verdict cannot disagree.
  Ids already `[x]` mean a retry: keep every existing finding and add
  dispositions for the outstanding ids only.
- **A verification report is always `internal`, whatever its confidence.** A
  finding whose claim is that something is correctly handled, enforced,
  satisfied, or that merely describes the diff, exists to discharge its
  hypothesis id — it is not a weaker finding, it is not a finding, and it can
  never earn a high confidence by being certainly true. The recall rule is
  untouched: a claim that something is *wrong*, however thin, reaches the
  review.
- **A speculative hazard is always `internal`, whatever its confidence.** A
  finding whose defect exists only after a hypothetical future change —
  *"nothing prevents a future developer from…"*, *"if this is later
  renamed…"* — asserts no misbehaviour of the code in this PR; the defect
  must be reachable by the code as it stands. Measured in: the zero-gold
  canary's false positives went 7/5 → 0/1/3 when this rule (plus the
  matching clause in the all-in-diff question) landed, with the 1667 recall
  guard holding internal union 5/5.
- **An `unprobed` hypothesis reaches the review** at lowered confidence; it
  was not disproved, nobody could run anything. When `verdicts.jsonl` is
  absent, no probe ran and nothing may be dropped at all.
- **Confidence prices the defect, not the model's certainty**, calibrated in
  bands: 0.90+ a reproduced transcript or the defect visible end-to-end in
  quoted code; 0.60–0.85 a concrete mechanism with one end quoted; 0.30–0.55
  plausible but inferred; below 0.30 speculative. The posting thresholds read
  this number — a document whose every row sits at 0.75+ has silently
  disabled them.
- **Anchoring is by excerpt**: every finding carries `existingCode`, the
  verbatim quote, copied from the hypothesis's own quote; the harness derives
  the line number, so a wrong `line` costs nothing and a wrong excerpt costs
  the inline comment.
- **Output**: it rewrites `findings.json` in full and owns it — `summary`,
  `event`, the per-axis `verdict` (`spec` / `standards`, each
  `pass|fail|unknown`; a blended verdict lets the passing axis hide the
  failing one, and `unknown` is the honest non-blocking answer when a PR
  states no acceptance criteria), `findings[]` (each with `tier`, `family`,
  `obligation`, `confidence`, `hypotheses[]`, `mechanism`, `evidence[]` on
  top of the reviewer shape), and `dropped[]` entries of the form
  `{ hypothesis, refutedBy }`.

### The conservation gate

`until_bash`: `lastlight-facts findings --dir .lastlight/pr-review`. One
property, enforced mechanically because an instruction is not a mechanism:
**every hypothesis id across `hypotheses/*.jsonl` appears in `findings.json`
with exactly one disposition** — carried by a finding
(`findings[].hypotheses[]`) or deleted by a `dropped[]` entry whose
`refutedBy` names a transcript that exists on disk. In neither list fails; in
both fails; a cited id no `.jsonl` ever declared fails *distinctly*, because
inventing provenance and losing it read the opposite way. An adjudicator that
reads thirty hypotheses and writes six findings passes every schema check and
still fails this one — which is the point: silence is not a disposition;
`internal` is what a hypothesis that deserves no comment is *for*. Findings
with no `hypotheses[]` field fail nothing — those are the shipped reviewer's
own, never hypothesis-derived, counted in a note rather than audited. No
`hypotheses/*.jsonl` at all passes, with a note: the pipeline being off is
not a finding, and the gate must never fail a run for the absence of the
thing it audits. Gap output is capped at 20 named ids plus `+N more` — it
lands in the next iteration's context and must be actionable.

## `reconcile` — the conservation floor

`type: bash`, `all_done` on `adjudicate`. Reaching `max_iterations` without
satisfying the gate is not a phase failure in this engine — the loop simply
ends — so a deterministic, model-free floor closes the hole:
`lastlight-facts findings --dir .lastlight/pr-review --repair` writes every
uncovered hypothesis into `findings.json` at `internal` tier (carrying its
family, obligation, claim, `existingCode` and a path derived from
`bothEnds.introducedAt`, and no confidence), and **promotes any `dropped`
entry whose transcript does not exist back to `internal`** — an unjustified
deletion becomes a recorded non-deletion, so the floor can never be reached by
dropping everything. It never deletes, never invents a missing
`findings.json` (a fabricated summary/event is a review nobody wrote), leaves
duplicates alone with a report (guessing which disposition was meant is the
deletion it exists to prevent), is idempotent — a no-op on a run where the
model satisfied the gate — mutates the object parsed from disk rather than a
schema-stripped copy (the findings schema is deliberately loose; a strict one
would delete the evidence packet in the act of preserving the finding), and
exits 0 on every path.

## `post-review` — the attention boundary and the post

`type: post-review` — an in-process phase-type handler
(`src/workflows/handlers/post-review.ts`), the one workflow body genuinely
coupled to GitHub. The agent supplies only content; the handler supplies
every fact the harness already knows — PR number from the run context, base
ref, head SHA and diff from the pre-cloned checkout — so the model never
hand-copies metadata. It posts **one** formal review via `GitHubClient` (App
auth in production; token + `githubApiBaseUrl` against the eval mock). A
genuine failure — missing findings after a real review, or a GitHub error
that survives the body-only retry — fails the phase visibly; a legitimate
`skip` succeeds without posting.

### Whether the pipeline ran, for this run

`analysisEnabled()` consults two authorities: the process-global runtime
config (`review.analysis.enabled`), and the run context's `analysisEnabled`
key — the same key every gated phase upstream keyed off, projected by
`specContext` only when the run's own effective review config enabled the
pipeline. Either satisfies; on a deployment that never opted in the key is
absent and neither can be. When the pipeline is off, the handler also
**strips a `verdict`** from the findings document before building the review —
so a forked prompt or an improvising model cannot change the event a
non-opted-in deployment posts. Inertness is structural, not a promise about
what a prompt says.

### Anchoring

The commentable set is the merge-base (three-dot) diff — computed locally when
a checkout exists (with best-effort deepening of both the base and the PR
branch across a shallow boundary, then a two-dot superset fallback), or
fetched from the GitHub API when none does. Before anything partitions on
`line`, the **anchor cascade** derives each finding's anchor from its verbatim
`existingCode` rather than trusting the line the model counted (models quote
code well and count lines badly): (1) match the excerpt against the finding's
own file's hunks, new side then old, nearest run to the advisory line; (2)
scan the full head-side file; (3) relocate across files on a **unique** hit
anywhere in the diff — zero and multiple hits both decline, because guessing
which file a repeated excerpt came from corrupts the one piece of evidence
pointing at the real code; (4) still unlocated — the model's line stands and
off-diff demotion is the honest floor. There is deliberately no model-assisted
regeneration step: handed the wrong file's diff and a prompt demanding a code
block, a model answers with whatever looks closest, producing a comment that
looks located while pointing at unrelated code — strictly worse than
demotion. A resolved multi-line range replaces `start_line` wholesale; a
stale range paired with a fresh end line is a comment GitHub rejects.

### The boundary

The `AttentionBoundary` — `maxInlineComments`, per-family confidence
`thresholds`, `internalFloor` — exists **only** when the pipeline is on;
`undefined` routes `buildReview` through its no-boundary branch
(anchorability is the only question, no cap, no `internal` tier). Preserving
internal recall and spending a human's attention are two different budgets;
conflating them is how a recall-first reviewer becomes unreadable.

`tierFindings` splits findings across three destinations — **nothing is
dropped**; `internal` is recorded, not posted — in an order where each step is
a different question:

1. **An explicit `tier: "internal"` is obeyed unconditionally and first**
   (`InternalReason: "adjudicated"`). The conservation floor's repaired
   hypotheses carry no confidence at all; a confidence-only rule would post
   every one, turning "recorded what we could not adjudicate" into "published
   what we could not adjudicate".
2. **The clean-discharge rule** (`"clean-discharge"`): a finding whose every
   supporting hypothesis is a clean discharge — `QUOTE` with
   `failureScenario` *present and explicitly `null`* — is an anti-finding: a
   confident report that nothing is wrong, which cannot match a real defect
   by construction and which no confidence bar can catch precisely because
   its confidence is high. The strict present-and-null reading is the
   contract: a row that never wrote the key made no self-report, so its
   silence carries no information — which also makes the rule structurally
   inert under the `minimal` contract, whose rows have no field to write.
   The clean-id set is read by the handler from the sibling
   `hypotheses/*.jsonl` (same identity rules: canonical `<family>-NNN`,
   non-shadowing unambiguous aliases) and only when a boundary exists;
   `undefined` — no `hypotheses/` directory, i.e. no pipeline — passes
   through untouched. Absence of provenance is not evidence of innocence: a
   finding with no `hypotheses[]`, or citing an id that resolves to no row,
   keeps the confidence path.
3. **`internalFloor`** (`"below-floor"`): below it, recorded but not posted —
   the one tier that costs recall, so the floor is low, and a finding
   carrying *no* confidence is never affected (both bars are `confidence !==
   undefined && confidence < bar`; an absent field is not a zero).
4. **Anchorability** (`DemotionReason: "off-diff"`): GitHub cannot anchor a
   comment off the diff, so the finding goes to the body.
5. **An explicit `tier: "body"`** (`"adjudicated"`): a demotion is always
   safe to obey. (`tier: "inline"` is only ever a *request* — a document may
   not grant itself a scarce inline slot.)
6. **The family threshold** (`"below-threshold"`): the per-family confidence
   bar for an inline comment; below it, the body. Per-family rather than
   global because families convert at different rates and a single bar
   punishes the productive ones.
7. **The budget** (`"overflow"`): survivors rank by confidence × severity
   weight (critical 3, important 2, minor 1; absent confidence ranks as 1.0,
   so a document with no confidences degenerates to severity order rather
   than being silently re-ranked under every scored finding), the top
   `maxInlineComments` go inline, the rest to the body.

The review body renders demotions **grouped by reason**, each group under its
own lead-in — off-diff, below the family bar, adjudicated to the body, beyond
the budget — because three causes under one "Additional findings" heading is a
worse review to read; none of the lead-ins says "we were not sure", because
that is not what demotion means. The built review returns its `tiered` split
so the review that is posted and the disposition that is audited are the same
object, and the **body-only retry** (when GitHub rejects an inline anchor)
rebuilds from that split — inline + body only — so a POST failure can never
republish what the boundary recorded-and-withheld.

The split verdict's one effect: a `fail` on either axis stops the review
being an `APPROVE` — it becomes a `COMMENT`, never escalated to
`REQUEST_CHANGES` — and the downgrade applies to an explicit `APPROVE` too: an
agent that writes `event: APPROVE` beside `verdict.spec: "fail"` has
contradicted itself, and the safe reading of a self-contradiction is the one
that does not silently approve a change that does not do what was asked.
`unknown` never blocks.

### Idempotency and duplicate suppression

- **`atHead`**: one pass over the bot's review history answers both questions
  — if a bot review already exists on the current head SHA, the phase
  succeeds without posting (resume / re-entry cannot double-post).
- **`repeatOfLastReview`**: an `APPROVE` with no inline comments whose body is
  byte-identical to the last posted bot review is skipped — the narrowest
  rule that catches a force-push amend producing the same review twice.
  Restricted to `APPROVE` because suppressing a duplicate
  `CHANGES_REQUESTED` would flip a failing check to a passing one.
- **`staleAgainstCurrentHead`**: when the head has materially moved past the
  reviewed SHA under an automatic trigger, the post is skipped — a fresh
  review of the new head is guaranteed by the same materiality rule the
  trigger gate uses, so dropping this one loses nothing. Under `on-request`,
  or on any read failure, it posts.

### `disposition.json`

When a boundary applied, the handler writes
`.lastlight/pr-review/disposition.json` — the boundary itself plus one row
per finding: `{ tier, reason, finding }`, with `reason` the machine token
(`off-diff` / `below-threshold` / `overflow` / `adjudicated` /
`clean-discharge` / `below-floor`, `null` for inline), never prose. It is
what makes the `internal` tier an attention boundary rather than a
suppressor: *"what did we know and not say, and why?"* is answerable from the
run's own workspace. Best-effort — a failure here never stops a review
posting. The phase's ledger line reports the `internal` count even at zero
whenever a boundary applied, because "recorded, not posted" is a number
nobody can read off the review itself.

## Artifact reference — `.lastlight/pr-review/`

| Artifact | Writer | Shape |
|---|---|---|
| `facts.json` | `facts` phase | `AllDocument` v2 envelope: `baseSha` (merge base) / `headSha`, `tier`, `engine`, `languages[]`, `coverage`, `degraded[]`, `toolchain` stamp, per-extractor payloads. `null` ≠ `[]` throughout. |
| `obligations.json` | `seed` phase | v1: `contract` (`full`\|`minimal`, stamped provenance; absent reads as `full`), inherited `coverage`/`degraded`, `families[]` with `measured`/`notMeasuredReason`, `obligations[]` (`O-NNN`, both ends, question, evidence, `discharge` requirement, rank), `dropped[]` (counted reasons), sealed `coverageSet`. |
| `obligations/<family>.md` | `seed` phase | Five rendered blocks (`contract`, `enforcement`, `security`, `state`, `tests`) — never empty; `spec` has none by design. |
| `hypotheses/<family>.jsonl` | one survey branch each | Append-only; one owner per family; canonical identity `<family>-NNN` by filename + ordinal; model ids are non-shadowing aliases. Row: `id`, `obligation`, `discharge` (full contract), `family`, `claim`, `bothEnds`, `quotes[]`, `existingCode`, `failureScenario` (full contract; present-and-`null` = clean), `needsProbe`, `severity`, `confidence`. |
| `probes/env.json` | `prepare` phase | `ProbeEnv`: package manager, install/typecheck/coverage status (each distinguishing "could not" from "found nothing"), `installed` read off the filesystem, `lifecycleScripts`, durations, `degraded[]`. |
| `probes/verdicts.jsonl` + `probes/*.txt` | `falsify` phase | One verdict per probed hypothesis — `reproduced` \| `refuted` \| `unprobed` — with `reproduced`/`refuted` naming a transcript that exists. |
| `findings.json` | `review` phase, then rewritten in full by `adjudicate`; repaired by `reconcile` | `skip?`, `summary`, `event`, `verdict { spec, standards }` (each `pass|fail|unknown`), `findings[]` (reviewer shape + `tier`, `family`, `obligation`, `confidence`, `hypotheses[]`, `mechanism`, `evidence[]`), `dropped[]` (`{ hypothesis, refutedBy }`). Schema is loose: unknown fields survive the floor's rewrite. |
| `disposition.json` | `post-review` handler | `boundary` + per-finding `{ tier, reason, finding }` with machine-token reasons. |

## Config and model keys

`review.analysis.*` in `apps/server/config/default.yaml` (operator-only; a
repo's `.lastlight/` may not set any of it):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | The whole pipeline. Off ⇒ every analysis phase skips and the posted review is byte-identical to the two-phase reviewer. |
| `maxObligations` | 40 | Budget for the five facts-derived families pooled — a safety bound the ranking should never let bind; truncation is counted, never silent. |
| `maxSpecObligations` | 40 | The same bound for the harness-built `spec` family. |
| `obligationContract` | **`minimal`** (shipped) | Which block the six families are handed — `minimal` \| `full`. Stamped into `obligations.json` so renderer, gate and artifact read one field. Under `minimal` the discharge gate degrades to the `test -s` floor. |
| `mint` | `""` | The two D2 seeding rules, comma-list over `all-in-diff` \| `registrations` (see "The six families"). Empty = the baseline four rules. Appended to `seed` as `--mint` only when non-empty; the CLI refuses unknown tokens with exit 2 (a typo'd arm must not silently measure the baseline); the choice is stamped into `obligations.json`. Measured KEEP on the 8-case confirm (internal paired +10/−1, p=0.006). |
| `surveyPasses` | 6 | Carried on config; the fan-out's branch list in the workflow definition is the authority and is fixed at five (`tests` has no branch). |
| `surveyConcurrency` | 6 | Ceiling for concurrent survey branches, clamped per backend (gondolin/smol/kubernetes → 1; none/docker as written). Bounds rate-limit and memory pressure, not spend. |
| `probes` | `false` | The second gate: `prepare` + `falsify`. What it buys is a workspace with dependencies installed — tier-1 `contract` seeding on monorepos, a coverage artifact for `tests`, and executable probes. |
| `probeLifecycleScripts` | `false` | Let the install run the tree's own postinstall. Security default: off. |
| `probeTypecheck` | `false` | The repo's own `tsc --noEmit` for anchorable diagnostics. Not a CI re-run. |
| `probeCoverage` | `false` | The one step that runs a test suite; only a command the repo itself named. |
| `prepareTimeoutSeconds` | 300 | Per-step budget; the phase ceiling is the sum of enabled steps + slack. |
| `coverageTimeoutSeconds` | 900 | The coverage run's own budget. |
| `probeRounds` | 2 | `falsify` loop iterations. |
| `maxInlineComments` | 8 | The inline budget; everything past it goes to the body, never away. |
| `thresholds` | contract .35 · enforcement .35 · security .30 · state .50 · tests .60 · spec .45 | Per-family confidence bar for an inline comment; below it, the body. Tuning values, recorded per retune. |
| `internalFloor` | 0.15 | Below it, recorded in `findings.json` / `disposition.json` and not posted — the one tier that costs recall, so it is low. An absent confidence is never affected. |

Model and variant keys:

- **`models.review-survey`** — the five survey branches and `falsify`. A cheap
  high-recall model is the intended fit: survey discovery rewards recall and
  the fan-out multiplies its price by five.
- **`models.review`** — the `review` phase.
- **`models.review-adjudicate`** — the `adjudicate` phase; unset falls through
  to `models.review` via the workflow's explicit `{{#if}}` pair (a bare
  reference would render empty and fall to the *default* model instead).
- **`variants.review`** — reasoning effort, shared by `review` and
  `adjudicate`.

## The eval instrument

The pipeline's mechanism metrics are first-class eval output
(`ReviewPipelineStats`, `apps/evals/src/schema.ts`), because posted
micro-recall over a small gold set cannot detect sub-frontier movement while
obligations, discharge rates and per-family funnels have an n in the
hundreds. Every field is optional — an arm reports what it has, and a
consumer must distinguish "absent" from "zero"; the field is absent entirely
for the shipped two-phase reviewer, and every metric that reads it degrades
to posted-only rather than reporting zeros.

Per case: `obligations` + `obligationsDropped` (with reasons); `hypotheses`
and `discharged` (conservation means their difference should be 0 — when it
is not, that is a measurement, not a crash); `dischargeCodes` as a histogram
in which `none` is a column, not an omission; `cleanDischarges` (QUOTE with
no failure scenario — anti-findings, counted apart from productive QUOTEs);
`unprovenanced` (findings carrying no `hypotheses[]` — conservation runs one
direction only, and nothing about these is knowable from the funnel);
`tiers` (inline/body/internal counts, from `disposition.json`);
`probes` (attempted/succeeded/reproduced/refuted — the oracle's own hit
rate); `coverage`, `degraded[]` and the resolved `toolchain` stamp, so every
scorecard records which analysis produced it; and `byFamily`, the
obligations → hypotheses → posted → matched funnel per family.

**Internal vs posted recall.** Posted recall grades what reached the PR;
internal recall grades what the pipeline *generated*, posted or withheld —
the gap between them is the adjudicator's and the boundary's bill, which a
posted-only metric cannot see. `internalGold` is the per-gold vector, not
just a count: index *i* is gold *i*, the value is the index of the generated
finding that matched it, `null` means never found — which is what makes
"found but withheld" and "never found" distinct facts and makes internal
union/intersection computable across repeats. `internalUngraded` records a
judge that did not run or did not parse; an ungraded internal pass is
deliberately not an internal recall of zero.

**The internal MATCH judge is claim-direction-aware**, as its own prompt: the
posted path filters praise and approvals in an EXTRACT step before matching,
but the internal path feeds `findings.json` to MATCH directly, and the
pipeline's findings include verification reports. The internal prompt
therefore adds: a finding matches a gold issue **only if it asserts the same
defect or risk** — a finding that asserts the mechanism is correctly handled,
enforced, satisfied, or merely describes the code's behaviour is a non-match
for every gold issue *even when it names the same constant, file and
mechanism*. It is a separate constant so the posted-side grader, whose
numbers are pinned, does not move.

**Repeats and bands.** `--repeats N` runs the whole arm N times as N sibling
runs — never folded into per-case means, which is what `--runs` does — so a
result is a band, not a point; `--repeat-concurrency` bounds how many repeats
run at once, and `--repeats` implies workspace preservation, because when
repeats disagree the artifacts are the only place the answer lives. Across a
band, matched gold is read three ways: the **mean**, the **union** (what the
pipeline is capable of surfacing — the ceiling sampling throws away), and the
**intersection** (what it surfaces reliably — the only part a user gets every
time). Both reads exist for the posted and the internal vectors; a case with
no vector on some repeat is absent from the set maths rather than counted as
empty.

## Measured results

Attached after each measurement campaign. The running record is
[RESTART.md](RESTART.md) §2b–§2l; the state of play after the 2026-08-24
campaign (§2l):

- **skillspro (8 cases, 25 gold), shipped config** (`minimal` + both prompt
  revisions + `mint: all-in-diff,registrations` + anti-speculation): posted
  micro-recall mean 0.400 (band 0.080), posted union 17/25, internal union
  21/25, vs the shipped two-phase reviewer's 0/25. The D2 mints are the one
  lever measured to GROW the union rather than rotate it (internal paired
  +10/−1, p=0.006).
- **Martian TS slice (10 cal.com cases, 31 gold), production model shape**:
  pipeline recall 0.581 both repeats vs baseline 0.484, paired +7/−0
  (p=0.008) — the recall claim generalised to gold the prompts were never
  tuned on. F1 ranks the pipeline 17–20 of 23 vs the baseline's 12: the
  posted volume (6.4–7.0/PR vs 3.4) is priced by F1 and the attention
  boundary is untuned — that is where the next precision work lives.
  Contamination caveat: public repo; the baseline's own 0.484-vs-0/25 gap
  against skillspro carries the classic signature.
- **Cost, production shape** (`--mode config`, Haiku surveys / Sonnet
  review+adjudicate, host sandbox): ~$2.50/case, wall clock 8–17 min at
  concurrency 2. On gondolin the survey fan-out clamps to a chain; expect
  the branch sum, not the span.
