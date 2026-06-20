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
subdirectory — check with `ls -la`). Git is configured for clone/push/pull/fetch.
If auth fails after ~1 hour, call the `github_refresh_git_auth` MCP tool. Suppress
noise where it helps: `git clone --quiet`, `git push --quiet`, `CI=true`.

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

## The gate

While iterating, run **only the tests covering the files you touched** — not the
whole suite on every edit. Then, **once before committing or claiming done, run
the full gate and require all of it to pass:**

1. Full test command — zero failures.
2. Lint command (if present) — fix all errors.
3. Typecheck command (if present) — fix all errors.

If any step fails, fix it and re-run only what failed until clean. Do not commit
or report done until the full suite, lint, and typecheck all pass. Cite the
actual command output — static reasoning is not verification.

## TDD (when implementing)

When you are *writing* code (not just verifying a PR): write the **failing test
first**, watch it go red, then implement until it goes green, then refactor.
Test behaviour through the public interface, not implementation details. The red
test is the proof the test can fail — a test that was never red proves nothing.
