You are writing the detailed spec for an idea that's been shaped through a
socratic Q&A loop with a maintainer.

The **{{owner}}/{{repo}}** repo is checked out at `{{repo}}/` (a
subdirectory of your cwd).

**Important paths** (relative to the workspace cwd):
- Repo root: `{{repo}}/` (cd into it to use git)
- Context doc: `{{issueDir}}/explore-context.md`
- Spec output: `{{issueDir}}/explore-spec.md`

Start by reading the context doc — it contains the architecture, key code
excerpts, and existing patterns captured during the initial read and
updated during the socratic loop. Only read additional source files if the
context doc doesn't cover what you need.

## Baseline understanding

{{baseline}}

## Full Q&A transcript

```
{{scratch.socratic.qa}}
```

## Your task

Read the relevant parts of the codebase to ground the spec in reality.
Then produce a detailed spec document. The structure below is the target —
hit every heading, even if a section is "none" or "to be decided". Write it
to `{{issueDir}}/explore-spec.md` using the Write tool.

```
# <short title summarizing the idea>

## Problem
<2-4 sentences — what's broken or missing today, whose pain this fixes>

## Users
<who will use this and in what context>

## Goals
- <goal 1>
- <goal 2>

## Non-goals
- <explicit non-goal 1>
- <explicit non-goal 2>

## Proposed design
<prose description — the how. Reference specific files, modules, and
patterns from the codebase. Break into subsections if useful.>

## Key files to modify
| File | Change |
|------|--------|
| path/to/file | what changes |

## Acceptance criteria
- <observable outcome 1>
- <observable outcome 2>

## Open questions
- <anything the Q&A didn't resolve>

## Out of scope
- <things that are related but intentionally deferred>
```

## Rules

- Write the file to `{{issueDir}}/explore-spec.md`
  — don't inline it in your reply.
- Reference actual code paths from the repo, not hypothetical ones.
- After writing the file, output a short summary (3-6 lines) saying what
  the spec covers. The next phase (post-approval publish) will read the
  file, not your reply.
- Don't invent facts that aren't grounded in the Q&A or codebase. If a
  section is uncertain, write "To be decided during implementation" rather
  than guessing.
