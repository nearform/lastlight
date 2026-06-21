# Skills

Skill directories staged into the sandbox per workflow phase (and a subset into
chat). A phase declares `skill: <name>` / `skills: [<name>, …]`; the runner
stages the whole directory into `<agentCwd>/.agents/skills/<name>/` and
pi-coding-agent surfaces `name` + `description` in the system prompt. The agent
reads SKILL.md (and any `references/`) on demand via its `read` tool.

**Authoring guide:** [`docs/agents/writing-skills.md`](../docs/agents/writing-skills.md)
— the loading contract, the craft, and house conventions. Read it before adding
or editing a skill.

## Skills

| Skill | Used by | Purpose |
|-------|---------|---------|
| [`chat`](chat/) | chat | Conversational assistant for Slack/Discord threads — answer repo/PR/issue questions, guide to natural-language triggers. |
| [`issue-triage`](issue-triage/) | `issue-triage.yaml`, chat | Move issues through the canonical triage state machine — categorise, label, dedupe, manage stale, write agent briefs. |
| [`issue-comment`](issue-comment/) | `issue-comment.yaml` | Handle non-build maintainer comments on issues/PRs — close, label, answer briefly, redirect build requests. |
| [`pr-review`](pr-review/) | `pr-review.yaml`, chat | Review a PR with structured, tiered feedback; build and test from the local checkout; post a formal review. |
| [`pr-comment`](pr-comment/) | `pr-comment.yaml` | Answer a maintainer's question about an open PR with concrete, code-cited evidence (not a full review). |
| [`repo-health`](repo-health/) | `repo-health.yaml`, chat | Generate a repository health report — open issues, PR backlog, CI status, action items. |
| [`security-review`](security-review/) | `security-review.yaml` | Diff-scoped SDLC security review; file one dated summary issue with a task-list of findings. |
| [`security-feedback`](security-feedback/) | `security-feedback.yaml` | Process a maintainer's comment on a security scan summary — break findings into issues or record suppressions. |
| [`building`](building/) | build (executor, reviewer), `pr-fix.yaml`, `pr-review.yaml` | Shared craft: install-first + package-manager detection, the test/lint/typecheck gate, and TDD discipline in the sandbox. |
| [`code-review`](code-review/) | build (reviewer), `pr-review.yaml` | Shared rubric: finding tiers (Critical/Important/Suggestions/Nits) and what-to-check. Referenced by both the branch-diff reviewer and the PR reviewer. |

`building` and `code-review` are **shared building blocks** — referenced by the
build-cycle prompts (`workflows/prompts/*.md`) and the PR skills so the install
gate and review rubric live in one place. They're staged alongside the phase's
primary skill/prompt and read on demand.

The live set is enforced at startup: `validateAssets()` (`src/workflows/loader.ts`)
resolves every workflow `skill:` reference and `CHAT_SKILL_NAMES`
(`src/engine/chat-skills.ts`). Adding a skill here does nothing until a phase or
the chat list references it.
