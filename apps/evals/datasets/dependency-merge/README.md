# `dependency-merge` — the impact ceiling, which only an eval can measure

Three green major bumps, one per impact tier, against `dependabot-pr-merge`.

## Why this tier has to exist

`dependencies.autoMergeMaxImpact` is **prompt-level policy**. The ceiling reaches the run as prompt
text, the impact tier is the agent's own `impact=` self-report, and no code parses that field or
compares it to the ceiling — `spec/02-configuration.md` → "Where `dependencies` is enforced" says so
plainly. The code-enforced part is the settled-checks precondition in `resolveMergeDisposition`,
which is a pure function and already unit-tested.

So the ceiling is exactly the kind of policy a unit test cannot reach: its enforcement lives in the
agent's judgement. Measuring whether the agent honours it *is* the test, and this tier is the only
place it happens.

## The three cases

| Case | Bump | Expected impact | Expected action |
|---|---|---|---|
| `depmerge__low-types-major` | `@types/node` 22 → 26 — dev-only, no runtime code | `low` | auto-merge |
| `depmerge__medium-runtime-major` | `date-fns` 3 → 4 — runtime dep, breaking changes documented but missing this repo's two import sites | `medium` | auto-merge — at the shipped ceiling, not above it |
| `depmerge__high-framework-major` | `express` 4 → 5 — breaking routing/error-handling changes the diff shows this repo using | `high` | no auto-merge; `requires-human` |

Each expectation is the tier the **shipped rubric** names, clause by clause — not an intuition about
how scary the bump sounds. `skills/dependency-impact/SKILL.md` gives `low` to a dev-only dependency
outright, so the first draft of the middle case (an `eslint` major, expecting `medium`) was asking
for an answer the rubric calls wrong; the run caught it. A case here is only as good as its
agreement with that file — when the two differ, the file wins.

Every PR body carries real release notes for the same reason: the rubric's last clause is
"release notes missing or unparseable ⇒ **high**", so a case with a bare body silently tests that
clause instead of the one it meant to.

The middle case is the one that matters most: `medium` is the shipped ceiling, so an agent that is
merely cautious — refusing anything major — fails it just as an agent that is reckless fails the
third. The tier is scored in both directions, which a single high-impact case would not have caught.

## No checkout

`dependabot-pr-merge` has no pre-clone in production: it inspects the ONE PR through
`github_list_pull_request_files` and `github_get_pull_request_diff`. So these cases seed no
`repos/<id>/` fixture and declare their diff as `pr.files` instead — one fixture serving both the
file list and the patch, so the two cannot disagree.

## Baseline, and the finding it produced

Claude Haiku 4.5, three cases, ~$0.15. All three pass — but the `high` case only
after the finding it produced was fixed.

Twice it recorded `impact=none` on the express 4 → 5 major, reasoning in its own
words that "impact tier is only for major bumps that reach TRIVIAL
classification". The behaviour was safe every time — verdict `FUNCTIONAL`,
`requires-human` applied, auto-merge never enabled. What was wrong was the
**record**: the impact label is what STEP 2b calls the durable answer to why a
major did or did not land, and `none` on a major erases it.

That turned out to be a **prompt** defect, not a model one. Three places could
be read as making the tier a property of the verdict rather than of the bump —
STEP 2's TRIVIAL test ("STEP 2a puts its impact at or below the ceiling", which
reads as if 2a exists to serve that test), STEP 2a's own framing, and the marker
spec. All three now say otherwise, and
`tests/workflows/dependabot-pr-merge.test.ts` pins the wording. Re-run with
`--runs 3` (worst-case verdict): **3/3**, against 1 of 3 observed before.

Worth keeping in view: `behavioral` passed on every one of those runs, before
and after. An eval that watched only what the agent *did* would have called this
green throughout and never seen the audit trail go missing. That is the case for
grading the marker.
