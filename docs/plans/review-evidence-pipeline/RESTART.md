# RESTART — pick this plan up in a new session

Say *"restart the plan in `docs/plans/review-evidence-pipeline/`"* and start
here. This file is the operational entry point: what state the tree is in, what
to run to prove it is sane, what is next, and how to drive sub-agents on it
without repeating a mistake that has already been made once.

For *why* any of it is shaped this way, read [README.md](README.md) (thesis +
locked decisions), then [HANDOFF.md](HANDOFF.md) (traps + human sign-off), then
[01b-code-facts-hardening.md](01b-code-facts-hardening.md) (what measurement
found, and why several earlier claims in this plan are now marked corrected).

## 0. Before anything else — is the work committed?

```bash
git -C ~/work/lastlight log --oneline -1
git -C ~/work/lastlight status --porcelain | wc -l
```

**As of 2026-08-22 everything through WP3 is committed**, ending at `2563ca41`.
If `HEAD` is that and the tree is clean, skip to §1.

**WP4 may not be.** If `HEAD` is `2563ca41` and the status count is large, the
uncommitted tree is WP4 — `prepare`, `falsify`, the `probes` gate, the seven
config switches, `--keep-workspace`, the corpus `--install` arm, and the doc
updates in this folder. It is gate-green (24/24, 3612 core tests, 486 in
code-facts); §2c says what it measured.

## 1. Prove the tree is sane — three commands, ~2 minutes

```bash
cd ~/work/lastlight
pnpm turbo run typecheck test build            # expect 24/24 tasks, 486 code-facts tests
pnpm --filter lastlight-code-facts selfcheck   # real-commit census; expect 31 of 31 analysed, exit 0
cd ~/work/lastlight/apps/evals && npx tsx scripts/facts-corpus.ts --profile smoke \
  --dataset ~/work/lastlight-evals/datasets/pr-review/instances.json \
  --cache   ~/work/lastlight-evals/.eval-cache                      # 8 cases
```

The corpus scripts live in **`apps/evals/`** (this monorepo) while the 5.9 GB of
bare mirrors and the gitignored `instances.json` still live in the standalone
`~/work/lastlight-evals` checkout, hence the two flags. `lastlight-core#test`
has flaked twice under parallel load and passed standalone both times — see the
load-sensitive tests in §4 before concluding a red gate means a real break.

`selfcheck` is the fastest honest signal: it runs `all` against a real commit of
this repo and exits non-zero on a `removed` delta with no deletion in the diff,
on too many phantom-capable deltas, or past 90 s. It is deliberately **not** in
CI — `actions/checkout` defaults to `fetch-depth: 1`, so `HEAD~1` does not exist
on a runner.

**Environment the measurements assume.** `opengrep` 1.27.1 and `gitleaks` 8.21.2
must be on `PATH` (see HANDOFF sign-off item 10) or the whole `patterns` family
is stamped `missing` and silently contributes nothing. `lastlight-facts
toolchain` prints what actually resolved. The 50-PR corpus needs the bare
mirrors under `~/work/lastlight-evals/.eval-cache/repos/` (~4.9 GB) and the
gitignored `datasets/pr-review/instances.json`; regenerate with
`scripts/import-martian.ts` rather than assuming they are present.

## 2. What is next

The decision recorded as locked decision #14 is **TypeScript-first**: prove the
pipeline helps on TypeScript before buying polyglot. WP3's and WP4's gates are
read on the `skillspro` set, which is TypeScript; grammars move the *Martian*
corpus, so they raise the generality claim rather than the shipping path.

```
✅ the 2 GB agent-cap decision — RETIRED. cap raised to 8g, not engineered around
✅ the FACT ENGINE          — ts-morph replaced by the TS 7 API (docs/plans/fact-engine/)
✅ WP3 BUILT (9536be3b)     — seeder, six survey phases, prompts, skills; inert,
                              gate green. Its gate was read where it was free.
✅ WP4 BUILT                — `prepare` + `falsify` + the `probes` gate + the
                              seven switches + `--keep-workspace`. Inert, and
                              NO MODEL HAS RUN AGAINST IT. §2c
✅ WP4a's free gate, n=1    — cal-com-10600: tier 2→1, contracts 0→3. §2c
             the same gate at n=50   ← hours of compute, no money
             WP4b's arm             ← model spend, and NO CONSUMER until WP6
             WP6  adjudicate + 7a/7b          ← the only rung that can move RECALL
   ── ship-capable on TypeScript here ──
             WP1c Stage 2 grammars (scoped)   ← generality, not shipping
             WP9  external validation         ← deterministic half is now free
             [R]  release → WP7c
WP2 parallel · WP5 PARKED
```

### The engine swap — 2026-08-22, after WP1b and before WP3

`packages/code-facts` no longer uses `ts-morph`. The type-aware tier runs on
`typescript@7.0.2`'s `unstable/sync` API (the Go compiler). The full argument,
the gates and the module-by-module end state are in
[`docs/plans/fact-engine/`](../fact-engine/README.md); what a WP3 reader needs:

- **Fidelity was the gate, and it held.** Entity sets compared as SETS on this
  repo's `HEAD~1..HEAD`: `facts` 44 = 44 symbols, 138 = 138 reference sites,
  contract keys 13 = 13, `consumersOutsideDiff` 32 = 32. Speed 3.2x (`facts`)
  and 2.6x (`contracts`); 9.6x / 6.9x against the old `--resolution full`.
- **Mechanisms deleted, not merely made faster.** `--resolution` entire,
  `--max-projects`, the cross-project file budget, `selectNeighbourhood`,
  `globCandidates`, and the second worktree for the base side. `project.ts`
  1252 → 296 lines. If a doc in THIS folder still reasons about a file budget
  or a resolution tier, it is describing something that no longer exists.
- **Bug 4 is fixed at the root**: a file under no tsconfig gets an inferred
  project with a working checker. On a real commit, 30 of 31 → **31 of 31**.
- **`--max-files` SURVIVES**, but it now means the ceiling on the repo-wide
  literal scan and the tier-2 name index (`DEFAULT_MAX_SCANNED_FILES` in
  `syntactic.ts`), never a compiler budget. It still backs the "an absence claim
  over a truncated file set is unsound" guard.
- **Envelope is `version: 2`**; `engine` is `["tsgo","ast-grep","none"]`. Safe
  only because `code-facts` still has **zero call sites in `apps/server`** —
  WP3 is what ends that, so schema changes get expensive from here.

**Two open items WP3 inherits.** Neither blocks it; both are the silent kind.

1. **Memory is UNMEASURED for the new engine, and the old figures do not
   transfer.** Any `process.memoryUsage.rss()` reading now excludes the compiler,
   which is a child process. Child-inclusive it is roughly 600 MB per open
   snapshot plus 200 MB of node. Do not quote this plan's older peak-RSS numbers
   against the current engine — they are ts-morph's.
2. **The base view diverges from the old one when the working tree is dirty.**
   The overlay serves base blobs for CHANGED files and falls through to the real
   filesystem for everything else; the old worktree served base blobs for
   everything. They agree exactly when the checkout is clean at head. Measured:
   a `languageBreakdown` delta the worktree reported and the overlay did not,
   because `schema.ts` was modified in the tree but absent from the changed set.
   This widens the caveat already in §4 below and wants a loud `degraded[]`
   entry on a dirty tree.

**Two bugs the swap surfaced, both fixed or pinned.** `.es6` panics the compiler
child and takes the whole snapshot with it, so it is kept analysable for
ast-grep and never handed to the compiler. And an unexecutable compiler binary
**wedges** rather than crashes — `spawnSync` had not returned after 50 s against
a 60 s timeout — which is worse than an OOM for a workflow phase, because it
burns the budget and fails anyway. Narrowed by a pre-flight, **not closed**;
§D12's shell-level catch stays mandatory.

**One thing to know before running `selfcheck` on your own work-in-progress:**
`facts`/`contracts` read head from the filesystem, so on a dirty tree the
default `HEAD~1..HEAD` invocation compares old blobs to new files and is
meaningless. Run it against a clean clone, or a `git stash create` snapshot.

Two gates are now available that this plan did not originally have, both free of
model spend, so use them *before* burning budget on a rung:

- **`pnpm selfcheck`** — does the substrate still behave on a real commit?
- **evidence coverage** (`apps/evals/scripts/facts-evidence.ts`) — an upper bound
  on recall attributable to code-facts as a seeder. If the envelope never names
  the identifier, no seeder can produce an obligation about it. Always read it
  with all three denominators and the candidate pool beside it; see
  [08-evals.md](08-evals.md).

## 2b. WP3 is BUILT and UNMEASURED — what the arm still needs

Landed 2026-08-22 in `9536be3b`, inert (`review.analysis.enabled: false`), full
gate green. What is built: `lastlight-facts seed`, the six survey phases in
`pr-review.yaml`, six prompts, the two skill rebalances, and 46 tests.
**No model has run against it.** Three things a reader needs before starting:

**The gate was read where it was free, and the arm was stopped.** 135 obligations
across all 8 gate cases, 0 dropped, at zero model spend — four of AC5's five
mechanism metrics, at a better n than an arm would have given. The re-baseline
(`2026-08-22_092611`, Haiku, pipeline OFF, $1.91, avgF1 **0.229**) is the
comparator from here. The pipeline-ON arm was killed after the baseline: its only
remaining metric is discharge rate, which must be re-measured after WP6 changes
what the surveys feed, and its recall columns are pinned at zero by WP3's own
non-goals. See [03](03-seed-and-survey.md) §"The WP3 gate, as far as it can be
read". **Read every free denominator to exhaustion before buying a model one.**

1. **The comparator is dead.** `apps/evals/src/run-instance.ts` excluded
   `pr-review` from `prContextPatch` — deliberately, so enriching its context
   would not silently move historical judge-scored numbers. The cost of that
   exclusion is that `renderContext` never runs for the tier, so `analysisEnabled`
   is never set and **all eight WP3 phases skip**; WP0's `{{specObligations}}`
   was equally unmeasurable there and nobody had noticed. Lifting it is what makes
   the arm possible, and it means **every pr-review number from before 2026-08-22
   sits on a different context**. `2026-08-20_074355` is no longer a valid
   baseline — re-run it rather than diffing across that boundary.
2. **Both arms run on Haiku 4.5** (operator decision, 2026-08-22). Not a cost
   compromise: Haiku beats Sonnet 4.6 on review recall on two independent evals
   (41.2% vs 22.1%), and it is what `models.review-survey` names. Baseline
   $5.65/8 cases on Sonnet with one phase; WP3 adds eight, so ~7× the agent work.
3. **`LASTLIGHT_FACTS_BIN` must be set** to the built `packages/code-facts/dist/cli.js`.
   The eval runs `--sandbox none` on the host and `lastlight-facts` is not on
   `PATH` there. It is **not in the sandbox image either** — that is WP2, and
   until it lands the pipeline cannot be switched on in production, only measured.

## 2c. WP4 is BUILT — what it measured, and what it still owes

**The ordering question below was decided: WP4.** The half of it that is built
is `prepare`, and it was built first for a reason worth keeping — *"read every
free denominator to exhaustion before buying a model one"*. `prepare` is
model-free and its claim is deterministic, so there is a gate for it that costs
nothing but compute.

**What landed, inert, gate green (24/24 turbo tasks, 3598 core tests, 467
code-facts tests):**

- **`lastlight-facts prepare`** (`packages/code-facts/src/prepare.ts`) — package
  manager detection, install, optional typecheck, optional coverage run, and
  `.lastlight/pr-review/probes/env.json` validated against `ProbeEnvSchema`.
  A subcommand rather than the `/opt/lastlight/code-facts/bin/prepare-tree.sh`
  the plan spelled, because **nothing installs that path** and the eval host —
  `--sandbox none` — could never see it anyway.
- **The `prepare` phase**, FIRST in `pr-review.yaml`, gated on **both**
  `analysisEnabled` and `probesEnabled`, with the same shell-level §D12 catch
  `facts` carries.
- **Four config switches**, operator-only like the rest of the block:
  `probes`, `probeLifecycleScripts`, `probeTypecheck`, `probeCoverage`, plus
  `prepareTimeoutSeconds` / `coverageTimeoutSeconds` / `probeRounds`.
- **`lastlight-evals run --keep-workspace`** — WP4's inherited item 4. Every
  kept path lands on the result as `workspaceDir` and is printed at the end.

**Three decisions taken that the plan did not contain**, each written up in
[04](04-probe-oracle.md):

1. **Lifecycle scripts are OFF.** The plan priced `prepare` in time, money, disk
   and memory. The fifth cost is that an install runs `postinstall` **from a pull
   request head** — the author's code, on the operator's machine — and
   `pr-review`'s workspace has never installed anything, so this phase is the
   first thing in the workflow that could. Nothing `prepare` exists for needs
   them: an `extends` resolves off files.
2. **The coverage run is its own switch**, because it is the wall-clock item
   §D13 deleted with `suite`, bought back only for the `tests` family. It never
   guesses a command — only one the repo itself named.
3. **The phase timeout is a SUM** computed in `specContext`, not the install
   budget. A phase killed part-way through a coverage run writes no `env.json`
   at all, which is the one outcome the design is against.

**`falsify` also landed**, with `lastlight-facts probes` as its exit gate:
verdicts go to their own append-only `probes/verdicts.jsonl` (never into a
`hypotheses/*.jsonl`, which the surveys own), and the gate mechanises exactly one
rule — a `reproduced` or `refuted` verdict must name a **transcript that
exists**. `unprobed` closes the gate with no transcript, deliberately: a gate a
pass cannot close honestly will be closed dishonestly, and WP3 already hit the
other failure once.

### The gate, read where it was free — n = 1, and it reads

`scripts/facts-corpus.ts --install` runs `prepare` in each worktree before
`all`. On `cal-com-10600`, one variable, both arms:

| | bare | `--install` |
|---|---|---|
| tier | 2 | **1** |
| **contract deltas** | **0** | **3**, with 15 consumers outside the diff |
| `degraded[]` | 16 | 3 |
| reference sites | **4577** (`name-match`) | **76** (`type-aware`) |
| `all` peak RSS | 399 MB | **1626 MB** |
| `prepare` wall clock | — | 85.8 s (first review only) |

The claim is discharged at n = 1: `contract` went from structurally impossible to
populated. Two readings beside it, both worth carrying:

- **4577 → 76 is not lost references, it is a 60× over-claim collapsing.** A
  tier-2 `facts` payload is BIGGER than a tier-1 one and worth far less.
- **1626 MB is the first installed-tree memory figure for the tsgo engine.**
  This plan has said `UNMEASURED` since the swap and every older number in it is
  ts-morph's. Well inside the 8g cap; 4× the bare figure; tracks repo size.

**Two silent bugs the measurement found, both in `prepare`, in three runs.**
Corepack's download prompt is not silenced by `CI=1`, so the first arm reported
`install: "failed"` on every case; and the strict→loose fallback **was not
loose** — yarn Berry and pnpm read `CI` and turn immutable installs on, so the
"fallback" re-ran the identical command and failed identically. Both would have
been honest, permanent failures in production on exactly the repos this phase
exists for. **This is the cheapest possible form of "read the free instrument
before buying a model one"**, and it paid twice before a single dollar.

**What WP4 still owes.** The same gate at **n = 50** — hours of compute,
gigabytes, no money — and the `falsify` arm, which costs model spend and whose
verdicts nothing reads until [WP6](06-adjudicate.md). `falsify` can move the
*mechanism* metrics (probes attempted / succeeded / reproduced / refuted, the
oracle's own hit rate); it cannot move recall until the exit is connected. That
is not an argument against having built it — it is the reason its gate is a
mechanism gate. **Sequence any corpus run after a `dist/cli.js` rebuild, never
concurrently** (§3).

> **A latent WP3 bug WP4's tests surfaced, and it is the §D12 shape.**
> `on_soft_failure` is a **`generic_loop`** key, and all six survey phases
> declared it at **phase level**, where zod strips it. Every survey was running
> `{ retries: 0, then: "fail" }`, so one degenerate agent turn would hard-fail
> the whole review — which records no `assessedHeadShaByWorkflow` and hands
> `cron-review.yaml` something to re-dispatch every thirty minutes forever. It
> had never fired because no model had ever run the pipeline. Fixed; the test now
> asserts the key's LOCATION, not just its value.

### The ordering question — WP4 or WP6? DECIDED: WP4 (2026-08-22)

Kept because the argument is still live for what comes *after* WP4b, and because
the reasoning on both sides was measured rather than assumed.

**For WP4 (`prepare` + `falsify`) first.** `prepare` turned out to gate **two**
families, not one. It was always what makes `coverage` — and therefore `tests` —
live. It is now also what makes **`contract`** live on any repo whose tsconfigs
`extends` a bare package specifier, because without `node_modules` tsgo excludes
the project and `contracts` emits nothing (corpus: tier-1 21 → 5, contract
deltas 73 → 19; [03](03-seed-and-survey.md) §"Measured 2026-08-22"). So WP4
raises the number of families that can seed at all from three to five, and it is
cheap and model-free.

**For WP6 (`adjudicate`) first.** **Nothing consumes a hypothesis.** The surveys
append to `hypotheses/<family>.jsonl` and no phase reads the file, so the run
still ends in the unchanged shipped reviewer. Verified on a real case: 40 KB of
obligations, 18+ hypotheses, `APPROVE` with **zero posted findings** against five
gold. **No rung before WP6 can move recall, including WP4** — a probe verdict
lands in the same unread place a hypothesis does. If the question being asked is
"does any of this improve the review", WP6 is the only rung that can answer it.

The honest summary: **WP4 widens the funnel's mouth; WP6 is the only thing that
opens its exit.** WP4 is cheaper and unblocks two families; WP6 is what makes
every number since WP1 mean something. A defensible third option is the smallest
possible slice of WP6 — a phase that reads the hypothesis files and writes
`findings.json` with no ranking, no tiering and no deletion — purely to connect
the exit, measured before either full work package.

**AC2 is not covered and should not be faked.** `apps/server` has no dependency
edge to `lastlight-code-facts`, so the seeder is unreachable from a core test;
and more to the point, a one-ended drop is counted in `obligations.json` and
**read by nobody** — `renderFamilyBlock` surfaces only the budget truncation.
That is arguably correct (the whole point is that a one-ended obligation never
reaches the model), but it means `dropped[]` currently has no consumer. WP6's
`adjudicate` is the natural one.

> **Do not close that missing edge — it is load-bearing.** The CLI is invoked as
> a PROCESS, resolved at run time through `LASTLIGHT_FACTS_BIN` → `PATH` →
> `/opt/lastlight/bin/`, and that indirection is the only reason the eval harness
> can measure any of this on a host that has never seen the sandbox image. WP4a
> paid the price rather than the edge: `env.json`'s field list is pinned as a
> literal on both sides (`packages/code-facts/tests/prepare.test.ts` and
> `apps/server/tests/workflows/pr-review-probes.test.ts`), each naming the other,
> because `pr-review.yaml`'s shell fallback hand-writes that document and is only
> ever reached when something has already gone wrong.

## 3. Driving sub-agents on this work

What produced results today, worth reusing close to verbatim:

- **"A failing test is more likely a new bug than a bad assertion — investigate
  before you adjust."** Four of WP1b's seven bugs surfaced exactly this way.
- **"Report anything in this brief you found to be wrong."** This repeatedly
  caught errors in the *brief*: opengrep was available on darwin after all, the
  grammar weight was 90 % waste, one bug had already been fixed, one field was
  mis-specified. Agents that were not asked this quietly worked around bad
  premises instead.
- **"A measured *this does not work* is a successful outcome of this task."**
  The name-match gate came back with a conditional yes and three specific
  constraints rather than a rubber stamp.
- **Hand them the measured numbers.** Agents made to rediscover context spend
  their budget on exploration; agents given the numbers go straight to work.
- **Explicit, disjoint file ownership** — *"you own `src/project.ts`; another
  agent owns `rules/`"*. Two agents editing one file early on cost a merge.

The mistake, so it is not repeated: **never run a measurement agent concurrently
with an agent that rebuilds what it measures.** A corpus run was invalidated
when `dist/cli.js` was rebuilt mid-flight; 50 cases were thrown away. The guard
now in the briefs is to `stat` the binary before and after and confirm every
case artifact's mtime falls inside the run window — but the simpler rule is to
sequence them. Relatedly, start long measurements detached (`nohup`); an agent
that polls a foreground run stops and restarts repeatedly and wastes cycles.

The second mistake, 2026-08-22: **an agent was killed mid-task for "scope creep"
that was not its doing.** Files well outside its brief were changing inside its
working window — a different work package entirely — and the obvious inference
was drift. They belonged to a concurrent human session in the same checkout. The
agent was in its lane, and the kill cost a half-finished `run.ts` rewire. So:
**a repo can have more than one writer, and `git status` does not name them.**
Before attributing a change to an agent, check it against the files you actually
gave it; if the two do not overlap, ask before you act. Note also that a stopped
agent could not be resumed in that session, which makes the cost of a wrong kill
the whole remaining task.

## 4. Open backlog

Small, none blocking, all measured rather than suspected.

**The 2 GB cap is RETIRED — the operator raised it 2026-08-22.**
`SANDBOX_MEMORY_LIMIT` defaults to **8g** now. Do not re-open the cap from a
stale reading of [HANDOFF.md](HANDOFF.md), and do not spend another hour
shrinking the tool to fit a number that no longer exists. What forced the
raise: **the "0.8–1.3 GB" figure was about this monorepo, not about real
repos.** On bare corpus trees `grafana-106778` peaks at **2449 MB off a
fourteen-file diff** and `sentry-greptile-5` at **2988 MB**, so the cost tracks
*repo* size through `--max-files`, and the only way to hold 2 GB was to go
blind again. > **All of that is now HISTORY, twice over.** `--resolution` does not exist —
> the engine swap (§2) deleted it along with the file budget it was rationing.
> Every number in this section is **ts-morph's**, and none of it transfers to
> the current engine, whose memory is UNMEASURED because the compiler is a child
> process. Kept because the *shape* is the lesson and the shape repeats: a knob
> can bound the wrong population entirely while looking like the relevant one.

The analysis, as it stood: `--max-files` bounded ts-morph's source-file count
(**637** on a three-file diff of this repo), while the `ts.Program` bound
**9,647** files, **8,947 of them under `node_modules`** — so the knob everyone
reasoned about was not the term that dominated. The fix was a `resolutionHost`
refusing bare specifiers into `node_modules` against an allow-list computed from
the changed files' own imports (`--resolution changed`, made the default):
**1022 / 1274 / 1600 / 1387 / 2157 MB** across five commits of an *installed*
tree where `full` cost **3699 / 3902 / 4347-OOM / 3481 / 4430**, at **zero
type-fidelity cost across 499 contract entries**. The full argument — including
why it was lossless *by construction*, and why that sweep's wall-clock figures
are contaminated and must never be quoted — is in
[01b-code-facts-hardening.md](01b-code-facts-hardening.md) → "Where the memory
actually goes".

Still open:

- **Fingerprint collisions.** 13 corpus findings yield 11 distinct fingerprints;
  two same-line matches at `topic.rb:382` cannot be separated by a 3-line
  context window, so a dedup consumer silently drops one.
- **`patterns` scopes to changed *files*, not *hunks*** — deliberate (evidence,
  not findings), but it means some hits are pre-existing code in a touched file.
  An `inChangedHunk` flag would let the seeder rank without the extractor
  filtering.
- **`facts`/`contracts` read head from the filesystem** while the changed set
  comes from git — and the engine swap **widened this**, so re-read it before
  assuming the old note still applies. The base side is now a virtual-FS overlay
  that serves base blobs for CHANGED files and falls through to the real
  filesystem for everything else; the old worktree served base blobs for
  everything. The two agree exactly when the checkout is clean at head. On a
  dirty tree they diverge silently — measured: a `languageBreakdown` contract
  delta the worktree reported and the overlay did not, because `schema.ts` was
  modified in the working tree but absent from the changed set. The old
  "2× cost" reason for deferring is void (there is no second worktree to double),
  so the cheap fix is now a loud `degraded[]` entry when the tree is dirty rather
  than a silent substitution. **Practical consequence: `pnpm selfcheck` on your
  own work-in-progress compares old blobs to new files and is meaningless — run
  it against a clean clone or a `git stash create` snapshot.**
- **Load-sensitive tests fail under CPU contention**, in two packages. In
  `code-facts` it was three (`constants` ×2, `fail-loud` ×1).

  **The `lastlight-core` one is IDENTIFIED as of 2026-08-22**, by copying
  `.turbo/turbo-test.log` aside before the re-run, which is the step the previous
  two sightings skipped:

  > `tests/cron/handler-crons.test.ts:143` — *"withLedger — a handler cron is
  > countable › records a row per invocation, keyed by the CRON name"*.
  > **`Error: Test timed out in 5000ms`**, having run **6963 ms**. Passes
  > standalone in 3.4 s (16/16).

  It is a **timeout, not an assertion failure**, and the body is
  `await import("#src/cron/handlers.js")` followed by `makeTestDb()` — a dynamic
  ESM import plus a database build inside a default 5 s budget. Under parallel
  sub-agent load the import alone can exceed it. Nothing about it is related to
  whatever change happens to be in flight when it fires, which is why it has
  twice looked like a mystery.

  **FIXED 2026-08-22, and not by raising the timeout.** The two modules that test
  imported inside its body (`#src/cron/handlers.js`, `#src/cron/scheduler.js`)
  are now hoisted to top-level `await import`s beside the three the file already
  hoisted — the file's own established convention, and below every `vi.mock`, so
  mock ordering is unchanged. The module-graph load is paid once at collection
  instead of being billed to whichever test happens to run first. Verified under
  load (two eval arms running): 16/16 in 4.57 s, with `import 2.85s` against
  `tests 1.62s` for all sixteen — where that single test used to burn 6963 ms.

  A bigger ceiling was the obvious fix and the wrong one: it would have hidden a
  real slowdown here later, which is the opposite of what this suite is for.

  **The same shape is latent in five other files** — an `await import()` inside a
  test body, where ESM caching means only the FIRST such test in the file pays
  the graph load: `tests/admin/routes.test.ts` (19 of them, the largest graph and
  so the likeliest next sighting), `tests/admin/auth.test.ts`,
  `tests/engine/github-app-client.test.ts`, `tests/engine/team-visibility.test.ts`,
  `tests/engine/pr-notes-harvest.test.ts`. **None has ever been observed to
  fail**, and none uses `vi.resetModules()`, so none of them *needs* the in-test
  import for module-state reasons and all five could be hoisted the same way.
  Left alone deliberately: five speculative edits to other subsystems' tests is
  not a fix, it is a guess with a diff. Hoist one when it actually fires.
