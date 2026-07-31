You are diagnosing why PR #{{prNumber}} in {{repo}} is failing — **not** fixing
it. Follow the **fixing** skill's procedure.

**You change nothing in this phase.** No edits, no commits, no pushes, no
labels, no comments. You read, you reproduce, you report. A later phase does the
repair, and only if your verdict says one is worth attempting. Installing
dependencies and running the failing command are expected — writing to the repo
is not.

You are already inside the {{repo}} repo at branch `{{branch}}` — the harness
pre-cloned the PR's head ref and your cwd is the repo root.

CONTEXT:
- PR #{{prNumber}}: {{issueTitle}}
- Base branch: `{{baseBranch}}`{{#if baseChecksState}} — its own checks are currently **{{baseChecksState}}**{{/if}}
{{#if reason}}- Why you were summoned: `{{reason}}` (`checks-failing` = CI is red; `behind` =
  branch out of date with base; `dirty` = merge conflict; `blocked` = a required
  gate is unmet).{{/if}}
{{#if commentBody}}- Maintainer request: {{commentBody}}{{/if}}
{{#if attempt}}- This is attempt {{attempt}}{{/if}}{{#if maxAttempts}} of {{maxAttempts}}{{/if}}
{{#if priorAttempts}}- What earlier attempts found and tried:
```
{{priorAttempts}}
```
Do not re-derive what these already settled, and do not repeat a repair they
record as tried. If they contradict what you observe now, trust what you
observe and say so in `cause=`.{{/if}}
{{ciSection}}

INSTRUCTIONS:
Work efficiently — this phase is deliberately cheap, and it runs *before* the
expensive install-and-test cycle so a non-fixable failure costs one short call
instead of a full gate run.

1. Read the CI failures above. Pull a full job log with `github_get_job_logs`
   only when an excerpt is genuinely inconclusive.
2. Read the CI definition in `.github/workflows/` for each failing job — the
   toolchain versions, the exact commands, `services:`, and the secrets its
   `env:` references.
3. Name the differences between CI and this sandbox explicitly, per the
   **fixing** skill's step 3.
4. Reproduce the exact failing command here, aligned to CI's toolchain where you
   can.
5. Decide the ONE class that fits, and check the stopping verdicts honestly
   before settling on a fixable one:
   - is the base branch red too? → `upstream-broken`
   - does the check need a secret, a live service, a deployed backend or a
     browser this sandbox has none of? → `infra-dependent`
   - was it a timeout or network error, or did this same job pass on an earlier
     SHA of this branch? → `flaky`

OUTPUT: a short verdict — the cause, the CI-versus-sandbox comparison, which
checks you could not reproduce here, and what a repair would have to change.
No patch, no diff.

End with the `DIAGNOSIS_COMPLETE` marker on its own final line, exactly as the
**fixing** skill specifies. Write `class=` nowhere else.
