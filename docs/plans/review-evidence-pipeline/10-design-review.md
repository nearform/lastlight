# Design review — 2026-08-21

**Thirteen** decisions taken in a structured review of this plan before
implementation started. Each one is recorded here rather than folded silently
into the work packages, because several **change the shape of the plan** and two
of them overturn something a work package asserts as fact. (This line said
*"Twelve"* while listing D1–D13; corrected 2026-08-21 — [README.md](README.md)
and [HANDOFF.md](HANDOFF.md) both already said thirteen.)

Where a decision contradicts a WP, **this file wins** and the WP has been
corrected in place.

## The four factual errors this review found

These were load-bearing claims that turned out to be false. They are listed
first because a reader who skips the rest still needs them.

| # | The plan said | The code says |
|---|---|---|
| E1 | WP8: the eval runs the real workflow, so *"every new phase, `prepare` and `falsify` included, exercises unmodified"* | `apps/evals/src/run.ts:461-479` defaults to `--sandbox none` (in-process, on the host); `docker`/`smol` are **rejected** because they break the in-process GitHub mock; `gondolin` needs `/dev/kvm` and `sandbox-preflight.ts` refuses on darwin. **No eval configuration on a Mac can see `/opt/lastlight/`** |
| E2 | WP3: the `spec` family is *"nearly free: the PR body, the linked issue and the changed tests are already in the run context (`renderContext` … projects them)"* | `prBody` appears **nowhere** in `apps/server/src` — it is a `TemplateContext` field that is never populated. The linked issue is not projected either; `closingIssuesReferences` exists in `github.ts:1040` but its only consumer is `repo-digest.ts` |
| E3 | WP3's survey gate: `test -s .lastlight/pr-review/hypotheses/$LL_FAMILY.jsonl` | `until_bash` **rejects** template markers (`phase-executor.ts:86-91`), and the only env injected into a phase is `LL_OUT_<PHASE>` (`:105`). `$LL_FAMILY` is never set, so the gate tests `hypotheses/.jsonl`, always fails, and the loop runs to `max_iterations` with a gate that means nothing — the dependency-cruiser failure mode locked decision 6 exists to prevent, reintroduced in the plan's own YAML |
| E4 | WP2: the sandbox carries a *"pinned toolchain"* | `sandbox-base.Dockerfile` pins gitleaks precisely (`v8.21.2`, line 97) but installs **semgrep via `pipx install semgrep`** (line 96) and **uv via `astral.sh/uv/install.sh`** (line 108). Both float today |

## The decisions

### D1 — `code-facts` ships inside the `lastlight` CLI, not only in the image

Consequence of E1. Binaries resolve `LASTLIGHT_FACTS_BIN` → `PATH` → the baked
`/opt/lastlight` path, in that order. The eval points the env var at the built
workspace bundle.

**[WP2](02-sandbox-image.md) leaves the critical path.** It stops being "the
thing that makes the tools exist" and becomes "the thing that makes the image
match the manifest" — a prod-packaging task that can land any time before the
Release. The order becomes WP8 → WP0 → WP1 → WP3 → WP4, with WP2 parallel.

Weight check, since the CLI is described as the *lean* global bin:

| | Estimated | **Measured (WP1)** |
|---|---|---|
| `lastlight` CLI today | 0.56 MB | 0.56 MB |
| `ts-morph@28` + `@ts-morph/common@0.29` | ~14.3 MB | 13.4 MB |
| `@ast-grep/napi@0.45.1` | 0.36 MB + platform binaries | 0.4 MB **+ 6.8 MB** (darwin-arm64; 7.9 MB linux-x64) |
| **Total** | **~15 MB** | **~21 MB** |

> **Corrected 2026-08-21, on landing WP1.** The estimate wrote *"+ platform
> binaries"* without sizing them, and they are a third of the total. Actual is
> **~40% above** the number this decision was taken on. The decision **stands** —
> same order of magnitude, and the alternative is a `code-facts` the eval harness
> cannot reach at all — but the corrected figure is recorded here because "~15 MB"
> was load-bearing in accepting it, and a later reader re-deriving the tradeoff
> should re-derive it from the true number.

`ts-morph@28`'s dependency list confirms it carries **no `typescript`**, so
locked decision 5 holds — and WP1 pins it with a fixture carrying a decoy
`node_modules/typescript@0.0.0-decoy` that is provably never loaded.

### D2 — Two tiers: pure-JS in the CLI, binary-backed probed at runtime

Neither scanner is installable from npm. The `opengrep` npm name is a **145-byte
empty stub** held by Aikido; the `gitleaks` npm name is an **unrelated
third-party package**. Both are really release binaries.

So `facts` / `contracts` / `constants` / `deps` (ts-morph, `@ast-grep/napi`,
knip, git) ship in the CLI and work everywhere. `patterns` (opengrep, gitleaks)
and anything needing a test runner are **probed on `PATH`** and, when absent,
emit `coverage: "degraded"` with a populated `degraded[]` — the fail-loud
contract WP1 already specifies, applied to a case it did not anticipate.

**Accepted consequence:** on an eval arm without the binaries, the `security`
family is measured with its `patterns` half missing. [WP8](08-evals.md)'s
per-family attribution must label that **"not measured"**, never "did not
convert".

### D3 — One pinned `toolchain.json`, three consumers, and a stamp

Consequence of E4, and of the eval now resolving tools from host `PATH` — which
is a **third** deviation from production, against the rule in
`apps/evals/CLAUDE.md` that *"the only deviations from production are the two we
can't do unattended"*. Taken deliberately, and contained as follows:

- `packages/code-facts/toolchain.json` is the single source of truth.
- `sandbox-base.Dockerfile` reads it as build ARGs — which **also fixes the
  floating semgrep and uv installs**, worth doing regardless of this plan.
- The eval preflight, modelled on `sandbox-preflight.ts`, checks each `--version`
  against the manifest and **refuses on a mismatch, printing the commands to
  fix it**. It never installs silently.
- **The facts envelope stamps the resolved versions** beside `coverage` and
  `degraded[]`, so every scorecard records which toolchain produced it.

Silent version drift is the failure this closes: measure rung 2 on host Opengrep
1.2, ship an image with 1.0, and the production reviewer generates a different
obligation set from the one every gate was read on. Nothing would error.

### D4 — The survey fan-out is six declared phases, not a `generic_loop`

Consequence of E3, plus: `families` has six entries and `surveyPasses` defaulted
to **3**, so half the families never ran — and the plan never said which half.
`enforcement` produced the only gold match in the investigation and could have
been one of the three that never executed.

Six `depends_on` phases need **no engine change and no [WP5](05-parallel-phases.md)**,
because the scheduler already runs ready nodes one at a time. They buy literal
`until_bash` gates (`test -s …/hypotheses/contract.jsonl` — no templating
needed), all six families, per-family `timeout_seconds`, individual ledger rows,
individual retryability, and dashboard visibility.

**Prompt layout is fixed now, not later:** the shared prefix (skill bundle,
`AGENTS.md`, diff summary) goes **first** and the family-specific obligations go
**last**, so six passes share a cached prefix. Prompt caching is provider-side
and keyed on the request prefix — sandboxes and sessions are irrelevant to it.
This is free if decided now and expensive to retrofit.

### D5 — WP5 is parked until measured latency justifies it

Concurrency buys wall-clock and moves nothing any gate in this plan reads. The
workflow YAML is **identical** sequential or parallel — turning it on later is
`maxPhasesPerRun` plus a scheduler change, with no prompt, obligation or
measurement rework. So it is purely an ordering question, and the ordering
follows the gates.

[WP4](04-probe-oracle.md) AC6 produces the latency number that would justify it.

Two carve-outs:

- **S2 and S3 land now**, independently. `appendPhase`/`mergeScratch` are
  unguarded read-modify-write and are a correctness bug under the run-level
  concurrency already shipping.
- **In-agent fan-out is recorded as the cheaper alternative to WP5.** Every hard
  blocker in WP5 — B1, D1, D2, D7 — exists *because each phase provisions its own
  sandbox against a shared workspace*. A fan-out inside one agent has none of
  them. `agentic-pi` has no subagent primitive today and that is deliberate
  (`README.md` §1: one-shot, one turn, *"the orchestrator spawns a new
  process"*), so it would be a new extension — but plausibly a smaller project
  than 5a+5b+D1+D2+D7, and far safer on the nearform host's memory profile.
  What it costs is per-family ledger rows, retryability and cost attribution.

### D6 — The gates stay on `skillspro`, with the detection floor written down

The 8-case set **cannot statistically detect an improvement short of frontier
performance.** Paired (McNemar) over 25 gold findings, keeping the baseline's one
hit and adding *k*:

| Candidate | Micro-recall | New hits | One-sided p | Two-sided p |
|---|---|---|---|---|
| 2/25 | 0.080 | 1 | 0.50 | 1.00 |
| 3/25 | 0.120 | 2 | 0.25 | 0.50 |
| 5/25 | 0.200 | 4 | 0.063 | 0.125 |
| 6/25 | 0.240 | 5 | **0.031** | 0.063 |
| 7/25 | 0.280 | 6 | 0.016 | **0.031** |

Detection floor **≈ 0.24–0.28 micro-recall** — at or above CR-Bench's GPT-5.2
(27.0%). And that is optimistic: it assumes independent gold items (they cluster
in four PRs), zero run-to-run variance (never measured), and a clean judge
(agreement 0.44–0.62).

WP3's gate as written — *"micro-recall exceeds 0.040"* — is satisfied by **one
extra finding, at p = 0.50**.

**Decision: keep `skillspro` as the gate and accept the tradeoff**, with two
required changes:

1. **The detection floor goes into [WP8](08-evals.md)**, because it is the number
   that tells a reader how to interpret every other number.
2. **WP3 and WP4 gates are re-expressed as mechanism gates**, which have real
   power because their n is in the hundreds: obligations generated and
   well-formed (~40 × 8 = 320 units); discharge rate; the per-family funnel
   obligations → hypotheses → posted → matched; and whether `1587-r2`'s O6 →
   Critical conversion reproduces mechanically. Micro-recall is still reported —
   just not gated on.

Martian tier-1 (50 PRs, wired today, one command to import) was considered as the
gate instrument and rejected on cost (~$35–120/arm vs $6–19). It remains
[WP9](09-external-validation.md)'s job.

> **The cost half of that is stale as of 2026-08-21, the decision is not.** The
> **deterministic** half of a tier-1 arm is now free and repeatable —
> `apps/evals/scripts/facts-corpus.ts` runs all 50 PRs off bare mirrors, p50
> 3.3 s and max 26.9 s per case, no model anywhere. Only the generative and
> adjudication rungs cost money. The decision stands on the **other** grounds it
> was also taken on — tier 1 is 40 non-TypeScript cases out of 50, where
> evidence coverage is **2.7%** ([08-evals.md](08-evals.md) §7), so it cannot be
> the instrument a TypeScript-first plan is gated on (locked decision 14).
> **Re-derive the $35–120 before quoting it again.**

### D7 — The `spec` axis is pulled forward as WP0

The only intervention in the plan that depends on **no** `code-facts`, **no**
ts-morph, **no** scanners, **no** image and **no** probe — and the only axis
nothing has ever tried. Confirmed by reading `skills/code-review/SKILL.md`: all
nine "what to check" items (Correctness, Contracts, Edge cases, Security,
Complexity, Duplication, Type safety, Regression risk, Test coverage, Fit) are
standards checks. v1, v2 and v3 all targeted that same axis.

**WP0 = the `spec` obligation family + #271's fix 7 (split verdict) + the `prBody`
and `closes[]` plumbing E2 shows is missing.** Lands after WP8, before WP1, as
ablation **rung 0.5** — orthogonal to every later rung, so it never confounds
attribution.

It still names both ends without violating locked decision 3: the first end is an
acceptance criterion from the issue, the second is
`{ candidates: [changed files], found: false }` from plain `git diff` — the same
shape as the `enforcedAt.found: false` seed that actually converted.

**The risk to respect:** IRIS says a one-ended seed is *actively harmful* (−3,
worse than no seed). A `spec` obligation reading *"the issue asks for rate
limiting — check that"* will degrade the arm and be misread as "the spec axis
doesn't work". The second end must come from the changed-file list, not from
prose.

### D8 — Cost and latency are measured, not budgeted in advance

No ceiling is set. The pipeline is built, run, and the numbers read from
[WP4](04-probe-oracle.md) AC6. The honest position is that the estimate is
unknowable in advance: the baseline is **$0.71/case** for one 54–68 turn phase,
and the only comparable datapoint — v3, *one* enumerator plus *one*
ledger-discharged phase — measured **~$2.4/case (≈3×)**, with 00-evidence §3
naming the cause as *"the discharge costs turns."*

Two things are decided now because they are free:

- the cache-stable prefix (D4);
- `maxObligations: 40` is a **per-PR** budget, so ~7 per family. Forty per
  *family* is the version that costs 6× v3. The seeder must make that explicit.

And one is designed in: the family set is **configurable**, so a deployment can
run three families instead of six once per-family attribution says which convert.

### D9 — `prepare` gets a disk guard, not a documentation note

`pr-review` workspaces are deliberately **not** reaped on completion
(`config/default.yaml:99-101` — kept as a warm cache, bounded only by
`retentionHours: 12` / `maxDirs: 40`). At a ~1.3 GB clone that is already ~52 GB
steady-state; `prepare` adds a `node_modules` that `sandbox/index.ts:665`
deliberately preserves across refreshes, taking it to **~90–130 GB** for npm or
yarn repos.

WP4 saw the risk and offered *"re-check the sweep bounds before enabling on a
busy instance"* — a human step, taken at the moment someone is excited about a
recall win, on a host that has already filled its disk (#106) and separately
needs an instance reset when it runs out of memory.

**Decision: a free-space precondition on `prepare`.** Below a configurable floor
it writes `{ installed: false, reason: "insufficient disk" }` and returns
success; `falsify` degrades to read-only reasoning and the review still posts.
This fits WP4's own rule that neither shell phase may fail the run.

Also: **lower `maxDirs` when `probes: true`**, and **verify the pnpm hardlink
actually lands**. `docker.ts:170-172` points every package manager at the shared
`/cache` volume including `npm_config_store_dir=/cache/pnpm`, so a pnpm repo's
`node_modules` is nearly free — *if* `/cache` and the workspace share a
filesystem. They are separate mounts. That single fact decides whether this is a
50 GB problem or a 130 GB one.

### D10 — WP7 splits in three, and recording starts now, ungated

[WP7](07-review-memory.md)'s data source does not exist until two steps after
WP7 is built. WP8 §2c calls author response *"the only ground truth that
matters"* and *"a **production** metric, read off `review_outcomes` once WP7
lands"*; WP7 AC6 concedes its own gate is unmeasurable on historical cases;
locked decision 8 keeps the pipeline off until after WP9 and a human enable. So
`repo_mechanisms` mining would land with no history to mine — **you cannot mine
history you never recorded.**

| | Scope | When |
|---|---|---|
| **7a** | `record` + `review_findings`, **not gated on `review.analysis.enabled`** | with [WP6](06-adjudicate.md) |
| **7b** | the `review_outcomes` sweep, also ungated | with 7a |
| **7c** | mining cron, `repo_mechanisms`, retrieval into `seed` | after **[R]** |

`post-review` posts findings today, so `record` can capture them today — months
of finding→outcome history accumulate before the new pipeline ever turns on. The
evidence-packet fields are optional, so today's simpler findings record fine and
get richer when WP6 lands. 7b also gives `feedback_anchors`/`feedback_signals`
(#255) their first consumer; they are analytical-only today.

Cost: the schema change lands earlier than planned — both dialects, both
generators, parity test, PGlite leg, per `apps/server/src/state/CLAUDE.md`.

### D11 — `validate-findings.js` is a conservation check

WP6 AC2 calls "may not delete without a counter-transcript" *"the v2 regression
and the most important test in the work package"* — and nothing enforced it. The
gate was described only as *"an existence-plus-schema check"*, so an adjudicator
reading 30 hypotheses and writing 6 findings would pass every gate in the plan.
That is exactly v2, which *"worked mechanically"* and cost recall anyway. A unit
test can check the plumbing; it cannot check a model's compliance.

**Every hypothesis id across `hypotheses/*.jsonl` must appear in `findings.json`
with exactly one disposition:**

| Disposition | Requirement |
|---|---|
| `inline` / `body` / `internal` | carries its `obligation` and `family` |
| `dropped` | carries `refutedBy` naming a probe transcript **that exists on disk** |

A hypothesis in neither list fails the gate. Five lines, in the spirit v3 proved
sufficient — *"a five-line existence gate is what earned the gold"* — applied to
the one invariant that killed a candidate. Silent omission becomes impossible by
construction rather than by instruction.

It is also **load-bearing for WP8**: "internal recall" and the auditable
`internal` tier (*"what did we know and not say?" is a query, not a guess*) are
not computable unless every hypothesis has a recorded disposition.

Smaller, same file: `splitFindings` (`review-poster.ts:137`) partitions on
**anchorability**, and there is **no inline cap today**. After WP6, "Additional
findings" would mean three different things — off-diff, below threshold, and
overflowed `maxInlineComments`. Split the heading or annotate each line with its
reason.

### D12 — Fail loud means loud *in the artifact*, never fatal to the run

**The most serious finding of the review.** `cron-review.yaml` runs
`*/30 * * * *`. The only thing stopping it re-dispatching a PR forever is the
`already-assessed` branch at `pr-decisions.ts:918`, and its own comment records
the incident: *"1260 review executions, 0 posted, ~$1.30/hour… this fixes the
loop, which any **ran-but-posted-nothing** outcome reaches."* The load-bearing
sentence is the next one:

> *"`assessedHeadShaByWorkflow` is populated … from **SUCCEEDED runs only** … a
> run that CRASHED records nothing here and is attempted again."*

So the sole defence against a 30-minute spend loop is **the run succeeding** —
and this plan turns one model phase into eight, plus two shell phases. Every one
is a new way not to succeed, and each re-dispatch now costs 2–3× what the
$1.30/hour incident cost.

As written, three of them were fatal:

| Phase | As written | Consequence |
|---|---|---|
| `facts` | WP1: **exit 2** when analysis can't run; `schema.ts:83` — *"A non-zero exit fails the phase"* | run fails → nothing recorded → re-dispatched in 30 min → exits 2 again → **forever** |
| six `survey` phases | `on_soft_failure` defaults to `{ retries: 0, then: "fail" }` | one degenerate turn of six kills the run |
| `adjudicate` | the D11 conservation gate | a gate that cannot pass takes the run with it |
| `prepare` / `suite` | WP4 already says neither may fail the run | **the one place the plan got this right** |

**Decisions:**

1. **`facts` exit 2 becomes a recorded fact, not a failed phase.** The wrapper
   catches the non-zero exit, writes the envelope with `coverage: "none"`, and
   returns 0. Locked decision 6's actual requirement is *"an empty obligation
   list and an unavailable analyser must never be indistinguishable"* — the
   envelope satisfies that completely. **The exit code was never what made it
   loud.**
2. **`on_soft_failure: { retries: 1, then: "complete" }` on every survey phase**,
   so five good families still produce a review when the sixth degenerates. The
   socratic explore loop already uses this pattern.
3. **The conservation gate needs a floor.** If it cannot pass within its
   iterations, write `findings.json` with every unresolved hypothesis at
   `internal` tier and continue. Post something, record everything, never take
   the run down.
4. **Test the invariant directly:** for every terminal path — degraded facts,
   failed install, timed-out probe, empty survey, unpassable gate — assert
   `assessedHeadShaByWorkflow["pr-review"]` is written.

Without this, the plan's most-repeated safety principle is also its most
expensive bug, and it presents as *"every run reports succeeded"* right up until
someone reads the bill.

### D13 — `mutants` and `suite` are cut

**Captured deliberately, because this is a removal and the reasoning must
outlive the decision.**

Three of the plan's own positions compose into a contradiction:

- WP4 calls `mutants` *"the most speculative extractor in the plan and the most
  expensive input"*; WP1 says *"if it does not earn its keep at rung 3, both it
  and `suite` are deleted rather than tuned."*
- WP1's `dynamic` section already names the cheaper replacement: *"a changed line
  covered by zero tests is a `tests` obligation with better provenance than a
  surviving mutant, and a coverage run is far cheaper than a mutation run… build
  this instead of tuning it."*
- **D6**: nothing below ~6 new matches is distinguishable from chance on 25 gold
  findings.

The `tests` family plausibly contributes one or two findings across the whole
set. That delta sits permanently inside the noise floor — so **rung 2b, the
measurement whose entire purpose is to decide whether `mutants` earns its keep,
cannot return an answer on the chosen instrument.** Building it means paying the
highest per-phase cost in the plan to obtain a number known in advance to be
unreadable.

**Coverage takes the `tests` family's place.** Cheaper (one instrumented run, not
N mutation runs); reuses `prepare`, which is being built anyway; needs **no green
baseline**, so coverage on a red suite is still valid data; and gives the same
both-ends obligation shape with better provenance — *"this changed line at
`src/auth.ts:73` is executed by zero tests"* is mechanical, where a surviving
mutant needs equivalent-mutant filtering to avoid being noise (Meta ACH: 0.79/0.47
raw, 0.95/0.96 with preprocessing).

Cutting `suite` also **deletes the longest wall-clock item in the pipeline**
(1–15 min) and the strongest operational argument against the whole thing.

**What is given up**, stated plainly: *"the PR changed this expression and no
test distinguishes it from a mutation"* is a genuinely stronger claim than
"untested line" when it fires. It is not worth a 15-minute phase and an
unmeasurable ablation rung. **If coverage shows the `tests` family converts at
all, mutation seeding becomes a well-motivated follow-on** rather than a
speculative up-front build — and this paragraph is the record of why it was
deferred rather than rejected.

Ablation rung **2b is removed**. `review.analysis.mutants` and
`suiteTimeoutSeconds` do not ship.

> **Amended 2026-08-21 ([01b](01b-code-facts-hardening.md)): the substitution is
> right and it is INERT.** The `coverage` extractor shipped with WP1 and
> **reads** a report; it never runs a suite. Across all **50** corpus cases it
> found **zero artifacts** — one `degraded[]` entry per case, every run of the
> day. So the `tests` family cannot convert until [WP4](04-probe-oracle.md)'s
> `prepare` produces one, and *producing one is now part of `prepare`'s scope*
> rather than an assumed side effect of installing dependencies. Recorded there
> as a hard ordering constraint. Until then, per-family attribution must show
> `tests` as **not measured**, per §D2's rule for the absent scanners: "the
> family did not convert" and "the family had no input" are the same row in a
> table and opposite conclusions.

### Not D14 — the resolution default is an implementation detail

**Considered and declined, 2026-08-21.** Making `--resolution changed` the
default for `code-facts` is a big enough change to peak memory that it was worth
asking whether it belongs in this file's numbering, or in
[README.md](README.md)'s locked-decision table. It does not, and the reasoning
is worth a paragraph so nobody re-asks.

The locked list has an entry criterion: decisions taken **against** the obvious
answer, or that contradict advice we would otherwise follow, and that a later
agent could quietly re-decide at real cost. Four of the fourteen are there
because they invert an instinct. This one **goes with** the obvious answer once
the numbers exist — pick the cheapest tier that loses nothing — and it is
reversible on one command line, with `full` retained and reproducing today's
document exactly. Nothing outside `packages/code-facts` depends on the tier
being `changed`; what the other work packages depend on is the *envelope fitting
the 2 GB cap*, and that dependency is recorded where it bites, in
[WP4](04-probe-oracle.md) and [WP3](03-seed-and-survey.md). Locking the tier
would also freeze a per-repo judgement: a repository where `changed` still OOMs
should drop to `none` and say so in `degraded[]`, and a locked decision naming
`changed` reads as forbidding exactly that.

**What is decision-grade is one rung down, and it is already recorded:** the
allow-list must be the **union of base and head, applied identically to both
programs**. The cheaper, more obvious implementation is per-side — compute each
program's allow-list from its own tree — and it silently rebuilds the asymmetry
behind WP1's **227 contract deltas of which one was real** (cause 1: an
asymmetric `tsconfig` between the two programs). That invariant is pinned by
tests and written up in
[01b-code-facts-hardening.md](01b-code-facts-hardening.md); it needs a test and
a paragraph, which it has, not a number in a table it would be the only
implementation-level entry in.

## Revised order

> **Superseded 2026-08-21 by locked decision 14** — see
> [HANDOFF.md](HANDOFF.md) for the current order and
> [01b-code-facts-hardening.md](01b-code-facts-hardening.md) for the
> measurement behind it. The block below is what this review decided; the
> changes since are the WP1b hardening pass, a **human decision on the 2 GB
> agent cap** ahead of WP3, and **WP1c (Stage 2 grammars) moving from a WP1
> follow-on to a WP9 dependency** — it raises the generality claim, not the
> shipping path.

```
  WP8  the instrument                    offline, no spend
   │
  WP0  spec axis + split verdict         ← NEW. rung 0.5, no infrastructure
   │
  WP1  code-facts (in the CLI)           + coverage in place of mutants
   │
  WP3  seed + six survey phases          gate: mechanism metrics
   │
  WP4  prepare + falsify                 gate: mechanism metrics + latency number
   │
  WP6  adjudicate + 7a/7b record         gate: recall flat-or-up, SNR reported
   │
  WP9  external validation               MANDATORY before any general claim
   │
  [R] release + overlay enable           ← human decision
   │
  WP7c review memory mining              needs history that 7a/7b have accumulated

  WP2  sandbox image                     parallel; before the Release
  WP5  parallel phases                   PARKED (S2, S3 land now regardless)
```

The current order (locked decision 14):

```
WP3 → WP4 → WP6 → [ship-capable on TypeScript]
  → WP1c Stage 2 grammars (scoped) → WP9 → [R] release → WP7c
  ;  WP2 parallel  ;  WP5 PARKED
```

> **Corrected 2026-08-21:** the leading `memory decision (2 GB cap) →` is gone.
> It was settled by measurement rather than taken — see
> [01b-code-facts-hardening.md](01b-code-facts-hardening.md) → "Where the memory
> actually goes". The paragraph above still describes it as a pending human
> decision because that is what this review decided; it is no longer true.
