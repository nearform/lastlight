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
| 1 | TS/JS with a resolvable project | all |
| 2 | TS/JS, project load failed | `deps`, `patterns`, `constants` (ast-grep only, **no reference set A**), `coverage` |
| 3 | any other language | `deps`, `patterns`, `coverage` |

Tier 2 and 3 emit `coverage: "degraded"` and a populated `degraded[]` naming what
is missing. **Silence is the failure mode we are engineering against.**

## The extractors

| Command | What it answers |
|---|---|
| `facts` | which hunks changed each symbol, every reference site, implementations, callees, which tests touch it. `referencesInDiff` vs `referenceCount` is the most productive field: a symbol whose shape changed and whose references are mostly OUTSIDE the diff is the cross-file contract bug, invisible because each file reads correctly alone |
| `contracts` | signature / parameter / return / nullability / thrown-type delta for every changed export, base vs head, plus `consumersOutsideDiff`. The base tree is a `git worktree add --detach` into a temp dir — **never** mutate the agent's working tree, which is reused across runs and read concurrently |
| `constants` | **references MINUS literals.** A = references to the identifier (ts-morph); B = occurrences of the literal value (ast-grep); report A, and `B \ A` as hard-coded duplicates. `sides` is a heuristic path partition and a hint for the seeder, never a finding. This is the `1587-r2` shape — the one gold finding the whole investigation converted |
| `deps` | manifest delta, import sites, and (with `--stage`) `npm pack` of changed runtime deps into `.lastlight/pr-review/deps/`. **The staging is the affordance fix, not a nicety** — the review workspace has no `node_modules`, so "open the library source" was structurally impossible |
| `patterns` | opengrep + gitleaks, scoped to the diff, normalised into `skills/security-review/SKILL.md`'s finding shape. **Evidence, not findings** — never posted directly |
| `coverage` | changed lines executed by zero tests, read from an **existing** report. It never runs a suite |
| `all` | one envelope, every payload — what a workflow phase writes |
| `toolchain` | the manifest and what actually resolved |

Two carried-forward v3 bug fixes live in `deps.ts` and must not regress: the
tooling denylist is **exact-match, never an `^eslint` prefix** (the prefix
swallowed `eslint-plugin-require-extensions`, the package the `1641-r2` gold
lives in), and the import scan recognises `createRequire(...)("pkg")`.

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

## Rules

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
- **The CLI's import of this package must stay dynamic.** ts-morph is ~14 MB of
  vendored compiler and must never be on `lastlight login`'s startup path.
