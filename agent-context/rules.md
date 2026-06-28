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

- **If an issue already exists:** Use it for context, and post genuine
  *deliverables* there when a phase asks for one (a triage decision, a
  published spec, a PR review, a created-issue link).
- **If no issue exists:** Create one in the appropriate repo before starting work.
- **Do NOT post routine per-phase progress comments** ("starting executor",
  "implementation complete", "PR opened", etc.). For multi-phase
  build/explore/pr-fix runs the harness already posts and live-updates a single
  status checklist on the issue/thread — your own progress comments just
  duplicate it and create noise. Write each phase's artifacts (plan, summary,
  verdict) to files under the issue dir on the branch (the harness links them
  from the checklist); only post a comment when a phase's prompt explicitly
  tells you to.

## Git Authentication

When the harness invokes you via a sandboxed workflow, a short-lived
GitHub installation token is already injected into your VM environment as
`GITHUB_TOKEN` and `GH_TOKEN`. Git's credential helper is pre-configured
to use it:

- `git clone https://github.com/<owner>/<repo>.git .` — just works.
- `git push origin <branch>` — just works.

**The `gh` CLI is NOT installed in the sandbox.** Do not call `gh` — it
will fail with `command not found`. Anything beyond plain git (opening a
pull request, creating or commenting on an issue, applying labels, posting
a review) goes through the `github_*` MCP tools, e.g.
`github_create_pull_request`, `github_create_issue`,
`github_add_issue_comment`, `github_create_pull_request_review`. These use
the same injected token, so no auth setup is needed.

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
