import type { GitHubTokenPermissions } from "./git-auth.js";
import type { BuildAssetsLocation, OtelConfig, SandboxBackend } from "../../config/config.js";
import { loadAgentContext as loadResolvedAgentContext } from "../../workflows/loader.js";

/**
 * Configuration for an agent execution.
 */
export interface ExecutorConfig {
  /** Working directory for the agent (used by the no-sandbox path). */
  cwd?: string;
  /** Maximum conversation turns. Unused by agentic-pi; kept for API stability. */
  maxTurns?: number;
  /** Model id (e.g. "anthropic/claude-sonnet-4-6"). */
  model?: string;
  /**
   * Pi thinking level: `off | minimal | low | medium | high | xhigh`.
   * Forwarded to agentic-pi as the `thinking` option. When omitted,
   * agentic-pi uses the model's default.
   */
  variant?: string;
  /** Path to agent context directory. */
  agentContextDir?: string;
  /** Directory for persistent state. */
  stateDir?: string;
  /** Directory for agent sandboxes (cloned repos). */
  sandboxDir?: string;
  /**
   * Run the agent in a `<workspace>/<repoSubdir>/` SUBDIRECTORY instead of the
   * workspace root, WITHOUT going through the token-gated `prePopulate`/clone
   * path. For callers that pre-seed the repo themselves (e.g. the evals harness
   * in static-token mode): it reproduces production's nested layout — the repo
   * checkout is a child dir, while `AGENTS.md`/`.lastlight-skills/` stay at the
   * workspace root, siblings outside the repo's git tree. Ignored when a real
   * `prePopulate` clone runs (that already nests into `<repo>/`). Use backend
   * `none` so skills stage at the root rather than under the repo.
   */
  repoSubdir?: string;
  /** Where the shim writes dashboard envelope jsonl. */
  sessionsDir?: string;
  /** Workflow sandbox backend (overrides config-level default). */
  sandbox?: SandboxBackend;
  /**
   * Which docker sandbox image this phase runs in: `"qa"` selects the
   * browser-QA image (Playwright + Chromium), anything else the lean default.
   * Overlaid per-phase from `sandbox_image:` by `phaseConfigFor`; only acted on
   * by the docker path.
   */
  sandboxImage?: "default" | "qa";
  /**
   * Where build handoff docs live for this run:
   *   - "repo" (default): the agent writes/commits `.lastlight/<issueKey>/`
   *     into the target repo branch; the stage-in/harvest seam is skipped.
   *   - "server": docs are staged in from / harvested back to the server store
   *     under `buildAssetsDir`, never committed. Set from the runtime config.
   */
  buildAssets?: BuildAssetsLocation;
  /** Filesystem root for the server-mode build-assets store (when buildAssets === "server"). */
  buildAssetsDir?: string;
  /**
   * Server-mode artifact identity for this run. Used by the stage-in/harvest
   * seam to locate the run's docs in the store at
   * `<buildAssetsDir>/<owner>/<repo>/<issueKey>/`. Set per run from simple.ts.
   */
  buildAssetsKey?: { owner: string; repo: string; issueKey: string };
  /**
   * Bypass the HTTP egress allowlist for this phase. When true:
   *   - gondolin: `allowedHttpHosts: ["*"]` is passed to agentic-pi.
   *   - docker:   the sandbox container uses the open CoreDNS/nginx
   *               egress-firewall pair instead of the strict one.
   *
   * Default false. Set via the `unrestricted_egress` field on a workflow
   * phase — used for phases that need broad web access (e.g. an explore
   * phase that searches third-party documentation).
   */
  unrestrictedEgress?: boolean;
  /**
   * Enable agentic-pi's web-search extension (`web_search` / `web_fetch`
   * tools). Default false. agentic-pi auto-enables web search whenever a
   * provider env var (`TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`,
   * `EXA_API_KEY`) is present, so we pass an explicit `false` downstream
   * to suppress auto-enable for non-explore workflows.
   */
  webSearch?: boolean;
  /**
   * Force a specific web-search provider. When unset, agentic-pi picks
   * one based on which API key env var is present (Tavily > Exa > Brave).
   */
  webSearchProvider?: "tavily" | "brave" | "exa";
  /**
   * Override the GitHub REST API base URL for agentic-pi's built-in
   * `github_*` tools (Octokit `baseUrl`). Test/eval escape hatch only:
   * the eval harness (`evals/`) points this at a local fake GitHub server so
   * a real workflow runs unchanged with its GitHub calls mocked. Production
   * leaves it unset → `https://api.github.com`. Only honoured by the
   * in-process (`none`/`gondolin`) path.
   */
  githubApiBaseUrl?: string;
  /** Controls OTEL env forwarding and PI event redaction for workflow phase runs. */
  otel?: OtelConfig;
  telemetry?: {
    workflowName?: string;
    phaseName?: string;
    triggerId?: string;
    workflowRunId?: string;
  };
  /**
   * Absolute host paths to skill directories (each containing SKILL.md
   * plus optional scripts/, references/, assets/). Staged into a per-phase
   * bundle at `.lastlight-skills/<phaseName>/<basename>/` before the agent
   * runs — gondolin/none via symlink, docker via copy — and passed to pi
   * explicitly (`--skill` in docker, `skillPaths` in-process). cwd stays the
   * repo; the bundle is a workspace-root sibling of the repo (never committed)
   * on docker/none, and under the repo + local `.git/info/exclude` on gondolin
   * (which mounts only cwd). Keyed per phase so parallel phases stay isolated.
   * Resolved by `phaseConfigFor` in the workflow runner from the phase's
   * `skill:`/`skills:` field.
   */
  skillPaths?: string[];
}

/**
 * Normalized status of one agentic-pi extension for a single run.
 * Keyed by extension name ("file-search" | "github" | "web-search") in
 * an {@link ExtensionStatusMap}. agentic-pi emits these as `extension_status`
 * events at run start and on `RunResult.{fileSearch,github,webSearch}`;
 * lastlight captures them so the dashboard and logs show which extensions
 * (e.g. FFF file-search) were actually active.
 */
export interface ExtensionStatus {
  /** "configured" when the extension loaded, "skipped" otherwise. */
  status: string;
  /** file-search only: "override" | "tools-only" | "tools-and-ui". */
  mode?: string;
  /** web-search only: the resolved search provider. */
  provider?: string;
  /** Number of tools the extension registered. */
  toolCount?: number;
  /** Why it was skipped (e.g. "no-credentials", "resolve-failed"). */
  reason?: string;
}

export type ExtensionStatusMap = Record<string, ExtensionStatus>;

/**
 * One skill agentic-pi discovered for a run, flattened from the
 * `skills_status` event's `skills[]`. Mirrors agentic-pi's `SkillSummary`.
 */
export interface SkillSummary {
  /** Skill name (from SKILL.md frontmatter). */
  name: string;
  /** Absolute path to the skill's SKILL.md. */
  source: string;
  /**
   * Whether the model can auto-invoke it. False when the skill set
   * `disable-model-invocation: true` — present but not surfaced in the
   * system prompt, so worth flagging in the dashboard.
   */
  modelInvocable: boolean;
}

/**
 * Normalized status of agentic-pi's skill discovery for a single run — the
 * skill-loading counterpart to {@link ExtensionStatus} (tool loading).
 * agentic-pi (≥0.2.6) emits this as a single, gated `skills_status` event at
 * run start: present only when skills were configured (`skillPaths`/`noSkills`)
 * or at least one was discovered, absent on a default run with no skills.
 * lastlight captures it so the dashboard's phase-detail panel can show which
 * skills the agent had available.
 */
export interface SkillsStatus {
  /**
   * "default" (rely on auto-discovery), "configured" (explicit `skillPaths`
   * resolved), or "disabled" (`noSkills` with no explicit paths).
   */
  status: string;
  /** Number of skills the resource loader actually discovered. */
  discovered: number;
  /** The discovered skills, flattened. */
  skills: SkillSummary[];
  /** Operator-mapped skill paths that resolved (echoed for observability). */
  mappedPaths: string[];
  /** Whether agentic-pi's default skill discovery was disabled. */
  noSkills: boolean;
}

/**
 * Result from an agent execution.
 */
export interface ExecutionResult {
  success: boolean;
  output: string;
  turns: number;
  error?: string;
  durationMs: number;
  /** Session id captured from the runtime's stream. */
  sessionId?: string;
  /** Total USD cost reported by the runtime. Zero under OAuth/subscription auth. */
  costUsd?: number;
  /** Tokens billed as fresh input (no cache hit). */
  inputTokens?: number;
  /** Tokens that triggered a cache write. */
  cacheCreationInputTokens?: number;
  /** Tokens served from prompt cache (heavily discounted). */
  cacheReadInputTokens?: number;
  /** Output tokens generated by the model. */
  outputTokens?: number;
  /** API-side duration (excludes orchestrator overhead). */
  apiDurationMs?: number;
  /** Mapped stop reason ("success" / "error_*" / etc.). */
  stopReason?: string;
  /**
   * Which agentic-pi extensions were active for this run, keyed by name.
   * Surfaced in the dashboard's phase-detail panel and persisted to the
   * `executions.extension_status` column.
   */
  extensions?: ExtensionStatusMap;
  /**
   * Skill-loading status captured from agentic-pi's `skills_status` event.
   * Surfaced alongside {@link extensions} in the dashboard's phase-detail
   * panel and persisted to the `executions.skills_status` column. Undefined
   * when the run reported no skills (the event is gated on the agentic-pi side).
   */
  skills?: SkillsStatus;
}

export type GitAccessProfile = "read" | "issues-write" | "review-write" | "repo-write";

/**
 * agentic-pi's GitHub extension uses the same four profile names — they
 * pass through unchanged. Kept as an explicit map so renames on either
 * side surface as a type error rather than a silent runtime mismatch.
 */
export const AGENTIC_PROFILE_FOR: Record<GitAccessProfile, string> = {
  read: "read",
  "issues-write": "issues-write",
  "review-write": "review-write",
  "repo-write": "repo-write",
};

export interface GitSandboxAccess {
  owner: string;
  repo: string;
  profile: GitAccessProfile;
  /**
   * When true, sandbox MCP can mint/refresh tokens using the app PEM.
   * Leave false for lower-trust runs to keep private key material inaccessible.
   */
  allowMcpAppAuth?: boolean;
  /**
   * When set, the harness pre-clones the repo at this branch into the
   * task's workspace before the sandbox container starts. The agent then
   * sees the workspace already checked out — no `clone_repo` call needed
   * inside the session. Used by read-only workflows (pr-review, pr-fix)
   * that operate on an existing branch, and by branch-synthesizing
   * workflows (`build`, `verify`, `qa-test`, `demo` — see
   * `PREPOPULATE_SYNTH_WORKFLOWS`) whose `lastlight/N-slug` branch doesn't
   * exist on the remote yet: the missing-branch fallback in
   * `prePopulateWorkspace` clones the default branch and creates it locally.
   */
  prePopulateBranch?: string;
  /**
   * The owning workflow run id. Stamped into a `<workDir>/.lastlight-run`
   * marker by the pre-clone so a reused per-PR workspace (see
   * `workflowScopedTaskId` for pr-review / pr-fix) can tell "next phase of
   * the same run" (preserve the checkout — build's plan.md lives here) from
   * "a fresh run reusing an old PR dir" (fetch + hard-reset + clean, keeping
   * node_modules warm). Unset for non-workflow callers, which keep the old
   * skip-if-`.git`-exists behaviour.
   */
  runId?: string;
  /**
   * Clone shallowly (`--depth 1 --single-branch`). Set for read-only
   * workflows that never need history; repo-write workflows (build, pr-fix,
   * security-feedback) keep the deeper `--depth 50` clone so rebases / amends
   * have headroom.
   */
  shallow?: boolean;
  /**
   * Recreate the workspace from the **default branch** on a fresh run instead
   * of reusing/refreshing an existing feature-branch checkout. Set for the
   * `PER_TARGET_RECREATE_WORKFLOWS` (build): a re-triggered build discards any
   * leftover from an earlier incomplete run and starts again off current
   * `main`, and its feature branch is always cut from the latest default —
   * never inheriting a stale pushed branch (issue #153). A same-run resume
   * (approval gate) still preserves the checkout via the run marker.
   */
  recreateFromBase?: boolean;
}

export const GITHUB_PERMISSION_PROFILES: Record<GitAccessProfile, GitHubTokenPermissions> = {
  read: {
    contents: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
  },
  "issues-write": {
    contents: "read",
    issues: "write",
    pull_requests: "read",
    metadata: "read",
  },
  "review-write": {
    contents: "read",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
  "repo-write": {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
};

export function loadAgentContext(_dir?: string): string {
  return loadResolvedAgentContext();
}
