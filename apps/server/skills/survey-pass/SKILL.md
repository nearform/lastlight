---
name: survey-pass
description: The shared rules for ONE pass of a multi-pass PR review — the workspace layout, the finding tiers, what is not a finding, and the one rule that separates a survey pass from a reviewer (the precision gate does not fire on you; over-produce). Use when discharging obligations for one family and appending hypotheses for a later phase to probe and adjudicate. Not for producing a review.
version: 1.0.0
tags: [review, survey, multi-pass]
---

# Survey pass

You are **one pass of a multi-pass review**. You discharge one family's
obligations and append hypotheses to that family's file. A later phase probes
what you record and a stronger model adjudicates it; **both can only remove**.

This skill is what every family's pass shares. Your prompt carries the family's
question and its obligations, and it wins wherever the two differ.

## What you are not

You are not producing the review, and three whole procedures therefore do not
apply to you: posting, `findings.json`, and deciding what is worth a maintainer's
attention. A later phase owns all three.

That is not a restriction on what you may notice. It is the reason you should
notice more.

## The precision gate does not fire on you

The `code-review` rubric a reviewer follows is precision-first: *"if you cannot
name the concrete impact, do not post it"*, and a confidence gate before
finalising. **None of that is yours to do.** Yours is not the last hand on the
work — every downstream stage can only *remove*, so nothing there can recover a
hypothesis you declined to write down, and a pass that self-censors is deleting
evidence on behalf of a stage that has not run yet.

**Record the mechanism you cannot yet refute.** Unease is not a refutation, and
here it is not even a reason to hesitate: write it down with what you do and do
not know.

The split is measured, not stylistic. Google's AutoCommenter found a single
**global** confidence threshold (`t = 0.98`) catastrophic — roughly **80% of the
predictions it discarded as below-threshold were correct anyway**. Replacing it
with per-check thresholds raised recall without costing precision. The gate is
worth having at the one point where a wrong finding is actually paid for, and is
expensive everywhere upstream of it. You are upstream of it.

## Workspace

The harness pre-clones the PR's head ref and drops you **inside the checkout** —
your cwd **is** the repo (`ls -la` shows `.git/` directly). Use `git` / `read` /
`grep` from here.

**Every `.lastlight/…` path in your prompt is relative to that cwd — use it
relative, never absolute.** The skill files you were handed are absolute paths
under `…/.lastlight-skills/`, and that directory is a **sibling of the checkout,
one level above you**. Joining a `.lastlight/…` path onto the directory your
skills came from lands outside the repo and reads nothing. Measured, not
hypothetical: it cost 23 of 120 survey branches their seeded obligations across
three runs.

**Read code from this local checkout, never the API.** Do not call
`github_get_pull_request_diff`, `github_list_pull_request_files` or
`github_get_file_contents` — the API patch is a large redundant payload that
re-bloats context every turn.

A **staged diff** is already on disk under `.lastlight/pr-review/diff/` — an
index plus one patch per changed file, in head coordinates. Do not re-derive the
range with `git diff`; it is written down. But the patch is your **starting
point, not your scope**: you are in the full checkout, and the highest-value
findings live in the files the diff never opened.

## Finding tiers

Categorise every hypothesis into exactly one tier. You post nothing, so this is
vocabulary for the adjudicator, not a filter on you:

- **Critical** — data loss, breaking changes, silent data-dropping, or a security
  issue that crosses a trust boundary (see below). Blocks merge.
- **Important** — missing tests, performance problems, type errors, avoidable
  duplication, excessive complexity, compiler-silencing assertions. Should fix.
- **Minor** — everything below that bar, including a clean discharge. Record it;
  the tier is what stops it competing for attention.

**Critical needs a trust boundary, not a category.** "This input is attacker
controlled" is not enough on its own — name the boundary the input crosses and a
capability the supplier does not already have. A local CLI parsing a file the
user themselves wrote is codegen robustness, not a security boundary: the
supplier of the input already holds every capability the finding would grant.
Severity feeds the adjudicator's ranking and therefore what occupies a
maintainer's top slots, so an inflated one spends attention that a real Critical
needed.

## Not findings

The list your prompt gives you is what *counts*. This is what does **not**,
however real it may be. It is a **category** rule, not a confidence bar: "I am
not certain this is enforced" is not on it, and nothing here narrows the
instruction to over-produce. The only thing it removes is noise you were never
supposed to produce, never a mechanism you could not refute.

- **Pre-existing issues.** The change is adjacent to them; it did not cause them.
- **Anything a linter, typechecker or compiler would catch.** They already run,
  and they are right more often than you are. The exception is an assertion that
  *silences* one — `as any`, `@ts-ignore` — which is by definition something the
  compiler does not catch.
- **Real issues on lines this PR did not touch — unless this PR is what makes
  them wrong.** A consumer the diff never opened, now reading a shape the diff
  moved, IS a finding and is the highest-value one there is. What is excluded is
  a defect that was already there and still is.
- **Changes that are clearly intentional and part of the broader change.** If the
  diff is doing X on purpose, "this does X" is a restatement, not a finding.
- **Points already deliberately silenced in the code** — an explicit suppression,
  an ignore directive, a comment saying why. Someone already decided.
- **Conventions the reviewed repository does not actually follow.** **The
  repository's conventions govern — not yours, and not the ones it aspires to.**
  If the merged code does not follow a convention, that convention is aspirational
  and departing from it is not a finding. Read the neighbours of the file you are
  reviewing; they are the standard, not the style guide.
- **A repeated literal the merged code already repeats.** If the copies agree and
  this change does not make them observably diverge, sharing the constant is a
  suggestion, not a finding. The moment this change DOES let them disagree in
  behaviour it becomes real — but then say what diverges and for whom.
- **"X is never validated" with no consumer that misbehaves.** A missing check is
  a finding when some input or caller reaches code that then does the wrong
  thing — name that path. Validation nobody's misbehaviour depends on is a design
  note.
- **Description staleness — though a doc's claims are checkable.** A PR
  description that under- or over-describes the change is not a finding. But a
  doc line, comment or example asserting something checkable about the code's
  behaviour which is **false at head** IS one — the next reader will act on it.
  The test: does the sentence make a claim the code can falsify?

Two more, which are about cost rather than category:

- Don't nitpick generated files (lockfiles, compiled assets).
- Don't repeat what linters and CI already catch.

## State the residual risk, not the reassurance

A discharge that concludes "correctly handled", "properly ordered" or "enforced"
is a **claim, not a measurement** — and its direction is the one thing no
downstream stage can flip. A probe and an adjudicator can remove a risk you wrote
down; they will never see one you graded away as fine.

So before you write "correct", name the bar you graded against. Two invariants
can both be true of the same quoted line, and your family's question is always
the **strongest** bar it cares about, never the weakest true statement. If you
cannot name the bar, record the mechanism with no verdict and let the probe
settle it.
