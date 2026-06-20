# Writing Last Light skills

The skills under `skills/` are staged into a sandbox and run **autonomously**
against a target repo — no human is in the loop mid-run. A skill exists to
wrangle determinism out of a stochastic agent: the goal is **predictability**,
the agent taking the same *process* every run (not producing the same output).
Everything below serves that.

This doctrine is adapted from `mattpocock/skills`' `writing-great-skills`. The
craft transfers; the interaction model does not — see [Autonomous, not
interactive](#autonomous-not-interactive).

## How skills load (the runtime contract)

Verified against `agentic-pi` → `@earendil-works/pi-coding-agent`. Skills are
**catalogue-on-demand, never prompt-injected**:

- A phase declares `skill: pr-review` (or `skills: [a, b]`). The runner stages
  each named `skills/<name>/` directory — **the whole tree** (SKILL.md +
  `references/` + `scripts/` + `assets/`) — into `<agentCwd>/.agents/skills/<name>/`
  before the run (`stageSkillsInWorkspace`, `src/engine/agent-executor.ts`).
- pi-coding-agent auto-discovers `.agents/skills/` (walking up from cwd to the
  git root) and puts **only `name` + `description` + the SKILL.md path** into
  the system prompt, inside `<available_skills>`. The body is not injected.
- The agent reads SKILL.md on demand via its `read` tool, and the prompt tells
  it to resolve relative links against the skill dir. **So `references/*.md`
  next to SKILL.md are reachable** — progressive disclosure works and is the
  intended design.

Three hard constraints fall out of this:

1. **`description` is required and ≤1024 chars.** It is the one line always in
   context, and the trigger that fires the skill — front-load the leading word,
   list distinct trigger branches, cut anything already in the body.
2. **Never set `disable-model-invocation: true`.** That flag drops the skill
   from the catalogue (it's how `mattpocock/skills` makes user-invoked skills) —
   our skills must stay visible so the agent reaches them autonomously. Do not
   copy the flag when porting.
3. **A skill cannot read another skill's files.** Each skill stages into its own
   run/workspace, so e.g. `security-feedback` cannot `read`
   `security-review/references/`. Shared contracts (the security `§ Issue
   format` grammar) must be duplicated in each skill, with a lockstep warning.

## Autonomous, not interactive

The biggest adaptation from `mattpocock/skills`. Their skills grill the
maintainer one question at a time and wait for direction. Ours can't block on a
human. Where an interactive skill would ask, an autonomous skill must instead:

- **Make the call** within its permission profile and act, or
- **Post-and-stop** — write a comment (`needs-info`, a question, a recommendation)
  and end the run. The async comment *is* the interaction; the next event resumes
  the conversation.

Never "wait for the maintainer to reply" inside a run.

## The craft

**Leading words.** A compact concept already in the model's pretraining, used as
a repeated token (not a sentence) to anchor a region of behaviour in the fewest
tokens — *tracer bullet*, *tight loop*, *install-first*, *red*. It serves
predictability twice: in the body it anchors execution; in the description it
anchors invocation. Hunt for restated triads ("fast, deterministic,
low-overhead" → *tight*) and collapse them. A leading word too weak to beat the
default is a [no-op](#pruning) — strengthen the word, don't change technique.

**Completion criteria.** Every step ends on the condition that tells the agent
it's done. Make it *checkable* (can the agent tell done from not-done?) and,
where it matters, *exhaustive* ("every changed file read in full", not "look at
the diff"). A vague bound invites **premature completion** — the agent slips to
the next step before the work is real.

**Information hierarchy + progressive disclosure.** Rank content by how
immediately the agent needs it: in-file steps (primary) → in-file reference →
reference disclosed to a linked file behind a pointer. Keep the top legible;
push bulky reference (templates, cheatsheets, format contracts, tier tables)
down into `references/` and point at it. Disclose what only some **branches**
need; inline what every path needs. (See the security-review SDLC checklist and
issue-format contract for the canonical example.)

**Single source of truth.** Each meaning lives in exactly one place, so changing
behaviour is a one-place edit. Duplication costs maintenance and tokens and
inflates a point's apparent importance. (The old `pr-review` restated "node_modules
is always absent" four times — one statement plus a leading word replaces it.)

## Pruning

Skills accumulate **sediment** (stale layers) and **sprawl** (length itself).
Cut aggressively:

- **Relevance** — does the line still bear on what the skill does? Delete stale
  and merely-expository lines.
- **No-op** — does the line change behaviour versus the agent's default? "Read
  the issue carefully" is a no-op; the agent already does. If not, delete it.
  Test each *sentence* in isolation; when one fails, drop the whole sentence.
- **Duplication** — one meaning, one home.

## House conventions

- **GitHub via MCP tools.** Inside the sandbox, use the `github_*` MCP tools for
  API operations (read metadata, post comments, labels, reviews, create issues).
  Never `gh` CLI, `curl`, or raw HTTP for the API. (This differs from
  `docs/agents/issue-tracker.md`, which governs the *maintainer* working on
  `cliftonc/lastlight` locally — that uses `gh`.)
- **Local checkout over API for code.** When a repo is cloned/pre-cloned, read
  diffs and file contents from the local checkout via `git`/`read`/`grep` — not
  `github_get_pull_request_diff` / `github_list_pull_request_files` /
  `github_get_file_contents`. The API patch is a large redundant payload that
  re-bloats context every turn.
- **Triage vocabulary.** Use the canonical roles from
  [`triage-labels.md`](triage-labels.md): categories `bug`/`enhancement`; states
  `needs-triage`/`needs-info`/`ready-for-agent`/`ready-for-human`/`wontfix`.
  Detect which labels the target repo actually has and degrade gracefully when
  the canonical ones are absent.
- **Frontmatter standard.** `name` (kebab, ≤64) and `description` (≤1024, trigger-led)
  are required. `version` and `tags` are optional. No `metadata.hermes` blocks —
  they are dead Hermes-migration cruft.

## Checklist

Before shipping a skill edit, confirm:

- [ ] Description ≤1024 chars, leads with the trigger word, no body duplication.
- [ ] No `disable-model-invocation`, no `metadata.hermes`.
- [ ] Every step ends on a checkable completion criterion.
- [ ] Bulky reference disclosed to `references/`; SKILL.md reads as a legible procedure.
- [ ] No duplicated meaning; no no-op lines; no waiting-on-a-human.
- [ ] GitHub API via `github_*`; code via the local checkout.
