# WP1 — `packages/code-facts`, the deterministic layer

**Goal.** A CLI that runs inside the sandbox against the PR checkout and emits
JSON facts about the change — the substrate every later phase reasons over. No
model spend, no network beyond the package registry, no dependency on the rest
of the workspace.

**Why this is the first work package.** v3's enumerator was regexes over the
diff, and it still produced the investigation's only gold match
([00-evidence §3](00-evidence.md)). The one converted finding had exactly this
shape — *"`MAX_TOKEN_AGE` is consumed at `client/session.ts:41` only, zero
server-side references"* — which is a **reference query**, guessed. Making it
mechanically true is the highest-leverage single change available.

## Package shape

A **private leaf** package: no `workspace:*` dependencies in either direction,
like `packages/agentic-pi`. `scripts/lint-import-boundaries.mjs` runs in
`typecheck` and must be given a rule for it.

```
packages/code-facts/
  package.json          private: true · type: module · bin: lastlight-facts
  tsconfig.json         extends ../../tsconfig.base.json (copy workflow-engine's)
  src/
    cli.ts              arg parsing + the fail-loud wrapper
    git.ts              diff hunks, changed paths, base/head trees
    project.ts          ts-morph Project construction (see "The TS 7 landmine")
    facts.ts            changed symbols + impact cone
    contracts.ts        signature/shape delta, base vs head
    constants.ts        references minus literals
    deps.ts             manifest delta + `npm pack` source staging
    patterns.ts         opengrep + gitleaks adapters
    mutants.ts          StrykerJS, diff-hunk scoped
    schema.ts           zod schemas for every emitted document
    errors.ts           FactsError + the exit-code contract
  tests/                vitest, offline, fixture repos under tests/fixtures/
```

`package.json` mirrors `packages/workflow-engine/package.json` (ESM, `engines.node >= 22.12`,
`build: tsc -p tsconfig.json`) plus:

```json
"private": true,
"bin": { "lastlight-facts": "dist/cli.js" }
```

**Not published.** It reaches the sandbox by vendoring
([WP2](02-sandbox-image.md)), the same route `agentic-pi` takes. Keeping it
private avoids a seventh npm package and a release-order edge.

## The TS 7 landmine — read before writing `project.ts`

**TypeScript 7 has no programmatic compiler API.** `tsgo` ships a CLI and an LSP
server; the API is explicitly "not ready". This workspace is already on TS 7
(`typescript: ^7.0.2`), and so are the target repos.

Three rules follow, and they are not negotiable:

1. **`ts-morph@28` is the primary engine**, because it vendors its own compiler
   and has **no `typescript` dependency**.
2. **Never resolve `typescript` from the repo under review.** Construct the
   `Project` from the pre-baked bundle's own module resolution only. A
   `require.resolve("typescript", { paths: [repoDir] })` anywhere in this
   package is a bug.
3. **Fallback tier** for repos ts-morph cannot load: `tsgo --lsp --stdio` +
   `textDocument/references`. Ship this behind a flag in a later pass — record
   the seam in `project.ts` now, do not build it in WP1.

This is the same failure mode that already bit us once: dependency-cruiser
refused to parse TS≥7 and **exited 0 anyway**, so the import-boundary gate went
green while seeing nothing (root `CLAUDE.md`). That is why WP1's headline
acceptance criterion is about failing loudly, not about coverage.

## The fail-loud contract

`errors.ts` defines the exit-code contract, and `cli.ts` enforces it:

| Exit | Meaning |
|---|---|
| `0` | Analysis ran and the result is trustworthy. May legitimately contain zero findings **only** with `"coverage": "full"` |
| `2` | Analysis could not run (project load failed, tool missing, tool crashed). **Nothing downstream may treat this as "no obligations"** — but see the wrapper rule below: exit 2 must **not** fail the phase |
| `3` | Analysis ran in a degraded tier — emits results **plus** a populated `degraded[]` explaining which extractors were unavailable and why |

Every emitted document carries a mandatory envelope:

```jsonc
{
  "version": 1,
  "generatedAt": "2026-08-21T…",
  "repo": "nearform/skillspro",
  "baseSha": "…", "headSha": "…",
  "coverage": "full" | "degraded" | "none",
  "degraded": [ { "extractor": "mutants", "reason": "base test suite red" } ],
  // …extractor payload
}
```

A consumer that sees `coverage: "none"` must say so in the obligations file
rather than emitting an empty list. **An empty obligation list and an
unavailable analyser must never be indistinguishable.**

> **Loud in the artifact, never fatal to the run
> ([10-design-review.md](10-design-review.md) §D12).** `schema.ts:83` — *"A
> non-zero exit fails the phase"* — and `cron-review.yaml` runs `*/30 * * * *`
> with `assessedHeadShaByWorkflow` populated **from succeeded runs only**
> (`pr-decisions.ts:918`). So a `facts` phase that exits 2 fails the run, records
> nothing, gets re-dispatched in thirty minutes, and exits 2 again — forever, at
> 2–3× the cost of the incident that comment documents (*"1260 review
> executions, 0 posted, ~$1.30/hour"*).
>
> **The wrapper therefore catches the non-zero exit, writes the envelope with
> `coverage: "none"` and a populated `degraded[]`, and returns 0.** The
> requirement above is satisfied entirely by the envelope. The exit code was
> never what made it loud.
>
> Exit codes stay in the contract because the CLI is also run by hand and by its
> own tests, where they are the right signal. It is the *phase wrapper* that
> translates them.

## Subcommands

All take `--repo <dir> --base <ref> --head <ref> --out <file>` and write JSON.

### `facts` — the impact cone

The core extractor. Answers, for every symbol the diff touched:

- which **hunks** changed it (`git diff -U0`, so hunk ranges are line-exact and
  map 1:1 onto StrykerJS's `file.ts:start-end` mutation-range syntax);
- every **reference site**, cross-file, cross-barrel and cross-workspace
  (ts-morph `findReferences`, cross-checked with `knip --trace-export`, which
  has no `typescript` dependency and is therefore TS-7 safe);
- **callers** and **callees**;
- **implementations / overrides** of a changed interface or abstract member;
- which **test files** reference the symbol.

```jsonc
{
  "symbols": [{
    "name": "getUser", "kind": "function",
    "declaredAt": "src/user.ts:14",
    "changedHunks": ["src/user.ts:12-19"],
    "references":     [{ "at": "src/api/handler.ts:88", "inDiff": false }],
    "implementations":[],
    "tests":          ["test/user.test.ts"],
    "referenceCount": 7, "referencesInDiff": 1
  }]
}
```

`referencesInDiff` vs `referenceCount` is the single most productive field: a
symbol whose shape changed in the diff and whose references are *mostly outside
it* is the cross-file contract bug the reviewer most needs to find, and it is
invisible in the diff because each file reads correctly alone.

### `contracts` — the semantic delta

Two `Project`s over the same checkout — one at `base`, one at `head` (use `git
worktree add` into a temp dir, or a second checkout; do **not** mutate the
agent's working tree). For each changed **exported** symbol, emit the before/
after of: signature, parameter types, return shape, nullability, thrown types,
and — where cheaply derivable — ordering/units conventions from the declaration.

```jsonc
{ "symbol": "getUser",
  "before": { "returns": "User | null" },
  "after":  { "returns": "User", "throws": ["NotFoundError"] },
  "consumersOutsideDiff": ["src/api/handler.ts:88"] }
```

This is the memo's "change-contract reviewer" made mechanical, and it is
directly the `getUser() -> User | null` → `throws NotFound` class of regression.

### `constants` — references **minus** literals

The subtraction is the insight. For each changed constant/config value:

- **A** = every reference to the identifier (ts-morph);
- **B** = every occurrence of the literal *value* (ast-grep);
- report `A`, and report `B \ A` as **hard-coded duplicates** — sites that use
  the value without going through the constant.

A constant with references only on one side of a boundary — defined in config,
read by the client, never compared server-side — is exactly the `1587-r2`
Critical. Emit that as a first-class shape:

```jsonc
{ "constant": "MAX_TOKEN_AGE", "declaredAt": "src/config.ts:12",
  "references": ["src/client/session.ts:41"],
  "hardCodedDuplicates": ["src/legacy/auth.ts:203"],
  "sides": { "client": 1, "server": 0 } }
```

`sides` is a heuristic partition (path-prefix based, configurable); it is a hint
for the seeder, never a finding on its own.

### `deps` — manifest delta and staged source

- `package.json` diff: added/removed/bumped, `dependencies` vs `devDependencies`.
- For each **changed runtime** dependency, `npm pack <pkg>@<locked-version>` and
  unpack under `.lastlight/pr-review/deps/<pkg>/`. Registries are already on the
  strict egress allowlist, so this needs no firewall change.
- `npm diff --diff=pkg@a --diff=pkg@b` for the source delta on a bump.

**This is the affordance fix**, not a nicety. The review workspace has no
`node_modules`, so "open the library source" was *structurally impossible*
([00-evidence §3](00-evidence.md)). Staging it turned that into a one-`read`
action and the model then quoted implementation lines.

Carry forward two v3 bug fixes: the tooling denylist must **not** use an
`^eslint` prefix (it swallowed `eslint-plugin-require-extensions`, the package
the `1641-r2` gold lives in — lint/format packages appear in added imports
precisely when a config *is* the diff, i.e. when they are the subject), and the
import scan must recognise `createRequire(...)("pkg")`.

### `patterns` — the cheap scanners

- **Opengrep** on changed files only (`--include=` per file). **Not** Semgrep:
  its registry rules moved to a licence that plausibly excludes a review product.
  Never `--config auto .` over the whole tree — the noise drowns the signal.
- **Gitleaks** over the commit range.

Normalise both into the common finding shape `skills/security-review/SKILL.md`
already defines — `{ fingerprint, severity, tool, rule, file, line, title }`,
`fingerprint = sha1(tool:rule:file:3-line-context)`. Reuse that vocabulary
rather than inventing a second one.

**These are evidence, not findings.** They are seeds for the survey, and they
are never posted directly. A static-analyser hit rewritten prettily by an LLM
and posted is the anti-pattern.

### ~~`mutants` — diff-scoped mutation seeding~~ — CUT

> **Cut 2026-08-21 ([10-design-review.md](10-design-review.md) §D13).** The
> `tests` family plausibly contributes one or two findings across the whole gold
> set, and §D6's detection floor puts that permanently inside the noise. So
> **rung 2b — the measurement whose entire purpose was to decide whether
> `mutants` earned its keep — cannot return a readable answer on this
> instrument.** Building it means paying the highest per-phase cost in the plan
> for a number known in advance to be unreadable.
>
> **Coverage takes the `tests` family's place** (see `dynamic` below): cheaper,
> reuses `prepare`, needs no green baseline, and gives the same both-ends shape
> with better provenance. Cutting it also deletes `suite`, the longest
> wall-clock item in the pipeline.
>
> What is given up: *"the PR changed this expression and no test distinguishes it
> from a mutation"* is a stronger claim than "untested line" when it fires. **If
> coverage shows the `tests` family converts at all, mutation seeding becomes a
> well-motivated follow-on** — this is a deferral with a trigger, not a
> rejection. The section is kept below for whoever picks that up.



**Gated on the `suite` phase reporting a green baseline** ([WP4](04-probe-oracle.md)),
which itself only runs when `review.analysis.mutants` is on. This extractor is
the sole reason a full test run exists anywhere in the pipeline, so if it does
not earn its keep at rung 3, both it and `suite` are deleted rather than tuned —
see `dynamic` above for the cheaper replacement.
StrykerJS's mutation-range syntax (`file.ts:start-end`) maps 1:1 onto diff hunks
via a `git diff -U0` awk one-liner.

Every **surviving** mutant on a changed line is a mechanism-granular obligation
with machine-verified provenance: *"the PR changed this expression and no test
distinguishes it from a mutation."* That is a far stronger finding than
"consider adding more tests" — it names the boundary.

Two rules:

- **Never report "0 surviving mutants" from a suite that did not run.** That is
  the fail-loud rule with money on it — it would read as "well tested".
- Equivalent-mutant filtering is required; Meta ACH's detector runs 0.79/0.47
  raw and 0.95/0.96 with preprocessing. Start with a conservative filter and
  count filtered mutants in `degraded[]`.

### `dynamic` — deferred, and the most promising future family

Not built in WP1. Recorded here because it changes what the extractor set should
grow into, and because it is **cheaper than the mutation path it partly
replaces**.

Every extractor above is static. But once a tree is runnable
([WP4](04-probe-oracle.md)'s `prepare`), dynamic data can **constrain the impact
cone before the model ever sees it**:

| Signal | Constrains the cone how |
|---|---|
| **line/branch coverage** on changed lines | a changed line covered by zero tests is a `tests` obligation with better provenance than a surviving mutant, and a coverage run is far cheaper than a mutation run |
| **which tests execute a changed symbol** | names the oracle for that symbol — `falsify` gets a runner instead of inventing one |
| **differential behaviour** base vs head on existing tests | a behavioural delta the PR did not intend is a finding; one it did intend is a `spec` obligation. We uniquely have two executable versions |
| **call traces from the existing suite** | resolves dynamic dispatch that ts-morph cannot — the known weak spot of purely static reference maps |

The distinction from `falsify` matters: these are **facts that narrow the search
space**, produced before generation. `falsify` is a **verdict** produced after.
Mixing them would reintroduce the v2 ordering error.

Sequencing note: coverage subsumes a good part of what `mutants` is for, at a
fraction of the cost. If the rung-3 ablation shows `mutants` not earning its
keep, build this instead of tuning it.

### `seed` — obligations

Pure function over the outputs above. Specified in
[03-seed-and-survey.md](03-seed-and-survey.md), because its contract belongs
with its consumer.

## Language tiers

TypeScript/JavaScript is first-class. Everything else degrades **explicitly**:

| Tier | Available | Extractors |
|---|---|---|
| 1 | TS/JS with a resolvable project | all |
| 2 | TS/JS, project load failed | `deps`, `patterns`, `constants` (ast-grep only, no `A` set) |
| 3 | any other language | `deps`, `patterns` |

A tier-2 or tier-3 run emits `coverage: "degraded"` and a populated `degraded[]`
naming what is missing. **Silence is the failure mode we are engineering
against.**

## Acceptance criteria

1. `lastlight-facts facts` on a fixture repo emits the `1587-r2`-shaped
   obligation input **mechanically** — `MAX_TOKEN_AGE` declared once, referenced
   only on the client side, zero server references. This is the WP's headline
   test and it should be a checked-in fixture, not a live repo.
2. Pointed at a **TypeScript 7** repo the analysis either succeeds or **exits 2
   with a named reason**. It never exits 0 with an empty symbol list.
3. `node_modules` in the target repo is neither required nor consulted for
   `facts`/`contracts`/`constants`. Verified by a test that deletes it.
4. No `typescript` resolution from the target repo. Verified by a unit test
   asserting the resolved compiler path is inside the package's own tree —
   mirror `tests/state/driver-isolation.test.ts`, which pins an equivalent rule.
5. Every subcommand's output validates against its zod schema in `schema.ts`.
6. Wall clock under **90 s** on a `skillspro`-sized PR with a warm cache. If it
   is slower, that is the signal to revisit locked decision 4 (index vs
   recompute) — record the number either way.
7. `pnpm turbo run typecheck test build` green, including the import-boundary
   gate.

## Tests

Offline and AI-free, in the style of `apps/evals/src/mechanism.test.ts`:

- **Fixture repos** under `tests/fixtures/` — small git repos created in
  `beforeAll` with two commits (base, head), so `git diff` is real. One per
  shape: cross-file contract change, constant-enforced-on-one-side,
  barrel/re-export chain, dependency bump, non-TS repo.
- **Degradation tests** — a repo with a broken `tsconfig.json`; assert exit 3
  and a populated `degraded[]`, *not* exit 0.
- **Golden JSON** for `facts` on the constant fixture — this is the regression
  guard for the one shape we know converts.

## Non-goals for WP1

- **No workflow change.** `pr-review.yaml` is untouched; the CLI is exercised by
  its own tests only. Wiring is [WP3](03-seed-and-survey.md).
- **No CodeQL.** Locked decision 7.
- **No persistent index, no SCIP, no embeddings.** Locked decision 4.
- **No `tsgo --lsp` fallback yet** — leave the seam, build it when a tier-2 repo
  actually blocks a measurement.
- **No prompt or skill edits.**
