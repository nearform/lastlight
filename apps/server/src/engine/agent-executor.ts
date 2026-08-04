import { resolve } from "path";
import { randomUUID } from "crypto";
import { refreshGitAuth } from "./github/git-auth.js";
import { getInstallationDirectory } from "./github/installations.js";
import {
  GITHUB_PERMISSION_PROFILES,
  type ExecutorConfig,
  type ExecutionResult,
  type GitSandboxAccess,
} from "./github/profiles.js";
import { getRuntimeConfig, type SandboxBackend } from "../config/config.js";
import type { PrePopulateSpec, SandboxFactory } from "../sandbox/sandbox.js";
import { getDockerSandboxOtelEnv, getOtelEnvForSandbox, safeSpanAttributes, withSpan } from "../telemetry/index.js";
import { OI, SpanKind, splitProviderModel } from "../telemetry/openinference.js";
import { DEFAULT_MODEL } from "./executors/shared.js";
import { PROVIDER_ENV_KEYS, providerByPrefix } from "lastlight-shared/providers";
import {
  OAUTH_ONLY_PROVIDERS,
  oauthEnvVarForProvider,
  oauthProviderIdForModel,
  resolveOAuthApiKey,
} from "./oauth.js";
import {
  runSandboxedAgent,
  runSandboxedCommand,
  type CommandSpec,
  type SandboxRunContext,
} from "./executors/orchestrator.js";
import { logger } from "../logging/logger.js";

const log = logger("executor");
// Re-exported for back-compat with existing importers (tests, dashboards,
// workflow phase executor).
export { RunResultAccumulator, stageSkillBundle, excludeFromGit, resetVerifyScript, VERIFY_SCRIPT_NAME, detectAccountError, mapStopReason, reclassifySuccess } from "./executors/shared.js";
export type { CommandSpec } from "./executors/orchestrator.js";

/**
 * The GitHub App credentials a run mints from, or undefined for the PAT path.
 *
 * `installationId` is deliberately absent: a mint is scoped to ONE installation
 * and the App may be installed on several accounts, so it is resolved from the
 * run's owner at mint time (via `InstallationDirectory`) rather than carried as
 * a single configured value.
 */
type GithubAppCreds = { appId: string; privateKeyPath: string };

/**
 * Resolve the App credentials to mint with from **boot config**, falling back to
 * `process.env` only when no config has been loaded (unit tests, embedders).
 *
 * Never gate the mint on live `process.env.GITHUB_APP_ID`. That was the second
 * half of issue #215: concurrent in-process runs used to splice `GITHUB_APP_* =
 * ""` into the shared env, and an interleaved restore could leave it falsy for
 * good — after which every run silently *skipped* the mint and forwarded whatever
 * stale `GITHUB_TOKEN` the last splice had left behind (wrong repo, wrong
 * profile, expired within the hour). `getRuntimeConfig()` is loaded once at boot,
 * so it can't be raced. Same reasoning as `resolveReviewGitHubClient` in
 * `workflows/handlers/post-review.ts`.
 *
 * `githubApiBaseUrl` set means GitHub is mocked (the evals harness points it at
 * an in-process fake and unsets the App env deliberately) — never mint against a
 * real installation for those runs; the static eval token is used instead.
 */
function resolveGithubApp(config: ExecutorConfig): GithubAppCreds | undefined {
  if (config.githubApiBaseUrl) return undefined;
  const fromConfig = getRuntimeConfig()?.githubApp;
  if (fromConfig) return { appId: fromConfig.appId, privateKeyPath: fromConfig.privateKeyPath };
  if (!process.env.GITHUB_APP_ID) return undefined;
  return {
    appId: process.env.GITHUB_APP_ID,
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
  };
}

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
  /**
   * Set when a scoped GitHub token was expected (App configured + a github
   * access profile requested) but the mint FAILED. The caller must not run a
   * toolless agent in that case — without a token agentic-pi skips the entire
   * github extension (no `github_*` tools) and any pre-clone would fail too, so
   * the run can only flail. Callers fail the phase fast with this message.
   */
  mintError?: string;
  /** Which of the two failure modes {@link mintFailureResult} should describe. */
  mintErrorKind?: MintErrorKind;
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
  //
  // `ghEnv` is the run's ONLY GitHub credential carrier: the container backends
  // pass it as the container env, and the in-process ones hand the same keys to
  // agentic-pi as `githubAuthEnv` (see `githubAuthEnvFrom` — an absent key means
  // "no credential", so nothing has to be blanked out here to suppress the
  // harness's own env any more; that blanking was issue #215).
  const ghEnv: Record<string, string> = {};
  let mintedToken: string | undefined;
  let mintError: string | undefined;
  let mintErrorKind: MintErrorKind | undefined;
  const access = opts?.githubAccess;
  const allowAppAuth = access?.allowMcpAppAuth === true;
  const app = resolveGithubApp(config);

  // WHICH installation to mint against is a function of the run's OWNER. A
  // GitHub App installed on N accounts has N installation ids, and a token
  // minted against the wrong one 422s ("at least one repository ... is not
  // accessible to the parent installation") — which is precisely what every run
  // against a second org used to do. Resolved before the mint so an owner the
  // App simply isn't installed on fails with that sentence rather than GitHub's.
  //
  // A run with no owner at all (a repo-less Slack-scoped run) has nothing to
  // resolve against, so it falls back to the sole installation when there is
  // exactly one — see `soleInstallationId`.
  const directory = app ? getInstallationDirectory() : undefined;
  const installationId = access?.owner
    ? await directory?.resolve(access.owner)
    : await directory?.soleInstallationId();

  if (app && allowAppAuth && installationId) {
    ghEnv.GITHUB_APP_ID = app.appId;
    ghEnv.GITHUB_APP_INSTALLATION_ID = installationId;
    ghEnv.GITHUB_APP_PRIVATE_KEY_PATH = app.privateKeyPath;
  }
  if (app && access?.owner && !installationId) {
    mintErrorKind = "not-installed";
    mintError = `the GitHub App is not installed on "${access.owner}"`;
    log.warn("No GitHub App installation for owner", {
      taskId,
      owner: access.owner,
      repo: access.repo || "none",
      profile: access.profile,
    });
  } else if (app && access && !installationId) {
    // Ownerless run, several installations — no defensible pick. Not fatal:
    // there is no repo to act on, so the agent simply runs without a token.
    log.warn("Ownerless run with multiple App installations — no token minted", { taskId });
  } else if (app && access && installationId) {
    try {
      const permissions = GITHUB_PERMISSION_PROFILES[access.profile];
      const repositories = access.repo ? [access.repo] : undefined;
      // `task=` matters when runs overlap: several in-process runs interleave
      // their mints in one log, and without the task id you can't tell which
      // credential belongs to the run that later 403s (issue #215). `installation`
      // matters for the same reason across accounts.
      log.info("Minting git token", {
        taskId,
        profile: access.profile,
        owner: access.owner,
        installationId,
        repo: access.repo || "(unscoped)",
        permissions: permissions ? Object.keys(permissions).join(",") : "all",
      });
      const { token } = await refreshGitAuth({
        appId: app.appId,
        privateKeyPath: app.privateKeyPath,
        installationId,
        permissions,
        repositories,
      });
      mintedToken = token;
      ghEnv.GITHUB_TOKEN = token;
      ghEnv.GIT_TOKEN = token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // A repo-scoped mint that 422s against the RIGHT installation means the
      // installation can't access this repo (deleted / transferred / access
      // revoked). Record it so the caller fails the phase loudly instead of
      // running a toolless agent.
      mintError = msg;
      mintErrorKind = "mint-failed";
      log.warn("Could not mint git token", {
        owner: access.owner,
        repo: access.repo || "none",
        installationId,
        profile: access.profile,
        err,
      });
    }
  } else if (access) {
    // PAT fallback: no GitHub App, but a static Personal Access Token is set.
    // Forward it directly — a PAT can't be per-run downscoped like an App
    // installation token, so it carries whatever scopes GitHub granted. A
    // read-only fine-grained PAT is the safe default; warn on repo-write
    // profiles so an operator running build/pr-fix under a PAT knows the
    // requested downscope isn't being applied.
    const pat = getRuntimeConfig()?.githubToken || process.env.GITHUB_TOKEN;
    if (pat) {
      if (GITHUB_PERMISSION_PROFILES[access.profile]?.contents === "write") {
        log.warn(
          "Using a static, operator-supplied GITHUB_TOKEN for a repo-write workflow — no App " +
            "configured, so this token was NOT minted for this run and the PAT's own scopes apply " +
            "(no per-run downscoping)",
          { taskId, profile: access.profile, repo: access.repo || "none" },
        );
      }
      mintedToken = pat;
      ghEnv.GITHUB_TOKEN = pat;
      ghEnv.GIT_TOKEN = pat;
    }
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
      log.warn(
        "Model uses OAuth provider with no in-guest env route — sandbox backend can't authenticate " +
          "it; use gondolin/none (host-side auth via the credential store) or an API-key provider",
        { modelSpec, oauthId, backend },
      );
    } else if (!ghEnv[oauthEnvVar] && !process.env[oauthEnvVar]) {
      // Only mint from stored creds when an explicit token isn't already set.
      try {
        const res = await resolveOAuthApiKey(oauthId, undefined, stateDir);
        if (res) {
          ghEnv[oauthEnvVar] = res.apiKey;
        } else {
          // No stored OAuth creds. Stay silent when the provider can fall back
          // to an API key that's already present (e.g. `anthropic` via
          // ANTHROPIC_API_KEY, forwarded above) — the sandbox authenticates
          // fine, so warning about a missing OAuth login on every run was pure
          // noise. Only warn when there's genuinely no usable credential: an
          // oauth-only provider (Codex/Copilot) or no API key configured.
          const apiKeyEnv = providerByPrefix(oauthId)?.envKey;
          const hasApiKey = !!apiKeyEnv && (!!ghEnv[apiKeyEnv] || !!process.env[apiKeyEnv]);
          if (OAUTH_ONLY_PROVIDERS.has(oauthId) || !hasApiKey) {
            log.warn("Model needs an OAuth login but none is stored", {
              modelSpec,
              oauthId,
              hint: `lastlight oauth login ${oauthId}`,
            });
          }
        }
      } catch (err: unknown) {
        log.warn("OAuth token refresh failed", { oauthId, err });
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
          baseBranch: access.baseBranch,
          token: mintedToken,
          runId: access.runId,
          shallow: access.shallow,
          recreateFromBase: access.recreateFromBase,
        }
      : undefined;

  return { taskId, stateDir, backend, ghEnv, mintedToken, prePopulate, mintError, mintErrorKind };
}

/**
 * Why a run has no scoped GitHub token. Two genuinely different operator
 * actions, so they get two different sentences:
 *  - `not-installed` — the App has no usable installation on the repo's
 *    ACCOUNT: never installed, uninstalled, or suspended (a suspended
 *    installation still exists but 403s every mint). Install or un-suspend it
 *    there. (The 422 GitHub returns for the first case says "repository ... not
 *    accessible to the parent installation", which reads like a repo problem
 *    and sent the operator looking in the wrong place.)
 *  - `mint-failed`   — the right installation exists but rejected the mint:
 *    the repo was deleted, transferred, or its access revoked.
 */
type MintErrorKind = "not-installed" | "mint-failed";

/**
 * Build the failed {@link ExecutionResult} returned when a scoped GitHub token
 * was expected but couldn't be minted (see `mintError`). Surfaced as a hard
 * phase failure (`error_fatal`) so the run stops cleanly with an actionable
 * message rather than handing the agent a session with no `github_*` tools.
 */
function mintFailureResult(
  access: GitSandboxAccess | undefined,
  mintError: string,
  kind: MintErrorKind = "mint-failed",
): ExecutionResult {
  const target = access ? `${access.owner}/${access.repo}` : "the target repo";
  const remedy =
    kind === "not-installed"
      ? `Install the GitHub App on the "${access?.owner ?? "target"}" account — ` +
        `or un-suspend it there if it is installed but suspended, or remove ` +
        `${access?.owner ?? "that owner"}/* from managedRepos.`
      : `The GitHub App installation can't access this repo (deleted, ` +
        `transferred to another org, or access revoked) — remove it from ` +
        `managedRepos or grant the App access to the repo.`;
  return {
    success: false,
    output: "",
    turns: 0,
    durationMs: 0,
    stopReason: "error_fatal",
    error:
      `Could not mint a scoped GitHub token for ${target} ` +
      `(profile=${access?.profile ?? "?"}): ${mintError}. ${remedy}`,
  };
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
  const { taskId, stateDir, backend, ghEnv, prePopulate, mintError, mintErrorKind } =
    await prepareRun(config, opts);
  const access = opts?.githubAccess;

  // Fail fast: an expected-but-failed token mint means no github_* tools (and a
  // doomed pre-clone). Don't burn a sandbox on a toolless run.
  if (mintError) return mintFailureResult(access, mintError, mintErrorKind);

  const runModel = config.model || DEFAULT_MODEL;
  const { system, modelName } = splitProviderModel(runModel);
  const spanAttrs = safeSpanAttributes({
    "agent.runtime": "agentic-pi",
    "sandbox.backend": backend,
    "task.id": taskId,
    repo: access?.repo,
    "github.profile": access?.profile,
    model: runModel,
    variant: config.variant,
    "web_search.enabled": config.webSearch === true,
    unrestricted_egress: config.unrestrictedEgress === true,
    "workflow.name": config.telemetry?.workflowName,
    "phase.name": config.telemetry?.phaseName,
    // OpenInference: render this as an AGENT span (model/tokens/cost) in Phoenix.
    // The keys survive safeSpanAttributes (they don't match the content scrubber);
    // per-turn tokens + cost are set later via the AgentSpanTree + setSpanAttributes.
    [OI.SPAN_KIND]: SpanKind.AGENT,
    ...(modelName ? { [OI.LLM_MODEL_NAME]: modelName } : {}),
    ...(system ? { [OI.LLM_SYSTEM]: system } : {}),
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
  return withSpan("lastlight.agent.execute", spanAttrs, (span) => runSandboxedAgent(prompt, ctx, span));
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
  const { taskId, stateDir, backend, ghEnv, prePopulate, mintError, mintErrorKind } =
    await prepareRun(config, opts);
  const access = opts?.githubAccess;

  if (mintError) return mintFailureResult(access, mintError, mintErrorKind);

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
