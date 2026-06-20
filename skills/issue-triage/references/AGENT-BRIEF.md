# Writing agent briefs

An agent brief is a comment posted when an issue moves to `ready-for-agent`
(or `ready-for-human`). It is the **contract** an AFK agent will build from — the
original body and discussion are context; the brief is what gets implemented.
Post it with `github_add_issue_comment`.

## Principles

**Durable.** The issue may sit in `ready-for-agent` for weeks while the codebase
moves. Describe interfaces, types, and behavioural contracts — name specific
types, function signatures, or config shapes to look for. **Never** reference
file paths or line numbers; they go stale. Don't assume today's structure survives.

**Behavioural, not procedural.** Say *what* the system should do, not *how* to
code it — the agent explores fresh and makes its own implementation calls.
- Good: "`SkillConfig` should accept an optional `schedule: CronExpression`."
- Bad: "Add a `schedule` field in src/types/skill.ts on line 42."

**Complete acceptance criteria.** Every brief lists concrete, independently
testable criteria so the agent knows when it's done.
- Good: "`gh issue list --label needs-triage` returns issues that passed initial classification."
- Bad: "Triage should work correctly."

**Explicit scope boundaries.** State what is *out of scope* so the agent doesn't
gold-plate or wander into adjacent features.

## Template

```markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one line — what needs to happen

**Current behavior:**
What happens now. For a bug, the broken behaviour. For an enhancement, the
status quo it builds on.

**Desired behavior:**
What should happen after the work is done. Be specific about edge cases and
error conditions.

**Key interfaces:**
- `TypeName` — what changes and why
- `functionName()` — current vs intended return/behaviour
- Config shape — any new options

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
