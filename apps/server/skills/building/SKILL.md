---
name: building
description: Install dependencies and run the test/lint/typecheck gate for a change inside the sandbox — package-manager detection, install-first, and (when implementing) TDD discipline. Use when implementing, fixing, or verifying code in a pre-cloned repo.
version: 1.0.0
tags: [build, test, sandbox]
---

# Building

How to install, build, test, and gate a change in the sandbox. The same
discipline whether you're implementing a feature, fixing review feedback, or
verifying someone else's PR.

## Workspace & git

The harness pre-cloned the repo; your cwd is the repo root (or a `<repo>/`
subdirectory — check with `ls -la`). Git is configured for clone/fetch/pull and
local commits. If auth fails after ~1 hour, call the `github_refresh_git_auth`
MCP tool. Suppress noise where it helps: `git clone --quiet`, `CI=true`.

Getting work onto the branch is not a git operation: a commit built by git here
is unsigned and a repo that requires signed commits blocks it permanently, so a
phase that publishes does it with `github_publish` rather than `git push`. Your
prompt says whether yours publishes and with what arguments.

## Install-first

`node_modules` (and any other dependency dir) is **always** absent on arrival —
by design, not a blocker. **Installing is the first step, not a reason to skip
verification.** Detect the package manager from the lockfile and use the
frozen/CI variant:

- `package-lock.json` → `npm ci`
- `pnpm-lock.yaml` → `corepack pnpm install --frozen-lockfile`
- `yarn.lock` → `corepack yarn install --frozen-lockfile`

Node is available via `fnm` + `corepack`; the egress allowlist permits the public
package registries, so install works. For a monorepo, install at the root, then
operate on the changed package. For non-Node repos, use the ecosystem's
equivalent (`pip install`, `cargo build`, `go mod download`, …) read from the
project's manifest.

The **only** acceptable "couldn't verify" is when the install or build command
*itself* fails — quote the exact command and error, and scope your work to what
you could check. Never cite "deps aren't installed" as the reason: you install them.

**If the repo's only test path needs an external service that won't run in the
sandbox** (a live database, a cloud API, a running daemon), do **not** report
that verification "could not run." Add a focused unit or CLI test project that
exercises your change against in-memory fixtures or fakes, run *that*, and paste
its output. A change you couldn't execute even once is unverified — building a
runnable path is part of the work, not an optional extra.

## The gate

While iterating, run **only the tests covering the files you touched** — not the
whole suite on every edit. Two habits keep that inner loop fast, and a slow
feedback loop is what burns your time budget:

- **Turn coverage off** for inner-loop runs — coverage is a CI-gate concern, not
  a feedback one, and instrumenting the whole tree can be several times slower
  (`--coverage=false`, or your runner's equivalent).
- **Batch touched files into one invocation**, not one run per file. A runner
  pays a fixed startup/compile cost per invocation (often tens of seconds on a
  cold cache — the sandbox is always cold), so N separate runs pay it N times.
  If the whole suite finishes in time comparable to a handful of files, just run
  it once.

Then, **once before committing or claiming done, run the full gate and require
all of it to pass.** Before running, determine the repo's real CI sequence —
check `AGENTS.md`/`CLAUDE.md`/`CONTRIBUTING.md` first for documented build/test
commands; only if those files contain no clear instructions should you fall back
to reading `.github/workflows/*.yml` (the job that runs on PRs). Workflow
definitions carry a high risk of invoking CI-only steps (Docker builds, secret
injection, environment bootstrapping) that are not suitable for local dev and
will fail or produce misleading results in the sandbox. **Prefer the commands
explicitly documented for contributors over anything inferred from CI.** The
generic list below is the fallback when no instructions are discoverable; it is
a floor, not a ceiling.

1. Build command (if present, e.g. `npm run build`, `vite build`,
   `cargo build`) — must succeed. Many bundler/PostCSS/frontend failures
   (and codemod-requiring major bumps) surface ONLY here, not in typecheck.
   Note that a frontend build of `tsc && vite build` passes its `tsc` half
   yet can still fail inside `vite build` — do not skip the build step just
   because typecheck passes.
2. Full test command — zero failures.
3. Lint command (if present) — fix all errors.
4. Typecheck command (if present) — fix all errors.

If any step fails, fix it and re-run only what failed until clean. Do not commit
or report done until the full build, test suite, lint, and typecheck all pass.
Cite the actual command output — static reasoning is not verification.

## TDD (when implementing)

When you are *writing* code (not just verifying a PR): write the **failing test
first**, watch it go red, then implement until it goes green, then refactor.
Test behaviour through the public interface, not implementation details. The red
test is the proof the test can fail — a test that was never red proves nothing.

## Decomposition budget (when implementing)

The gate passing is necessary, not sufficient — a green test does not excuse an
unmaintainable function. Before you commit, decompose:

- Keep each function under **roughly 15 cyclomatic complexity** (branches +
  loops + boolean operators). If you're past that, extract helpers.
- One function = one responsibility. A function that **parses, validates, and
  emits is three functions** — split it before committing, not "later."
- The refactor step of red-green-refactor is where this happens. Don't skip it
  because the tests already pass.

## Type safety — no compiler-silencing assertions

The gate requires `tsc` (or the project's typechecker) to pass — but passing it
by *suppressing* it is a regression, not a fix. **Never** use `as any`, an
unchecked `as`-cast, `@ts-ignore`/`@ts-expect-error`, `# type: ignore`, or the
equivalent to:

- silence a compiler error instead of fixing the underlying type, or
- bypass a validator/guard the same code path defines (e.g. casting past a Zod
  schema, a runtime type guard, or a parse function so the value skips the very
  check that file exists to enforce).

If the types genuinely can't express something, narrow with a real type guard or
fix the type — don't assert your way past it.
