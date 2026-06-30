# Writing a triage summary

A triage summary is a comment posted when an issue moves to `ready-for-agent`
(or `ready-for-human`). It captures the **problem statement** — what the issue is
really asking for and what "done" looks like — so a downstream agent (or human)
can pick it up. The original body and discussion are context; the summary is the
distilled problem.

Triage classifies and **scopes the problem**. It does **not** design the
solution: triage runs with read-only context and no deep exploration, so any
implementation it guessed would be wrong as often as right. The build agent
explores the codebase fresh, with full source access, and owns every
implementation decision. Post the summary with `github_add_issue_comment`.

## Principles

**Durable.** The issue may sit in `ready-for-agent` for weeks while the codebase
moves. Describe the problem and the desired behaviour in terms that stay true as
the code changes. **Never** reference file paths or line numbers; they go stale.

**Problem, not solution.** Say *what* should be true when the work is done, not
*how* to build it. Do **not** name types, function signatures, or config shapes,
propose an implementation approach, or point at where in the code to change —
that is the build agent's job.
- Good: "Todos can have an optional target date, shown in the list and editable."
- Bad: "Add a `dueDate: Date` field to the `Todo` interface and a date picker in `TodoForm`."

**Complete acceptance criteria.** List concrete, independently testable criteria
so the agent knows when it's done. These describe the problem's done-state — not
the implementation.
- Good: "A todo with a past target date is visually flagged as overdue."
- Bad: "Triage should work correctly."

**Explicit scope boundaries.** State what is *out of scope* so the agent doesn't
gold-plate or wander into adjacent features.

## Template

```markdown
## Triage Summary

**Category:** bug / enhancement
**Summary:** one line — what needs to happen

**Current behavior:**
What happens now. For a bug, the broken behaviour. For an enhancement, the
status quo it builds on.

**Desired behavior:**
What should happen after the work is done. Be specific about edge cases and
error conditions — in user-visible / behavioural terms, not code.

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2

**Out of scope:**
- Thing that should NOT be changed here
- Adjacent feature that looks related but is separate
```

## `ready-for-human` variant

Same structure, plus a leading note on **why it can't be delegated** — judgment
calls, external access, design decisions, or manual testing the agent can't do.
