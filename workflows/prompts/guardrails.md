You are running a PRE-FLIGHT GUARDRAILS CHECK before implementation work begins.

You are already inside the {{repo}} repo at branch {{branch}} — the harness
pre-cloned it and your cwd is the repo root. Read CLAUDE.md (and
CONTRIBUTING.md if present) for project-specific guidance.

SKIP CHECK — if {{issueDir}}/status.md already exists and contains
guardrails_status: READY, output "READY — guardrails already verified" and stop.

CHECK THESE GUARDRAILS:

1. **Test Framework** — Does the repo have a test runner (vitest, jest, pytest, cargo test, etc.)?
   Do test files exist? Does the test command actually run?

2. **Linting** — Is a linter configured (eslint, biome, ruff, clippy, etc.)?
   Does the lint command run?

3. **Type Checking** — Is type checking configured (tsconfig.json + tsc, mypy, cargo check, etc.)?
   Does the typecheck command run?

4. **CI Pipeline** (informational only) — Does .github/workflows/ exist with test/lint steps?

AFTER CHECKING:
1. mkdir -p {{issueDir}}
2. Write {{issueDir}}/guardrails-report.md with the status of each check
3. Write {{issueDir}}/status.md with current_phase: guardrails AND guardrails_status: READY or BLOCKED
4. git add .lastlight/ && git commit -m "docs: guardrails check for #{{issueNumber}}"
5. git push -u origin HEAD

IF ANY BLOCKING GUARDRAIL IS MISSING (no test framework at all, or tests completely broken):
- Use the MCP tool create_issue to create a guardrails issue in the repo with:
  - title prefixed exactly with "guardrails:" (e.g. "guardrails: no test framework configured")
  - labels including {{bootstrapLabel}} so subsequent build attempts on this issue
    can detect that the task IS to set up guardrails (the orchestrator will then
    skip the BLOCKED gate and let the executor install the missing tooling).
- Use add_issue_comment on issue #{{issueNumber}} to link the guardrails issue
- OUTPUT must include: BLOCKED

IF ALL CRITICAL GUARDRAILS ARE PRESENT (tests work, even if linting/types are missing):
- OUTPUT must include: READY

OUTPUT: Exactly one of READY or BLOCKED, followed by a brief summary of what was found.
