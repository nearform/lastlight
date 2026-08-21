# WP4 — `probes` and `falsify`, the executable oracle

**Goal.** Give the reviewer the capability the `1641-r2` failure named: write a
minimal reproduction, **run it**, and keep the transcript as evidence.

**Depends on:** [WP3](03-seed-and-survey.md).

**This is the step change.** Everything before it improves *which questions get
asked*. This changes *how a question can be settled*.

## The evidence, restated

`1641-r2` is the case. Every mechanical fix worked — the enumerator surfaced the
right package, the ledger was written, the model **opened the plugin source and
the shim** — and it concluded *"All plugin usages are verified at source… the
Proxy restores the removed `context.getFilename()` API"*. It stood at the defect
site and judged the buggy shim correct.

The human settled the same question in one line: *"Verified on this branch: with
that change the probe file reports correctly."* They **ran ESLint with a probe
file**. The `TypeError` is deterministic.

The gold itself — ESLint 10 freezes rule contexts, and a `get` trap returning
`value.bind(target)` violates the Proxy invariant for non-writable own
properties — is expert-level JS semantics that may stay out of reach for any
model, at any prompt. **Running it costs 30 seconds.**

External support: AnyPoC turned ~2700 candidate reports into 121 new bugs, 108
developer-confirmed, by making validation mechanical, with a **Checker that
re-executes in a fresh environment with no access to the generator's context and
is instructed to trust its own execution over the generator's claims**. Baseline
agents fail to reject 96% of false reports; AnyPoC rejects 85–96%.

## First: this is not a second CI, and an earlier draft of this page was wrong

The earlier design had one `probes` phase that installed, typechecked **and ran
the whole test suite**, and justified it partly as *"a red base suite is a fact
the adjudicator needs"*. That justification is wrong and the phase was too big.

**CI already ran.** `checksState` (`passing` / `failing` / `pending` / `none`)
and, when failing, `ciSection` (job, step, log excerpt) are already projected
into the run context by `renderContext` and consumed by
`skills/pr-review/SKILL.md` §4. Re-deriving red/green is pure duplication, and it
is slower and less complete than the thing it duplicates — CI runs a matrix, we
run one machine.

So separate the *information* from the *capability*:

| Want | Source |
|---|---|
| "does it build / do tests pass" | **CI.** Already in context. Never re-derive it |
| a tree where a probe **can be executed** | a dependency install — the affordance |
| a green suite to mutate against | a suite run — needed by `mutants` **only** |

That splits the old phase in two, with very different price tags.

### `prepare` — the affordance (cheap, no model)

Install dependencies if they are absent. That is all.

```yaml
  - name: prepare
    label: Prepare probe environment
    type: bash
    timeout_seconds: { from: review.analysis.prepareTimeoutSeconds, default: 300 }
    skip_if: "review.analysis.probes == false"
    command: /opt/lastlight/code-facts/bin/prepare-tree.sh
```

Usually near-free: `pr-review` is in `PER_TARGET_REUSE_WORKFLOWS`, so the
workspace is keyed by (repo, PR) and the cross-run refresh is `git fetch` +
`reset --hard` + **`git clean -fdx -e node_modules`** — dependencies survive.
A first review on a PR pays the install; every re-review does not. The shared
`/cache` package-download volume (issue #107) means even the first one reuses
already-fetched tarballs.

Typecheck is **optional** and cheap, and unlike the suite it is not duplication:
CI reports a pass/fail summary, `tsc` on the local tree gives per-file, per-line
diagnostics that can be attached to a specific hypothesis. Gate it separately
(`review.analysis.typecheck`).

Write `.lastlight/pr-review/probes/env.json`
(`{ installed: true|false, packageManager, typecheck: "clean"|"errors"|"skipped",
durationMs }`) so downstream phases read a fact, not a substring of stdout.

### ~~`suite` — only for mutation seeding~~ — CUT

> **Cut 2026-08-21 ([10-design-review.md](10-design-review.md) §D13),** together
> with `mutants`, its sole consumer. `review.analysis.mutants` and
> `suiteTimeoutSeconds` do not ship, and ablation rung 2b is removed. Coverage
> — which reuses `prepare` and needs no green baseline — takes the `tests`
> family's place. This deletes the longest wall-clock item in the pipeline. The
> section is kept below for whoever revisits mutation seeding once coverage has
> shown whether the `tests` family converts at all.

### ~~`suite` (retained for reference)~~

A full test run exists for exactly one consumer: StrykerJS needs a green baseline
to mutate against, and *"0 surviving mutants"* from a suite that did not run is
the fail-loud violation ([WP1](01-code-facts.md)).

So it is gated on `mutants`, not a general prerequisite:

```yaml
  - name: suite
    label: Baseline suite (mutation gate)
    type: bash
    timeout_seconds: { from: review.analysis.suiteTimeoutSeconds, default: 900 }
    skip_if:
      - "review.analysis.mutants == false"
      - "scratch.probeEnv.installed == false"
```

`mutants` is the most speculative extractor in the plan and the most expensive
input. **Both default off.** If the rung-3 ablation does not show the `tests`
obligation family earning its keep, this phase is deleted rather than tuned.

### No phase may fail the run — and that now means *every* phase

A red suite, a failed install, an expired timeout — all record a fact and
continue. Use `skip_if` downstream, never `on_output.action: fail`. A red run
posts `messages.on_failure`, offers a Retry that cannot succeed, pollutes the
cost stats and defeats the SHA dedup — the reasoning already recorded for
`skip_if` in `src/workflows/CLAUDE.md`.

> **Generalised 2026-08-21 ([10-design-review.md](10-design-review.md) §D12).**
> This section was right and was applied only to the two cheapest phases. It now
> governs **all** of them, because `cron-review.yaml` runs `*/30 * * * *` and
> `assessedHeadShaByWorkflow` is populated **from succeeded runs only**
> (`pr-decisions.ts:918`, which documents the 1260-execution / $1.30-an-hour
> loop). The sole defence against a thirty-minute spend loop is *the run
> succeeding*, and this plan turns one model phase into eight.
>
> - `facts` exit 2 → the wrapper writes `coverage: "none"` and returns 0.
> - Every survey phase carries `on_soft_failure: { retries: 1, then: complete }`,
>   so five good families still produce a review when the sixth degenerates.
> - The `adjudicate` conservation gate has a **floor**: if it cannot pass within
>   its iterations, write `findings.json` with every unresolved hypothesis at
>   `internal` tier and continue. Post something, record everything.
> - **Test it directly:** for every terminal path — degraded facts, failed
>   install, timed-out probe, empty survey, unpassable gate — assert
>   `assessedHeadShaByWorkflow["pr-review"]` is written.

### What this actually costs

Worth stating precisely, because "time and money" conflates two different things:

| | `prepare` | `suite` | `falsify` |
|---|---|---|---|
| **Model spend** | **none** — `type: bash` | **none** | agent turns — the real money |
| **Wall clock** | 0–3 min (usually 0; warm `node_modules`) | 1–15 min, repo-dependent | 1–5 min |
| **Disk** | `node_modules` per PR workspace | — | probe files (KB) |

The money in WP4 is `falsify`, not the shell phases. The **disk** is the real
operational risk: installing dependencies on every reviewed PR multiplies
workspace size, and prod has hit 100% disk before (issue #106). Re-check the
sweep bounds (`retentionHours: 12`, `maxDirs: 40`) before enabling on a busy
instance, and treat `prepare` as the thing that makes #106's reaping load-bearing
rather than precautionary.

### If we ship it off by default, what does quality lose?

Stated honestly, because this decides whether the work package is worth building
at all.

**Lost outright:**

- The `tests` obligation family (mutation seeding) — gone with `mutants`.
- The `1641-r2` class: defects settled only by execution. That is **1 of 25**
  gold findings in our set, and it is the one no amount of prompting reached.
- Transcript-backed evidence, so Critical findings carry reference/contract
  evidence but no reproduction. Under [WP6](06-adjudicate.md)'s calibration that
  means lower confidence → more findings demoted to the review body → **less
  inline signal, but nothing lost from the review**.

**Not lost — and this is most of the gold:**

The impact cone, contract deltas, constants-minus-literals, the `spec` axis, repo
memory, and — importantly — the **staged dependency source** from `deps`
([WP1](01-code-facts.md)). An earlier draft claimed the `1667` class needed the
oracle; it does not. `1667` was an **affordance** failure (no `node_modules`, so
"open the library source" was structurally impossible), and `deps` fixes that
with `npm pack` at the locked version, with no install and no test run.

**So probes-off is a coherent, degraded mode, not a broken one** — and the
difference is a measurable ablation rung, not a judgement call. Rung 1 → rung 2
in [08-evals.md](08-evals.md) *is* this question. **Do not decide it now; decide
it on the number.**

Default posture: **off in production, on in the eval harness**, so we buy the
measurement without buying the prod bill. If the delta is small, this work package
ships permanently off and the plan loses very little.

Both `prepare` and `suite` are **operator-only** in the repo-config bounds — they
spend the operator's compute and disk, so they sit with `fix.gateTimeoutSeconds`
rather than with the add-only leaves a repo may raise.

### `falsify` — the oracle

For every hypothesis with `needsProbe: true` (and every `severity: Critical`
regardless), write the smallest artefact that settles it and run it:

| Question shape | Probe |
|---|---|
| library/framework semantics | a probe file + the real tool (`eslint`, `tsc`, the framework's own runner) |
| a caller contract | a minimal call through the changed symbol |
| a boundary the PR moved | the same input against **base** and **head** — differential execution |
| an unhandled input | the input, through the real entry point |

Transcripts land in `.lastlight/pr-review/probes/<hypothesis-id>.txt`, and the
loop's exit condition is a **five-line existence gate**, not a validator:

```yaml
  - name: falsify
    label: Falsify
    prompt: prompts/review-falsify.md
    model: "{{models.review-survey}}"
    skip_if: "review.analysis.probes == false"
    generic_loop:
      max_iterations: { from: review.analysis.probeRounds, default: 2 }
      until_bash: |
        /opt/lastlight/code-facts/bin/check-probes.sh   # every needsProbe id has a transcript
```

v3's lesson 3 is the sizing argument: a five-line existence gate is what earned
the gold; v2's full quote validator was overkill and cost 2.4×.

### Differential execution is the shape to prefer

A PR reviewer has something bug-repair does not: **two executable versions of the
program.** Where a probe can be run against base *and* head, prefer that — the
output is a behavioural delta rather than an assertion, and the base tree is
already available (`ensureBaseAvailable` fetches `origin/<base>` as a real ref
for exactly this reason).

Then ask the question the memo gets right: *is this changed behaviour explained
by the PR's intended specification?* A difference is not automatically a bug —
which is why the answer is routed to the `spec` family
([WP3](03-seed-and-survey.md)) rather than posted.

## The rule that keeps this from becoming v2

> **`falsify` may add evidence and lower confidence. It may not delete a
> hypothesis without a counter-transcript.**

BitsAI-CR is the reason: verification bolted onto a conservative generator
raised precision 54.5 → 67.1 and **cut recall 45.5 → 39.8**. v2 built exactly
that and reverted. The oracle here is safe **only** because
[WP3](03-seed-and-survey.md) re-tuned generation to over-produce first — that is
the ordering both PropertyGPT and Meta ACH share, and the ordering v2 got
backwards.

Concretely: a hypothesis whose probe **passes** (no defect reproduced) is marked
`refuted` **with the transcript attached** and is dropped. A hypothesis that
could not be probed — no runner, timeout, tier-3 language — is marked
`unprobed` and **survives to adjudication with lowered confidence**. Silence is
never a refutation.

## Context isolation

`falsify` runs as its own phase and reads the **hypothesis record and the code**,
not the survey's transcript. That is AnyPoC's "Checker with no access to the
generator's context, instructed to trust its own execution over the generator's
claims", implemented with the mechanism we have (a separate phase; or a
`fresh_context` loop iteration). It does **not** require per-phase tool
allow/deny — that gap already killed one design and is not needed here
([00-evidence §6](00-evidence.md)).

## Config

```yaml
review:
  analysis:
    probes: false                  # `prepare` + `falsify`. Operator-only.
                                   # OFF in prod, ON in the eval overlay.
    typecheck: false               # local tsc diagnostics (not CI duplication)
    mutants: false                 # implies `suite`; the expensive tail
    prepareTimeoutSeconds: 300
    suiteTimeoutSeconds: 900
    probeRounds: 2
```

Three separate switches, deliberately. `probes` buys the oracle; `mutants` buys
the `tests` obligation family and drags a full suite run with it; `typecheck` is
cheap and independent of both. Conflating them is how a plan ends up unable to
tell which part earned the recall.

## Acceptance criteria

1. A red base test suite yields a **succeeded** run and `mutants` reporting
   `degraded`, not `0 surviving mutants`.
2. `prepare` failing or timing out records `installed: false`, `falsify` degrades
   to read-only reasoning, and the review still posts.
2b. **No phase re-derives `checksState`.** A test asserts the pipeline reads CI's
   verdict from the run context and never emits a finding restating it.
3. A hypothesis marked `needsProbe` and never probed reaches adjudication as
   `unprobed`, **not** dropped. Unit-test this directly — it is the BitsAI-CR
   failure mode and the most likely regression.
4. A refuted hypothesis carries its transcript.
5. **Measurement gate:** on the blind split, micro-recall improves over the WP3
   arm. `1641-r2` specifically is the case to inspect by hand — read
   `sessions/<instance>/trial-1/full.jsonl`, not the scorecard.
6. Wall-clock and cost recorded per case; the arm stays inside ~2–3× the
   baseline.

## Non-goals

- **No mutation-based findings posted directly.** A surviving mutant is an
  obligation, not a finding.
- **No test generation as ground truth.** Generated tests are probes. They can
  encode stale assumptions about the old implementation; a behavioural
  difference is evidence, and the `spec` family decides whether it is intended.
- **No fuzzing, no property-based testing.** Both are attractive and both are a
  separate project.
- **No CI re-run.** We do not restate what CI already said (`checksState` /
  `ciSection` are already in the run context).
