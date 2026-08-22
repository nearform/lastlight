# WP1b — hardening `code-facts` against itself

**Goal.** Make "run it on a real commit and read the output" a *mechanical* step
rather than a discipline, and then run it on fifty real commits.

**Depends on:** [WP1](01-code-facts.md). **Landed:** 2026-08-21.

## Why this work package exists

WP1 shipped with 101 green tests and its own commit note said the quiet part
out loud: running the extractors against a real commit was worth more than the
unit tests. That claim was already evidence — the phantom-delta trap in
[01-code-facts.md](01-code-facts.md) was found that way, **227 contract deltas
of which one was real, with every unit test passing throughout**.

WP1b turned that observation into machinery. It found **seven bugs, six of them
the same species: a wrong or absent answer that looked like a clean result.**

That is the precise failure mode locked decision 6 exists to prevent —
dependency-cruiser exiting 0 while seeing nothing — living *inside the package
built to prevent it*. Not one of the six was visible in a test suite, an exit
code, or a `degraded[]` entry. Every one of them was visible the moment a
second, independent oracle was pointed at the same document.

## The seven

Numbered by discovery, with what each one cost, because the *shape* is the
lesson and the shape repeats.

### 1. `canonicalType` counted the `>` of `=>` as a closing bracket

`splitTopLevel` walks a type string tracking bracket depth so a union can be
split without cutting inside a generic. `=>` is two characters, and the second
one is `>`. So depth went **negative at the first arrow**, and every function
signature was split inside its return type.

Cost: **12 phantom deltas** on a fixture whose only real change is one added
parameter. `contracts.test.ts` passed throughout — its cases have no arrow, or
no union, and it takes both to fire.

### 2. `stripImportPaths` matched only the qualified form

It handled `import("…").Member` and nothing else. A **module-namespace** type —
`typeof import("./x.js")` — has no trailing dot, so it survived with its
specifier intact: **2 of 207 deltas** on a real commit carried an absolute path
that differs between the head tree and the temp base worktree. That is the
phantom vector exactly, and it is the one that does not announce itself, because
two type strings that differ only in a `/private/var/folders/…` prefix read as a
genuine signature change.

Worse in the same file: **`throws[]` was never stripped at all**, and is
compared **raw** by `sameShape` with no `canonicalType` pass.

### 3. The diff range was two-dot, not the merge base

`base..head` additionally contains every commit that landed on the base
*branch* since the PR forked, none of which the author wrote.

**Production was inconsistent with itself.**
`apps/server/src/workflows/handlers/post-review.ts:415-455` already did
three-dot with an unshallow retry; `code-facts` did two-dot. And this is a
**production shape, not a dataset artefact** — the workflow reads
`pull_request.base.sha`, the tip at event time, so a review against a busy base
branch analysed thousands of untouched files and generated obligations about
unrelated code.

Measured across the 50-PR Martian corpus, 9 of 50 cases diverge:

| case | `base..head` | merge base |
|---|---|---|
| sentry-greptile-1 | 6125 files | 3 |
| sentry-greptile-94376 | 1281 | 7 |
| grafana-90939 | 142 | 1 |
| keycloak-40940 | 82 | 4 |

`sentry-greptile-1` alone was the corpus's **entire over-90 s count (157.9 s,
against AC6's 90 s budget)** and its 2.7 GB peak-RSS ceiling.

### 4. Monorepo tsconfig blindness

`findTsConfig` picked **one** nearest tsconfig, so a diff spanning packages was
mostly unanalysed. On this repo's own WP1 commit: **1 of 31 analysable changed
files**. Across the corpus: 58 of 8,514 — 0.7%. Every one of those runs carried
the shortfall in `degraded[]`, so this was never a loudness bug. The package was
honest, and blind.

Fixed by opening **one `Project` per tsconfig the diff touches**, unioned, with
the file budget allocated rather than spent first-come-first-served. The full
reasoning — including the two rejected alternatives and why `maxFiles` had to
stay a *total* against the 2 GB agent cap — is in
[`packages/code-facts/CLAUDE.md`](../../../packages/code-facts/CLAUDE.md).

### 5. `@throws {ValidationError} when the id is empty` recorded `"when"`

TypeScript parses `@throws {X} prose` as a `JSDocThrowsTag` and **lifts the
braced type out into a separate `typeExpression`**, so `getCommentText()`
returns only the description. The old code read the type off the comment text
and unwrapped it with `/^\{(.+?)\}.*$/` — a regex that therefore never matched,
leaving the **first word of the prose**.

The braced form is the dominant spelling, so this was the **common case, not the
edge case**. And `@throws {TypeError}` with no prose returned `[]` — an
**absence claim about a throw that is documented in the source**, emitted by the
extractor whose entire output is absence claims. Compounded by bug 2: `throws`
is compared raw, so editing prose after a `@throws` manufactured a phantom
`changed` delta out of a comment edit.

### 6. `rules/review.yaml` had never been valid YAML

`- pattern: $JWT.verify(…, {..., algorithms: ["none"], ...})` is a plain scalar
containing `: `, which YAML rejects. **Opengrep refused the entire config on
every run since the file was written.**

The extractor degraded honestly — a config error reaches `degraded[]` like any
other — but *for the wrong reason*, and the finding list is empty either way. It
interlocked with a second defect to become unobservable: `toolchain.json`
published a **linux-x86-only download URL**, in the file whose third consumer
"refuses on a mismatch, printing the commands to fix it". So on darwin it
printed a command that could not work, for the package that exists precisely so
a Mac at `--sandbox none` can be measured. **Nobody on a Mac could install the
binary to discover the bug.** Both streams publish darwin builds at the pinned
versions; the manifest was the limit, not the platform.

This is the one of the seven that is not a wrong answer — it is an entire
obligation family that could never have fired, reported as a routine
degradation.

### 7. ast-grep refuses a whole rule naming a node kind its grammar lacks

A rule table shared across the TypeScript and JavaScript grammars threw on every
`.js` file, and a `try`/`catch` turned the throw into **"this file contained
nothing"**.

Six of the seven are the same species. Number 6 is the seventh, and it is worse:
the family was not wrong, it was *unobservable*.

## What WP1b built, and why each piece is load-bearing

Four instruments and two tests. None of them is a unit test, and that is the
point — every one of the six was invisible to a suite that asserts *what the
extractor said*.

### `src/selfcheck.ts` — an independent oracle

Cross-checks the envelope against **git**, not against ts-morph: `git show
<head>:<file>`, `git diff --name-status`, `git diff -U0`. An oracle built out of
the same machinery as the thing under test cannot see a plausible-and-wrong
answer, because both halves are wrong in the same direction.

It is **exported**, so the same code runs in CI, in `pnpm selfcheck`, and inside
the corpus harness — which is what makes a 50-PR run a **bug detector that needs
no gold labels at all**. Its `removed`-implies-absent-at-head check alone would
have caught WP1's 65 phantom removals.

It is pure, synchronous, and never throws: a malformed document produces a
violation, because a self-check that dies on bad input reports nothing exactly
when something is wrong.

### `tests/noise-floor.test.ts` — three sensitivity proofs

The rule it establishes, now in `packages/code-facts/CLAUDE.md`:

> **A bound is only a guard if you also pin the number it would be WITHOUT the
> fix.**

`expect(contracts.length).toBeLessThanOrEqual(3)` passes trivially on a two-file
fixture. So each ceiling is paired with a floor measured on
`makeMonorepoFixture()`, a ~40-file two-package repo carrying all three original
causes at once. Measured floors: **one-sided guard 41 deltas / 40 removed
exports, node_modules mirror 17, `canonicalType` 24.** The floors assert
`toBeGreaterThan`, never exact values — an exact number is a snapshot.

Building the fixture found bug 1, which the three original fixes did not cover.
That is what a fixture large enough to exhibit the bug is *for*.

### `tests/oom.test.ts` — pinning the hole, not closing it

`--never-fail` is an in-process `try`/`catch`. It covers everything that raises
and cannot cover a process that dies: an OOM exits **134 with no envelope**.

The test spawns under `--max-old-space-size=32` and asserts a non-zero exit
**and that no file was written**. 0% flake over 20 runs. It exists so nobody
closes the hole into a *false* guarantee — an `uncaughtException` handler here
would make the docs read as though the envelope were always written, and the
shell-level catch that is the actual guarantee would quietly get dropped. §D12
depends on that catch; see [HANDOFF.md](HANDOFF.md).

### `scripts/selfcheck.ts` — the real-commit census

`all` against this repo (`--base` defaults to `HEAD~1`), printing how much of
the diff was analysed and by which programs, counts by change type, the top 20
symbols by `consumersOutsideDiff`, the tier, every `degraded[]` reason and the
wall clock. It reproduces WP1's landed **19 contracts** exactly, so the number
that closed WP1 is now a regression guard rather than a paragraph.

Not in CI, deliberately: `actions/checkout` defaults to `fetch-depth: 1`, so
`HEAD~1` does not exist on a runner.

### `apps/evals/scripts/facts-corpus.ts` — fifty real PRs

Runs the built CLI over the 50-PR Martian corpus off **bare-mirror worktrees**
(`git worktree add --detach`, never a clone), with **no `node_modules`** — which
is production's shape, not a defect. Emits per-case tier, coverage, exit code,
wall clock, peak RSS, payload counts, and the roll-up tables this document
quotes.

### `apps/evals/scripts/facts-anchors.ts` + `anchors.json`

The frozen, hand-audited deterministic anchor labels that give the
evidence-coverage metric its denominator. No model anywhere. See
[08-evals.md](08-evals.md) → "Evidence coverage".

### `apps/evals/scripts/facts-evidence.ts`

Scores a corpus run against those labels. Deterministic, free, and it bounds
WP3 *upstream* of the mechanism metrics.

## Corpus movement

Baseline `2026-08-21_103537` → final `2026-08-21_140115`, both 50 cases, same
CLI harness, same mirrors.

| | baseline | final |
|---|---|---|
| analysed / changed (**merge-base** denominator) | 58/670 — **8.66%** | 238/670 — **35.52%** |
| analysed / changed (harness **two-dot** denominator) | 58/8514 — 0.68% | 238/8514 — 2.80% |
| symbols | 82 | **318** |
| contracts | 33 | **73** |
| `consumersOutsideDiff` | 36 | **147** |
| cases producing zero facts of any kind | 34 | **27** |
| tiers | 1=19 · 2=3 · 3=28 | 1=21 · 3=29 |
| max wall clock | **157.9 s** | **26.9 s** |
| runs over 90 s (AC6) | 1 | **0** |
| `noEnvelope` | none | none |

**Report both denominators, and never switch mid-comparison.** The harness still
computes `changedFiles` two-dot so the divergence table stays readable; the tool
now diffs at the merge base. Quoting 35.52% against a two-dot baseline, or 2.80%
against a merge-base one, would manufacture or erase most of the movement.

### Three numbers went DOWN, and all three are corrections

| | baseline | final |
|---|---|---|
| `constants` | 72 | 0 |
| `depChanges` | 102 | 7 |
| `coverageChangedLines` | 225,518 | 16,436 |

**68 of the 72 constants, 96 of the 102 dependency changes and 196,913 of the
225,518 coverage lines came from `sentry-greptile-1` alone** — extracted from
6,122 files the PR never touched. They were facts about the base branch's own
history, presented as facts about the pull request. A seeder consuming them
would have spent its `maxObligations` budget on other people's commits, which
IRIS measures as *actively harmful* rather than merely wasteful (locked decision
3).

`constants` reaching **0** across the corpus is not a regression to chase: 29 of
50 cases are tier 3, where there is no reference set A at all, and the remaining
tier-1 diffs changed no constants. It is the honest answer, and the
`degraded[]` entry says so on every case.

## What it cost

**Tests 101 → 376**, across 22 files. Source grew 3,894 → 8,761 lines and tests
1,879 → 8,231, so the test:src ratio went **0.48:1 → 0.94:1**. The four standing
instruments — `pnpm selfcheck`, `facts-corpus.ts`, `facts-evidence.ts` and
`scripts/name-match-gate.ts` — are *not* in that count and are not tests: they
report, they never gate a build, and three of the four need a real repository
with real history.

## What this changes elsewhere

Recorded in the work packages themselves, listed here so the trail is findable:

- **[WP3](03-seed-and-survey.md)** — `patterns` is spent as a *discovery* route,
  proven by counterfactual; and evidence coverage becomes a cheap upstream
  precondition on the seeder.
- **[WP4](04-probe-oracle.md)** — the `coverage` extractor is **structurally
  dead** until `prepare` produces an artifact. A hard ordering constraint, not a
  preference. And, added later the same day, `prepare`'s install was an
  **unrecorded OOM dependency** on WP3's phase; see the closing section below.
- **[WP8](08-evals.md)** — the evidence-coverage instrument, three numbers and
  three denominators.
- **[WP9](09-external-validation.md)** — got cheaper, and gained Stage 2
  grammars as a dependency.
- **§D12** — reconfirmed, not changed. `tests/oom.test.ts` pins that
  `--never-fail` cannot survive a dead process, so the shell-level catch remains
  the guarantee.

## Non-goals for WP1b

- **No workflow change.** `pr-review.yaml` is still untouched; wiring is
  [WP3](03-seed-and-survey.md).
- **No new grammars.** `scripts/name-match-gate.ts` is the measurement that
  decides whether they are worth +36.5 MB, and its answer is scoped in
  [09-external-validation.md](09-external-validation.md).
- **No model spend.** Every number in this file is deterministic and repeatable.

## Where the memory actually goes — and the 2 GB cap, closed

**Measured 2026-08-21, after the rest of WP1b had landed.** The 2 GB agent cap
was [HANDOFF.md](HANDOFF.md) sign-off item 9 and it blocked
[WP3](03-seed-and-survey.md). Settling it produced a finding that first *added*
a dependency between two work packages, and then a fix that dissolves it.

### Peak RSS is dominated by `node_modules`, not by the file budget

`--max-files` bounds the **ts-morph** source-file count. That is not the
population the type-checker allocates against. On a three-file diff of this
repo:

| | files |
|---|---|
| ts-morph source files — what `--max-files` bounds | **637** |
| files the underlying `ts.Program` parses and binds | **9,647** |
| …of those, under `node_modules` | **8,947** |
| …of those, `.d.ts` | 7,374 — **78 MB** of declaration text |

`skipFileDependencyResolution` stops ts-morph *adding* files, and `types: []`
stops auto-including `@types`. **Neither stops the type-checker following a bare
specifier**: that happens one layer below the API the budget is expressed in.
Loading is lazy, which is exactly why the shape hid behind a plausible knob —
the 637-file load costs **446 MB**, and the first touch of the checker takes it
to **1.66 GB**.

So the lever WP1 reasoned about — `maxFiles` kept as a *total* against the cap
— was bounding the wrong population. `--max-files 3000` really did take
`sentry-greptile-5` to 2.14 GB with identical output, and that measurement
stands; what it was not is the dominant term.

### Why this was about to become a WP3/WP4 problem

`all` fits the 2 GB sandbox today at **0.8–1.3 GB** — *but only because the
review workspace has no install.* `pr-review.yaml` has no install phase and the
pre-clone is bare. **Nothing enforced that.** It was a property of the workflow
that nobody had written down, and every memory number in this plan was measured
under it.

[WP4](04-probe-oracle.md)'s `prepare` ends it. It must produce a coverage
report; a coverage report means running a suite; running a suite means
installing dependencies. And the install *persists* — the cross-run refresh is
`git clean -fdx -e node_modules` — so once `prepare` has run on a PR, every
later `facts` run in that workspace, including every re-review, analyses an
installed tree. Measured on the same five commits, installed:

```
peak RSS MB, INSTALLED tree
commits with 3 / 22 / 22 / 46 / 158 analysable changed files
full       3699 / 3902 / 4347-OOM / 3481 / 4430
changed    1022 / 1274 / 1600     / 1387 / 2157
workspace  1057 / 1286 / 1639     / 1480 / 2182
hop        1106 / 1372 / 1688     / 1541 / 2349
none        818 /  926 / 1320     / 1215 / 1277

BARE (no node_modules — the sandbox today): 791–1422 MB across ALL tiers
```

At `full`, four of five commits are roughly **2× the cap** and the third is an
**OOM: exit 134, no envelope**. That is precisely the shape §D12 exists to
close — the phase fails, the run fails, `assessedHeadShaByWorkflow` is written
**from SUCCEEDED runs only**, and `cron-review.yaml` re-dispatches every thirty
minutes forever. WP4 would have re-opened the $1.30-an-hour loop from *inside*
the phase WP3 wires up, by installing dependencies for an unrelated reason.

### The fix: refuse bare specifiers *selectively*

A `resolutionHost` that will not resolve into `node_modules`, with an
**allow-list of the specifiers the changed files import**. Five tiers were swept
(50 runs: 5 commits × 2 conditions × 5 tiers); the table above is the result.
`changed` is the allow-list tier, `none` blocks every bare specifier, and
`workspace` and `hop` widen the list.

Fidelity was then measured against the `full` baseline document on the two
largest commits — contract entry counts, **key identity**, and type-text loss:

| tier @ commit | contract entries | `textDiffers` | `anyIntroduced` |
|---|---|---|---|
| `changed` @ `c8530b83` | 251 | **0** | **0** |
| `changed` @ `df645b6f` | 248 | **0** | **0** |
| `none` @ `c8530b83` | 251 | 78 | 76 |
| `none` @ `df645b6f` | 248 | 56 | 44 |

For both `changed` rows the key sets are **identical** — the same symbols in the
same files, not merely the same count. So `changed` costs **zero type fidelity
across 499 contract entries**, at a third of `full`'s memory.

**And it is lossless by construction, not by luck.** The allow-list is computed
from the same changed files whose contracts are extracted, and a contract
signature can only mention types reachable from its own file's imports. A
specifier that is not on the list is one no changed file imports, so no contract
entry in the document can be sourced from it. The measurement is a check on the
argument, not the reason to believe it. (`none` is the counterfactual that
proves the argument is doing work: block *everything* and 78 entries lose their
type text, 76 of them by gaining `any`.)

`workspace` and `hop` are **dominated** — both cost more memory than `changed`
on every installed commit measured (1057–2182 and 1106–2349 MB), for no
fidelity `changed` lacks, and both carry pathological wall-clock outliers
(2124 s and 342 s on the 158-file commit, against `changed`'s 21 s), with `hop`
opening hundreds of package manifests to get there. They were therefore **cut**:
the shipped tiers are `full` / `changed` / `none` only. A dominated option left
in a list is an invitation to pick it.

The decision this evidence supports: **`changed` becomes the default**, `full`
remains the escape hatch for a run that must reproduce today's document exactly,
and `none` is the emergency lever for a repo that OOMs anyway. That is an
implementation default in `packages/code-facts`, not a new locked decision —
see [10-design-review.md](10-design-review.md) for why it was deliberately not
given a number.

### Two safety properties, implemented and pinned by tests

- **The allow-list is the union of base and head, applied identically to both
  programs.** Per-side resolution would rebuild exactly the asymmetry behind
  WP1's **227 deltas of which one was real** — cause 1 was an asymmetric
  `tsconfig` between the two programs, and a per-side allow-list is the same bug
  wearing a different hat.
- **Unlike `none`, `changed` leaves real resolution in place.** The
  `mirrorNodeModules` fix (WP1's phantom-delta cause 2) stays load-bearing, and
  `tests/noise-floor.test.ts`'s **17-delta** sensitivity floor for that mirror
  keeps its meaning. A tier that resolved nothing would make that floor
  unreachable and the proof vacuous, which is the failure locked decision 6
  exists to prevent, one layer down.

At restricted tiers the extractor also records the honest converse in
`degraded[]`: an unresolved specifier renders as `any` on **both** sides, which
suppresses a phantom delta and would **mask a real one** between two unresolved
external types. At `changed` that set is empty by the argument above; the entry
exists so a reader of a `none` document is never told the silence is evidence.

### The timings in this sweep are contaminated — do not quote them

The sweep ran while a full test gate was running on the same machine, and it
shows. Erratic outliers appear across unrelated tiers, including **1933 s for a
`bare/none` run that should take seconds**. **The RSS pattern is
consistent, large, and reproducible enough to act on; the wall-clock numbers are
not, and need a clean re-run before anyone quotes them** — including the 2124 s
and 342 s figures cited above against `workspace` and `hop`, which are used here
only as "pathological relative to `changed` in the same conditions", never as
measurements of those tiers.

This is the same rule as the three load-sensitive tests in
[RESTART.md](RESTART.md)'s backlog: a number measured on a busy machine is a
number about the machine.
