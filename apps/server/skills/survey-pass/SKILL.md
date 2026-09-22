---
name: survey-pass
description: The shared rules for ONE pass of a multi-pass PR review — the workspace layout, the finding tiers, what is not a finding, and the one rule that separates a survey pass from a reviewer (the precision gate does not fire on you; over-produce). Use when discharging obligations for one family and appending hypotheses for a later phase to probe and adjudicate. Not for producing a review.
version: 1.0.0
tags: [review, survey, multi-pass]
---

# Survey pass

You are **one pass of a multi-pass review**. You discharge one family's obligations and append hypotheses to that family's file. A later phase probes what you record and a stronger model adjudicates it; **both can only remove**.

This skill is what every family's pass shares. Your prompt carries the family's question and its obligations, and it wins wherever the two differ.

## Over-produce: you are upstream of the precision gate

Posting, `findings.json`, and deciding what is worth a maintainer's attention are **not yours** — a later phase owns all three. That is not a restriction on what you may notice; it is the reason to notice more.

| rule | why |
|---|---|
| **Record the mechanism you cannot yet refute** — with what you do and do not know | every downstream stage can only *remove*, so nothing there can recover a hypothesis you declined to write down, and a pass that self-censors is deleting evidence on behalf of a stage that has not run yet |
| **Apply no confidence bar.** Unease is not a refutation, and here it is not even a reason to hesitate | a precision gate is worth having at the one point where a wrong finding is paid for — posting. Upstream of it, it only loses evidence |

## Workspace

The harness pre-clones the PR's head ref and drops you **inside the checkout** — your cwd **is** the repo (`ls -la` shows `.git/` directly). Use `git` / `read` / `grep` from here.

| rule | why |
|---|---|
| **Every `.lastlight/…` path in your prompt is relative to that cwd — use it relative, never absolute** | the skill files you were handed are absolute paths under `…/.lastlight-skills/`, a **sibling of the checkout, one level above you**; joining a `.lastlight/…` path onto that directory lands outside the repo and reads nothing — it cost 23 of 120 survey branches their seeded obligations |
| **Read code from this local checkout, never the API** — not `github_get_pull_request_diff`, `github_list_pull_request_files` or `github_get_file_contents` | the API patch is a large redundant payload that re-bloats context every turn |
| **Do not re-derive the range with `git diff`** | a **staged diff** is already on disk under `.lastlight/pr-review/diff/` — an index plus one patch per changed file, in head coordinates |

The patch is your **starting point, not your scope**: you are in the full checkout, and the highest-value findings live in the files the diff never opened.

## Finding tiers

Categorise every hypothesis into exactly one tier. You post nothing, so this is vocabulary for the adjudicator, not a filter on you:

| tier | what belongs |
|---|---|
| **Critical** | data loss, breaking changes, silent data-dropping, or a security issue that crosses a trust boundary (see below). Blocks merge. |
| **Important** | missing tests, performance problems, type errors, avoidable duplication, excessive complexity, compiler-silencing assertions. Should fix. |
| **Minor** | everything below that bar, including a clean discharge. Record it; the tier is what stops it competing for attention. |

**Critical needs a trust boundary, not a category.** "This input is attacker controlled" is not enough on its own — name the boundary the input crosses and a capability the supplier does not already have. A local CLI parsing a file the user themselves wrote is codegen robustness, not a security boundary: the supplier of the input already holds every capability the finding would grant. Severity feeds the adjudicator's ranking and therefore what occupies a maintainer's top slots, so an inflated one spends attention that a real Critical needed.

## Not findings

The list your prompt gives you is what *counts*. This is what does **not**, however real it may be. It is a **category** rule, not a confidence bar: "I am not certain this is enforced" is not on it, and nothing here narrows the instruction to over-produce. The only thing it removes is noise you were never supposed to produce, never a mechanism you could not refute.

| not a finding | unless |
|---|---|
| **Pre-existing issues.** The change is adjacent to them; it did not cause them — a defect that was already there and still is | **this PR is what makes them wrong.** A consumer the diff never opened, now reading a shape the diff moved, IS a finding and is the highest-value one there is |
| **Anything a linter, typechecker or compiler would catch.** They already run, and they are right more often than you are | the assertion *silences* one — `as any`, `@ts-ignore` — which is by definition something the compiler does not catch |
| **Changes that are clearly intentional and part of the broader change.** If the diff is doing X on purpose, "this does X" is a restatement | |
| **Points already deliberately silenced in the code** — an explicit suppression, an ignore directive, a comment saying why. Someone already decided | |
| **Conventions the reviewed repository does not actually follow.** **The repository's conventions govern — not yours, and not the ones it aspires to.** If the merged code does not follow a convention, that convention is aspirational and departing from it is not a finding. Read the neighbours of the file you are reviewing; they are the standard, not the style guide | |
| **A repeated literal the merged code already repeats.** If the copies agree, sharing the constant is a suggestion | this change DOES let them disagree **in behaviour** — but then say what diverges and for whom |
| **"X is never validated" with no consumer that misbehaves.** Validation nobody's misbehaviour depends on is a design note | some input or caller reaches code that then does the wrong thing — name that path |
| **Description staleness.** A PR description that under- or over-describes the change | a doc line, comment or example asserts something checkable about the code's behaviour which is **false at head** — the next reader will act on it. The test: does the sentence make a claim the code can falsify? |
| **Generated files** (lockfiles, compiled assets), and anything linters and CI already catch | |

## State the residual risk, not the reassurance

A discharge that concludes "correctly handled", "properly ordered" or "enforced" is a **claim, not a measurement** — and its direction is the one thing no downstream stage can flip. A probe and an adjudicator can remove a risk you wrote down; they will never see one you graded away as fine.

So before you write "correct", name the bar you graded against. Two invariants can both be true of the same quoted line, and your family's question is always the **strongest** bar it cares about, never the weakest true statement. If you cannot name the bar, record the mechanism with no verdict and let the probe settle it.

**In a changed hunk: record the risk, not the reassurance.** Put the falsifiable risk in `claim` and set `needsProbe: true`.

| don't write | write |
|---|---|
| `the page cap is properly enforced` | `when the cap fires, the caller gets a truncated result and no signal that it was truncated` |
| `the client is configured with retry and rate-limit handling` | `a rate-limited call is dropped rather than retried` |

`needsProbe` is the only field that routes a record to the one stage that can execute against it. Set it whenever your record asserts a behavioural property a four-line probe could contradict — in EITHER direction. Today only suspicions ask for probes and reassurances never do, which is backwards: the reassurance is the direction nothing downstream can flip.
