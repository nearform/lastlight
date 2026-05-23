You are helping a maintainer think through a half-formed idea. Before we ask
any clarifying questions, you need to clone the target repo, explore the
relevant code, and write a detailed context document that all subsequent
phases will reference.

## Step 1 — Prepare the workspace

The repo lives (or will live) in a `{{repo}}/` subdirectory under your
cwd. Check first:

```
ls -la
```

- If you see `{{repo}}/.git/` already, the harness pre-cloned it.
  `cd {{repo}}` and continue.
- Otherwise clone it into a `{{repo}}/` subdirectory and cd in:

  ```
  git clone https://github.com/{{owner}}/{{repo}}.git {{repo}}
  cd {{repo}}
  ```

  Git credentials are already configured.

All subsequent file paths in this prompt are relative to the cwd.

{{#if issueNumber}}
## Step 2 — Read the issue

Fetch issue #{{issueNumber}} using the GitHub MCP tools to get the latest
title, body, and comments.
{{/if}}

## Source material

{{#if issueTitle}}**Issue title:** {{issueTitle}}{{/if}}
{{#if issueBody}}
**Issue body:**

```
{{issueBody}}
```
{{/if}}
{{#if commentBody}}
**Most recent comment / Slack message that triggered this explore:**

```
{{commentBody}}
```
{{/if}}

## Step 3 — Deep codebase exploration

Read the source material above, then explore the codebase thoroughly to
understand everything relevant to the idea. Look at:

- Directory structure and key entry points
- Files, modules, and types that relate to the idea
- Existing patterns, conventions, and abstractions the idea would build on
- Database schemas, API routes, or config that would be affected
- Tests and how they're structured in the relevant areas

## Step 4 — Write the context document

First create the scratch directory at the WORKSPACE root (alongside
`{{repo}}/`, not inside it):

```
mkdir -p ../{{issueDir}}    # if you're inside the {{repo}}/ subdir
# OR, if you cd'd back out:
mkdir -p {{issueDir}}
```

Then write a detailed context file to **`{{issueDir}}/explore-context.md`**
relative to the workspace root (i.e. `../{{issueDir}}/explore-context.md`
when you're inside the repo subdir). This file is the primary reference for
all subsequent phases — they should rarely need to re-explore the codebase.

Structure it as:

```markdown
# Explore context: <short description of the idea>

## Idea summary
<2-3 sentences distilling what the user wants>

## Codebase overview
<Brief description of the repo's purpose and structure>

## Relevant architecture
<How the parts of the codebase that matter for this idea fit together.
Include file paths, key types/interfaces, function signatures, data flow.>

## Key code excerpts
<Paste the most relevant snippets (with file paths and line numbers) that
a later agent would need to understand the design space. Don't be shy —
include enough that the next phase doesn't have to re-read these files.>

## Existing patterns to follow
<Conventions, naming, testing approach, etc. from the codebase that the
new work should match.>

## What we know
- <bullet>

## What's unclear
- <bullet>
```

Be thorough — the quality of the socratic questions and the final spec
depend entirely on how well this document captures the relevant code.

## Step 5 — Output the baseline

After writing the context file, output a brief baseline summary (the
"What we know" and "What's unclear" sections) as your reply. This is what
the socratic loop will see as `{{baseline}}`.

Do not ask questions yet. Do not write a spec yet.
