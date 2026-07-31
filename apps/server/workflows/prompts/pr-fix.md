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
2. Write the gate script FIRST: `.lastlight-verify.sh` in the repo root, holding
   the exact build + test + lint + typecheck commands CI runs, with the package
   manager taken from the lockfile. Exit 0 means green. It is not there yet —
   the harness clears it at the start of every attempt (see the **fixing**
   skill).
3. Read the relevant code and make the fix — per the **fixing** skill, the
   smallest change that addresses the diagnosed cause. Don't widen the scope.
4. Follow the **building** skill: install dependencies, then run the full
   gate (mirror CI — build + test + lint + typecheck) — do NOT commit until it all passes

AFTER FIXING:
1. git add -A && git commit -m "fix: address feedback on PR #{{prNumber}}

{{commentBody}}"
2. git push origin HEAD

PUSH DISCIPLINE — the gate decides, and it is checked after you finish:
{{#if iteration}}- This is local iteration {{iteration}} of {{maxIterations}}. When `.lastlight-verify.sh`
  exits non-zero you get another iteration to keep working; when it exits 0 the
  phase ends.{{/if}}
- Push **only** on a green local gate. A gate that did not run is `gate=skipped`,
  and `skipped` counts as RED — it never authorises a push.
- On the LAST iteration with the gate still red: emit `outcome=gave-up`,
  `gate=red`, and do **not** push a speculative fix. An unverified push costs a
  full CI cycle to prove nothing; dispatch-time escalation owns what happens
  next, not you.

OUTPUT: Brief summary of what was fixed and test results, then the
`CI_FIX_COMPLETE` marker on its own final line, exactly as the **fixing** skill
specifies.
