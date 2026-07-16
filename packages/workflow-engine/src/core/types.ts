/**
 * Shared vocabulary for the workflow engine — the concrete data types that flow
 * through phase execution: the agent config/result, the git-sandbox access
 * descriptor, and the deterministic command spec.
 *
 * These moved here (from `src/engine/github/profiles.ts`,
 * `src/config/config.ts`, and `src/engine/executors/orchestrator.ts`) so the
 * engine owns its own vocabulary and no longer type-depends on the app layer.
 * The app-side modules re-export them from here for import-path stability.
 *
 * Engine-internal: this module imports nothing from `../engine`, `../state`,
 * `../config`, etc. — the dependency-cruiser boundary gate enforces that.
 */

// ── Config sub-types (were in config/config.ts) ──────────────────────────────

/** Workflow sandbox backend. */
export type SandboxBackend = "gondolin" | "docker" | "smol" | "none";

/** Where build handoff docs live for a run. */
export type BuildAssetsLocation = "repo" | "server";

/** OTEL forwarding + redaction config threaded into a phase run. */
export interface OtelConfig {
  enabled: boolean;
  serviceName: string;
  includeContent: boolean;
  forwardToSandbox: boolean;
  strict: boolean;
  collectorHosts: string[];
}

// ── ExecutorConfig (was in engine/github/profiles.ts) ────────────────────────

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

// ── Agent execution result (was in engine/github/profiles.ts) ────────────────

/**
 * Normalized status of one agentic-pi extension for a single run.
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
   * `disable-model-invocation: true`.
   */
  modelInvocable: boolean;
}

/**
 * Normalized status of agentic-pi's skill discovery for a single run.
 */
export interface SkillsStatus {
  status: string;
  discovered: number;
  skills: SkillSummary[];
  mappedPaths: string[];
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
  /** Which agentic-pi extensions were active for this run, keyed by name. */
  extensions?: ExtensionStatusMap;
  /** Skill-loading status captured from agentic-pi's `skills_status` event. */
  skills?: SkillsStatus;
}

// ── Git sandbox access (was in engine/github/profiles.ts) ────────────────────

export type GitAccessProfile = "read" | "issues-write" | "review-write" | "repo-write";

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
   * task's workspace before the sandbox container starts.
   */
  prePopulateBranch?: string;
  /**
   * The owning workflow run id. Stamped into a `<workDir>/.lastlight-run`
   * marker by the pre-clone so a reused per-PR workspace can tell "next phase
   * of the same run" from "a fresh run reusing an old PR dir".
   */
  runId?: string;
  /**
   * Clone shallowly (`--depth 1 --single-branch`). Set for read-only
   * workflows that never need history.
   */
  shallow?: boolean;
  /**
   * Recreate the workspace from the **default branch** on a fresh run instead
   * of reusing/refreshing an existing feature-branch checkout (issue #153).
   */
  recreateFromBase?: boolean;
}

// ── Deterministic command spec (was in engine/executors/orchestrator.ts) ─────

/**
 * The spec for a deterministic `type: bash` / `type: script` phase — a shell
 * command or an inline script with a runtime.
 */
export type CommandSpec =
  | { kind: "bash"; command: string }
  | { kind: "script"; script: string; runtime: "js" | "ts" | "python"; name: string };
