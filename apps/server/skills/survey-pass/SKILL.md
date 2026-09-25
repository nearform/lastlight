---
name: survey-pass
description: The mechanics every pass of a multi-pass PR review shares — where the workspace is, how to grade severity, what is not a finding, and how to write the output file. The pass's own question comes from its prompt. Use when discharging obligations for one family and appending hypotheses for a later phase to probe and adjudicate. Not for producing a review.
version: 2.0.0
tags: [review, survey, multi-pass]
---

# Survey pass — the mechanics

Your prompt carries the question you own and the reason it is shaped that way. This is everything else: where things are, how to grade, and what to write. Where the two differ, the prompt wins.

## Workspace

You are **inside the checkout** — your cwd is the repo (`ls -la` shows `.git/`). Read code from here, never through the GitHub API: the API patch is a large redundant payload that re-bloats your context every turn.

- **A staged diff is already on disk** at `.lastlight/pr-review/diff/` — an index plus one patch per changed file, in head coordinates. Do not re-derive it with `git diff`. (If the index says NOT AVAILABLE, use `git diff origin/<base>...HEAD` — **three dots**; two dots claims commits the author never wrote.)
- **Every `.lastlight/…` path is relative to cwd. Use it relative, never absolute.** The skill files you were handed live in a sibling directory one level up; joining a `.lastlight/…` path onto that reads nothing, silently.

<!-- MEASURED, and the reason the rule is stated this bluntly: across three
     stored runs, 98 of 98 relative first-turn reads from a survey branch
     resolved and 0 of 27 workspace-root-absolute ones did — the only absolute
     path a branch holds is its skill bundle, one directory ABOVE the checkout.
     An earlier version of this cost 23 of 120 branches their seeded
     obligations, each of which then reported its family clean. -->
- **Do not install dependencies or run the test suite, the linter or the type-checker.** CI's result is in your context — cite it. Where only running the code could settle a field of the evidence record, record it `unknown`; the falsify phase runs what can be run.
- **The patch is your starting point, not your scope.** You have the whole checkout: open changed files in full, grep for the callers the patch never shows you, and follow a changed symbol into files this PR did not touch. The defects worth finding usually live there.

## The evidence record — you supply facts, the verdict is computed

Two fields decide what happens to your row: whether a probe runs against it
(`needsProbe`), and where it ranks among everything the review found
(`severity`). **You do not judge either one.** Both are derived from the
evidence below, by code, so that identical evidence always produces an
identical verdict.

So the work is to establish the facts honestly. Put them in the row's
`evidence` object, under exactly these names:

| field | type | what it means |
|---|---|---|
| `subject` | string | the symbol, path, behaviour or criterion this row is about |
| `control_site` | `"path:line"` \| `"none"` | the line that **closes** the mechanism — your prompt says what closing means for your family. `none` if no line does. |
| `control_text` | string | that line, verbatim from the file |
| `authority` | `"binding"` \| `"advisory"` \| `"unknown"` | `binding` = it sits where it still holds if the other side is hostile, buggy or simply older. `advisory` = the side the other party controls, or a check nothing consults. |
| `order_ok` | `true` \| `false` \| `unknown` | does the control run **before** the thing it governs? |
| `cannot_distinguish` | string | two DIFFERENT situations the control treats identically — or exactly `"nothing"` |
| `bypass` | string | one concrete path that reaches the governed operation without the control — or `"none found"` |
| `in_changed_hunk` | `true` \| `false` | does this PR touch the subject, the control, or a site using either? |
| `consequence` | string \| `null` | what goes wrong, and what it does then. `null` when nothing is wrong. |
| `trigger` | `"input"` \| `"state"` \| `"code_change"` \| `"unknown"` | what makes `consequence` happen. `input`/`state` = reachable **at head**. `code_change` = only once somebody edits the source. |
| `crosses_boundary` | `true` \| `false` | does `consequence` cross a trust boundary, lose or silently drop data, or break an existing caller? |
| `capability_gained` | string \| `null` | something the supplier does **not** already hold without this defect |

What keeps these honest:

- **`control_text` must be copyable from the file.** If you cannot quote it,
  `control_site` is `none`. A line that MENTIONS the subject, or passes it
  onward, closes nothing.
- **`cannot_distinguish: "nothing"` is a strong claim.** It says you checked
  the empty case, the boundary case and the absent case and the control
  separates all of them.
- **`bypass: "none found"` means you SEARCHED.** It is not the default.
- **`capability_gained` is `null`** whenever the supplier could already cause
  the same outcome by legitimate means.
- **If your `consequence` begins "if X is changed…", the `trigger` is
  `code_change`.** Nothing is wrong at head, and the only person who can
  trigger it is someone who can already edit the repository.
- **There is no `"N/A"`, `"none"` or `"-"`.** Every field takes a value from
  its type; a question that does not apply still has an answer — `"nothing"`,
  `"none found"`, `null` or `unknown`, as the type says.
- **`unknown` is a real answer and a safe one.** Never round it to a clean
  value to make a row look finished.

**You do not write `severity` or `needsProbe`.** They are not on your row. Both are computed from the record above, downstream, so that identical evidence always produces an identical verdict.

That is worth knowing because of what it means for two fields in particular:

- **`consequence: null` is how a clean discharge is recorded.** It is not a hedge — it is the fact that nothing goes wrong, and it is what makes the row rank below anything that does.
- **`in_changed_hunk` decides whether a clean discharge gets verified.** A control you found sound, over code this PR touched, is a *reassurance* — and a reassurance is the one kind of row nothing downstream can reopen. A later phase can delete a risk you recorded; it can never resurrect one you graded away. Marking the hunk honestly is what sends it for verification.

<!-- Both fields used to be judgements, and both measured unstable: identical
     inputs produced different rankings run to run, and clean discharges over
     changed code declined the one verification that could contradict them.
     Asking for a judgement makes the answer depend on the adjectives a prompt
     happens to use, which is why rewording moved the numbers in both
     directions without ever settling them. The rules now live in
     `packages/code-facts/src/survey-verdict.ts`, with the measurements that
     shaped each one. -->

## Not findings

What your prompt asks for is what counts. This is what does not, however true:

| not a finding | unless |
|---|---|
| **Pre-existing issues** the change is merely adjacent to | **this PR is what makes them wrong** — a consumer the diff never opened, now reading a shape the diff moved, is the highest-value finding there is |
| **Anything a linter, typechecker or compiler catches.** They run, and they are right more often than you are | the code *silences* one (`as any`, `@ts-ignore`) — by definition something they no longer catch |
| **Restatements of the intended change.** If the diff does X on purpose, "this does X" is a description, not a finding | |
| **Points already deliberately silenced** — a suppression, an ignore directive, a comment saying why. Someone decided already | |
| **Conventions the repository does not actually follow.** Its neighbours are the standard, not its style guide or yours | |
| **A repeated literal the merged code already repeats** | this change lets the copies diverge **in behaviour** — then say what diverges, and for whom |
| **"X is never validated" with no consumer that misbehaves** | some caller reaches code that then does the wrong thing — name that path |
| **Stale prose.** A description that under- or over-describes the change | a doc line, comment or example makes a checkable claim that is **false at head** and the next reader will act on it |
| **Generated files** — lockfiles, compiled assets | |

This is a **category** rule, never a confidence bar. "I am not certain" is not on the list.

## Output

Append one JSON object per line to your family's file under `.lastlight/pr-review/hypotheses/`, in the shape your obligations block prescribes. Read and write no other family's file — the passes are kept apart so they cannot collapse onto one opinion.

Create the file even with nothing to record, so *surveyed and found nothing* and *never ran* stay distinguishable. But a placeholder row carries **no analysis**: the moment it quotes lines and grades them, it is a hypothesis with a verdict and must be written as one, bar named — not folded into a no-findings line where no probe and no adjudicator will ever look.

**An unseeded block is not an empty task.** If your attachment says NOT MEASURED, NOT AVAILABLE, or that no obligations could be built, record that as your FIRST row — then work the diff for your family's question yourself and write what you find. A file holding only that row is a pass that stopped at the door; the gate fails it. (The one exception is a family whose own prompt says NOT MEASURED *is* its answer — `tests`, which can observe nothing without a coverage report.)

Do not write `findings.json` and do not post a review. Neither is yours.

<!-- The cross-family rule is "by construction, not by instruction": six passes
     appending to six disjoint files cannot collapse onto one shared opinion
     even if every one of them wants to. Reading another family's file is what
     would reintroduce that, which is why the ban is on the READ as well as the
     write.

     And on the seeded block: "we could not look" and "we looked and it is
     clean" are different facts at every layer (locked decision 6). A pass that
     was handed NOT MEASURED, or nothing at all, records that FIRST — and then
     works the diff unseeded, because the seed is a head start, not the scope.
     (This comment once ended at "does not substitute a judgement for a
     measurement", and on 2026-09-24 Haiku read that as "stop": 2 of 3 repeats
     of an unseeded branch wrote the one placeholder row and nothing else, on
     a fixture whose gold other models found unseeded.) The block is delivered INTO
     the prompt rather than left on disk because any path a pass constructs for
     it is a guess about a harness layout that varies by backend. -->
