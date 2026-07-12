import { resolve } from "path";
import { randomUUID } from "crypto";
import { refreshGitAuth } from "./github/git-auth.js";
import {
  GITHUB_PERMISSION_PROFILES,
  type ExecutorConfig,
  type ExecutionResult,
  type GitSandboxAccess,
} from "./github/profiles.js";
import type { SandboxBackend } from "../config/config.js";
import type { PrePopulateSpec, SandboxFactory } from "../sandbox/sandbox.js";
import { getDockerSandboxOtelEnv, getOtelEnvForSandbox, safeSpanAttributes, withSpan } from "../telemetry/index.js";
import { DEFAULT_MODEL } from "./executors/shared.js";
import { PROVIDER_ENV_KEYS } from "../providers.js";
import { oauthEnvVarForProvider, oauthProviderIdForModel, resolveOAuthApiKey } from "./oauth.js";
import {
  runSandboxedAgent,
  runSandboxedCommand,
  type CommandSpec,
  type SandboxRunContext,
} from "./executors/orchestrator.js";
// Re-exported for back-compat with existing importers (tests, dashboards,
// workflow phase executor).
export { RunResultAccumulator, stageSkillBundle, excludeFromGit, detectAccountError } from "./executors/shared.js";
export type { CommandSpec } from "./executors/orchestrator.js";

/**
 * Shared run preparation for {@link executeAgent} and {@link executeCommand}:
 * resolve the taskId / state dir / backend, mint the scoped GitHub token,
 * assemble the sandbox env (git token, provider keys, OTEL), and compute the
 * pre-populate descriptor. Both the agent and the deterministic command paths
 * run in the same sandbox/workspace with the same git access, so they share
 * this setup verbatim.
 */
async function prepareRun(
  config: ExecutorConfig,
  opts?: { taskId?: string; githubAccess?: GitSandboxAccess },
): Promise<{
  taskId: string;
  stateDir: string;
  backend: SandboxBackend;
  ghEnv: Record<string, string>;
  mintedToken?: string;
  prePopulate?: PrePopulateSpec;
}> {
  const taskId = opts?.taskId || `task-${randomUUID().slice(0, 8)}`;
  const stateDir = config.stateDir || resolve("data");
  const backend: SandboxBackend = config.sandbox ?? "gondolin";

  // Mint a scoped GitHub App token. Same flow as the legacy executor —
  // defense in depth so a downstream tool gating regression can't burn
  // more access than the profile allowed.
  //
  // GITHUB_APP_* env vars are forwarded to agentic-pi *only* when the access
  // profile opts into App PEM access via `allowMcpAppAuth`. That is currently
  // never set (see gitSandboxAccessForWorkflow): the github extension can't
  // read the PEM in the sandbox and skips rather than falling back, so we keep
  // the App key out entirely and every run uses just the minted `GITHUB_TOKEN`
  // below — which also stops agents minting elevated tokens themselves. The
  // branch is retained so per-profile App auth can be re-enabled if the
  // sandbox-side PEM is ever materialized.
  const ghEnv: Record<string, string> = {};
  let mintedToken: string | undefined;
  const access = opts?.githubAccess;
  const allowAppAuth = access?.allowMcpAppAuth === true;
  if (process.env.GITHUB_APP_ID && allowAppAuth) {
    ghEnv.GITHUB_APP_ID = process.env.GITHUB_APP_ID;
    if (process.env.GITHUB_APP_INSTALLATION_ID) {
      ghEnv.GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
    }
    if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
      ghEnv.GITHUB_APP_PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    }
  } else {
    // Suppress for in-process runs that inherit our env. Empty strings
    // override the inherited value via `applyEnv()`.
    ghEnv.GITHUB_APP_ID = "";
    ghEnv.GITHUB_APP_INSTALLATION_ID = "";
    ghEnv.GITHUB_APP_PRIVATE_KEY_PATH = "";
  }
  if (process.env.GITHUB_APP_ID && access) {
    try {
      const permissions = GITHUB_PERMISSION_PROFILES[access.profile];
      const repositories = access.repo ? [access.repo] : undefined;
      console.log(
        `[executor] Minting git token: profile=${access.profile}, ` +
        `repo=${access.repo || "(unscoped)"}, permissions=${permissions ? Object.keys(permissions).join(",") : "all"}`,
      );
      const { token } = await refreshGitAuth({
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
        installationId: process.env.GITHUB_APP_INSTALLATION_ID || "",
        permissions,
        repositories,
      });
      mintedToken = token;
      ghEnv.GITHUB_TOKEN = token;
      ghEnv.GIT_TOKEN = token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[executor] Could not mint git token (repo=${access.repo || "none"}, ` +
        `profile=${access.profile}): ${msg}`,
      );
    }
  } else if (process.env.GITHUB_TOKEN && access) {
    // PAT fallback: no GitHub App, but a static Personal Access Token is set.
    // Forward it directly — a PAT can't be per-run downscoped like an App
    // installation token, so it carries whatever scopes GitHub granted. A
    // read-only fine-grained PAT is the safe default; warn on repo-write
    // profiles so an operator running build/pr-fix under a PAT knows the
    // requested downscope isn't being applied.
    if (GITHUB_PERMISSION_PROFILES[access.profile]?.contents === "write") {
      console.warn(
        `[executor] Using a static GITHUB_TOKEN for a repo-write workflow ` +
        `(profile=${access.profile}, repo=${access.repo || "none"}) — the PAT's ` +
        `own scopes apply (no per-run downscoping).`,
      );
    }
    mintedToken = process.env.GITHUB_TOKEN;
    ghEnv.GITHUB_TOKEN = process.env.GITHUB_TOKEN;
    ghEnv.GIT_TOKEN = process.env.GITHUB_TOKEN;
  }

  // Provider API keys. Forwarded in registry order — see `src/providers.ts`
  // (the single source of truth for wizard-able providers). Every entry a
  // user can pick in the setup wizard is reachable from the sandbox because
  // the egress firewall list is also derived from the same registry's hosts.
  for (const envKey of PROVIDER_ENV_KEYS) {
    const v = process.env[envKey];
    if (v) ghEnv[envKey] = v;
  }

  // OAuth-backed providers (subscription logins: Codex / Claude Pro / Copilot).
  //
  // In-process backends (none/gondolin) run the model call host-side, so the
  // orchestrator hands agentic-pi `authFile` = our credential store and Pi's
  // AuthStorage resolves EVERY OAuth provider (Codex included) from it. Nothing
  // to do here for those backends.
  //
  // Container backends (docker/smol) run the model call inside the guest, where
  // that host path can't be read — so we inject the refreshed token via the env
  // var pi reads in-guest (ANTHROPIC_OAUTH_TOKEN / COPILOT_GITHUB_TOKEN). Codex
  // has no in-guest env route (chatgpt.com backend), so it can't authenticate
  // there — warn rather than 401 mid-run, and point at a host-side backend.
  const inProcessBackend = backend === "none" || backend === "gondolin";
  const modelSpec = config.model || DEFAULT_MODEL;
  const oauthId = oauthProviderIdForModel(modelSpec);
  if (oauthId && !inProcessBackend) {
    const oauthEnvVar = oauthEnvVarForProvider(oauthId);
    if (!oauthEnvVar) {
      console.warn(
        `[executor] Model '${modelSpec}' uses OAuth provider '${oauthId}', which has no ` +
          `in-guest env route — the '${backend}' sandbox can't authenticate it. Use the ` +
          `gondolin/none backend (host-side auth via the credential store) or an API-key provider.`,
      );
    } else if (!ghEnv[oauthEnvVar] && !process.env[oauthEnvVar]) {
      // Only mint from stored creds when an explicit token isn't already set.
      try {
        const res = await resolveOAuthApiKey(oauthId, undefined, stateDir);
        if (res) {
          ghEnv[oauthEnvVar] = res.apiKey;
        } else {
          console.warn(
            `[executor] Model '${modelSpec}' needs an OAuth login for '${oauthId}' but none is ` +
              `stored. Run: lastlight oauth login ${oauthId}`,
          );
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[executor] OAuth token refresh failed for '${oauthId}': ${msg}`);
      }
    }
  }

  // Web-search provider keys. Forwarded only when the workflow opted into
  // web search (scoped to explore today; see webSearchEnabledForWorkflow
  // in workflows/runner.ts). agentic-pi auto-detects the provider from
  // whichever key is present (Tavily > Exa > Brave by default).
  if (config.webSearch) {
    if (process.env.TAVILY_API_KEY) ghEnv.TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    if (process.env.BRAVE_SEARCH_API_KEY) ghEnv.BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
    if (process.env.EXA_API_KEY) ghEnv.EXA_API_KEY = process.env.EXA_API_KEY;
  }

  // OTEL config for the agent runtime itself. On docker the agent runs
  // inside the container, so it reads this (the container env) and is
  // pointed at the in-network collector — never the real backend or its
  // auth headers. On gondolin/none the agent runs in the harness process
  // and inherits the harness SDK; forwarding the host's OTEL_* here just
  // re-affirms that config for any child processes.
  if (config.otel?.enabled && config.otel.forwardToSandbox) {
    Object.assign(ghEnv, backend === "docker" ? getDockerSandboxOtelEnv() : getOtelEnvForSandbox());
  }

  const prePopulate =
    access?.prePopulateBranch && mintedToken
      ? {
          owner: access.owner,
          repo: access.repo,
          branch: access.prePopulateBranch,
          token: mintedToken,
          runId: access.runId,
          shallow: access.shallow,
          recreateFromBase: access.recreateFromBase,
        }
      : undefined;

  return { taskId, stateDir, backend, ghEnv, mintedToken, prePopulate };
}

export async function executeAgent(
  prompt: string,
  config: ExecutorConfig,
  opts?: {
    taskId?: string;
    /**
     * Fired as soon as the run gets a session id. Used to persist the id
     * onto the in-flight executions row so the dashboard can deep-link
     * the running phase to its live JSONL.
     */
    onSessionId?: (sessionId: string) => void;
    githubAccess?: GitSandboxAccess;
    /** Test seam — substitute a FakeSandbox. Defaults to the real factory. */
    sandboxFactory?: SandboxFactory;
  },
): Promise<ExecutionResult> {
  const { taskId, stateDir, backend, ghEnv, prePopulate } = await prepareRun(config, opts);
  const access = opts?.githubAccess;

  const spanAttrs = safeSpanAttributes({
    "agent.runtime": "agentic-pi",
    "sandbox.backend": backend,
    "task.id": taskId,
    repo: access?.repo,
    "github.profile": access?.profile,
    model: config.model || DEFAULT_MODEL,
    variant: config.variant,
    "web_search.enabled": config.webSearch === true,
    unrestricted_egress: config.unrestrictedEgress === true,
    "workflow.name": config.telemetry?.workflowName,
    "phase.name": config.telemetry?.phaseName,
  });

  const ctx: SandboxRunContext = {
    config,
    taskId,
    stateDir,
    backend,
    env: ghEnv,
    prePopulate,
    access,
    onSessionId: opts?.onSessionId,
    sandboxFactory: opts?.sandboxFactory,
  };
  return withSpan("lastlight.agent.execute", spanAttrs, () => runSandboxedAgent(prompt, ctx));
}

// ── Deterministic command path (type: bash / type: script) ───────────
//
// Runs a deterministic shell command (or inline script) inside the SAME
// sandbox/workspace an agent phase would use — no LLM. The command's output is
// mirrored to a Claude-SDK-style session jsonl via the AgenticShim (the same
// shim agent phases use), so a bash/script phase shows up in the admin console
// and `lastlight session log` exactly like an agent turn: the command renders
// as a `bash` tool_use and its stdout/stderr as the tool_result.

export async function executeCommand(
  spec: CommandSpec,
  config: ExecutorConfig,
  opts?: {
    taskId?: string;
    githubAccess?: GitSandboxAccess;
    /** Per-step timeout in seconds. */
    timeoutSeconds?: number;
    /** Extra env forwarded into the command (e.g. upstream phase outputs). */
    sandboxEnv?: Record<string, string>;
    onSessionId?: (sessionId: string) => void;
    /**
     * Mirror the command output to a session jsonl (visible in the dashboard +
     * CLI). Default true. Set false for internal checks like `until_bash` that
     * shouldn't create a user-facing session log.
     */
    writeSession?: boolean;
    /** Test seam — substitute a FakeSandbox. Defaults to the real factory. */
    sandboxFactory?: SandboxFactory;
  },
): Promise<ExecutionResult> {
  const { taskId, stateDir, backend, ghEnv, prePopulate } = await prepareRun(config, opts);
  const access = opts?.githubAccess;

  const spanAttrs = safeSpanAttributes({
    "agent.runtime": spec.kind,
    "sandbox.backend": backend,
    "task.id": taskId,
    repo: access?.repo,
    "github.profile": access?.profile,
    unrestricted_egress: config.unrestrictedEgress === true,
    "workflow.name": config.telemetry?.workflowName,
    "phase.name": config.telemetry?.phaseName,
  });

  const ctx: SandboxRunContext = {
    config,
    taskId,
    stateDir,
    backend,
    env: ghEnv,
    prePopulate,
    access,
    onSessionId: opts?.onSessionId,
    sandboxFactory: opts?.sandboxFactory,
  };
  return withSpan("lastlight.command.execute", spanAttrs, () =>
    runSandboxedCommand(spec, ctx, {
      timeoutSeconds: opts?.timeoutSeconds,
      sandboxEnv: opts?.sandboxEnv,
      writeSession: opts?.writeSession,
    }),
  );
}
