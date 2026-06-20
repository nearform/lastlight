---
name: code-review
description: The shared rubric for reviewing a code change — finding tiers (Critical/Important/Suggestions/Nits) and what to check (correctness, security, edge cases, regression risk, test coverage). Use when reviewing a PR or a branch diff.
version: 1.0.0
tags: [review, code-quality]
---

# Code Review

The shared rubric for assessing a code change. Used both by a PR review and by
the build cycle's branch-diff reviewer — the *procedure* differs (where the diff
comes from, how the verdict is recorded), but the rubric below is the same.

Review the change **in full context** — read each changed file, not just the
hunk. For a large change (>300 lines or >5 files): trace data flow through
modified functions, check callers of anything whose signature or behaviour
changed for regression risk, and check that tests cover the actual risk areas,
not just the happy path.

## Finding tiers

Categorise every finding into exactly one tier:

- **Critical** — security issues, data loss, breaking changes. Blocks merge.
- **Important** — missing tests, performance problems, type errors. Should fix.
- **Suggestions** — clarity, naming, DRY opportunities. Nice to have.
- **Nits** — style, formatting. Optional.

## What to check

- **Correctness** — does it do what it claims? Logic errors, off-by-one, wrong
  conditions, mishandled async.
- **Edge cases** — empty/null inputs, boundaries, error paths, concurrency.
- **Security** — injection, auth/authorization, secret handling, untrusted input.
- **Regression risk** — existing callers of changed functions; behaviour changes
  that ripple.
- **Test coverage** — do the tests exercise the real risk, or just the happy path?
- **Fit** — does it match the codebase's existing patterns and conventions?

## Calibration

- Don't nitpick generated files (lockfiles, compiled assets).
- Don't repeat what linters/CI already catch.
- Don't block over style preferences alone.
- Read the room: if a human reviewer already approved, lower the bar for blocking
  — prefer a comment over requesting changes on non-critical findings.
