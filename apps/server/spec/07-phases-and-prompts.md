---
title: "Phases & Prompts"
order: 7
description: "Phase types, the template engine (substitution, conditionals, helpers, phase-output access), the variable context every prompt sees, and the catalogue of prompt files under workflows/prompts/."
---

## Purpose

[Workflow Engine](/spec/06-workflow-engine) defines what a phase *is*.
This page documents what a phase actually *does* — the template engine
that renders a prompt, the variables available to it, and the catalogue
of prompt files that drive each workflow.

## Phase types

Four from the runner's perspective; an agent phase further specialises
depending on whether it declares `loop:` or `generic_loop:`.

| Type | Used for | Required fields | Optional fields |
|---|---|---|---|
| `context` | Dashboard checkpoints — no agent runs | `name`, `label`, `type: "context"` | — |
| `agent` (default) | One agent session | `name`; at least one of `prompt:`, `skill:`, `skills:` | `model`, `variant`, `loop`, `generic_loop`, `approval_gate`, `output_var`, `on_output`, `messages`, `depends_on`, `unrestricted_egress`, `web_search`, `requires_sandbox`, `sandbox_image`, `skip_if` |
| `bash` | Deterministic shell command in the sandbox (no LLM) | `name`, `type: "bash"`, `command:` | `timeout_seconds`, `output_var`, `approval_gate`, `messages`, `depends_on`, `unrestricted_egress`, `sandbox_image` |
| `script` | Inline JS/TS (`node`) or Python (`uv run`) in the sandbox | `name`, `type: "script"`, `script:` | `runtime` (default `js`), `timeout_seconds`, `output_var`, `approval_gate`, `messages`, `depends_on`, `unrestricted_egress`, `sandbox_image` |

`bash`/`script` phases run in the same sandbox/workspace as agent phases,
expose stdout downstream via `output_var` → `{{phaseOutputs.<name>}}`, fail the
phase on a non-zero exit, and are mirrored to a session jsonl (command →
`bash` tool_use, output → tool_result) so they show in the dashboard +
`lastlight session log` with `turns: 0`. See [Sandbox](/spec/09-sandbox).

`prompt:` and `skills:` (or sugar `skill:`) may be set together — the
prompt template is rendered as the user prompt, and the named skills
are staged into the phase's bundle at
`<workspaceRoot>/.lastlight-skills/<phase>/<name>/` alongside so the
agent can pull them via its `read` tool. See [Skills](/spec/08-skills)
for the full staging mechanism. `skill:` and `skills:` are mutually
exclusive with each other (sugar collision).

Agent phases iterate when a loop is declared:

- `loop:` — the reviewer / fix cycle on `build.yaml`. The iteration
  variable is `fixCycle`, named `phase_fix_1`, `phase_2` (re-review),
  `phase_fix_2`, `phase_3`, etc.
- `generic_loop:` — until-condition / reply-gate iteration used by
  `explore.yaml`. Named `phase_iter_1`, `phase_iter_2`, …
  `iteration`, `maxIterations`, `previousOutput`, and `scratch.<key>`
  are exposed to the prompt.

## Template engine

`src/workflows/templates.ts`. Mustache-flavored but bespoke.

| Syntax | Meaning |
|---|---|
| `{{varName}}` | Substitution. Empty if missing. |
| `{{dotted.key}}` | Nested object access. First segment falls back to `phaseOutputs` if not on the base context. |
| `${phaseName.output}` | Inline phase-output substitution at the top level. |
| `{{#if varName}}…{{/if}}` | Conditional block. Truthy = non-empty string / non-zero number / non-empty array / `true`. **Does not nest** — see Invariants. |
| `{{#if !varName}}…{{/if}}` | Negated conditional. |
| `{{slugify varName}}` | Helper — lowercase, hyphen-separated, max 40 chars. |
| `{{branchUrl filename}}` | Helper — produces `https://github.com/{owner}/{repo}/blob/{branch}/{issueDir}/{filename}`. |
| `{{artifactUrl filename}}` | Helper — mode-aware handoff-doc link: GitHub blob URL in repo mode, dashboard Artifacts deep link in server mode (falls back to the blob URL without `PUBLIC_URL`). |
| `{{approvalUrl}}` | Helper — deep link to the focused approval view (`${publicUrl}/admin/?approval=<id>`) for the gate being rendered; empty without `PUBLIC_URL` or `approvalId`. |

The `walkKey()` fallback (`templates.ts:112–126`) is load-bearing for
phase outputs: a prompt can write `{{architect.output}}` to read the
architect phase's output without having to spell `phaseOutputs.architect.output`
every time.

## Variable context

Built in `src/workflows/simple.ts:248–279` and merged with phase-scoped
extras at each phase boundary in `runner.ts:385, 528, 837`.

| Variable | Source |
|---|---|
| `owner`, `repo`, `issueNumber`, `prNumber` | The triggering envelope or dispatch context |
| `issueTitle`, `issueBody`, `issueLabels`, `commentBody`, `sender` | Same |
| `branch` | Derived — `lastlight/{issueNumber}-{slug}` for builds; pre-populated for PR reviews |
| `taskId` | `${repo}-${issueNumber}-${workflowName}-${runId.slice(0, 8)}` |
| `issueDir` | `.lastlight/issue-${issueNumber}` (or `.lastlight/${workflowName}-${id}`) |
| `bootstrapLabel` | From config; default `lastlight:bootstrap` |
| `contextSnapshot` | Wrapped untrusted user content + branch + sender, built at `simple.ts:229–246` |
| `models`, `variants` | The model/variant maps from config — `{{models.architect}}` resolves to the override or default |
| `fix`, `dependencies` | The **effective** policy blocks (repo layer already clamped in), so a prompt can render `{{fix.maxAttempts}}` / `{{dependencies.autoMergeMaxImpact}}` and state the budget it is actually running under rather than a number frozen in prose |
| `prePopulateBranch` | Branch to pre-clone (PR reviews / builds) |
| `triggerIdOverride` | Slack `slack:{teamId}:{channel}:{thread}` override |
| `phaseOutputs` | Built up during execution, keyed by phase name or `output_var` |
| `scratch` | Mutable JSON from `workflow_runs.scratch` — see [Workflow Engine §scratch state](/spec/06-workflow-engine) |
| `fixCycle` | Loop only — 0-indexed (first fix is `fixCycle: 0`) |
| `iteration`, `maxIterations`, `previousOutput` | `generic_loop` only |
| `...request.extra` | Workflow-specific extras spread in last (e.g. `failedChecks`, `ciSection` for `pr-fix`) |

The third policy block, `review`, is deliberately **not** seeded here. A dotted
key resolves against the context first and only falls back to `phaseOutputs` when
its first segment is absent — and `build.yaml`'s reviewer loop emits
`output_var: review`, which `prompts/pr.md` reads as `{{review.approved}}` /
`{{review.cycles}}`. A top-level `review` object would shadow it and make every
build PR claim unresolved reviewer issues. The review policy has no prompt
consumer anyway: it is read in code, off the run's config.

## Phase rendering pipeline

From "the runner has reached phase X" to "the agent receives a prompt
string":

1. `loadDefinition(workflowName)` — YAML loaded and cached.
2. Build base context (`simple.ts:248–279`).
3. Enter phase: `context` writes a checkpoint and returns; `agent`
   calls `runPhase()`.
4. Merge phase-scoped extras into base context — `phaseOutputs`,
   `fixCycle`, `iteration`, `previousOutput`, `scratch` (`runner.ts:385, 528, 837`).
5. Resolve `phase.model` and `phase.variant` strings — these may
   themselves be templates like `{{models.architect}}`.
6. `phaseConfigFor(config, phase)` resolves `skill:`/`skills:` to
   absolute directory paths via `resolveSkillPaths` and overlays them
   onto `ExecutorConfig.skillPaths` (alongside any `unrestricted_egress`
   / `web_search` overrides). All `runPhase` call sites route through
   here, so loop fix/re-review cycles inherit the parent phase's
   skills automatically.
7. `buildPhasePrompt(phase, ctx)`:
   - If `prompt:` set — `loadPromptTemplate(path)`, render against ctx. The
     runner resolves this (and step 6's `resolveSkillPaths`) through the **run's**
     `AssetResolver` when the target repo commits a `.lastlight/` layer, and
     through the module-level facade otherwise — see
     [Configuration](/spec/02-configuration).
   - Else if `skills:`/`skill:` set — emit a short auto-generated
     nudge: `Use the **<primary>** skill … Other skills available: …` followed by the workflow context as `key: value` lines.
   - Otherwise — error.
8. `executeAgent()` runs with cwd = the pre-cloned repo (workspace root if
   not pre-cloned) and stages the resolved skill paths into a per-phase
   bundle at `<workspaceRoot>/.lastlight-skills/<phase>/<name>/` (symlink in
   `none`, recursive copy in docker/gondolin — gondolin mounts only cwd,
   so a symlink would dangle outside the guest mount) — a sibling of the `<repo>/`
   subdir, never in its git tree — then maps it to the agent via absolute
   `--skill` (docker) / `skillPaths` (in-process). It delivers `AGENTS.md` —
   a workspace write on the host-shared backends, the `AgentContextSink` channel
   on kubernetes (see [Skills](/spec/08-skills)) — then invokes the
   [Sandbox](/spec/09-sandbox) with the rendered prompt.
   The agent's `read` tool pulls SKILL.md content on demand —
   [Skills](/spec/08-skills).
9. Output is parsed for verdict / status markers and stored in
   `phaseOutputs[phase.name]` (and `phaseOutputs[phase.output_var]` if
   present).

## Prompt catalogue

Every file in `workflows/prompts/`.

### Build cycle

| File | Purpose | Output marker | Writes |
|---|---|---|---|
| `guardrails.md` | Pre-flight — verify test / lint / typecheck setup runs. Skips if `{{issueDir}}/status.md` already says READY. | First line `READY` or `BLOCKED` (matched by `on_output: contains_BLOCKED/READY`) | `{{issueDir}}/guardrails-report.md`, `{{issueDir}}/status.md` |
| `architect.md` | Read codebase + guardrails report → produce implementation plan with `file:line` evidence. Approval gate: `post_architect`. | None — deterministic structure | `{{issueDir}}/architect-plan.md`, `{{issueDir}}/status.md` |
| `executor.md` | Implement per plan, TDD, run guardrails commands, commit. | None | `{{issueDir}}/executor-summary.md`, `{{issueDir}}/status.md` |
| `reviewer.md` | Independent review against plan + diff. Approval gate: `post_reviewer` (on `REQUEST_CHANGES`). | First line `VERDICT: APPROVED` or `VERDICT: REQUEST_CHANGES` (parsed by `^\s*VERDICT:\s*…`) | `{{issueDir}}/reviewer-verdict.md`, `{{issueDir}}/status.md` |
| `fix.md` | Fix cycle `{{fixCycle}}` — address reviewer's flagged issues, run guardrails, commit. | None | Appends `## Fix Cycle {{fixCycle}}` to `executor-summary.md` |
| `re-reviewer.md` | Re-review after fix cycle. | Same `VERDICT:` marker | Appends `## Re-review after Fix Cycle {{fixCycle}}` to `reviewer-verdict.md` |
| `pr.md` | Open the PR. Uses `{{branchUrl}}` for links to planning docs. | None | GitHub PR; comment back on issue |

### PR fix (diagnose → fix; no architect, no review)

Both `pr-fix.yaml` and `dependabot-ci-fix.yaml` run **two** phases,
`diagnose` then `fix`, and stage `skills: [fixing, building]` on the
fix phase. The split exists to gate spend: `diagnose` runs against the
already-pre-cloned workspace *before* the install + test cycle, so a
failure no amount of fixing can address costs one short call rather
than a full gate run. `fixing` owns *why did this fail and can it be
fixed here*; `building` owns *install and run the gate*. See
[Skills](/spec/08-skills).

Each phase carries a `requires_marker` postcondition —
`DIAGNOSIS_COMPLETE` on `diagnose`, `CI_FIX_COMPLETE` on `fix` — and
the marker line is the interface between them. `diagnose` writes
`class=<one of five>` into its marker; `fix` declares a `skip_if` that
reads it (`phaseOutputs.diagnosis.contains('class=flaky')` and the two
other stopping classes) and is skipped, non-failing, when it matches.
`dependabot-ci-fix` previously had *no* postcondition at all, so a run
that inspected the PR and stopped without pushing or labelling reported
green.

Two of those three rows are unconditional. The `flaky` row is
**bounded**: once the snapshot reports `flakyDeferrals >=
fix.maxFlakyDeferrals` (packaged `2`), the harness drops that expression
for the run, so the *third* consecutive `flaky` verdict is treated as
`reproducible` and spends a normal attempt — three flaky reports running
is an intermittent real failure, and the alternative is an unbounded
series of free full runs on one flaky test. The conjunction lives in
`promoteFlakyDiagnosis` rather than in the guard because `skip_if`'s
grammar has no negation (see
[Workflow engine](/spec/06-workflow-engine#gated-skips)).

The model the `fix` phase runs on is escalated on the same axis. Above
`fix.escalateModelAfterAttempt`, `escalateFixModel`
(`src/workflows/simple.ts`) substitutes `models["pr-fix-retry"]` for
`models["pr-fix"]` for that run — the `model:` template renders against
the run context only, so `{{attempt}}` inside it could never work, and
rewriting the map is the same result with no engine change. It is done
*before* the map is persisted on `context.models`, so the admin panel
shows which model an attempt actually used and `resume.ts` reads that
same map back rather than re-deriving one.
An operator who configures no `pr-fix-retry` key gets today's behaviour
exactly, and a per-repo `models` override composes for free because the
map is already the merged `base ⊕ repo` one.

The marker lines are also the interface between *attempts*, not only
between phases. `{{phaseOutputs}}` is empty across a run boundary and
the shared per-PR workspace is `reset --hard`-ed between runs, so the
harness **harvests** each marker as its phase completes — parsing it in
`RunnerCallbacks.onPhaseEnd` (`src/engine/fix-markers.ts` for the
grammar, `fix-harvest.ts` for the write) onto the run's
`scratch.fixMarkers`, where the next dispatch reads it back (see
[State](/spec/10-state) and the
[dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate)). Three
properties matter. The parser splits each value at the **next known
key**, not at the next space, because `cause=` is a sentence that may
contain `=`; an unrecognised `class=` / `outcome=` / `gate=` value stays
`null` rather than being coerced to the nearest legal one; and nothing
in the parse can throw, because the input is agent prose and a failed
harvest must never fail the phase that produced it. Each harvested
attempt is rendered as **one bounded line** —
`attempt 2: class=env-mismatch cause=… | outcome=pushed gate=green` —
and the accumulated lines are what `{{priorAttempts}}` renders, so
attempt 3 knows what was tried and what was ruled out without replaying
two agent sessions.

| File | Purpose | Writes |
|---|---|---|
| `diagnose-ci.md` | Shared by both fix workflows. Read the CI report (pulling a full job log only when an excerpt is inconclusive), read `.github/workflows/*.yml`, name the differences between CI and this sandbox, reproduce the exact failing command, and classify into exactly one of the `fixing` skill's five classes. **Changes nothing** — no edits, commits, pushes, labels or comments; the repair is the fix phase's job, and only if the verdict says one is worth attempting. Renders `{{ciSection}}`, `{{baseChecksState}}`, `{{reason}}`, `{{attempt}}`/`{{maxAttempts}}` and `{{priorAttempts}}` (the earlier attempts' marker lines). | Nothing — verdict + `DIAGNOSIS_COMPLETE` marker only (`output_var: diagnosis`) |
| `pr-fix.md` | Read maintainer comment + CI section + the diagnosis, fix issues, run guardrails, push. Signs off with `CI_FIX_COMPLETE`. | Commits on PR branch |
| `dependabot-ci-fix.md` | Fix-only: first merge the base branch into a dependency-update PR that can't merge on its own (plain, no force-push — so a `behind` PR is made current, a `dirty` conflict is resolved by regenerating the lockfile), then make the smallest fix (lockfile / call-site / type) if CI is red, run the gate, and push. It does **not** classify or merge — once the push turns checks green the `pr.checks_passed` webhook hands off to `dependabot-pr-merge` (the single owner of the classify → label → auto-merge decision). If it can't land the PR — a fix it can't complete, **or** a `blocked` PR with nothing to push that it can't unblock (e.g. awaiting a required human review) — it stops and applies the `requires-human` label. The label is the *notification*; what actually stops a re-attempt is the escalation record on the run (`escalatedAtSha`), which the [dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate) reads on every route — so a maintainer's push re-arms the PR with no label to remove, and the sweeps need no filter of their own. **Triggered by the `pr.checks_failed` webhook, or by the daily `fix-red-dependency-prs` cron whose runner finds Dependabot / Renovate PRs that are settled-red **or** `behind`/`dirty`/`blocked` in code (`src/cron/dependabot-discovery.ts`) and fans out one bounded run per PR (carrying the `{{reason}}`).** Runs only when the preceding `diagnose` verdict says a repair is worth attempting, and signs off with a `CI_FIX_COMPLETE` marker. | Commits on PR branch / labels (give-up only) |
| `dependabot-pr-merge.md` | For an **already-green** dependency PR (no fix needed): inspect via `github_list_pull_request_files` (file list + line counts, no checkout), **skipping lockfile diffs** — only pull `github_get_pull_request_diff` for a small non-lockfile source change — classify trivial vs functional, and enable auto-merge on the trivial ones — falling back to a direct squash merge only when GitHub refuses auto-merge because the PR is already mergeable with no checks to wait on ("clean status"), and to a maintainer comment when the repo disallows auto-merge outright. **The merge gate is the code-computed check state, not `mergeable_state`** — the prompt renders `{{checksState}}` / `{{settledCheckCount}}` against `dependencies.{requireSettledChecks,minSettledChecks}` and applies it to *both* mechanisms, because auto-merge is a merge (on a repo with no required checks it lands an already-mergeable PR immediately, so it is not the safe path it was credited as being — 09 → D10). `mergeable_state` survives only for branch hygiene and for choosing the mechanism. For a PR that is `behind`/`dirty` it never rebases or pushes itself — it asks the bot that opened the PR to update its own branch (`@dependabot rebase`/`recreate` via `github_add_issue_comment`, or Renovate's `rebase` label via `github_add_labels`). **That branch request is independent of the verdict:** regenerating a bot's own branch merges nothing and pre-empts no review, so a FUNCTIONAL bump gets it too — it just doesn't also get auto-merge, which stays trivial-only (issue #245). A trivial PR gets both, so GitHub lands it once the re-run checks go green. **A MAJOR bump branches into the `dependency-impact` rubric** rather than being FUNCTIONAL by definition: `low` / `medium` / `high` judged from evidence with no checkout, auto-merged when at or below `{{dependencies.autoMergeMaxImpact}}`, with one audit comment recording the tier and the evidence when `{{dependencies.auditComment}}` (issue #252). Records the verdict as a label — `dependency-trivial` (clearing any stale `requires-human`) or `dependency-functional` + `requires-human` — plus, for a major, exactly one of `dependency-major-low` / `-medium` / `-high`, clearing the other two. Signs off with an `ASSESSMENT_COMPLETE` marker (`on_output.requires_marker`) carrying `verdict=`, `impact=` and `action=`, so a silent no-op run fails instead of passing green. **Always single-PR:** triggered by the `pr.checks_passed` webhook, or by the daily cron whose runner finds green Dependabot / Renovate PRs in code (`src/cron/dependabot-discovery.ts`) and fans out one bounded run per PR (retiring the old `mode: scan` whole-repo sweep, which overflowed the model context on busy repos). | Enables auto-merge / requests a rebase / posts a comment / labels |

### Explore (Socratic + publish)

| File | Purpose | Output marker | Writes |
|---|---|---|---|
| `explore-read.md` | Clone if needed, read issue + codebase, produce baseline. | None | `{{issueDir}}/explore-context.md` (linked via `{{artifactUrl explore-context.md}}`, mode-gated on `externalizeArtifacts`: dashboard Assets view in server mode, local-path note in repo mode) |
| `explore-ask.md` | Socratic loop iteration `{{iteration}}/{{maxIterations}}`. Reads baseline + `{{scratch.socratic.qa}}`, asks clarifying questions or signals `READY`. | `READY` on its own line ends the loop. | None (Q&A merged into scratch on gate pause) |
| `explore-synthesize.md` | Write the spec from baseline + full Q&A. | None | `{{issueDir}}/explore-spec.md` |
| `explore-publish.md` | Comment on issue (GitHub-scoped) or open a new issue (Slack-scoped). | None | GitHub comment or issue |

## Handoff folder

Phases coordinate through the git branch and `.lastlight/issue-<N>/`,
not through in-memory state. By convention:

```
.lastlight/issue-42/
├── guardrails-report.md   ← test / lint / typecheck the repo uses
├── architect-plan.md      ← problem, files to modify, test strategy
├── status.md              ← YAML — current_phase, reviewer_status, loop counters
├── executor-summary.md    ← files changed, test output, deviations (appended per fix)
└── reviewer-verdict.md    ← VERDICT line + issues (appended per re-review)
```

`issueDir` is set in `simple.ts` based on the run scope; every
prompt hardcodes paths under `{{issueDir}}/`. The runner never reads
or writes these files — the prompts manage the lifecycle. Each prompt
commits its outputs before exiting; the next phase clones the branch
and reads what it needs.

**Server mode (`buildAssets.location = server`).** When externalized, the docs
are **not** committed into the target repo. Instead the executor stages the
server store's copy into the workspace before each phase and harvests changes
back afterwards (`stageArtifactsIn`/`harvestArtifactsOut`,
`src/engine/agent-executor.ts`). For **pre-cloned** workflows on a
whole-workspace backend (docker/none/smol) the staged dir is the **workspace
root** — a sibling of the checkout — and `{{issueDir}}` becomes
`../.lastlight/<issueKey>`, so the docs live entirely outside the repo tree and
the agent's `git add -A` can never sweep them into the feature commit
(`buildAssetsRelocated`). gondolin mounts only cwd, so there the dir stays the
in-repo `.lastlight/<issueKey>/` and is added to `.git/info/exclude` as a
backstop. Either way each prompt also gates its
`git add .lastlight/ && commit` behind `{{#if !externalizeArtifacts}}` (the
inverse flag defaults absent⇒repo so any un-tagged render still commits), and
the executor's `git add -A` unstages `.lastlight` before committing in server
mode as belt-and-suspenders for the gondolin (in-repo) path.
PR-body links use `{{artifactUrl}}`, which resolves to the dashboard's
Artifacts view rather than a GitHub blob URL. The browser-QA prompts instead use
`{{artifactBaseUrl}}` — the unauthenticated, image-only public base
(`<publicUrl>/admin/api/public/artifacts/<owner>/<repo>/<issueKey>`, empty when
no `PUBLIC_URL`) — to embed each screenshot inline (`![cap]({{artifactBaseUrl}}/<name>.png)`)
so it renders directly in the GitHub comment. The store and the cross-phase
handoff are otherwise unchanged — the branch is just no longer the carrier.

**Single-comment delivery (`status_checklist` + `final_message`).** A workflow
can render its progress as one in-place "task list" comment (`status_checklist:
true`, driving `src/notify/`) instead of a comment per phase, and end with one
synthesized result via the workflow-level `final_message` template: rendered at
wrap-up against the accumulated `output_var`s and delivered once — set as the
checklist comment's **footer** when the checklist is active, else posted as a
single standalone comment. `verify`/`qa-test` use this: their text and gated
browser passes write short progress lines into the checklist and stash their
full reports in `output_var`s; a terminal `synthesize` phase (which depends only
on the always-run text phase, so it still runs when the browser phase is gated
out) folds them into one verdict that `final_message` drops into the footer.

## Prompt vs skill — when to pick which

They serve different purposes and can coexist on the same phase:

- **`prompt: prompts/<file>.md`** — a template tied to this workflow,
  rendered against the variable context as the user prompt. Use for
  multi-phase workflows with workflow-specific shared state
  (`build`, `explore`, `pr-fix`).
- **`skills: [<name>, …]`** (or sugar `skill: <name>`) — registers a
  [Skill](/spec/08-skills) catalogue with the agent via filesystem
  staging. The agent sees each skill's name + description in the
  system prompt's XML `<available_skills>` block and pulls the full
  SKILL.md on demand via its `read` tool — pi's
  [progressive-disclosure model](https://pi.dev/docs/latest/skills).
  Use for reusable behaviour (`pr-review` is invoked by webhooks,
  cron, and chat).
- **Both** — the prompt template is the user prompt; the skills are
  staged alongside. The template can reference skills by name ("see
  the `pr-review` skill for the structured-feedback format") and the
  agent loads them when relevant. Useful when the workflow has
  prompt-specific orchestration but leans on a reusable skill for
  the substantive instructions.

When `prompt:` is absent and only `skills:` is set, the runner emits
a short auto-generated user prompt nudging the agent to read the
primary (first-listed) skill. Skill content is *never* pasted into
the user prompt — it always reaches the agent via the staged
filesystem + `read` tool path.

## Invariants

- **`issueDir` is a convention, not a guarantee.** The runner does not
  validate that any prompt writes to it. Prompts that ignore the
  convention will break the handoff.
- **`fixCycle` is 0-indexed.** The first reviewer pass sees
  `fixCycle: undefined`; fix cycle 1 sees `fixCycle: 0`. Prompts that
  display `{{fixCycle}}` should be aware.
- **The verdict marker is matched on the *first* matching line.** A
  reviewer prompt that says "the previous verdict was APPROVED" early
  in its output and `VERDICT: REQUEST_CHANGES` later will be misread.
  Reviewer prompts are written to produce the marker first.
- **`{{#if}}` blocks do not nest.** The regex is lazy to the *first*
  `{{/if}}` (`templates.ts:8`), so an inner conditional's closing tag
  terminates the outer block and the outer block's tail leaks into the
  prompt as raw mustache — silently, since nothing validates a rendered
  prompt. Write sibling conditionals instead; the fix prompts' nested
  ones were flattened for exactly this reason.
- **`class=` is a parsed token, not prose.** The `fix` phase's `skip_if`
  substring-matches `class=flaky` (and the other two stopping classes)
  anywhere in the diagnosis output, so a "this is not `class=flaky`
  because…" aside changes what the workflow does. The `fixing` skill
  therefore tells the agent to write the token *only* on its marker
  line. Any future marker field that a guard reads inherits the same
  constraint.
- **Skill content reaches the agent via the `read` tool, not the
  prompt.** The runner never embeds SKILL.md text in either the user
  prompt or the system prompt. Only name + description appear in the
  system-prompt XML catalogue; the body is loaded on demand. Skill
  files are *not* template-rendered — `{{varName}}` inside a SKILL.md
  reaches the agent verbatim, so skills should not depend on
  workflow-context substitution.
- **`output_var` collisions silently overwrite.** If two phases declare
  `output_var: result`, the second wins. Names are unprotected.
- **Frontmatter `name` and `description` are mandatory on skills.**
  pi-coding-agent's loader silently drops SKILL.md files that omit
  either, which would surface as "no skills appeared in the catalogue"
  with no error. Audit on add.
- **Phase-rendered shell commands are sanity-checked.** `until_bash` and
  `type: bash` commands are rejected if they contain unrendered `{{}}` markers
  after template rendering (`validateShellCommand`) — a defence against
  template injection.

## Current implementation

| Piece | File |
|---|---|
| Template engine | `src/workflows/templates.ts` |
| `buildPhasePrompt`, render pipeline | `src/workflows/runner.ts` |
| `phaseConfigFor` (resolves skills onto ExecutorConfig) | `src/workflows/runner.ts` |
| Prompt templates | `workflows/prompts/*.md` |
| Skill name validation + path resolution | `src/workflows/loader.ts` (`resolveSkillPaths`) |
| Per-phase skill bundle staging | `src/engine/agent-executor.ts` (`stageSkillBundle`) |
| Variable context assembly | `src/workflows/simple.ts` |

## Rebuild notes

- **Pick one templating language and stick with it.** The mix of
  `{{var}}` Mustache-ish syntax plus `${X.output}` interpolation is
  workable but easy to mis-quote. A re-implementation might unify on
  a single syntax — just make sure the migration is total.
- **Make the truthy rules explicit.** `{{#if x}}` truthiness includes
  non-empty string, non-zero number, non-empty array, `true`. Other
  template engines bias differently. Document or test the choice.
- **Treat the prompt files as code.** They're versioned, reviewable,
  and the wire-format between agents. Changes to a prompt are
  behaviour changes; treat them with the same care as code.
- **Don't move the handoff folder into the DB.** The convention of
  committing `architect-plan.md` etc. to the branch is what lets the
  reviewer see exactly what the executor agreed to do. Reading those
  from SQLite would still work, but it would lose the audit trail and
  the human-readable history on the PR.
- **Verdict markers are an interface contract.** Prompts produce them;
  the runner parses them. Both sides should agree before either side
  ships. If you change the marker format, update both at once.
- **Progressive disclosure scales linearly.** Because only name +
  description reach the system prompt, a phase with five skills costs
  the agent about the same context budget as a phase with one. The
  agent only pays the read cost for skills it actually loads. A
  re-implementation that pastes skill bodies into the prompt (the
  legacy approach) will block multi-skill phases on context budget.
- **Workflow-context variables belong in the prompt, not the skill.**
  Skills are static — they don't get template-rendered. If a phase
  needs to thread `{{issueNumber}}` etc., put that in the `prompt:`
  template and let the agent combine it with the skill's instructions
  on its own.
