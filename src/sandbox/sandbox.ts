import { join, relative } from "path";
import { mkdtempSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import type { run as agenticRunType, RunResult, ThinkingLevel } from "agentic-pi";
import type { OtelConfig, SandboxBackend } from "../config/config.js";
import { createTaskSandbox, setupTaskWorktree, prePopulateWorkspace } from "./index.js";
import type { DockerSandbox as DockerDriver } from "./docker.js";
import { SmolSandbox as SmolDriver, smolAvailable, SMOL_WORKSPACE_DIR } from "./smol.js";
import { ALLOW_ALL_SENTINEL } from "./egress-allowlist.js";
import { getDockerSandboxOtelEnv, getOtelEnvForSandbox } from "../telemetry/index.js";
import {
  DOCKER_WORKSPACE_DIR,
  SKILL_BUNDLE_ROOT,
  stageSkillBundle,
  excludeFromGit,
  applyEnv,
} from "../engine/executors/shared.js";

/**
 * The **Sandbox port** — the single named interface every isolation backend
 * (`docker`, `smol`, `gondolin`, `none`) implements. Before this seam existed,
 * the orchestration around the four backends was copy-pasted twin-for-twin
 * (`executeDocker` / `executeSmol` / `executeInProcess`). Now the orchestrator
 * (`src/engine/executors/orchestrator.ts`) is written once and drives any
 * adapter through these methods.
 *
 * See `CONTEXT.md` → "Sandbox execution" for the pinned vocabulary; in short:
 *   - **Sandbox** (this interface) is the *port*.
 *   - **adapters** are the concrete backends below (`DockerSandbox`,
 *     `SmolSandbox`, `InProcessSandbox`, `FakeSandbox`). Each owns its
 *     isolation mechanism + egress enforcement; none of that surfaces here.
 *   - the **orchestrator** is the deep module that brackets a run.
 *
 * A Sandbox instance is created per task (the factory carries `taskId`), so the
 * `taskId` argument on `runAgent` / `runCommand` is threaded purely for the
 * underlying driver APIs.
 */
export interface Sandbox {
  /** Which backend this adapter is — used only for telemetry tagging. */
  readonly backend: SandboxBackend;
  /**
   * Provision the workspace and any isolation primitive (container / VM /
   * worktree). **Owns provisioning** — each adapter orders its own
   * clone-vs-boot internally (docker pre-clones then mounts; smol boots then
   * probes the share then clones; in-process just sets up the worktree) and
   * returns the two paths the orchestrator needs.
   */
  provision(prePopulate?: PrePopulateSpec): Promise<ProvisionResult>;
  /**
   * Stage this phase's skill bundle into the workspace and return the skill
   * dirs to hand the agent (already mapped to sandbox-visible paths). The
   * mode (symlink vs copy), root (workspace vs cwd), and any post-stage git
   * exclusion are adapter-local. Returns undefined when the phase has none.
   */
  stageSkills(phaseKey: string, skillPaths: string[] | undefined): string[] | undefined;
  /**
   * Map a workspace-relative path (written to `hostWorkspaceDir`) to the
   * absolute path the sandboxed process sees. Used for staged `type: script`
   * source files. docker/smol prefix the in-sandbox workspace root; in-process
   * returns the host path verbatim.
   */
  sandboxPathFor(relPath: string): string;
  /**
   * Run one agent turn. Emits **parsed** event records to `onEvent` — the
   * `startsWith("{")` guard + `JSON.parse` of the subprocess line stream live
   * inside the docker/smol adapters; the in-process adapter forwards
   * agentic-pi's already-parsed events straight through. Returns the run's
   * authoritative `RunResult` when the adapter has one (in-process), else
   * `undefined` (docker/smol) — the orchestrator reconstructs it from the
   * accumulated events in that case.
   */
  runAgent(
    taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined>;
  /** Run a deterministic shell command (no LLM). Resolves with its raw result. */
  runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult>;
  /** Tear down the isolation primitive (container/VM destroy; no-op in-process). */
  dispose(): Promise<void> | void;
}

/**
 * The **intent-only** egress value object. The orchestrator decides *what is
 * allowed* once (hosts already merged with any OTEL collector hosts); each
 * adapter translates it to its *mechanism* — docker `--dns` strict/open, smol
 * `--allow-host`, in-process `allowedHttpHosts` / `["*"]`. The `172.30.0.x`
 * constants and the `"*"` sentinel live inside the adapters, never here.
 */
export interface EgressPolicy {
  /** True iff a phase opted out of the allowlist (`unrestricted_egress`). */
  unrestricted: boolean;
  /** Allowed apex hostnames when not unrestricted (incl. collector hosts). */
  hosts: string[];
}

/** The repo pre-clone descriptor handed to {@link Sandbox.provision}. */
export interface PrePopulateSpec {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  runId?: string;
  shallow?: boolean;
}

/** What {@link Sandbox.provision} hands back to the orchestrator. */
export interface ProvisionResult {
  /** Host dir backing the workspace (where the orchestrator stages files). */
  hostWorkspaceDir: string;
  /** Working directory the agent/command process runs in (sandbox-visible). */
  agentCwd: string;
}

export type SandboxEvent = Record<string, unknown>;

export interface RunAgentOpts {
  model: string;
  thinking?: ThinkingLevel;
  /** agentic-pi github profile (`read` | `issues-write` | … ). */
  profile?: string;
  /** Base inner-run env (git identity); adapters merge their own OTEL/HOME. */
  sandboxEnv: Record<string, string>;
  agentCwd: string;
  skillDirs?: string[];
  webSearch?: boolean;
  webSearchProvider?: "tavily" | "brave" | "exa";
  /** Test/eval escape hatch — only honoured by the in-process adapter. */
  githubApiBaseUrl?: string;
  /**
   * Credential store (`auth.json`) agentic-pi points Pi's AuthStorage at for
   * model auth — carries OAuth subscription logins (Codex / Claude Pro /
   * Copilot). Only meaningful for the in-process adapter (none/gondolin), where
   * the model call runs host-side so a host path resolves; the docker adapter
   * ignores it (its model call is in-container) and relies on env tokens.
   */
  authFile?: string;
}

export interface RunCommandOpts {
  cwd: string;
  /** Extra env forwarded into the command (upstream phase outputs, etc.). */
  sandboxEnv?: Record<string, string>;
  timeoutSeconds: number;
}

export interface RawCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Construction-time opts for {@link sandboxFor} / each adapter. */
export interface SandboxFactoryOpts {
  taskId: string;
  egress: EgressPolicy;
  /** Env forwarded into the sandbox (provider keys, minted GITHUB_TOKEN, …). */
  env: Record<string, string>;
  stateDir: string;
  sandboxDir?: string;
  /** Run the agent in this `<workspace>/<repoSubdir>/` subdir (pre-seeded by the
   * caller) instead of the workspace root — see {@link ExecutorConfig.repoSubdir}. */
  repoSubdir?: string;
  /** Docker image override (the browser-QA image for `sandbox_image: qa`). */
  imageName?: string;
  otel?: OtelConfig;
  timeoutSeconds?: number;
}

export type SandboxFactory = (backend: SandboxBackend, opts: SandboxFactoryOpts) => Sandbox;

/** Inner-run git identity, shared by every adapter's agent path. */
const GIT_IDENTITY_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "last-light[bot]",
  GIT_AUTHOR_EMAIL: "last-light[bot]@users.noreply.github.com",
  GIT_COMMITTER_NAME: "last-light[bot]",
  GIT_COMMITTER_EMAIL: "last-light[bot]@users.noreply.github.com",
  // /workspace is a host-UID bind mount into a different-UID guest; git refuses
  // to operate without an explicit safe-directory. GIT_CONFIG_* avoids needing
  // a writeable ~/.gitconfig.
  GIT_CONFIG_COUNT: "1",
  GIT_CONFIG_KEY_0: "safe.directory",
  GIT_CONFIG_VALUE_0: "*",
};

/** The base (git-identity) sandbox env the orchestrator passes to `runAgent`. */
export const AGENT_GIT_IDENTITY_ENV: Record<string, string> = GIT_IDENTITY_ENV;

/**
 * The single factory replacing the `if (backend === …)` ladder. Given a
 * backend and construction opts, returns the matching adapter. Docker's
 * old null-fallback is now a thrown error from `provision` (the orchestrator's
 * bracket surfaces it), so this never returns null.
 */
export function sandboxFor(backend: SandboxBackend, opts: SandboxFactoryOpts): Sandbox {
  switch (backend) {
    case "docker":
      return new DockerSandbox(opts);
    case "smol":
      return new SmolSandbox(opts);
    case "gondolin":
      return new InProcessSandbox("gondolin", opts);
    case "none":
      return new InProcessSandbox("none", opts);
  }
}

// ── Docker adapter ──────────────────────────────────────────────────

/**
 * Wraps the docker container driver ({@link DockerDriver}) + the
 * `createTaskSandbox` provisioning helper. Egress is the strict/open coredns
 * pair selected by `--dns`; the host constants live here.
 */
class DockerSandbox implements Sandbox {
  readonly backend: SandboxBackend = "docker";
  private sbx?: { sandbox: DockerDriver; workDir: string; cleanup: () => Promise<void> };
  private agentCwd = DOCKER_WORKSPACE_DIR;

  constructor(private readonly opts: SandboxFactoryOpts) {}

  async provision(pre?: PrePopulateSpec): Promise<ProvisionResult> {
    // Strict allowlist by default; an `unrestricted_egress` phase points at the
    // open coredns sidecar instead. IPs match docker-compose.yml's static
    // assignments (see src/sandbox/egress-firewall-config.ts).
    const dnsIp = this.opts.egress.unrestricted
      ? process.env.LASTLIGHT_DNS_OPEN || "172.30.0.11"
      : process.env.LASTLIGHT_DNS_STRICT || "172.30.0.10";

    const sbx = await createTaskSandbox({
      taskId: this.opts.taskId,
      stateDir: this.opts.stateDir,
      sandboxDir: this.opts.sandboxDir,
      env: this.opts.env,
      prePopulate: pre,
      dnsIp,
      imageName: this.opts.imageName,
    });
    if (!sbx) {
      throw new Error(
        "LASTLIGHT_SANDBOX=docker but no docker sandbox was available. " +
          "Install Docker and build the sandbox image, or set LASTLIGHT_SANDBOX=gondolin / none.",
      );
    }
    this.sbx = sbx;
    this.agentCwd = pre ? `${DOCKER_WORKSPACE_DIR}/${pre.repo}` : DOCKER_WORKSPACE_DIR;
    return { hostWorkspaceDir: sbx.workDir, agentCwd: this.agentCwd };
  }

  stageSkills(phaseKey: string, skillPaths: string[] | undefined): string[] | undefined {
    if (!this.sbx) throw new Error("DockerSandbox.stageSkills before provision");
    // Copy (not symlink): the agent's tools run inside the container and host
    // symlink targets wouldn't resolve there. Map host dests → in-container paths.
    const staged = stageSkillBundle(this.sbx.workDir, phaseKey, skillPaths, "copy");
    if (!staged) return undefined;
    return staged.map((d) => `${DOCKER_WORKSPACE_DIR}/${relative(this.sbx!.workDir, d)}`);
  }

  sandboxPathFor(relPath: string): string {
    return `${DOCKER_WORKSPACE_DIR}/${relPath}`;
  }

  async runAgent(
    taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    if (!this.sbx) throw new Error("DockerSandbox.runAgent before provision");
    await this.sbx.sandbox.runAgent(taskId, prompt, {
      model: opts.model,
      thinking: opts.thinking,
      profile: opts.profile,
      sandboxEnv: this.innerAgentEnv(opts.sandboxEnv),
      agentCwd: opts.agentCwd,
      skillDirs: opts.skillDirs,
      webSearch: opts.webSearch,
      webSearchProvider: opts.webSearchProvider,
      onLine: parseLine(onEvent),
    });
    return undefined;
  }

  async runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    if (!this.sbx) throw new Error("DockerSandbox.runCommand before provision");
    return this.sbx.sandbox.runCommand(taskId, command, {
      cwd: opts.cwd,
      sandboxEnv: opts.sandboxEnv,
      timeoutSeconds: opts.timeoutSeconds,
      onLine: () => {},
    });
  }

  async dispose(): Promise<void> {
    if (this.sbx) await this.sbx.cleanup();
  }

  /** Git identity + (inside-container) OTEL collector env. */
  private innerAgentEnv(base: Record<string, string>): Record<string, string> {
    const otel = this.opts.otel?.enabled && this.opts.otel.forwardToSandbox ? getDockerSandboxOtelEnv() : {};
    return { ...otel, ...base };
  }
}

// ── smol adapter ────────────────────────────────────────────────────

/**
 * Wraps the smolvm micro-VM driver ({@link SmolDriver}). Egress is native
 * per-machine `--allow-host`; unrestricted → null (open). Provisioning boots
 * the VM first, then probes the share-backed host dir before cloning into it.
 */
class SmolSandbox implements Sandbox {
  readonly backend: SandboxBackend = "smol";
  private driver?: SmolDriver;
  private agentCwd = SMOL_WORKSPACE_DIR;
  private hostWorkspaceDir = "";

  constructor(private readonly opts: SandboxFactoryOpts) {}

  async provision(pre?: PrePopulateSpec): Promise<ProvisionResult> {
    if (!smolAvailable()) {
      throw new Error(
        "LASTLIGHT_SANDBOX=smol but the smolvm CLI is not available. " +
          "Install smolvm (https://smolmachines.com) and start `smolvm serve`, " +
          "or set LASTLIGHT_SANDBOX=docker / gondolin / none.",
      );
    }
    // Boot FIRST (workspace dir mounted), then provision the probed share. No
    // pre-clone here — see SmolSandbox.resolveHostWorkspace for why the mount
    // source isn't always the share root.
    const workDir = setupTaskWorktree({
      taskId: this.opts.taskId,
      stateDir: this.opts.stateDir,
      sandboxDir: this.opts.sandboxDir,
    });
    this.driver = new SmolDriver({
      env: this.opts.env,
      allowHosts: this.opts.egress.unrestricted ? null : this.opts.egress.hosts,
    });
    const machine = await this.driver.create({ taskId: this.opts.taskId, worktreePath: workDir });
    const hostWs = machine.hostWorkspace;
    if (pre) prePopulateWorkspace(hostWs, pre);
    this.hostWorkspaceDir = hostWs;
    this.agentCwd = pre ? `${SMOL_WORKSPACE_DIR}/${pre.repo}` : SMOL_WORKSPACE_DIR;
    return { hostWorkspaceDir: hostWs, agentCwd: this.agentCwd };
  }

  stageSkills(phaseKey: string, skillPaths: string[] | undefined): string[] | undefined {
    const staged = stageSkillBundle(this.hostWorkspaceDir, phaseKey, skillPaths, "copy");
    if (!staged) return undefined;
    return staged.map((d) => `${SMOL_WORKSPACE_DIR}/${relative(this.hostWorkspaceDir, d)}`);
  }

  sandboxPathFor(relPath: string): string {
    return `${SMOL_WORKSPACE_DIR}/${relPath}`;
  }

  async runAgent(
    taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    if (!this.driver) throw new Error("SmolSandbox.runAgent before provision");
    await this.driver.runAgent(taskId, prompt, {
      model: opts.model,
      thinking: opts.thinking,
      profile: opts.profile,
      sandboxEnv: opts.sandboxEnv,
      agentCwd: opts.agentCwd,
      skillDirs: opts.skillDirs,
      webSearch: opts.webSearch,
      webSearchProvider: opts.webSearchProvider,
      onLine: parseLine(onEvent),
    });
    return undefined;
  }

  async runCommand(taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    if (!this.driver) throw new Error("SmolSandbox.runCommand before provision");
    return this.driver.runCommand(taskId, command, {
      cwd: opts.cwd,
      sandboxEnv: opts.sandboxEnv,
      timeoutSeconds: opts.timeoutSeconds,
      onLine: () => {},
    });
  }

  async dispose(): Promise<void> {
    if (this.driver) await this.driver.destroy(this.opts.taskId);
  }
}

// ── In-process adapter (gondolin / none) ────────────────────────────

/**
 * **One** adapter for the two in-process backends, parameterized by
 * `mode: 'gondolin' | 'none'`. The two differ only in agentic-pi's `sandbox`
 * arg and a `HOME` override. Owns the `applyEnv`/restore `process.env` splice
 * and the lazy `import("agentic-pi")`.
 *
 * The `mode` flag is a **tombstone** for gondolin's planned removal — when
 * gondolin is retired it collapses to single-mode `none`.
 */
class InProcessSandbox implements Sandbox {
  readonly backend: SandboxBackend;
  private hostWorkspaceDir = "";
  private agentCwd = "";

  constructor(
    private readonly mode: "gondolin" | "none",
    private readonly opts: SandboxFactoryOpts,
  ) {
    this.backend = mode;
  }

  async provision(pre?: PrePopulateSpec): Promise<ProvisionResult> {
    const workDir = setupTaskWorktree({
      taskId: this.opts.taskId,
      stateDir: this.opts.stateDir,
      sandboxDir: this.opts.sandboxDir,
      prePopulate: pre,
    });
    this.hostWorkspaceDir = workDir;
    // When pre-cloned, cwd is the checkout so the agent runs inside the repo
    // with no `cd` preamble; otherwise the workspace root. `repoSubdir` lets a
    // caller that pre-seeded a `<workspace>/<repo>/` checkout nest the cwd the
    // same way without a clone (the evals harness) — workDir (the root) stays
    // hostWorkspaceDir so AGENTS.md/skills remain siblings outside the repo.
    if (pre) {
      this.agentCwd = join(workDir, pre.repo);
    } else if (this.opts.repoSubdir) {
      this.agentCwd = join(workDir, this.opts.repoSubdir);
      mkdirSync(this.agentCwd, { recursive: true });
    } else {
      this.agentCwd = workDir;
    }
    return { hostWorkspaceDir: workDir, agentCwd: this.agentCwd };
  }

  stageSkills(phaseKey: string, skillPaths: string[] | undefined): string[] | undefined {
    // none: stage at the workspace ROOT (host FS fully visible), by symlink —
    // the host resolves it and it's the cheap/CI path. gondolin mounts ONLY cwd
    // into the guest, so its bundle is staged under the repo (inside the mount)
    // AND must be COPIED, not symlinked: a symlink's target is the skill source
    // in the install tree (outside cwd), which isn't mounted, so it would dangle
    // in the guest and the agent couldn't read SKILL.md. Copying (dereferenced)
    // lands the real files inside the mount, exactly as docker does. The bundle
    // is added to the checkout's local `.git/info/exclude` so it's never committed.
    const gondolin = this.mode === "gondolin";
    const skillRoot = gondolin ? this.agentCwd : this.hostWorkspaceDir;
    const staged = stageSkillBundle(skillRoot, phaseKey, skillPaths, gondolin ? "copy" : "symlink");
    if (staged && gondolin) excludeFromGit(this.agentCwd, SKILL_BUNDLE_ROOT);
    return staged; // paths inside cwd → agentic-pi maps them into the guest's /workspace
  }

  sandboxPathFor(relPath: string): string {
    return join(this.hostWorkspaceDir, relPath);
  }

  async runAgent(
    _taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    // agentic-pi reads its own env (provider keys, App PEM, …) from
    // process.env. Splice in our scoped values for the call, then restore.
    const restore = applyEnv(this.opts.env);
    const allowedHttpHosts = this.opts.egress.unrestricted ? [ALLOW_ALL_SENTINEL] : this.opts.egress.hosts;
    try {
      // Loaded lazily: agentic-pi transitively poisons the global undici
      // dispatcher on import, which would break the harness's own fetch. The
      // dynamic import keeps the harness clean unless an in-process run happens.
      const { run: agenticRun }: { run: typeof agenticRunType } = await import("agentic-pi");
      return await agenticRun({
        model: opts.model,
        prompt,
        thinking: opts.thinking,
        profile: opts.profile,
        authFile: opts.authFile,
        githubApiBaseUrl: opts.githubApiBaseUrl,
        sandbox: this.mode === "gondolin" ? "gondolin" : "none",
        sandboxEnv: this.innerAgentEnv(opts.sandboxEnv),
        cwd: opts.agentCwd,
        noSession: true,
        skillPaths: opts.skillDirs,
        allowedHttpHosts,
        webSearch: opts.webSearch === true,
        webSearchProvider: opts.webSearchProvider,
        onEvent,
        onWarn: (msg) => console.warn(`[agentic] ${msg}`),
      });
    } finally {
      restore();
    }
  }

  async runCommand(_taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    // gondolin / none run the command on the host worktree via spawnSync — the
    // same degraded model those backends already used.
    const proc = spawnSync("sh", ["-c", command], {
      cwd: opts.cwd,
      env: { ...process.env, ...this.opts.env, ...(opts.sandboxEnv ?? {}) },
      encoding: "utf-8",
      timeout: opts.timeoutSeconds * 1000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const exitCode = proc.status ?? (proc.signal ? 124 : 1);
    return {
      exitCode,
      stdout: proc.stdout ?? "",
      stderr: proc.stderr ?? "",
      timedOut: proc.signal === "SIGTERM",
    };
  }

  dispose(): void {
    // No isolation primitive to tear down — the env splice is restored inside
    // runAgent, and the worktree is reaped elsewhere.
  }

  /** Git identity + OTEL env + (gondolin only) a HOME override into the VM. */
  private innerAgentEnv(base: Record<string, string>): Record<string, string> {
    const otel = this.opts.otel?.enabled && this.opts.otel.forwardToSandbox ? getOtelEnvForSandbox() : {};
    // gondolin: the VM user inherits HOME from the agentic-pi process (the
    // host's HOME leaks in). Force HOME=/root so `git config --global` /
    // `gh auth status` write to a real path inside the VM. none runs on the
    // host — never override HOME.
    const homeOverride: Record<string, string> =
      this.mode === "gondolin" ? { HOME: "/root", USER: "root", LOGNAME: "root" } : {};
    return { ...otel, ...base, ...homeOverride };
  }
}

// ── FakeSandbox (test-only) ─────────────────────────────────────────

export interface FakeBehavior {
  /** Canned parsed pi-event records replayed through `onEvent`. */
  events?: SandboxEvent[];
  /** Throw from `runAgent` to exercise the fallback path. */
  throwOnRunAgent?: Error | string;
  /** Authoritative RunResult `runAgent` returns (else undefined → acc.build). */
  returnRunResult?: RunResult;
  /** Result `runCommand` resolves with (default exit 0, empty output). */
  commandResult?: RawCommandResult;
  /** Throw from `runCommand`. */
  throwOnRunCommand?: Error | string;
}

/**
 * In-memory `Sandbox` adapter for unit-testing the orchestrator without
 * Docker/VMs. `provision()` returns a **real** `mkdtemp` workspace (so skill
 * staging + artifact harvest run for real), `runAgent` replays a canned array
 * of pi event records through `onEvent`, and it **records** the opts it
 * received for assertions. Covers Last Light's orchestration, not agentic-pi's
 * semantics.
 *
 * Inject it via the optional `sandboxFactory` on `executeAgent`/`executeCommand`
 * — see {@link FakeSandbox.asFactory}.
 */
export class FakeSandbox implements Sandbox {
  backend: SandboxBackend = "none";
  // Recorded for assertions.
  egress?: EgressPolicy;
  env?: Record<string, string>;
  hostWorkspaceDir = "";
  agentCwd = "";
  stagedSkillDirs?: string[];
  receivedAgentOpts?: RunAgentOpts;
  receivedCommandOpts?: RunCommandOpts;
  receivedCommand?: string;
  provisionCalls = 0;
  disposed = false;

  constructor(private readonly behavior: FakeBehavior = {}) {}

  /**
   * Build a {@link SandboxFactory} that always returns THIS instance, capturing
   * the construction opts (egress, env, backend) for later inspection.
   */
  asFactory(): SandboxFactory {
    return (backend, opts) => {
      this.backend = backend;
      this.egress = opts.egress;
      this.env = opts.env;
      return this;
    };
  }

  async provision(pre?: PrePopulateSpec): Promise<ProvisionResult> {
    this.provisionCalls += 1;
    const dir = mkdtempSync(join(tmpdir(), "fake-sbx-"));
    this.hostWorkspaceDir = dir;
    this.agentCwd = pre ? join(dir, pre.repo) : dir;
    if (pre) mkdirSync(this.agentCwd, { recursive: true });
    return { hostWorkspaceDir: dir, agentCwd: this.agentCwd };
  }

  stageSkills(phaseKey: string, skillPaths: string[] | undefined): string[] | undefined {
    this.stagedSkillDirs = stageSkillBundle(this.hostWorkspaceDir, phaseKey, skillPaths, "symlink");
    return this.stagedSkillDirs;
  }

  sandboxPathFor(relPath: string): string {
    return join(this.hostWorkspaceDir, relPath);
  }

  async runAgent(
    _taskId: string,
    _prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    this.receivedAgentOpts = opts;
    if (this.behavior.throwOnRunAgent) throw asError(this.behavior.throwOnRunAgent);
    for (const record of this.behavior.events ?? []) onEvent(record);
    return this.behavior.returnRunResult;
  }

  async runCommand(_taskId: string, command: string, opts: RunCommandOpts): Promise<RawCommandResult> {
    this.receivedCommand = command;
    this.receivedCommandOpts = opts;
    if (this.behavior.throwOnRunCommand) throw asError(this.behavior.throwOnRunCommand);
    return this.behavior.commandResult ?? { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  }

  dispose(): void {
    this.disposed = true;
    try {
      if (this.hostWorkspaceDir) rmSync(this.hostWorkspaceDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────

function asError(e: Error | string): Error {
  return e instanceof Error ? e : new Error(e);
}

/**
 * Wrap an `onEvent(record)` consumer as an `onLine(line)` handler for the
 * subprocess (docker/smol) drivers: apply the cheap `{`-prefix guard, parse
 * JSON, and forward the parsed record. Non-JSON / malformed lines are dropped.
 */
function parseLine(onEvent: (record: SandboxEvent) => void): (line: string) => void {
  return (line: string) => {
    if (!line.startsWith("{")) return;
    let record: SandboxEvent;
    try {
      record = JSON.parse(line) as SandboxEvent;
    } catch {
      return;
    }
    onEvent(record);
  };
}

