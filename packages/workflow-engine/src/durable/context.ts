/**
 * `WorkflowContext` — the authoring surface a code-defined workflow sees (spike).
 *
 * Every method is a thin layer over {@link DurableStep}: agent runs, bash
 * commands and notifications are memoized steps; approvals are a memoized
 * "request" step followed by a durable signal wait. Because step outputs are
 * persisted, a resumed run gets the SAME `AgentResult` back for a completed
 * phase — the YAML engine's "phaseOutputs are empty after resume" caveat does
 * not exist here.
 */

import type { AgentPort, AssetLoader, LoggerPort } from "../ports/ports.js";
import { noopLogger } from "../ports/ports.js";
import type { ExecutionResult, ExecutorConfig, GitAccessProfile } from "../core/types.js";
import { renderTemplate, type TemplateContext } from "../core/templates.js";
import { approvalSignal, type DurableStep, type Json } from "./step.js";

/** The persisted input of a run — everything `ctx` is rebuilt from on resume. */
export interface WorkflowInput {
  /** Template variables for prompts/messages (owner, repo, issueNumber, branch, issueDir, …). */
  vars: Record<string, Json>;
  models?: Record<string, string>;
  variants?: Record<string, string>;
  /** Approval gates enabled for this run (positive-enable, like `approval:` config). */
  gates?: Record<string, boolean>;
  timeouts?: { phaseSeconds?: number; gateSeconds?: number };
}

/** The serialisable slice of an {@link ExecutionResult} a step persists. */
export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  stopReason?: string;
  sessionId?: string;
  costUsd?: number;
  durationMs?: number;
}

export interface ApprovalDecision {
  approved: boolean;
  /** For `kind: "reply"` gates: the human's reply text. */
  reply?: string;
  reason?: string;
  by?: string;
}

export interface ApprovalRequest {
  runId: string;
  gate: string;
  kind: "approve" | "reply";
  summary: string;
  /** Renders the "review & decide" message once the approval id (→ `approvalUrl`) exists. */
  message?: (approvalId: string) => string;
  artifact?: string;
}

/** App-supplied services. Same ports the YAML engine uses, plus approvals. */
export interface WorkflowServices {
  agent: AgentPort;
  assets: AssetLoader;
  /** Base executor config (sandbox, cwd, taskId plumbing) for every agent/bash step. */
  baseConfig: (input: WorkflowInput) => ExecutorConfig;
  /** Persist an approval row + post the "review & decide" message; returns its id. */
  approvals?: {
    request(req: ApprovalRequest): Promise<{ approvalId: string }>;
    /**
     * The decision already recorded for this gate, if any. The runtime's
     * signals are not buffered — a signal sent while no step is waiting is
     * dropped — so the approval row stays the source of truth and is checked
     * before parking (covers a crash between "request" and "wait").
     */
    decision?(runId: string, gate: string): Promise<ApprovalDecision | null>;
  };
  /** Post a progress line (checklist note / comment). */
  notify?: (runId: string, message: string) => Promise<void>;
  /** Phase lifecycle hooks — the dashboard/evals attribution seam (`onPhaseStart/End` today). */
  hooks?: {
    onStepStart?(runId: string, name: string): void | Promise<void>;
    onStepEnd?(runId: string, name: string, result: AgentResult): void | Promise<void>;
  };
  log?: LoggerPort;
}

export interface AgentStepOptions {
  /**
   * Prompt template path, resolved through the layered AssetLoader. Omit for a
   * skill-only phase: the agent is told to use `skills[0]` with the run vars
   * as context (the YAML engine's `buildPhasePrompt` fallback).
   */
  prompt?: string;
  /** Extra template variables merged over `input.vars`. */
  vars?: Record<string, Json>;
  model?: string;
  variant?: string;
  skills?: string[];
  timeoutSeconds?: number;
  access?: GitAccessProfile;
  unrestrictedEgress?: boolean;
  webSearch?: boolean;
  sandboxImage?: "default" | "qa";
  commandPolicy?: ExecutorConfig["commandPolicy"];
}

export interface BashStepOptions {
  timeoutSeconds?: number;
  vars?: Record<string, Json>;
}

export interface ApprovalOptions {
  summary: string;
  /** `reply` gates wait for free text (explore's Socratic loop); default `approve`. */
  kind?: "approve" | "reply";
  /** Message template (rendered with `approvalUrl`/`approvalId` available). */
  message?: string;
  artifact?: string;
  /** How long the run may stay parked. Default 30 days. */
  timeout?: string;
}

export interface WorkflowContext {
  readonly runId: string;
  readonly input: WorkflowInput;
  readonly vars: Record<string, Json>;
  readonly log: LoggerPort;
  /**
   * In-memory, per-execution scratch for values derived during the run. NOT
   * persisted: anything that must survive a replay is recomputed from step
   * results, which are. (The YAML engine's `scratch` was persisted because
   * phase outputs were not.)
   */
  readonly scratch: Record<string, unknown>;
  /** Dotted-path read over `vars` (then `scratch`) — the YAML `{{a.b}}` / `skip_if` lookup. */
  get(path: string): unknown;
  /** A numeric budget read from the run input, e.g. `num("gate.timeoutSeconds", 900)`. */
  num(path: string, fallback?: number): number | undefined;
  model(role: string): string | undefined;
  variant(role: string): string | undefined;
  gateEnabled(gate: string): boolean;
  /** Generic memoized step for deterministic TS work (parsing, GitHub calls, …). */
  step<T>(name: string, fn: () => Promise<T>): Promise<T>;
  agent(name: string, opts: AgentStepOptions): Promise<AgentResult>;
  bash(name: string, command: string, opts?: BashStepOptions): Promise<AgentResult>;
  /** Pause for a human decision. Returns the decision; a timeout counts as a rejection. */
  approval(gate: string, opts: ApprovalOptions): Promise<ApprovalDecision>;
  notify(name: string, message: string, vars?: Record<string, Json>): Promise<void>;
  sleep(name: string, duration: string): Promise<void>;
  /**
   * Run `fn` over `items` with at most `max` in flight. Each branch MUST name
   * its steps uniquely (e.g. suffix with the item id) — names are the memo key.
   */
  parallel<I, O>(items: readonly I[], opts: { max: number }, fn: (item: I, index: number) => Promise<O>): Promise<O[]>;
  render(template: string, vars?: Record<string, Json>): string;
}

function toAgentResult(r: ExecutionResult): AgentResult {
  const out: AgentResult = { success: r.success, output: r.output ?? "" };
  if (r.error !== undefined) out.error = r.error;
  if (r.stopReason !== undefined) out.stopReason = r.stopReason;
  if (r.sessionId !== undefined) out.sessionId = r.sessionId;
  if (r.costUsd !== undefined) out.costUsd = r.costUsd;
  if (r.durationMs !== undefined) out.durationMs = r.durationMs;
  return out;
}

function skillPrompt(skills: readonly string[], vars: Record<string, Json>): string {
  if (!skills.length) throw new Error("agent step needs a prompt or at least one skill");
  const [primary, ...rest] = skills;
  const context = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
    .join("\n");
  return [
    `Use the **${primary}** skill to handle this request.`,
    rest.length ? `Other skills available if you need them: ${rest.join(", ")}.` : "",
    "Context:",
    context,
  ]
    .filter(Boolean)
    .join("\n");
}

export function createWorkflowContext(
  step: DurableStep,
  services: WorkflowServices,
  runId: string,
  input: WorkflowInput,
): WorkflowContext {
  const log = services.log ?? noopLogger;
  const render = (template: string, vars?: Record<string, Json>) =>
    renderTemplate(template, { ...input.vars, ...vars } as unknown as TemplateContext);

  const tracked = async (name: string, fn: () => Promise<AgentResult>) =>
    step.run(name, async () => {
      await services.hooks?.onStepStart?.(runId, name);
      const result = await fn();
      await services.hooks?.onStepEnd?.(runId, name, result);
      return result;
    });

  const scratch: Record<string, unknown> = {};
  const get = (path: string): unknown => {
    const read = (root: unknown) => {
      let cur = root;
      for (const part of path.split(".")) {
        if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
        cur = (cur as Record<string, unknown>)[part];
      }
      return cur;
    };
    return path.startsWith("scratch.") ? read({ scratch }) : read(input.vars);
  };

  const ctx: WorkflowContext = {
    runId,
    input,
    vars: input.vars,
    log,
    scratch,
    get,
    num(path, fallback) {
      const v = get(path);
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      return Number.isFinite(n) && n > 0 ? n : fallback;
    },
    model: (role) => input.models?.[role],
    variant: (role) => input.variants?.[role],
    gateEnabled: (gate) => input.gates?.[gate] === true,
    step: (name, fn) => step.run(name, fn),
    sleep: (name, duration) => step.sleep(name, duration),
    render,

    agent(name, opts) {
      return tracked(name, async () => {
        const prompt = opts.prompt
          ? render(services.assets.loadPromptTemplate(opts.prompt), opts.vars)
          : skillPrompt(opts.skills ?? [], { ...input.vars, ...opts.vars });
        const config: ExecutorConfig = { ...services.baseConfig(input) };
        if (opts.model) config.model = opts.model;
        if (opts.variant) config.variant = opts.variant;
        if (opts.skills?.length) config.skillPaths = services.assets.resolveSkillPaths(opts.skills);
        if (opts.unrestrictedEgress !== undefined) config.unrestrictedEgress = opts.unrestrictedEgress;
        if (opts.webSearch !== undefined) config.webSearch = opts.webSearch;
        if (opts.sandboxImage !== undefined) config.sandboxImage = opts.sandboxImage;
        if (opts.commandPolicy !== undefined) config.commandPolicy = opts.commandPolicy;
        const owner = String(input.vars.owner ?? "");
        const repo = String(input.vars.repo ?? "");
        const result = await services.agent.runAgent(prompt, config, {
          taskId: typeof input.vars.taskId === "string" ? input.vars.taskId : undefined,
          timeoutSeconds: opts.timeoutSeconds,
          githubAccess: opts.access ? { owner, repo, profile: opts.access } : undefined,
        });
        return toAgentResult(result);
      });
    },

    bash(name, command, opts = {}) {
      return tracked(name, async () => {
        const result = await services.agent.runCommand(
          { kind: "bash", command: render(command, opts.vars) },
          services.baseConfig(input),
          {
            taskId: typeof input.vars.taskId === "string" ? input.vars.taskId : undefined,
            timeoutSeconds: opts.timeoutSeconds,
          },
        );
        return toAgentResult(result);
      });
    },

    async approval(gate, opts) {
      await step.run(`approval:${gate}:request`, async () => {
        if (!services.approvals) throw new Error(`approval gate "${gate}" reached but no approvals service is wired`);
        const { approvalId } = await services.approvals.request({
          runId,
          gate,
          kind: opts.kind ?? "approve",
          summary: opts.summary,
          artifact: opts.artifact,
          message: opts.message ? (approvalId) => render(opts.message!, { approvalId }) : undefined,
        });
        return approvalId;
      });
      const recorded = await services.approvals?.decision?.(runId, gate);
      if (recorded) return recorded;
      const got = await step.waitForSignal<ApprovalDecision>(
        `approval:${gate}`,
        approvalSignal(runId, gate),
        opts.timeout ?? "30d",
      );
      return got?.data ?? { approved: false, reason: "approval timed out" };
    },

    async notify(name, message, vars) {
      if (!services.notify) return;
      await step.run(`notify:${name}`, async () => {
        await services.notify!(runId, render(message, vars));
      });
    },

    async parallel(items, { max }, fn) {
      const results = new Array(items.length);
      let next = 0;
      const lane = async () => {
        while (next < items.length) {
          const i = next++;
          results[i] = await fn(items[i], i);
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(max, items.length)) }, lane));
      return results;
    },
  };
  return ctx;
}
