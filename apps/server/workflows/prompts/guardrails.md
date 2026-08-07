You are running a PRE-FLIGHT GUARDRAILS CHECK before implementation work begins.

You are already inside the {{repo}} repo at branch {{branch}} — the harness
pre-cloned it and your cwd is the repo root. Read CLAUDE.md (and
CONTRIBUTING.md if present) for project-specific guidance.

THE ISSUE THIS BUILD WILL IMPLEMENT (use it to judge the escape hatch below):
{{contextSnapshot}}

SKIP CHECK — if {{issueDir}}/status.md already exists and contains
guardrails_status: READY, output "READY — guardrails already verified" and stop.

INSTALL DEPENDENCIES FIRST (do this before running ANY check command):
The harness pre-clones the repo but does NOT install dependencies, so the
test/lint/typecheck binaries (vitest, oxlint, tsc, eslint, ruff, …) will not
resolve until you install them. Detect the ecosystem and run the install:
- Node — pick the package manager from the lockfile: `pnpm-lock.yaml` → `pnpm install`,
  `yarn.lock` → `yarn install`, `package-lock.json` (or none) → `npm ci`
  (fall back to `npm install` if `npm ci` fails for a lockfile mismatch).
- Python — `pip install -e .` / `pip install -r requirements.txt`, or `poetry install` / `uv sync`.
- Rust — cargo fetches on first build; no separate step.
Only AFTER a successful install should you judge whether a command "runs". A
binary that is missing *after* dependencies installed cleanly is a real gap; a
binary missing *because deps were never installed* is NOT — do not BLOCK on it.
If the install itself fails (bad lockfile, missing manifest), that IS a blocking
guardrail — report it as such.

CHECK THESE GUARDRAILS:

The rule for each check below: **if it is present, it MUST pass; if it is not
present, that's fine.** A configured command that FAILS is a blocker. A command
that simply doesn't exist is NOT a blocker.

1. **Test Framework** — Does the repo have a test runner (vitest, jest, pytest,
   cargo test, etc.)? Do test files exist? Does the test command run AND pass?
   (Tests are the primary signal — a repo with no test framework at all is the
   one absent-tooling case that still blocks, since there's nothing to verify
   the build against.)

2. **Linting** — Is a linter configured (eslint, biome, ruff, clippy, etc.)?
   If configured, the lint command MUST pass → a failing lint BLOCKS. If no
   linter is configured at all, that's fine — note it and do NOT block.

3. **Type Checking** — Is type checking configured (tsconfig.json + tsc, mypy,
   cargo check, etc.)? If configured, the typecheck command MUST pass → a
   failing typecheck BLOCKS. If not configured at all, that's fine — note it
   and do NOT block.

4. **CI Pipeline** (informational only) — Does .github/workflows/ exist with test/lint steps?

AFTER CHECKING:
1. mkdir -p {{issueDir}}
2. Write {{issueDir}}/guardrails-report.md with the status of each check
3. Write {{issueDir}}/status.md with current_phase: guardrails AND guardrails_status: READY or BLOCKED
{{#if !externalizeArtifacts}}4. `github_publish` with `{ owner: "{{owner}}", repo: "{{repo}}", message: "docs: guardrails check for #{{issueNumber}}" }` — it commits the working tree as one signed commit, creating the branch on GitHub if it isn't there yet.{{/if}}{{#if externalizeArtifacts}}4. Do NOT git add or commit {{issueDir}}/ — the harness persists it to the Last Light server automatically.{{/if}}

ESCAPE HATCH — bootstrap tasks (CHECK THIS FIRST):
If THE ISSUE ABOVE is itself asking to ADD the tooling you're checking for —
set up tests / a test harness, linting, type-checking, CI, an AGENTS.md, etc. —
then missing tooling is the expected STARTING state, not a blocker. The whole
point of the build is to create it. In that case:
- Do NOT output BLOCKED, and do NOT create a separate guardrails issue.
- In guardrails-report.md, mark this a BOOTSTRAP build: list what's missing and
  state that the executor must ESTABLISH this tooling as the task — there are no
  existing test/lint/typecheck commands to rely on yet.
- Write guardrails_status: READY and OUTPUT: READY so the build proceeds to the
  architect.
This applies even when there is no `lastlight:bootstrap` label and the title has
no `guardrails:` prefix — judge it from the issue's intent.

Otherwise (the issue is normal feature/bug work, not about adding tooling):

Apply the present-must-pass rule. BLOCK if ANY of these hold:
- there is no test framework at all, or the test command is broken / fails;
- a linter IS configured but the lint command fails;
- type checking IS configured but the typecheck command fails;
- the dependency install itself failed.

A check that is simply ABSENT (no linter configured, no typecheck configured) is
NOT a blocker — note it in the report and proceed. Do not create a guardrails
issue merely because lint or typecheck tooling is missing.

IF A BLOCKING CONDITION ABOVE HOLDS:
- Use the MCP tool github_create_issue to create a guardrails issue in the repo with:
  - title prefixed exactly with "guardrails:" (e.g. "guardrails: no test framework configured")
  - labels including {{bootstrapLabel}} so subsequent build attempts on this issue
    can detect that the task IS to set up guardrails (the orchestrator will then
    skip the BLOCKED gate and let the executor install the missing tooling).
- Use github_add_issue_comment on issue #{{issueNumber}} to link the guardrails issue
- OUTPUT must include: BLOCKED

OTHERWISE — every check that EXISTS passes (absent lint/typecheck is fine):
- OUTPUT must include: READY

OUTPUT: Exactly one of READY or BLOCKED, followed by a brief summary of what was found.
