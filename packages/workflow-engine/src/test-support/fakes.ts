/**
 * In-memory fakes for the workflow engine's injected ports — no docker, git,
 * sqlite, or filesystem. They let a consumer (the app's unit tests, an external
 * eval harness, or another codebase embedding the engine) drive a real workflow
 * run with scripted agent outcomes.
 *
 * Engine-pure: imports only the port interfaces + core types.
 */

import type {
  AgentPort,
  AgentRunOpts,
  AssetLoader,
  EngineSpan,
  ExecutionFinish,
  ExecutionLedger,
  LivenessPort,
  NewApproval,
  NewExecution,
  ObservabilityPort,
  PhaseHistoryEntry,
  PhaseMarker,
  PhaseReporter,
  PhaseResult,
  RunStore,
  StepStatus,
  WorkflowRunView,
  WorkflowStateStore,
} from "../ports/ports.js";

export { noopLogger } from "../ports/ports.js";
import type {
  CommandSpec,
  ExecutionResult,
  ExecutorConfig,
} from "../core/types.js";

// ── FakeAgentPort ────────────────────────────────────────────────────────────

export interface RecordedAgentCall {
  kind: "agent" | "command";
  prompt?: string;
  spec?: CommandSpec;
  config: ExecutorConfig;
  opts: AgentRunOpts;
}

const OK: ExecutionResult = { success: true, output: "", turns: 1, durationMs: 0 };

/**
 * Records every `{prompt|spec, config, opts}` and returns scripted
 * `ExecutionResult`s (a queue, or a single default). Mirrors the app's
 * `FakeSandbox` shape.
 */
export class FakeAgentPort implements AgentPort {
  readonly calls: RecordedAgentCall[] = [];
  private queue: ExecutionResult[] = [];
  private fallback: ExecutionResult;

  constructor(fallback: ExecutionResult = OK) {
    this.fallback = fallback;
  }

  /** Script the next N results (consumed FIFO). */
  script(...results: ExecutionResult[]): this {
    this.queue.push(...results);
    return this;
  }

  private next(): ExecutionResult {
    return this.queue.shift() ?? this.fallback;
  }

  async runAgent(prompt: string, config: ExecutorConfig, opts: AgentRunOpts): Promise<ExecutionResult> {
    this.calls.push({ kind: "agent", prompt, config, opts });
    const result = this.next();
    if (result.sessionId) opts.onSessionId?.(result.sessionId);
    return result;
  }

  async runCommand(spec: CommandSpec, config: ExecutorConfig, opts: AgentRunOpts): Promise<ExecutionResult> {
    this.calls.push({ kind: "command", spec, config, opts });
    return this.next();
  }
}

// ── InMemoryStateStore ───────────────────────────────────────────────────────

/**
 * One row of the in-memory `executions` ledger — the fake's mirror of the
 * production table, kept wide enough to assert the things the real table is
 * read for: is it still open (`finished === false`, i.e. `finished_at IS NULL`),
 * when did it start, and what verdict did it carry (`stopReason`).
 *
 * `startedAt` matters on its own: a long in-sandbox step (the generic loop's
 * `until_bash` exit check) is only visible while it is in flight because it has
 * an OPEN row with a start time — that pair is how every renderer draws "in
 * progress, since N".
 */
export interface FakeExecutionRow {
  id: string;
  /** `<workflow>:<phase>` — the ledger dedup key, mirrored to `skill`. */
  dedupKey: string;
  triggerId: string;
  workflowRunId?: string;
  /**
   * The (owner, BARE repo) pair the row was written with. Recorded because it
   * was silently dropped here, so no engine-side test could observe what the
   * phase executor actually put on the ledger (issue #279).
   */
  owner?: string;
  repo?: string;
  startedAt: string;
  success?: boolean;
  finished: boolean;
  stopReason?: string;
  durationMs?: number;
  error?: string;
  output?: string;
}

type LedgerRow = FakeExecutionRow;

interface RunRow {
  status: WorkflowRunView["status"];
  scratch: Record<string, unknown>;
  history: PhaseHistoryEntry[];
  approvals: NewApproval[];
}

const ledgerKey = (dedupKey: string, triggerId: string, workflowRunId?: string) =>
  JSON.stringify([dedupKey, triggerId, workflowRunId ?? ""]);

/**
 * Map-backed {@link WorkflowStateStore} — the resume/dedup ledger + run store,
 * with no better-sqlite3. Reproduces the production resume caveat: a phase whose
 * ledger row is already `success=1` returns `"done"` from
 * {@link ExecutionLedger.shouldRunPhase}, so the engine skips it (and it
 * contributes nothing to the in-memory `outputs` map).
 */
export class InMemoryStateStore implements WorkflowStateStore {
  private runsById = new Map<string, RunRow>();
  private ledger = new Map<string, LedgerRow>();
  private byExecId = new Map<string, LedgerRow>();
  /** Every row ever started, in insertion order (the ledger Map dedups by key). */
  private readonly rows: LedgerRow[] = [];

  constructor(runId?: string) {
    if (runId) this.runsById.set(runId, { status: "running", scratch: {}, history: [], approvals: [] });
  }

  private ensureRun(id: string): RunRow {
    let row = this.runsById.get(id);
    if (!row) {
      row = { status: "running", scratch: {}, history: [], approvals: [] };
      this.runsById.set(id, row);
    }
    return row;
  }

  /**
   * Every `executions` row, oldest first — the ledger Map is keyed by dedup key
   * and so can't be enumerated in start order. Optionally filtered to rows whose
   * dedup key ends in `:<suffix>` (i.e. one phase label).
   *
   * Returns **snapshots**, not the live rows. The whole point of this accessor
   * is observing a row while its step is still in flight (an open `until_bash`
   * check, say); handing back the live object would let the later
   * `recordFinish` rewrite what the test believes it saw, and the assertion
   * would pass or fail on timing rather than on behaviour.
   */
  executionRows(phaseSuffix?: string): readonly FakeExecutionRow[] {
    const rows = phaseSuffix
      ? this.rows.filter((r) => r.dedupKey.endsWith(`:${phaseSuffix}`))
      : this.rows;
    return rows.map((r) => ({ ...r }));
  }

  /** The run's `phase_history`, oldest first. */
  phaseHistory(runId: string): readonly PhaseHistoryEntry[] {
    return this.runsById.get(runId)?.history ?? [];
  }

  readonly runs: RunStore = {
    getRun: async (id) => {
      const row = this.runsById.get(id);
      return row ? ({ status: row.status, scratch: row.scratch } satisfies WorkflowRunView) : null;
    },
    appendPhase: async (id, _phase, entry) => {
      this.ensureRun(id).history.push(entry);
    },
    finishRun: async (id, status, opts) => {
      const row = this.ensureRun(id);
      if (opts?.terminalMarker) row.history.push({ ...opts.terminalMarker, timestamp: new Date().toISOString(), success: true } as PhaseHistoryEntry);
      row.status = status;
    },
    mergeScratch: async (id, patch) => {
      const row = this.ensureRun(id);
      row.scratch = { ...row.scratch, ...patch };
    },
    pauseForApproval: async (runId, approval: NewApproval, marker: PhaseMarker, scratchPatch) => {
      const row = this.ensureRun(runId);
      row.history.push({ phase: marker.phase, summary: marker.summary, timestamp: new Date().toISOString(), success: true });
      if (scratchPatch) row.scratch = { ...row.scratch, ...scratchPatch };
      row.approvals.push(approval);
      row.status = "paused";
    },
  };

  readonly executions: ExecutionLedger = {
    shouldRunPhase: async (dedupKey, triggerId, workflowRunId) => {
      const row = this.ledger.get(ledgerKey(dedupKey, triggerId, workflowRunId));
      if (!row) return "run";
      if (!row.finished) return "running";
      return row.success ? "done" : "run";
    },
    markStaleAsFailed: async (dedupKey, triggerId, workflowRunId) => {
      const row = this.ledger.get(ledgerKey(dedupKey, triggerId, workflowRunId));
      if (row && !row.finished) {
        row.finished = true;
        row.success = false;
        return 1;
      }
      return 0;
    },
    markLatestAsFailed: async (dedupKey, triggerId, _reason, workflowRunId) => {
      const row = this.ledger.get(ledgerKey(dedupKey, triggerId, workflowRunId));
      if (row) {
        row.finished = true;
        row.success = false;
        return 1;
      }
      return 0;
    },
    recordStart: async (rec: NewExecution) => {
      const row: LedgerRow = {
        id: rec.id,
        dedupKey: rec.skill,
        triggerId: rec.triggerId,
        workflowRunId: rec.workflowRunId,
        owner: rec.owner,
        repo: rec.repo,
        startedAt: rec.startedAt,
        finished: false,
      };
      this.ledger.set(ledgerKey(rec.skill, rec.triggerId, rec.workflowRunId), row);
      this.byExecId.set(rec.id, row);
      this.rows.push(row);
    },
    recordFinish: async (id, result: ExecutionFinish) => {
      const row = this.byExecId.get(id);
      if (row) {
        row.finished = true;
        row.success = result.success;
        row.stopReason = result.stopReason;
        row.durationMs = result.durationMs;
        row.error = result.error;
      }
    },
    recordSessionId: async () => {},
    recordOutputText: async (id, text) => {
      const row = this.byExecId.get(id);
      if (row) row.output = text;
    },
    recordSkippedPhase: async (dedupKey, triggerId, workflowRunId, repo, owner) => {
      const row: LedgerRow = {
        id: `skipped:${dedupKey}`,
        dedupKey,
        triggerId,
        workflowRunId,
        owner,
        repo,
        startedAt: new Date().toISOString(),
        finished: true,
        success: false,
        stopReason: "skipped",
      };
      this.ledger.set(ledgerKey(dedupKey, triggerId, workflowRunId), row);
      this.rows.push(row);
    },
    getPhaseOutput: async (dedupKey, triggerId, workflowRunId) =>
      this.ledger.get(ledgerKey(dedupKey, triggerId, workflowRunId))?.output ?? null,
    getExecutionOutput: async (id) => this.byExecId.get(id)?.output ?? null,
  };
}

// ── RecordingReporter ────────────────────────────────────────────────────────

export interface RecordedStep {
  key: string;
  status: StepStatus;
  template?: string;
}

/** A {@link PhaseReporter} that records everything and posts nowhere. */
export class RecordingReporter implements PhaseReporter {
  readonly steps: RecordedStep[] = [];
  readonly notes: string[] = [];
  readonly persisted: { phase: string; summary?: string }[] = [];
  readonly failures: string[] = [];
  readonly ends: PhaseResult[] = [];

  async onStart(): Promise<void> {}
  async onEnd(_phase: string, result: PhaseResult): Promise<void> {
    this.ends.push(result);
  }
  async step(key: string, status: StepStatus, template?: string): Promise<void> {
    this.steps.push({ key, status, template });
  }
  async message(template: string | undefined): Promise<void> {
    if (template) this.notes.push(template);
  }
  async approvalNote(template: string | undefined): Promise<void> {
    if (template) this.notes.push(template);
  }
  async postNote(text: string): Promise<void> {
    this.notes.push(text);
  }
  async persistPhase(phase: string, summary?: string): Promise<void> {
    this.persisted.push({ phase, summary });
  }
  async failWorkflow(errorMsg?: string): Promise<void> {
    this.failures.push(errorMsg ?? "");
  }
  async footer(markdown: string): Promise<void> {
    this.notes.push(markdown);
  }
  async noteTerminal(markdown: string): Promise<void> {
    this.notes.push(markdown);
  }
}

// ── StubAssetLoader ──────────────────────────────────────────────────────────

/** Returns a deterministic stub template per path + no skill paths. */
export class StubAssetLoader implements AssetLoader {
  constructor(private readonly templates: Record<string, string> = {}) {}
  loadPromptTemplate(relativePath: string): string {
    return this.templates[relativePath] ?? `TEMPLATE:${relativePath}`;
  }
  resolveSkillPaths(names: readonly string[]): string[] {
    return names.map((n) => `/fake/skills/${n}`);
  }
}

// ── Tiny no-op ports ─────────────────────────────────────────────────────────

/** Liveness port that never sees a live container (the test default). */
export const noopLiveness: LivenessPort = {
  isPhaseContainerAlive: async () => false,
};

/** Observability port that runs the span body directly and drops metrics. */
export const noopObservability: ObservabilityPort = {
  withSpan: <T>(_name: string, _attrs: Record<string, unknown>, fn: (span?: EngineSpan) => Promise<T> | T) =>
    Promise.resolve(fn(undefined)),
  recordExecutionMetrics: () => {},
  recordError: () => {},
};
