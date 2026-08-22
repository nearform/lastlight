# The fact engine — replacing `ts-morph` with the TypeScript 7 API

> **Status: a written spec.** No file outside this directory was changed to
> produce it. The deliverable is the argument, the contract, and the gates —
> [01-spike.md](01-spike.md) says what has to be proved before any of it is
> built, and [02-migration.md](02-migration.md) describes the end state module
> by module.
>
> **Tree state, 2026-08-22 — revised later the same day.** The seam is now
> committed (`packages/code-facts/src/tsgo.ts`, 711 lines, at `7602ef47`) and
> `facts` + `contracts` are ported onto it in `src/tsgo-extractors.ts` (1,231
> lines, untracked) behind **`--engine tsgo`**, a measurement flag whose default
> is still `ts-morph`. `tests/tsgo.test.ts` and `tests/tsgo-port.test.ts` both
> exist. **Nothing is deleted** — the shared file budget, `--max-projects`,
> `--resolution` and `withWorktree` all still ship and still run on the default
> path. Of the gates in [01-spike.md](01-spike.md), only the head-to-head under
> "The measurements" below has been run; G1, G3, G4, G5 and G-impl are unread.

This is a standalone companion to
[`docs/plans/review-evidence-pipeline/`](../review-evidence-pipeline/README.md).
It changes **one tier of one package**: the type-aware TS/JS engine inside
`packages/code-facts`. It does not change the pipeline's thesis, its locked
decisions (except #5, below, whose premise expired), or any work package.

**Read [01b-code-facts-hardening.md](../review-evidence-pipeline/01b-code-facts-hardening.md)
first if you have not.** It is the measurement record this document stands on,
and its house rules are the ones used here: quote a number with the command that
produced it, say which half of a contaminated measurement you are standing on,
and mark a correction with its date.

## The claim in one sentence

`packages/code-facts` is the right tool and must not be rebuilt — but roughly
half of its complexity exists to work around the cost of a JavaScript
type-checker, and that cost is now optional.

The package is 10,476 lines of `src/` + `scripts/` (measured `wc -l`,
2026-08-22) with 376 tests, a 50-PR corpus, an independent oracle, and a record
of seven bugs found and fixed. Its **syntactic** tier is already Rust /
tree-sitter (`@ast-grep/napi`). None of that is in question. What is in question
is `ts-morph@28`, which vendors the *JavaScript* TypeScript compiler.

## The problem, in one table

Every row is a mechanism that exists because building and holding a
JS-TypeScript program is expensive. Line numbers are **as of 2026-08-22 on
`feat/review-evidence-pipeline`**; `src/project.ts` is under active edit, so
prefer the symbol name over the number if the two disagree.

| Mechanism | Why it exists | Where |
|---|---|---|
| `maxFiles` as a **total**, `unserved` reserve, `allowanceFor`, `selectNeighbourhood` | one shared file ceiling across N programs, allocated rather than spent | `src/project.ts` — `selectNeighbourhood` :526, `unserved` :819, `allowanceFor` :822, the 55-line rationale :762–818 |
| `DEFAULT_MAX_PROJECTS = 12` | *"each `new Project` is a compiler instance (~23 MB, ~90 ms)"* — and it is the one refusal that stays **wholesale**, because half a compiler is not a thing | `src/project.ts:360`, rationale :343–359 |
| `globCandidates` / `tsConfigCandidates` | list a group's files **before** anything is parsed. Letting ts-morph glob the repo root took `pnpm selfcheck` from **774 MB to 4.5 GB** peak RSS — for a program rejected on the next line | `src/project.ts:463` / `:494` |
| `--resolution full \| changed \| none` + `computeResolutionPolicy` | keep the checker from following bare specifiers into `node_modules` | `src/resolution.ts` (325 lines); tiers :81, default `changed` :88 |
| `withWorktree(...)` + `mirrorNodeModules` | the base-side program needs a **second checkout** and a mirrored `node_modules` | `src/git.ts:622`; **one** runtime caller, `src/run.ts:353` (`contracts`) |
| `vendoredCompilerPath()` + `tests/compiler-isolation.test.ts` | never resolve `typescript` from the repo under review | `src/project.ts:72` |
| `tests/oom.test.ts` | pins a hole that cannot be closed from inside: an OOM is **exit 134, no envelope**, and `--never-fail` provably cannot catch it | `tests/oom.test.ts` |

Nothing in that list is wrong. Every one of them was measured into existence,
several of them by [01b](../review-evidence-pipeline/01b-code-facts-hardening.md)
after a bug. They are all *cost management for one engine*.

### What that cost actually is, quoted honestly

From the frozen baseline corpus run
`apps/evals/eval-results/facts-corpus/2026-08-21_140115-c8530b83/report.json`
(50 cases, bare worktrees, no `node_modules`, no `--never-fail`):

```
wall clock   p50 3302 ms   p90 8423 ms   max 26857 ms   over 90 s: 0
peak RSS     p50 264.4 MB  p90 1152.1 MB max 2987.8 MB
```

Worst two cases: `sentry-greptile-5` **2987.8 MB**, `grafana-106778`
**2449 MB** — and `grafana-106778` changes **fourteen files**. The cost tracks
*repo* size through the `--max-files` budget, not diff size, so **no
diff-scoped lever reaches it**.

The `1022–4430 MB` range that appears elsewhere in the plan is a **different
measurement**: the five-commit, two-condition, five-tier resolution sweep on an
*installed* tree of this monorepo
([01b](../review-evidence-pipeline/01b-code-facts-hardening.md) → "Where the
memory actually goes"). Do not pool the two. That sweep's **wall-clock** numbers
are contaminated (it ran beside a full test gate; one `bare/none` run recorded
1933 s) and must never be quoted; its **RSS** numbers stand.

## Two corrections to fold in before reading further

### 1. The 2 GB agent cap is RETIRED, not closed — 2026-08-22

`SANDBOX_MEMORY_LIMIT` now defaults to **`8g`**
(`apps/server/src/sandbox/docker.ts`), raised by the operator on 2026-08-22.
Earlier drafts of this argument said "against a 2 GB agent cap". That is no
longer the truth and repeating it would be arguing from a constraint that does
not exist.

The truth is more useful. The cap was raised **because holding 2 GB required
going blind**: the only lever that reached the corpus's worst cases was cutting
`--max-files` far enough to re-open [WP1b bug 4](../review-evidence-pipeline/01b-code-facts-hardening.md)'s
monorepo blindness — trading a measured number for an unmeasurable one. Lever
two (raise the cap) was the honest answer and it was taken.

**So this work is not about fitting a cap**, and — per honesty note 4 under "The
measurements" — the memory win is **not the measured two orders of magnitude an
earlier draft claimed**, because the tsgo figure omits the compiler child.
Strike memory from the case entirely and two things are left:

- **Deleted mechanisms.** Roughly 900 lines of budget, cap, pre-sizing and
  worktree machinery stop having anything to bound. That is the argument.
- **Speed** — 3–10x on this repo, measured end to end (below), which is what
  makes fan-out affordable downstream.

The §D12 OOM loop is a *consequence*, not a third reason, and it is now stated
carefully: an OOM exits 134 with no envelope, the phase fails,
`assessedHeadShaByWorkflow` is written from SUCCEEDED runs only, and
`cron-review.yaml` re-dispatches every thirty minutes forever — the documented
1,260-execution / $1.30-per-hour shape. A shell-level catch *contains* that, and
**the catch stays regardless**: the new engine narrows the reachable path (a
`spawn()` with no `'error'` listener is a NEW one) but no measurement in hand
shows it removed.

### 2. `--resolution` has THREE tiers, not five

`full` · `changed` · `none` (`src/resolution.ts:81`), default `changed`
(`:88`). `workspace` and `hop` were **built, measured and cut as dominated** —
more memory than `changed` on every installed commit measured, for no fidelity
`changed` lacks. Any document that lists five tiers is stale.

## The expired premise

**Locked decision #5** of the pipeline plan reads:

> *The analysis toolchain is pre-baked and pinned in the sandbox image, and never
> resolves `typescript` from the repo under review* — **"TypeScript 7 has no
> programmatic compiler API"** (`tsgo` is CLI+LSP only). `ts-morph@28` vendors
> its own compiler and has no `typescript` dependency.

The same claim appears in `HANDOFF.md`'s trap list, in
`packages/code-facts/CLAUDE.md` ("The TS 7 landmine"), and in the header of
`packages/code-facts/src/project.ts:1-24`.

**The second half of that decision is still correct and must not be relaxed.**
Never resolving `typescript` from the repo under review is a hard rule, pinned
by `tests/compiler-isolation.test.ts`, and this work *strengthens* it (see
[02-migration.md](02-migration.md)).

**The first half expired.** It was true when written (2026-08-20). It is false
now:

| | |
|---|---|
| Package | `typescript@7.0.2`, present in this workspace |
| Declared by | eight `package.json` files as `"typescript": "^7.0.2"` (devDependency), including `packages/code-facts` |
| The entry point | `exports["./unstable/sync"] → ./dist/api/sync/api.js` (verified in the installed `package.json`) |
| Also exported | `./unstable/async`, `./unstable/fs`, `./unstable/proto`, `./unstable/ast`, `./unstable/ast/is`, `./unstable/ast/factory`, `./unstable/ast/utils`, `./unstable/ast/scanner`, `./unstable/ast/visitor`, `./unstable/ast/clone` |
| The engine behind it | the Go compiler, spawned as a subprocess; the JS side is a client |
| The binary | `optionalDependencies` — **20** of them, `@typescript/typescript-<platform>-<arch>@7.0.2`, resolved by `typescript/lib/getExePath.js` |

It is namespaced `unstable/`. That is a real risk and it is stated as one at the
end of this document — it is not a reason to keep believing a claim that is
false.

**The correction to make in the pipeline plan is minimal**: a one-line
"superseded by `docs/plans/fact-engine/`" pointer at each of the three sites, not
a rewrite. Those three files are owned by other agents; see the report that
accompanies this directory.

## The measurements

**Taken 2026-08-22 in this checkout, on darwin-arm64, sequentially, with nothing
else running.**

> **`scripts/engine-bench.mjs` NO LONGER EXISTS, and that is deliberate.** It
> compared the two engines, so it died with `ts-morph`: an A/B harness cannot run
> against an engine that is gone, and keeping a script that silently benchmarks
> one side against itself is worse than not having it. **To reproduce the table
> below, check out `7602ef47`** — the last commit where both engines were
> present — and run it there. The rows are a historical record from that commit,
> not a live gate; no decision now depends on re-running them, and the decision
> they informed was taken on the fidelity and wall-clock evidence, not on these.

```bash
git checkout 7602ef47                         # both engines present
cd packages/code-facts
node scripts/engine-bench.mjs ts-morph        # defaults to apps/server/tsconfig.json
node scripts/engine-bench.mjs tsgo            # same default
node scripts/engine-overlay-probe.mjs         # still present at HEAD
```

### One project — `apps/server/tsconfig.json`

| | `ts-morph@28` | `typescript@7.0.2` API |
|---|---|---|
| import the engine | 111 ms | **21 ms** |
| build the program | 1902 ms | **247 ms** |
| semantic pass (see caveat) | 595 ms | **90 ms** |
| **peak process RSS** | **1087 MB** | **79 MB** |
| files reported (see caveat) | 196 | 3926 |

**Four honesty notes, none of them optional. The fourth is a correction to the
third, made 2026-08-22 after reading the script.**

1. **The "files reported" row compares two different populations and is not a
   win.** 196 is ts-morph's `getSourceFiles()` — the source-file list
   `--max-files` bounds. 3926 is `program.getSourceFileNames()` — the full
   program file list, `node_modules` and `lib.*.d.ts` included. Those are the
   *exact* two numbers whose divergence is the subject of
   `packages/code-facts/CLAUDE.md` → "WHERE THE MEMORY GOES" (637 vs 9,647 on a
   three-file diff of this repo). Presenting 196 → 3926 as "20× more coverage"
   would be the same category error the section was written to name. It is
   reported here only to say *which* number each engine hands you.
2. **The semantic-pass row is not perfectly like-for-like either.** Each engine
   sliced its own first 200 files — tsgo from `project.rootFiles`, ts-morph from
   `getSourceFiles()` — and they are different 200 files, producing **1822**
   symbols (tsgo) against **2199** (ts-morph). Read the row as "same shape of
   work, ~6× apart", not as a ratio to two significant figures.
3. ~~**The RSS and build-time rows ARE comparable.** Same tsconfig, same
   machine, one engine per process, process-wide RSS.~~ **Half withdrawn — see
   note 4.** The build-time row stands. The RSS row does not.
4. **The RSS row is NOT comparable, and the reason is structural.**
   `engine-bench.mjs` reports `process.memoryUsage.rss()`, which is the RSS of
   **the node process it runs in**. ts-morph's compiler lives in that process, so
   its 1087 MB counts everything. tsgo's compiler is a **child process over a
   pipe**, and the 79 MB counts none of it. The number that includes the child is
   recorded in `packages/code-facts/src/run.ts` and
   `src/tsgo-extractors.ts` — **~600 MB per open snapshot plus ~200 MB of node**,
   measured on this repo, which is why `contracts` drains the base view to plain
   strings and disposes it before opening the head one rather than holding two
   (1.4 GB, *worse* than the ts-morph path's ~1.0 GB). Nothing about the
   *argument* changes, because
   [correction 1](#1-the-2-gb-agent-cap-is-retired-not-closed--2026-08-22)
   already withdrew memory as the case for the swap. What changes is that
   **"~1–3 GB to ~100 MB" must not be repeated**: no measurement in this document
   supports it. A like-for-like peak needs `/usr/bin/time -l` (or an
   equivalent that sums the child) around a real extractor run, and that has not
   been done.

### Every workspace tsconfig in ONE snapshot

```bash
cd packages/code-facts
node scripts/engine-bench.mjs tsgo <tsconfig> [<tsconfig> ...]
```

Measured: **8 projects, 10,078 program files, build 320 ms, semantic pass
166 ms, peak RSS 98 MB.**

**Provenance gap, stated rather than papered over.** The workspace contains
**ten** `tsconfig.json` files outside `node_modules`, `data/sandboxes/` and
`apps/evals/datasets/` — the two dashboards, `apps/evals`, `apps/server`,
`apps/www`, and the five `packages/*`. The run recorded eight projects and the
argv was not recorded, so *which* eight is not known. The re-run must print its
argv. (An earlier draft of this argument quoted "11 tsconfigs, 11,512 files,
669 ms, 69 MB"; that was taken on this machine on the same day and is reported
below rather than silently replaced.)

Whichever eight they were, the shape is the point: **one snapshot, symbols
shared across projects, 320 ms.** `--max-projects`, the shared file budget and
`selectNeighbourhood` have nothing left to bound. The 98 MB is the node client
only (honesty note 4) and is not the peak.

### The base side, without a second worktree

```bash
cd packages/code-facts && node scripts/engine-overlay-probe.mjs
```

An `API({ cwd, fs: { readFile } })` whose `readFile` returns the **base blob**
for changed files and `undefined` for everything else (fall through to the real
FS) produces a genuine base-side program over the same tree:

```
head:  (id: string) => User
base:  (id: string) => User | null      24 ms
```

That is one `git show` per changed file instead of a `git worktree add`, a
`node_modules` mirror, and a second compiler.

### The figures an earlier draft quoted

Recorded, not replaced. Both sets were taken on this machine on the same day
(2026-08-22); they were not taken by the same script, and the earlier set's
"full semantic check" is a whole-program diagnostic sweep, which is **a
different operation** from the exported-symbol pass above and cannot be
compared to it.

| | earlier draft | `engine-bench.mjs`, this document |
|---|---|---|
| build, `ts-morph` / tsgo | 2702 ms / 531 ms | 1902 ms / 247 ms |
| semantic, `ts-morph` / tsgo | 1596 ms / 439 ms | 595 ms / 90 ms (different work) |
| RSS, `ts-morph` / tsgo | 1346 MB / 65 MB | 1087 MB / 79 MB |
| all-tsconfig snapshot | 11 projects, 11,512 files, 669 ms, 69 MB | 8 projects, 10,078 files, 320 ms, 98 MB |
| base-side overlay | 40 ms | 24 ms |

The two sets agree on every conclusion and on no digit. Treat the range, not the
values, as the finding: **build ~5–8×**. Both RSS rows are node-client-only on
the tsgo side (honesty note 4), so the "~14–20×" an earlier draft read off them
is withdrawn rather than re-quoted.

### End to end, on the real extractors — `scripts/engine-ab.mts`

The bench above compares two compilers. This compares two **documents**, which
is what actually has to hold. `packages/code-facts/scripts/engine-ab.mts` runs
`facts` and `contracts` on this repo at `HEAD~1..HEAD` through `runExtractor`
itself, once per engine, and diffs the outputs as **SETS** rather than counts —
a run that loses eight symbols and gains eight reads as flat on a total.

| | `ts-morph` | `tsgo` |
|---|---|---|
| `facts` symbol set / reference sites | 44 / 138 | **44 / 138**, nothing on either side only |
| `contracts` keys / `consumersOutsideDiff` | 13 / 32 | **13 / 32**, identical |
| `facts` wall clock | 2034 ms | **642 ms** (3.2×) |
| `contracts` wall clock | 3661 ms | **1405 ms** (2.6×) |
| the same two at `--resolution full` | 5704 / 10485 ms | 594 / 1523 ms (**9.6×** / **6.9×**) |
| `selfcheck`'s three exit conditions, recomputed in-script | OK | OK |

It is **one commit of one repo**, so it is evidence toward G1/G2 and not a
substitute for either — the corpus run and `pnpm selfcheck` itself are still
unread. Two things it did surface:

- **The printers disagree about union member ORDER.** `TsgoFailureReason` prints
  its five members in a different sequence on each engine, which is why the
  `printed SIGNATURES` set diverges by one entry while the contract KEY set does
  not. Harmless while both sides of a comparison come from the same engine;
  fatal to any attempt to diff a stored ts-morph `before` against a fresh tsgo
  `after`. This is **cause 3**, the one this migration does not remove.
- **The two base views are not the same base view** — see the risks table.

## The engine contract

The seam the rest of the package codes against. One module owns the compiler;
nothing else imports `typescript/unstable/*`.

### The real API, stated accurately

Verified against
`node_modules/.pnpm/typescript@7.0.2/node_modules/typescript/dist/api/sync/api.d.ts`,
`../proto.d.ts`, `../fs.d.ts`, `../options.d.ts`. Loose pseudo-code has already
been written about this API twice; these are the shapes that actually exist.

```ts
import { API } from "typescript/unstable/sync";

// APIOptions extends ClientSpawnOptions: { tsserverPath?, cwd?, fs?, collectTiming? }
const api = new API({ cwd: repo, fs: overlay });

// UpdateSnapshotParams — NOT `projects: [{ configFileName }]`.
// DocumentIdentifier = string | { uri: string }
const snap = api.updateSnapshot({
  openProjects: tsconfigPaths,   // DocumentIdentifier[]
  openFiles:    orphanFiles,     // DocumentIdentifier[] → configured OR INFERRED project
});

for (const p of snap.getProjects()) {
  p.configFileName;   // string
  p.rootFiles;        // readonly string[]
  p.program;          // PROPERTY, not a method
  p.checker;          // PROPERTY, not a method
}

snap.getProject(configFileName);        // Project | undefined
snap.getDefaultProjectForFile(file);    // Project | undefined  ← after openFiles

snap.dispose();
api.close();
```

Four things that a loose reading gets wrong:

- `updateSnapshot` takes **`openProjects: DocumentIdentifier[]`**. There is no
  `projects: [{ configFileName }]`. `openProject` (singular) exists and is
  `@deprecated`.
- **`Project.program` and `Project.checker` are properties.** `p.checker()`
  is a type error.
- Opens are **ref-counted and persist across snapshots** until `closeProjects` /
  `closeFiles`. A long-lived `API` with successive snapshots is the intended
  shape; `code-facts` runs once and exits, so it takes one snapshot and closes.
- `updateSnapshot` also accepts **`fileChanges`** (`{ changed?, created?,
  deleted? } | { invalidateAll: true }`) for incremental re-snapshotting. Not
  needed for a one-shot run; relevant if `facts` ever becomes a resident
  service.

### The virtual FS

```ts
interface FileSystem {
  readFile?: (fileName: string) => string | null | undefined;
  fileExists?: (fileName: string) => boolean | undefined;
  directoryExists?: (directoryName: string) => boolean | undefined;
  getAccessibleEntries?: (directoryName: string) => FileSystemEntries | undefined;
  realpath?: (path: string) => string | undefined;
  writeFile?: ...; removeFile?: ...;
}
```

The three-valued `readFile` return is the whole mechanism, and it is documented
in `fs.d.ts` in these words:

- a **`string`** (including `""`) — this is the content;
- **`null`** — the file **does not exist**, and do not fall back;
- **`undefined`** — **fall back to the real filesystem**.

So a base-side overlay is: return the base blob for a file the diff modified,
return **`null`** for a file the diff **added** (absent at base), and return
`undefined` for everything else. That is the exact shape `contracts`' one-sided
guard already reasons about, expressed in the engine instead of in a worktree.

### The seam, as built

> **Landed while this document was being written.**
> `packages/code-facts/src/tsgo.ts` (619 lines, untracked at the time of
> writing) implements this seam. What follows is read off that file rather than
> proposed; where the two disagree, the file wins.

```ts
export function openSnapshot(options: OpenSnapshotOptions): EngineSnapshot;

interface OpenSnapshotOptions {
  repo: string;
  /** The tsconfigs to open, in PRECEDENCE order. */
  tsConfigPaths?: readonly string[];
  /** Files no tsconfig covers → tsgo's INFERRED project. */
  openFiles?: readonly string[];
  /** The base-side view. The ONLY field that may differ between the two sides. */
  overlay?: Overlay | null;
  tsgoPath?: string;            // else $LASTLIGHT_TSGO_BIN, else this package's own tree
  log?: LoggerPort;
}

type Overlay = ReadonlyMap<string, string | null>;   // null = absent on this side

interface EngineSnapshot {
  repo: string;
  projects: readonly EngineProject[];   // caller order, inferred project last
  overlaid: boolean;
  degraded: readonly DegradedEntry[];
  failures: readonly TsgoProjectFailure[];   // the machine-checkable half
  lookup(path: string): EngineFile | null;  // null = no program holds it
  dispose(): void;                          // idempotent, safe in a finally
}
```

Three design choices in it are load-bearing and were not obvious:

- **The symmetry invariant is structural, not advisory.** The base and head
  snapshots are *the same call with the same `tsConfigPaths` and `openFiles`*,
  differing only in `overlay`. Nothing about the program's shape can drift
  between the sides, because the shape is one argument list used twice. That is
  the direct answer to WP1's *227 deltas of which one was real*.
- **`EngineProject.tsConfigPath` is repo-relative.** An absolute spelling would
  let two otherwise-identical sides compare unequal — the same reasoning that
  made `selectNeighbourhood` rank on repo-relative paths.
- **`tsgo.ts` owns lifecycle and no policy.** No file budget, no project cap, no
  tier. `project.ts` decides *which* tsconfigs and *which* orphan files are
  worth opening; the seam is told and obeys.

Two invariants carried over **verbatim**, because they are the founding rules of
this package and an engine swap is exactly when they get quietly dropped:

- **`null` means NOBODY LOOKED; `[]` means looked, found none.** It applies to
  `SymbolFact.implementations`, `ConstantFact.references` and
  `ConstantFact.sides`. Never write `?? []` on any of the three. That was the M6
  bug, in the extractor whose whole output is absence claims.
- **A tier is not a coverage.** A snapshot that loads is not a diff that was
  analysed. Whatever replaces `LoadedProject.narrowed` and the per-group
  `degraded[]` entries must keep saying, per changed file, whether a program
  actually held it. `EngineSnapshot.lookup()` returning `null` is that answer.

## The API surface actually needed

`code-facts` uses far less of `ts-morph` than its size suggests. Counted by
grep over `src/` on 2026-08-22.

| `ts-morph` today | call sites | where | `typescript@7.0.2` equivalent |
|---|---|---|---|
| `findReferencesAsNodes()` | **3** | `facts.ts:320`, `contracts.ts:588`, `constants.ts:193` | `Checker.getReferencedSymbolsForNode(node, position) → ReferencedSymbolEntry[]` (each with `definition: NodeHandle` and `references: NodeHandle[]`); `Checker.getReferencesToSymbolInFile(file, symbol)` for the per-file form |
| `getType()` ×4, `…getCallSignatures()[0].getReturnType()`, `getParameters()` | **6** | `contracts.ts:200–220`, `facts.ts` | `Checker.getTypeOfSymbol` · `getTypeAtLocation` · `getSignaturesOfType(t, SignatureKind.Call)` + `getReturnTypeOfSignature` · `getParameterType(sig, i)` · `getSignatureFromDeclaration` |
| `Type.getText(enclosingNode)` | on the same 6 | `contracts.ts` | `Checker.typeToString(type, enclosingDeclaration?, flags?)` |
| `getExportedDeclarations()` | **1** | `contracts.ts:43` | `Checker.getSymbolAtLocation(sourceFile)` → `Checker.getExportsOfModule(sym)`; `getAliasedSymbol` for re-exports |
| `getJsDocs()` | **1** | `contracts.ts:89` | **not `getJsDocTagsOfSymbol` — see below.** `Node.jsDoc` via `typescript/unstable/ast` + `isJSDocThrowsTag` from `typescript/unstable/ast/is` |
| `getStartLineNumber()` ×9 / `getEndLineNumber()` ×2 | **11** | across `facts.ts`, `contracts.ts`, `constants.ts` | `SourceFile.getLineAndCharacterOfPosition(position)` — local, no IPC. **0-based**; ts-morph's is 1-based |
| `getImplementations()` | **1** real call | `facts.ts:361` (plus a duck-type narrow at `:337`) | **no equivalent — see below** |

Three of these carry a trap.

**`getJsDocs()` is a regression risk, not a rename.** The obvious mapping is
`Checker.getJsDocTagsOfSymbol(symbol)`, and it is wrong. Its return type is

```ts
interface JSDocTagInfo { readonly name: string; readonly text?: string | undefined; }
```

— a flat rendered string with **no separate type expression**. That is precisely
the shape that caused [WP1b bug 5](../review-evidence-pipeline/01b-code-facts-hardening.md):
`@throws {ValidationError} when the id is empty` recorded `"when"`, because the
old code read the type off the comment text and regex-unwrapped `{X}`. Adopting
`getJsDocTagsOfSymbol` re-introduces that bug in the same file.

The fix survives on the **AST** route, which is verified to exist:
`Node.jsDoc?: readonly Node[]` (`dist/ast/ast.d.ts:39`),
`isJSDocThrowsTag(node)` (`dist/ast/is.generated.d.ts:169`), and
`JSDocThrowsTag.typeExpression?: TypeNode`
(`dist/ast/ast.generated.d.ts:872-875`). **UNVERIFIED and a spike item:** whether
the API's wire protocol actually populates `jsDoc` on a node resolved through
`NodeHandle.resolve()`. If it does not, `@throws` extraction has no route and
the field must degrade to `null` + a `degraded[]` entry rather than to `[]`.

**Line numbers are 0-based.** `getLineAndCharacterOfPosition` returns
`{ line, character }` both 0-based; `getStartLineNumber()` is 1-based. Eleven
call sites feed `path:line` citations that `selfcheck.ts` cross-checks against
`git diff -U0`. An off-by-one here does not throw — it shifts every citation in
the document by one line and the oracle is the only thing that would notice.
Pin it with a test.

**`getExportedDeclarations()` is not `getExportsOfModule()`.** ts-morph's
returns *declarations*, following re-exports through barrels (there is a comment
at `contracts.ts:45` saying so). `getExportsOfModule` returns *symbols*, and
aliases need `getAliasedSymbol` explicitly. `contracts` is keyed on the export
set; a difference here changes the key set, which is the definition of a phantom
delta. This is the highest-risk single mapping in the table.

## The one gap: `getImplementations`

**There is no implementations query in the API.** `Checker` has 60-odd methods;
none of them answers "who implements this interface member". This was checked by
reading `api.d.ts` end to end, not by grep.

`facts.ts`'s `implementationsOf()` already gets this exactly right, and the
migration must not undo it:

```
"interface" | "interface-method" | "abstract-method" | "class"  → ask
anything else                                                   → null   (question does not apply)
the query threw                                                 → null   (looked, could not see)
```

`SymbolFact.implementations` is `z.array(z.string()).nullable()`
(`src/schema.ts:185`), and the schema comment says why in the package's own
words: *"`null` = NOBODY LOOKED; `[]` = looked, found none."*

**The legal migration is `implementations: null` plus a `degraded[]` entry
naming the engine as the reason.** Emitting `[]` would assert *"this exported
interface has no implementers anywhere"* — an absence claim nobody verified,
from the extractor whose entire output is absence claims. That is the M6 bug
(`packages/code-facts/CLAUDE.md`, "Rules"), and it is the single easiest thing
for a migration to get wrong, because `[]` type-checks and `null` needs the
`degraded[]` line written.

**The likely answer, marked UNVERIFIED.** `API.fromLSPConnection(options)`
exists (`api.d.ts:36`), it returns `API<true>`, and `tsgo`'s LSP server
implements `textDocument/implementation`. An LSP session sharing the snapshot
therefore *plausibly* answers the query. Nothing about that has been tested:
not that the LSP and API sides can share one process, not that the handle types
line up, not the cost. **It is a spike item ([G-impl](01-spike.md)), not an
assumption**, and the spike's acceptable outcome includes "no — stamp `null`".

## A fidelity gain worth recording

```ts
Checker.getSignatureUsage(signatureDecl: Node): SignatureUsage[]
interface SignatureUsage {
  name: NodeHandle;            // the reference
  call?: NodeHandle | undefined; // the call expression, IF the reference is invoked
}
```

This distinguishes **referenced** from **invoked** at the point of the reference.
`code-facts` currently cannot: `findReferencesAsNodes()` returns nodes, and
telling `foo(1)` from `export { foo }` from `onClick={foo}` means walking
parents.

That matters because `referencesInDiff` vs `referenceCount` is described in
`schema.ts:189-195` as *"the single most productive field in the document"* — a
symbol whose shape changed and whose references are mostly **outside** the diff
is the cross-file contract bug, invisible because each file reads correctly
alone. A signature change breaks **call sites**; it does not break a re-export.
Splitting the count sharpens the most productive field in the document, for
free.

It is a **new field**, not a replacement. Add it beside `referenceCount` /
`referencesInDiff`; do not redefine either, or every number in
[01b](../review-evidence-pipeline/01b-code-facts-hardening.md) stops being
comparable.

## What stays, untouched

This changes the **TS/JS type-aware tier**. Nothing else.

| | |
|---|---|
| `@ast-grep/napi` | stays the syntactic engine and the polyglot path. `src/syntactic.ts` (904 lines), `src/langs/` |
| `constants`' set B | literal occurrences stay on ast-grep. Only set A (references) moves |
| `patterns` | opengrep 1.27.1 + gitleaks 8.21.2, `rules/review.yaml` across five languages. Untouched |
| `deps` | six ecosystems via `src/manifests.ts`; reads git blobs (`showFile`), never a worktree. Untouched |
| `coverage` | six report formats; reads an artifact, loads no project. Untouched |
| `selfcheck` | cross-checks against **git**, not against the engine. That is exactly what makes it a valid referee for this swap |
| WP1c Stage 2 grammars | still the answer for non-TS. Locked decision 14 is unaffected |
| `git.listFiles` | the file set still comes from git, not `readdirSync` |

## What is explicitly not re-litigated

Each of these was decided with reasoning that this work does not change.

- **SCIP / persistent cross-repo indexing** — locked decision #4. Facts are
  recomputed per run. Making the compiler cheap makes that decision *more*
  right, not less.
- **CodeQL** — locked decision #7. Its CLI licence forbids non-open-source
  codebases without paid GHAS. Never in the product path.
- **Semgrep** — same decision. The registry rules moved to a licence that
  plausibly excludes a review product. The engine slot is **Opengrep**.
- **tree-sitter as a *replacement* for the type-aware tier** — it has no name
  resolution and no types, so it cannot produce the impact cone, the contract
  delta, or references-minus-literals. This is measured, not asserted:
  `scripts/name-match-gate.ts` ran both engines over the same symbols and found
  93–99% recall but 3–25% whole-repo precision, with **members** the failure
  mode (`nameAmbiguity` 145 for `handler` on cal.com). It is a good **tier 2**
  and it already ships as one.
- **Rebuilding `packages/code-facts` from scratch.** The measurement record is
  the most valuable thing in the package and a rebuild discards it.
- **A dual-engine fallback.** `ts-morph` is replaced outright or not at all. Two
  engines is the complexity being objected to, and a fallback path is a path
  nobody measures.

## Risks, stated not buried

| Risk | Shape | What reduces it |
|---|---|---|
| **`unstable/`** | The API is namespaced `unstable/` and the export map can change under a patch bump | Pin `typescript` to an **exact** version as a real dependency, not `^7.0.2`. One module (`src/tsgo.ts`) touches it, so a breaking change is one file |
| **A different type printer** | TS7's `typeToString` may not render identically to the vendored TS 6.0.2 printer. `contracts` compares type **strings**, so a printer difference is a **phantom delta** | This is the spike's central gate. `canonicalType` / `stripImportPaths` / `shapeOf` / `sameShape` all get re-validated against the new printer, and `selfcheck` referees against git |
| **`node_modules` cost is unmeasured on the new engine** | Every measurement above is on this monorepo, which is installed. Whether the Go compiler's `.d.ts` cost tracks ts-morph's is **not known**. `--resolution changed` exists because the JS checker followed bare specifiers below the API the budget was expressed in | G4 measures corpus peak RSS on **bare** trees; an installed-tree run is a separate, explicit spike item |
| **The base-side overlay is proved on a two-file fixture** | `engine-overlay-probe.mjs` is 50 lines and one type. It has never been run against a real PR with renames, deletions, added packages, or an added tsconfig | The spike runs `contracts` end to end on the corpus, not on the probe |
| **CLI size** | `typescript` ≈ 3.5 MB + one ~26 MB platform binary, minus 13.4 MB of `ts-morph` — call it 21 MB → ~38 MB installed. **Estimated, not measured** | Measure it in the spike (`npm pack` / `du` on a clean install) before quoting it anywhere |
| **The platform binary arrives via `optionalDependencies`** | 20 of them; only the matching one installs. This checkout has exactly `@typescript+typescript-darwin-arm64@7.0.2`. A linux image that does not install its own gets a `typescript` that resolves and a `tsgo` that does not exist | **The same hazard class WP1c already wrote the `existsSync` guard for** (`09-external-validation.md:163` — *"`registerLanguages()` MUST `existsSync(libraryPath)` before the native load"*). Same guard, same reason: a native asset missing on a platform must fail loud at probe time, not at first use |
| **A subprocess, not a library** | The compiler is a child process over a pipe. New failure modes: spawn failure, a killed child, a hung pipe | `dispose()` in a `finally`; the §D12 shell-level catch stays regardless. **And see the three silent-failure rows below** |
| **A tsconfig that will not parse does NOT throw** | `updateSnapshot` returns a project built from a *recovered* configuration and demotes the parse failure to `Program.getConfigFileParsingDiagnostics()`. Unchecked, that is a broken build config silently promoted to tier 1 — exactly what `makeBrokenTsConfigFixture` exists to prevent | Detected in `src/tsgo.ts`, which **excludes** the project rather than degrading it, and records `tsconfig-unparsable` in `failures[]`. `getConfigFileParsingDiagnostics` is verified to exist (`api.d.ts:205`); the "20 error diagnostics against 0" measurement is the concurrent implementation's and is **not independently verified here** |
| **A tsconfig that does not exist is dropped silently** | It simply does not appear in `getProjects()`, and a shorter `getProjects()` looks like nothing at all. This is locked decision 6's exact shape — an empty result indistinguishable from an unavailable analyser | `failures[]` carries `tsconfig-absent`. The count of projects asked for must be compared against the count returned, every run |
| **The client `spawn()` has no `'error'` listener** | **Verified by reading `dist/api/syncChannel.js:99,126`** — both `spawn()` calls attach no `'error'` handler. A binary that cannot be executed emits an unhandled `'error'` on the next tick and **kills the node process outright**. That is the `tests/oom.test.ts` shape: `--never-fail` provably cannot cover it | `resolveTsgoBinary()` pre-flights the executable (`accessSync(X_OK)`) and passes the resolved path back in as `tsserverPath`, so the path checked is the path spawned. **A narrowing, not a guarantee** — a binary that passes `X_OK` and dies during exec still takes the process down, so the shell-level catch stays mandatory |
| **The inferred project carries DEFAULT compiler options** | A file opened via `openFiles` under no tsconfig gets a checker — but with no `paths`, no `strict`, nothing the repository configured. It fixes WP1b bug 4's blindness; it does not produce the same answer the repo's own config would | Named in `degraded[]`. *Analysed is better than skipped, but it is not the same answer* — the same rule as glob-tier output not being tsconfig-tier output |
| **`facts`/`contracts` still read HEAD off the filesystem** | Pre-existing, listed in the plan's open backlog — but this work **widens** it, see the row below | The overlay makes it *cheaper* to fix (serve head blobs too, no worktree) — a follow-on, not a claim |
| **The overlay's base view is not the worktree's, and a DIRTY TREE makes them disagree** | `withWorktree` materialises base blobs for **every** file. `buildBaseOverlay` serves base blobs for the **changed** files and falls through to the real filesystem — the **working tree** — for everything else. Identical when the checkout is clean at head; divergent otherwise, silently. **Measured 2026-08-22**: with `src/schema.ts` edited in the working tree but absent from the `HEAD~1..HEAD` changed set, ts-morph reported a `changed` delta on `project.ts#languageBreakdown` (its return type names the `engine` enum `schema.ts` declares) and tsgo did not — 14 deltas against 13, `--resolution full` arm of `engine-ab.mts`. Neither engine is wrong about the tree it was shown | **Nothing yet — it is an open item, not a fixed one.** It wants a loud `degraded[]` entry when the tree is dirty: the document claims to be about `baseSha..headSha`, and a dirty tree makes it partly a claim about somebody's uncommitted edits. No such check exists in `src/` (verified 2026-08-22). Serving head blobs through the same overlay closes the other half. Written up in `packages/code-facts/CLAUDE.md` → "The overlay's base view is NOT the worktree's" |

## What this does not buy

**Recall.** `code-facts` has **zero runtime call sites in `apps/server`** —
verified 2026-08-22; the only matches are a doc comment in
`src/engine/review-spec.ts` and the CLI's dynamic import at
`packages/cli/src/cli.ts:1356`. Nothing consumes the facts yet.
[WP3](../review-evidence-pipeline/03-seed-and-survey.md) is still where review
quality comes from.

This work makes WP3 and WP4 safe and cheap to build on, deletes roughly half of
`packages/code-facts`'s cost-management machinery, and removes the reachable
path to the §D12 OOM loop. It moves no recall number by itself and must not be
justified as though it does.
