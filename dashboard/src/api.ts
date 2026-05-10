const TOKEN_KEY = "lastlight-token";
const BASE = "/admin/api";

export interface Session {
  id: string;
  source: string;
  sessionType?: string;
  model: string | null;
  started_at: number;
  last_message_at: number | null;
  message_count: number;
  tool_call_count: number;
  conversation_message_count: number;
  last_assistant_content: string | null;
  /** Whether this session has an active Docker container */
  live?: boolean;
  // Optional fields from execution correlation
  title?: string | null;
  estimated_cost_usd?: number | null;
  ended_at?: number | null;
}

export interface Message {
  id: number;
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: string | number;
  reasoning?: unknown;
  finish_reason?: string;
  [k: string]: unknown;
}

export interface Execution {
  id: string;
  trigger_type: string;
  trigger_id: string;
  skill: string;
  repo: string | null;
  issue_number: number | null;
  started_at: string;
  finished_at: string | null;
  success: number | null;
  error: string | null;
  turns: number | null;
  duration_ms: number | null;
}

export interface PhaseHistoryEntry {
  phase: string;
  timestamp: string;
  success: boolean;
  summary?: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  triggerId: string;
  repo?: string;
  issueNumber?: number;
  currentPhase: string;
  phaseHistory: PhaseHistoryEntry[];
  status: "running" | "paused" | "succeeded" | "failed" | "cancelled";
  context?: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
}

/**
 * Dashboard-side view of a workflow YAML definition. Mirrors the subset
 * served by GET /admin/api/workflows/:name. The pipeline visualisation
 * fetches this on-demand to render the actual phases of any workflow,
 * including user-defined custom ones.
 */
export interface WorkflowPhaseDefinition {
  name: string;
  label: string;
  type: "context" | "agent";
  hasLoop?: boolean;
  approvalGate?: string;
}

export interface WorkflowDefinition {
  name: string;
  kind: string;
  description?: string;
  phases: WorkflowPhaseDefinition[];
}

/**
 * Per-phase execution row returned by GET /workflow-runs/:id/executions.
 * The dashboard uses this to map a clicked pipeline node to its session log
 * and to surface cost / token metrics in the phase detail panel.
 */
export interface WorkflowRunExecution {
  id: string;
  skill: string;
  phase: string;
  sessionId?: string;
  success?: boolean;
  error?: string;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number;
  turns?: number;
  costUsd?: number;
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  apiDurationMs?: number;
  stopReason?: string;
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  created: string;
  taskId: string | null;
  image: string;
}

export interface ContainerStats {
  name: string;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
}

export interface Stats {
  total_executions: number;
  today_count: number;
  by_skill: Record<string, { count: number; success: number; fail: number }>;
  by_trigger: Record<string, number>;
  running: number;
}

export interface DailyStat {
  date: string;
  executions: number;
  successes: number;
  failures: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

export interface Health {
  status: string;
  stateDir: string;
}

export interface WorkflowApproval {
  id: string;
  workflowRunId: string;
  gate: string;
  summary: string;
  status: "pending" | "approved" | "rejected";
  requestedBy?: string;
  createdAt: string;
}

export class UnauthorizedError extends Error {
  constructor() {
    super("unauthorized");
    this.name = "UnauthorizedError";
  }
}

export const auth = {
  getToken: () => localStorage.getItem(TOKEN_KEY),
  setToken: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = auth.getToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    auth.clear();
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

export interface RateLimit {
  resource: string;
  remaining: number;
  reset_at: string;
  updated_at: string;
}

export const api = {
  authRequired: () => req<{ required: boolean; slackOAuth: boolean; githubOAuth: boolean }>("/auth-required"),
  login: (password: string) =>
    req<{ token: string }>("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  health: () => req<Health>("/health"),
  sessions: (opts: { limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    const qss = qs.toString();
    return req<{ sessions: Session[] }>(`/sessions${qss ? `?${qss}` : ""}`);
  },
  session: (id: string) => req<{ session: Session }>(`/sessions/${id}`),
  messages: (id: string, since = -1) =>
    req<{ source: string; messages: Message[]; last_id: number }>(
      `/sessions/${id}/messages?since=${since}`,
    ),
  stats: () => req<Stats>("/stats"),
  dailyStats: (days = 30) => req<{ daily: DailyStat[] }>(`/stats/daily?days=${days}`),
  hourlyStats: (hours = 24) =>
    req<{ hourly: DailyStat[] }>(`/stats/hourly?hours=${hours}`),
  executions: (opts: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.offset) qs.set("offset", String(opts.offset));
    const qss = qs.toString();
    return req<{ executions: Execution[] }>(`/executions${qss ? `?${qss}` : ""}`);
  },
  containers: () => req<{ containers: ContainerInfo[] }>("/containers"),
  containerStats: () => req<{ stats: ContainerStats[] }>("/containers/stats"),
  killContainer: (name: string) =>
    req<{ killed: string }>(`/containers/${encodeURIComponent(name)}`, { method: "DELETE" }),
  rateLimits: () => req<{ limits: RateLimit[] }>("/rate-limits"),
  workflowRuns: (
    opts: {
      limit?: number;
      offset?: number;
      since?: string;
      workflow?: string;
      /** "active" → running+paused; or comma-separated explicit statuses. */
      status?: string;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.since) qs.set("since", opts.since);
    if (opts.workflow) qs.set("workflow", opts.workflow);
    if (opts.status) qs.set("status", opts.status);
    const qss = qs.toString();
    return req<{ workflowRuns: WorkflowRun[]; total: number }>(
      `/workflow-runs${qss ? `?${qss}` : ""}`,
    );
  },
  workflowNames: () => req<{ names: string[] }>("/workflow-names"),
  workflowRun: (id: string) => req<{ workflowRun: WorkflowRun }>(`/workflow-runs/${id}`),
  workflowRunExecutions: (id: string) =>
    req<{ executions: WorkflowRunExecution[] }>(`/workflow-runs/${id}/executions`),
  cancelWorkflowRun: (id: string) =>
    req<{ cancelled: string }>(`/workflow-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  workflowDefinition: (name: string) =>
    req<{ workflow: WorkflowDefinition }>(`/workflows/${encodeURIComponent(name)}`),
  approvals: () => req<{ approvals: WorkflowApproval[] }>("/approvals"),
  respondToApproval: (id: string, decision: "approved" | "rejected", reason?: string) =>
    req<{ status: string }>(`/approvals/${id}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision, reason }),
    }),
  crons: () => req<{ crons: CronInfo[] }>("/crons"),
  toggleCron: (name: string) =>
    req<{ name: string; enabled: boolean }>(`/crons/${encodeURIComponent(name)}/toggle`, {
      method: "POST",
    }),
  setCronSchedule: (name: string, schedule: string) =>
    req<{ name: string; schedule: string }>(`/crons/${encodeURIComponent(name)}/schedule`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ schedule }),
    }),
  resetCronOverride: (name: string) =>
    req<{ name: string; schedule: string; enabled: boolean }>(
      `/crons/${encodeURIComponent(name)}/override`,
      { method: "DELETE" },
    ),
};

export interface CronInfo {
  name: string;
  workflow: string;
  schedule: string;
  originalSchedule: string;
  enabled: boolean;
  registered: boolean;
  nextRun: string | null;
  lastRun: string | null;
  lastStatus: string | null;
  recentFailures: number;
  context: Record<string, unknown>;
  override: { updatedAt: string; updatedBy: string | null; hasScheduleOverride: boolean } | null;
}
