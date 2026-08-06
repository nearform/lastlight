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
  /** Origin platform for chat sessions ("slack" / "cli"). */
  platform?: string | null;
  /**
   * `owner/repo` this session ran against, when resolvable — the key the
   * per-repo visibility filter matches on. Null (a repo-less chat thread) is
   * never filtered out.
   */
  repo?: string | null;
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

export interface ConfigBundle {
  default: Record<string, unknown>;
  overlay: Record<string, unknown> | null;
  merged: Record<string, unknown>;
  /** Provenance tree mirroring `merged`; leaves are "default" | "overlay" | "env". */
  sources: Record<string, unknown>;
}

/**
 * Which managed repos to show the logged-in user by default — the admin
 * `/me/repos` endpoint (issue #169).
 *
 * `repos: null` is the fail-open sentinel: **no filter, show everything.** It is
 * what a password/Slack login, an `allowedOrg: "*"` deployment, a disabled
 * feature, an over-budget resolution and a GitHub error all return. Treat any
 * failure to fetch this the same way — the server still returns global data on
 * every list endpoint, so filtering is a convenience, never a boundary.
 */
export interface MeRepos {
  repos: string[] | null;
  /** Coarse "we have a resolved answer for this person" flag, for a UI hint. */
  synced: boolean;
  reason:
    | "ok"
    | "no-identity"
    | "disabled"
    | "unavailable"
    | "no-teams"
    | "too-many-teams"
    | "truncated"
    | "budget"
    | "error";
  teams: Array<{ org: string; slug: string }>;
  syncedAt: string | null;
}

/** Effective managed-repo list — see the admin `/managed-repos` endpoint. */
export interface ManagedRepos {
  /** The overlay `managedRepos` list (empty when unset). */
  configured: string[];
  /** Repos the GitHub App installation can access (discovered at boot + webhooks). */
  installation: string[];
  /** What actually gates events: `configured` when non-empty, else `installation`. */
  effective: string[];
  /** Which list `effective` came from. */
  source: "config" | "installation";
  /** ISO timestamp of the last installation-repo cache update, or null. */
  refreshedAt: string | null;
  /**
   * Every ACCOUNT the GitHub App is installed on. An App is installed per
   * account and each installation mints its own tokens, so this is the list
   * that determines which owners the harness can act on at all.
   */
  installations: {
    id: string;
    account: string;
    accountType: string;
    repositorySelection: "all" | "selected";
    suspended: boolean;
    repoCount: number;
    /**
     * GitHub's settings page for this install (repo grant / suspend /
     * uninstall). Null when the account type isn't known yet, since the path
     * shape depends on it — render plain text rather than a guessed link.
     */
    htmlUrl: string | null;
  }[];
  /**
   * Owners appearing in `effective` that have NO installation — every run
   * against them will fail to mint a token. Empty is the healthy state.
   */
  uninstalledOwners: string[];
  /** GitHub's "install this App on an account" page, for fixing the above. */
  appInstallUrl: string;
  /**
   * Per-effective-repo `.lastlight/` presence, read from the harness's in-memory
   * cache only (no network). `hasRepoConfig: false` means "nothing cached yet",
   * not necessarily "no repo config" — opening the repo's Config tab settles it.
   */
  repoConfig: { repo: string; hasRepoConfig: boolean; fetchedAt: string | null }[];
}

/**
 * One row in the Repos tab's index — the union of managed repos and repos with
 * activity, annotated with recent workflow-run + artifact counts. See the admin
 * `GET /repos` endpoint.
 */
export interface RepoEntry {
  /** `owner/repo` full name. */
  repo: string;
  /** Whether this repo is in the effective managed-repo set. */
  managed: boolean;
  /** Number of workflow runs recorded for this repo. */
  runCount: number;
  /** ISO timestamp of the most recent run's start, or null when idle. */
  lastRunAt: string | null;
  /** Number of stored artifact run-keys (build assets) for this repo. */
  artifactKeyCount: number;
  /**
   * True when the harness has a cached `.lastlight/` layer for this repo — a
   * cache-only hint (no network) that makes the repo's Config tab discoverable.
   * False can also mean "not fetched yet"; the Config tab is always available.
   */
  hasRepoConfig: boolean;
}

export type OverlayAssetType = "workflow" | "cron" | "prompt" | "skill" | "agent-context";

export interface OverlayAsset {
  type: OverlayAssetType;
  name: string;
  /** True when the overlay shadows a same-named built-in; false when it adds a new one. */
  shadowsDefault: boolean;
}

export interface OverridesBundle {
  overlayDir: string | null;
  overrides: OverlayAsset[];
}

// ── Per-repository configuration (issue #180) ────────────────────────────────

/** Which layer a resolved config leaf came from. `repo` is the `.lastlight/` layer. */
export type ConfigSource = "default" | "overlay" | "env" | "repo";

/** One thing the harness dropped out of a repo's `.lastlight/`, and why. */
export interface RepoConfigWarning {
  /** Machine code — `invalid-yaml`, `key-not-allowed`, `model-not-allowed`, … */
  code: string;
  repo?: string;
  /** The config path (`models.architect`) or file path (`workflows/x.yaml`) at fault. */
  path: string;
  message: string;
}

/** The operator's bounds on what a repo may set (overlay `repoConfig:`). */
export interface RepoConfigPolicy {
  enabled: boolean;
  allowKeys: string[];
  /** Exact-match model allow-list, or null for "any wireable provider/model". */
  allowedModels: string[] | null;
  allowAssets: boolean;
}

/**
 * The effective, repo-specific values for the keys a repo is allowed to touch.
 *
 * Hand-mirrored from `RepoMergedConfig` in `packages/shared/src/
 * repo-config-schema.ts` — the dashboard has no import edge to core. The three
 * policy blocks below were missing from this copy while the endpoint was
 * already returning them with provenance, so the per-repo Config tab silently
 * hid the budgets a repo had actually set (#256). Keep the two in step: a leaf
 * absent HERE is a leaf that does not exist as far as an operator can see.
 */
export interface RepoMergedConfig {
  models: Record<string, string>;
  variants: Record<string, string>;
  disabled: Record<string, string[]>;
  approval: Record<string, boolean>;
  /** Retry/escalation budgets for the fix family (issue #251). */
  fix: Record<string, unknown>;
  /** Major-bump auto-merge policy (issue #252). */
  dependencies: Record<string, unknown>;
  /** Review trigger policy. */
  review: Record<string, unknown>;
}

/** Provenance mirror of {@link RepoMergedConfig} — each leaf tagged with its winning layer. */
export interface RepoConfigSources {
  models: Record<string, ConfigSource>;
  variants: Record<string, ConfigSource>;
  disabled: Record<string, ConfigSource>;
  approval: Record<string, ConfigSource>;
  fix: Record<string, ConfigSource>;
  dependencies: Record<string, ConfigSource>;
  review: Record<string, ConfigSource>;
}

/** Response of `GET /repos/:owner/:repo/config`. */
export interface RepoConfigBundle {
  repo: string;
  /** Effective config for THIS repo, post-bounds. */
  merged: RepoMergedConfig;
  /** Per-leaf provenance mirroring {@link merged}. */
  sources: RepoConfigSources;
  /** The repo's `lastlight.yml` as committed, PRE-validation. Absent when the
   *  repo has no `.lastlight/` — a normal state, not an error. */
  repoLayer?: Record<string, unknown>;
  warnings: RepoConfigWarning[];
  /** Prompts / skills / agent-context the repo contributes, and what each shadows. */
  assets: OverlayAsset[];
  policy: RepoConfigPolicy;
  fetchedAt: string | null;
  treeSha: string | null;
  defaultBranch: string | null;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  triggerId: string;
  /** GitHub org/user owning {@link repo}; composes the qualified `owner/repo`. */
  owner?: string;
  /** BARE repo name (no owner) — see {@link runRepoPath} to qualify it. */
  repo?: string;
  issueNumber?: number;
  currentPhase: string;
  phaseHistory: PhaseHistoryEntry[];
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
  context?: Record<string, unknown>;
  /**
   * The run's mutable phase-to-phase state. Present on the single-run detail
   * fetch only (the list query omits the heavy JSON blobs). Carries the fix
   * harvest under `fixMarkers` — the attempt markers, the PR journal, and the
   * push gate the agent wrote for itself — which `PrStatePanel` renders.
   */
  scratch?: Record<string, unknown>;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /** Who ORIGINALLY triggered the run — a GitHub login / Slack handle / cli / cron (issue #205). */
  triggeredBy?: string;
  /** Coarse actor category for {@link triggeredBy}. */
  triggerActorType?: "github" | "slack" | "cli" | "cron" | "admin" | "system";
  /** Roll-up totals across the run's executions — present on the runs list. */
  totalCostUsd?: number;
  totalTokens?: number;
}

/**
 * The `users`-table identity for a run's actor (issue #205), returned alongside
 * the single-run detail endpoint. Null for cron/system/password actors or a
 * login with no matching row — the UI then falls back to the raw login string.
 */
export interface TriggeredByUser {
  login?: string;
  name?: string | null;
  avatarUrl?: string | null;
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
  type: "context" | "agent" | "bash" | "script" | "post-review";
  hasLoop?: boolean;
  approvalGate?: string;
}

export interface WorkflowDefinition {
  name: string;
  kind: string;
  description?: string;
  phases: WorkflowPhaseDefinition[];
}

/** Compact list of trigger source types — used for badges on the workflow list. */
export type TriggerKind = "cron" | "github" | "slack" | "mention" | "internal";

/**
 * One trigger source for a workflow. Cron entries reference a row in the
 * Crons tab; the others mirror what the router (`src/engine/router.ts`)
 * does with incoming events.
 */
export type TriggerInfo =
  | { kind: "cron"; name: string; schedule: string }
  | { kind: "github"; event: string; description: string }
  | { kind: "slack"; command: string; description: string }
  | { kind: "mention"; description: string }
  | { kind: "internal"; description: string };

/**
 * Summary returned by GET /workflows — one row per agent workflow YAML.
 * Used by the Workflows browser (left list).
 */
export interface WorkflowSummary {
  name: string;
  kind: string;
  description?: string;
  trigger?: string;
  phaseCount: number;
  hasDag: boolean;
  triggerKinds: TriggerKind[];
  /** Per-workflow kill switch. Disabled workflows skip every dispatch path. */
  enabled: boolean;
}

/**
 * Full structured definition returned by GET /workflows/:name/full.
 * Mirrors the server's `AgentWorkflowDefinition` (src/workflows/schema.ts).
 * Phase fields are loosely typed here — the dashboard treats most of them
 * as opaque metadata to show in the phase detail drawer.
 */
export interface WorkflowFullPhase {
  name: string;
  label?: string;
  type: "context" | "agent" | "bash" | "script" | "post-review";
  prompt?: string;
  /** type: bash — deterministic shell command run in the sandbox. */
  command?: string;
  /** type: script — inline source run in the sandbox. */
  script?: string;
  /** type: script — runtime selector (js/ts → node, python → uv run). */
  runtime?: "js" | "ts" | "python";
  /** type: bash/script — per-step timeout in seconds. */
  timeout_seconds?: number;
  /** Singular sugar. Mutually exclusive with `skills`; use {@link phaseSkillNames}. */
  skill?: string;
  /** Plural skill list (e.g. pr-review's `skills: [pr-review, building, code-review]`). */
  skills?: string[];
  model?: string;
  approval_gate?: string;
  approval_gate_message?: string;
  messages?: Record<string, string>;
  loop?: {
    max_cycles: number;
    on_request_changes: { fix_prompt: string; fix_model?: string; re_review_prompt: string };
    approval_gate?: string;
    messages?: Record<string, string>;
  };
  generic_loop?: {
    max_iterations: number;
    until?: string;
    until_bash?: string;
    interactive?: boolean;
    gate_message?: string;
    gate_kind?: "approve" | "reply";
    scratch_key?: string;
    fresh_context?: boolean;
  };
  on_output?: {
    contains_BLOCKED?: { action: string; message?: string; unless_label?: string; unless_title_matches?: string; bypass_message?: string };
    contains_READY?: { action: string; message?: string; unless_label?: string; unless_title_matches?: string; bypass_message?: string };
  };
  on_success?: { set_phase?: string };
  depends_on?: string[];
  trigger_rule?: "all_success" | "one_success" | "none_failed_min_one_success" | "all_done";
  output_var?: string;
}

export interface WorkflowFullDefinition {
  name: string;
  kind: string;
  description?: string;
  trigger?: string;
  variables?: Record<string, string>;
  phases: WorkflowFullPhase[];
}

/**
 * Normalize a phase's declared skills to a flat list — mirrors the server's
 * `phaseSkillNames` (src/workflows/schema.ts). A phase may use the plural
 * `skills: [...]` array or the singular `skill:` sugar; prefer the array.
 */
export function phaseSkillNames(phase: WorkflowFullPhase): string[] {
  if (phase.skills?.length) return phase.skills;
  if (phase.skill) return [phase.skill];
  return [];
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
  /**
   * agentic-pi extensions active for this phase, keyed by name
   * ("file-search" | "github" | "web-search").
   */
  extensions?: Record<
    string,
    { status: string; mode?: string; provider?: string; toolCount?: number; reason?: string }
  >;
  /**
   * agentic-pi skill-loading status for this phase — the skill-loading
   * counterpart to {@link extensions}. Present only when the run reported
   * skills (agentic-pi gates the underlying `skills_status` event).
   */
  skills?: {
    status: string;
    discovered: number;
    skills: { name: string; source: string; modelInvocable: boolean }[];
    mappedPaths: string[];
    noSkills: boolean;
  };
}

export interface ContainerInfo {
  id: string;
  name: string;
  status: string;
  created: string;
  taskId: string | null;
  image: string;
}

export type ContainerKind = "agent" | "sandbox" | "infra";

export interface ContainerStats {
  name: string;
  kind: ContainerKind;
  cpuPercent: number;
  memUsageBytes: number;
  memLimitBytes: number;
  memPercent: number;
}

export interface HostStats {
  memTotalBytes: number;
  memUsedBytes: number;
  memPercent: number;
  cpuPercent: number;
  cpuCount: number;
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

// ── Feedback signals (issue #255) ──────────────────────────────────────────
// Hand-mirrored from `src/state/feedback-store.ts` — the dashboard is a
// separate Vite app with no import edge to core, so every server type is
// copied here by hand.

/** One 👍/👎 on something the bot wrote, scored against the run that wrote it. */
export interface FeedbackSignal {
  id: string;
  anchorId: string;
  source: "slack" | "github";
  workflowRunId: string | null;
  workflowName: string | null;
  messagingSessionId: string | null;
  owner: string | null;
  repo: string | null;
  issueNumber: number | null;
  emoji: string;
  /** -2..+2. Zero means "recorded, not scored" — 👀. */
  score: number;
  sentiment: "very_good" | "good" | "neutral" | "bad" | "very_bad";
  reactor: string | null;
  reactedAt: string | null;
  observedAt: string;
  removedAt: string | null;
  exportedAt: string | null;
}

export interface FeedbackSummaryRow {
  workflowName: string | null;
  total: number;
  positive: number;
  negative: number;
  /** 👀 — counted, but excluded from `averageScore`. */
  neutral: number;
  averageScore: number;
}

export interface FeedbackDailyRow {
  date: string;
  total: number;
  positive: number;
  negative: number;
  averageScore: number;
}

export interface Health {
  status: string;
  stateDir: string;
}

export interface RepoVersion {
  current: string | null;
  latest: string | null;
  behind: boolean;
}

export interface ServerInfo {
  core: RepoVersion;
  overlay: RepoVersion;
  /** Core-version pin (`deploy.version`) the overlay declares, or null. When
   *  set, core drift is measured against the pinned tag, not `main`. */
  pinned: string | null;
  packageVersion: string | null;
  buildDate: string | null;
}

export interface ServerContainer {
  name: string;
  /** Short label derived from the compose name: lastlight-<service>-<n>. */
  service: string;
  status: string;
  image: string;
}

export interface WorkflowApproval {
  id: string;
  workflowRunId: string;
  gate: string;
  summary: string;
  status: "pending" | "approved" | "rejected";
  /**
   * Gate flavor. `approve` gates resolve on an explicit approve/reject; `reply`
   * gates (socratic explore loop) resolve on any free-form reply.
   */
  kind?: "approve" | "reply";
  /** Handoff doc filename this gate is asking the reviewer to approve. */
  artifact?: string;
  requestedBy?: string;
  /** Who approved/rejected (GitHub login / Slack user id / "admin"). */
  respondedBy?: string;
  /** Free-form comment/reason left with the decision (or reply text). */
  response?: string;
  /** ISO timestamp the decision was recorded. */
  respondedAt?: string;
  createdAt: string;
}

/**
 * Where the artifact a gate is approving lives. In server mode it's an editable
 * doc in the build-asset store ({owner, repo, issueKey, doc}); in repo mode the
 * doc is committed on the branch and `githubUrl` links to it.
 */
export interface ArtifactRef {
  mode: "repo" | "server";
  owner: string;
  repo: string;
  issueKey: string;
  doc: string;
  githubUrl?: string;
}

export type ArtifactLockReason =
  | "no_matching_approval"
  | "unverified_owner"
  | "approval_resolved"
  | "approval_rejected";

export interface ArtifactApprovalSummary {
  id: string;
  workflowRunId: string;
  status: WorkflowApproval["status"];
  gate: string;
  summary: string;
  respondedBy?: string;
  respondedAt?: string;
  createdAt: string;
}

export interface ArtifactLock {
  reason: ArtifactLockReason;
  approval?: ArtifactApprovalSummary;
  message?: string;
}

export interface ArtifactMetadata {
  editable: boolean;
  lock: ArtifactLock | null;
}

/** A repo that has stored artifacts, for the Repos tab's Assets sub-tab. */
export interface ArtifactRepoEntry {
  owner: string;
  repo: string;
  slug: string;
  keyCount: number;
  updatedAt: string;
}

/** One run key (issue dir) within a repo, with its age + doc count. */
export interface ArtifactKeyEntry {
  key: string;
  fileCount: number;
  updatedAt: string;
}

export class ArtifactLockedError extends Error {
  lock: ArtifactLock;

  constructor(lock: ArtifactLock, message = "artifact_locked") {
    super(message);
    this.name = "ArtifactLockedError";
    this.lock = lock;
  }
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

/**
 * Listeners notified whenever any API call returns 401 (e.g. an expired
 * token while the dashboard is already mounted). Lets the app drop back to
 * the login screen without a manual hard refresh.
 */
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

/** Clear the token and notify listeners that the session is no longer valid. */
function handleUnauthorized() {
  auth.clear();
  for (const listener of unauthorizedListeners) listener();
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = auth.getToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    handleUnauthorized();
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return (await res.json()) as T;
}

/** Same as `req` but for endpoints that return text/plain (raw YAML, markdown). */
async function reqText(path: string, init?: RequestInit): Promise<string> {
  const token = auth.getToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    handleUnauthorized();
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.text();
}

/** Same as `reqText` but returns the raw response Blob (binary artifacts). */
async function reqBlob(path: string, init?: RequestInit): Promise<Blob> {
  const token = auth.getToken();
  const headers: Record<string, string> = { ...(init?.headers as Record<string, string>) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  if (res.status === 401) {
    handleUnauthorized();
    throw new UnauthorizedError();
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return await res.blob();
}

/**
 * True when a build-asset filename is an image we render in an <img> viewer
 * rather than the markdown editor (PNG screenshot evidence etc.). Mirrors the
 * server's `binaryMimeForArtifact` image extensions.
 */
export function isImageArtifact(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name);
}

/**
 * True when a build-asset filename is a video we render in a <video> viewer
 * (the `/demo` workflow's mp4/webm). Mirrors the server's `binaryMimeForArtifact`
 * video extensions.
 */
export function isVideoArtifact(name: string): boolean {
  return /\.(mp4|webm)$/i.test(name);
}

export const api = {
  authRequired: () =>
    req<{ required: boolean; password: boolean; slackOAuth: boolean; githubOAuth: boolean }>("/auth-required"),
  login: (password: string) =>
    req<{ token: string }>("/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    }),
  health: () => req<Health>("/health"),
  serverInfo: () => req<ServerInfo>("/server/info"),
  serverContainers: () => req<{ containers: ServerContainer[] }>("/server/containers"),
  /** One-shot `docker logs` snapshot for a container (time-windowed via `since`). */
  serverLogs: (opts: { container?: string; tail?: number; since?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.container) qs.set("container", opts.container);
    if (opts.tail) qs.set("tail", String(opts.tail));
    if (opts.since) qs.set("since", opts.since);
    const qss = qs.toString();
    return req<{ container: string; lines: string[] }>(`/server/logs${qss ? `?${qss}` : ""}`);
  },
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
  feedbackSignals: (opts: { limit?: number; workflow?: string; source?: string } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.workflow) qs.set("workflow", opts.workflow);
    if (opts.source) qs.set("source", opts.source);
    const q = qs.toString();
    return req<{ signals: FeedbackSignal[]; total: number }>(
      `/feedback/signals${q ? `?${q}` : ""}`,
    );
  },
  feedbackSummary: (days = 30) =>
    req<{ summary: FeedbackSummaryRow[]; days: number }>(`/feedback/summary?days=${days}`),
  feedbackDaily: (days = 30, workflow?: string) =>
    req<{ daily: FeedbackDailyRow[] }>(
      `/feedback/daily?days=${days}${workflow ? `&workflow=${encodeURIComponent(workflow)}` : ""}`,
    ),
  workflowRunFeedback: (id: string) =>
    req<{ signals: FeedbackSignal[] }>(`/workflow-runs/${id}/feedback`),
  executions: (opts: { limit?: number; offset?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.offset) qs.set("offset", String(opts.offset));
    const qss = qs.toString();
    return req<{ executions: Execution[] }>(`/executions${qss ? `?${qss}` : ""}`);
  },
  containers: () => req<{ containers: ContainerInfo[] }>("/containers"),
  containerStats: () =>
    req<{ stats: ContainerStats[]; host: HostStats | null }>("/containers/stats"),
  killContainer: (name: string) =>
    req<{ killed: string }>(`/containers/${encodeURIComponent(name)}`, { method: "DELETE" }),
  workflowRuns: (
    opts: {
      limit?: number;
      offset?: number;
      since?: string;
      workflow?: string;
      /** Filter to one repo (`owner/repo`) — used by the Repos tab. */
      repo?: string;
      /**
       * Scope to a SET of repos — the per-repo visibility scope (issue #169),
       * so a list asks for exactly the rows it renders rather than fetching
       * globally and narrowing in the browser. A caller-supplied query filter,
       * not enforcement: omit it and you get global data as before.
       */
      repos?: string[];
      /** "active" → running+paused; or comma-separated explicit statuses. */
      status?: string;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (opts.limit) qs.set("limit", String(opts.limit));
    if (opts.offset) qs.set("offset", String(opts.offset));
    if (opts.since) qs.set("since", opts.since);
    if (opts.workflow) qs.set("workflow", opts.workflow);
    if (opts.repo) qs.set("repo", opts.repo);
    if (opts.repos && opts.repos.length > 0) qs.set("repos", opts.repos.join(","));
    if (opts.status) qs.set("status", opts.status);
    const qss = qs.toString();
    return req<{ workflowRuns: WorkflowRun[]; total: number }>(
      `/workflow-runs${qss ? `?${qss}` : ""}`,
    );
  },
  workflowNames: () => req<{ names: string[] }>("/workflow-names"),
  workflowRun: (id: string) =>
    req<{ workflowRun: WorkflowRun; triggeredByUser: TriggeredByUser | null }>(
      `/workflow-runs/${id}`,
    ),
  workflowRunExecutions: (id: string) =>
    req<{ executions: WorkflowRunExecution[] }>(`/workflow-runs/${id}/executions`),
  // All approvals (pending + resolved) for one run — powers the pipeline's
  // approval-gate nodes and the detail panel's approval history.
  workflowRunApprovals: (id: string) =>
    req<{ approvals: WorkflowApproval[] }>(`/workflow-runs/${id}/approvals`),
  cancelWorkflowRun: (id: string) =>
    req<{ cancelled: string }>(`/workflow-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  // Retry a FAILED run — resumes from the phase that failed with the same context.
  retryWorkflowRun: (id: string) =>
    req<{ retrying: string }>(`/workflow-runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  workflowDefinition: (name: string) =>
    req<{ workflow: WorkflowDefinition }>(`/workflows/${encodeURIComponent(name)}`),
  workflows: () => req<{ workflows: WorkflowSummary[] }>("/workflows"),
  workflowFull: (name: string) =>
    req<{ workflow: WorkflowFullDefinition; triggers: TriggerInfo[]; enabled: boolean }>(
      `/workflows/${encodeURIComponent(name)}/full`,
    ),
  toggleWorkflow: (name: string) =>
    req<{ name: string; enabled: boolean }>(
      `/workflows/${encodeURIComponent(name)}/toggle`,
      { method: "POST" },
    ),
  workflowYaml: (name: string) => reqText(`/workflows/${encodeURIComponent(name)}/yaml`),
  workflowPrompt: (name: string, path: string) =>
    reqText(`/workflows/${encodeURIComponent(name)}/prompt?path=${encodeURIComponent(path)}`),
  skill: (name: string) => reqText(`/skills/${encodeURIComponent(name)}`),
  // ── Build assets (server-mode handoff docs) ──────────────────────────────
  // Repos that actually have artifacts (search + paginate).
  listArtifactRepos: (opts: { q?: string; limit?: number; offset?: number } = {}) => {
    const params = new URLSearchParams();
    if (opts.q) params.set("q", opts.q);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    const qs = params.toString();
    return req<{ repos: ArtifactRepoEntry[]; total: number }>(
      `/artifact-repos${qs ? `?${qs}` : ""}`,
    );
  },
  // Run keys for one repo, newest first, with age. `since` is an ISO cutoff.
  listArtifactKeys: (
    repo: string,
    opts: { q?: string; since?: string; limit?: number; offset?: number } = {},
  ) => {
    const params = new URLSearchParams({ repo });
    if (opts.q) params.set("q", opts.q);
    if (opts.since) params.set("since", opts.since);
    if (opts.limit !== undefined) params.set("limit", String(opts.limit));
    if (opts.offset !== undefined) params.set("offset", String(opts.offset));
    return req<{ keys: ArtifactKeyEntry[]; total: number }>(`/artifacts?${params.toString()}`);
  },
  listArtifactFiles: (owner: string, repo: string, key: string) =>
    req<{ files: string[] }>(
      `/artifacts/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(key)}`,
    ),
  getArtifact: (owner: string, repo: string, key: string, doc: string) =>
    reqText(
      `/artifacts/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(key)}/${encodeURIComponent(doc)}`,
    ),
  artifactMetadata: (owner: string, repo: string, key: string, doc: string) =>
    req<ArtifactMetadata>(
      `/artifacts/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(key)}/${encodeURIComponent(doc)}/metadata`,
    ),
  // Binary artifacts (PNG screenshot evidence etc.) — fetched as a Blob the
  // image viewer turns into an object URL.
  getArtifactBlob: (owner: string, repo: string, key: string, doc: string) =>
    reqBlob(
      `/artifacts/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(key)}/${encodeURIComponent(doc)}`,
    ),
  saveArtifact: async (owner: string, repo: string, key: string, doc: string, content: string) => {
    const token = auth.getToken();
    const headers: Record<string, string> = { "Content-Type": "text/plain" };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(
      `${BASE}/artifacts/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(key)}/${encodeURIComponent(doc)}`,
      {
        method: "PUT",
        headers,
        body: content,
      },
    );
    if (res.status === 401) {
      handleUnauthorized();
      throw new UnauthorizedError();
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      let parsed: any = null;
      if (contentType.includes("application/json")) {
        try {
          parsed = await res.json();
        } catch {
          parsed = null;
        }
      }
      if (res.status === 403 && parsed?.error === "artifact_locked" && parsed.lock) {
        throw new ArtifactLockedError(parsed.lock);
      }
      const message = typeof parsed?.error === "string" ? parsed.error : `${res.status} ${res.statusText}`;
      throw new Error(message);
    }
    if (contentType.includes("application/json")) {
      await res.json();
    } else {
      await res.text();
    }
  },
  approvals: () => req<{ approvals: WorkflowApproval[] }>("/approvals"),
  approval: (id: string) =>
    req<{ approval: WorkflowApproval; artifactRef: ArtifactRef | null; run: WorkflowRun | null }>(
      `/approvals/${encodeURIComponent(id)}`,
    ),
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
  triggerCron: (name: string) =>
    req<{ name: string; workflow: string; triggered: boolean }>(
      `/crons/${encodeURIComponent(name)}/trigger`,
      { method: "POST" },
    ),
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
  config: () => req<ConfigBundle>("/config"),
  overrides: () => req<OverridesBundle>("/overrides"),
  managedRepos: () => req<ManagedRepos>("/managed-repos"),
  // Repos this user's GitHub teams can reach — the client-side declutter filter.
  meRepos: () => req<MeRepos>("/me/repos"),
  meReposResync: () => req<MeRepos>("/me/repos/resync", { method: "POST" }),
  // Repo-centric index for the Repos tab — managed repos ∪ active repos, each
  // with run/artifact activity, newest-activity first.
  repos: () => req<{ repos: RepoEntry[] }>("/repos"),
  // Effective config for ONE repo: the instance layers with that repo's
  // committed `.lastlight/` applied on top, within the operator's bounds.
  // `refresh` bypasses the harness's 60s repo-layer TTL.
  repoConfig: (repo: string, opts: { refresh?: boolean } = {}) =>
    req<RepoConfigBundle>(
      `/repos/${repo.split("/").map(encodeURIComponent).join("/")}/config${opts.refresh ? "?refresh=1" : ""}`,
    ),
  // Event Router Playground: static graph + hermetic dry-run of a synthetic event.
  routeGraph: () => req<RouteGraphResponse>("/route-graph"),
  routeTest: (input: RouteTestRequest) =>
    req<RouteTestResponse>("/route-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
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
  /**
   * Managed repos that opted INTO this cron from their own `.lastlight/`
   * (issue #180). Only meaningful when `enabled` is false: a globally-off cron
   * keeps its scheduler tick so these repos can still be served, which is why
   * `registered`/`nextRun` stay populated while the toggle reads off.
   * Cache-only server-side, so it can under-report until a tick warms the cache.
   */
  optedInRepos: string[];
  context: Record<string, unknown>;
  override: { updatedAt: string; updatedBy: string | null; hasScheduleOverride: boolean } | null;
}

// ── Event Router Playground ──────────────────────────────────────────────────

export type RoutingKind = "deterministic" | "classifier";

export interface RouteGraphResponse {
  /** The configured bot handle (`GITHUB_APP_BOT_NAME`) — what a comment must
   *  @-mention to trigger. Drives the playground's placeholders + mention tip. */
  botName: string;
  inputs: { id: "github" | "slack"; label: string }[];
  eventTypes: { input: "github" | "slack"; type: string; routing: RoutingKind; label: string }[];
  handlers: { name: string; claimedIntent?: string; kind: "workflow" | "in-process" }[];
  deterministicEdges: { from: string; to: string; via: string }[];
  intentEdges: { intent: string; to: string }[];
}

export interface RouteTestRequest {
  source: "github" | "slack";
  type: string;
  body: string;
  title?: string;
  sender?: string;
  repo?: string;
  issueNumber?: number;
  prNumber?: number;
  isPullRequest?: boolean;
  prAuthor?: string;
  checksState?: string;
  labels?: string[];
  authorAssociation?: string;
}

/** Mirrors the server `Route` union in src/engine/router.ts. */
export type Route =
  | { action: "handler"; handler: string; context: Record<string, unknown> }
  | { action: "reply"; message: string }
  | { action: "ignore"; reason: string };

export interface RouteClassification {
  intent: string;
  repo?: string;
  issueNumber?: number;
  reason?: string;
  /** The provider/model the classifier resolved to (introspection only). */
  model?: string;
}

export interface RouteExplanation {
  routingKind: RoutingKind;
  branchLabel: string;
  handler?: string;
  routeKey?: string;
  reason?: string;
  notes: string[];
}

export interface RouteTestResponse {
  route: Route;
  classification?: RouteClassification;
  explanation: RouteExplanation;
}
