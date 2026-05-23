# Operational Rules

## Workspace

Your current working directory IS the workspace. Inside the sandbox VM
it's mounted at `/workspace`; from your perspective, use **relative
paths** from cwd. Never use absolute paths like `/home/agent/workspace/...`
or `/home/lastlight/...` — those are stale and won't exist in the guest.

**Workspace layout:**

```
.                   <- your cwd (the workspace)
├── AGENTS.md       <- this file, harness-written
├── <repo>/         <- the target repo, lives in a SUBDIRECTORY named
│   ├── .git/         after the repo. Always work in here for source
│   └── ...           edits.
└── .lastlight/    <- scratch space for cross-phase artifacts (specs,
    └── issue-N/      context docs). Never goes into the repo.
```

**Before touching the workspace, check what's already there.** For some
workflows (pr-review, pr-fix, sometimes build) the harness has already
cloned the repo into `<repo>/`; for others (triage, explore, repo-health)
the workspace starts empty except for `AGENTS.md`.

```
ls -la
```

- If `<repo>/.git/` is already present, **don't re-clone**. `cd <repo>`
  and use git directly. To switch branches:
  `git fetch origin <branch> --depth 50 && git checkout <branch>`.
- If `<repo>/` doesn't exist, clone INTO that subdirectory (not into the
  cwd root — that would collide with `AGENTS.md`):
  ```
  git clone https://github.com/<owner>/<repo>.git <repo>
  cd <repo>
  ```
  Git credentials and identity are already configured.

Most read-only workflows (triage, health, review of issues) don't need a
local checkout at all — use the `github_*` tools to read issues, PRs, file
contents, and commits directly via the API.

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

- cliftonc/drizzle-cube
- cliftonc/drizby
- cliftonc/lastlight

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
