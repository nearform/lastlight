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
| `guardrails.md` | Pre-flight (agent) — install, typecheck, lint, and write `.git/lastlight-gate.sh` holding the repo's **full** test command. Skips if `{{issueDir}}/status.md` already says READY. Does not judge the suite. | First line `READY` or `BLOCKED` (matched by `on_output: contains_BLOCKED/READY`) | `{{issueDir}}/guardrails-report.md`, `{{issueDir}}/status.md`, `.git/lastlight-gate.sh` |
| *(no prompt)* `guardrails_gate` | Harness-run `type: bash` phase, no LLM: runs `.git/lastlight-gate.sh` once under `timeout {{gate.timeoutSeconds}}`. Exit 0 → READY; non-zero → BLOCKED with the log tail; timeout → BLOCKED "full test suite did not finish within gate.timeoutSeconds — raise it". READY requires the FULL suite to pass; a subset run is never evidence. Phase budget `gate.phaseTimeoutSeconds`. | `READY` / `BLOCKED` | — |
| `architect.md` | Read codebase + guardrails report → produce implementation plan with `file:line` evidence. Approval gate: `post_architect`. | None — deterministic structure | `{{issueDir}}/architect-plan.md`, `{{issueDir}}/status.md` |
| `executor.md` | Implement per plan, TDD; targeted tests + typecheck/lint/build, then the full suite **once** at `gate.timeoutSeconds`, judged by exit code (a timeout is reported, not retried). Phase budget `gate.phaseTimeoutSeconds`. Commit. | None | `{{issueDir}}/executor-summary.md`, `{{issueDir}}/status.md` |
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
fixed here* — including the gate script's content contract below;
`building` owns *install and run the commands*. See
[Skills](/spec/08-skills).

**The gate is a targeted reproduction, not a CI clone.** All three
surfaces that instruct it — `skills/fixing/SKILL.md` ("The gate"), and
step 2 / step 3 of `prompts/pr-fix.md` / `prompts/dependabot-ci-fix.md` —
ask for the *narrowest* command that would have failed before the fix and
passes after it: one test file, one lint rule, one build target, one
install, under two minutes. Four exclusions are explicit: the whole suite
(CI runs it on the pushed commit and is the authority), a check already
watched passing in the same session, anything that starts a service
(there is no docker in the sandbox, so a `command -v docker` guard is dead
code — a check that needs one is `infra-dependent`), and anything that
mutates git state (the harness re-runs the script). The failure this
closes: a `dirty` PR whose whole repair was a regenerated lockfile got a
verbatim copy of the repo's CI pipeline — five builds, two test suites,
eleven minutes, three unreachable service branches — and real CI went
green before the local gate finished. A weak gate costs a wasted attempt
and never a bad merge (`fix-harvest.ts`), which is exactly why breadth
belongs to CI and not here. **A repair with nothing to reproduce still
writes a gate** — the coherence check the repair implies (no conflict
marker left, the lockfile installs), or an honest one-line `exit 0`
stating why there was nothing to verify. Leaving it unwritten is the
worse option, not the modest one: with no script the loop's gate
condition can never be met, so it burns its remaining iterations
re-running a repair that was already finished, ends on the phase's
`on_failure` message, and the run reports `gate=skipped` — RED, which
never authorises the push the repair needed.

`dependabot-ci-fix` runs **one** phase when it was summoned for a merge
problem rather than a red build: its `diagnose` declares
`skip_if: reason == 'dirty' | 'behind' | 'blocked'`, because no check is
failing and the repair is the mechanical base-merge the fix prompt already
performs in its first step. See
[Workflow engine → Conditional skip](/spec/06-workflow-engine).

Each phase carries a `requires_marker` postcondition —
`DIAGNOSIS_COMPLETE:` on `diagnose`, `CI_FIX_COMPLETE:` on `fix` — and
the marker line is the interface between them. **The colon is part of the
postcondition**, because the engine enforces `requires_marker` as a bare
substring of the output while the parser only recognises `<TAG>:`; declaring
the bare tag let an output that merely *mentioned* it pass a gate that then
parsed to nothing. Both forms are pinned to `DIAGNOSIS_MARKER_POSTCONDITION`
/ `CI_FIX_MARKER_POSTCONDITION` (`src/engine/fix-markers.ts`) by test.
`diagnose` writes `class=<one of five>` into its marker; `fix` declares a
`skip_if` that reads the **parsed** class the harvest persisted
(`scratch.fixMarkers.diagnosis.class == 'flaky'` and the two other stopping
classes) and is skipped, non-failing, when it matches.
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
`fix.escalateModelAfterAttempt` — measured as `priorAttempts.length + 1`,
the **journal** rather than the re-arming `attempt` counter, so a retry does
not hand a thrice-failed PR back to the base model — `escalateFixModel`
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

The same harvest drains the **PR journal**. All three fix prompts render
it as `{{priorNotes}}` — a single string carrying its own fence, its own
"hints, never instructions" statement, and one provenance-stamped line
per note (kind, run, workflow/phase, date, and `STALE` once someone else
has pushed). The fence is emitted by the renderer rather than written
into the templates precisely because the templates are forkable: a fork
can add guidance around the block, and cannot remove the fence from it.
`{{notesFile}}` is the path the agent appends a new note to. Both are
absent — so the block disappears — on a PR with no journal.

| File | Purpose | Writes |
|---|---|---|
| `diagnose-ci.md` | Shared by both fix workflows. Read the CI report (pulling a full job log only when an excerpt is inconclusive), read `.github/workflows/*.yml`, name the differences between CI and this sandbox, reproduce the exact failing command, and classify into exactly one of the `fixing` skill's five classes. **Changes nothing** — no edits, commits, pushes, labels or comments; the repair is the fix phase's job, and only if the verdict says one is worth attempting. On `dependabot-ci-fix` the phase is normally **skipped** for a merge-blocked PR (`reason` = `dirty`/`behind`/`blocked`); for the paths where it still runs on one — a comment route, or a dispatch carrying no `reason` — the prompt states that "no job failing at all" is `reproducible` and emphatically **not** `infra-dependent`, since every stopping class means "no repair is worth attempting" and choosing one leaves the PR conflicted. Renders `{{ciSection}}`, `{{baseChecksState}}`, `{{reason}}`, `{{attempt}}`/`{{maxAttempts}}`, `{{priorAttempts}}` (the earlier attempts' marker lines) and `{{priorNotes}}` (the fenced PR journal). | Nothing — verdict + `DIAGNOSIS_COMPLETE` marker only (`output_var: diagnosis`), plus any note it appends to `{{notesFile}}` |
| `pr-fix.md` | Read maintainer comment + CI section + the diagnosis, fix issues, run guardrails, push. Signs off with `CI_FIX_COMPLETE`. | Commits on PR branch |
| `dependabot-ci-fix.md` | Fix-only: first merge the base branch into a dependency-update PR that can't merge on its own (`git fetch origin <base>` then `git merge --no-edit FETCH_HEAD` — **`FETCH_HEAD`, never `origin/<base>`**, because in a shallow single-branch clone that remote-tracking ref may not have moved and merging it silently lands a superseded base; plain, no force-push — so a `behind` PR is made current, a `dirty` conflict is resolved by regenerating the lockfile), then make the smallest fix (lockfile / call-site / type) if CI is red, run the gate, and push. It does **not** classify or merge — once the push turns checks green the `pr.checks_passed` webhook hands off to `dependabot-pr-merge` (the single owner of the classify → label → auto-merge decision). If it can't land the PR — a fix it can't complete, **or** a `blocked` PR with nothing to push that it can't unblock (e.g. awaiting a required human review) — it stops and applies the `requires-human` label. The label is the *notification* and is read by nothing (the prompt says so, and tells the agent never to touch `lastlight-ignore`, the hold a maintainer applies); what actually stops a re-attempt is the escalation record on the run (`escalatedAtSha`), which the [dispatch gate](/spec/05-router#the-pr-scoped-dispatch-gate) reads on every route — so a maintainer's push re-arms the PR with no label to remove, and the sweeps need no filter of their own. **For bot-owned branches (`dependabot/*` / `renovate/*`) the workflow drives the bot by PR primitive, never by push** (issue #442) — Dependabot/Renovate own those heads and a non-bot commit makes the bot abandon the PR on its next sync with a comment about the branch being "edited by someone other than the bot". The interceptor is **bot-family aware** because the two vendors have different update primitives: **Dependabot** parses `@dependabot …` slash commands, so the prompt routes to a bare `github_add_issue_comment` per reason — `@dependabot rebase` for `behind`, `@dependabot recreate` for `dirty` / `checks-failing`, and the `requires-human` path for `blocked`; **Renovate does NOT parse `@dependabot` and ignores those comments entirely**, so the prompt routes Renovate to the `rebase` label via `github_add_labels` (the same one `dependabot-pr-merge` already uses on green-then-blocked Renovate PRs, and Renovate's [own docs at `…/updating-rebasing/#manual-rebasing`](https://docs.renovatebot.com/updating-rebasing/) name as the documented Manual-rebase trigger) for **`behind` / `dirty` / `checks-failing`**, plus a brief comment so a maintainer notices if nothing happens. The rebase label works because the docs explicitly call out three cases where it is the right call ("a branch behind base", "discard the edits and have Renovate create it again", "a branch that was created with an error (e.g. lockfile generation) and you want Renovate to try again") and Renovate regenerates on its next sync regardless of edits. **`blocked` is the only reason the intercept ends at `requires-human`** — a required-review gate is not something a rebase label can clear. The interceptor also writes a one-line `exit 0` to `{{verifyScript}}` BEFORE the comment, so the fix phase's `generic_loop.until_bash` is green on the first iteration and the loop closes cleanly — a missing script was `gate=skipped` (RED) and re-rendered the prompt, posting the same bot nudge a second time before the loop exited `failed`. `github_publish` AND `github_create_or_update_file` are **hard-blocked** for these prefixes at the tool level (the latter as defence in depth: `dependabot-ci-fix` runs under `repo-write` and `REPO_WRITE_TOOLS` includes both tools), with a per-family error message that names the right primitive — Dependabot gets `github_add_issue_comment` + the `@dependabot` commands, Renovate gets `github_add_labels` + the `rebase` label. **The label name is resolved at run time from the repo's Renovate config** (`jq -r '.rebaseLabel // empty' renovate.json` against `renovate.json`, `.renovaterc.json`, `.github/renovate.json`, and `.github/.renovaterc.json`; literal `rebase` when the field is missing, JSON5 configs isn't `jq`-parseable so the agent defaults and calls out the wiring in the comment) so a `rebaseLabel: "rebase-now"` repo gets the configured name and an unmodified repo keeps its prior default. **Reachability scope:** the bot-family routing fires inside the fix phase, which the **`diagnose` `skip_if` rows already trim to the verdict classes that are worth repairing** (`flaky` / `infra-dependent` / `upstream-broken` short-circuit at the cost-of-repair boundary, not here). The bot-prefix gate is also literal: the prefix is what makes the bot the lifecycle owner, not the PR author — a maintainer's hand-written patch on top of a `dependabot/*` branch still gets the same treatment. It also renders `{{settledCheckCount}}` beside `{{checksState}}`, with the instruction to read a suspiciously low count as *unknown* rather than green: GitHub builds no `pull_request` workflow for a `dirty` PR, so the one thing still reporting is whatever commit-status app keys off the push. **Triggered by the `pr.checks_failed` webhook, or by the daily `fix-red-dependency-prs` cron whose runner finds Dependabot / Renovate PRs that are settled-red **or** `behind`/`dirty`/`blocked` in code (`src/cron/dependabot-discovery.ts`) and fans out one bounded run per PR (carrying the `{{reason}}`).** Runs only when the preceding `diagnose` verdict says a repair is worth attempting, and signs off with a `CI_FIX_COMPLETE` marker. | Comments on bot-owned branches (one per PR, per the bot's primitive) / commits on PR branch (non-bot-owned) / labels (give-up only) |
### Explore (Socratic + publish)

| File | Purpose | Output marker | Writes |
|---|---|---|---|
| `explore-read.md` | Clone if needed, read issue + codebase, produce baseline. | None | `{{issueDir}}/explore-context.md` (linked via `{{artifactUrl explore-context.md}}`, mode-gated on `externalizeArtifacts`: dashboard Assets view in server mode, local-path note in repo mode) |
| `explore-ask.md` | Socratic loop iteration `{{iteration}}/{{maxIterations}}`. Reads baseline + `{{scratch.socratic.qa}}`, asks clarifying questions or signals `READY`. | `READY` on its own line ends the loop. | None (Q&A merged into scratch on gate pause) |
| `explore-synthesize.md` | Write the spec from baseline + full Q&A. | None | `{{issueDir}}/explore-spec.md` |
| `explore-publish.md` | Comment on issue (GitHub-scoped) or open a new issue (Slack-scoped). | None | GitHub comment or issue |

### PR review (evidence pipeline)

The prompts `pr-review.yaml` runs when `review.analysis.enabled` is on, plus
`review-triage.md`, which is gated separately and runs on a re-review whatever
the pipeline is set to. All of the pipeline prompts coordinate through
`.lastlight/pr-review/` in the checkout; their exit gates are `lastlight-facts`
subcommands, not markers ([Workflow engine](/spec/06-workflow-engine) has the
phase wiring).

| File | Purpose | Exit gate | Writes |
|---|---|---|---|
| `review-triage.md` | **How much review is this push owed?** — not a review (issue #378). Runs only on a re-review (`reviewIsRereview`), only where `review.triage.enabled`, and **never with `review.analysis` on** (`skip_if: analysisEnabled == true`, issue #429): a light run is one unbounded pass with no ledger and no gate, and the pipeline scopes a re-review in code instead — a small push is a few changed units, so few sites, and a push that changed nothing the last review had plans no site at all. Reads `git diff <prior reviewed SHA>...HEAD` in the pre-cloned checkout and answers with one `REVIEW_DEPTH: full \| light` line. `light` is earned only by a small, localised, self-contained delta that is not an answer to something the prior review flagged; **uncertainty is a `full` answer**, as are an unrecognised value and no marker at all. | None — deliberately no `on_output.requires_marker`, since a red run would post `messages.on_failure` and offer a Retry that cannot succeed | `scratch.reviewTriage` (via the `onPhaseEnd` harvest, `src/engine/review-triage.ts`) |
| `review.md` | **Two-mode**, chosen by `scratch.reviewTriage` rather than by `analysisEnabled` — the template engine has no `else` and no nesting, so the choice is two mutually exclusive keys, `baseline` seeded at run start and `light` written over it by the triage harvest. `baseline`: one line handing the run to the `pr-review` skill — the whole review when the pipeline is off. `light`: a single focused pass over the delta since the prior review, naming its SHA and verdict, reporting only a new defect, a flagged point the delta claims to fix but does not, and one it genuinely fixed. Always writes `findings.json`, empty `findings` included. **With the pipeline on, the phase is skipped** (`site-finalize` writes `findings.json`) — `runner.ts` seeds `scratch.reviewTriage.skipReview` and the phase's `skip_if` reads it; a `light` run always runs it (the light harvest replaces the namespace and drops the flag). | None | `.lastlight/pr-review/findings.json`, when it runs |
| `survey-unit.md` | The unit survey's **system prompt** of every call in the in-process `survey-units` phase, sent byte-identical on each (the handler appends `units.json`'s `sharedPrefix`; the unit's pre-rendered request is the user message). Deliberately free of template variables — its sha256 is part of the unit reply-cache key. Carries only what does not vary per unit: answer every listed obligation exactly once with the model's own verdict sentence as the `claim` (never the obligation restated) and a non-null `consequence` whenever no shown control holds (`control_site: "none"`, or an advisory/bypassable control), record every defect it can see that a changed line causes or makes reachable — breadth, not a bar (units-v7): later stages can remove a risk but never recover one not written down, doubt is not a reason to omit one, only the request's NOT FINDINGS categories stay out (pre-existing issues the change does not make wrong, compiler/linter catches, restating the change, deliberately silenced points, generated files, "never validated" with no misbehaving consumer, a test's own assertions/wording, inventing unseen code), no count prior and no cap, and a defect that needs a future edit is labelled `trigger: "code_change"` (measured: v1's breadth credited 11/50 gold, and 0 of its 320 `code_change` defects; v4–v6's DEFECT BAR cut credited gold to 6, 3, then 5–6), answer only the one family a large unit's request names (units over 40 changed lines are surveyed once per family, ids `u-NNN-<family>`), fill the evidence record with facts rather than verdicts (verbatim `control_text`, `line` only from a shown tag), and reply with exactly one JSON object naming the request's `unitId`. The questions, evidence field list and response shape live in the request `lastlight-facts units` renders. | `lastlight-facts units-ingest` (validates each reply; an unparsable reply or wrong `unitId` is discarded and its obligations recorded unanswered; an entry naming no holding control with a null consequence is kept as written and listed in `units/ingest.json`'s `consequenceGaps`; an UNPROMPTED defect with `evidence.trigger: "code_change"` is demoted — kept out of `hypotheses/`, recorded in full in the unit's `demoted` list with a document-level `demotedCount` — while an obligation's answer is never demoted, whatever its trigger), then each family's `discharge` — reported, never failed on | `.lastlight/pr-review/units/responses/<unitId>.json`, ingested into `hypotheses/<family>.jsonl` |
| *(no prompt — `type: bash`)* `probe-plan` | **Kept but not attached** — skips on `falsifyAttached != true`, which nothing projects, until falsify is wired into the sites engine (docs/plans/pr-review-units-sites.md, stage 5). **Which hypotheses `falsify` owes a verdict on — decided in code, not by the oracle.** `lastlight-facts probe-plan` derives the owed set with the same `requiresProbe` rule as the `probes` gate (a derived-Critical severity, or a raw `needsProbe: true`), ranks it (Critical first, then a survey's own ask, then discharge `ABSENT` > `PARTIAL` > `QUOTE`, then declaration order — evidence record only, never claim prose) and caps it at `review.analysis.maxProbes` (default `8`, `null` = no cap). Rows past the cap are **deferred**, not dropped. Exists because the falsify prompt keyed on a literal `"severity": "Critical"` field that a unit-survey row never carries (severity is derived): measured 2026-09-27, the gate owed 21 rows on one case and falsify wrote 1 verdict. Waits on `units-ingest` with `all_done`; `--never-fail`, so a failure costs the cap, never a probe — with no plan on disk the gate and the prompt fall back to the pre-plan owed set. | None (`--never-fail`) | `.lastlight/pr-review/probes/plan.json` (the gate's owed list) + `probes/plan.md` (the selected records falsify reads) |
| `review-falsify.md` | **Kept but not attached** (as `probe-plan`). The oracle: settle hypotheses by **running code**. Four verdicts, strongest first — `reproduced` (the scenario was **executed**) / `corroborated` (a **read** — grep, file view, facts query — that supports a claim without executing it; weaker, and read downstream as weaker) / `refuted` / `unprobed` — and **only a transcript may refute**; silence is never a refutation. A claim is **behavioural** when its evidence record states a `consequence` live at head (`isBehaviouralClaim`, derived, never asked for); a read settles a *structural* claim, but `reproduced` on a behavioural one whose every command only reads code (`grep`/`rg`/`cat`/`sed -n`/a facts query, quote-aware) is a `read-not-reproduction` gap the loop iterates on — relabel `corroborated` or run something (issue #405: on one case 4 of 13 `reproduced` were greps). A script written for another hypothesis counts only if its transcript shows *this* hypothesis's scenario; the gate reports such borrowed transcripts (`borrowedFrom`) without failing on them. **Reading the code is not a probe, and that is machine-checked**: a `reproduced`/`corroborated`/`refuted` verdict must name a `command` its transcript's first non-blank line echoes, or `lastlight-facts probes` reports an `unexecuted` gap and the loop iterates (first real run: 9 verdicts, 9 `reproduced`, every one `"command": "code inspection"` over prose, zero executed commands). `unprobed` stays free of that bar — it is the honest answer. Its model is `models.review-falsify`, falling through to `models.review-survey` via an explicit `{{#if}}` pair. Probing follows a cost-ordered ladder, every tier zero-install: a differential `git` probe, an isolated pure function under plain `node`, a binary already on disk, then a scoped `lastlight-facts` re-query; anything above that is `unprobed` with the reason. Gated on `probesEnabled` (`review.analysis.probes`, off by default) like `prepare` — but `probes: static` reaches BOTH phases without installing anything, so the oracle no longer costs an install. Bounded by `falsifyTimeoutSeconds` across every round. Reads `probes/plan.md` (from `probe-plan`, which it `depends_on`) rather than every hypothesis file, and the `probes` gate owes exactly that plan's `selected` list — falling back to `requiresProbe` over every row only when no plan exists. | `lastlight-facts probes` | `.lastlight/pr-review/probes/` (`verdicts.jsonl` + transcripts) |
| *(no prompt — `type: bash`)* `site-plan` | **The `sites` review engine** (`docs/plans/pr-review-units-sites.md`). The hypothesis rows are not the items the review weighs but a VOLUME signal: `lastlight-facts sites --plan` clusters them into sites (distinct-unit votes, window 20, span ≤ 60, test-file sites ranked after every other site — never claim prose; at a fixed cap, ranking tests with the rest displaced better sites, while skipping them left slots empty and lost the test-code gold) and writes `sites/plan.json`, one brief per slot, and `sites/branches.json` — the manifest `site-review` fans out over (`branches_from:`). There is one slot per site actually formed, up to `siteTop` (`--top`, `review.analysis.siteTop`, 5 by default): `site-001.md` …, and with `models.review-site-pair` set (`--pair`) a second slot per site, `site-001-b.md` …, re-briefing it for the second investigator. Each brief is the site (file, line range, rows/voters) and a "Your assignment" section: the site id, the one output file, and how many probed suspicions a `none` needs (1 on a site of ≤ 3 rows, else 2). There are no empty slots: a PR with two sites plans two. **On a re-review (issue #429)** the rows of units whose `delta` is `unchanged` — the last review had that exact code, and nothing it calls or is called by changed (`units --prior`, against `prior-review.json` which the `units` phase writes from `{{priorReviewJson}}`) — are **carried**: they form no site and are counted in `plan.json`; a push that changed nothing the last review had plans no slot, the fan-out is a no-op, `merge` pools nothing and `select` is skipped. Each site's vote is weighed by the highest risk tier among its units (low 0.5, medium 1, high 1.5, critical 2; `units --risk-rules` from `{{riskRulesJson}}`). Depends on `units-ingest`, `all_done`, `--never-fail` | — | `sites/plan.json`, `sites/branches.json`, `sites/<site-id>.md` |
| `review-site.md` | One investigator per slot of the dynamic `site-review` fan-out (`branches_from: sites/branches.json`, `max: 16`; model `models.review-site`, else `models.review-survey`; the `-b` pair slots on `models.review-site-pair`); also the evals `micro-site-review` replay's prompt. **Slot-generic** — the prompt is shared with the replay, so the brief attached via `context_file` names the site id, output file and `none` bar. Under `{{#if prIntent}}` it reads the PR's title, body and closed issues (`renderPrIntent`, template comments stripped, bounded) framed as the author's **claim** to check — code that does not do what the description promises is a defect, and the description never closes a suspicion. Look at the one stretch of code, and write 1–3 **grounded** findings (real `path` + `line`, mechanism, consequence, `strength` reproduced / corroborated / read, and an `importance` of `must-fix` / `worth-mentioning` / `nit`), or a `none` whose checked suspicions were each answered by an EXECUTED probe (a copied function under `node`, a differential `git show`) — a `none` is earned, not asserted. Installs and the suite are blocked; never per-row verdicts. | `lastlight-facts sites --check <site-id>` per branch; `on_branch_gate_failure: { retries: 1 }` re-runs a failing branch once with the gate's gaps appended | `sites/<site-id>.findings.jsonl` |
| *(no prompt — `type: bash`)* `merge` | `lastlight-facts sites --merge` pools every slot's findings as `F1…Fn`, each with a code excerpt, and PROPOSES cross-site duplicate groups (same file, lines within ±10) — it cannot decide "same defect". Stdout is `output_var: siteMerge`, the select prompt's input; an empty pool prints `SITE_MERGE_EMPTY` as its first line, on which `select` skips (`startsWith` — an excerpt may quote the marker) | — | `sites/merged.json`, `sites/merged.md` |
| `review-select.md` | The **selection pass** — one agent call (`models.review-select`, else `models.review`; `generic_loop`, 2 iterations, `fresh_context`) over `{{phaseOutputs.siteMerge}}`. Merges only true duplicates (same faulty code, mechanism and fix — proximity groups are proposals), sets each item's importance (`must-fix` / `worth-mentioning` / `nit`; a `nit` is recorded, never posted; the investigator's importance is a starting point, often too high), and writes each comment's `title` / `body` / `fix` plus a review `summary`. Read-only commands only, to decide duplicates — no re-investigation. Under `{{#if priorDiscussion}}` it reads the PR's prior reviews, inline threads (with resolution) and comments (`renderPriorDiscussion`, one GraphQL read) and marks an item repeating an already-raised point `alreadyRaised` (who and where) — recorded, not posted; the discussion never drops or demotes a grounded finding. Under `{{#if priorLedger}}` (issue #429) it also reads the PR's review ledger: what our earlier reviews POSTED and is still open (a repeat gets `alreadyRaised`), and what they found but never posted (re-raising one is a choice, not a duplicate). `post-review` backs this with a deterministic check: a finding whose file + quoted code fingerprint matches an open ledger entry is withheld `already-raised`. **Every `F` id in exactly one item**: it may merge and demote, never drop. Skipped (`skip_if`) when `merge` pooled nothing — the only correct selection is empty and `--finalize` falls back to it. | `lastlight-facts sites --check-select` (conservation) | `sites/selected.json` |
| *(no prompt — `type: bash`)* `site-finalize` | `lastlight-facts sites --finalize` turns `selected.json` into the `findings.json` `post-review` reads: each item at its primary finding's path/line with that line's text as `existingCode` — or, when the investigator gave an optional `startLine` (≤ 12 lines ending at `line`), the whole range's text, which `post-review`'s anchor cascade posts as a multi-line comment, re-resolving as its single `anchorLine` (exactly as the range-less finding would) when the range does not fit inside one hunk — severity from importance (must-fix → Important, worth-mentioning → Minor, `nit` or `alreadyRaised` → tier `internal`), category `defect`, and every hypothesis row id in `internal[]` so `reconcile`'s conservation holds. **The re-review convergence gate** (issue #429) runs here, per LINE: a finding whose anchored lines were all already among the prior review's recorded lines for that file (`anchorDelta`) is a late discovery — filed `internal` with `withheld: "converged"` (reason `converged` in `disposition.json`, kept in the ledger) unless it is `must-fix` on a unit above `low` risk, which posts with a "Missed in an earlier review" label (`lateDiscovery: true`). It also writes `review-coverage.json` — per unit, surveyed (a survey call answered) and investigated (its rows sat in a site an investigator closed), with risk-weighted percentages and the in-scope units nobody investigated; `post-review` copies a compact form to the run's `scratch.reviewCoverage` for the dashboard's Review tab. A missing or invalid selection falls back to one item per pooled finding at the investigator's own importance, so a failed `select` still posts. **The event:** `APPROVE` when nothing posts, no **must-fix** was withheld `converged` (a withheld worth-mentioning finding is the gate's own choice not to post, so it does not block), and every primary site answered (`findings`, or a `none` whose checks closed) — a silent primary is an area nobody looked at; pair slots do not gate. Otherwise `COMMENT`. `post-review` adds the floor only GitHub can see. `reconcile` then depends on `site-finalize` | — | `findings.json` |

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
publishes its outputs before exiting; the next phase clones the branch
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
backstop. Either way each prompt also gates its artifact publish — a
`github_publish` scoped with `include: [".lastlight"]`, so one signed commit
carries the docs and nothing the phase's install or test run left behind —
behind `{{#if !externalizeArtifacts}}` (the inverse flag defaults absent⇒repo so
any un-tagged render still publishes them), and the executor's own whole-tree
publish passes `exclude: [".lastlight"]` in server mode as belt-and-suspenders
for the gondolin (in-repo) path.
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
  from the state database would still work, but it would lose the audit trail and
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
