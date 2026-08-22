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

### What WP4 inherits from WP3 — measured 2026-08-22, read this first

WP3 landed built-but-unmeasured (`9536be3b`; see
[RESTART §2b](RESTART.md)). Five things it discovered change this work package
rather than merely preceding it.

**1. `prepare` now has a SECOND, independent reason to exist, and it is bigger
than the first.** The stated reason was the coverage artifact that makes the
`tests` family live. The new one: on a bare checkout with no `node_modules`, a
tsconfig that `extends` a **bare package specifier** — `@calcom/tsconfig/react-library.json`,
`@grafana/tsconfig` — does not resolve, tsgo reports a config parsing error and
(correctly, per its rule 3) **excludes the project**. The case drops to tier 2
and `contracts` emits nothing. Measured across the 50-PR corpus: **tier-1 cases
21 → 5, contract deltas 73 → 19**, single cause, all 16 demoted cases.

> So **`contract` joins `tests` as a family that cannot seed until `prepare`
> lands**, on any repo whose tsconfigs extend a package — which is the normal
> monorepo shape. `prepare` stops being an affordance for probes and becomes a
> precondition for two of the six families.

Note what this does to the ordering argument in reverse: `prepare` installing
dependencies is also what **re-arms the memory question**, and memory is
currently **UNMEASURED** on the tsgo engine (the compiler is a child process, so
every `rss()` figure in this plan is ts-morph's). Do not carry the old numbers.

**2. The gate set is unaffected, so it will not warn you.** All eight
`skillspro` cases are tier 1 with no package-extending tsconfig. A `contract`
result measured there generalises less far than it looks, and the corpus is the
population that shows it.

**3. Hypotheses have NO CONSUMER.** WP3's non-goals exclude adjudication and any
`findings.json` write, so the six surveys append to
`hypotheses/<family>.jsonl` and **nothing reads them**. Verified on a real eval
case: 40 KB of obligations, 18+ hypotheses, `APPROVE` with **zero posted
findings** against five gold. That is WP3 behaving as specified — but it means
**no rung between here and [WP6](06-adjudicate.md) can move recall**, and WP4's
`falsify` will produce probe verdicts that also go nowhere. Decide deliberately
whether WP4 or WP6 comes next (see RESTART §2).

**4. The eval workspace is DELETED at the end of every run.** ~~`runInstance` has
a `keepWorkspace` option and **no CLI flag exposes it**~~ — **DONE 2026-08-22**:
`--keep-workspace` now reaches it, every kept path lands on the result as
`workspaceDir`, and the runner prints all of them at the end (per TRIAL, not off
the aggregate — `aggregateTrials` carries trial 1's fields through, so with
`--runs 3` the other two would have been on disk and named nowhere). Off by
default: a kept workspace is a full checkout plus, once `prepare` runs,
`node_modules`.

**5. `lastlight-facts` is not in the sandbox image.** The `facts` and `seed`
phases resolve `LASTLIGHT_FACTS_BIN` → `PATH` → `/opt/lastlight/bin/`, and only
the first of those exists on the eval host. The YAML above already spells a
`/opt/lastlight/code-facts/bin/prepare-tree.sh` path that nothing installs.
**WP2 is the blocker for switching any of this on in production**, and it is not
on the measurement path — the eval runs `--sandbox none` on the host.

### `prepare` — the affordance (cheap, no model). **BUILT 2026-08-22**

Install dependencies if they are absent. That is all.

> **What shipped, and the five places it differs from the sketch below.** The
> phase is live, inert (`review.analysis.probes: false`), and the gate is green.
> Nothing has run a model against it. Read this before reading the YAML sketch,
> which is kept for its shape and is wrong in each of these respects.
>
> 1. **It is `lastlight-facts prepare`, not a shell script.** The sketch spells
>    `/opt/lastlight/code-facts/bin/prepare-tree.sh` — a path **nothing
>    installs**, and one the eval harness could never see anyway (it runs
>    `--sandbox none` on the host). As a subcommand it resolves through §D1's
>    order like every other invocation, so the same phase works on the host and
>    in the image, and the branching is unit-tested against real trees rather
>    than living in a shell script nobody can call. `src/prepare.ts` +
>    `tests/prepare.test.ts` in `packages/code-facts`.
> 2. **It runs BEFORE `facts`, not after it.** That follows directly from
>    discovery 1 below: if `prepare` ran after `facts`, the install would arrive
>    one phase too late to make a package-extending `tsconfig` resolve, and
>    `contracts` would still emit nothing on exactly the repos this was built
>    for.
> 3. **Lifecycle scripts are OFF by default, and that cost was never priced
>    here.** This page costs `prepare` in time, money, disk and (in the
>    correction below) memory. The fifth cost is that an install runs
>    `postinstall` **from a pull request head** — arbitrary code the PR author
>    wrote, executing on the operator's infrastructure — and `pr-review`'s
>    workspace has never installed anything, so this phase is the first thing in
>    the workflow that could. Neither reason `prepare` exists needs the scripts:
>    an `extends` resolves off files on disk. `review.analysis.probeLifecycleScripts`
>    opts in; `env.json` records which it was.
> 4. **`probes` is a second switch, and the coverage run is a third.** The config
>    block below is what shipped, plus `probeLifecycleScripts` and — renamed —
>    `probeTypecheck` / `probeCoverage`. The coverage run is the one step that
>    executes a test suite, i.e. the wall-clock item §D13 deleted with `suite`,
>    bought back **only** for the `tests` family. It never guesses a command,
>    only one the repo itself named (a `coverage` / `test:coverage` script, or an
>    explicit `--coverage-cmd`) — because after a guessed fifteen-minute run that
>    produced nothing, *"no command"* and *"no artifact"* would be the same row
>    in the funnel and opposite conclusions.
> 5. **The phase timeout is a SUM, computed in `specContext`.** `timeout_seconds`
>    bounds the whole phase, so handing it the install budget would kill the
>    process part-way through a coverage run — and a killed process writes no
>    `env.json` at all, which is the one outcome this design exists to prevent.
>    `templated-number` reads a context value and cannot add, so the arithmetic
>    is in `pr-decisions.ts` and the YAML reads
>    `{ from: probePhaseTimeoutSeconds, default: 300 }`.
>
> Two gates it carries that the sketch does not. `skip_if` lists **both**
> `analysisEnabled != true` and `probesEnabled != true`: the projection already
> pairs them, but "it cannot happen because of how the projection is written" is
> a weaker guarantee than "the phase refuses", and this is the phase that
> installs a stranger's dependency tree. And the §D12 catch is at the **shell**,
> exactly as `facts` carries it — `--never-fail` is an in-process try/catch and
> cannot cover a process that dies.

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

#### The gate, read where it was free — `cal-com-10600`, 2026-08-22

`prepare`'s claim is deterministic, so it has a gate that costs no model spend:
`facts-corpus.ts --install` runs it in each worktree before `all`. One case, both
arms, one variable:

| | bare | `--install` |
|---|---|---|
| tier | 2 | **1** |
| `degraded[]` entries | 16 | **3** |
| **contract deltas** | **0** | **3** (1 added, 2 changed) |
| consumers outside the diff | 0 | **15** |
| `facts` symbols | 22, `name-match` | 15, `type-aware` |
| reference sites | **4577** | **76** |
| `all` wall clock | 5.9 s | 7.7 s |
| `all` peak RSS | 399 MB | **1626 MB** |
| `prepare` wall clock | — | 85.8 s |

**The `contract` family went from structurally impossible to populated**, which
is the claim, discharged. Three things beside it are worth more than the headline:

- **4577 → 76 reference sites.** Those are not lost references, they are the
  name-match engine's false ones — a **60× over-claim** collapsing under a type
  checker. Consistent with the measured precision table in
  `packages/code-facts/CLAUDE.md` (cal.com: 9.0% whole-repo precision), and a
  reminder that a tier-2 `facts` payload is *bigger* than a tier-1 one and worth
  far less.
- **Memory: 399 → 1626 MB, and this is the FIRST installed-tree figure for the
  tsgo engine.** The plan has been carrying `UNMEASURED` here since the engine
  swap, and every older number in it is ts-morph's. It sits well inside the 8g
  cap; it is 4× the bare figure, on one mid-sized monorepo, and it tracks repo
  size rather than diff size.
- **`prepare` costs 86 s against `all`'s 8 s.** On a first review. Every
  re-review pays zero, because the cross-run refresh is `git clean -fdx -e
  node_modules` — which is exactly why that flag exists.

**Two bugs the first two attempts found, both mine, both silent.** The run had to
be made three times, and each failure is the shape this plan keeps meeting:

1. `install: "failed"` on **every** case, because Corepack's *"about to
   download…"* confirmation prompt is not silenced by `CI=1` — and a repo that
   pins its manager through `packageManager` (the field `detectPackageManager`
   reads first, and the shape of every monorepo this phase exists for) cannot
   install without it. Fixed with `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`.
2. The strict→loose fallback **was not loose**. yarn Berry and pnpm both read
   `CI` and turn immutable installs *on*, so a bare `yarn install` re-ran the
   identical command and failed identically (`YN0028: The lockfile would have
   been modified`). A fallback bit-identical to what it falls back from is a
   second copy of the failure. Fixed with explicit `--no-immutable` /
   `--no-frozen-lockfile`; a test now asserts `loose !== strict` for every
   manager.

Both would have reported an honest `install: "failed"` in production forever, on
exactly the repos the phase was built for. **This is the argument for reading the
free instrument before buying a model one**, in its cheapest possible form.

**Not yet read: the other 49 cases.** The corpus claim — tier-1 21 → 5 and
contract deltas 73 → 19 — is a fifty-case number and this is one of them. The
full arm costs hours of wall clock and gigabytes, no money, and it is the
remaining half of AC1's evidence.

> **`prepare` also unblocks the `tests` family — measured 2026-08-21
> ([WP1b](01b-code-facts-hardening.md)), and it is a HARD ORDERING
> CONSTRAINT.** §D13 cut `mutants` for `coverage` on the grounds that coverage
> is mechanical and cheap. True — and **inert**: `coverage` *reads* an existing
> report and never runs a suite, and across all **50** corpus cases it found
> **zero artifacts**, one `degraded[]` entry per case, every time. So the
> `tests` obligation family cannot convert until `prepare` produces one.
>
> Two consequences. First, **`prepare` must emit a coverage artifact**, not just
> install dependencies — that is a scope addition to this phase, and it is the
> whole of what §D13 traded `suite` away for. Second, until it lands, a WP3 arm
> reports five live families and one that was **not measured**; label it that
> way (§D2's rule for the absent scanners), because "the `tests` family did not
> convert" and "the `tests` family had no input" are the same row in a table and
> opposite conclusions.

> **Corrected 2026-08-21, later the same day: `prepare`'s install was an
> unrecorded OOM dependency on [WP3](03-seed-and-survey.md)'s phase — and the
> selective-resolution default is what removes it.** This page costed `prepare`
> as time, money and **disk**, and that list was incomplete. It also costs
> **memory, in a different phase**.
>
> **Re-amended 2026-08-22: the cap was raised to 8g, so this is a cost note,
> not a blocker.** `--resolution changed` (now the default) keeps the installed
> case at 1.0–2.2 GB, and the tree below has room. The shape is still worth
> knowing, because it is the reason an install in one phase changes another
> phase's memory at all.
>
> `lastlight-facts all` fits the old 2 GB agent cap at 0.8–1.3 GB **only
> because the review workspace has no install** — `pr-review.yaml` has no
> install phase and the pre-clone is bare, and nothing enforced it. Peak RSS in
> `code-facts` is dominated by `node_modules`, not by `--max-files`: on a
> three-file diff of this repo, 637 ts-morph source files against **9,647** files
> the `ts.Program` actually binds, **8,947 of them under `node_modules`**
> (7,374 `.d.ts`, 78 MB of declarations). So the moment `prepare` installs
> dependencies, WP3's `facts` phase inherits an installed tree — and it inherits
> it on every re-review too, because the cross-run refresh is deliberately
> `git clean -fdx -e node_modules`.
>
> Measured on five commits of this repo, installed, at the old `--resolution
> full` default: **3699 / 3902 / 4347 / 3481 / 4430 MB**, and the 4347 is an
> **OOM — exit 134, no envelope**. That is §D12's exact failure: the phase dies,
> the run dies, `assessedHeadShaByWorkflow` is populated **from SUCCEEDED runs
> only**, and `cron-review.yaml` re-dispatches every thirty minutes forever. WP4
> would have re-opened the $1.30-an-hour loop from inside WP3's phase, by
> installing dependencies for an unrelated reason — and **the shell-level catch
> §D12 relies on would have been firing on every review** rather than never.
>
> **What removes it** is a `resolutionHost` that refuses bare specifiers into
> `node_modules` against an allow-list computed from the changed files' own
> imports (`--resolution changed`), which the same sweep measures at **1022 /
> 1274 / 1600 / 1387 / 2157 MB** — inside the cap on four of five, and at **zero
> type-fidelity cost across 499 contract entries** on the two largest commits.
> The sweep, the fidelity table and the by-construction argument are in
> [01b-code-facts-hardening.md](01b-code-facts-hardening.md) → "Where the memory
> actually goes".
>
> Two things follow for this WP. **`prepare` is no longer memory-free**: it is
> the phase that changes *another* phase's memory profile, so any change to what
> it installs is a change to `facts`' peak RSS and has to be re-measured there.
> And **AC2 gains a case**: a workspace where `prepare` succeeded must be
> exercised by the `facts` phase in the same measurement, because a bare
> workspace stops being the shape production runs in the moment this phase
> ships.

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

> **Amended 2026-08-21.** The table above is missing a column and the sentence
> "the **disk** is the real operational risk" is now only half right. Installing
> dependencies also **triples `facts`' peak RSS in a later phase** — 0.8–1.3 GB
> bare against 3.5–4.4 GB installed at `--resolution full`. See the correction
> under `prepare` above. Disk is still a real risk; it is not the only one, and
> memory is the one that ends in exit 134.
>
> **2026-08-22:** the 2 GB cap that made this urgent is gone (raised to 8g), and
> the default is `--resolution changed`, which measured 1.0–2.2 GB installed.
> Both numbers now sit inside the limit, so this is a budget line rather than an
> OOM risk.

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

### `falsify` — the oracle. **BUILT 2026-08-22**

> **What shipped.** `prompts/review-falsify.md`, the phase between `survey_spec`
> and `review`, and `lastlight-facts probes` — the loop's exit gate. Inert
> (`review.analysis.probes: false`), gate green, **no model has run against it**.
> Four things a reader needs:
>
> 1. **Verdicts go in their own file.** `probes/verdicts.jsonl`, append-only,
>    one line per probed hypothesis. `falsify` never edits a
>    `hypotheses/*.jsonl` — those are owned by the passes that wrote them, and
>    the append-only union is what makes consensus collapse impossible by
>    construction. A second round revises a verdict by appending; the gate takes
>    the last line.
> 2. **The gate mechanises the rule, and only the rule.** `probes` checks that
>    every hypothesis with `needsProbe` or `severity: Critical` has a verdict,
>    and that every `reproduced` / `refuted` names a transcript **that exists**.
>    It reads no transcript and judges no verdict — v3's five-line existence gate
>    earned the gold; v2's quote validator cost 2.4× for a worse result.
> 3. **It is satisfiable in one pass without lying.** `unprobed` closes the gate
>    with no transcript, which is the whole reason that verdict exists: a gate a
>    pass cannot honestly close will be closed dishonestly. WP3 already hit the
>    other failure — `$LL_FAMILY` was never set, so the gate tested
>    `hypotheses/.jsonl`, always failed, and the loop burned `max_iterations`
>    against a condition that meant nothing.
> 4. **Nothing reads `verdicts.jsonl`.** [WP6](06-adjudicate.md)'s `adjudicate`
>    is its consumer and does not exist. So this phase can move the mechanism
>    metrics — probes attempted / succeeded / reproduced / refuted, the oracle's
>    own hit rate — and **cannot move recall**. Stated in the phase's own
>    comment so nobody measures it expecting otherwise.

> **A latent WP3 bug this work surfaced, and it is the §D12 shape.**
> `on_soft_failure` is a **`generic_loop`** key (`schema.ts`), and all six survey
> phases declared it at **phase level**, where zod strips it. Every one of them
> was therefore running the default `{ retries: 0, then: "fail" }` — so one
> degenerate agent turn in any survey would **hard-fail the whole review**, which
> records no `assessedHeadShaByWorkflow` and hands `cron-review.yaml` something
> to re-dispatch every thirty minutes forever. It had never fired because no
> model had run the pipeline. Fixed by moving the key inside each loop; the test
> asserts the **location**, not just the value.

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

What shipped 2026-08-22 (the sketch this replaces named `typecheck`, `mutants`
and `suiteTimeoutSeconds`; `mutants` and `suite` were cut by §D13):

```yaml
review:
  analysis:
    probes: false                  # `prepare` + `falsify`. Operator-only.
                                   # OFF in prod, ON in the eval overlay.
    probeLifecycleScripts: false   # run the PR's own postinstall. A SECURITY
                                   # default: that is the author's code, here.
    probeTypecheck: false          # local tsc diagnostics (not CI duplication)
    probeCoverage: false           # the one step that runs a test suite
    prepareTimeoutSeconds: 300
    coverageTimeoutSeconds: 900
    probeRounds: 2
```

Four separate switches, deliberately. `probes` buys the affordance and the
oracle; `probeCoverage` buys the `tests` obligation family and drags a suite run
with it; `probeTypecheck` is cheap and independent of both;
`probeLifecycleScripts` is not a cost dial at all but a trust one. Conflating
them is how a plan ends up unable to tell which part earned the recall — and, in
the last case, how an operator ends up running a stranger's `postinstall`
because they wanted a contract delta.

## Acceptance criteria

> **Status 2026-08-22.** 1, 2 and 2b are **discharged in code and tested**; 3, 4,
> 5 and 6 belong to `falsify`, which is not built. What discharges 1 and 2 is
> split across two suites on purpose, because there is **no dependency edge from
> `apps/server` to `lastlight-code-facts`** and there must not be one — the CLI
> is invoked as a process resolved at run time, which is the whole reason the
> eval harness can measure this on a host that has never seen the sandbox image.
> So `packages/code-facts/tests/prepare.test.ts` owns the branching
> (`unavailable` ≠ `clean`, `absent` ≠ `produced`, a red suite's artifact still
> counts, a timeout does not trigger the lockfile fallback) and
> `apps/server/tests/workflows/pr-review-probes.test.ts` owns the wiring — the
> config → context → flag chain, the shell fallback **executed in a real shell**
> and parsed, and AC2b. The `env.json` field list is pinned as a literal in both,
> each naming the other; that is the drift guard the missing edge costs.



1. ~~A red base test suite yields a **succeeded** run and `mutants` reporting
   `degraded`, not `0 surviving mutants`.~~ **Replaced 2026-08-21**, since
   §D13 cut `mutants` and this criterion had not been updated: **`prepare`
   produces a coverage artifact the `coverage` extractor can read**, and a run
   where it does not still yields a **succeeded** run with `coverage` reporting
   `degraded` — never an empty uncovered-line list, which reads as "well
   tested". Verified on the corpus before WP4: 0 artifacts across 50 cases, so
   the current answer is honestly `degraded` on every one.
2. `prepare` failing or timing out records `installed: false`, `falsify` degrades
   to read-only reasoning, and the review still posts.
2b. **No phase re-derives `checksState`.** A test asserts the pipeline reads CI's
   verdict from the run context and never emits a finding restating it.
3. A hypothesis marked `needsProbe` and never probed reaches adjudication as
   `unprobed`, **not** dropped. Unit-test this directly — it is the BitsAI-CR
   failure mode and the most likely regression.
4. A refuted hypothesis carries its transcript.
5. **Measurement gate:** the **mechanism** metrics plus the latency number
   (§D6). Probe executions attempted / succeeded / reproduced / refuted is the
   oracle's own hit rate and is the number with real power here; micro-recall on
   the blind split is **reported** with its paired p, not gated on — three cases
   swing 33% on one finding. `1641-r2` specifically is the case to inspect by
   hand — read `sessions/<instance>/trial-1/full.jsonl`, not the scorecard.

   > **Corrected 2026-08-21 (§D6).** *"On the blind split, micro-recall improves
   > over the WP3 arm"* is below the detection floor by construction — the blind
   > split is three cases. §D6 re-expressed this gate as a mechanism gate and
   > the criterion had not been updated.
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
