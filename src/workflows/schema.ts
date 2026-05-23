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
    /** context: no agent execution (just metadata); agent: run an agent session */
    type: z.enum(["context", "agent"]).default("agent"),
    /**
     * Path to a prompt template file (relative to workflowDir).
     * Mutually exclusive with `skill`.
     */
    prompt: z.string().optional(),
    /**
     * Name of a skill in skills/<name>/SKILL.md to load as the agent's
     * instructions. Mutually exclusive with `prompt`. The runner reads the
     * SKILL.md and renders it the same way the legacy executeSkill did:
     *     "Follow these skill instructions:\n\n<SKILL.md>\n\nContext:\n<ctx>"
     * Use this for single-phase skill-style workflows (triage, review, etc.).
     */
    skill: z.string().optional(),
    /** Model override — can reference template vars like {{models.architect}} */
    model: z.string().optional(),
    /**
     * Reasoning-effort override — can reference template vars like
     * `{{variants.architect}}`. Maps to agentic-pi's thinking level
     * (`off | minimal | low | medium | high | xhigh`). pi-ai translates
     * this into each provider's reasoning-effort API.
     */
    variant: z.string().optional(),
    /** Named approval gate to pause at after this phase */
    approval_gate: z.string().optional(),
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
  .refine((p) => !(p.prompt && p.skill), {
    message: "phase cannot specify both `prompt` and `skill` — pick one",
  });

export type PhaseDefinition = z.infer<typeof PhaseDefinitionSchema>;
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

export const AgentWorkflowSchema = z.object({
  /** Categorization label — e.g. "build", "triage", "review", "health". Free string. */
  kind: z.string().default("agent"),
  name: z.string(),
  description: z.string().optional(),
  /** What can trigger this workflow (informational; routing is in code). */
  trigger: z.string().optional(),
  variables: z.record(z.string(), z.string()).optional(),
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
