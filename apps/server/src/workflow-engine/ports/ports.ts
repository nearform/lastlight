/**
 * The workflow engine's injected ports — the concrete couplings the app layer
 * supplies so the engine stays domain-agnostic (no imports of `../engine`,
 * `../state`, `../notify`, `../admin`, `../config`, GitHub, or better-sqlite3).
 *
 * The app's existing concrete types already satisfy these structurally, so
 * introducing each port is a type-only change: the default adapters (built in
 * `src/workflows/runner.ts`) are thin delegations to the real functions.
 */

import type {
  ExecutorConfig,
  ExecutionResult,
  GitSandboxAccess,
  CommandSpec,
} from "../core/types.js";
import type { PhaseDefinition } from "../core/schema.js";
import type { DagNode } from "../core/dag.js";
import type { TemplateContext } from "../core/templates.js";
import type { ParsedVerdict } from "../core/verdict.js";

// ── Progress / notification vocabulary (was in src/notify/types.ts) ──────────
//
// StepStatus + ProgressStep are the engine's reporting vocabulary; the app's
// `src/notify/types.ts` re-exports them so its renderer/transport code keeps
// importing them from the same place.

/** Lifecycle state of a single checklist step. */
export type StepStatus =
  | "pending"
  | "running"
  | "done"
  | "blocked"
  | "awaiting"
  | "failed"
  | "skipped";

/** One row in the task list. `key` is stable; `label` is what humans see. */
export interface ProgressStep {
  key: string;
  label: string;
  status: StepStatus;
  /** Optional one-line context shown after the label (e.g. a link or status). */
  detail?: string;
}

// ── Engine result / outcome vocabulary ───────────────────────────────────────

export interface PhaseResult {
  phase: string;
  success: boolean;
  output: string;
  error?: string;
}

export interface WorkflowResult {
  success: boolean;
  phases: PhaseResult[];
  prNumber?: number;
  paused?: boolean;
}

/** The delta a single `execute(node, outputs)` returns to the scheduler. */
export interface PhaseOutcome {
  results: PhaseResult[];
  status: "succeeded" | "failed" | "skipped";
  /** Approval / reply gate hit — scheduler returns `{ success: true, paused: true }`. */
  paused?: boolean;
  /**
   * Dedup running-skip — another instance is mid-flight on this exact phase.
   * Scheduler stops the whole run immediately with `success: false` and does
   * NOT cascade skips (it isn't a phase failure).
   */
  aborted?: boolean;
  /** Output map additions to merge into the scheduler's accumulated outputs. */
  outputVars?: Record<string, unknown>;
}

// ── AgentPort — the agent/sandbox seam ───────────────────────────────────────

export interface AgentRunOpts {
  taskId?: string;
  githubAccess?: GitSandboxAccess;
  onSessionId?: (sessionId: string) => void;
  timeoutSeconds?: number;
  sandboxEnv?: Record<string, string>;
  writeSession?: boolean;
}

/**
 * Replaces the direct `executeAgent` / `executeCommand` imports in the phase
 * executor. Signatures mirror `src/engine/agent-executor.ts`.
 */
export interface AgentPort {
  runAgent(prompt: string, config: ExecutorConfig, opts: AgentRunOpts): Promise<ExecutionResult>;
  runCommand(spec: CommandSpec, config: ExecutorConfig, opts: AgentRunOpts): Promise<ExecutionResult>;
}

// ── WorkflowStateStore — runs + dedup ledger ─────────────────────────────────
//
// The observed method surface of `StateDb`'s `runs` + `executions` sub-stores.
// `StateDb` already implements it (a future divergence surfaces via the
// `StateDb satisfies WorkflowStateStore` contract test). Domain types are
// re-declared here (structural subsets of the real ones) so the engine never
// type-depends on `../state`.

export interface PhaseHistoryEntry {
  phase: string;
  timestamp: string;
  success: boolean;
  summary?: string;
}

/** A non-agent phase marker folded into an atomic lifecycle op. */
export interface PhaseMarker {
  phase: string;
  summary?: string;
}

/** The subset of a workflow run the engine reads. */
export interface WorkflowRunView {
  status: "running" | "paused" | "succeeded" | "failed" | "cancelled";
  scratch?: Record<string, unknown>;
}

/** The approval row the engine asks the store to create when pausing. */
export interface NewApproval {
  id: string;
  workflowRunId: string;
  gate: string;
  summary: string;
  kind: "approve" | "reply";
  artifact?: string;
  requestedBy?: string;
  createdAt: string;
}

/** The row the engine records when a phase starts. */
export interface NewExecution {
  id: string;
  triggerType: "webhook" | "cron" | "chat" | "api";
  triggerId: string;
  skill: string;
  repo?: string;
  issueNumber?: number;
  startedAt: string;
  workflowRunId?: string;
}

/** The fields the engine records when a phase finishes. */
export interface ExecutionFinish {
  success: boolean;
  error?: string;
  turns?: number;
  durationMs?: number;
  sessionId?: string;
  costUsd?: number;
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  apiDurationMs?: number;
  stopReason?: string;
  extensionStatus?: string;
  skillsStatus?: string;
}

export interface FinishOpts {
  error?: string;
  terminalMarker?: PhaseMarker;
}

export interface RunStore {
  getRun(id: string): WorkflowRunView | null;
  appendPhase(id: string, phase: string, entry: PhaseHistoryEntry): void;
  finishRun(id: string, status: "succeeded" | "failed" | "cancelled", opts?: FinishOpts): void;
  mergeScratch(id: string, patch: Record<string, unknown>): void;
  pauseForApproval(runId: string, approval: NewApproval, marker: PhaseMarker, scratchPatch?: Record<string, unknown>): void;
}

export interface ExecutionLedger {
  shouldRunPhase(dedupKey: string, triggerId: string, workflowRunId?: string): "run" | "running" | "done";
  markStaleAsFailed(dedupKey: string, triggerId: string, workflowRunId?: string): number;
  markLatestAsFailed(dedupKey: string, triggerId: string, reason: string, workflowRunId?: string): number;
  recordStart(row: NewExecution): void;
  recordFinish(id: string, result: ExecutionFinish): void;
  recordSessionId(id: string, sessionId: string): void;
  recordOutputText(id: string, text: string): void;
  recordSkippedPhase(dedupKey: string, triggerId: string, workflowRunId?: string, repo?: string): void;
  getPhaseOutput(dedupKey: string, triggerId: string, workflowRunId?: string): string | null;
  getExecutionOutput(id: string): string | null;
}

export interface WorkflowStateStore {
  runs: RunStore;
  executions: ExecutionLedger;
}

// ── AssetLoader — prompts + skills ───────────────────────────────────────────

export interface AssetLoader {
  loadPromptTemplate(relativePath: string): string;
  resolveSkillPaths(names: readonly string[]): string[];
}

// ── LivenessPort — container liveness (tiny) ─────────────────────────────────

export interface LivenessPort {
  isPhaseContainerAlive(taskId: string): Promise<boolean>;
}

// ── ObservabilityPort — telemetry (spans + metrics) ──────────────────────────
//
// The engine's dedup ledger is instrumented; the app owns the OTEL SDK, so the
// engine takes an injected observability seam instead of importing
// `../telemetry`. The default adapter wraps the real helpers; the test/no-op
// impl runs `fn` directly and drops metrics.

export interface EngineSpan {
  addEvent(name: string, attrs?: Record<string, unknown>): void;
  setAttributes(attrs: Record<string, unknown>): void;
}

export interface ObservabilityPort {
  withSpan<T>(name: string, attrs: Record<string, unknown>, fn: (span?: EngineSpan) => Promise<T> | T): Promise<T>;
  recordExecutionMetrics(surface: string, attrs: Record<string, unknown>): void;
  recordError(surface: string, error: unknown, attrs: Record<string, unknown>): void;
}

// ── PhaseReporter — progress / notification surface ──────────────────────────

export interface ReportStepOpts {
  label?: string;
  insertBefore?: string;
  insert?: boolean;
  alsoNote?: boolean;
}

/** Progress / notification surface — the reporting collaborator. */
export interface PhaseReporter {
  onStart(phase: string): Promise<void>;
  onEnd(phase: string, result: PhaseResult): Promise<void>;
  /** Transition a checklist step (and optionally render a YAML message detail). */
  step(
    key: string,
    status: StepStatus,
    template?: string,
    extraCtx?: Partial<TemplateContext>,
    opts?: ReportStepOpts,
  ): Promise<void>;
  /** Render a YAML message template and post it as a standalone note. */
  message(template: string | undefined, extraCtx?: Partial<TemplateContext>): Promise<void>;
  /**
   * Render a YAML message template and post it as an *interactive approval
   * prompt* (Approve/Reject buttons on rich surfaces, plain text elsewhere).
   */
  approvalNote(
    template: string | undefined,
    extraCtx: Partial<TemplateContext>,
    meta: { workflowRunId: string },
  ): Promise<void>;
  /** Post a pre-rendered standalone message. */
  postNote(text: string): Promise<void>;
  /** Persist a phase-history entry on the workflow run. */
  persistPhase(phase: string, summary?: string): void;
  /** Mark the workflow run failed. */
  failWorkflow(errorMsg?: string): void;
  /** Set (or clear) the trailing footer of the single status surface. */
  footer(markdown: string): Promise<void>;
  /** Post the run's completion message (terminal-ping surfaces only). */
  noteTerminal(markdown: string): Promise<void>;
}

/** Model / variant / prompt / gate resolution — the resolution collaborator. */
export interface PhaseResolver {
  modelFor(taskType: string): string | undefined;
  variantFor(taskType: string): string | undefined;
  renderPrompt(promptPath: string, extraCtx?: Partial<TemplateContext>): string;
  gateEnabled(gateName: string | undefined): boolean;
}

/**
 * Reads the reviewer's authoritative verdict from its on-disk artifact
 * (`reviewer-verdict.md`, in the server-mode build-asset store or the committed
 * host checkout) when the stdout `VERDICT:` marker is missing. App-coupled
 * (filesystem + build-asset store), so it's injected. Absent ⇒ the reviewer
 * loop's file-fallback recovery simply no-ops (the "no recoverable verdict"
 * path), which is safe.
 */
export interface VerdictArtifactReader {
  read(input: { config: ExecutorConfig; repo: string; issueDir: string; taskId: string }): ParsedVerdict | undefined;
}

// ── PhaseTypeHandler — the domain escape hatch ───────────────────────────────
//
// `post-review` is the one body genuinely coupled to GitHub. Core owns the
// phase-type switch for the generic kinds and delegates unknown types to
// app-registered handlers.

export interface PhaseTypeHandler {
  execute(
    phase: PhaseDefinition,
    node: DagNode,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome>;
}

// ── EngineDeps — the injected bundle a phase run needs ───────────────────────

export interface EnginePorts {
  agent: AgentPort;
  assets: AssetLoader;
  liveness: LivenessPort;
  observability: ObservabilityPort;
  /** Reviewer verdict-artifact fallback reader (see {@link VerdictArtifactReader}). */
  verdictReader?: VerdictArtifactReader;
  /** App-registered handlers for non-generic phase types (e.g. post-review). */
  handlers?: Map<string, PhaseTypeHandler>;
}
