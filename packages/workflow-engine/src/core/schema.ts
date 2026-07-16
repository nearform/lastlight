import { z } from "zod";

// ── Output rules ──────────────────────────────────────────────────────

const OutputRuleSchema = z.object({
  action: z.enum(["fail", "continue", "pause"]),
  message: z.string().optional(),
  /** Skip the action if the request has this label */
  unless_label: z.string().optional(),
  /** Skip the action if ctx.issueTitle matches this case-insensitive regex */
  unless_title_matches: z.string().optional(),
  /** Template rendered when an `unless_*` clause fires and the rule is bypassed */
  bypass_message: z.string().optional(),
});

const PhaseOnOutputSchema = z.object({
  contains_BLOCKED: OutputRuleSchema.optional(),
  contains_READY: OutputRuleSchema.optional(),
});

// ── Loop configuration ────────────────────────────────────────────────

const PhaseLoopMessagesSchema = z.object({
  on_cycle_start: z.string().optional(),
  on_approved: z.string().optional(),
  on_request_changes: z.string().optional(),
  on_max_cycles: z.string().optional(),
  on_fix_start: z.string().optional(),
  on_fix_failed: z.string().optional(),
  on_pause_for_approval: z.string().optional(),
});

const PhaseLoopSchema = z.object({
  max_cycles: z.number().int().positive(),
  on_request_changes: z.object({
    fix_prompt: z.string(),
    fix_model: z.string().optional(),
    /** Reasoning-effort override for the fix cycle (e.g. {{variants.fix}}). */
    fix_variant: z.string().optional(),
    re_review_prompt: z.string(),
  }),
  /** Gate to pause at before running the fix (optional) */
  approval_gate: z.string().optional(),
  /**
   * Artifact (handoff doc) filename this gate is asking the reviewer to
   * approve, e.g. `reviewer-verdict.md`. Surfaced by the focused approval
   * view so the reviewer reads/edits the right doc before approving.
   */
  approval_artifact: z.string().optional(),
  /** Optional per-event notification templates rendered through the template engine. */
  messages: PhaseLoopMessagesSchema.optional(),
});

const GenericLoopSchema = z
  .object({
    max_iterations: z.number().int().positive(),
    /** Expression to evaluate for completion: "output.contains('PASS')" or "verdict == 'APPROVED'" */
    until: z.string().optional(),
    /** Shell command: exit 0 = loop complete, non-zero = continue */
    until_bash: z.string().optional(),
    /** Pause for human approval between iterations */
    interactive: z.boolean().default(false),
    /** Message shown at the interactive gate */
    gate_message: z.string().optional(),
    /**
     * Gate flavor for interactive loops. `approve` (default when absent)
     * pauses until the user sends an explicit approve/reject command;
     * `reply` pauses until the user sends *any* free-form message in the
     * same thread — the reply body is merged into `scratch` and passed
     * into the next iteration. Used by the socratic explore loop.
     */
    gate_kind: z.enum(["approve", "reply"]).optional(),
    /**
     * Dotted key into `scratch` that the loop writes the current
     * iteration state under (e.g. `socratic`). Only meaningful when
     * `gate_kind: reply` — the runner reads it back on resume to continue
     * from the right iteration instead of restarting from 1.
     */
    scratch_key: z.string().optional(),
    /** Reset agent context each iteration (don't pass previousOutput) */
    fresh_context: z.boolean().default(false),
    /**
     * Policy for a *soft* iteration outcome — the agent exited cleanly but
     * produced no usable output (stop reason `unknown` / `error_truncated`),
     * as opposed to a real crash (fatal / tool error / non-zero exit /
     * terminated), which always fails the run. Absent ⇒ `{ retries: 0, then:
     * "fail" }`, i.e. any non-success iteration hard-fails the workflow (the
     * historical behavior). Opt in to make a loop resilient to a degenerate
     * turn — e.g. the socratic explore loop retries once, then advances to
     * synthesis with the Q&A gathered so far instead of discarding the run.
     */
    on_soft_failure: z
      .object({
        /** Re-run the same iteration up to N times on a soft outcome. */
        retries: z.number().int().min(0).default(0),
        /**
         * What to do when an iteration is still soft after `retries`:
         * `fail` (default) hard-fails the workflow; `complete` treats the
         * loop as finished (as if the `until` condition matched) and lets
         * downstream phases run.
         */
        then: z.enum(["fail", "complete"]).default("fail"),
      })
      .optional(),
  })
  .refine((v) => v.until !== undefined || v.until_bash !== undefined, {
    message: "generic_loop requires at least one of: until, until_bash",
  });

// ── Phase definition ──────────────────────────────────────────────────

const PhaseDefinitionSchema = z
  .object({
    name: z.string(),
    /**
     * Optional human-readable label for dashboards and notifications.
     * Defaults to the phase `name` if not set. Source of truth for any
     * UI element that wants to display this phase.
     */
    label: z.string().optional(),
    /**
     * Phase kind:
     * - `context`: no execution (just a dashboard checkpoint marker).
     * - `agent` (default): run an LLM agent session.
     * - `bash`: run a deterministic shell command inside the sandbox
     *   container (no LLM). Requires `command:`.
     * - `script`: run an inline JS/TS (via `node`) or Python (via `uv run`)
     *   program inside the sandbox container. Requires `script:`.
     * - `post-review`: first-class, in-process PR-review submission. Reads the
     *   reviewer agent's `.lastlight/pr-review/findings.json` (content only:
     *   `{ skip?, summary, event, findings[] }`), supplies the PR number / base
     *   ref / head SHA / diff from the harness's own run context + checkout,
     *   anchors each finding to a changed line, and posts ONE formal review via
     *   `GitHubClient`. Runs on the harness (no sandbox); a genuine failure
     *   fails the phase, a legitimate `skip` succeeds without posting. See
     *   `PhaseExecutor.runPostReview`.
     *
     * `bash`/`script` phases run in the SAME sandbox/workspace as agent
     * phases (the host workDir persists across phases keyed by taskId), honour
     * `unrestricted_egress`/`sandbox_image`/`timeout_seconds`, and expose
     * their stdout downstream exactly like an agent phase (`output_var` →
     * `{{phaseOutputs.<name>.output}}`). A non-zero exit fails the phase.
     */
    type: z.enum(["context", "agent", "bash", "script", "post-review"]).default("agent"),
    /**
     * Shell command for `type: bash`. Rendered through the template engine
     * first (so it may reference `{{phaseOutputs.*}}`, `{{branch}}`, etc.),
     * then executed via `sh -c` inside the sandbox container. Exit 0 = success.
     */
    command: z.string().optional(),
    /**
     * Inline program source for `type: script`. Rendered through the template
     * engine, written to a temp file in the workspace, and executed with the
     * runtime selected by `runtime`. Python sources may carry a PEP 723
     * `# /// script` inline-dependency block (resolved by `uv run`).
     */
    script: z.string().optional(),
    /**
     * Runtime for `type: script` (default `js`):
     * - `js` → `node <file>`
     * - `ts` → `node --experimental-strip-types <file>` (sandbox Node 22)
     * - `python` → `uv run <file>`
     */
    runtime: z.enum(["js", "ts", "python"]).optional(),
    /**
     * Per-step timeout in seconds for `bash`/`script` phases. Defaults to the
     * sandbox's configured timeout (fallback 300s for deterministic steps).
     */
    timeout_seconds: z.number().int().positive().optional(),
    /**
     * Path to a prompt template file (relative to workflowDir).
     * Mutually exclusive with `skill`.
     */
    prompt: z.string().optional(),
    /**
     * Single skill to make available to the phase. Sugar for
     * `skills: [<name>]`. Mutually exclusive with `skills` (use one or
     * the other), but may coexist with `prompt`.
     */
    skill: z.string().optional(),
    /**
     * Skills to make available to the phase. Each entry names a directory
     * under `skills/<name>/` (containing SKILL.md plus optional scripts/,
     * references/, assets/). The first entry is the "primary" skill the
     * runner directs the agent to use; the rest are available for the
     * agent to read on demand via pi's progressive-disclosure model.
     *
     * Each named skill is staged into a per-phase bundle at
     * `.lastlight-skills/<phaseName>/<name>/` before the agent runs (symlink
     * in none, copy in docker/gondolin — a symlink's target would be outside
     * the guest's mounted cwd and dangle) and mapped to the agent explicitly via
     * pi's `--skill`/`skillPaths` (absolute paths). cwd stays the repo; the
     * bundle is staged at the workspace root — a sibling of the repo, outside
     * its git tree — for docker/none (gondolin, which mounts only cwd, stages
     * it under the repo + local `.git/info/exclude` so it's never committed).
     * Keyed per phase so concurrent phases can't clobber each other. Phases
     * with no `skills:`/`skill:` field get no bundle — `prompt:`-only phases
     * are unaffected.
     *
     * May coexist with `prompt`: when both are set, the prompt template
     * is the user prompt and `skills:` just stages the catalogue. The
     * prompt can then reference skills by name ("see the `pr-review`
     * skill for the structured-feedback format") and the agent can
     * read them via its built-in `read` tool.
     *
     * Mutually exclusive with the singular `skill:` field.
     */
    skills: z.array(z.string()).min(1).optional(),
    /** Model override — can reference template vars like {{models.architect}} */
    model: z.string().optional(),
    /**
     * Reasoning-effort override — can reference template vars like
     * `{{variants.architect}}`. Maps to agentic-pi's thinking level
     * (`off | minimal | low | medium | high | xhigh`). pi-ai translates
     * this into each provider's reasoning-effort API.
     */
    variant: z.string().optional(),
    /**
     * Bypass the sandbox HTTP egress allowlist for this phase.
     *
     * Default: the phase runs with the standard allowlist (GitHub, LLM
     * providers, public package registries — see
     * `src/sandbox/egress-allowlist.ts`). Set `unrestricted_egress: true`
     * for phases that need broad web access, e.g. an `explore` phase that
     * searches third-party documentation. Use sparingly — this is the
     * exfil control the allowlist exists to enforce.
     */
    unrestricted_egress: z.boolean().optional(),
    /**
     * Enable agentic-pi's web-search extension (`web_search` /
     * `web_fetch` tools) for this phase. Default: undefined → false.
     *
     * Set `true` on phases that should be able to search the web — e.g.
     * the research phases of the `explore` workflow. The opt-out
     * default is load-bearing: agentic-pi auto-enables web search
     * whenever a provider env var (`TAVILY_API_KEY`,
     * `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`) is present in
     * process.env, so we need an explicit `false` for every phase
     * that should not see the tools.
     *
     * Phases that opt in usually also want `unrestricted_egress: true`
     * so `web_fetch` calls can reach arbitrary docs sites through the
     * open-mode firewall — `web_search` itself only needs the provider
     * host (api.tavily.com / api.search.brave.com / api.exa.ai) which
     * is also covered by the open-mode tunnel.
     */
    web_search: z.boolean().optional(),
    /**
     * Capability gate: the sandbox backend this phase needs to run on.
     *
     * Default (absent): the phase runs on whatever backend the harness is
     * configured for. When set, the phase runs only if the **active** backend
     * matches; otherwise it is **silently skipped** — recorded as a
     * non-failing skip (like a trigger-rule skip), never a failure. This is
     * safe-by-default graceful degradation: a phase that depends on tooling
     * baked only into a specific sandbox image (a `/demo` video render, a
     * headless-browser QA step) just no-ops on a host that can't provide it
     * instead of breaking the workflow. E.g. the demo step in `build` declares
     * `requires_sandbox: docker` so it skips (rather than fails the build) on a
     * gondolin-only host.
     *
     * A skipped node is not `succeeded`, so a downstream phase that depends on
     * a gated phase via the default `all_success` rule would itself skip. Keep
     * gated phases **terminal** (nothing depends on them) or give their
     * dependants `trigger_rule: all_done`. Pair with `messages.on_skipped_done`
     * to surface why the phase was skipped.
     */
    requires_sandbox: z.enum(["docker", "gondolin", "none"]).optional(),
    /**
     * Which docker sandbox image this phase runs in. `default` (or omitted) uses
     * the lean `lastlight-sandbox:latest`; `qa` uses the heavier
     * `lastlight-sandbox-qa:latest` (Playwright + Chromium baked in) for the
     * browser-QA path. Only meaningful on the docker backend — pair it with
     * `requires_sandbox: docker` so the phase skips on gondolin. When `qa` is
     * requested but that image isn't built on the host, the scheduler skips the
     * phase too (graceful degradation), so keep such phases terminal.
     */
    sandbox_image: z.enum(["default", "qa"]).optional(),
    /** Named approval gate to pause at after this phase */
    approval_gate: z.string().optional(),
    /**
     * Artifact (handoff doc) filename this gate is asking the reviewer to
     * approve, e.g. `architect-plan.md`. Surfaced by the focused approval
     * view so the reviewer reads/edits the right doc before approving.
     */
    approval_artifact: z.string().optional(),
    /** Message template rendered when pausing at this phase's approval gate. */
    approval_gate_message: z.string().optional(),
    /** Optional per-event notification templates rendered through the template engine. */
    messages: z
      .object({
        on_start: z.string().optional(),
        on_success: z.string().optional(),
        on_failure: z.string().optional(),
        on_skipped_done: z.string().optional(),
        on_blocked: z.string().optional(),
        on_blocked_bypassed: z.string().optional(),
      })
      .optional(),
    /** Loop configuration for reviewer-style looping phases */
    loop: PhaseLoopSchema.optional(),
    /** Generic loop configuration — expression/bash-based completion conditions */
    generic_loop: GenericLoopSchema.optional(),
    /** Rules applied to agent output */
    on_output: PhaseOnOutputSchema.optional(),
    /** Actions taken on successful completion */
    on_success: z
      .object({
        set_phase: z.string().optional(),
      })
      .optional(),
    /** DAG: list of phase names this phase depends on */
    depends_on: z.array(z.string()).optional(),
    /** DAG: trigger rule for this phase — when to run based on dependency outcomes */
    trigger_rule: z.enum(["all_success", "one_success", "none_failed_min_one_success", "all_done"]).optional(),
    /** DAG: variable name to store the output of this phase for use in downstream phases */
    output_var: z.string().optional(),
  })
  .refine((p) => !(p.skill && p.skills), {
    message: "phase cannot specify both `skill` and `skills` — use `skills` for multiple",
  })
  .superRefine((p, ctx) => {
    const type = p.type ?? "agent";
    if (type === "bash") {
      if (!p.command) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "phase type `bash` requires `command:`" });
      }
      if (p.script !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`script:` is only valid on type `script`" });
      }
    } else if (type === "script") {
      if (!p.script) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "phase type `script` requires `script:`" });
      }
      if (p.command !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`command:` is only valid on type `bash`" });
      }
    } else {
      // context / agent
      if (p.command !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`command:` is only valid on type `bash`" });
      }
      if (p.script !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`script:` is only valid on type `script`" });
      }
      if (p.runtime !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`runtime:` is only valid on type `script`" });
      }
    }
  });

export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;

/**
 * Normalize a phase's skill declaration to a single list of names.
 * Returns `[]` for phases that have neither `skill` nor `skills`
 * (e.g. `prompt:`-only or `context:` phases).
 */
export function phaseSkillNames(phase: PhaseDefinition): string[] {
  if (phase.skills?.length) return phase.skills;
  if (phase.skill) return [phase.skill];
  return [];
}
export type PhaseLoop = z.infer<typeof PhaseLoopSchema>;
export type GenericLoop = z.infer<typeof GenericLoopSchema>;
export type OutputRule = z.infer<typeof OutputRuleSchema>;

// ── Agent workflow ────────────────────────────────────────────────────
//
// "Agent workflows" are the unified definition for everything Last Light does
// that involves running an agent — whether it's a multi-phase build cycle, a
// single-shot triage, a PR review, a health report, or a custom user-defined
// workflow. Each is a list of phases that the runner executes; simple
// workflows have a single phase, complex ones have many with optional loops,
// approval gates, DAG dependencies, etc.
//
// The `kind` field is purely a categorization label used by the dashboard
// (e.g. to group runs by purpose). The runner ignores it.

/**
 * Intents owned by the harness itself (workflow gates / session control), not by
 * any workflow. A workflow's `classification.intent` may not claim one of these.
 * The classifier keeps their category text + examples in its base prompt template.
 */
export const RESERVED_CONTROL_INTENTS = [
  "approve",
  "reject",
  "status",
  "reset",
  "chat",
] as const;

/**
 * Uppercase prompt token for an intent — the string the classifier emits on its
 * `INTENT:` line and parses back. `qa-test` → `QATEST`, `incident` → `INCIDENT`.
 * Kept here (workflows layer) so the loader's validation and the classifier's
 * prompt/parser derive tokens the same way.
 */
export function intentToken(intent: string): string {
  return intent.toUpperCase().replace(/-/g, "");
}

export const AgentWorkflowSchema = z.object({
  /** Categorization label — e.g. "build", "triage", "review", "health". Free string. */
  kind: z.string().default("agent"),
  name: z.string(),
  description: z.string().optional(),
  /** What can trigger this workflow (informational; routing is in code). */
  trigger: z.string().optional(),
  /**
   * Render progress as a single in-place "task list" comment/message that is
   * edited as phases run, instead of posting a new comment per phase. When
   * true, the runner drives `callbacks.reporter` (see `src/notify/`) and the
   * per-phase `messages.on_*` strings become the one-line detail on each
   * checklist step. Default (absent/false) keeps the legacy one-comment-per-
   * phase behavior. Opt in on chatty multi-phase workflows (build, explore,
   * pr-fix); leave off for single-deliverable workflows (triage, pr-review,
   * health) that post their own result.
   */
  status_checklist: z.boolean().optional(),
  /**
   * Template rendered once at workflow wrap-up (against the accumulated
   * `output_var`s) and delivered as the single final update: set as the
   * footer of the in-place checklist comment when `status_checklist` is on, or
   * posted as one standalone comment otherwise. Renders empty ⇒ no-op. Lets a
   * workflow end with one synthesized result (e.g. verify/qa-test fold their
   * text + browser passes into a single verdict via a final `synthesize` phase
   * whose `output_var` this references) instead of a comment per phase.
   */
  final_message: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
  /**
   * How the free-text intent classifier should route to this workflow. When
   * present, this workflow contributes one category to the composed classifier
   * prompt (`src/engine/screen/classifier.ts`) AND claims the `intent` token:
   * a comment/message the classifier tags with this intent routes here (via the
   * router's `getWorkflowByIntent` fallback) unless a bespoke router branch
   * already handles that intent. The prompt token is derived from `intent`
   * (`intent.toUpperCase().replace(/-/g, "")` — e.g. `qa-test` → `QATEST`).
   * Validated in the loader: `intent` must be unique across workflows and must
   * not collide with a reserved control intent (approve/reject/status/reset/chat).
   */
  classification: z
    .object({
      /** Intent token this workflow owns (e.g. "build", "qa-test", "incident"). */
      intent: z.string(),
      /** The category paragraph, conventionally prefixed with its UPPER token. */
      description: z.string(),
      /** Optional one-line classifier examples (verbatim lines for the prompt). */
      examples: z.array(z.string()).optional(),
    })
    .optional(),
  phases: z.array(PhaseDefinitionSchema),
});

export type AgentWorkflowDefinition = z.infer<typeof AgentWorkflowSchema>;

// ── Cron workflow ─────────────────────────────────────────────────────
//
// Cron workflows are NOT runnable themselves — they describe a schedule that
// triggers another workflow. The `workflow` field is the name of an
// AgentWorkflow to invoke on each tick. (Previously this carried a `skill`
// field referencing the legacy executeSkill path; that path no longer exists.)

export const CronWorkflowSchema = z.object({
  kind: z.literal("cron"),
  name: z.string(),
  schedule: z.string(),
  /** Name of the AgentWorkflow to run on each tick */
  workflow: z.string(),
  /** Static context to merge into the workflow's input on each tick */
  context: z.record(z.string(), z.unknown()).default({}),
  condition: z
    .object({
      unless: z.string().optional(),
    })
    .optional(),
});

export type CronWorkflowDefinition = z.infer<typeof CronWorkflowSchema>;
