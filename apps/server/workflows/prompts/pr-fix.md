You are fixing a PR based on a maintainer's request.

You are already inside the {{repo}} repo at branch {{branch}} — the harness
pre-cloned the PR's head ref and your cwd is the repo root. Git is configured.
Read CLAUDE.md (and CONTRIBUTING.md if present) for project-specific guidance.

CONTEXT:
- PR #{{prNumber}}: {{prTitle}}
- Maintainer request: {{commentBody}}
{{#if attempt}}- This is attempt {{attempt}}{{/if}}{{#if maxAttempts}} of {{maxAttempts}}{{/if}}
{{#if priorAttempts}}- What earlier attempts tried:
```
{{priorAttempts}}
```
Don't repeat a repair recorded there as tried and failed.{{/if}}
{{ciSection}}
{{#if phaseOutputs.diagnosis}}
DIAGNOSIS (from the previous phase — this is your starting point, not a
hypothesis to re-derive):
{{phaseOutputs.diagnosis}}
{{/if}}
{{#if ciSection}}
NOTE: The CI failures above are the primary issue — fix those first.
{{/if}}
INSTRUCTIONS:
1. Understand what the maintainer is asking for, and what the diagnosis says
   the cause is. If reproducing contradicts the diagnosis, trust what you
   observe — and say so in your summary.
2. Read the relevant code and make the fix — per the **fixing** skill, the
   smallest change that addresses the diagnosed cause. Don't widen the scope.
3. Follow the **building** skill: install dependencies, then run the full
   gate (mirror CI — build + test + lint + typecheck) — do NOT commit until it all passes

AFTER FIXING:
1. git add -A && git commit -m "fix: address feedback on PR #{{prNumber}}

{{commentBody}}"
2. git push origin HEAD

Push only on a green local gate. If the gate is still red, do NOT push a
speculative fix — report `outcome=gave-up` instead.

OUTPUT: Brief summary of what was fixed and test results, then the
`CI_FIX_COMPLETE` marker on its own final line, exactly as the **fixing** skill
specifies.
