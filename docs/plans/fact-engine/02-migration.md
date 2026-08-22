# The migration — the end state, module by module

**Written as a spec of the end state, not as a diff.** It describes what
`packages/code-facts` looks like after `ts-morph` is gone, so that a reader who
never saw the intermediate branch can tell whether the tree matches.

**Prerequisite: [01-spike.md](01-spike.md)'s gates, all read and written down —
including the failures.** Nothing below is started until G2 (no phantom deltas)
and G-impl (the `getImplementations` answer) have numbers against them. A
migration begun on an unproved printer is a migration that discovers
`contracts` is broken after the old engine has been deleted.

Every symbol named below was **checked to exist** on 2026-08-22 on
`feat/review-evidence-pipeline`. Where an earlier draft named a symbol that does
not exist, or put one in the wrong file, that is called out inline — the drafts
were written from a survey.

`src/project.ts` is under concurrent edit; prefer the symbol name over the line
number wherever the two disagree.

## The shape of the change

```
before                                    after
──────                                    ─────
src/project.ts        1252 lines          src/tsgo.ts          711   the only compiler touch (EXISTS)
                                          src/tsgo-extractors.ts     facts + contracts, ported (EXISTS)
src/resolution.ts      325                src/project.ts       ~350  paths, languages, tiers
src/git.ts             706 (withWorktree)   src/git.ts         ~600  worktree gone from the TS/JS path
ts-morph@28            ~13.4 MB vendored  typescript@7.0.2 (exact) + one platform binary
```

Roughly 900 lines of cost-management machinery are deleted, not rewritten. That
is the point of the work; it is also why it must not start before the gates.

## `src/tsgo.ts` — the seam, and it already exists

**Committed 2026-08-22 at `7602ef47`: 711 lines.** An earlier draft called for a
new `src/engine/tsgo.ts`; the module that exists is `src/tsgo.ts`, and its
surface is described in [README.md](README.md) → "The seam, as built". Do not
create a second one. The extractors that ride on it live in
`src/tsgo-extractors.ts` (1,231 lines), reached from `runOnTsgo` in
`src/run.ts` behind `--engine tsgo`; deleting the flag after the migration is
`git rm` plus one branch.

| Responsibility | Detail |
|---|---|
| **Lifecycle only** | resolve the binary, spawn the API, open the projects, index the files, hand back a checker, tear the child down. `dispose()` is idempotent and safe to call twice from a `finally` |
| **No policy** | no file budget, no project cap, no neighbourhood selection, no tier. `project.ts` decides *which* tsconfigs and *which* orphan files; the seam is told and obeys |
| **Binary resolution** | explicit `tsgoPath` → `$LASTLIGHT_TSGO_BIN` → the platform package inside **this package's own dependency tree**. **Deliberately no `PATH` step** — a `tsgo` on `PATH` is an arbitrary version, and the point is that the compiler is the one this lockfile pinned. An explicit path that is not executable **throws**; an unresolvable default returns `null` and lets the API's own `getExePath()` try |
| **The base side** | `overlay: ReadonlyMap<string, string \| null>` — a base blob for a modified file, **`null`** for a file the diff **added** (absent at base), absent from the map for everything else. Keys may be relative or absolute; both spellings are indexed |
| **Symmetry** | base and head are the same call with the same `tsConfigPaths` and `openFiles`, differing only in `overlay` |
| **Loudness** | a tsconfig that will not parse and one that does not exist are both **silent** in this API. Both are detected, both **exclude** the project rather than degrading it, and both land in `degraded[]` + `failures[]`. A whole-snapshot failure **throws** `TsgoError`, because a caller must not be able to mistake it for an empty snapshot |
| **Nothing else imports `typescript/unstable/*`** | pinned by a test, the same way `tests/state/driver-isolation.test.ts` pins `schema/pg.ts` in core |

The blob source is `showFile(repo, baseSha, path)` from `src/git.ts:275` —
already the mechanism `deps` and `patterns` use, already merge-base-correct via
`resolveDiffBase`.

**`resolveTsgoBinary`'s pre-flight is not optional.** `dist/api/syncChannel.js`
calls `spawn()` at `:99` and `:126` and attaches **no `'error'` listener**
(verified by reading the vendored source). An unexecutable binary therefore
emits an unhandled `'error'` on the next tick and kills the node process — the
`tests/oom.test.ts` shape, which `--never-fail` provably cannot cover. The
pre-flight narrows it; the §D12 shell-level catch still has to be there.

## `src/project.ts` — 1247 lines → ~350

### Delete, with the mechanism each one manages

| Symbol | Today | Why it goes |
|---|---|---|
| `globCandidates` | `:463` | there is no per-group glob to size; one snapshot holds every project |
| `tsConfigCandidates` | `:494` | same — `ts.getParsedCommandLineOfConfigFile` was a pre-parse sizing trick |
| `selectNeighbourhood` | `:526` | nothing is narrowed, so nothing is ranked |
| `newProject` | `:646` | replaced by the snapshot |
| `allowanceFor` / `unserved` / `reserveBudget` | `:819–:822` | the shared-budget allocator |
| `DEFAULT_MAX_FILES` | `:346` | with `--max-files` |
| `DEFAULT_MAX_PROJECTS` | `:360` | with `--max-projects` |
| `SOURCE_INDEXES` | `:1114` | a `WeakMap<Project, …>` over **ts-morph** `SourceFile`s. If a file→node index is still needed it is rebuilt over `Program.getSourceFileNames()`, not carried over |
| `vendoredCompilerPath` | `:72` | there is no vendored compiler |
| `isUsableTsConfig`, `nearestUp`(tsconfig use), `groupByTsConfig`, `nearestPackageRoot`, `brokenProject` | `:362`–`:436`, `:705+` | grouping/fallback machinery for N separately-built programs |

`DEFAULT_MAX_FILES` is **also imported by `src/syntactic.ts:44`** as the ceiling
on the tier-2 repo-wide parse. That use is unrelated to the compiler and must
survive — move the constant to `src/syntactic.ts`, or keep it in
`project.ts` under a name that says which population it bounds. Deleting it
outright breaks the syntactic engine, which this work does not touch.

### Keep, verbatim

These have nothing to do with the compiler and are load-bearing elsewhere:

| Symbol | Today | Used by |
|---|---|---|
| `hasAnalysableExtension` | `:81` | `resolution.ts:77`, the loader |
| `JS_TEST_PATH_RE` · `GO_TEST_PATH_RE` · `PYTHON_TEST_PATH_RE` · `JAVA_TEST_PATH_RE` · `RUBY_TEST_PATH_RE` + `TEST_PATH_RES` + `isTestPath` | `:97`–`:124` | `SymbolFact.tests`, `Reference.isTest`, `langs/` |
| `isIgnoredPath` | `:162` | the residual denylist; the walk fallback's only filter |
| `isScannablePath` | `:173` | `listFiles` accept predicate |
| `MAX_SCANNED_FILE_BYTES` | `:184` | 512 KB ceiling, `syntactic.ts:585` |
| `looksMinified` | | `syntactic.ts:632`, `:724` |
| `LANGUAGE_BY_EXTENSION` / `languageIdOf` | `:213` / `:233` | `languages[]` in the envelope |
| `astGrepLangFor` | `:1160` | the ast-grep tier |

**Also keep `compilerInfo()` (`:61`), moved and re-pointed** — see
`src/toolchain.ts` below. An earlier draft placed it in `src/toolchain.ts`; it
is in `src/project.ts:61` and is imported by `src/cli.ts:22` and
`tests/compiler-isolation.test.ts`.

### Replace

`loadProject` (`:705`) → `openSnapshot`. Open every tsconfig the diff touches;
`openFiles` for files under none. Two properties of the old loader must survive
the replacement, because both were bought with a bug:

- **A tsconfig that will not PARSE is different from one that is absent.** Its
  files are abandoned, not globbed around — a repo whose build config is broken
  must not be silently promoted to tier 1. `makeBrokenTsConfigFixture` stays at
  tier 2. Under the new engine the equivalent question is what
  `api.parseConfigFile(file)` reports and what `getProjects()` comes back with;
  a project that loads with zero root files is the same silence.
- **The tier is not the coverage.** `LoadedProject.narrowed` and the per-group
  `degraded[]` entries exist so a consumer can tell, per changed file, whether a
  program actually held it. The narrowing reason goes away; **the per-file
  answer must not.**

The inferred-project path is the structural repair of
[WP1b bug 4](../review-evidence-pipeline/01b-code-facts-hardening.md):
*"1 of 31 analysable changed files"*, fixed once by one-program-per-tsconfig and
removed at the root here, since `openFiles` gets a working checker for a file
under no tsconfig at all.

## `src/resolution.ts` — 325 lines, deleted **conditionally**

Delete the file, `RESOLUTION_TIERS` (`:81`), `DEFAULT_RESOLUTION_TIER` (`:88`),
`computeResolutionPolicy`, the `--resolution` flag (`src/cli.ts:56`, `:206`),
and the `resolution` field on the envelope (`src/schema.ts:134`).

**Conditionally, and the condition is a measurement.** `--resolution` exists
because ts-morph's checker followed bare specifiers into `node_modules` one
layer below the API `--max-files` was expressed in — 8,947 of 9,647 program
files on a three-file diff. Whether the Go compiler behaves the same way on an
**installed** tree has **not been measured** ([01-spike.md](01-spike.md) → G4,
second half). If it does, the tier survives in some form and this row does not
apply; if it does not, the whole file goes. That measurement must count the
**compiler child process**, not just node's RSS — the only child-inclusive
figure on record is ~600 MB per snapshot on this (installed) monorepo, which is
nowhere near the node-only 79/98 MB the bench prints and is not yet a
like-for-like comparison with anything.

Two facts to carry forward whichever way it lands:

- The tiers are **three** — `full` / `changed` / `none`. `workspace` and `hop`
  were built, measured and **cut as dominated**. Any document listing five is
  stale.
- `changed` was **not only** a memory lever: a third of `full`'s memory and a
  fraction of its wall clock at **zero fidelity cost across 499 contract
  entries**, with identical key sets. Free is worth having whether or not
  anything is scarce.

## `src/git.ts` — `withWorktree` loses its only runtime caller

The audit an earlier draft asked for has been **done**, and the answer is
narrower than it guessed:

| Consumer | Base-side mechanism | Needs a worktree? |
|---|---|---|
| `contracts` | `withWorktree` → `src/run.ts:353` | **the only one** |
| `deps` | `showFile(repo, base, manifest.path)` — `deps.ts:206, 242, 257, 262` | no |
| `patterns` | `showFile(repo, head, file)` — `patterns.ts:213` | no |
| `coverage` | reads an existing artifact; loads no project | no |
| `constants` / `facts` | head-side only | no |

So `withWorktree` (`src/git.ts:622`) has **exactly one** runtime call site, and
the overlay removes it.

**Do not delete the function.** It is exported from `src/index.ts:175` (public
API) and used by four test files —
`tests/no-node-modules.test.ts:108`, `tests/noise-floor.test.ts:159`,
`tests/resolution.test.ts:340`, `tests/git.test.ts:168/192/205`. Two of those
(`no-node-modules`, `git`) test `withWorktree` itself and its
`mirrorNodeModules` option, and both remain meaningful. Keep the function,
record that the TS/JS path no longer uses it, and re-decide it if a later change
removes the last test caller too.

`mirrorNodeModules` becomes **structurally unnecessary for `contracts`** — one
tree, one `node_modules`, so the two sides cannot disagree about what is on
disk. That is a real win *and* it makes a sensitivity proof vacuous; see
[01-spike.md](01-spike.md) → G3, which requires a written decision rather than a
silent deletion.

**One tree also means a different base view, and that is not a free swap.** The
worktree served base blobs for **every** file; the overlay serves them for the
**changed** files and falls through to the working tree for the rest. Equal on a
clean checkout, divergent on a dirty one — measured, and recorded as an open item
in [README.md](README.md)'s risks table. Whatever else the migration does, it
does not get to call this one closed.

## `src/facts.ts` — three changes, one of them a trap

| Today | After |
|---|---|
| `findReferences(nameNode)` → `nameNode.findReferencesAsNodes()` (`:317–324`), wrapped in `try`/`catch` so one odd declaration does not take the extractor down | `Checker.getReferencedSymbolsForNode(node, position)` → `ReferencedSymbolEntry[]`, each with `references: NodeHandle[]`. **Keep the `try`/`catch` and keep it returning `[]` for that symbol only** |
| — | **adopt `Checker.getSignatureUsage(signatureDecl)`** — `SignatureUsage { name: NodeHandle; call?: NodeHandle }` — as a **new** field beside `referenceCount` / `referencesInDiff`. Do not redefine either, or nothing in [01b](../review-evidence-pipeline/01b-code-facts-hardening.md) stays comparable |
| `implementationsOf()` (`:353–376`): a kind filter, a duck-typed narrow (`asImplementationGetable`, `:335`), and `getImplementations()` at `:361` | **`implementations: null` plus a `degraded[]` entry**, unless G-impl came back yes |

**The trap is `[]`.** `implementations` is
`z.array(z.string()).nullable()` (`src/schema.ts:185`), and the three-way
contract already implemented at `:353–376` is:

```
kind the question does not apply to   → null
the query threw                       → null    "looked, could not see"
the query ran                         → []      "looked, found none"
```

An engine with no implementations query is the **first** case, not the third.
Writing `[]` asserts *"this exported interface has no implementers anywhere"* —
an absence claim nobody verified, from the extractor whose whole output is
absence claims. That is the M6 bug (`packages/code-facts/CLAUDE.md` → "Rules":
*"Never write `?? []` on any of the three"*), and tier 2 is heading for ~80% of
the corpus.

The `degraded[]` entry must name the engine, not the symbol — one line per run,
not one per interface, or `degraded[]` stops carrying signal.

## `src/contracts.ts` — the highest-risk file

599 lines, and every phantom-delta bug in this package's history lived here.

### The mapping, corrected

An earlier draft said *"re-point `typeToString`"*. **There is no `typeToString`
in `packages/code-facts`.** What produces type text today is ts-morph's
`Type.getText(enclosingNode)`, at four sites:

| Today | Line | After |
|---|---|---|
| `expression.getType().getText(expression)` | `:85` | `Checker.typeToString(type, enclosingDeclaration?, flags?)` |
| `parameter.getType().getText(parameter)` | `:202` | same |
| `fn.getType().getCallSignatures()[0]?.getReturnType()` | `:206` | `getSignaturesOfType(t, SignatureKind.Call)` → `getReturnTypeOfSignature(sig)` → `typeToString` |
| `node.getType().getText(node)` | `:220` | same |

### Re-validate, do not port

Four functions consume that text and **every one of them was a bug**:

| Function | Line | What broke it |
|---|---|---|
| `canonicalType` | `:454` | counted the `>` of `=>` as a closing bracket, so depth went negative at the first arrow and every function signature was split inside its return type — **12 phantom deltas** with `contracts.test.ts` green throughout |
| `stripImportPaths` | used `:176–177` | matched only `import("…").Member`; a module-namespace type (`typeof import("./x.js")`) survived with an absolute `/private/var/folders/…` prefix intact |
| `shapeOf` | `:169` | the shape the other three operate on |
| `sameShape` | | compares `throws` **raw**, with no `canonicalType` pass |

A different printer changes the input to all four. They are re-validated against
the new printer with the same instrument that caught them:
`tests/noise-floor.test.ts` plus `pnpm selfcheck`, which referees against **git**
rather than against either engine.

### `getExportedDeclarations` is not a rename

`:43` uses ts-morph's `getExportedDeclarations()`, which returns **declarations**
and follows re-exports through barrels — there is a comment at `:45` saying so.
The API equivalent is `Checker.getSymbolAtLocation(sourceFile)` →
`Checker.getExportsOfModule(sym)`, which returns **symbols**, with aliases
needing `getAliasedSymbol` explicitly. `contracts` is keyed on the export set, so
a difference here **changes the key set**, which is the definition of a phantom
delta. Treat it as the highest-risk single mapping in the migration and diff the
key sets on this repo before trusting the count.

### `@throws` must NOT move to `getJsDocTagsOfSymbol`

`:89` reads `node.getJsDocs()`, and `:127–131` reads
`getTypeExpression()?.getTypeNode()?.getText()` — the fix for
[WP1b bug 5](../review-evidence-pipeline/01b-code-facts-hardening.md).

`Checker.getJsDocTagsOfSymbol` returns `JSDocTagInfo { name, text? }` — a **flat
rendered string with no separate type expression**. Adopting it re-creates bug 5
in the same file: `@throws {ValidationError} when the id is empty` recorded
`"when"`.

The route that preserves the fix is the AST, and it is verified to exist:
`Node.jsDoc?: readonly Node[]`, `isJSDocThrowsTag` from
`typescript/unstable/ast/is`, and `JSDocThrowsTag.typeExpression?: TypeNode`.
**UNVERIFIED:** whether the API's wire protocol populates `jsDoc` on a node
resolved through `NodeHandle.resolve()`. If it does not, `throws` degrades to
`null` + a `degraded[]` entry — **never `[]`**, which is an absence claim about a
throw that is documented in the source.

### The structural win, stated precisely

[WP1](../review-evidence-pipeline/01-code-facts.md)'s **227 deltas of which one
was real** had three causes. Two are removed **by construction** here, because
both sides now come from one snapshot over one tree:

- **cause 1, an asymmetric tsconfig between the two programs** — there is one
  set of projects, opened once;
- **cause 2, no `node_modules` on the base side** — there is one tree, so one
  `node_modules`.

**Cause 3 (`canonicalType`, reordered/re-printed type text) is NOT removed.** It
is the one a new printer can make *worse*. That is why G2 is the gate that
matters most.

## `src/constants.ts` — shape unchanged

`:193` uses `findReferencesAsNodes()` for **set A**; it moves to the new checker
with `facts.ts`. **Set B stays on ast-grep** — literal occurrences, via
`findLiteralOccurrences` and `git.listFiles`. The payload shape does not change.

Two invariants carried verbatim:

- `ConstantFact.references` is `null` on tier 2 (there **is** no set A) and an
  array on tier 1; **`ConstantFact.sides` is `null` whenever `references` is** —
  it is a partition of that set. `{server: 0}` from no data is
  indistinguishable from `{server: 0}` measured, and "zero server-side
  references" is the exact shape of the one gold finding this investigation ever
  converted.
- **An extractor that stops early must say so.** `findLiteralOccurrences`
  returns a truncation flag and `extractConstants` turns it into a `degraded[]`
  entry naming the ceiling, how many files were eligible and how many were read.
  An absence claim over a truncated file set is not weak, it is **unsound**.

## `src/syntactic.ts` + `src/langs/` — untouched

904 + ~560 lines, the tier-2 name-match engine and its `LanguageDescriptor`
tables. It is a *second* reference engine by design and does not go through the
compiler at all. Its only coupling to this work is the `DEFAULT_MAX_FILES`
import noted above.

`nameAmbiguity` stays **data, never a filter**.

## `src/schema.ts` — envelope `version: 2`

| Field | Today | After |
|---|---|---|
| `version` | `z.literal(1)` (`:106`) | `z.literal(2)` |
| `engine` | `z.enum(["ts-morph", "ast-grep", "none"])` (`:77`) | `z.enum(["tsgo", "ast-grep", "none"])` |
| `resolution` | `{ tier, allowed }` (`:134`) | dropped **if** `src/resolution.ts` is dropped (see the condition above) |
| `SymbolFact.implementations` | `z.array(z.string()).nullable()` (`:185`) | **unchanged**, and the `null` semantics are what the migration turns on |
| `SymbolFact.resolution` | `z.enum(["type-aware","name-match"])` (`:166`) | unchanged — it describes how the reference set was obtained, not which compiler obtained it |

**Cheap, and here is the evidence rather than the assertion.** Grepped
2026-08-22: `code-facts` has **zero runtime call sites in `apps/server`** — the
only matches are a doc comment in `apps/server/src/engine/review-spec.ts:80` and
the CLI's dynamic import at `packages/cli/src/cli.ts:1356`. Nobody consumes the
envelope yet. This is the last cheap moment to change it.

`tests/schema.test.ts` and `src/run.ts`'s "every document validates against its
zod schema before it is written" rule are unaffected in principle and must stay.

## `src/toolchain.ts` + `compilerInfo()` — and a correction about `toolchain.json`

`compilerInfo()` lives in **`src/project.ts:61`**, not in `src/toolchain.ts`. It
returns `{ version: ts.version, modulePath: vendoredCompilerPath() }`. After the
migration it reports the **`typescript` package version** and the **resolved
platform package path** (`@typescript/typescript-<platform>-<arch>`), which is
what `typescript/lib/getExePath.js` actually spawns.

`bundledVersions()` **is** in `src/toolchain.ts:235`. It reads the *installed*
`package.json` of each npm-resolved engine. Its list becomes
`["typescript", "@ast-grep/napi"]`; `ts-morph` goes.

### `toolchain.json` gets nothing — and that is the file's own rule

An earlier draft said *"add the tsgo platform binary to `toolchain.json` so
`sandbox-base.Dockerfile` pins it"*. That contradicts the manifest's stated
policy, quoted from its own `$comment`:

> **WHAT IS DELIBERATELY *NOT* HERE: the npm-resolved engines** (ts-morph,
> @ast-grep/napi, zod). They are pinned by `package.json` + `pnpm-lock.yaml`,
> which is a stronger pin than a hand-maintained copy, and duplicating them here
> would create exactly the drift this file exists to prevent.

`toolchain.json.binaries` is for binaries **downloaded from a release URL** —
each entry carries per-platform `sources` (opengrep, gitleaks). The tsgo
executable is not one of those: it arrives as an npm `optionalDependency` and is
resolved by `getExePath()` relative to the installed `typescript` package. By
the manifest's own rule it belongs in `bundledVersions()`, stamped from the
installed package, **not** in `binaries` with a fabricated URL.

**What WP2 actually needs is different, and is a real requirement.** Only the
matching optional dependency installs: this checkout has exactly
`@typescript+typescript-darwin-arm64@7.0.2` and nothing else. A linux image that
does not install its own gets a `typescript` that imports fine and a `tsgo` that
does not exist. So:

- the envelope stamp records the **resolved platform package and its path**, so
  "which compiler produced this document?" stays answerable;
- the package **probes at startup** that the executable exists and fails loud if
  it does not — the same guard, for the same reason, as WP1c's
  `registerLanguages()` rule (`09-external-validation.md:163`: *"MUST
  `existsSync(libraryPath)` before the native load"*);
- `apps/server/sandbox-base.Dockerfile` gets whatever it needs from the
  lockfile-driven `pnpm deploy` bundle it already builds, not from a URL.

## `src/run.ts` / `src/cli.ts` / `src/index.ts`

| File | Change |
|---|---|
| `src/run.ts` | `loadProject` → `openSnapshot`; the `withWorktree` block at `:353` becomes an overlay `API`. The `--never-fail` wrapper, the `coverage`/`degraded[]` contract and the schema-validate-before-write rule are **unchanged** |
| `src/cli.ts` | `--resolution` and its validator (`resolutionFlag`, `:133`) go with `resolution.ts`; `--max-files` / `--max-projects` (`:53–54`) go with the budget. `--never-fail` (`:71`), `--tsconfig` (`:52`) and the exit-code contract (`0` trustworthy · `2` could not run · `3` degraded) stay |
| `src/index.ts` | drop the deleted exports; keep `withWorktree` (`:175`) and `isScannablePath` (`:115`) |
| `packages/cli/src/cli.ts` | **no change** — the import at `:1356` is already dynamic, and it must stay dynamic. ts-morph was ~14 MB on `lastlight login`'s startup path; a spawned compiler is worse, not better |

## `package.json` / `toolchain.json`

```diff
 "dependencies": {
   "@ast-grep/napi": "^0.45.1",
-  "ts-morph": "^28.0.0",
+  "typescript": "7.0.2",            ← EXACT, and a real dependency
   "zod": "^4.3.6"
 },
 "devDependencies": {
-  "typescript": "^7.0.2",
+  "typescript": …removed; it is a dependency now
 },
 "keywords": [
-  "ts-morph",
+  "typescript",
   "ast-grep", …
 ]
```

**Exact-pinned, not `^7.0.2`.** The API is namespaced `unstable/`; its export map
and its shapes are allowed to move under a minor. A caret here is an unpinned
compiler in a package whose whole job is producing reproducible documents, and
`tests/invariants.test.ts` already asserts the document does not depend on the
host.

`toolchain.json` is **unchanged** — see the correction above.

## Tests

| File | Disposition |
|---|---|
| `tests/compiler-isolation.test.ts` | **Updated and its invariant STRENGTHENED.** Still: never `require.resolve("typescript", { paths: [repoDir] })` anywhere in `src/`, comments stripped first so the doc comments that *name* the forbidden shape do not trip it. **Additionally**: assert the `typescript` that resolved is the **pinned copy** (exact version, path under this package's own dependency tree), and that the spawned executable is the bundled platform package. Verified 2026-08-22: `getExePath()` resolves relative to the installed `typescript` package's `__dirname` and **does not consult `cwd`** — so `new API({ cwd: repo })` cannot pull a compiler out of the repo under review. Assert it anyway; that is what the file is for |
| `tests/resolution.test.ts` | deleted **with** `src/resolution.ts`, and only if that file goes (see the condition) |
| `tests/multi-project.test.ts` | mostly deleted with the budget/grouping mechanisms. **Two halves survive and must be re-homed**: `--repo .` normalising to an absolute path (a coverage bug that read as clean — 31 files globbed against 1), and `--tsconfig` forcing one program *and* disabling the glob fallback |
| `tests/noise-floor.test.ts` | **kept, with a recorded decision on cause 2** — the `node_modules`-mirror floor may become unreachable. [01-spike.md](01-spike.md) → G3 |
| `tests/no-node-modules.test.ts` | **kept as-is.** It deletes `node_modules` and asserts `facts`/`contracts`/`constants` still work. It gets *more* important: the new engine's `node_modules` behaviour is unmeasured |
| `tests/oom.test.ts` | **needs a decision recorded, not a silent deletion.** Its premise — an unclosable hole — largely stops being true: the compiler is a child process, and a dead child raises on the client side where `--never-fail` can catch it. But its header explicitly warns against "fixing" it into a false guarantee, and **§D12's shell-level catch must survive regardless**, because a segfault in `@ast-grep/napi` is still reachable and still kills V8 before any `catch`. The honest end state is: keep the test, re-point it at the surviving hole, and keep the shell catch |
| `tests/merge-base.test.ts` | **kept and load-bearing.** The overlay is a new git-range consumer |
| `tests/invariants.test.ts` | kept. "the document must not depend on the host" is exactly what an exact pin is for |
| new | `tests/tsgo.test.ts` — the seam's own gate. It does not exist yet; `src/tsgo.ts`'s header already references it, so the reference is currently a promise |
| new | one test asserting **nothing outside `src/tsgo.ts` imports `typescript/unstable/*`** |
| new | one test per silent-failure mode: a tsconfig that will not parse must land in `failures[]` as `tsconfig-unparsable` and **not** appear in `projects`; a tsconfig that does not exist must land as `tsconfig-absent`. Both are invisible in this API by default |
| new | one test pinning the **0-based → 1-based** line-number conversion. `getLineAndCharacterOfPosition` is 0-based; `getStartLineNumber()` was 1-based; eleven call sites feed `path:line` citations that `selfcheck` cross-checks against `git diff -U0`. An off-by-one does not throw — it shifts every citation by one line |

## Acceptance, and what "done" means

1. `pnpm turbo run typecheck test build` green from the repo root.
2. `pnpm --filter lastlight-code-facts selfcheck` exit 0, with the analysed
   count **at or above** today's ~30 of 31 and the phantom-capable delta count
   at or below today's.
3. A full corpus run whose entity sets do not shrink against
   `2026-08-21_140115-c8530b83` (G1), whose EC-strict does not fall (G5), and
   whose `rollup.peakRssMb` is reported at all three percentiles (G4).
4. `grep -rn "ts-morph" packages/code-facts/` returns only historical prose in
   docs and comments — no imports, no `package.json` entry, no keyword.
5. Every `degraded[]` reason that named a deleted mechanism is either gone or
   re-worded. A `degraded[]` line about `--max-projects` in a document produced
   by an engine that has no projects budget is worse than no line at all.
6. **The document is still honest about what it did not see.** The migration
   deletes cost management, not epistemics: `null` ≠ `[]`, tier ≠ coverage, an
   empty result is never a pass.
