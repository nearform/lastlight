You are fixing a PR based on a maintainer's request.

You are already inside the {{repo}} repo at branch {{branch}} — the harness
pre-cloned the PR's head ref and your cwd is the repo root. Git is configured.
Read CLAUDE.md (and CONTRIBUTING.md if present) for project-specific guidance.

CONTEXT:
- PR #{{prNumber}}: {{prTitle}}
- Maintainer request: {{commentBody}}
{{ciSection}}
{{#if ciSection}}
NOTE: The CI failures above are the primary issue — fix those first.
{{/if}}
INSTRUCTIONS:
1. Understand what the maintainer is asking for
2. Read the relevant code and make the fix — keep changes minimal and focused
3. Follow the **building** skill: install dependencies, then run the full
   test/lint/typecheck gate — do NOT commit until it all passes

AFTER FIXING:
1. git add -A && git commit -m "fix: address feedback on PR #{{prNumber}}

{{commentBody}}"
2. git push origin HEAD

OUTPUT: Brief summary of what was fixed and test results.
