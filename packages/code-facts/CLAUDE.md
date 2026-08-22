# `lastlight-code-facts` — the deterministic layer

Program analysis of a pull request, emitted as JSON. No model spend, no network
(unless you ask for `--stage`), and no dependency on the rest of the workspace.
It is the substrate every later phase of the PR-review evidence pipeline reasons
over — see
[`docs/plans/review-evidence-pipeline/01-code-facts.md`](../../docs/plans/review-evidence-pipeline/01-code-facts.md)
(WP1) and
[`10-design-review.md`](../../docs/plans/review-evidence-pipeline/10-design-review.md).

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
OOM (--max-files raised),  "   → exit 134, NO envelope                        ✗
```

Reachable two ways: raising `--max-files` past what the heap can hold (the
default 6000 ceiling degrades gracefully instead, which is the whole reason it
exists), and any segfault in the `@ast-grep/napi` native binary.

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

## The TS 7 landmine

**TypeScript 7 has no programmatic compiler API** — `tsgo` is CLI + LSP only.
Three rules, not negotiable:

1. **`ts-morph@28` is the engine.** It vendors its own compiler (currently TS
   6.0.2) and carries **no `typescript` dependency**.
2. **Never resolve `typescript` from the repo under review.** A
   `require.resolve("typescript", { paths: [repoDir] })` anywhere here is a bug
   that breaks every TS-7 target, which is now most of them.
   `tests/compiler-isolation.test.ts` enforces it, with comments stripped first
   so the doc comments that *name* the forbidden shape do not trip it.
3. **The `tsgo --lsp --stdio` fallback is a seam, not a build.** `loadProject`
   returns a tier plus a reason instead of throwing, which is where an
   LSP-backed reference provider would plug in. Build it when a tier-2 repo
   actually blocks a measurement — not before.

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
it substitutes for and under the 2 GB agent cap. `constants` is unchanged to the
byte and to the megabyte — A/B'd on this repo, 7,992 hits both ways, 406 MB both
ways — because `interestingKinds` asks the parser only for the node kinds the
caller's sink can use, and the literal sweep's sink asks for four.

## ONE PROGRAM PER TSCONFIG — the tier is not the coverage

`loadProject` returns **a group per tsconfig the diff touches**, not one project
for the diff. It used to return one, and the corpus measured what that cost: over
50 real PRs, **58 of 8,514 changed files were analysed — 0.7%**, with
`grafana-90939` reporting **tier 1** on 1 file of 142 and `cal-com-22532`
reporting **tier 1** on 0 of 17. Every one of those runs carried the shortfall in
`degraded[]`, so this was never a loudness bug: the package was honest, and
blind. Nearest-first picks one tsconfig, and a monorepo diff (cal.com: 26
tsconfigs, 140 `package.json` files; grafana: 29) is covered by none of them.

Measured on this repo's own WP1 commit, `pnpm selfcheck`: **1 of 31 analysable
changed files → 30 of 31**, across 4 programs. On the corpus spot-checks:
cal-com-22532 `0/12 → 12/12`, cal-com-11059 `1/38 → 38/38`, cal-com-10967
`4/22 → 22/22`. grafana-106778 was already `12/12` and stayed there — where one
tsconfig genuinely covered the diff, nothing changes.

Four things hold it together, and each is load-bearing:

- **`maxFiles` is a TOTAL across groups, and the total is ALLOCATED rather than
  spent.** See "the budget is shared out" below — this is the one thing here
  that was rebuilt after the multi-project loader shipped.
- **Every group's size is known BEFORE anything is parsed** — the glob from
  `git ls-files` (`globCandidates`), the tsconfig from
  `ts.getParsedCommandLineOfConfigFile` (`tsConfigCandidates`). Letting ts-morph
  glob the repo root and checking the count afterwards took `pnpm selfcheck`
  from 774 MB to **4.5 GB** of peak RSS — for a program rejected on the next
  line for being over the ceiling. The tsconfig half had exactly the same bug
  and kept it a release longer: measured on sentry's root tsconfig, **112 ms and
  211 MB to LIST 7,230 files against 3.6 s and 1.29 GB to compile them**, and
  the loader compiled them, counted them, found them over budget and threw the
  whole program away. `globCandidates` honours `.gitignore` for free, which on
  this monorepo is the difference between 9,399 files and **731**.
- **A file under no tsconfig still gets analysed**, by globbing its nearest
  `package.json` directory (not the repo — that is the memory trap above, and the
  glob excludes every directory a tsconfig group already holds). It is **named in
  `degraded[]`**: glob-tier output is not tsconfig-tier output, and a consumer
  that read it as one would be over-trusting it.
- **A tsconfig that will not PARSE is different from one that is absent.** Its
  files are abandoned, not globbed around — a repo whose build config is broken
  must not be silently promoted to tier 1. That is what keeps
  `makeBrokenTsConfigFixture` at tier 2.

**Reference queries stay inside their own program.** That is correct rather than
a limitation: a cross-project reference is not resolvable without project
references anyway, and over-claiming a reference set would be worse than
under-claiming it in the two extractors (`constants`, `contracts`) whose output
is an ABSENCE claim.

### The budget is SHARED OUT, and a group that does not fit is NARROWED

One program per tsconfig shipped with a first-come-first-served budget: groups
loaded largest-diff-share first and each was refused **wholesale** once the
running total passed `maxFiles`. That is a starvation shape, and it is
scale-independent — it bites any monorepo whose diff spans several packages.
Caught on `prreview__grafana-106778` (*"the glob over . holds 7473 source files
and 5399 were already loaded for this diff, above the 6000 ceiling — it was NOT
analysed"*) and measured on `prreview__sentry-greptile-5`, where one 7,230-file
tsconfig over the 6,000 ceiling meant **0 of 69 changed `.tsx` files analysed**
in the largest genuinely-large PR in the corpus. **A project holding one changed
file must never be refused because an unrelated project already spent the shared
budget.**

Be precise about grafana, because the honest number is not the dramatic one: its
single "uncovered" file turns out to be a **deletion**, so the refused group
could not have analysed it either — the envelope was blaming the budget for a
deleted file. That case's fix is the two bullets at the end of this list; the
budget redesign is what sentry needed.

Three fixes were on the table and two were rejected:

- **A budget per project** — the obvious one — multiplies the memory bound by
  `maxProjects`. 12 × 6,000 files is ~5 GB against a production sandbox with a
  **2 GB agent cap**. Rejected on that alone.
- **Counting QUERIED files instead of loaded files** is the honest proxy for
  reference-query time, but it cannot bound memory and it is not knowable before
  the program exists. Not this fix.
- **What ships**: `maxFiles` stays a total — so peak RSS is unchanged — but it
  is allocated. Before any group spends anything, every changed file not yet in
  a program is RESERVED (`unserved` in `loadProject`), and a group's allowance is
  whatever is left *after* the other groups' reserves. A group over its allowance
  is admitted **partially**: it keeps every changed file it covers plus as much
  of their neighbourhood as fits (`selectNeighbourhood`, deepest shared directory
  first), instead of being refused.

Consequences that are load-bearing:

- **A narrowed program's reference sets are a LOWER BOUND**, and that is said in
  those words in `degraded[]` along with the counts, plus
  `LoadedProject.narrowed` as the machine-checkable half. An omitted file is a
  file a reference could have lived in, so no *"appears nowhere else"* reading is
  available from a narrowed group — which matters most to `constants`, whose
  whole output is an absence claim.
- **The reserve can push past `maxFiles`, deliberately.** The diff is not
  optional work: `facts` and `contracts` read every changed file whatever the
  loader decides, so declining to compile one saves nothing and costs the whole
  answer for it. The hard bound is `maxFiles + min(analysable diff, maxFiles)`,
  and a diff bigger than the budget outright gets ONE named reason instead of a
  pile of per-group ones.
- **`--max-projects` is the one refusal that stays wholesale**, because half a
  compiler is not a thing. Named separately, with its own count.
- **`selectNeighbourhood` ranks on REPO-RELATIVE paths.** `contracts` compares a
  head program against a base program in a temp worktree; ranking on absolute
  paths would make the two sides narrow to different file sets for no reason,
  which is the recipe for a phantom delta.
- **A group holding NONE of the changed files it was opened for is skipped.** It
  can never own a declaration under review, so no reference query will ever run
  in it — it is all cost and no answer. Measured on `grafana-106778`, where the
  one "uncovered" changed file turns out to be a **deletion**: compiling the glob
  group's share of the budget for it cost 600 files and 319 MB to analyse
  nothing.
- **A file the diff DELETED gets its own reason, not a coverage-gap one.** It is
  absent at head, so no program can hold it and none should be blamed — the same
  argument `languages[].changedFiles` already makes about deletions. That one
  line was the whole of `grafana-106778`'s remaining `degraded[]` entry, and it
  had been reading as a budget failure.

Measured, one line per case:

| case | before | after |
|---|---|---|
| `sentry-greptile-5` | tier **2**, 0 of 69 changed `.tsx`, 0 symbols, 0 contracts, **8** degraded, 1.33 GB, 6.5 s | tier **1**, **69 of 69**, 112 symbols, 20 contracts, **5** degraded, 2.95 GB, 23.6 s |
| `grafana-106778` | 12 analysed, 11 contracts, 5 degraded, 2.43 GB | 12 analysed, 11 contracts, **4** degraded, **2.36 GB** |
| `cal-com-22532` | 1.82 GB | **1.49 GB** |
| this repo, `all` | 2.66 GB | 2.61 GB |
| `pnpm selfcheck` | 30 of 31, 4 programs | unchanged (every group fits) |

sentry-greptile-5 is the honest cost line: it went from producing **nothing** to
producing a full tier-1 document, and a 6,000-file program on a repo that size
has always cost about 2.9 GB — grafana pays 2.36 GB for 5,399. The old loader
never cashed that promise because it refused the group instead. Nothing here
raised the ceiling.

`--max-files` is the lever, and narrowing is what makes it a *useful* one for
the first time. The same sentry case at **`--max-files 3000`** is **2.14 GB and
identical output** — 69 of 69, 112 symbols, 20 contracts — because what buys the
coverage is the reserve plus the neighbourhood, not the ceiling. Under the old
wholesale rule, lowering the ceiling could only ever refuse *more*. A host that
cannot afford 2.9 GB should turn this down rather than turn the analysis off.

The cost, measured: roughly **2x wall clock and 2.3x peak RSS** for 30x the
coverage (`facts` on this repo: 1.6 s / 572 MB → 3.4 s / 1.17 GB). Worst observed
on the corpus is 15 s, against AC6's 90 s budget. `constants`'s repo-wide literal
scan used to dominate `all` (2.3 GB of 3.4 GB); enumerating from the git tree
took `all` to 2.34 GB and `constants` alone from 2.24 GB to 0.82 GB. `all`'s wall
clock went slightly *up* (18.9 s → 21.4 s) because the repo-root glob group now
fits under the file ceiling and is actually compiled instead of being dropped.

### WHERE THE MEMORY GOES — it is `node_modules`, not the file budget

A phase that runs this inside the review sandbox has a **2 GB agent cap**, and a
process that exceeds it dies as `exit 134` with **no envelope** — `--never-fail`
is an in-process `try`/`catch` and provably cannot catch it (`tests/oom.test.ts`).
So the peak has to be a number somebody has measured. It is, per extractor, on
five real commits of THIS repo (darwin-arm64, `/usr/bin/time -l`, `node dist/cli.js`):

| commit (analysable diff) | `facts` | `contracts` | `constants` | `deps` | `patterns` | `coverage` | **`all`** |
|---|---|---|---|---|---|---|---|
| `a63200ff` (3 files) | 544 | 810 | 405 | 164 | 264 | 163 | **815 MB / 5.5 s** |
| `30ebc63c` (22) | 602 | 903 | 543 | 171 | 264 | 163 | **921 MB / 6.7 s** |
| `3b880cce` (22) | 713 | 1147 | 663 | 172 | 300 | 163 | **1325 MB / 8.1 s** |
| `df645b6f` (158) | — | — | — | — | — | — | **1297 MB / 12.0 s** |

Read three things off it:

- **`all` peaks at the MAX of its parts, not their sum** (815 against
  `contracts`' 810). The extractors share the one head program `contracts` needs
  anyway, so *"run them sequentially and release between them"* is not a fix —
  it is the same peak plus a second program build.
- **`contracts` is the whole cost**, because it is the only extractor that
  materialises a second tree. Dropping it roughly halves the peak.
- **A 160 MB floor** is node plus the vendored compiler's `lib.*.d.ts`
  (`deps`/`coverage` load no project at all).

Those are the numbers **without an install**. With the repo's `node_modules` on
disk the SAME commits cost 3.5 GB, and `3b880cce` — an ordinary 31-file PR —
**OOMs at 4.3 GB, exit 134, no document, and a leaked `git worktree` in
`$TMPDIR` because the `finally` never ran**:

| commit | no `node_modules` | installed | installed, resolution blocked |
|---|---|---|---|
| `1c090b3c` | 948 MB | 3713 MB | 926 MB |
| `30ebc63c` | 942 MB | 3756 MB | 930 MB |
| `3b880cce` | 1324 MB | **OOM (4322 MB)** | 1370 MB |
| `c8530b83` | 1210 MB | 3452 MB | 1227 MB |

The mechanism, measured on `a63200ff` (a **3-file** diff): ts-morph holds **637**
source files and the underlying `ts.Program` holds **9,647** — **8,947 of them
from `node_modules`**, 7,374 `.d.ts`, 78 MB of declaration text. Neither
`skipFileDependencyResolution` nor `types: []` stops the checker following a
bare specifier; they only stop ts-morph *adding* files and the compiler
*auto-including* `@types`. So:

- **`--max-files` bounds the wrong number.** It is a ceiling on the ROOT list.
  The same case at `--max-files 200` still peaks at 3.27 GB against 3.68 GB at
  the 6000 default — a 3% saving for a 30x smaller budget — because the 15x
  closure is untouched. On this repo the budget is not even binding: the whole
  diff loads 637–757 files against a 6000 ceiling. **Lowering the default would
  buy nothing and cost the narrowing win.**
- **`maxFiles` being a TOTAL does not make N programs cost one program.** Each
  group builds its own `ts.Program` with its own copy of the closure: **~110 MB
  per extra program with no install, ~350–500 MB with one**. That is the axis
  `--max-projects` bounds, and it costs coverage directly — `3b880cce` analyses
  22 of 31 changed files at 12 programs and **8 of 31** at one.
- **An RSS-based budget is not the answer either.** It cannot be known before
  the program is built (`loadProject` is lazy: the 637-file load reads 446 MB and
  only touching the checker takes it to 1.66 GB), and a ceiling that depends on
  how much memory the host happened to have makes the document
  non-reproducible — `tests/invariants.test.ts` asserts the opposite.

**What this means for a workflow phase.** Today's review workspace is a
pre-clone with no install, which is why `all` fits: 0.8–1.3 GB on a
representative PR, and 1.3 GB on the largest real PR this repo has (158 files).
Nothing in this package enforces that, and **a `prepare` step that installs
dependencies — to produce the coverage artifact `coverage` reads, say — is what
re-arms the OOM.** The shell-level catch is not optional (see `--never-fail`
above); neither is keeping the install out of the tree `lastlight-facts` is
pointed at.

The one lever that closes the gap without touching coverage of the *diff* is a
ts-morph `resolutionHost` that refuses to resolve into `node_modules` — the
third column above, prototyped and measured. It is **not** free and was not
taken: 375 of 376 tests pass under it, and the one that fails is
`noise-floor`'s *"WITHOUT the node_modules mirror the same commit yields >10
deltas"*, which drops from **17 phantom deltas to 1** — the cause is genuinely
gone, because both sides become symmetrically unresolved, which is also what
makes `mirrorNodeModules` redundant. The cost is real and lands in `contracts`:
an externally-typed signature renders `any` (`z.infer<typeof S>` → `z.infer<any>`,
`Node<ts.Node>` → `Node`) on **61 of 168** entries at `c8530b83`, with the delta
COUNT unchanged on every commit measured — so a delta between two external types
that both print `any` would be MASKED. Deciding that is a `contracts` design
call, not a memory one.

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
| `contracts` | signature / parameter / return / nullability / thrown-type delta for every changed export, base vs head, plus `consumersOutsideDiff`. The base tree is a `git worktree add --detach` into a temp dir — **never** mutate the agent's working tree, which is reused across runs and read concurrently |
| `constants` | **references MINUS literals.** A = references to the identifier (ts-morph); B = occurrences of the literal value (ast-grep); report A, and `B \ A` as hard-coded duplicates. `sides` is a heuristic path partition and a hint for the seeder, never a finding. This is the `1587-r2` shape — the one gold finding the whole investigation converted |
| `deps` | manifest delta, import sites, and (with `--stage`) `npm pack` of changed runtime deps into `.lastlight/pr-review/deps/`. **The staging is the affordance fix, not a nicety** — the review workspace has no `node_modules`, so "open the library source" was structurally impossible. **Six ecosystems**, not one — see below |
| `patterns` | opengrep + gitleaks, scoped to the diff, normalised into `skills/security-review/SKILL.md`'s finding shape. **Evidence, not findings** — never posted directly |
| `coverage` | changed lines executed by zero tests, read from an **existing** report. It never runs a suite. istanbul · lcov · JaCoCo · Cobertura · Go coverprofile · SimpleCov |
| `all` | one envelope, every payload — what a workflow phase writes |
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
  (`@throws Foo when …`), which is the only case it was ever right for.
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

## `toolchain.json` — the single source of truth

Design review §D3. Three consumers: `sandbox-base.Dockerfile` reads it as build
ARGs (WP2 — which also fixes the floating `pipx install semgrep` and
`astral.sh/uv/install.sh`), this package probes and **stamps** what resolved into
every envelope, and the eval preflight refuses on a mismatch.

The npm-resolved engines are deliberately **not** in it: `package.json` +
`pnpm-lock.yaml` are the stronger pin, and a second hand-maintained copy is the
drift the file exists to prevent. Their resolved versions are stamped from the
installed packages instead.

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
  4. **The ceiling means something again.** The repo-root glob held 9,399 files —
     over the 6000 ceiling, so the whole group was *dropped* and its changed
     files went unanalysed. It now holds 731 and loads.
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
  at `headSha` they analyse one tree and cite another. Closing it means
  materialising a head worktree as well as the base one — 2x the worktree cost —
  so it is a deferral with a trigger, not an oversight.
- **The CLI's import of this package must stay dynamic.** ts-morph is ~14 MB of
  vendored compiler and must never be on `lastlight login`'s startup path.

## `pnpm selfcheck` — the census against a real commit

`scripts/selfcheck.ts` runs `all` against this repo (`--base` defaults to
`HEAD~1`) and prints the delta census: **how much of the diff was analysed and by
which programs**, counts by change type, the top 20 symbols by
`consumersOutsideDiff`, the tier, every `degraded[]` reason, and the wall clock.
It exits non-zero on a `removed` delta with no deletion or rename in the diff, on
more than 40 contract deltas **that could be phantom**, or past 90 s (AC6).

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
