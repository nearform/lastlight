import { z } from "zod";
import { TemplatedNumberSchema } from "./templated-number.js";

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
  /**
   * Postcondition marker. The phase FAILS if the agent's final output does not
   * contain this literal substring. Guards against "silent no-op" runs: an
   * agent that inspects context then stops without reaching a verdict or taking
   * an action exits cleanly (`success: true`) today, so an empty run is
   * reported as a false green. Requiring the phase to sign off with an agreed
   * completion marker turns that empty run into a visible failure instead —
   * for action-taking workflows where "the process exited 0" is the wrong
   * success criterion (e.g. dependabot-pr-merge must reach a per-PR verdict).
   */
  requires_marker: z.string().min(1).optional(),
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
    /**
     * Iteration bound. Accepts `{ from: <ctx path>, default: N }` — see
     * {@link TemplatedNumberSchema}; the fix loop reads `fix.localIterations`.
     */
    max_iterations: TemplatedNumberSchema,
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

// ── Fan-out branches (`type: fanout`) ─────────────────────────────────

/**
 * One branch of a `type: fanout` phase — a single agent session run
 * CONCURRENTLY with its siblings inside the phase's one provisioned workspace.
 *
 * `name` is deliberately restricted to `[A-Za-z0-9-]` (no underscores). Every
 * branch gets its own `executions` row keyed `<phase>_branch_<name>`, plus
 * `_retry` / `_check` variants, and {@link PhaseRef.parse} has to split those
 * back apart against a BASE phase name that may itself contain underscores
 * (`survey_contract`). Forbidding `_` in the branch half is what makes the split
 * unambiguous rather than heuristic.
 */
const FanoutBranchSchema = z
  .object({
    /** Branch identity — the ledger key, the skill-bundle key, and the label. */
    name: z
      .string()
      .regex(
        /^[A-Za-z0-9][A-Za-z0-9-]*$/,
        "a fanout branch name must be alphanumeric with hyphens (no underscores — see PhaseRef)",
      )
      .refine((n) => !/-(retry|check)$/.test(n), {
        message: "a fanout branch name may not end in `-retry` or `-check` (reserved ledger suffixes)",
      }),
    /** Prompt template for this branch. Falls back to the phase's own `prompt`. */
    prompt: z.string().optional(),
    /** Skill override for this branch. Falls back to the phase's `skill`/`skills`. */
    skill: z.string().optional(),
    skills: z.array(z.string()).min(1).optional(),
    /** Model / reasoning-effort override. Falls back to the phase's. */
    model: z.string().optional(),
    variant: z.string().optional(),
    /**
     * Post-branch condition, run in the SAME workspace after every branch has
     * joined. Observational, exactly like a `generic_loop.until_bash` on a loop
     * with `max_iterations: 1`: it records a `<phase>_branch_<name>_check`
     * ledger row with `condition_met` / `condition_not_met` and can never fail
     * the phase. Literal shell only — `{{` is rejected, same as everywhere else.
     */
    until_bash: z.string().optional(),
    /** Per-branch timeout for `until_bash` (seconds). */
    timeout_seconds: TemplatedNumberSchema.optional(),
    /**
     * A workspace file whose CONTENTS are appended to this branch's rendered
     * prompt — resolved **relative to the agent's own working directory** and
     * read by the harness, never by the model.
     *
     * **This exists because a path in a prompt is not a path.** Measured across
     * three stored pr-review runs (2026-08-22): of 120 non-spec survey branches,
     * 27 first-turn reads of the per-family obligations file went to
     * `<workspaceRoot>/.lastlight/…` instead of `<checkout>/.lastlight/…` and
     * hit ENOENT; 23 of those branches never recovered. Every single failure
     * was the workspace-root ABSOLUTE form and every one of the 98 relative
     * reads succeeded — the model was joining the prompt's relative path onto
     * the only absolute base it had been handed at that point, the skill bundle
     * (`<workspaceRoot>/.lastlight-skills/<phase>/<skill>/SKILL.md`), which sits
     * one level ABOVE the checkout. Those branches then took the prompt's
     * "if the file does not exist, work the diff directly" escape hatch, so a
     * SEEDED pass silently became an unseeded one and which questions got asked
     * varied per run.
     *
     * Appending the bytes removes the resolution from the model entirely: the
     * harness reads the file at the same base the deterministic phases wrote it
     * (`ProvisionResult.hostAgentCwd`, the host view of the very `cwd` a
     * `type: bash` phase runs in), so the producer and the consumer cannot
     * disagree about where the file is. A file the harness cannot read appends a
     * LOUD notice naming the path instead — "nobody looked" never renders as
     * "looked and found none".
     */
    context_file: z.string().optional(),
  })
  .refine((b) => !(b.skill && b.skills), {
    message: "a fanout branch cannot specify both `skill` and `skills`",
  });

export type FanoutBranch = z.infer<typeof FanoutBranchSchema>;

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
     * - `fanout`: run N agent sessions CONCURRENTLY inside ONE provisioned
     *   workspace. Requires `branches:`. See {@link FanoutBranchSchema} and the
     *   note below.
     *
     * `bash`/`script` phases run in the SAME sandbox/workspace as agent
     * phases (the host workDir persists across phases keyed by taskId), honour
     * `unrestricted_egress`/`sandbox_image`/`timeout_seconds`, and expose
     * their stdout downstream exactly like an agent phase (`output_var` →
     * `{{phaseOutputs.<name>.output}}`). A non-zero exit fails the phase.
     *
     * **Why `fanout` is one node rather than N parallel phases.** Real DAG
     * concurrency is parked (`docs/plans/deterministic-pr-levers.md` §WP5)
     * behind four hard blockers and seven design changes, and that doc records
     * why: *"every hard blocker exists because each phase provisions its own
     * sandbox against a shared workspace"*. A fan-out INSIDE one phase has none
     * of them — one node, one provision, one `current_phase`, one artifact
     * harvest, one dispose. What it gives up is a DAG node per branch; what it
     * keeps (because each branch still goes through the dedup ledger under its
     * own `<phase>_branch_<name>` key) is resume, dedup, per-branch cost
     * attribution and the dashboard's longest-prefix grouping.
     */
    type: z.enum(["context", "agent", "bash", "script", "post-review", "fanout"]).default("agent"),
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
     * Per-step timeout in seconds for `bash`/`script` phases, and for an agent
     * phase's `generic_loop.until_bash` gate. Defaults to the sandbox's
     * configured timeout (fallback 300s for deterministic steps, 30s for a
     * loop condition).
     *
     * Accepts `{ from: <ctx path>, default: N }` — see
     * {@link TemplatedNumberSchema}. `pr-fix` / `dependabot-ci-fix` read
     * `fix.gateTimeoutSeconds` that way, so the repo-clamped config value is
     * what actually bounds the gate.
     */
    timeout_seconds: TemplatedNumberSchema.optional(),
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
     * Conditional gate: skip this phase when any of these expressions matches
     * the run's render context. One string, or a list (OR-ed).
     *
     * Same non-failing skip as `requires_sandbox` above — the node goes
     * `skipped`, a `recordSkippedPhase` row lands, `messages.on_skipped_done`
     * is surfaced, and the **run still records `succeeded`**. That last part is
     * the whole point, and is why this exists rather than being expressed with
     * the pre-existing `on_output.contains_BLOCKED: { action: fail }`: a phase
     * whose *correct* outcome is "there is nothing for the next phase to do"
     * must not paint the run red. A red run posts `messages.on_failure` to the
     * PR, offers the dashboard's Retry button for something that cannot
     * succeed, pollutes the cost/failure stats, and — because
     * `latestSucceededForTrigger` ignores failed runs — defeats the
     * already-handled-this-SHA dedup, so the same dead end is re-diagnosed on
     * every webhook re-fire.
     *
     * Expressions use the `until:` grammar (see `core/loop-eval.ts`) evaluated
     * against `{ ...ctx, phaseOutputs, scratch }` — the same values a prompt
     * template can render. `output` is empty here (the phase has not run), so
     * only bare `output.contains(...)` is meaningless; read what an upstream
     * phase left behind instead. Prefer a value a phase already PARSED into
     * `scratch` (e.g. `scratch.fixMarkers.diagnosis.class == 'flaky'`) over a
     * `.contains()` against `phaseOutputs.<phase>`: the latter is a substring
     * match on the agent's whole free-form output, so prose that merely
     * mentions the needle matches it, and it is empty across a resume boundary
     * (below) where it then fails open.
     *
     * Two scoping notes:
     *   - `phaseOutputs` is empty across a **resume** boundary (a phase skipped
     *     as already-`done` contributes nothing to the in-memory map), so a
     *     guard that must survive resume should read `scratch`, which the run
     *     store rehydrates.
     *   - The guard is evaluated when the node becomes *ready*, i.e. after its
     *     dependencies are terminal — which is what makes reading an upstream
     *     phase's output well-defined.
     *
     * A skipped node is not `succeeded`, so the same `trigger_rule` caveat as
     * `requires_sandbox` applies to anything downstream of a guarded phase.
     */
    skip_if: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
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
    /**
     * The branches of a `type: fanout` phase. Required for that type, rejected
     * on every other. Order is declaration order and is what the results are
     * reported in; it does NOT constrain execution order.
     */
    branches: z.array(FanoutBranchSchema).min(1).optional(),
    /**
     * How many fan-out branches may be in flight at once. Accepts the
     * `{ from: <ctx path>, default: N }` form so an operator dials it from
     * config without forking the workflow.
     *
     * **This is a ceiling the run then clamps further, per backend.** The host
     * has the last word: `gondolin` boots a QEMU micro-VM per agent session in
     * the harness process (WP5's D7 — the nearform host has no swap and has
     * wedged under memory pressure), and `smol`/`kubernetes` are unverified, so
     * all three clamp to 1 and run the branches sequentially. `none` and
     * `docker` take the declared value. A clamp to 1 is byte-identical to
     * running the branches as a chain, which is what makes this safe to ship
     * before the backends are measured.
     */
    max_concurrent: TemplatedNumberSchema.optional(),
    /**
     * What a SOFT branch outcome costs — a clean exit that produced no usable
     * output (`stopReason` `unknown` / `error_truncated`), as opposed to a real
     * crash. Mirrors `generic_loop.on_soft_failure`, and exists as its own
     * phase-level key rather than reusing that name for a reason worth stating:
     * `on_soft_failure` at PHASE level is stripped by zod (it belongs to
     * `generic_loop`), which is exactly how all six survey phases silently ran
     * with `{retries: 0, then: fail}` until 2026-08-22. A distinct key cannot be
     * confused with it, and `fanout-policy.test.ts` pins the EFFECTIVE resolved
     * value off the shipped YAML rather than the key's presence.
     *
     * Absent ⇒ `{ retries: 0, then: "complete" }`. Note the default `then`
     * differs from `generic_loop`'s: a fan-out exists to gather independent
     * evidence, so one degenerate branch must not discard the other five.
     */
    on_branch_soft_failure: z
      .object({
        retries: z.number().int().min(0).default(0),
        then: z.enum(["fail", "complete"]).default("complete"),
      })
      .optional(),
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
      // context / agent / post-review / fanout
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

    // ── Fan-out ──────────────────────────────────────────────────────────────
    if (type === "fanout") {
      if (!p.branches?.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "phase type `fanout` requires a non-empty `branches:`" });
      }
      // A fan-out cannot pause. `pauseForApproval` persists the run as `paused`
      // and RETURNS — under N in-flight sessions there is nothing to return to,
      // and a sibling finishing afterwards would flip the run to `succeeded`
      // over the top of `paused` and orphan the approval row. That is WP5's B2,
      // the one item its own doc calls "silent corruption — the worst in this
      // list", and refusing the combination is how a fan-out never meets it.
      for (const key of ["approval_gate", "approval_artifact", "approval_gate_message"] as const) {
        if (p[key] !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `\`${key}:\` is not supported on type \`fanout\` (a fan-out cannot pause mid-flight)` });
        }
      }
      // The branches ARE the iteration shape; a second one on top of them would
      // multiply concurrent sessions by the loop count with nothing bounding it.
      if (p.loop !== undefined || p.generic_loop !== undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "`loop:`/`generic_loop:` are not supported on type `fanout` — use `branches[].until_bash`" });
      }
      const names = p.branches?.map((b) => b.name) ?? [];
      if (new Set(names).size !== names.length) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "fanout branch names must be unique (they are ledger keys)" });
      }
      // Every branch must be able to build a prompt — `buildPhasePrompt` throws
      // otherwise, and it would throw INSIDE the fan-out where the failure reads
      // as a branch crash rather than as a malformed workflow.
      for (const b of p.branches ?? []) {
        const hasSkills = !!(b.skill || b.skills?.length || p.skill || p.skills?.length);
        if (!b.prompt && !p.prompt && !hasSkills) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `fanout branch \`${b.name}\` has neither \`prompt:\` nor \`skills:\` (and the phase supplies neither)` });
        }
      }
    } else {
      for (const key of ["branches", "max_concurrent", "on_branch_soft_failure"] as const) {
        if (p[key] !== undefined) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: `\`${key}:\` is only valid on type \`fanout\`` });
        }
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

/**
 * Normalize a phase's `skip_if` declaration to a list of expressions.
 * Returns `[]` for phases with no guard. Mirrors {@link phaseSkillNames}.
 */
export function phaseSkipIfExpressions(phase: PhaseDefinition): string[] {
  if (phase.skip_if === undefined) return [];
  return typeof phase.skip_if === "string" ? [phase.skip_if] : phase.skip_if;
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
   * This workflow is dispatched against a PULL REQUEST, and must therefore
   * cross the PR-scoped dispatch gate.
   *
   * Unlike `kind` (a dashboard label the runner ignores) this one is
   * load-bearing. Declaring it puts the workflow inside:
   *
   *   - the **PR-scoped run lock** — one PR-scoped run per PR at a time, across
   *     every member, so two agents never clone and push the same branch;
   *   - the **already-assessed-at-this-head-SHA dedup**, per workflow;
   *   - **escalation** — a terminal skip labels the PR and comments once,
   *     rather than being dropped silently;
   *   - the resolved **`PrState` snapshot** on `context.prState`, which is what
   *     the fix prompts, the PR journal and the admin panel all render from.
   *
   * It is metadata on the workflow because that is where the fact lives. The
   * harness used to carry a hardcoded set of four names while the handlers are
   * operator-configurable through `routes.github.*`, so remapping a route to a
   * forked workflow silently dropped the whole gate for it — no lock, no dedup,
   * no escalation, and no warning (issue #256). `validateAssets` now warns when
   * a configured `routes.github.pr_*` target does not declare this.
   *
   * The consuming set is `prScopedWorkflows()` in
   * `apps/server/src/workflows/pr-scope.ts`.
   */
  pr_scoped: z.boolean().optional(),
  /**
   * What the GitHub token minted for this workflow's sandbox may DO.
   *
   * A sibling of `pr_scoped` and load-bearing in the same way: it selects the
   * permission profile (`GITHUB_PERMISSION_PROFILES` in
   * `apps/server/src/engine/github/profiles.ts`) that the harness mints an
   * installation token against and forwards as `GITHUB_TOKEN`, and it decides
   * the agentic github-tool set the sandbox is given.
   *
   *   - `read` — contents:read. The default, and the right answer for anything
   *     that never writes to GitHub.
   *   - `issues-write` — contents:read + issues:write + pull_requests:write
   *     (the last is needed to comment on a PR at all). Workflows that read the
   *     repo and post a findings/answer/demo comment but never push code.
   *   - `review-write` — as above plus the ability to SUBMIT a formal review on
   *     a pull request. `pr-review`'s profile.
   *   - `repo-write` — contents:write. The code-pushing profiles, plus
   *     `dependabot-pr-merge`, which never pushes but needs
   *     `github_enable_auto_merge` (that tool lives in the repo-write profile).
   *
   * `repo-write` also switches the sandbox pre-clone OFF `--depth 1`: only the
   * pushing profiles keep the deeper clone for rebase/amend headroom
   * (`shallow` in `gitSandboxAccessForWorkflow`).
   *
   * This used to be a `switch` over literal workflow names in
   * `workflows/runner.ts`, so a workflow that exists only in a deployment
   * overlay could never be anything but `read` — a reviewer arm shipped in an
   * overlay silently could not submit its review (issue #368). Unlike
   * `pr_scoped`, this key does not merely add restrictions: an overlay
   * declaring `repo-write` mints itself a push token. That is deliberate —
   * overlays already own prompts, skills and the agent persona, and are
   * trusted.
   */
  git_access: z.enum(["read", "issues-write", "review-write", "repo-write"]).optional(),
  /**
   * How this workflow's sandbox workspace is KEYED and how a re-run treats an
   * existing checkout.
   *
   *   - `per-run` (default) — a fresh workspace per run, keyed by
   *     (repo, issue, workflow, run-id). Reaped on success.
   *
   *   - `per-target-reuse` — the workspace is keyed by **(repo, PR)** rather
   *     than per-run. The taskId drops the run-id suffix so re-reviews of the
   *     same PR (push → `synchronize`, cron PR-review fanout) reuse one sandbox
   *     dir — a warm `node_modules` + an incremental `git fetch` instead of a
   *     fresh 1.3G clone + full install each time, and N dirs/PR collapse to 1
   *     (issue #107, cutting the #106 churn at its source). Concurrency is held
   *     off by the dispatcher's `isRunning(skill, triggerId)` guard plus
   *     `runs.getByTrigger` reuse — two runs never share the dir live; the
   *     cross-run refresh in `prePopulateWorkspace` resets it cleanly between
   *     them. `dependabot-pr-merge` uses this despite having no checkout at
   *     all: it is always single-PR (webhook or the cron's per-PR fan-out), so
   *     a repeated `pr.checks_passed` and the daily cron backstop for the same
   *     PR dedup onto one dir/run rather than stacking.
   *
   *   - `per-target-recreate` — keyed by (repo, issue) exactly like
   *     `per-target-reuse`, but a *different*-run marker triggers a delete +
   *     fresh clone off the DEFAULT branch, not a `git fetch`/reset of the
   *     (stale) feature branch. This makes an incomplete `build` disposable:
   *     re-triggering it starts again from current `main` (issue #153). A
   *     genuine *resume* of the same run (approval gate) still preserves the
   *     workspace via the same-run marker — the architect's `plan.md` survives.
   *     Concurrency is held off by the same `isRunning` guard, so the delete
   *     only ever hits a leftover from a finished/abandoned run. `build` must
   *     not merely *refresh* a stale checkout — that would reset onto the old
   *     feature branch.
   *
   * Neither per-target class is reaped on success (`reapOnSuccess`): they are a
   * warm cache whose eviction belongs to the backstop TTL/LRU sweep.
   *
   * Was two hardcoded name sets in `workflows/target-policy.ts`, which could
   * also express the illegal state "both" (issue #368).
   */
  workspace: z.enum(["per-run", "per-target-reuse", "per-target-recreate"]).optional(),
  /**
   * This workflow synthesizes its own `lastlight/N-slug` branch (which doesn't
   * exist on the remote at dispatch time) yet should still PRE-POPULATE the
   * sandbox: the agent's cwd becomes the repo root (no `git clone`/`cd`), and —
   * for the read-only `verify`/`qa-test` runs — server-mode artifacts the agent
   * writes to `.lastlight/<key>/` (e.g. browser-QA screenshots) land where
   * `serverArtifacts()` harvests them instead of being orphaned a level up.
   * `build` was the original member; verify/qa-test were added for the harvest
   * fix, and `demo` for the same reason (its `demo.mp4` is written under
   * `.lastlight/<key>/` and harvested into the Artifacts store).
   *
   * For a fresh (issue-scoped) dispatch the dispatcher leaves
   * `prePopulateBranch` unset and the missing-branch fallback in
   * `prePopulateWorkspace` clones the default branch — correct for
   * `build`/`demo`, which *create* the synth branch off the default. But when
   * the *same* workflow runs against an existing PR, the synth
   * `lastlight/<prNumber>-<title-slug>` name won't match the PR's real head ref
   * (named after the originating issue), so the fallback would clone the
   * default branch and test/demo code that lacks the PR — see
   * {@link prepopulate_pr_head_ref}, the orthogonal key that fixes that.
   */
  prepopulate_synth_branch: z.boolean().optional(),
  /**
   * When there IS a real pull request, pin the pre-populated workspace to the
   * PR's *real* head ref (via `getPullRequest(...).head.ref`) instead of
   * letting it fall back to the synthesized `lastlight/N-<title-slug>` name.
   *
   * Each workflow that declares this is meaningful only against an existing PR,
   * and the synth name never matches the PR's actual branch (which is named
   * after the originating issue, e.g. `lastlight/14-…` for a PR #15). Without
   * this pinning:
   *   - `qa-test` / `verify` QA the *base* branch and report the PR's feature
   *     missing — a false-negative result.
   *   - `demo`'s "after" collapses onto the default branch, matching "before".
   *
   * Orthogonal to {@link prepopulate_synth_branch} — "pre-populate even though
   * my branch is synthesized" and "when there is a real PR, pin to its head
   * ref" are different facts, and three workflows declare both. `pr_fix_shaped`
   * workflows get head-ref pinning implicitly (they also plumb `branch` through
   * context for the architect/executor to push to), so they need not declare
   * this. See the resolution block in `dispatchWorkflow` (src/index.ts).
   */
  prepopulate_pr_head_ref: z.boolean().optional(),
  /**
   * This workflow is shaped like `pr-fix`: dispatched off a PR event, it
   * resolves the PR's head branch + failed-check details and pushes a fix to
   * that branch.
   *
   * The dispatcher routes every workflow declaring this through `handlePrFix`
   * (branch resolution, CI failure summary, fork-PR skip), and
   * `dispatchWorkflow` honours the `branch` they plumb through context as the
   * pre-populate branch. It is also the family the fix ledger keys on: shared
   * per-PR workspace (`${repo}-${N}-fix`), the `models["pr-fix-retry"]`
   * escalation, the fix-marker harvest, and the admin PR-retry route's
   * "which workflow last worked this PR" lookup.
   *
   * `dependabot-ci-fix` (fix a failing dependency-update PR, then auto-merge
   * trivial ones) is the second member.
   *
   * Requires `pr_scoped: true` — the loader enforces it. Being routed through
   * `handlePrFix` only makes sense inside the PR gate, and the two built-in
   * members have always been a strict subset of the PR-scoped set.
   */
  pr_fix_shaped: z.boolean().optional(),
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
  /**
   * How the CHAT agent should ADVERTISE this workflow to a human — the phrase it
   * tells someone to type in Slack, and the one-line summary of what they get.
   *
   * Deliberately separate from `classification:`, and an explicit opt-in rather
   * than a derivation from it, because the two answer different questions.
   * `classification:` says "the classifier can tag a message with this intent";
   * this says "a human should be told to type this in chat". Those diverge in
   * both directions:
   *
   *   - `demo` declares a `classification:` block and a `routes.slack.demo`
   *     entry, but the Slack switch in `router.ts` has no `demo` branch and
   *     `demo` sits in `WELL_KNOWN_INTENTS`, so `fallbackWorkflowForIntent`
   *     returns undefined for it and a `demo`-classified message falls through
   *     to plain chat. Advertising it would send users at a dead route.
   *   - `dependabot-ci-fix` / `dependabot-pr-merge` are genuinely reachable from
   *     a Slack message (they're outside `WELL_KNOWN_INTENTS`, so the `default:`
   *     fallback dispatches them) but would arrive with a repo and no PR number.
   *     Nobody should be told to type those.
   *
   * So the gate is the presence of THIS block and nothing else — `classification:`
   * is not consulted. Absence means silence, which is the right default for those
   * three plus every workflow with no `classification:` at all (`pr-fix`, the
   * crons). Consumed by `assembleChatPrompt()` in
   * `src/engine/chat/chat-prompt.ts`, which composes the chat system prompt from
   * the ENABLED workflow set the way `assembleClassifier()` composes the
   * classifier prompt (issue #164) — so an overlay workflow that declares this
   * gets advertised with no core edit, and one an operator disables stops being
   * advertised.
   */
  chat: z
    .object({
      /**
       * The verbatim phrase to tell a user to type, e.g. `triage owner/repo`.
       * Natural language — never with a leading `/`, which Slack intercepts
       * before it reaches Last Light.
       *
       * OPTIONAL, because a workflow may want a chat bullet without being
       * chat-triggerable at all: `repo-health` runs on a cron and has no
       * `classification:` block, but the chat agent still needs to know what to
       * say when someone asks for a health report. Such an entry supplies
       * `reply` instead and never appears in the suggestable-trigger list.
       */
      trigger: z.string().optional(),
      /** One line naming what the user gets, e.g. "Triage open issues on a repo". */
      summary: z.string(),
      /**
       * Optional user phrasings that should be DEFLECTED to this workflow rather
       * than attempted in-process — the "if they ask for this, name the trigger
       * and stop" list. Rendered verbatim; falls back to `summary` when absent.
       */
      deflect: z.array(z.string()).optional(),
      /**
       * Optional override for the deflection reply. Defaults to
       * ``tell me `<trigger>` ``. Set it when naming the trigger isn't the right
       * answer — `answer`'s research path needs the user to include a managed
       * repo, and `repo-health` has to explain that it's cron-only.
       */
      reply: z.string().optional(),
    })
    .refine((c) => c.trigger !== undefined || c.reply !== undefined, {
      message: "chat: needs a `trigger` (what to type) or a `reply` (what to say instead)",
    })
    .optional(),
  phases: z.array(PhaseDefinitionSchema),
});

export type AgentWorkflowDefinition = z.infer<typeof AgentWorkflowSchema>;

// ── Cron workflow ─────────────────────────────────────────────────────
//
// Cron workflows are NOT runnable themselves — they describe a schedule that
// triggers WORK. That work is one of exactly two things, and a definition names
// precisely one of them:
//
//   `workflow:` — the name of an AgentWorkflow to dispatch on each tick. The
//                 normal case: the tick fans out one sandboxed agent run per
//                 managed repo.
//   `handler:`  — the name of a HOST-SIDE handler, resolved at boot against a
//                 registry the runtime supplies. No sandbox, no agent, no run
//                 row: the handler is plain code in the harness process.
//
// `handler:` exists because some periodic work is structurally un-agentable.
// The repo digest is the motivating case: its facts live in the harness's own
// SQLite (which a sandboxed phase cannot reach) and it posts to Slack (which no
// agent has a tool for). Such a cron could be registered with the scheduler's
// `registerDirect`, as the sandbox sweep and feedback poll are — but a direct
// job is invisible to `getCronWorkflows()`, so it gets no dashboard toggle, no
// `cron_overrides` schedule, no per-repo participation and, worst of all, no
// "Run now". Declaring it here buys all of that for the cost of one field.
//
// (Previously this carried a `skill` field referencing the legacy executeSkill
// path; that path no longer exists.)

export const CronWorkflowSchema = z
  .object({
    kind: z.literal("cron"),
    name: z.string(),
    schedule: z.string(),
    /** Name of the AgentWorkflow to run on each tick. Mutually exclusive with `handler`. */
    workflow: z.string().optional(),
    /** Name of a host-side handler to invoke on each tick. Mutually exclusive with `workflow`. */
    handler: z.string().optional(),
    /** Static context to merge into the workflow's input on each tick */
    context: z.record(z.string(), z.unknown()).default({}),
    condition: z
      .object({
        unless: z.string().optional(),
      })
      .optional(),
  })
  // Exactly one, never both and never neither: the two are different execution
  // paths, so a definition carrying both would silently pick one and a
  // definition carrying neither would register a cron that ticks into the void.
  .refine((def) => !!def.workflow !== !!def.handler, {
    message: "a cron must declare exactly one of `workflow:` or `handler:`",
    path: ["workflow"],
  });

export type CronWorkflowDefinition = z.infer<typeof CronWorkflowSchema>;
