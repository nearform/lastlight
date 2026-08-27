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
2. Stages each directory into a **per-phase bundle** at
   `<workspaceRoot>/.lastlight-skills/<phaseName>/<name>/` before the
   agent runs (symlink in `none`, copy in docker/gondolin — gondolin
   mounts only cwd, so a symlink's target would sit outside the mount
   and dangle in the guest). The bundle
   sits at the workspace root — a sibling of any checked-out repo, never
   inside its git tree — and is keyed per phase so concurrent phases in
   one workspace can't clobber each other's catalogue.
3. Maps the bundle to the agent explicitly via pi's `--skill`/`skillPaths`
   (rather than relying on `.agents/skills` auto-discovery, which only
   reads that one fixed name). pi extracts name/description from the
   frontmatter and emits the XML catalogue into the system prompt.

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

The **whole directory** is staged into the phase bundle — helper scripts
and references are visible at
`.lastlight-skills/<phase>/<name>/scripts/...` and runnable / readable by
the agent's bash and read tools.

## Skill loader

`resolveSkillPaths(names)` lives in `packages/shared/src/workflow-loader.ts`
(re-exported by `src/workflows/loader.ts`). It validates each name against
`/^[a-zA-Z0-9_-]+$/`, refuses a name in `disabled.skills`, and walks the **layer
stack in reverse** — last layer wins — returning the first
`<base>/<name>/SKILL.md` that exists, with an `isInside` escape check per
candidate.

The stack is built by `configureWorkflowAssets`: `built-in` (the packaged root),
then `overlay` (`$LASTLIGHT_OVERLAY_DIR`) when one is configured. A run against a
repo that commits `.lastlight/skills/<name>/` gets a **third, per-run** layer on
top, via a resolver built with `createAssetResolver([...getAssetLayers(),
makeLayer("repo", …)], …)` — see [Configuration](/spec/02-configuration). Each
layer has a `skillRoot` (`<root>/skills`); the built-in and legacy layers also
carry a `claudeSkillRoot` (`.claude/skills`) fallback, which the overlay and repo
layers deliberately do not.

Returns absolute **directory** paths — one per declared skill. The loader does
**not** recurse into nested directories —
`skills/software-development/architect` is not addressable as
`software-development/architect`. Names are flat and alphanumeric.

Because a repo skill resolves to an ordinary host path (inside the repo-config
cache), the orchestrator stages it exactly like a built-in or overlay skill —
copy for docker, tar for kubernetes. No sandbox backend knows a repo layer
exists.

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
   nudge that points the agent at the primary skill (the mapped skills
   already appear in the system-prompt catalogue, so no path is needed):
   ```
   Use the **pr-review** skill to handle this request.
   Other skills available if you need them: issue-triage.

   Context:
   owner: clifton
   repo: lastlight
   issueNumber: 42
   ...
   ```
3. Else — throw.

## Workspace staging

Before each agent run, `stageSkillBundle` in
`src/engine/agent-executor.ts` materialises the named skills into a
**per-phase bundle** at `<workspaceRoot>/.lastlight-skills/<phaseKey>/<name>/`,
then maps it to the agent explicitly via pi's `--skill` (docker) /
`skillPaths` (in-process). Behaviour:

- **cwd is the repo; the bundle is an out-of-repo sibling.** When the
  harness pre-clones the repo, the agent's cwd **is** the checkout — so its
  commands run inside the repo with no `cd` preamble. The skill bundle is
  staged at the workspace root (`.lastlight-skills/`), a **sibling** of the
  `<repo>/` checkout, and mapped by an **absolute** `--skill`/`skillPaths`
  path so cwd is irrelevant: docker bind-mounts the whole workspace (the
  sibling resolves), and `none` sees the host FS directly. **gondolin**
  mounts *only* cwd, so a workspace-root sibling would be invisible — there
  the bundle is staged *under* the repo and added to the checkout's local
  `.git/info/exclude` (`excludeFromGit`), so the agent still can't commit
  it. Non-pre-cloned workflows run with cwd = the workspace root.
- **Keyed per phase (`phaseKey` = sanitized phase name).** Only the
  phase's own `<phaseKey>` subtree is cleared, so a clean slate per phase
  never disturbs a sibling phase — concurrent phases sharing one workspace
  (sequential today, parallel via worktrees later) can't clobber each
  other's catalogue. A phase with no `skills:`/`skill:` gets no bundle.
- **Explicit mapping, not auto-discovery.** The bundle is NOT named
  `.agents/skills` (pi's auto-discovery path); the resolved skill dirs are
  passed to pi via `--skill`/`skillPaths` so the per-phase isolation
  survives — auto-discovery only ever reads that one fixed name.
- **Whole directory, not just SKILL.md.** `scripts/`, `references/`,
  `assets/` travel along.
- **Two modes:**
  - `symlink` (`none` only) — `symlinkSync(hostDir, dest, "dir")`.
    Zero-copy; the host FS is fully visible so pi reads the skill files
    host-side through the link.
  - `copy` (docker / gondolin) — recursive `cpSync(hostDir, dest, { recursive: true, dereference: true })`.
    The dest sits inside the agent's mounted cwd, but the symlink *target*
    (the skill source in the install tree) would sit outside it — so a
    symlink dangles in the guest. Docker's container and gondolin's
    cwd-only mount both need the real files present; copy (dereferenced)
    lands them inside the mount, piggybacking on the existing
    bind/cwd mount instead of adding new mounts per skill.

```
<workspaceRoot>/              ← host workDir (bind-mounted whole on docker)
├── AGENTS.md                  ← persona + rules (see below)
├── .lastlight-skills/         ← sibling of the repo, never in its git tree
│   └── <phase>/               ← e.g. reviewer, architect (per-phase bundle)
│       ├── pr-review/         ← staged from <repo>/skills/pr-review/
│       │   ├── SKILL.md
│       │   └── ...
│       └── issue-triage/
│           └── SKILL.md
└── <repo>/                    ← pre-cloned target repo = agent's cwd
    └── .git/                  ← (gondolin: bundle lives here + info/exclude)
```

## Chat path

Chat doesn't run inside pi-coding-agent's `AgentSession` — it uses
pi-ai's lower-level `completeSimple` loop. To still give chat the
same progressive-disclosure model, `src/engine/chat/chat-skills.ts`:

1. Enumerates every skill resolvable through the asset layer stack
   (`listSkillNames()`) and keeps the ones whose SKILL.md frontmatter
   declares **`chat: true`**, resolving each through `resolveSkillPaths`
   so an overlay's version of a built-in skill wins. The packaged set is
   `chat`, `issue-triage`, `pr-review`, `repo-health`.

   Opt-in, because most skills are written for a sandbox phase with a
   checkout, a shell and write access — chat has none of those, so
   exposing one by default advertises instructions the agent cannot
   follow. It replaced a hardcoded `CHAT_SKILL_NAMES` list resolved
   against `resolve("skills")` (the process cwd), which meant an overlay
   could neither add a chat skill nor override a built-in one.
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
| `pr-review` | Precision-first PR review: advance the discussion, keep only Critical / Important findings past a confidence gate. A **pure code review — no building** (CI validates the change builds/runs). Does **not** post the review itself — it writes review *content only* (`{ skip?, summary, event, findings[] }`) to `.lastlight/pr-review/findings.json` (schema in `references/findings-schema.md`); `pr-review.yaml`'s first-class `type: post-review` action reads that, supplies the PR number / base ref / head SHA / diff from the harness itself, and posts one formal review with the findings as line-anchored inline comments (demoting any off-diff finding to the body). A finding is anchored by its verbatim `existingCode` excerpt, not by a line number the model counted — `line`/`side` are advisory and get overwritten | `pr-review.yaml`, `cron-review.yaml`, chat |
| `pr-comment` | Answer maintainer questions on open PRs | `pr-comment.yaml` |
| `repo-health` | Weekly health report (open / stale / velocity / labels) | `repo-health.yaml`, `cron-health.yaml`, chat |
| `security-review` | Diff-based security scan since last review | `security-review.yaml`, `cron-security.yaml` |
| `security-feedback` | Break out scan findings into individual issues | `security-feedback.yaml` |
| `building` | Shared craft: install deps + run the repo's CI gate (build + test + lint + typecheck, mirroring `.github/workflows` / AGENTS.md) in the sandbox (package-manager detection from lockfile, install-first, TDD discipline when implementing, a decomposition budget (~15 cyclomatic), no compiler-silencing assertions, and building a runnable in-sandbox verification path when the only test path needs an unavailable external service) | build executor + reviewer, `pr-fix.yaml`, `dependabot-ci-fix.yaml` |
| `fixing` | Diagnose a red PR **before** repairing it: read the real failure, read the CI definition, name the CI-versus-sandbox differences explicitly, reproduce the exact failing command, then classify into exactly one of five classes — `reproducible`, `env-mismatch`, `flaky`, `infra-dependent`, `upstream-broken`. Also owns publish discipline (publish only on a green local gate; never a speculative publish; the phase's work reaches the branch through `github_publish`, never `git push`, and a successful publish IS the phase's push — so it is reported `outcome=pushed`), the runtime-written `.git/lastlight-verify.sh` gate script (inside the checkout's `.git/`, which git never walks, so it cannot be committed; deleted by the harness each attempt so a superseded diagnosis cannot gate this one; run by the loop as `bash <script>`, so it must be a bash script and the harness scores the same gate the agent ran; `gate=skipped` counts as red) and **what belongs in it** — a *targeted reproduction* of the diagnosed failure, the narrowest command that would have failed before the fix and passes after it (one test file, one lint rule, one build target, one install; under two minutes), never a clone of the repo's CI pipeline (CI runs on the published commit and is the authority), never a check already watched passing in the same session, never anything that starts a service (there is no docker in the sandbox, so the guarded branches are dead code) and never anything that mutates git state (the harness re-runs it); a repair with **nothing** to reproduce — a resolved merge conflict is the motivating case — still writes one, either the coherence check the repair implies (no conflict marker left, the lockfile installs) or an honest one-line `exit 0` saying why, because leaving it unwritten burns the loop's remaining iterations on a finished repair and reports `gate=skipped`, the `DIAGNOSIS_COMPLETE` / `CI_FIX_COMPLETE` marker formats, and the **PR journal** — `<kind>: <one line>` appended to `.git/lastlight-notes` (same placement and same per-run delete), where `finding` / `constraint` / `ruled-out` / `todo` are the four kinds, `ruled-out` is the only one recording a verified negative, `class=` in a note is rejected outright because that token is parsed, and a note read back is a hint that can never authorise a push or stand in for the gate | `pr-fix.yaml`, `dependabot-ci-fix.yaml` (primary on both, both phases) |
| `code-review` | Shared review rubric, precision-first: post **only Critical / Important** (Suggestions / Nits are dropped as noise), each with a concrete-impact line, past a self-refutation confidence gate + what to check (correctness incl. silent-default/dropped-output as a bug, security, edge cases, complexity, duplication, type-safety, regression risk, test coverage). The confidence gate is **scoped to what you post**: it fires on the pass that *produces* the review, and explicitly not on a survey pass appending hypotheses for a later probe/adjudicate stage, which is told to over-produce because every downstream stage can only remove (Google's AutoCommenter measured a single global threshold as catastrophic — ~80% of what it discarded below `t = 0.98` was correct anyway). It also owns **what is not a finding**, a *category* rule rather than a second confidence bar: pre-existing issues, anything a linter/typechecker/compiler already catches (bar an assertion that *silences* one), defects on lines the diff never touched unless the diff is what makes them wrong, restatements of what the change is deliberately doing, points already explicitly suppressed in the code, conventions the reviewed repository does not actually follow — **the repository's conventions govern, not the ones it aspires to** — and (v2.4.0, mined from measured review noise) a **repeated literal the merged code already repeats** (a finding only when the change makes the copies observably diverge; sharing the constant is a Suggestion), **"X is never validated" with no consumer that misbehaves**, and **PR-description staleness** — though a doc/comment/example asserting something *checkable* about behaviour that is **false at head** IS a finding. Posting discipline: **one defect per comment** (never fold a second defect into an "Additionally…" sentence; two comments may share a line) and distinct claims stay distinct — "out of date" is not "wrong" | build cycle's branch-diff reviewer, `pr-review.yaml` (same rubric, different procedure) |
| `survey-pass` | The shared rules for ONE pass of the `pr-review` fan-out: workspace layout (cwd IS the checkout; every `.lastlight/…` path is relative to it, and the skill bundle is a SIBLING one level above — measured, it cost 23 of 120 survey branches their seed), the finding tiers, **what is not a finding** as a category rule, and the multi-pass carve-out that tells a survey to **over-produce** because every downstream stage can only remove. Deliberately carries NO posting procedure, no `findings.json`, and no confidence gate — the three things a survey pass is forbidden to do and used to be handed anyway. Also owns the **trust-boundary predicate** on `Critical`: a security-shaped hazard whose input supplier already holds the capability it would grant is not a boundary crossing | `pr-review.yaml`'s `survey` fan-out (all five branches) |
| `dependency-impact` | Judge a **major** dependency bump by blast radius rather than semver magnitude — `low` / `medium` / `high` from evidence gathered with **no checkout** (dev-vs-runtime, release notes in the PR body, direct import-site count via `github_search_code`, security sensitivity, the settled check result), with **unknown ⇒ high**. Also owns the audit-evidence format an auto-merged major is recorded with | `dependabot-pr-merge.yaml` (alongside `code-review`) |
| `issue-answer` | Answer a question directly: sourced neutral reply to a GitHub issue or Slack thread; research repo docs + web; label `question` (GitHub only); never write a brief, mark ready-for-agent, or change code | `answer.yaml` |
| `verify` | Test a behaviour claim as an investigator: install + run the code in the sandbox, capture bash/text evidence, report CONFIRMED / REFUTED / INCONCLUSIVE; never fabricate or stage evidence | `verify.yaml` (text phase) |
| `qa-test` | Drive a CLI or locally-served app through a flow and report step-level pass/fail with evidence; continue past failures unless one blocks everything | `qa-test.yaml` (text phase) |
| `browser-qa` | Drive a web UI in a real headless Chromium and capture screenshot evidence (bundled `agent-browser` Playwright CLI: `doctor` probe + `run <flow.json>`; opt-in `--record-dir DIR` mode screen-records the whole session via Playwright `recordVideo` → `session.webm`, used by the `demo` skill). Used only in the docker-gated browser phase on the `lastlight-sandbox-qa` image; degrades to the text path when unavailable | `verify.yaml` + `qa-test.yaml` (browser phase, `sandbox_image: qa`), `demo.yaml` |
| `demo` | Record a short DEMO VIDEO of a PR/feature: drive the repo's web UI in headless Chromium (via the browser-qa driver's `--record-dir` mode), then composite a titled, size-capped (≤ 5 MB) mp4 with ffmpeg via the bundled `scripts/compose-demo.sh` (title card, optional before/after side-by-side, trim/speed). ffmpeg-only — no Remotion. Web/Electron only; never fabricates evidence | `demo.yaml` (demo phase, `sandbox_image: qa`) |
| `chat` | Conversational assistant persona | chat (always-on) |

`building` and `code-review` are not optional libraries — they're live
shared building blocks staged into multiple workflows (`code-review` in the
build cycle and `pr-review`; `building` in the build cycle and both fix
workflows), the same way `issue-triage` is reused across webhook and cron.
The "Used by" column lists every workflow that stages each. Note `pr-review`
stages `code-review` but **not** `building` — it's a pure code review.

**`code-review` is for a phase that PRODUCES a review, and `survey-pass` is
for one that does not.** `pr-review.yaml` stages `code-review` on `falsify`,
`review` and `adjudicate` — the last hands on the work before a human reads it,
which is exactly where its precision gate is meant to fire. The five `survey`
branches stage only `survey-pass`. They used to stage `pr-review` +
`code-review` (and `security` a third, `security-review`), 528 lines of which
each family prompt then countermanded the main contracts — a review-producing
procedure the pass may not follow, plus a ten-axis checklist handed whole to
five specialists owning one or two axes each. The axes now live in the family
prompts, which is LD9: specialists separated by *question*, not by tool access.

### `fixing` vs `building`

They divide by tense. `building` is about *implementing* — it assumes you
know what you are trying to build. `fixing` is about **a failure that
already happened**: find out why, decide whether it can be fixed here at
all, and only then repair it, minimally. So on both fix workflows the
`diagnose` phase stages `skill: fixing` alone and the `fix` phase stages
`skills: [fixing, building]` — `fixing` first, so it is the primary, and
`building` alongside it for the install + gate mechanics `fixing` defers
to. Both phases set `prompt:` as well, and both prompts name the skill
explicitly rather than relying on the auto-generated nudge.

The five classes are the skill's load-bearing output, because the workflow
branches on them:

| Class | Meaning | Disposition |
|---|---|---|
| `reproducible` | The same command fails here too | Fix it |
| `env-mismatch` | Passes here, fails in CI on a version / OS / flag difference | Align to CI and re-verify — the repair is often config, not code |
| `flaky` | A timeout or network blip, or the same job passed on a prior SHA | Change nothing |
| `infra-dependent` | Needs secrets, a live service, a deployed backend, a browser | Cannot be fixed here — escalate, naming the checks |
| `upstream-broken` | The base branch is red too | Not this PR's fault; self-heals when the base goes green |

The last three are **stopping** verdicts. Reaching one is a *correct*
outcome, not a failure — stopping cheaply is the entire point of diagnosing
first — which is why the `fix` phase's `skip_if` skips rather than fails on
them and the run still records `succeeded`
([Workflow Engine](/spec/06-workflow-engine)). The skill says so explicitly,
because an agent's natural bias is to round a stopping verdict up to
`reproducible` in order to look useful.

Markdown cannot import, so the class vocabulary is pinned from the code side
instead: `tests/skills/fixing.test.ts` asserts all five names appear verbatim
in `SKILL.md`, the same pattern (and for the same reason) as
`tests/cron/label-vocab.test.ts`.

### `dependency-impact` — impact, not magnitude

The only rule about bump magnitude in the codebase used to be one prose
conjunct in the merge prompt's TRIVIAL test — *"it is not a **major**
version bump of a runtime dependency"* — so every major escalated, whether
it was a `@types/*` dev bump or a runtime framework rewrite. This skill
replaces that conjunct with a rubric over evidence (issue #252).

It is a skill rather than more prompt prose for two reasons. **Progressive
disclosure:** the assess prompt is already long and the rubric is needed
only when the PR *is* a major, which pi's on-demand catalogue handles for
free. **Per-repo tunability:** a managed repo can override
`skills/dependency-impact/SKILL.md` in its own `.lastlight/` — exactly the
per-repo tuning this work exists to enable — without the operator widening
`repoConfig.allowKeys`.

| Tier | When | Effect |
|---|---|---|
| `low` | Dev-only dependency, **or** a GitHub Actions tag bump, **or** zero direct import sites; no documented breaking changes; CI settled `passing` | Auto-merges at `autoMergeMaxImpact >= low` |
| `medium` | Runtime dependency, CI settled `passing`, breaking changes documented but none matching this repo's usage, not security-sensitive | Auto-merges at `autoMergeMaxImpact >= medium` (the packaged default) |
| `high` | Security-sensitive domain, **or** many import sites, **or** breaking changes plausibly touching used APIs, **or** CI not settled `passing`, **or** release notes missing/unparseable | `dependency-functional` + `requires-human`, as every major used to get |

**Unknown ⇒ high** is the load-bearing clause: inability to gather the
evidence is itself a high-impact signal, not licence to guess low. It is
why a repo with no CI at all cannot produce `low` or `medium` for a major —
there is no behavioural evidence to weigh — while its non-major bumps
continue down the unchanged trivial path.

The tiers, the three impact labels and their hex colours are a contract
between the skill, the merge prompt and `src/cron/dependabot-discovery.ts`,
which markdown cannot import; `tests/cron/label-vocab.test.ts` and
`tests/workflows/dependabot-pr-merge.test.ts` pin them, the same pattern as
the `fixing` classes above.

Nested skill directories (`skills/software-development/architect`,
`skills/github/github-pr-workflow`, etc.) exist as a category library —
they're organisational, not loader-discoverable. Their content informs
inline prompt files and documentation, but workflows don't reference
them directly.

## Agent context layer

Three files in `agent-context/`, read in alphabetical order:

- **`rules.md`** — operational guardrails. Workspace conventions, the
  prohibition on satisfying a check by disabling it (issue #264),
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

## Composition

`loadAgentContext()` walks the layer stack **forwards**, keyed by **basename**,
so a later layer's `rules.md` replaces an earlier one's, then joins the surviving
files (alphabetically) with `\n\n---\n\n`. `disabled.agentContext` removes a file
by exact filename (`rules.md`) or stem (`rules`).

**A repo layer is additive only.** A resolver built with
`agentContextAdditiveOnly: true` — which is the only way the runner ever builds
one for a repo — keeps last-wins for built-in ⊕ overlay but *drops* a `repo`
file whose basename an operator-owned layer already provides, recording an
`agent-context-dropped` `AssetWarning`. Without that rule, committing a
`security.md` would neuter the operator's security boundaries for every run
against that repo. A repo can still **add** context under any other filename.
See [Configuration](/spec/02-configuration).

## AGENTS.md materialization

### Sandbox

The runner composes the run's context **once**, off that run's asset resolver,
and threads it as `ExecutorConfig.agentContext`. The orchestrator's
`deliverAgentContext` (`src/engine/executors/orchestrator.ts`) then picks the
delivery, reading the value through `agentContextFor(config)` —
`config.agentContext ?? loadAgentContext(...)`, so a run with no repo layer is
byte-identical to the pre-#180 behaviour:

- **host-shared backends** (docker / gondolin / none / smol) — written to
  `<hostWorkspaceDir>/AGENTS.md`. An empty context writes no file.
- **kubernetes** — `hostWorkspaceDir` is an in-pod path, so the text goes to the
  adapter through the `AgentContextSink` capability
  (`provideAgentContext(sandbox, md)` → `KubernetesSandbox.setAgentContext`) and
  is served over its own per-run init-fetch channel. See
  [Sandbox](/spec/09-sandbox).

Best-effort on both paths: a failure degrades the agent's context, it never
fails the phase. The value is used **verbatim** downstream — re-composing it
anywhere else would drop the repo layer, or include it without the
additive-only filter.

`loadAgentContext(_dir?)` (`src/engine/github/profiles.ts`) is the
operator-only composition; its directory argument is accepted for call-site
compatibility and ignored, because agent context is resolved layer-wise rather
than from one directory.

### In-process (chat)

```ts
// src/index.ts (chat boot)
systemPrompt: () => agentContext + chatSystemSuffix(hasGithub, { isWorkflowEnabled }) + chatSkills.catalogueXml
```

The same helper, injected directly into the chat system prompt rather than
dropped on disk, with the chat-specific suffix and the skill catalogue XML
appended. Chat is not repo-scoped, so it carries **no** repo layer.

The docker sandbox image's entrypoint still ships a
`cat /app/agent-context/*.md` fallback, but it is guarded by
`[ ! -f "$WORKSPACE/AGENTS.md" ]` and the orchestrator's write overwrites the
same path — so it only ever applies when the composition was empty.

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
  and stages directories. Skill bodies reach the agent through pi's
  `--skill`/`skillPaths` catalogue + the agent's own `read` tool.
- **Each phase's bundle is cleared at phase start.** A phase with no
  `skills:` declaration gets no staged catalogue; clearing only its own
  `.lastlight-skills/<phase>/` subtree leaves sibling phases untouched.
- **Whole directories travel.** `scripts/` / `references/` / `assets/`
  next to a SKILL.md are visible at
  `.lastlight-skills/<phase>/<name>/...` and runnable / readable by the
  agent's bash and read tools.
- **Agent context is *append-only* per session.** The sandbox writes
  `AGENTS.md` at startup and never modifies it. Chat injects it once
  into the system prompt. Drift between sessions only happens if
  `agent-context/*.md` itself changes on disk.

## Current implementation

| Piece | File |
|---|---|
| Skill name validation + path resolution | `packages/shared/src/workflow-loader.ts` (`resolveSkillPaths`, `loadSkillRaw`), re-exported by `src/workflows/loader.ts` |
| Layer stack + per-run resolver | `packages/shared/src/workflow-loader.ts` (`AssetLayer`, `makeLayer`, `configureWorkflowAssets`, `getAssetLayers`, `getDisabledAssets`, `createAssetResolver`, `AssetWarning`) |
| Phase config overlay (resolves `skill:`/`skills:` into `ExecutorConfig.skillPaths`) | `src/workflows/runner.ts` (`phaseConfigFor`) |
| User prompt generation | `src/workflows/runner.ts` (`buildPhasePrompt`) |
| Per-phase bundle staging (symlink/copy) | `src/engine/agent-executor.ts` (`stageSkillBundle`, `skillBundleKey`, `excludeFromGit`) |
| Chat catalogue + `read_skill` tool | `src/engine/chat/chat-skills.ts` |
| Chat catalogue wiring | `src/index.ts` (ChatRunner boot) |
| Skills | `skills/<name>/SKILL.md` |
| Agent context layer | `agent-context/{rules,security,soul}.md` |
| In-process `loadAgentContext()` / per-run `agentContextFor()` / `AgentContextSink` | `src/engine/github/profiles.ts` |
| AGENTS.md delivery (workspace write vs k8s sink) | `src/engine/executors/orchestrator.ts` (`deliverAgentContext`) |

## Rebuild notes

- **Filesystem layout is the contract.** The decision to stage skills
  into a per-phase bundle under `<workspaceRoot>/.lastlight-skills/` and
  map it via the SDK's `--skill`/`skillPaths` means there is no
  SDK-level skill-object API to maintain. A re-implementation on a
  different SDK should pick an equivalent filesystem convention rather
  than threading skill objects through
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
