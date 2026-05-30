# Operational Rules

## Workspace

Your current working directory depends on the workflow:

- **Code-writing workflows** (`build`, `pr-fix`, `pr-review`): the harness
  has already pre-cloned the target repo, and your cwd is the **repo root**
  (`<workspace>/<repo>/`), already checked out on the right branch. Just
  start working — no `git clone`, no `cd`. Git credentials and identity
  are pre-configured.

- **Read-only / repo-less workflows** (`issue-triage`, `repo-health`,
  `explore`, etc.): cwd is the workspace root, with no repo pre-cloned.
  These workflows usually don't need a local checkout — read issues, PRs,
  files, and commits through the `github_*` tools directly. If you do
  need source, clone into a `<repo>/` subdirectory and `cd` in.

In both cases the harness drops a concatenated `AGENTS.md` at the
workspace root (one level above the repo when pre-cloned). Pi auto-loads
it on the directory walk, so you don't need to read it explicitly.

`.lastlight/issue-N/` is the cross-phase scratch dir. When the repo is
pre-cloned it lives inside the repo (so commits go in with the rest of
the work); otherwise it sits at the workspace root.

Use **relative paths** from cwd. Never write absolute paths like
`/home/agent/workspace/...` or `/home/lastlight/...` — those are stale
and won't exist in every backend.

## GitHub-First Coordination

**All work is coordinated through GitHub issues.** Regardless of where a request originates, GitHub is the single source of truth.

- **If an issue already exists:** Use it. Post context, progress, and results as comments.
- **If no issue exists:** Create one in the appropriate repo before starting work.
- **Every phase of work** posts a brief update to the issue: architect analysis summary, executor progress, reviewer verdict, PR link.

## Git Authentication

When the harness invokes you via a sandboxed workflow, a short-lived
GitHub installation token is already injected into your VM environment as
`GITHUB_TOKEN` and `GH_TOKEN`. Git's credential helper is pre-configured
to use it, and so is the `gh` CLI:

- `git clone https://github.com/<owner>/<repo>.git .` — just works.
- `git push origin <branch>` — just works.
- `gh pr create`, `gh pr view`, etc. — just work.

You don't need to mint tokens or call any auth helper. If a request
fails with 401, the token expired (~1 hour lifetime); just let the
harness know and it'll start a new run with a fresh token.

## Managed Repositories

The set of repositories you manage is configured by the operator (in
`config/default.yaml` or the deployment overlay) — not listed here. The harness
only ever dispatches you against managed repos, so you can treat whatever repo a
task targets as in-scope.

**After cloning, always read the repo's own docs first:**
1. Check for `CLAUDE.md`, `AGENTS.md`, or `CONTRIBUTING.md` in the repo root
2. Read them before doing any analysis, testing, or implementation
3. These files contain project-specific commands, conventions, and architecture notes

## Review Guidelines

When reviewing pull requests, follow this priority order:

### Critical (must fix before merge)
- Security vulnerabilities (injection, auth bypass, secret exposure)
- Data loss risks
- Breaking API changes without migration path
- Missing error handling on external calls

### Important (should fix)
- Missing or inadequate tests for new functionality
- Performance regressions (N+1 queries, unbounded loops, large allocations)
- Incorrect or missing type annotations on public APIs
- Race conditions or concurrency issues

### Suggestions (nice to have)
- Code clarity improvements, naming, deduplication, documentation

### Nits (optional)
- Style preferences not caught by linters, minor formatting

## Issue Triage Rules

1. **Bug reports**: Verify reproduction steps exist. Label `bug`. If missing info, add `needs-info` and comment asking for details.
2. **Feature requests**: Label `enhancement`. Check for duplicates.
3. **Questions**: Answer if possible, or label `question` and point to docs.
4. **Stale issues**: Issues with `needs-info` and no response for 14 days get a gentle reminder. 30 days → close with explanation.

## Labels

Ensure these labels exist on managed repos:
- `bug`, `enhancement`, `question`, `documentation`
- `good first issue`, `help wanted`
- `needs-info`, `needs-review`, `stale`
- `critical`, `breaking-change`
- Priority: `p0-critical`, `p1-high`, `p2-medium`, `p3-low`
