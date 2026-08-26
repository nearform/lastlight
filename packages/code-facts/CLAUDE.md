# `lastlight-code-facts` — the deterministic layer

Program analysis of a pull request, emitted as JSON. No model spend, no network
(unless you ask for `--stage`), and no dependency on the rest of the workspace.
It is the substrate every later phase of the PR-review evidence pipeline reasons
over — see
[`docs/plans/deterministic-pr-levers.md` → code-facts](../../docs/plans/deterministic-pr-levers.md#code-facts-wp1-and-hardening-wp1b)
(WP1) and
[its design-review decisions](../../docs/plans/deterministic-pr-levers.md#decisions).

```bash
lastlight-facts all --repo . --base main --head HEAD --out facts.json
lastlight facts constants --repo . --base main       # same code, via the CLI
```

## Why it lives here, and why it is published

**It ships inside the `lastlight` CLI** (design review §D1). That reads like a
packaging choice and is really a measurement one: the eval harness defaults to
`--sandbox none` — in-process, on the host — **rejects** `docker`/`smol` because
they break the in-process GitHub mock, and `gondolin` needs `/dev/kvm`, which
`sandbox-preflight.ts` refuses on darwin. So **no eval configuration on a Mac can
see `/opt/lastlight/`**, and a toolchain that existed only in the sandbox image
would be a pipeline nobody could measure.

Being a dependency of a **published** package forces this one to be published
too: `pnpm pack` rewrites `workspace:*` to a concrete version, and npm cannot
resolve a version that was never published. Hence a seventh npm package, against
WP1's original "private: true" — that line was written when delivery was
image-only, which §D1 reversed. The `lastlight` CLI grew ~22 MB installed as a
result (measured, on darwin-arm64; §D1 estimated ~15 MB and did not size
`@ast-grep/napi`'s platform binary).

It is a **leaf**: no `workspace:*` dependencies in either direction, like
`agentic-pi`. That is why `log.ts` re-declares the `LoggerPort` shape instead of
importing it from `lastlight-workflow-engine` — the interface is structurally
identical, so `logger("code-facts")` from core passes straight in, and vendoring
this package into the sandbox image never drags the workspace along.

## The two loudness surfaces — read this before changing an extractor

The failure mode this package is engineered against is **a tool that cannot see
the sources and reports success anyway**. dependency-cruiser refused to parse
TS >= 7 and *exited 0*, so the import-boundary gate went green while seeing
nothing (root `CLAUDE.md`). A silently-empty obligation list is that bug with a
green pipeline.

But "fail loud" cannot mean "fail the run". `cron-review.yaml` re-dispatches
every thirty minutes, and `assessedHeadShaByWorkflow` is populated from
**SUCCEEDED runs only** (`pr-decisions.ts` ~line 918, whose comment records a
1260-execution / $1.30-an-hour incident). A phase that exits non-zero fails the
run, records nothing, and is retried forever.

So loudness lives in **two places** and they are not the same place:

| Surface | Who reads it | Contract |
|---|---|---|
| **Exit code** | a human, and this package's own tests | `0` trustworthy · `2` could not run · `3` degraded |
| **The envelope** | a workflow phase | `coverage` + `degraded[]` + the toolchain stamp, on **every** document including the failures |

`--never-fail` is the phase wrapper (§D12): it catches the failure, writes the
envelope with `coverage: "none"` and a populated `degraded[]`, and **returns 0**.
Locked decision 6's actual requirement is that *an empty obligation list and an
unavailable analyser must never be indistinguishable* — the envelope satisfies
that completely. **The exit code was never what made it loud.**

`tests/fail-loud.test.ts` is the gate on both halves. Do not weaken it.

### `--never-fail` covers thrown errors, **not** a dead process

Measured, not assumed: `--never-fail` is an **in-process `try`/`catch`**, so it
covers every failure that raises — a missing binary, an unparseable tsconfig, a
directory that is not a git repo. It cannot cover a process that dies.

```
not a git repo, --never-fail   → exit 0,   coverage:"none" envelope written   ✓
process death,  --never-fail   → exit 134, NO envelope                        ✗
```

Three ways to reach the second row, and the newest arrived with the new engine:
an OOM (raising `--max-files` past what the heap can hold; the default ceiling
degrades gracefully instead, which is why it exists), a segfault in the
`@ast-grep/napi` native binary, and — **verified by reading `typescript`'s
`dist/api/syncChannel.js`** — a `spawn()` with **no `'error'` listener**, so a
`tsgo` executable that cannot be run emits an unhandled `'error'` on the next
tick and kills the node process outright. `resolveTsgoBinary()` pre-flights it
(`accessSync(X_OK)`) and passes the resolved path back in as `tsserverPath`, so
the path checked is the path spawned — **a narrowing, not a guarantee**: a binary
that passes `X_OK` and dies during exec still takes the process down. That
executable arrives as an npm `optionalDependency`
(`@typescript/typescript-<platform>-<arch>`; 20 declared, one installed), so an
image that does not install its own gets a `typescript` that imports fine and a
`tsgo` that does not exist.

**So the caller must own the fallback.** The workflow phase catches at the shell
— `lastlight-facts all … || <write a fallback envelope>` — because a wrapper
inside the crashing process is not a guarantee. Anything that raises this
package's memory ceiling without that catch in place re-opens the 30-minute
re-dispatch loop §D12 exists to close.

Both rows of that table are executable: `tests/fail-loud.test.ts` pins the first
and `tests/oom.test.ts` the second (a spawn under `--max-old-space-size=32`,
asserting a non-zero exit **and** that no file was written). The second one
exists so nobody closes the hole into a *false* guarantee — an
`uncaughtException` handler here would make the docs read as though the envelope
were always written, and the shell-level catch that is the actual guarantee
would quietly get dropped.

## The compiler — the TS 7 premise expired, and the rule that survived it

**TypeScript 7 does have a programmatic compiler API.** `typescript@7.0.2`
exports `./unstable/sync`; the engine behind it is the Go compiler, spawned as a
**child process** over a synchronous pipe, with the JS side as a client. WP1's
locked decision — *"`tsgo` is CLI + LSP only"* — was true when it was written
(2026-08-20) and is false now. The argument, the measurements, the gates and the
end state live in [`docs/plans/fact-engine/`](../../docs/plans/fact-engine/README.md).

**Where the tree was at `7602ef47`, and where it is going.** The seam
(`src/tsgo.ts`) is committed and `facts` + `contracts` are ported onto it in
`src/tsgo-extractors.ts` behind **`--engine tsgo`**, a measurement flag whose
default was still `ts-morph` at that commit. The end state — `ts-morph` gone, and
with it the shared file budget, `--max-projects`, `--resolution` and the base
worktree — is specified in
[`02-migration.md`](../../docs/plans/fact-engine/02-migration.md) and was
**landing while this was written**, so treat every mechanism named below as
scheduled for deletion and **read the tree, not this file, for what is still
there**. What survives the swap is not the machinery, it is the epistemics:
`null` ≠ `[]`, a tier is not a coverage, an empty result is never a pass.

Three rules, not negotiable:

1. **`src/tsgo.ts` is the only module that may import `typescript/unstable/*`.**
   It owns the compiler LIFECYCLE and no policy — no file budget, no project
   cap, no tier. `project.ts` decides *which* tsconfigs and *which* orphan files
   are worth opening; the seam is told and obeys.
2. **Never resolve `typescript` from the repo under review.** Unchanged from
   WP1, and now the *more* important half, because the engine **is**
   `typescript`: a resolve that walked into the target repo would run an
   arbitrary compiler pinned by an arbitrary lockfile against the code it is
   supposed to be auditing. Hence the **exact** pin (`"typescript": "7.0.2"`, a
   real dependency, not a caret — the API is namespaced `unstable/` and a caret
   is an unpinned compiler in a package whose job is reproducible documents).
   Verified 2026-08-22: `typescript/lib/getExePath.js` resolves the platform
   executable from its own `import.meta.url` and never consults `cwd`, so
   `new API({ cwd: repo })` cannot pull a compiler out of the target. Assert it
   anyway — `tests/compiler-isolation.test.ts` is the gate, with comments
   stripped first so the doc comments that *name* the forbidden shape do not
   trip it.
3. **This engine's silences are louder than its failures.** A tsconfig that will
   not parse does **not** throw: `updateSnapshot` hands back a project built from
   a *recovered* configuration and demotes the parse failure to
   `getConfigFileParsingDiagnostics()`. A tsconfig that does not exist is simply
   absent from `getProjects()`, and a shorter list looks like nothing at all.
   Both are locked decision 6's exact shape. `src/tsgo.ts` detects both,
   **excludes** the project rather than degrading it, and records
   `tsconfig-unparsable` / `tsconfig-absent` in `failures[]` beside the
   `degraded[]` prose. Compare projects asked for against projects returned,
   every run.

The **`tsgo --lsp --stdio` fallback tier** that used to be rule 3 is not what
shipped and is not planned. A file under no tsconfig gets a real checker from
`openFiles` → tsgo's **inferred project** (default compiler options — no
`paths`, no `strict`, nothing the repository configured — so it is named in
`degraded[]`: analysed is better than skipped, and it is not the same answer).
The one query with no API equivalent is `getImplementations`; an LSP session
sharing the snapshot is the plausible route and is an **open** spike item
(G-impl). Until it is answered, `SymbolFact.implementations` is **`null` plus a
`degraded[]` entry naming the engine** — never `[]`, which would assert that an
exported interface has no implementers anywhere.

### Measured: the two engines agree, and one is 3–10x faster

`scripts/engine-ab.mts`, this repo at `HEAD~1..HEAD`, one engine per run,
compared as **sets** rather than counts — a run that loses eight symbols and
gains eight reads as flat:

| | `ts-morph` | `tsgo` |
|---|---|---|
| `facts` symbol set / reference sites | 44 / 138 | **44 / 138**, nothing on either side only |
| `contracts` keys / `consumersOutsideDiff` | 13 / 32 | **13 / 32**, identical |
| `facts` wall clock | 2034 ms | **642 ms** (3.2x) |
| `contracts` wall clock | 3661 ms | **1405 ms** (2.6x) |
| the same two at `--resolution full` | 5704 / 10485 ms | 594 / 1523 ms (**9.6x** / **6.9x**) |
| `selfcheck`'s three exit conditions, recomputed in-script | OK | OK |

One commit of one repo, and the last row is a reimplementation of the check
rather than `pnpm selfcheck` itself — evidence toward the spike's G1/G2, not a
substitute for either.

**Two things that table does not say, and one of them is a correction.**

- **It is not a memory result, and this swap must never be sold as one.**
  `SANDBOX_MEMORY_LIMIT` went to **8g** on 2026-08-22, so there is no ceiling
  left to fit, and `01-spike.md`'s G4 was withdrawn from a gate to a reported
  number the same day. The **79 MB** figure `scripts/engine-bench.mjs` prints
  for tsgo is `process.memoryUsage.rss()` of the **node client**, and the
  compiler is a child process it does not count; the ts-morph column is
  in-process and counts everything. The number that includes the child is
  recorded in `src/run.ts`: **~600 MB per open snapshot plus ~200 MB of node**,
  on this repo — which is why `contracts` drains the base view to plain strings
  and disposes it *before* opening the head one, rather than holding two. The
  case for the swap is that it deletes mechanisms and is faster.
- **The two printers are not identical.** `TsgoFailureReason` prints its union
  members in a different ORDER on each engine, which is why the `printed
  SIGNATURES` set diverges by one entry while the contract KEY set does not.
  Harmless while both sides of a `contracts` comparison come from the same
  engine — and a standing reason never to compare a stored ts-morph `before`
  against a fresh tsgo `after`. Cause 3 of WP1's *227 deltas of which one was
  real* (`canonicalType` over re-printed type text) is the one cause the new
  engine does **not** remove.

### The overlay's base view is NOT the worktree's, and a dirty tree makes them disagree

Its own heading because it generalises, and because it is a silent-wrongness
shape rather than a crash.

- `withWorktree` (the ts-morph path) materialises **base blobs for every file**.
- `buildBaseOverlay` (the tsgo path) serves **base blobs for the CHANGED files**
  and returns `undefined` for everything else, which the engine's three-valued
  `readFile` means *fall through to the real filesystem* — the **working tree**.
  That is the point: one tree, one `node_modules`, ~24 ms instead of a second
  checkout, and the ranking skew a temp worktree introduces cannot arise.

**They agree exactly when the checkout is clean at head, and only then.**
Measured on this repo while `src/schema.ts` was modified in the working tree but
absent from the `HEAD~1..HEAD` changed set: ts-morph reported a `changed` delta
on `project.ts#languageBreakdown` — whose return type names the `engine` enum
`schema.ts` declares — and tsgo did not, 14 deltas against 13, in the
`--resolution full` arm of `scripts/engine-ab.mts`. The overlay never overrode
`schema.ts`, so the base view read the *edited* bytes and both sides matched.
Neither engine is wrong about the tree it was shown; they were shown different
trees.

This **inherits and widens** the backlog item in
[the `deterministic-pr-levers.md` backlog](../../docs/plans/deterministic-pr-levers.md#backlog) —
*"`facts`/`contracts` read head from the filesystem while the changed set comes
from git"*. That caveat was about head; the overlay makes it true of the **base**
view as well, for every file the diff did not touch.

**Open, not fixed.** What it wants is a loud `degraded[]` entry whenever the
working tree is dirty: the document claims to be about `baseSha..headSha`, and a
dirty tree makes it partly a claim about somebody's uncommitted edits. No such
check exists in `src/` today (verified 2026-08-22). Serving head blobs through
the same overlay closes the other half and is cheap for the first time — it was
a second worktree before.

## Language tiers

| Tier | Available | Extractors |
|---|---|---|
| 1 | TS/JS with a resolvable project | all, `resolution: "type-aware"` |
| 2 | TS/JS, project load failed | `deps`, `patterns`, `constants` (ast-grep only, **no reference set A**), `coverage`, and `facts` at `resolution: "name-match"` |
| 3 | any other language | `deps`, `patterns`, `coverage` |

Tier 2 and 3 emit `coverage: "degraded"` and a populated `degraded[]` naming what
is missing. **Silence is the failure mode we are engineering against.**

## `resolution` — the syntactic engine, and what it is worth

`src/syntactic.ts` is a second reference engine: one pass over the git-enumerated
file set producing `declarations`, `references` and `literals` keyed by NAME.
It drives tier-2 `facts`, which used to emit nothing at all. Every symbol it
produces carries `resolution: "name-match"` beside `nameAmbiguity` (distinct
declaration sites in the repo binding that name); tier 1 carries
`resolution: "type-aware"` and `nameAmbiguity: null` — nobody looked, because
building it costs a repo-wide parse a type-resolved run has no use for.

It is fed by `src/langs/`: a `LanguageDescriptor` is a TABLE of tree-sitter node
kinds (declarations, constants, references, literals, the call kind) plus three
predicates (`isExported`, `isTestPath`, and nothing else). **Not a plugin
system** — `register.ts` is a literal array. `tsjs.ts` is the only entry, and it
exists so the tier-2 path runs through the code a second language would.

**`nameAmbiguity` is DATA, never a filter.** This layer generates hypotheses and
the seeder ranks them; filtering here would delete evidence nothing downstream
could recover.

`scripts/name-match-gate.ts` is the measurement that justifies any of it: it
runs BOTH engines over the same symbols in a tier-1 repo and diffs the reference
sets. Measured (`--repo ../..` at the WP1 commit; cal.com and sentry-greptile
from the Martian corpus):

| case | recall | precision, whole repo | precision, own program | ambiguity 1 → 2-3 → 4-10 |
|---|---|---|---|---|
| this repo | **99.2%** | 20.5% | **85.7%** | 90% → 73% → 57% |
| sentry-greptile-5 | 93.0% | 25.5% | 26.3% | 53% → 24% → 4% |
| cal-com-11059 | 80.4% | 9.0% | 23.2% | 100% → 7% → n/a |
| cal-com-10967 | 94.6% | 3.1% | 29.0% | 53% → 20% → 12% |

Three things that are load-bearing and were each measured, not assumed:

- **Recall is the good news and it is nearly free**: 93–99% on three of four
  cases. A name-matched set essentially never MISSES a type-resolved reference.
  What it misses is aliases — `import Foo from "./bar.js"` where the class is
  `Bar`, which name matching cannot see at all (cal-com-11059: 7 class symbols,
  9 real references, 0 found).
- **Precision is dominated by SCOPE, not by ambiguity.** Restricting the match
  to the declaration's own program takes this repo from 20.5% to 85.7% — because
  tier 1's reference queries never leave their own program either, so a hit in a
  sibling package is not a false positive, it is a reference ts-morph was never
  in a position to find. On the two cal.com cases the same correction is worth
  only ~20 points, and there the imprecision is real.
- **MEMBERS are where it fails.** `LoggerPort.error`, `Visualize.yAxis`,
  `handler` (nameAmbiguity **145** on cal.com) offer hundreds of sites for one
  or two real ones. Module-level names hold up: `interface` and `type` score
  100%, `variable` 97%, `function` 87% on this repo.

The cost line: tier-2 `all` on sentry-greptile-5 is **1.75 GB / 13.6 s** against
the same case at tier 1 (3.15 GB / 24.5 s), so the new work stays under the tier
it substitutes for. `constants` is unchanged to the
byte and to the megabyte — A/B'd on this repo, 7,992 hits both ways, 406 MB both
ways — because `interestingKinds` asks the parser only for the node kinds the
caller's sink can use, and the literal sweep's sink asks for four.

## ONE PROGRAM PER TSCONFIG, the shared budget, the memory — why they exist

**Everything in this section is cost management for a JavaScript type-checker,
and [`02-migration.md`](../../docs/plans/fact-engine/02-migration.md) deletes it.**
The measurement record is kept compressed rather than dropped, because each
mechanism was bought with a bug and the *reasoning* outlives the mechanism.

**The rule that outlives all of it: the tier is not the coverage.** A program
that loads is not a diff that was analysed. `loadProject` returns **a group per
tsconfig the diff touches**, not one project for the diff, because when it
returned one the corpus measured what that cost: over 50 real PRs, **58 of 8,514
changed files were analysed — 0.7%**, with `grafana-90939` reporting **tier 1**
on 1 file of 142. Every run carried the shortfall in `degraded[]`, so this was
never a loudness bug: the package was honest, and blind. Measured on this repo's
WP1 commit, `pnpm selfcheck`: **1 of 31 analysable changed files → 30 of 31**,
across 4 programs; `cal-com-22532` went `0/12 → 12/12`. Whatever the engine,
**the per-file answer must survive** — `EngineSnapshot.lookup()` returning
`null`, or `LoadedProject.narrowed`, is how a consumer can still tell which
changed files a program actually held. **Reference queries stay inside their own
program**, which is correct rather than a limitation: over-claiming a reference
set would be worse than under-claiming it in the two extractors (`constants`,
`contracts`) whose output is an ABSENCE claim. Both engines produce the same set
today — 138 reference sites either way on this repo at `HEAD~1..HEAD`.

Three mechanisms, compressed, each with what removes it:

- **The file budget, ALLOCATED rather than spent** (`maxFiles` as a TOTAL,
  `unserved`, `allowanceFor`, `selectNeighbourhood`). One shared ceiling across N
  programs shipped first-come-first-served, which starves any monorepo diff
  spanning several packages: on `prreview__sentry-greptile-5` a single 7,230-file
  tsconfig over the 6,000 ceiling meant **0 of 69 changed `.tsx` files analysed**.
  The fix RESERVES every changed file before any group spends, and admits an
  over-allowance group **partially** — its changed files plus as much
  neighbourhood as fits — instead of refusing it wholesale. sentry went from
  producing nothing to a full tier-1 document (69 of 69, 112 symbols, 20
  contracts), and to **identical output at `--max-files 3000`**, because what
  buys the coverage is the reserve, not the ceiling. Two consequences were the
  whole point and both are epistemic rather than budgetary: **a narrowed
  program's reference sets are a LOWER BOUND**, said in those words in
  `degraded[]` — no *"appears nowhere else"* reading is available from a narrowed
  group, which matters most to `constants` — and **a file the diff DELETED gets
  its own reason, not a coverage-gap one**, because it is absent at head and no
  program can hold it. *Removed by:* one snapshot holding every project, so there
  is no per-group glob to size and nothing to narrow.
- **Pre-sizing every group BEFORE anything is parsed** (`globCandidates` from
  `git ls-files`, `tsConfigCandidates` from `getParsedCommandLineOfConfigFile`).
  Letting ts-morph glob the repo root and checking the count afterwards took
  `pnpm selfcheck` from 774 MB to **4.5 GB** of peak RSS — for a program rejected
  on the next line for being over the ceiling. The tsconfig half had the same bug
  and kept it a release longer: **112 ms and 211 MB to LIST** sentry's 7,230
  files against **3.6 s and 1.29 GB to compile them**, count them, find them over
  budget and throw the whole program away. *Removed by:* there being nothing left
  to size.
- **`--resolution` and the `node_modules` closure.** `--max-files` bounds the
  ROOT list, and the checker follows bare specifiers one layer below it: measured
  on a **3-file** diff of this repo, ts-morph held 637 source files while the
  underlying `ts.Program` held **9,647 — 8,947 of them from `node_modules`**,
  7,374 `.d.ts`. Neither `skipFileDependencyResolution` nor `types: []` stops it,
  so the same commits cost 0.9–1.3 GB on a bare tree and ~3.5 GB installed, with
  one ordinary 31-file PR **OOMing at 4.3 GB — exit 134, no document, and a
  leaked `git worktree` in `$TMPDIR` because the `finally` never ran**. That is
  the whole reason `--resolution` exists (`full` · `changed` · `none`, default
  `changed`; `workspace` and `hop` were built, measured and cut as dominated).
  It is not free, and the cost lands in `contracts`: with resolution blocked an
  externally-typed signature renders `any` (`z.infer<typeof S>` → `z.infer<any>`)
  on **61 of 168** entries, so a delta between two external types that both print
  `any` would be MASKED. *Removed by:* the tsgo path resolving every specifier,
  which makes the tier inapplicable rather than answered — **whether the Go
  compiler's `node_modules` cost behaves the same way has not been measured on
  any tree** ([`01-spike.md`](../../docs/plans/fact-engine/01-spike.md)'s G4,
  second half). `src/resolution.ts`'s deletion was conditioned on that
  measurement; if the file is gone from the tree and no installed-tree number is
  written down, the condition was skipped rather than met, and that is worth
  knowing before the next OOM.

Three readings of the retired per-extractor memory table survive it, because
they are about shape rather than about ts-morph. **`all` peaks at the MAX of its
parts, not their sum** — the extractors share the one head program `contracts`
needs anyway, so *"run them sequentially and release between them"* is the same
peak plus a second program build. **`contracts` is the whole cost**, because it
is the only extractor that materialises a second tree; the overlay is exactly the
removal of that tree, and what it changes about the *answer* is the dirty-tree
section above. And **peak tracks REPO size, not diff size** — `grafana-106778`
peaks at **2449 MB off a fourteen-file diff**, which is why no diff-scoped lever
ever reached it.

**What this means for a workflow phase, and none of it has changed.** The review
workspace is a pre-clone with **no install**, which is why `all` fits. Nothing in
this package enforces that, and **a `prepare` step that installs dependencies —
to produce the coverage artifact `coverage` reads, say — is what re-arms the
OOM.** The shell-level catch is not optional (see `--never-fail` above); neither
is keeping the install out of the tree `lastlight-facts` is pointed at.

### `engine` + `languages[]` — silence, made machine-checkable

`degraded[]` is prose. The envelope also carries two fields a consumer can
*compare*:

```json
"engine": "none",
"languages": [{ "id": "go", "changedFiles": 31, "parsedFiles": 0, "engine": "none" }]
```

A Go PR that produced nothing now says so in a shape **no clean run can ever
take**: a language was recognised, thirty-one files of it changed, and nothing
parsed one of them. Measured on the real corpus — keycloak `37429` reads
`[properties 45/0, java 2/0, xml 1/0]`.

- `id` comes from the extension (`languageIdOf`); a language nobody thought
  about falls back to its bare extension rather than vanishing.
- `parsedFiles` means **this run obtained a syntax tree**, in every tier:
  membership of the compiled program on tier 1, ast-grep actually parsing on
  tier 2. Not "declared parsable".
- Deletions are excluded from `changedFiles` — a file absent at head cannot be
  parsed, and counting it would manufacture the exact signal these fields exist
  to make trustworthy.
- `engine` is `"none"` for a `deps`-only run, which loads no project at all. The
  tier can be 1 while the engine is `"none"`; that is accurate, not a bug.

## The extractors

| Command | What it answers |
|---|---|
| `facts` | which hunks changed each symbol, every reference site, implementations, callees, which tests touch it. `referencesInDiff` vs `referenceCount` is the most productive field: a symbol whose shape changed and whose references are mostly OUTSIDE the diff is the cross-file contract bug, invisible because each file reads correctly alone |
| `contracts` | signature / parameter / return / nullability / thrown-type delta for every changed export, base vs head, plus `consumersOutsideDiff`. The base tree is a `git worktree add --detach` into a temp dir on the ts-morph path and a virtual-FS **overlay on the same tree** on the tsgo one (see above — they are not the same base view) — **never** mutate the agent's working tree, which is reused across runs and read concurrently |
| `constants` | **references MINUS literals.** A = references to the identifier (the type-aware engine); B = occurrences of the literal value (ast-grep, and it stays there); report A, and `B \ A` as hard-coded duplicates. `sides` is a heuristic path partition and a hint for the seeder, never a finding. This is the `1587-r2` shape — the one gold finding the whole investigation converted |
| `deps` | manifest delta, import sites, and (with `--stage`) `npm pack` of changed runtime deps into `.lastlight/pr-review/deps/`. **The staging is the affordance fix, not a nicety** — the review workspace has no `node_modules`, so "open the library source" was structurally impossible. **Six ecosystems**, not one — see below |
| `patterns` | opengrep + gitleaks, scoped to the diff, normalised into `skills/security-review/SKILL.md`'s finding shape. **Evidence, not findings** — never posted directly |
| `coverage` | changed lines executed by zero tests, read from an **existing** report. It never runs a suite. istanbul · lcov · JaCoCo · Cobertura · Go coverprofile · SimpleCov |
| `all` | one envelope, every payload — what a workflow phase writes. With `--stage-diff` it also writes the **staged diff** (`.lastlight/pr-review/diff/`), an index plus one patch per changed file. See below |
| `prepare` | **not an extractor** — installs dependencies so a probe can be RUN, and writes `probes/env.json`. See below |
| `discharge` | each `survey` branch's exit gate — every obligation the family owns carries a `QUOTE` / `ABSENT` / `PARTIAL` / `PROBE` discharge in `hypotheses/<family>.jsonl`. Degrades to the `test -s` floor on an unreadable `obligations.json` **or** on `contract: "minimal"`. See below |
| `probes` | the `falsify` loop's exit gate — every hypothesis that needed a probe has a verdict, and every claim of execution has a transcript |
| `findings` | the `adjudicate` loop's exit gate — the **conservation check**. See below |
| `toolchain` | the manifest and what actually resolved |

Three fixes must not regress. Two are carried forward from v3 and live in
`deps.ts`: the tooling denylist is **exact-match, never an `^eslint` prefix**
(the prefix swallowed `eslint-plugin-require-extensions`, the package the
`1641-r2` gold lives in), and the import scan recognises
`createRequire(...)("pkg")`. The third is `contracts`'s **`@throws` type**:

- TypeScript parses `@throws {X} prose` as a `JSDocThrowsTag` and **lifts the
  braced type out into a separate `typeExpression`**, so `getCommentText()`
  returns only the description. The old code read the type off the comment and
  unwrapped it with `/^\{(.+?)\}.*$/` — a regex that therefore never matched,
  leaving the **first word of the prose**: `@throws {ValidationError} when the
  id is empty` recorded `["when"]`. Read `getTypeExpression()?.getTypeNode()`
  first; the comment-text path stays as the fallback for the un-braced spelling
  (`@throws Foo when …`), which is the only case it was ever right for. **The
  obvious tsgo mapping re-creates this bug**: `Checker.getJsDocTagsOfSymbol`
  returns `{ name, text? }` — a flat rendered string with no separate type
  expression, which is the exact shape that produced `["when"]`. The route that
  preserves the fix is the AST (`Node.jsDoc` + `isJSDocThrowsTag` +
  `JSDocThrowsTag.typeExpression`); if it turns out the wire protocol does not
  populate `jsDoc` on a resolved handle, `throws` degrades to `null` plus a
  `degraded[]` entry, never to `[]`.
- It matters twice, and the second half is the expensive one. `throws` is
  compared **raw** in `sameShape`, with no `canonicalType` pass — so editing the
  prose after a `@throws` moved the recorded "thrown type" and manufactured a
  phantom `changed` delta out of a comment edit. And `@throws {TypeError}` with
  no prose returned `[]`: an **absence claim about a throw that is documented in
  the source**, from the extractor whose whole output is absence claims.

### `rules/review.yaml` is FIVE languages, and it has to be run to be believed

The ruleset is six families — dynamic code execution, a shell command built by
interpolation, SQL built by interpolation, weak randomness feeding something
named like a secret, disabled TLS verification, disabled cookie protection —
plus JWT verification where the language has an exact spelling for "off". It
carries them across **typescript · javascript · java · go · python · ruby**
(identifiers verified against `opengrep --show-supported-languages` on the
pinned 1.27.1, not guessed), because 40 of the 50 PRs in the pr-review corpus
are not TypeScript and a TS-only ruleset hands four fifths of the measurement
set an empty envelope. One family becomes one rule per language: a pattern must
parse in every language a rule declares, and `new Function($X)` is not Python.

**`tests/rules.test.ts` is the guard, and the thing it guards against already
happened.** The seven-rule TypeScript set that shipped with WP1 was never valid
YAML — `- pattern: $JWT.verify(…, {..., algorithms: ["none"], ...})` is a plain
scalar containing `: `, which YAML rejects, so opengrep refused the **whole
config on every run**. The envelope was honest about it (a config error reaches
`degraded[]` the same as any other), but the finding list is empty either way,
and nobody looked because no machine that ran the suite had the binary. So the
test has two halves on purpose: a dependency-free lint for that exact YAML shape
that runs everywhere, and — skipped when the binary is absent — the real
opengrep over a fixture tree holding a **true positive and a near-miss true
negative for every rule**. A rule that fires on neither is not coverage; it
reads as coverage, which is worse.

Measured on the corpus after the fix, with both binaries installed: every case
runs `coverage: "full"` where it used to carry a YAML error, and the finding
count is **0 on ordinary PRs** — which is the honest answer for this rule set
and the reason per-family attribution, not a hit count, is what decides whether
the `security` family earns more rules.

### An observation, not a defect: a rename always lands in `degraded[]`

`contracts` treats `status === "renamed"` as `expectsBoth`, and the base tree
never has the new path — `changedPaths` takes the NEW side of an `R100` line,
which is the only side that exists at head. So the one-sided guard fires on
every renamed file: a `degraded[]` entry, no delta, and **a pure-rename PR
reports `coverage: "degraded"` by construction**.

That is the conservative direction and it is the right one — the alternative is
every export in the file reading as `added`, which is the 65-phantom-removal
shape the guard exists to prevent, and IRIS measured a half-mechanism seed as
*actively harmful* rather than merely useless. Write it down so nobody reads a
degraded rename as a bug and "fixes" it. Closing it properly means resolving the
old path (`git diff --find-renames` already knows it) and comparing across the
rename; that is a real improvement, not a correction.

### `deps` reads six ecosystems, and scopes the scan to the PR

`src/manifests.ts`: npm · go.mod · pom.xml · build.gradle[.kts] · Gemfile[.lock]
· pyproject.toml / requirements.txt. It reads what a manifest **declares**, at
the version it declares — no lockfile graph, no Gradle evaluation, no parent-POM
expansion. Per-ecosystem resolution semantics is a rabbit hole and the question
is only *"what did this PR change?"*.

Measured, and it is why the file exists: keycloak's root manifest is Maven and
discourse's is a Gemfile — **neither has a root `package.json`** — so `deps`
degraded outright on ~19 of 50 corpus cases; grafana (`npm`+`go.mod`) and sentry
(`npm`+`pyproject.toml`) were worse, because they degraded on *nothing* and
covered only the JS half.

- **Scope is touched-manifests PLUS the root.** Not every manifest in the tree
  (cal.com has 140 `package.json` files, and that delta is about the monorepo,
  not the PR); not the root alone (grafana changes `package.json` and `go.mod`
  in one PR). Each change carries `manifest` + `ecosystem`, and the payload
  carries `manifests[]` rather than a single `manifest`.
- **`scope` is folded onto npm's four names** so one array is comparable across
  a mixed PR. Maven `test`/`provided` and Gradle `test*` → dev; Bundler's
  `:development`/`:test` groups → dev; a python extra → optional.
- **`--stage` stays npm-only.** Everything else reports `stagedAt: null` plus
  ONE `degraded[]` entry per ecosystem — a degraded list with sixty identical
  lines in it is a list nobody reads.
- Two traps worth keeping: go.mod's `// indirect` lines are **excluded** (they
  are the toolchain's pins, and including them buries the one line a human
  typed), and Maven `${property}` versions are resolved one level, because that
  is where a keycloak bump actually lands.

### `mutants` is CUT; `coverage` replaces it

Design review §D13. The `tests` family plausibly contributes one or two findings
across the whole gold set, which sits permanently inside §D6's detection floor —
so the ablation rung whose purpose was to decide whether mutation seeding earned
its keep could not have returned a readable answer. *"This changed line at
`src/auth.ts:73` is executed by zero tests"* is mechanical, needs no green
baseline, and costs one instrumented run rather than N mutation runs. Cutting it
also deleted `suite`, the longest wall-clock item in the pipeline. **If coverage
shows the `tests` family converts at all, mutation seeding becomes a
well-motivated follow-on** — a deferral with a trigger, not a rejection.

`coverage` here READS an artifact; producing one is WP4's `prepare`.

### `--stage-diff` — the range, written down once (lever f1)

`src/stage-diff.ts`. `all --stage-diff` writes `.lastlight/pr-review/diff/`:
`index.md` — one row per changed file with its status (A/M/D/R, and the base-side
path of a rename), its changed line ranges **in head coordinates**, and the patch
that holds its diff — plus one unified patch per changed file. The envelope
records what it did, on `stagedDiff`.

**It is a spend result and a correctness result, and the second is the bigger
one.** The five survey fan-out branches make ~93 bash calls per case; ~30 of them
re-derive ONE fixed merge-base range `facts.json` already holds, and surveys are
~75% of a case's spend. But each of those thirty is also a fresh chance to spell
the range two-dot, which is WP1b's bug 3 — the corpus number is 6,125 changed
files against 3 (`tests/merge-base.test.ts`). Writing it down converts a repeated
judgement into a read.

- **The range is not re-derived here either.** `stageDiff` is handed the
  `changed`/`hunks` the run already computed and calls `git.unifiedDiff`, which
  goes through the same private `diffRange` as `changedPaths` and `diffHunks`.
  One `git diff` per run, full context (`-U3`, not `diffHunks`'s `-U0`) because a
  model reads it, `-M` so a rename stays a rename.
- **The filename escape is INJECTIVE, and it had to be.** `/` → `__` alone
  collides `src/auth/x.ts` with `src__auth/x.ts` — one patch overwrites the other
  and the index points two rows at one file. So `_` is escaped too (`_5f_`), as
  is everything outside `[A-Za-z0-9.-]`; a path long enough to overrun a 255-byte
  name limit truncates onto a `~<hash>` tail. `src/auth/index.ts` still reads as
  `src__auth__index.ts.patch`.
- **The index is never truncated; the patch BODIES are.** `MAX_STAGED_FILES`
  (400) and `MAX_PATCH_BYTES` bound bytes on disk. Every changed file still gets
  a row, with `patch: null` and a **NOT STAGED** cell, plus one aggregate
  `degraded[]` entry — a file missing from an index that claims to be complete is
  the omission this package exists to prevent.
- **Staging failure is `degraded` at MOST.** `stageDiff` never throws: a throw
  would reach `runWrapped` and turn a complete analysis into a `coverage: "none"`
  envelope saying nothing was analysed. It records a `degraded[]` entry naming
  what half of the document is unaffected, and it writes a **loud `index.md` at
  the same path**, because the brief points a survey there and a 404 reads as a
  deployment without the pipeline. It runs BEFORE the compiler opens, so the
  patches survive an extractor that later fails.
- **`null` ≠ `[]` ≠ absent**, one more time: `stagedDiff.files` is `null` when
  staging could not run, `[]` only when the range genuinely changed nothing, and
  the whole field is ABSENT when nobody asked.

The consumer side is `src/seed-render.ts`, which gives every family brief a
**Staged diff** section — the index, the patches this family's own obligations
point at, and exactly one prohibition — *"do not re-derive the range"* — beside
the affordance it is useless without: *"the patch is your STARTING POINT, not
your scope; you are in the FULL CHECKOUT"*. That second half is measured, not
manners. The first cut said *"read the staged patch INSTEAD OF running `git
diff`"* and over-suppressed: total survey bash calls fell **848 → 399** while the
eliminated range re-derivation accounts for only ~276 of it — ~170 greps,
whole-file reads and reference traces went with it, and internal recall fell
**21/25 → 12/25**. Access never changed (the staged diff sits INSIDE the
checkout); the framing narrowed the behaviour. Three
states, three paragraphs, and the section is **never silently omitted**: an
absent section reads to a survey as *"this deployment has no staged diff"*, which
is the *we could not look* / *we looked and it is clean* conflation everything
else here is built against. Every path it prints is **checkout-relative**, and
that is measured rather than stylistic — across three stored runs, 98 of 98
relative first-turn reads from a survey branch resolved and **0 of 27**
workspace-root-absolute ones did, because the only absolute path a branch holds
is its skill bundle, one directory ABOVE the checkout.

Opt-in, like `--stage` and for the same reason: this is one of the few things
here that touches the repository under review, and `pr-review.yaml`'s `facts`
phase is where the flag belongs — on the same invocation that resolved the base.

### `prepare` — the one command that WRITES to the tree

`src/prepare.ts`. It is not an extractor: it emits no envelope, resolves no
tier, takes no `--base`, and makes no claim about a commit range. It installs
dependencies when they are absent, optionally typechecks, optionally produces a
coverage artifact, and writes `.lastlight/pr-review/probes/env.json` — validated
against `ProbeEnvSchema`, so a downstream phase reads a field rather than
grepping stdout.

It lives here rather than at the `/opt/lastlight/code-facts/bin/prepare-tree.sh`
path WP4 originally spelled, because **nothing installs that path** and the eval
harness runs `--sandbox none` on the host where `/opt/lastlight/` does not
exist. As a subcommand it resolves through §D1's order like everything else.

Four things about it that are decisions, not implementation detail:

- **It is not a second CI.** `checksState` / `ciSection` are already in the run
  context; re-deriving red/green here duplicates a matrix build on one machine
  (locked decision 11). What execution buys is a *probe*, and a probe needs an
  install, not a test run.
- **Lifecycle scripts are OFF by default**, and this is the one cost WP4 never
  priced. An install runs `postinstall` from a **pull request head** — code the
  PR author wrote, on the operator's machine — and `pr-review`'s workspace has
  never installed anything, so this phase is the first thing that could. Neither
  reason to install needs the scripts: a package-extending `tsconfig` resolves
  off files. `--lifecycle-scripts` opts in, and `env.json` records which it was.
- **`--coverage` runs the repo's test suite**, which is the wall-clock item §D13
  deleted with `suite`. It is opt-in, it takes only a command the repo itself
  named (a `coverage` / `test:coverage` script, or `--coverage-cmd`), and it
  never guesses — because after a guessed fifteen-minute run that produced
  nothing, *"no command"* and *"no artifact"* would be the same row. A **red**
  suite still counts: coverage needs no green baseline, which is the whole
  reason it replaced `mutants`.
- **Every step distinguishes "could not" from "found nothing".** `typecheck`
  is `unavailable` — never `clean` — when there is no compiler or no root
  tsconfig; `coverage` is `absent` when a command ran and produced no readable
  report, which is what stands between the `tests` family and *"well tested"*.
  `installed` is read off the filesystem at the end rather than inferred from an
  exit code, because a failed install can leave a partial tree and
  `already-present` and `installed` are the same answer to the only question a
  later phase has.

**And it re-arms the memory question.** `facts` inherits whatever tree this
leaves — on every re-review too, since the cross-run refresh is deliberately
`git clean -fdx -e node_modules`. Peak RSS on an installed tree is **unmeasured**
for the tsgo engine (the compiler is a child process), so none of the older
figures in the plan transfer. The shell-level catch is not optional.

### `discharge` — the survey's gate, and the field the contract had no room for

`src/discharge.ts`, WP3. It is each `survey` branch's `until_bash`, so exit 0
closes that branch's loop and non-zero means iterate — the same contract as
`probes` and `findings`, and not wrapped by `--never-fail` for the same reason.
It reads `obligations.json` and `hypotheses/<family>.jsonl` and answers one
question: **did every obligation this family owns get a recorded discharge —
`QUOTE`, `ABSENT`, `PARTIAL` or `PROBE`?**

What it replaces is `test -s .lastlight/pr-review/hypotheses/<family>.jsonl`,
which **one line of any content passes**. Measured on
`prreview__skillspro-1587-r1` against 31 obligations: `state.jsonl` was a single
line listing ten obligation ids and discharging none of them, `security.jsonl`
one free-form line citing no obligation at all against three, `enforcement.jsonl`
nine rows against thirteen — and the gate passed all of them. Identical
obligation sets then produced 18 hypotheses on one run and 43 on the next. The
floor was one line; it should be N discharges. Same shape as the conservation
gate that passed falsely and the model-minted ids that collided: **an
instruction is not a mechanism.**

It reads through `src/hypotheses.ts`, exactly as `findings` and `probes` do, so
no two gates can disagree about which rows exist or which family a row belongs
to (the FILENAME's, never the row's self-report). A row may discharge one
obligation (`{"obligation": "O-014", "discharge": "ABSENT"}`) or several
(`{"obligations": [{"id": "O-014", "status": "QUOTE"}]}` — the shape a survey
chose on its own); the prose is never read, because scanning a `claim` string
for `O-014` would restore *"one line of any content passes"* through the back
door.

`null` ≠ `[]`, three ways, and the exit codes carry the distinction: **no file**
is *nobody looked* (exit 2, nothing to grade); an **empty file** is *looked,
recorded nothing* (exit 3 when anything is outstanding); a family marked **NOT
MEASURED** in `obligations.json` passes, with a note saying why, because failing
a family for the absence of the thing it audits is how a gate takes a run down.
A family with zero obligations passes too. Any non-zero means *iterate again* —
the 2/3 split is for the human reading the phase log, not two instructions.

Four decisions that are decisions:

- **With no readable `obligations.json` it DEGRADES to the `test -s` floor it
  replaces** — one parsed row passes — and says in its output that it graded
  nothing. `pr-review.yaml` runs `seed … || true` and a `coverage: "none"`
  envelope writes no document at all, so a gate demanding one would be
  unsatisfiable by the agent. That is WP3's original `$LL_FAMILY` bug exactly (a
  gate testing `hypotheses/.jsonl`, failing forever, burning every iteration),
  and it is the failure mode this file guards hardest against.
- **It degrades the same way on `contract: "minimal"`, and it is the same rule:
  never grade a contract the block did not ask for.** `seed --contract minimal`
  (`review.analysis.obligationContract`) renders the pre-2026-08-23 block — no
  `discharge` field on the prescribed row, no id checklist, no exemplar — as the
  CONTROL for that day's result. Measured compliance under exactly that block was
  **0/31, 0/34, 0/40**, so grading it would fail every family of every run over a
  field nobody was told to write. The mode is stamped into `obligations.json` by
  the seeder, so the block, the gate and the artifact read ONE field; a
  render-time flag would have let the first two disagree. `--ledger` says NOT
  APPLICABLE rather than reciting a contract the run never issued, and
  `renderDischargeCheck` suppresses the per-obligation todo list, whose detail
  line is imperative and would read as the failure the note is denying.
- **An unknown `--family` is the opposite case and stays fatal.** Nothing an
  agent writes can fix a misspelled or unset flag, so it breaks loudly at the
  wiring. An empty `--family` is refused at the CLI door.
- **The code is read case-insensitively, and `discharge` is accepted beside
  `status`.** A survey already wrote `status` unprompted; refusing a spelling
  the model reached for buys nothing but an iteration. The collision this
  creates is with the obligation's OWN `discharge: quote | probe | either`
  requirement field — which is why `seed-render.ts` now prints that field as
  **`expects:`**. The row's `discharge` is an ANSWER (one of the four codes);
  the obligation's is a REQUIREMENT (what it is *likely* answerable by), and
  `either` is not one of the four, so a model copying the label it just read
  landed `bad-code` and could not satisfy the gate however many iterations it
  spent. One word of separation removes that.
- **`--ledger` always exits 0.** Same reading, opposite audience: the gate
  answers the harness (*may the loop stop?*) with an exit code; the ledger
  answers the SURVEY (*what must I still answer?*) with a `[x]`/`[ ]` checklist
  of every obligation and its question, and inside an agent's own bash tool the
  gate's non-zero would read as a tool failure. Nothing in it is capped — a
  truncated checklist reproduces the omission it exists to prevent — and the
  outstanding list wraps.

It is **pure**: it reads two artifacts and writes nothing. There is no
`--repair` analogue here and there must not be — a machine that manufactured
discharges would be inventing the exact evidence the pipeline exists to demand,
and a survey's §D12 floor is the loop's own `max_iterations`. What it
deliberately does not do: read a quote, resolve a `path:line`, judge a claim, or
check that an `ABSENT` really is absent. It checks that the work was *recorded*,
per obligation.

The other half of the fix is in `src/seed-render.ts`, because the contract and
the mechanism must not be separable: the block's prescribed row shape now
carries `discharge` (and `failureScenario`), lists **every** id that needs one
(wrapped, never truncated), points the survey at `discharge --ledger`, and ends
with **one worked exemplar** — a real `PARTIAL` row from a real run, chosen
because the measured run discharged that obligation `QUOTE` against a line that
merely *mentions* the constant, looked perfectly discharged, and reported
nothing. `renderFamilyBlock` also never returns `""` any more: every seedable
family always gets a block, so a **missing** file means the seeder failed rather
than being confused with "nothing to say" or "the consumer looked in the wrong
place". `tests/seed-render.test.ts` parses the rendered exemplar back out and
feeds it to `checkDischarge`, so the emitted shape cannot drift out of the
gate's reading.

#### And then recall went to zero — `seed --contract full|minimal`

On the same comparator case (`prreview__skillspro-1587-r2`, `--repeats 3`) that
change took discharge compliance 0/33 → **33/33** *and* the union of matched gold
**4-of-5 → 0-of-5**, three repeats running, with half to two thirds of every
hypothesis becoming a *clean quote* — `QUOTE` with `failureScenario: null`, "I
found the line and it is fine" (23, 25 and 30 clean of 45, 48 and 46). Two
variables moved in one commit and the run cannot separate them: the obligations
may ask the **wrong question**, and making a wrong question mandatory turns
hunting into checklist-clearing (C1); and/or **reliable seeding itself suppresses
discovery** (C2 — the same commit stopped ~24% of survey branches losing their
seed entirely).

So both blocks live in `seed-render.ts`, selected by
`ObligationsDocument.contract` and driven by `review.analysis.obligationContract`
→ `lastlight-facts seed --contract`. `full` is the default and is byte-identical;
`minimal` is this file's block exactly as it stood at `5fa06da1^`, restored from
the diff rather than reimagined. Two deliberate exceptions, each named at its
site: the **never-empty rule holds under both**, because it is the DELIVERY half
of that commit and the control exists to hold delivery constant while the
question changes; and the per-obligation label goes back to `discharge:` under
`minimal`, because the `expects:` rename closes a trap that needs a row-level
`discharge` field to spring and `minimal`'s row has none.
`apps/server/src/engine/review-spec.ts` mirrors the same switch so the sixth
(`spec`) axis moves with its five siblings — as the same four removals, **not**
as a revert of that file to its own pre-change text, which carried `N/A` and no
row shape at all and would have corrupted the instrument rather than the
variable. `review-spec.test.ts` pins the two renderers against each other under
**both** contracts.

Two things that are true and are not obvious. **`minimal` is not "no discharge
contract"** — the four codes and *"Reading a file is not a discharge"* predate
the bug; what `minimal` removes is the three lines that made a code
*recordable*, which is why compliance measured zero under it. And **`--contract`
is refused rather than defaulted on an unrecognised value**: a typo'd control arm
that fell back to `full` would run, produce a number, and report it for an
experiment that never happened, which nothing downstream could detect.

#### `seed --mint` — the two D2 rules for defects the original rules cannot see

Every original minting rule requires references **outside** the diff, so a
defect wholly inside a new hunk is invisible to all four (the D2 finding:
`1667`'s `strictDryRun`, declared and solely referenced inside the diff, minted
nothing across five arms). `--mint <spec>` is a comma-list enabling two
additional rules, both **off when the flag is absent**:

- **`all-in-diff`** — `seedAllInDiff`: a `contract`-family obligation for a
  changed **runtime** symbol (`function|method|variable|class`; a pure type has
  no runtime line a caller can be surprised by) whose every reference is also
  inside the diff. The predicate compares the **uncapped counts**
  (`referencesInDiff === referenceCount`), never the capped `references[]`
  array, where `.every(r => r.inDiff)` can be vacuously true. Candidates are
  the in-diff reference sites; rank base `ALL_IN_DIFF_WEIGHT = 45` sits below
  `state` so these rank last inside the `contract` family and its ceiling
  truncates them first, auditable in `dropped[]`.
- **`registrations`** — `seedRegistrations`: a `security`-family obligation
  ordering the route/hook registrations a symbol makes, from the
  `registrations` fact (**tier-1 tsgo only**; tier 2 writes `null` = nobody
  looked, and `null ≠ []` as everywhere in this package). The extractor is
  deliberately conservative: `addHook`/`on`-style needs a string-literal arg,
  route verbs need a `/`-prefixed literal path, so `map.get("x")` and
  `emitter.on(handler)` never mint. Module-level registrations outside any
  declaration attach to no symbol — a known, documented limitation.

Like `--contract`, an unknown token is **refused (exit 2), never defaulted**,
and what was asked is stamped into the document (`minting: {allInDiff,
registrations}`) so an artifact read months later answers "which arm produced
this". Both rules widen GENERATION — the direction that has bought recall
before (locked decision 2) — and neither touches `seed-render.ts`.

#### Per-family ceilings — a pooled budget is a budget the loudest family eats

Truncation is **per family**, and `--max-obligations` is only the total
backstop over it:

| family | ceiling |
|---|---|
| `contract` | 12 |
| `enforcement` | 12 |
| `state` | 8 |
| `security` | 8 |
| `tests` | 8 |
| **`--max-obligations` (`review.analysis.maxObligations`)** | **48 — their sum** |

`FAMILY_CAPS` in `src/seed.ts`. Each family keeps its own obligations in the
existing global-rank order, truncated at its own ceiling; the backstop is
applied afterwards and drops the lowest-ranked across families only if the
post-cap total still exceeds it. At the shipped default it **cannot bind**, and
that is the point of the number — raising one ceiling stays a bounded act
instead of an unbounded one.

What a single pool did wrong, measured across the eight gate cases: `contract`
minted **89** obligations while `security` minted **3**, and 35 obligations went
into `dropped[]` carrying the words *"These are NOT 'checked'"* — so a family's
questions went unasked because a **different** family had a lot to say, which is
not what a ranking is supposed to mean. Two of `1667`'s five gold findings are
security-family.

`FAMILY_FLOOR = 5` / `applyFamilyFloors` was the first attempt and is
**superseded**: a reserve still competes inside one budget, so it displaced
`contract` slots on exactly the heavy-mint cases, and it is a suspect in the
recall regression measured after it landed. Two things make ceilings the right
shape rather than a bigger floor:

- **The cost is PER BRANCH, not per document.** Each family's obligations feed
  exactly one survey branch, so a pooled cap bounds the *sum* while the thing
  that actually costs money and context is the fattest single branch. A ceiling
  bounds that directly; a pool never did.
- **Cross-family ranking prices incommensurable things against each other.** A
  `contract` rank of 91 and a `security` rank of 41 are two points on a
  mechanism-CLASS ordering, not on one scale. Ranking *within* a family is
  meaningful; subtracting one family's questions from another's on the strength
  of those numbers is arithmetic nobody has evidence for.

Four properties, each pinned by `tests/seed.test.ts`:

- **A family's excess costs only that family.** `contract` 89 + `security` 3
  → 12 and 3. The same `security` count survives whether its neighbour minted 4
  or 400 — structural, not arbitrated.
- **An under-cap family is untouched.** No slot is reserved from anyone, so a
  family minting two gets two and gives up nothing.
- **Deterministic, ids still ascending with rank.** One pass over the
  globally-ranked list keeping each family's first `cap` entries, so the
  survivors come back in that same global order and one input yields a
  byte-identical document.
- **The backstop binds only after the ceilings**, taking the lowest-ranked
  across families — the one place cross-family ranking still decides anything.

Nothing here is tuned; when a ceiling is measured to bind on something that
converts, this is the table that moves. The truncation is still counted once per
dropped obligation in `dropped[]` — **one reason per family**, naming that
family's ceiling, plus one for the backstop, so a reader comparing two families'
counts can tell *"little to say"* from *"truncated at its own ceiling"* — and the
coverage set is still sealed before any model call.

The sixth family, `spec`, has the same shape under a different owner: it is
seeded harness-side by WP0's `review-spec.ts` under its own
`review.analysis.maxSpecObligations`, and it is deliberately not in this table
because this package cannot see the PR body or the linked issue it comes from.

### `findings` — conservation, and the floor that makes it a mechanism

`src/findings.ts`, WP6c. It is the `adjudicate` phase's `until_bash`, so **exit 0
closes the loop** and non-zero means iterate again — the same contract as
`probes`, and for the same reason it is not wrapped by `--never-fail`.

#### Identity is assigned at ingest, not minted by the model

`src/hypotheses.ts` is the one reader `findings`, `--ledger` and `probes` all go
through, so no two gates can disagree about which claims exist. Every row gets
**`<family>-NNN`** — the family from the FILENAME, the ordinal from its position
in an append-only file. Both halves were bought with a measurement on the first
real run (`prreview__skillspro-1587-r1`, 30 hypotheses, six families):

- **Collision.** `contract.jsonl` minted `H-001..H-005` and `security.jsonl`
  independently minted `H-001..H-003`. The old reader keyed a flat map on the
  string with first-write-wins, so the three security claims were **discarded on
  read**, and the gate reported `5/5 accounted for` and exited 0 while three
  hypotheses had never been adjudicated. **A gate that passes falsely is worse
  than no gate** — it converts an omission into a green light.
- **Absence.** Only **8 of 30** rows carried an `id` at all; the rest were
  free-form (`{claim, obligations}`, `{claim, producer_side, consumer_side}`, …).
  Conservation saw only the compliant subset, so **22 of 30 real claims were
  structurally invisible** — including every hypothesis about a gold finding that
  run missed. `probes` had the same hole from the other side: it gated on
  `typeof row.id === "string"`, which silently excused a free-form row from ever
  needing a probe, Criticals included.

Compliance was 27% on that run and reportedly 100% on the one before, which is
the tell: **an instruction is not a mechanism**, the same lesson §D11 records
about conservation itself. A model-minted id is still honoured, as an **alias** —
but only when unambiguous. An id two families minted resolves to NEITHER and is
reported as `ambiguous`, naming both claimants, because crediting whichever file
sorted first is precisely the silent mis-attribution above. Canonical ids always
beat aliases, so a row declaring `contract-001` from third position cannot
capture citations meant for the real first row.

Replayed against that run's kept workspace: `5/5 accounted for, exit 0` became
`2/30, exit 3` with the three collisions named — and `--repair` conserves all 30
across all six families.

It enforces one property: **every hypothesis id across `hypotheses/*.jsonl`
appears in `findings.json` with exactly one disposition** — carried by a finding
(`findings[].hypotheses[]`) or deleted by a `dropped[]` entry whose `refutedBy`
names a probe transcript **that exists on disk**. In neither list fails; in both
fails; a cited id no `.jsonl` ever declared fails *distinctly*, because
inventing provenance and losing it read the opposite way.

**Why it is a gate and not an instruction.** §D11 is blunt: an adjudicator
reading 30 hypotheses and writing 6 findings *"would have passed every gate in
this plan"* — which is v2, which worked mechanically and cost recall anyway
(micro-recall 1/25 → 2/25, precision canary regressed, cost 2.4×; BitsAI-CR
reproduced the trade independently at 54.5 → 67.1 precision for 45.5 → 39.8
recall). A unit test can check the plumbing; it cannot check a model's
compliance. This makes silent omission impossible by construction. It is also
what WP8 needs: *internal recall* and the auditable `internal` tier are not
computable unless every hypothesis has a recorded disposition.

Four decisions in it that are decisions, not implementation detail:

- **`--repair` is the §D12 FLOOR, and it never deletes.** Every uncovered
  hypothesis is appended at `tier: "internal"` — recorded, never posted —
  carrying its `family`, `obligation`, `claim` (as the body), `existingCode`,
  and a `path` derived from `bothEnds.introducedAt`. Every drop whose transcript
  is missing is **un-deleted**: the entry goes and the record comes back at
  `internal`. **An unjustified deletion becomes a recorded non-deletion**, which
  is the whole asymmetry of the work package expressed as code — and it means
  the floor can never be reached by dropping everything. It rewrites the file,
  exits 0, and is idempotent. A **duplicate** is reported and left alone: the
  gate cannot know which disposition was meant, and guessing is the deletion it
  exists to prevent.
- **A finding with no `hypotheses` field fails nothing.** Those are the shipped
  reviewer's own findings, which were never hypothesis-derived. Requiring the
  field would make them unpostable — a recall loss dressed as a conservation
  win. They are counted in a note, not audited.
- **No `hypotheses/*.jsonl` at all ⇒ it passes.** The pipeline being off is not
  a finding, and this must never fail a run for the absence of the thing it
  audits. The note says so, so that pass is never read as *"the adjudication was
  complete"*. A missing or unparseable `findings.json` is the separate failure,
  and it fails — the loop should get another iteration to write one. `--repair`
  deliberately **does not invent one**: a fabricated `summary`/`event` is a
  review nobody wrote, and a loop that merely runs out of iterations does not
  fail the run anyway.
- **`FindingsDocumentSchema` is LOOSE at every level** (`schema.ts`). The real
  contract lives in `apps/server/skills/pr-review/references/findings-schema.md`
  and the adjudicator writes a superset — `mechanism`, `bothEnds`, `evidence`.
  A schema that stripped unknown fields would turn the floor's rewrite into
  silent data loss: the gate would delete the evidence packet in the act of
  preserving the finding. `--repair` mutates the object parsed from disk, not
  the one zod handed back, so key order survives too. `dropped[].hypothesis` is
  `optional()` for a second reason — a required one would report a missing id as
  *"unparseable document"* (a zod dump instead of the actionable line the next
  iteration needs) **and** make the floor's pre-write validation throw on a
  document it was mid-rescue. A floor that can crash is not a floor. The same
  rule made the advisory string fields (`obligation`, `path`, `title`, `body`,
  `severity`, `family`, `existingCode`, `confidence`) **`.nullish()`** on
  2026-08-25: models write literal `null` for "nobody looked" — this package's
  own convention — and `.optional()` rejected it, so six of sixteen real
  adjudications were "unreadable" to the gate on `"obligation": null` alone,
  each buying a forced extra loop iteration *plus* a silently dead repair
  (`--repair` refuses an unreadable document).
- **The `internal[]` id-list is ACCEPTED, expanded by `--repair`, and
  deliberately not advertised to the adjudicator.** A document may carry a
  top-level `internal: ["contract-001", …]`; each entry credits exactly one
  disposition through the same `creditTo` path as a finding citation
  (duplicates, ambiguous model-minted ids and fabricated provenance fail the
  gate unchanged), and `--repair` materialises every resolvable entry into a
  full internal-tier row via `internalFinding()` — running **even on a
  satisfied document**, because post-review's disposition record, the pipeline
  stats and the internal-recall judge all read full rows. An unresolvable
  entry stays in the list, reported, never silently deleted. **Do not teach a
  prompt to use it.** It was prompted once (2026-08-25) and reverted the same
  day: with bare-id filing available the adjudicator bulk-filed internal and
  stopped promoting — posted findings fell from 5-8 to 1-3 per case and
  micro-recall collapsed on the live band. The full-row cost is the friction
  that makes the model look at each claim; the code support exists so a
  document that *arrives* with the list is conserved rather than rejected
  (`tests/findings.test.ts` pins all of it).

Output is capped at 20 named ids plus a `+N more`, on both the gap list and the
repair list. It goes into an agent's context, and *"3 hypotheses unaccounted
for"* without the ids cannot be acted on by the next iteration — being acted on
is the entire point.

#### `--ledger` — the same reading, the other audience

`checkFindings` answers the HARNESS ("may the loop stop?") with an exit code.
`buildFindingsLedger` answers the ADJUDICATOR ("what must I account for, and
what have I not?") with a list: every declared id by family, with its obligation,
severity and path, marked `[x]`/`[ ]`, plus an outstanding set. Both read through
the same `inspect`, so the checklist and the verdict cannot disagree about which
ids exist — which is the reason it lives here rather than in the prompt as an
instruction to go and count.

It is what makes the gate satisfiable on the FIRST attempt. Measured on
`prreview__skillspro-1587-r1`: attempt 1 spent **426 s and $0.52** reconstructing
the id set from six `.jsonl` files, missed some, and bought a second **274 s /
$0.43** attempt — 40% of the case's wall clock and 38% of its cost, for a set
that is mechanically derivable.

Three properties that are decisions:

- **It ALWAYS exits 0**, unlike the two gate modes beside it. Its caller is the
  agent's own bash tool, where the gate's non-zero *"iterate again"* would read
  as a tool failure. Two audiences, two exit contracts; conflating them is how
  the checklist would come to be treated as the gate.
- **Nothing is capped.** `renderFindingsCheck` stops at 20 ids because it is a
  log line; a checklist that elided entries would reproduce the exact omission it
  exists to prevent. The bound is on each claim (`titleFrom`, one sentence) and
  the outstanding list WRAPS rather than truncating.
- **An unreadable `findings.json` means every id is outstanding**, not zero.
  `inspect` early-returns with no gaps in that case — correct for the gate, which
  fails on the document error alone, and a lie of omission for a checklist.

`fresh_context: true` on the `adjudicate` loop is what makes re-running it the
whole retry mechanism: iteration 2 carries no prior transcript
(`phase-executor.ts` passes `previousOutput: ""`), so the ledger is how a retry
learns what is left — freshly, rather than from stale plumbing.

What it deliberately does **not** do: read a transcript, judge a verdict,
validate a quote, or check anything about `summary` / `event` / `verdict`. Quote
*resolution* is checked upstream; quote *semantics* still is not. v3's five-line
gate earned the investigation's only gold match and v2's full validator is what
made it expensive.

## `toolchain.json` — the single source of truth

Design review §D3. Three consumers: `sandbox-base.Dockerfile` reads it as build
ARGs (WP2 — which also fixes the floating `pipx install semgrep` and
`astral.sh/uv/install.sh`), this package probes and **stamps** what resolved into
every envelope, and the eval preflight refuses on a mismatch.

The npm-resolved engines are deliberately **not** in it: `package.json` +
`pnpm-lock.yaml` are the stronger pin, and a second hand-maintained copy is the
drift the file exists to prevent. Their resolved versions are stamped from the
installed packages instead. **That covers the `tsgo` executable too** — it is an
npm `optionalDependency` resolved by `getExePath()` relative to the installed
`typescript` package, not a binary downloaded from a release URL, so it belongs
in the bundled-version stamp and not in `binaries` with a fabricated `sources`
entry. What it does need is the same guard WP1c wrote for the native grammars:
**probe that the executable exists and fail loud at probe time**, because the
platform package is the one thing about this compiler that a `pnpm install` on
another OS can silently omit.

Binaries resolve `LASTLIGHT_<TOOL>_BIN` → `PATH` → `/opt/lastlight/bin/<tool>`
(§D1). `resolveFactsBin()` applies the same order to this CLI, under the name
§D1 gives it: **`LASTLIGHT_FACTS_BIN`**.

A version that resolves but does not match the manifest is stamped `mismatch`,
**not** treated as failure. The point is that the deviation is recorded, so
"which toolchain produced this scorecard?" stays answerable weeks later.

**`sources` is per-platform** (`linux-x64` · `linux-arm64` · `darwin-arm64` ·
`darwin-x64`, keyed exactly as `platformKey()` derives them from
`process.platform`/`process.arch`). It was one hardcoded linux/x86 URL per tool
— in the file whose third consumer *"refuses on a mismatch, printing the
commands to fix it"*, so on darwin it printed a command that could not work, on
the package that exists precisely so a Mac at `--sandbox none` can be measured.
Both streams publish darwin builds at the pinned versions
(`opengrep_osx_arm64`, `gitleaks_8.21.2_darwin_arm64.tar.gz`) — the manifest was
the limit, not the platform. **Verify an asset name against the real release
before writing it; do not guess.** `platformKey()` returns `null` on anything
else rather than defaulting to linux, because a wrong install command is worse
than an absent one: the operator runs it and it half-works. Every stamp records
which build the host wanted (`toolchain.binaries.<tool>.platform`), and the
manifest is at **schema version 2** because of the `source` → `sources` change.

`sandbox-base.Dockerfile` selects gitleaks on `TARGETARCH`, which is also what
unbreaks an arm64 image build.

## Rules

- **Every diff is against the MERGE BASE, never the base branch's tip.**
  `base...head`, which is what GitHub's "Files changed" tab shows. Two-dot
  additionally contains every commit that landed on the base *branch* since the
  PR forked, and the author wrote none of it. This is a PRODUCTION shape, not a
  dataset artefact: the workflow reads `pull_request.base.sha` — the tip at event
  time — so a review against a busy base branch analysed thousands of untouched
  files and generated obligations about unrelated code. Measured across the
  50-PR Martian corpus, 9 of 50 cases diverge:

  | case | `base..head` | merge base |
  |---|---|---|
  | sentry-greptile-1 | 6125 files | 3 |
  | sentry-greptile-94376 | 1281 | 7 |
  | grafana-90939 | 142 | 1 |
  | keycloak-40940 | 82 | 4 |

  That first case alone was the corpus's only >90 s run (157.9 s) and its 2.7 GB
  peak-RSS ceiling. `prepare()` resolves the fork point ONCE and threads it
  through, so the envelope's `baseSha` records the commit actually compared —
  which matters because `contracts` materialises the base worktree from it, and
  comparing against the tip rather than the fork point is precisely the asymmetry
  that produces phantom deltas. With no merge base (unrelated histories, a
  shallow clone) the run degrades with a named `degraded[]` entry rather than
  falling back silently; `tests/merge-base.test.ts` is the guard on both halves.
- **`repo` is normalised to an ABSOLUTE path on the way in**, in `runExtractor`
  and again in `loadProject`. `--repo .` used to disable tsconfig discovery
  outright: `nearestUp` guards its walk on `dir.startsWith(repo)`, and
  `join(".", "apps/server/src/x.ts")` normalises the `./` away, so
  `"apps/server/src"` does not start with `"."` and the walk never ran. Every
  changed file was filed under *"covered by no tsconfig"* and the whole diff fell
  through to the **glob** fallback — no `strict`, no `jsx`, no `paths`. Measured
  on this repo at `c8530b83`: `--repo .` reported 31 files globbed against the
  absolute spelling's 1, and that is the spelling in the example at the top of
  this file. Named in `degraded[]` throughout, so it was a coverage bug and never
  a loudness one. `tests/multi-project.test.ts` pins both halves.
- **No `console.*` outside `cli.ts`.** Every module takes
  `log: LoggerPort = noopLogger`. `cli.ts` is a terminal entry point and is the
  exception.
- **Every document validates against its zod schema before it is written**
  (`run.ts`). A document that fails its own schema throws, which the wrapper
  turns into `coverage: "none"` — better than putting a malformed obligation set
  in front of the model.
- **Fixtures are real git repos with real commits** (`tests/helpers.ts`), not
  mocks. Every claim here is a claim about what `git diff` and a type-checker
  say; mocking either would let the claim be wrong while the test passed.
- **A bound is only a guard if you also pin the number it would be WITHOUT the
  fix.** `contracts` once reported 227 deltas of which one was real, and *every
  unit test passed throughout* — because no fixture was big enough to exhibit
  any of the causes. `tests/noise-floor.test.ts` pairs each ceiling with a floor
  measured on `makeMonorepoFixture()`, a ~40-file two-package repo carrying all
  three causes at once (asymmetric tsconfig, unresolvable externals, reordered
  type text). The floors are `toBeGreaterThan`, never exact values — an exact
  number is a snapshot. `withWorktree(…, { mirrorNodeModules: false })` exists
  for exactly that: it is how the mirror's value becomes a number.
- **`null` means NOBODY LOOKED; `[]` means looked, found none.** The founding
  distinction of this package, and it was being collapsed in the three fields
  that carry it. `ConstantFact.references` is `null` on tier 2 (there IS no set
  A) and an array on tier 1; `SymbolFact.implementations` is `null` for a kind
  the question does not apply to and for a query the language service threw on;
  **`ConstantFact.sides` is `null` whenever `references` is** — it is a partition
  OF that set, and it used to emit an all-zeros record built from a reference set
  that does not exist. `{server: 0}` from no data is indistinguishable from
  `{server: 0}` measured, and "zero server-side references" is the exact shape of
  the one gold finding this investigation ever converted, so a false one is
  expensive. `sideDefinitions` ships either way, so the partition stays
  auditable. Never write `?? []` on any of the three — that was the M6 bug, in
  the extractor that makes ABSENCE claims, and tier 2 is heading for ~80% of the
  corpus.
- **An extractor that stops early must say so.** `findLiteralOccurrences` returns
  a truncation flag beside the hits and `extractConstants` turns it into a
  `degraded[]` entry naming the ceiling, how many files were eligible and how
  many were read. It used to stop at `--max-files` with no record at all, so set
  B was an arbitrary filesystem-order PREFIX of the repo while the document
  looked complete — reachable on 20 of 50 corpus cases (sentry has 7,255
  analysable files at head against a 6000 default). An absence claim over a
  truncated file set is not weak, it is **unsound**.
- **THE FILE SET COMES FROM GIT, NOT FROM `readdirSync`** — `git.listFiles`, and
  every scan in this package goes through it. `git ls-tree -r -l -z <headSha>`
  for set B, `git ls-files` for the ts-morph glob fallback (which parses off
  disk, so it wants the working tree). Four things follow from that one change
  and each was a bug:
  1. **`.gitignore` is honoured by construction.** An ignored file is not in the
     tree. Nested `.gitignore` files, `.git/info/exclude` and global excludes
     come with it — none of which a flat denylist can see, and the two worst
     offenders on this monorepo were exactly those shapes.
  2. **The scan resolves at the head COMMIT.** `hardCodedDuplicates` is a list of
     `path:line` citations and the envelope stamps `headSha`; reading the working
     directory made every one of them a claim about the checkout instead, wrong
     and invisible whenever a reused review workspace was not at head.
  3. **Build output and vendored checkouts vanish.** Measured on this repo at
     `HEAD~1..HEAD`, one run over ten changed constants: **44,633 hard-coded
     duplicates → 4,201**, of which **41,079 came from
     `apps/server/data/sandboxes/**`** — cloned review workspaces, gitignored,
     under a name no denylist would ever have carried. (The 2,663 figure that
     motivated the stage-0 denylist widening was one constant of the ten; it is
     now 319.) Peak RSS 2.24 GB → 0.82 GB, wall clock 12.6 s → 3.3 s.
  4. **The ceiling meant something again** — the repo-root glob went from 9,399
     files, over the 6000 ceiling and therefore *dropped* whole, to 731 and
     loading. (That half dies with the ceiling; the first three do not.)
  `isIgnoredPath` survives as a **residual** denylist, not the mechanism: the
  committed `dist/`, the vendored `third_party/`, a checked-in `*.min.js`. It is
  also the only filter the walk fallback has. Paired with a 512 KB size ceiling
  (free — `ls-tree -l` reports the blob size, so an oversized bundle is never
  read) and `looksMinified` for a bundle under an innocent path.
- **The walk fallback is NAMED.** When git cannot enumerate (not a repo, an
  unresolvable ref, a partial clone) the old `readdirSync` walk still runs, so
  the package does not hard-require a git repo where it never did — but
  `FileListing.reason` is populated and `extractConstants` puts it in
  `degraded[]`. Walk-tier output honours no `.gitignore` and describes the
  checkout rather than a commit; a consumer that read it as tree-tier output
  would be over-trusting it, which is the same mistake as reading tier 2 as
  tier 1.
- **Known, not fixed: `facts` and `contracts` still read HEAD off the
  filesystem** while their changed set comes from git. On a workspace that is not
  at `headSha` they analyse one tree and cite another. On the tsgo path this is
  **wider**, because the overlay's base view falls through to the working tree
  for every file the diff did not touch — see the dirty-tree section above, which
  is where the `degraded[]` entry this wants is written up. A deferral with a
  trigger, not an oversight.
- **The CLI's import of this package must stay dynamic.** A vendored compiler
  (ts-morph, ~14 MB) or a spawned one (`typescript` + its ~26 MB platform binary)
  must never be on `lastlight login`'s startup path. The second is worse than the
  first, not better.

## `pnpm selfcheck` — the census against a real commit

`scripts/selfcheck.ts` runs `all` against this repo (`--base` defaults to
`HEAD~1`) and prints the delta census: **how much of the diff was analysed and by
which programs**, counts by change type, the top 20 symbols by
`consumersOutsideDiff`, the tier, every `degraded[]` reason, and the wall clock.
It exits non-zero on a `removed` delta with no deletion or rename in the diff, on
more than 40 contract deltas **that could be phantom**, or past 90 s (AC6).

**It cross-checks against git — `git show`, `git diff --name-status`, `git diff
-U0` — never against a compiler**, which is what makes it a valid referee for an
engine swap. An oracle built from the same machinery as the thing under test
cannot see a plausible-and-wrong answer, because both halves are wrong in the
same direction.

That qualifier is not a relaxation. The ceiling was calibrated when the loader
compiled one tsconfig for the whole diff and therefore analysed 1 of this repo's
31 changed source files; one program per tsconfig analyses 30 of 31 and the raw
count went to **220 — every one of them an `added` export in an `added` file**,
which is trivially true and cannot be a phantom. A ceiling that a COVERAGE fix
trips is a ceiling measuring the wrong thing, so it now counts `changed`,
`removed`, and `added`-in-a-pre-existing-file. On the 227-delta commit that
motivated the guard, that count would have been 227.

**Not in CI, deliberately** — `actions/checkout` defaults to `fetch-depth: 1`,
so `HEAD~1` does not exist on a runner. Run it before you change an extractor.
`--tsconfig` is now the escape hatch it reads as, not the routine workaround it
used to be: it FORCES one program for the whole diff — which is what the loader
did on every run before, and what made the "analysed" line above read 1 of 31 —
and it also **disables the glob fallback**, because a caller that named a project
did not ask for one to be quietly globbed around it.
