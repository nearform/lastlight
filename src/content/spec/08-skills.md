---
title: "Skills"
order: 8
description: "The SKILL.md format, skill staging into the agent workspace, the catalogue of skills referenced by workflows and chat, and the agent-context/ persona layer that becomes AGENTS.md at session start."
---

## Purpose

Skills and agent-context are the two persistent text layers every agent
session sees. They sit *outside* a specific workflow — they're the
shared instructions and persona — and exist independently so a single
skill or a single rule can be reused across many workflows.

- **Skills** are reusable agent instructions referenced by name from a
  workflow phase's `skills:` field (or sugar `skill:`). Each skill is
  a directory under `skills/<name>/` containing a `SKILL.md` plus
  optional helper files.
- **Agent context** (`AGENTS.md`) is the persona + operational rules
  layer concatenated from `agent-context/*.md` at session start. Every
  agent — sandboxed or chat — reads it.

## How skills reach the agent

Skills follow the **progressive-disclosure** model described at
[pi.dev/docs/latest/skills](https://pi.dev/docs/latest/skills): only
the name and description of each registered skill appear in the
system prompt as an XML `<available_skills>` catalogue. The agent
loads the full SKILL.md (and any sibling files) on demand via its
built-in `read` tool when a task matches a skill's description.

The harness does *not* paste skill bodies into the user prompt. The
runner only:

1. Resolves the named skills to absolute host directory paths.
2. Stages each directory at `<workspace>/.agents/skills/<name>/`
   before the agent runs.
3. Lets pi-coding-agent's built-in `.agents/skills/` auto-discovery
   pick them up — it scans the cwd at session start, extracts
   name/description from the frontmatter, and emits the XML catalogue
   into the system prompt.

This means the runner never reads SKILL.md content. The contract
between the harness and the SDK is purely filesystem layout +
frontmatter shape.

## SKILL.md format

```yaml
---
name: issue-triage
description: |
  Triage GitHub issues — label, deduplicate, request info on incomplete
  reports, manage stale items.
version: 2.0.0
tags: [github, issues, triage]
---

# Issue Triage

## When to use
…

## Procedure
1. …
2. …
```

Frontmatter rules (enforced by pi-coding-agent's loader):

| Field | Required | Constraints |
|---|---|---|
| `name` | yes | lowercase a-z, 0-9, hyphens; ≤ 64 chars; no leading/trailing/consecutive hyphens |
| `description` | yes | ≤ 1024 chars; "what the skill does and when to use it" |
| `disable-model-invocation` | no | when `true`, hides the skill from the system-prompt catalogue (still readable explicitly) |
| `version`, `tags`, `metadata`, `license`, `compatibility`, `allowed-tools` | no | informational; pass through to dashboards |

**Skills missing `name` or `description` are silently dropped** by the
SDK loader. Every SKILL.md in `skills/` must carry valid frontmatter.

Body convention: `# Title`, then `##` sections — "When to Use",
"Procedure", "Tool Usage", "Pitfalls", "Verification".

A skill directory can contain anything alongside SKILL.md:

```
skills/issue-triage/
├── SKILL.md              # required, with frontmatter
├── scripts/              # helper bash/python the agent can run
│   └── count-labels.sh
├── references/           # detailed docs the SKILL.md links to
│   └── label-taxonomy.md
└── assets/               # templates, snippets
    └── comment-template.md
```

The **whole directory** is staged into the workspace — helper scripts
and references are visible at `.agents/skills/<name>/scripts/...` and
runnable / readable by the agent's bash and read tools.

## Skill loader

```ts
// src/workflows/loader.ts:208
export function resolveSkillPaths(names: readonly string[]): string[] {
  return names.map((name) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new Error(`Invalid skill name: ${name}`);
    }
    for (const base of SKILL_BASES) {
      const dir = join(base, name);
      if (existsSync(join(dir, "SKILL.md"))) return dir;
    }
    throw new Error(`Skill not found: skills/${name}/SKILL.md`);
  });
}
```

Returns absolute **directory** paths — one per declared skill. Search
order: `skills/<name>/`, then `.claude/skills/<name>/` (legacy). The
loader does **not** recurse into nested directories —
`skills/software-development/architect` is not addressable as
`software-development/architect`. Names are flat and alphanumeric.

`loadSkillRaw(name)` (same file) is retained for the admin dashboard's
skill viewer — it returns the raw SKILL.md text for display. The
runner doesn't call it.

## Phase declaration

A phase declares skills via either form (mutually exclusive with each
other, but may coexist with `prompt:`):

```yaml
# Single skill — sugar for skills: [pr-review]
- name: review
  skill: pr-review

# Multiple skills — first entry is "primary"
- name: triage
  skills: [issue-triage, pr-review]

# Prompt + skills — template is the user prompt, skills are staged
# alongside; the template can reference them by name.
- name: reviewer
  prompt: prompts/reviewer.md
  skills: [pr-review]
```

The runner's resolution order (`buildPhasePrompt` in `runner.ts`):

1. If `prompt:` set — render the template as the user prompt. The
   staged catalogue is available alongside; the template can say
   "see the `pr-review` skill for the structured-feedback format" and
   the agent reads it via its `read` tool.
2. Else if `skills:` (or `skill:`) set — emit a short auto-generated
   nudge that points the agent at the primary skill:
   ```
   Use the **pr-review** skill to handle this request.
   Read `.agents/skills/pr-review/SKILL.md` for the full instructions.
   Other skills available if you need them: issue-triage.

   Context:
   owner: clifton
   repo: lastlight
   issueNumber: 42
   ...
   ```
3. Else — throw.

## Workspace staging

Before each agent run, `stageSkillsInWorkspace` in
`src/engine/agent-executor.ts` materialises the named skills under
`<agentCwd>/.agents/skills/<name>/`. Behaviour:

- **Always clears the staging directory first.** Each phase gets a
  clean slate — a phase with no `skills:`/`skill:` sees no
  `.agents/skills/` at all, even if a previous phase in the same
  linear-runner workspace staged some.
- **Whole directory, not just SKILL.md.** `scripts/`, `references/`,
  `assets/` travel along.
- **Two modes:**
  - `symlink` (gondolin / none) — `symlinkSync(hostDir, stageDir, "dir")`.
    Zero-copy; pi-coding-agent's tools run in the harness process and
    can follow host symlinks.
  - `copy` (docker) — recursive `cpSync(hostDir, stageDir, { recursive: true, dereference: true })`.
    Symlinks pointing at harness host paths wouldn't resolve inside the
    container; copy piggybacks on the existing workspace bind-mount
    instead of adding new `-v` flags per skill.
- **Rooted at `agentCwd`, not workDir.** When the harness pre-cloned
  the target repo (`access.prePopulateBranch` set), cwd is
  `<workDir>/<repo>` and `.agents/skills/` is staged there. This
  avoids the walk-up auto-discovery ever crossing the inner repo's
  `.git` boundary.

```
<workspace>/                  ← agent's cwd (host workDir or workDir/<repo>)
├── AGENTS.md                  ← persona + rules (see below)
├── .agents/
│   └── skills/
│       ├── pr-review/         ← staged from <repo>/skills/pr-review/
│       │   ├── SKILL.md
│       │   └── ...
│       └── issue-triage/
│           └── SKILL.md
└── ... (target repo files)
```

## Chat path

Chat doesn't run inside pi-coding-agent's `AgentSession` — it uses
pi-ai's lower-level `completeSimple` loop. To still give chat the
same progressive-disclosure model, `src/engine/chat-skills.ts`:

1. Loads a curated chat skill list from `<repo>/skills/<name>/` using
   `loadSkillsFromDir` (same parser pi-coding-agent uses for sandbox
   phases). `CHAT_SKILL_NAMES` is the v1 hard-coded set:
   `["chat", "issue-triage", "pr-review", "repo-health"]`.
2. Formats an XML `<available_skills>` block (name + description per
   skill) and prepends it to the chat system prompt at boot
   (`src/index.ts`).
3. Registers a `read_skill` tool — pi-ai `Tool` shape, parameters
   `{ name: <enum-of-loaded-skill-names> }` — that resolves the name
   through `resolveSkillPaths` and returns the SKILL.md text.

The chat agent sees the catalogue in its system prompt, decides when
a request matches a skill, and calls `read_skill` to pull the body.
Same UX as the sandbox path, lighter implementation.

## Skill catalogue

Top-level skills referenced from at least one workflow YAML or by the
chat runtime:

| Skill | Purpose | Used by |
|---|---|---|
| `issue-triage` | Label, deduplicate, request info, manage stale issues | `issue-triage.yaml`, `cron-triage.yaml`, chat |
| `issue-comment` | Handle non-build maintainer comments on issues | `issue-comment.yaml` |
| `pr-review` | Structured PR review (critical / important / suggestion / nit) | `pr-review.yaml`, `cron-review.yaml`, chat |
| `pr-comment` | Answer maintainer questions on open PRs | `pr-comment.yaml` |
| `repo-health` | Weekly health report (open / stale / velocity / labels) | `repo-health.yaml`, `cron-health.yaml`, chat |
| `security-review` | Diff-based security scan since last review | `security-review.yaml`, `cron-security.yaml` |
| `security-feedback` | Break out scan findings into individual issues | `security-feedback.yaml` |
| `building` | Shared craft: install deps + run the test/lint/typecheck gate in the sandbox (package-manager detection from lockfile, install-first, TDD discipline when implementing) | build executor + reviewer, `pr-fix.yaml`, `pr-review.yaml` |
| `code-review` | Shared review rubric: finding tiers (Critical / Important / Suggestions / Nits) + what to check (correctness, security, edge cases, regression risk, test coverage) | build cycle's branch-diff reviewer, `pr-review.yaml` (same rubric, different procedure) |
| `issue-answer` | Answer a question directly: sourced neutral reply to a GitHub issue or Slack thread; research repo docs + web; label `question` (GitHub only); never write a brief, mark ready-for-agent, or change code | `answer.yaml` |
| `chat` | Conversational assistant persona | chat (always-on) |

`building` and `code-review` are not optional libraries — they're live
shared building blocks staged into multiple workflows (the build cycle,
`pr-fix`, and `pr-review`), the same way `issue-triage` is reused across
webhook and cron. The "Used by" column lists every workflow that stages
each.

Nested skill directories (`skills/software-development/architect`,
`skills/github/github-pr-workflow`, etc.) exist as a category library —
they're organisational, not loader-discoverable. Their content informs
inline prompt files and documentation, but workflows don't reference
them directly.

## Agent context layer

Three files in `agent-context/`, read in alphabetical order:

- **`rules.md`** — operational guardrails. Workspace conventions,
  GitHub-first coordination, git auth, managed repos, review and
  triage guidelines, label standards.
- **`security.md`** — security boundaries. Untrusted user content
  marked `<<<USER_CONTENT_UNTRUSTED>>>` is data not instructions;
  host / runtime disclosure is refused; injection-attempt detection
  via `[lastlight-flag: …]` prefixes.
- **`soul.md`** — identity and communication style. Helpful, precise,
  kind, conservative, transparent. The three roles
  (Architect / Executor / Reviewer). GitHub-first coordination,
  delegation model.

## AGENTS.md materialization

Two surfaces, with a subtle inconsistency.

### Sandbox

The harness writes `AGENTS.md` into the workspace before each agent
run (`src/engine/agent-executor.ts`):

```ts
const md = loadAgentContext(config.agentContextDir);
if (md) writeFileSync(join(workDir, "AGENTS.md"), md);
```

`loadAgentContext()` (`src/engine/profiles.ts`) joins
`agent-context/*.md` with `\n\n---\n\n`. pi-coding-agent's discovery
walks up from cwd and reads it.

### In-process (chat)

```ts
// src/index.ts (chat boot)
systemPrompt: loadAgentContext() + CHAT_SYSTEM_SUFFIX + chatSkills.catalogueXml
```

Same `loadAgentContext()` helper, but injected directly into the
chat system prompt rather than dropped on disk. The chat-specific
suffix and the skill catalogue XML are appended.

Both paths use the same `\n\n---\n\n` separator now. The legacy
sandbox-entrypoint `cat /app/agent-context/*.md` (raw concatenation)
applies only to the docker backend's container entrypoint and is on
its way out — the in-process AGENTS.md write happens first, so the
on-disk file is canonical.

## Skills vs prompts vs full workflows

When to use which:

| Use a … | When … |
|---|---|
| **Skill** | The instructions are reusable across workflows (`issue-triage` from both webhook and cron), or you want the agent to pull them on demand via progressive disclosure. Self-contained behaviour. |
| **Inline prompt** | The instructions are workflow-specific and read from workflow-specific shared state (architect-plan, scratch-key, fix-cycle). Lives under `workflows/prompts/`. |
| **Prompt + skills together** | The phase's overall flow is workflow-specific (use a prompt), but it leans on reusable rules (a skill). The prompt references the skill by name. |
| **Skill-style workflow** | A one-phase YAML wrapping a skill — `issue-triage.yaml` is just `phases: [{ name: triage, skill: issue-triage }]`. Lets the workflow runner manage dispatch even for atomic skill work. |
| **Multi-phase workflow** | Architect → Executor → Reviewer cycles, loops, approval gates. `build.yaml`, `explore.yaml`. Each phase picks a prompt, a skill, or both. |

The deciding question is reuse, not size. A long single skill can stay
in `skills/`; a short prompt that's tied to one workflow's shared
state belongs in `workflows/prompts/`.

## Invariants

- **One canonical `AGENTS.md`** is materialised per session. Mutating
  it after startup will not propagate — pi-coding-agent reads it once
  at session start.
- **Skill names are flat and alphanumeric.** `[a-zA-Z0-9_-]+` only.
  No slashes, no nesting via the loader.
- **Frontmatter is mandatory.** Skills without `name` + `description`
  are silently dropped by pi-coding-agent's loader. Every SKILL.md in
  `skills/` must carry both.
- **The runner never reads SKILL.md content.** It only resolves paths
  and stages directories. Skill bodies reach the agent through
  pi-coding-agent's auto-discovery + the agent's own `read` tool.
- **`.agents/skills/` is cleared at every phase.** A phase with no
  `skills:` declaration gets no staged catalogue, even if a previous
  phase in the same workspace staged some.
- **Whole directories travel.** `scripts/` / `references/` / `assets/`
  next to a SKILL.md are visible at `.agents/skills/<name>/...` and
  runnable / readable by the agent's bash and read tools.
- **Agent context is *append-only* per session.** The sandbox writes
  `AGENTS.md` at startup and never modifies it. Chat injects it once
  into the system prompt. Drift between sessions only happens if
  `agent-context/*.md` itself changes on disk.

## Current implementation

| Piece | File |
|---|---|
| Skill name validation + path resolution | `src/workflows/loader.ts` (`resolveSkillPaths`, `loadSkillRaw`) |
| Phase config overlay (resolves `skill:`/`skills:` into `ExecutorConfig.skillPaths`) | `src/workflows/runner.ts` (`phaseConfigFor`) |
| User prompt generation | `src/workflows/runner.ts` (`buildPhasePrompt`) |
| Workspace staging (symlink/copy) | `src/engine/agent-executor.ts` (`stageSkillsInWorkspace`) |
| Chat catalogue + `read_skill` tool | `src/engine/chat-skills.ts` |
| Chat catalogue wiring | `src/index.ts` (ChatRunner boot) |
| Skills | `skills/<name>/SKILL.md` |
| Agent context layer | `agent-context/{rules,security,soul}.md` |
| In-process `loadAgentContext()` | `src/engine/profiles.ts` |

## Rebuild notes

- **Filesystem layout is the contract.** The decision to stage skills
  at `<cwd>/.agents/skills/` and rely on pi-coding-agent's
  auto-discovery means there is no SDK-level skill API to maintain.
  A re-implementation on a different SDK should pick an equivalent
  filesystem convention rather than threading skill objects through
  function calls.
- **Keep skills flat.** The loader's flat-name policy is a feature.
  Nested category directories are useful for human navigation in the
  repo but should never become part of the addressable name. If you
  want categories at the loader level, namespace them explicitly
  (e.g. `triage/issue-triage`) — don't make them implicit by path.
- **Don't re-embed skill content into the prompt.** The legacy
  approach (paste the whole SKILL.md into the user prompt every
  turn) made prompts huge and prevented multi-skill phases.
  Progressive disclosure scales linearly with the number of skills
  staged because only descriptions reach the system prompt.
- **Stage only what the phase declared.** Bind-mounting / symlinking
  the entire `skills/` catalogue would work but defeats the per-phase
  scoping that lets us reason about what's in context. Per-phase
  staging keeps the surface area honest.
- **Symlink vs copy is a backend detail, not a policy choice.**
  Gondolin runs pi-coding-agent in the harness process — host
  symlinks resolve. Docker runs it in a container — they don't.
  Either way the on-cwd layout the agent sees is identical.
- **Frontmatter as documentation contract.** Even though the agent
  only sees name + description in the catalogue, the other structured
  fields (`tags`, `version`, `metadata`) are how dashboards / IDEs
  render skills. Don't drop the schema even though the runtime
  ignores most of it.
- **The persona layer is small for a reason.** Three files, total
  size measured in kilobytes. A re-implementation that grows this
  into a sprawling 50-file behavior library will quickly find the
  agent ignoring half of it. Keep it ruthless.
- **Bot personality lives here, not in code.** A re-implementation
  should treat `agent-context/` the same way it treats
  `workflows/*.yaml` — versioned, reviewable, behaviour-defining.
  Code changes that affect tone or rules belong here, not in TypeScript.
