---
name: code-review
description: The shared rubric for reviewing a code change — precision-first, high-signal findings only (Critical/Important), plus what to check (correctness, contracts between producer and consumer, security, edge cases, regression risk, test coverage). Use when reviewing a PR or a branch diff.
version: 2.2.0
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

## Precision first — post only what matters

A review is only useful if people trust it. A noisy reviewer gets muted; every
low-value comment you post spends the credibility of the ones that matter. So
the bar is **high-signal only** — on what you **post**. Read "Where the gate
applies" below first: if your output is consumed by a later stage rather than by
a human, none of the filtering in this section is yours to do.

- **Post only Critical and Important findings.** Suggestions and Nits (below)
  are *not* worth a formal review comment on their own — drop them, or fold at
  most one genuinely valuable line into the summary. When in doubt about a
  finding's **tier**, leave it out of the review.
- **If you cannot name the concrete impact — what breaks, and for which input or
  caller — do not post it.** "This could be cleaner" is not a finding; "this
  crashes when `items` is empty because line 42 indexes `[0]`" is.
- **Confidence gate — refute, don't doubt, and only at the end.** Before you
  finalise, re-read each finding against the actual code and try to *refute your
  own claim*. Dropping it requires naming the specific thing that makes it
  wrong: the guard you missed, the caller that already validates, the type that
  makes the case unreachable. **Unease is not a refutation.** "I'm not certain"
  is an instruction to go and read the other side of the contract, not to delete
  the finding.

### Where the gate applies

The confidence gate filters what you **post**. It is not a filter on what you
are allowed to notice, to write down, or to hand to a later stage — and which of
those you are doing decides whether it fires at all.

- **You are producing the review** — writing `findings.json`, submitting a
  formal review, or recording a verdict on a branch diff. **The gate fires.**
  Everything in this section applies: yours is the last hand on the work before
  a human reads it, so an ungrounded finding costs real credibility.
- **You are one pass of a multi-pass review** — discharging obligations and
  appending hypotheses to a per-family file for a later phase to probe and
  adjudicate. **The gate does not fire.** Record the mechanism you cannot yet
  refute. Every downstream stage can only *remove*, so nothing there can recover
  a hypothesis you declined to write down, and a pass that self-censors is
  deleting evidence on behalf of a stage that has not run yet.

The split is measured, not stylistic. Google's AutoCommenter found a single
**global** confidence threshold (`t = 0.98`) catastrophic: roughly **80% of the
predictions it discarded as below-threshold were correct anyway**. Replacing it
with per-check thresholds raised recall without costing precision. So the gate
is worth having at the one point where a wrong finding is actually paid for, and
is expensive everywhere upstream of it.

### The gate cuts both ways

The confidence gate exists to stop *speculative* findings. It is not a reason to
approve a change you have not actually checked. Two failure modes, equally bad:

| Failure | What it looks like | Cost |
|---|---|---|
| **Noise** | posting a worry you can't ground in the code | the review gets muted |
| **Rubber-stamping** | an APPROVE with no findings on a change you only skimmed | the bug ships, and the approval is the thing that let it |

An **empty APPROVE is a positive claim**: "I checked this and found nothing."
Only make it when you did the work below — read each changed file in context and
checked the consumers of everything whose contract moved. A review that
approves every PR carries exactly as much information as no review at all.

Severity decides how hard you must work to refute, not how sure you must feel:

- **Critical-tier claims** (contract mismatch, data loss, security, breaking
  change) — go and *read the other side* before dropping it. The refutation has
  to come from the consumer's code, not from an assumption about it.
- **Important-tier claims** — one careful re-read against the diff is enough.
- **Below the bar** — drop it, as above.

## Finding tiers

Categorise every finding into exactly one tier. **Only Critical and Important
are posted** (see Precision first):

- **Critical** — security issues, data loss, breaking changes, silent
  data-dropping (see Correctness below). Blocks merge.
- **Important** — missing tests, performance problems, type errors, **avoidable
  duplication**, **excessive complexity**, **compiler-silencing assertions**.
  Should fix.
- **Suggestions** — clarity, naming, minor DRY tidy-ups. *Not posted* — noise
  in a formal review.
- **Nits** — style, formatting. *Not posted* — this is the linter's job.

Every posted finding carries a **one-line concrete impact**: the consequence
(what breaks / for whom) and, where it helps, the fix. That local reasoning is
what makes a comment actionable rather than a vague worry.

## What to check

- **Correctness** — does it do what it claims? Logic errors, off-by-one, wrong
  conditions, mishandled async. **A silent default or a dropped output for an
  input the code doesn't support is a correctness bug, not graceful handling** —
  flag any unsupported case that is silently defaulted, skipped, or omitted
  instead of warned-and-skipped or warned-and-surfaced.
- **Contracts — check the other side. Mandatory, not optional.** Whenever the
  diff changes what a unit *produces or accepts* — a return shape, a field name,
  an enum value, an event payload, a header, a status code, a units/format
  convention, a nullability, an ordering guarantee — **grep for the consumers
  and read them**, including consumers the diff does not touch. Then state the
  two sides explicitly to yourself: *producer now emits X; consumer at
  `path:line` still reads Y*. A mismatch is **Critical** and it is the single
  highest-value thing a reviewer catches, because it is invisible in the diff:
  each side looks correct alone. Do the same for a value that has to be enforced
  in more than one place (a limit, an expiry, a max-age, an auth check) — a
  constant defined client-side and never checked server-side is not enforced at
  all. If the change spans modules and you have *not* opened the other side, you
  have not finished the review.
- **Edge cases** — empty/null inputs, boundaries, error paths, concurrency.
- **Security** — injection, auth/authorization, secret handling, untrusted input.
- **Complexity** — flag functions past ~15 cyclomatic complexity or that mix
  parse/validate/emit responsibilities; ask for helper extraction. This is an
  **Important** finding, not a nit.
- **Duplication** — flag avoidable duplicated logic (two or more clone groups of
  the same code/branching). DRY is **should-fix** here, not merely "nice to have."
- **Type safety** — flag `as any`, unchecked `as`-casts, or `@ts-ignore` used to
  silence the compiler or to bypass a validator the same code path defines.
- **Regression risk** — existing callers of changed functions; behaviour changes
  that ripple.
- **Test coverage** — do the tests exercise the real risk, or just the happy
  path? **A test that asserts the buggy behaviour is not a fix — it is the bug,
  pinned.** If you raised a finding and the change adds a test that encodes the
  wrong answer as the expected one, the finding still stands and the test is a
  second, worse finding: it makes the bug look deliberate to the next reader.
  Say so explicitly, quoting the assertion.
- **Fit** — does it match the codebase's existing patterns and conventions?

## Calibration

- Don't nitpick generated files (lockfiles, compiled assets).
- Don't repeat what linters/CI already catch.
- Don't block over style preferences alone.
- Read the room, in **both** directions:
  - a human reviewer already **approved** → lower the bar for blocking; prefer a
    comment over requesting changes on non-critical findings;
  - a human reviewer has an **open `CHANGES_REQUESTED`** (not dismissed, not
    superseded by a later approval from the same person) → **raise** the bar for
    approving. Somebody with more context than you has said this is not ready.
    Never post an APPROVE over the top of it: a bot approval sitting above an
    open human block reads as a second opinion overruling the first. Post a
    COMMENT instead, and say which of their concerns the current diff does and
    does not address.
