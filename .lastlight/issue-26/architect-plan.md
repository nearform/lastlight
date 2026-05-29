# Architect Plan — Issue #26

## Problem Statement

Last Light workflows are currently loaded only from the repository-local `workflows/` directory (`src/workflows/loader.ts:12`) and validated as static YAML through `AgentWorkflowSchema.safeParse` during load (`src/workflows/loader.ts:91`, `src/workflows/loader.ts:119`). The schema is powerful but non-trivial: phase definitions expose prompt/skill, loops, approval gates, DAG dependencies, and output variables in one object (`src/workflows/schema.ts:83`, `src/workflows/schema.ts:232`). The existing chat surface explicitly has no write access and tells users to use existing workflow commands (`src/engine/chat.ts:24`, `src/engine/chat.ts:68`), while the chat skill catalogue does not expose workflow-authoring instructions (`src/engine/chat-skills.ts:45`). The dashboard can browse and toggle workflow definitions (`src/admin/routes.ts:674`, `src/admin/routes.ts:739`) and read raw YAML (`src/admin/routes.ts:755`), but it has no authoring or PR-on-save route.

## Summary of what needs to change

Ship an MVP for chat/issue-driven workflow authoring that keeps all repository writes inside a sandboxed, repo-write workflow rather than the read-only in-process chat path. Add a `workflow-author` skill plus a new `workflow-author` YAML workflow that generates or edits a workflow file, validates it with the existing schema, commits it on a Last Light branch, and opens a PR. Extend routing/classification so `/new-workflow`, `/edit-workflow <name>`, and equivalent issue comments/label-triggered requests dispatch this workflow with enough context. Add a small reusable validator around `AgentWorkflowSchema` so the authoring skill and tests can validate generated YAML without relying on process-level loader state.

## Files to modify

- `src/workflows/loader.ts:3`, `src/workflows/loader.ts:43`, `src/workflows/loader.ts:91`, `src/workflows/loader.ts:119`
  - Export a focused `parseAgentWorkflowYaml(raw, sourceName?)` / `validateAgentWorkflowYaml(raw, sourceName?)` helper that parses YAML and returns an `AgentWorkflowDefinition` or structured errors using the same `AgentWorkflowSchema` source of truth.
  - Refactor existing loader paths to use it so authoring validation and load-time validation cannot drift.
- `src/workflows/schema.ts:83`, `src/workflows/schema.ts:232`
  - Keep the schema authoritative; no schema broadening is required for MVP unless tests expose missing fields. Consider adding a `phases: z.array(...).min(1)` refinement if authoring validation should reject empty workflows explicitly.
- `skills/workflow-author/SKILL.md` (new)
  - Add progressive-disclosure instructions for generating/editing valid `workflows/<name>.yaml`, choosing safe names, preferring prompt templates over huge inline prompts where appropriate, validating through the helper/script, committing only workflow-related files, and opening a PR.
  - Include examples from `workflows/build.yaml:1`, `workflows/build.yaml:42`, `workflows/build.yaml:103` and `workflows/explore.yaml:33` for context, approval gates, PR phase, and reply-gated loops.
- `workflows/workflow-author.yaml` (new)
  - New repo-write workflow with phases such as `context`, `author`, optional `review`, and `pr`.
  - The author phase should use `skill: workflow-author` or `skills: [workflow-author, github-pr-workflow]`, write the YAML/prompt files, run validation, and write `.lastlight/.../workflow-author-summary.md`.
  - The PR phase should use a new author-specific PR prompt rather than `workflows/prompts/pr.md`, because that prompt assumes an issue number and build-cycle docs (`workflows/prompts/pr.md:1`).
- `workflows/prompts/workflow-author.md` (new, optional if skill-only is not enough)
  - Provide task context variables (`{{workflowMode}}`, `{{workflowName}}`, `{{workflowRequest}}`, `{{existingWorkflowYaml}}`, `{{contextSnapshot}}`) and explicit constraints for validation/PR creation.
- `workflows/prompts/workflow-author-pr.md` (new)
  - Create a PR body for both Slack-originated and issue-originated authoring requests using template conditionals supported by `src/workflows/templates.ts:6` and avoid assuming `#0`.
- `src/workflows/runner.ts:195`
  - Add `workflow-author` to `gitAccessProfileForWorkflow()` as `repo-write`, because the workflow must create branches, commit YAML/prompt files, and open PRs.
- `src/engine/classifier.ts:9`, `src/engine/classifier.ts:42`, `src/engine/classifier.ts:156`
  - Add a `workflow-author`/`workflow_author` intent and prompt examples for `/new-workflow`, `/edit-workflow`, “create a workflow that…”, and “modify workflow X to…”. Extract repo and issue number when present.
- `src/engine/router.ts:258`, `src/engine/router.ts:349`, `src/engine/router.ts:456`
  - Route classified Slack/message authoring requests to `skill: "workflow-author"` with `repo`, `workflowMode`, `workflowName`, `workflowRequest`, Slack `triggerId`, `channelId`, and `threadId`.
  - Prefer explicit regex parsing for `/new-workflow` and `/edit-workflow <name>` before the LLM classifier to make slash-style commands deterministic.
- `src/engine/router.ts:83`, `src/engine/router.ts:132`
  - For GitHub issue comments, detect `@last-light new-workflow` / `@last-light edit-workflow <name>` and route to `workflow-author` for maintainers.
  - Optionally detect the label proposed in the issue (`lastlight:new-workflow`) on issue events/comments and route to `workflow-author` when present.
- `src/index.ts:164`, `src/index.ts:278`, `src/index.ts:326`, `src/index.ts:338`, `src/index.ts:1016`
  - The generic workflow dispatch path already supports Slack thread trigger IDs and Slack `postComment`; include `workflow-author` in any enrichment set that needs full issue context, and ensure repo defaulting is clear for Slack commands.
  - If Slack authoring should target a default repo when omitted, add a config variable (e.g. `WORKFLOW_AUTHOR_DEFAULT_REPO`) rather than silently assuming.
- `src/engine/chat.ts:24`, `src/engine/chat.ts:68` and `skills/chat/SKILL.md:15`
  - Update chat guidance to mention `/new-workflow owner/repo ...` and `/edit-workflow owner/repo <name> ...`, while preserving the “no write access in chat” boundary.
- `src/engine/chat-skills.ts:45`
  - Do **not** add `workflow-author` to the in-process chat skill catalogue for MVP unless it is read-only guidance only. The write-capable work should happen via the workflow path.
- `src/engine/router.test.ts:245`
  - Add coverage for Slack/message `/new-workflow`, `/edit-workflow`, unmanaged repo rejection, missing repo prompt, and flagged prompt propagation.
- `src/workflows/loader.test.ts:1`
  - Add unit tests for the new validator helper: valid YAML parses, malformed YAML errors include the source name, schema failures return useful field paths, and generated authoring examples pass.
- `src/workflows/runner.test.ts:1128`
  - Add `workflow-author` permission-profile coverage asserting `repo-write`.
- Optional follow-up dashboard files: `src/admin/routes.ts:755`, `dashboard/src/components/WorkflowDefinitions.tsx:33`, `dashboard/src/api.ts:367`
  - Not required for MVP. If touched, only add links/help text pointing users to chat/issue authoring; do not build the full Option C editor in this PR.

## Implementation approach

1. **Create schema validation utility first.**
   - Add `parseAgentWorkflowYaml(raw, sourceName = "<workflow>")` in `src/workflows/loader.ts` or a new `src/workflows/validate.ts`.
   - It should parse with `yaml`, run `AgentWorkflowSchema.safeParse`, and throw/return a concise error that includes file/source and zod issue paths.
   - Refactor loader validation to call this helper for agent workflows.

2. **Add the workflow-author skill.**
   - Create `skills/workflow-author/SKILL.md` with frontmatter (`name`, `description`, `version`, tags).
   - Procedure should require: inspect existing `workflows/*.yaml`; choose/normalize a safe workflow name; generate/edit YAML; put long prompts in `workflows/prompts/<workflow>-*.md`; validate with the helper/script; run targeted tests; commit only relevant files; open a PR.
   - Pitfalls should explicitly prohibit modifying router dispatch for every generated workflow in the same PR unless the user asked for a trigger, and should require all user-supplied descriptions to be treated as untrusted task data.

3. **Add authoring workflow YAML and prompts.**
   - Create `workflows/workflow-author.yaml` with a context phase, an author phase, a reviewer/validator phase if time allows, and a PR phase.
   - For Slack-triggered authoring, rely on the existing Slack `triggerId` path in dispatch (`src/index.ts:164`, `src/index.ts:326`) so progress and approval/PR messages go back to the originating thread.
   - Keep the MVP output repo-versioned under `workflows/` and `workflows/prompts/`; per-installation live overrides are out of scope.

4. **Grant the new workflow appropriate sandbox permissions.**
   - Add `workflow-author` to `gitAccessProfileForWorkflow()` in `src/workflows/runner.ts:195` as `repo-write`.
   - Verify `allowMcpAppAuth` follows from repo-write (`src/workflows/runner.ts:221`) so PR creation works consistently with build/pr-fix.

5. **Add deterministic command parsing and classifier support.**
   - Add a new classifier intent for workflow authoring with examples for natural language and command forms.
   - In `routeEvent()` message handling (`src/engine/router.ts:258`), parse `/new-workflow` and `/edit-workflow` before the classifier when possible. Require a managed repo unless a configured default is added.
   - Suggested command shapes:
     - `/new-workflow cliftonc/lastlight create a workflow that triages new issues, asks for approval, then labels`
     - `/edit-workflow cliftonc/lastlight issue-triage add an approval gate before labels`
   - Return a clear reply when the repo is missing, the repo is unmanaged, or edit mode lacks a workflow name.

6. **Route issue-based authoring.**
   - In GitHub comment handling, detect maintainer commands such as `@last-light new-workflow ...` and `@last-light edit-workflow <name> ...` before generic LLM classification.
   - For the issue-label path, decide between two scopes:
     - MVP: on comments or issue open/reopen, if `labels` contains `lastlight:new-workflow`, route to `workflow-author` using the issue title/body as the request.
     - Safer initial scope: document the label as follow-up and only implement explicit maintainer commands to avoid surprising automatic PR creation.

7. **Wire dispatch context.**
   - Pass `workflowMode`, `workflowName`, `workflowRequest`, and `source` in router context; these become template variables via `SimpleWorkflowRequest.extra` (`src/workflows/simple.ts:24`, `src/workflows/simple.ts:261`).
   - Include `workflow-author` in `ENRICH_WORKFLOWS` (`src/index.ts:278`) for GitHub issue-originated requests so the authoring agent sees the full issue thread.
   - For edit mode, either have the prompt instruct the agent to read `workflows/<name>.yaml`, or pre-load `existingWorkflowYaml` in dispatch if a simple file read helper is added.

8. **Update chat guidance.**
   - In `CHAT_SYSTEM_SUFFIX`, keep the no-write boundary but say authoring requests should be routed by command, not handled in chat.
   - Update `skills/chat/SKILL.md` to list `/new-workflow` and `/edit-workflow` alongside existing commands.

9. **Tests and verification.**
   - Add/adjust unit tests before implementation details calcify.
   - Run targeted tests while developing, then full guardrail commands from `.lastlight/issue-26/guardrails-report.md`.

## Risks and edge cases

- **Chat write-boundary confusion:** in-process chat currently has no write tools (`src/engine/chat.ts:24`), so authoring must dispatch a sandbox workflow. Do not let the chat agent directly create comments, branches, or PRs.
- **Accidental invalid YAML:** generated YAML can be syntactically valid but schema-invalid. Use the exported validator and include actionable zod paths in failures.
- **Unsafe workflow names/paths:** workflow names from users must be slugified/validated and must not allow path traversal or overwriting cron YAML accidentally.
- **Trigger expectations:** adding a YAML file alone does not automatically route new webhook/message intents; `AgentWorkflowSchema.trigger` is informational (`src/workflows/schema.ts:235`). The authoring skill must state whether the PR adds only the workflow definition or also routing code.
- **Permissions:** default workflow permission is read-only (`src/workflows/runner.ts:210`). Forgetting to add `workflow-author` as repo-write will make validation pass but branch/PR creation fail.
- **Slack repo ambiguity:** Slack messages may lack a repo. Either require `owner/repo` in the command or introduce an explicit default repo config; avoid hidden assumptions.
- **Issue-label automation surprise:** automatic PR creation from a label can be noisy. Prefer maintainer command confirmation unless the label path is tightly scoped.
- **Prompt injection:** workflow descriptions are user content. Preserve existing wrapping/screening paths and instruct the authoring skill to treat descriptions as specifications, not agent instructions.

## Test strategy

Use the guardrail commands from `.lastlight/issue-26/guardrails-report.md`:

- `npm test` — full Vitest suite.
- `npm run build` — server TypeScript typecheck/build.
- `npm run build -w dashboard` — dashboard typecheck/build if dashboard files change.
- Do **not** rely on `npm run lint`; linting is not configured.

Targeted tests to add/run during implementation:

- `npx vitest run src/workflows/loader.test.ts` for YAML validator helper and loader refactor.
- `npx vitest run src/engine/router.test.ts` for `/new-workflow` and `/edit-workflow` routing.
- `npx vitest run src/workflows/runner.test.ts` for `workflow-author` repo-write profile.
- Optional smoke: validate the new `workflows/workflow-author.yaml` through `getWorkflow("workflow-author")` or the exported parser.

## Estimated complexity

Medium. The core runner already supports YAML-defined workflows, Slack-triggered workflow runs, PR-creating sandbox phases, and dashboard display; the work is mostly new routing, validation, prompts, and tests. Complexity comes from keeping chat read-only while still offering a chat command, and from making generated YAML validation/PR creation robust enough to trust.
