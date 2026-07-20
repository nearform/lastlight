import { execFileSync, execFile as execFileCb, spawn } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFileCb);

/**
 * Docker sandbox manager — runs agent tasks in isolated sibling containers.
 *
 * The sandbox image bakes immutable assets at /app/ (skills, agent-context,
 * MCP server, MCP config template). Its entrypoint wires them into the
 * workspace after volumes are mounted — no post-run docker exec needed.
 *
 * Volumes mounted at runtime:
 * - Shared data volume (/data): secrets (app.pem), session logs
 * - Task worktree (/home/agent/workspace): per-task git repo
 */

export interface SandboxConfig {
  /** Docker image for sandbox containers (default: lastlight-sandbox:latest) */
  imageName: string;
  /** Env vars to inject into the sandbox */
  env: Record<string, string>;
  /** Timeout in seconds (default: 1800 = 30 min) */
  timeoutSeconds?: number;
  /**
   * Per-sandbox memory cap, in Docker's `--memory` format (e.g. "2g", "512m").
   * Default: 2g — enough headroom for `npm install`, vite build, and an
   * agent loop, but small enough that several concurrent sandboxes can't
   * exhaust a 16 GB host. Override via the `SANDBOX_MEMORY_LIMIT` env var.
   */
  memoryLimit?: string;
  /**
   * Docker network to attach the sandbox container to. Defaults to
   * `LASTLIGHT_SANDBOX_NETWORK` env var or `lastlight_sandbox-egress`
   * (the `internal: true` network declared in docker-compose.yml). The
   * sandbox can only reach the public internet through the nginx-egress
   * firewall sidecars on this network.
   */
  network?: string;
  /**
   * IP of the coredns sidecar this sandbox uses as its DNS resolver.
   * `coredns-strict` (172.30.0.10) returns the strict-nginx IP for
   * allowlisted hosts and NXDOMAIN for everything else; `coredns-open`
   * (172.30.0.11) returns the open-nginx IP for any hostname (minus a
   * small SSRF deny set). Passed to `docker run` as `--dns <ip>`.
   *
   * No env vars are injected — the sandbox has no idea a firewall is
   * in front of it. Works for every SDK regardless of whether it
   * honours HTTP_PROXY / HTTPS_PROXY.
   */
  dnsIp?: string;
}

export interface SandboxInfo {
  containerId: string;
  containerName: string;
  worktreePath: string;
}

/**
 * How `/home/agent/workspace` is materialized inside the sandbox container.
 *
 * - `bind`: classic host-path bind mount. Only safe when the host filesystem
 *   path is identical from the harness's view and the docker daemon's view —
 *   i.e. local dev where the harness runs directly on the host, or any
 *   deployment where `SANDBOX_DATA_VOLUME` is a real host path.
 * - `volume-subpath`: mount a subpath of a named docker volume. Required
 *   when the harness runs inside a container that holds the data dir via a
 *   named volume (the standard docker-compose setup). A bare bind would
 *   resolve `/app/data/sandboxes/<id>` against the host's empty bare-FS
 *   `/app/data/...` rather than the named volume's `_data/sandboxes/<id>`,
 *   producing two divergent trees and breaking skill staging.
 */
export type WorkspaceMount =
  | { type: "bind"; hostPath: string }
  | { type: "volume-subpath"; volume: string; subpath: string };

const WORKSPACE_DIR = "/home/agent/workspace";
/** Shared package-manager download cache mount (issue #107). */
const PKG_CACHE_DIR = "/cache";

export class DockerSandbox {
  private config: SandboxConfig;
  private activeContainers: Map<string, SandboxInfo> = new Map();

  constructor(config: SandboxConfig) {
    this.config = config;
  }

  /**
   * Create and start a sandbox container for a task.
   */
  async create(opts: {
    taskId: string;
    worktreePath: string;
    workspaceMount: WorkspaceMount;
  }): Promise<SandboxInfo> {
    const containerName = `lastlight-sandbox-${opts.taskId}-${randomUUID().slice(0, 8)}`;
    const worktreePath = resolve(opts.worktreePath);

    // Shared data — mounted at /data inside the sandbox. Contains secrets
    // (app.pem) and the agent-sessions session-jsonl tree (see
    // deploy/sandbox-entrypoint.sh for the layout it expects).
    //
    // SANDBOX_DATA_VOLUME accepts either:
    //   - a Docker named volume name (e.g. "lastlight_agent-data") — used in
    //     production where the harness runs in the same compose stack
    //   - a host filesystem path (relative or absolute, starting with `/`,
    //     `.`, or `~`) — used in local dev so the host can inspect/edit the
    //     same dir without copying things in and out of a named volume
    //
    // Default is the production named volume, so existing behavior is preserved.
    const dataVolumeRaw = process.env.SANDBOX_DATA_VOLUME || "lastlight_agent-data";
    const dataMount = isPathLike(dataVolumeRaw)
      ? resolveHostPath(dataVolumeRaw)  // bind mount → absolute host path
      : dataVolumeRaw;                  // named volume → pass through

    // /data is the same volume the workspace is carved out of (or the same
    // host path), so the same -v form covers both — bind for path mode,
    // named volume for volume mode. The workspace itself needs the more
    // precise `--mount … volume-subpath=…` form in volume mode so the
    // sandbox sees the harness's sandboxes/<taskId>/ dir rather than an
    // empty docker-auto-created bind target on the host filesystem (the
    // bug that made staged skills invisible — the two paths look identical
    // but live in different physical locations).
    const dockerArgs: string[] = ["-v", `${dataMount}:/data`];
    if (opts.workspaceMount.type === "bind") {
      dockerArgs.push("-v", `${opts.workspaceMount.hostPath}:${WORKSPACE_DIR}`);
    } else {
      const { volume, subpath } = opts.workspaceMount;
      dockerArgs.push(
        "--mount",
        `type=volume,source=${volume},target=${WORKSPACE_DIR},volume-subpath=${subpath}`,
      );
    }

    // Shared package-manager cache, mounted at /cache and shared across every
    // sandbox (issue #107). Each ecosystem's download cache is content-
    // addressed, so sharing across repos is safe and avoids re-fetching the
    // same tarballs on every run. We point npm / pnpm / yarn at subdirs of it
    // via env below; the entrypoint chowns them to the agent user. This is the
    // *download* cache only — per-workspace `node_modules` stays per-workspace
    // (a shared store can't hardlink across separate container mounts anyway).
    //
    // A Docker named volume (auto-created on first use); override the name with
    // LASTLIGHT_PKG_CACHE_VOLUME. In local path-mode this is still a named
    // volume — it needs no host-path view, so the volume/bind split that the
    // workspace mount needs doesn't apply here.
    const pkgCacheVolume = process.env.LASTLIGHT_PKG_CACHE_VOLUME || "lastlight_pkg-cache";
    dockerArgs.push("-v", `${pkgCacheVolume}:${PKG_CACHE_DIR}`);
    // Point each package manager at its shared subdir. npm reads npm_config_cache;
    // pnpm reads npm-style env config (npm_config_store_dir → store-dir); yarn
    // (classic + berry) reads YARN_CACHE_FOLDER; uv (python `type: script`
    // phases) reads UV_CACHE_DIR. The agent already picks the PM from the repo's
    // lockfile (see skills/pr-review/SKILL.md), so all are wired regardless of
    // which one a given repo uses.
    dockerArgs.push(
      "-e", `npm_config_cache=${PKG_CACHE_DIR}/npm`,
      "-e", `npm_config_store_dir=${PKG_CACHE_DIR}/pnpm`,
      "-e", `YARN_CACHE_FOLDER=${PKG_CACHE_DIR}/yarn`,
      "-e", `UV_CACHE_DIR=${PKG_CACHE_DIR}/uv`,
      // uv resolves PEP 723 deps from PyPI (pypi.org / pythonhosted.org are in
      // the strict egress allowlist). Pin it to the baked-in system python3 so
      // it never tries to fetch a managed interpreter from astral.sh / GitHub
      // (not guaranteed reachable under strict egress).
      "-e", "UV_PYTHON_DOWNLOADS=never",
    );

    // Resolve git mounts for worktrees (if .git is a file pointing elsewhere).
    // In volume-subpath mode these are still emitted as bind mounts; the
    // gitMounts path is only hit for git worktrees that live alongside the
    // sandbox in the same data dir, so for the named-volume case the
    // sources would also be invisible from the daemon's view. The codebase
    // doesn't currently exercise that combination — pre-clones always
    // produce a real .git directory inside worktreePath — so leaving the
    // bind form here keeps the existing path mode working without adding
    // dead complexity to the named-volume path. If we ever wire a real
    // git worktree under volume mode this needs the same translation.
    const gitMounts = this.resolveGitMounts(worktreePath).flatMap((m) => ["-v", m]);
    dockerArgs.push(...gitMounts);

    // Env flags — passed to entrypoint for MCP config template expansion.
    // No proxy env (HTTPS_PROXY etc.) is injected: the sandbox-egress
    // network has no route to the public internet, and the coredns
    // sidecar referenced by --dns below sinkholes allowlisted hosts to
    // the nginx-egress firewall IP. Clients dial real hostnames; the
    // network routes them transparently. See egress-firewall-config.ts.
    const envFlags = Object.entries(this.config.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    // Per-sandbox memory cap. Without this, a runaway agent (or a hot
    // `npm install` / vite build inside the workspace) can OOM the host
    // and take every other container with it. We set --memory-swap to the
    // same value so swap can't be used to silently exceed the cap.
    const memoryLimit = this.config.memoryLimit || "2g";

    // Network attachment. Default is the `internal: true` sandbox-egress
    // network declared in docker-compose.yml, which has no host route —
    // the only outbound path is through nginx-egress, reached via the
    // DNS sinkhole. Override via LASTLIGHT_SANDBOX_NETWORK for setups
    // (local dev, alt orchestration) where the harness was started
    // outside docker-compose and the network hasn't been created.
    const network =
      this.config.network ||
      process.env.LASTLIGHT_SANDBOX_NETWORK ||
      "lastlight_sandbox-egress";
    const networkArgs = network === "default" ? [] : ["--network", network];

    // DNS resolver. Points at coredns-strict or coredns-open depending on
    // the phase's egress policy. The whole filtering scheme hinges on
    // this — every name lookup happens against our sinkhole, and
    // allowlisted hosts get answered with the nginx-egress IP rather
    // than the real one.
    const dnsArgs = this.config.dnsIp ? ["--dns", this.config.dnsIp] : [];

    // The entrypoint runs as root to fix permissions, then drops to agent via gosu.
    // No --user flag needed.
    const args = [
      "run", "-d",
      "--name", containerName,
      "--memory", memoryLimit,
      "--memory-swap", memoryLimit,
      ...networkArgs,
      ...dnsArgs,
      ...envFlags,
      ...dockerArgs,
      "-w", WORKSPACE_DIR,
      this.config.imageName,
    ];

    try {
      // The entrypoint handles all setup: AGENTS.md, opencode.json, app.pem
      // materialization, and git config. No docker exec calls needed.
      const containerId = execCmd("docker", args).trim();

      const info: SandboxInfo = { containerId, containerName, worktreePath };
      this.activeContainers.set(opts.taskId, info);
      console.log(`[sandbox] Created: ${containerName}`);

      // Wait for entrypoint to finish setting up auth, skills, MCP config.
      // The entrypoint drops to `gosu agent sleep infinity` when done —
      // we detect readiness by checking for the .credentials.json symlink.
      await this.waitForReady(containerName);

      return info;
    } catch (err: any) {
      throw new Error(`Failed to create sandbox: ${err.message}`);
    }
  }

  /**
   * Wait for the sandbox entrypoint to finish setup. The entrypoint touches
   * `$WORKSPACE/.ready` as its last step before exec'ing the agent shell.
   */
  private async waitForReady(containerName: string, timeoutMs = 15000): Promise<void> {
    const start = Date.now();
    const interval = 500;

    while (Date.now() - start < timeoutMs) {
      try {
        await execFileAsync("docker", [
          "exec", "--user", "agent", containerName,
          "test", "-f", `${WORKSPACE_DIR}/.ready`,
        ], { timeout: 5000 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, interval));
      }
    }

    console.warn(`[sandbox] Timed out waiting for ${containerName} to be ready — proceeding anyway`);
  }

  /**
   * Run the agentic-pi CLI inside the sandbox with a prompt.
   *
   * Streams stdout line-by-line so the caller can react to JSON events
   * (e.g. capture the top-level `session` record's id) before the agent
   * has finished. The full stdout is also buffered and returned for
   * post-run parsing of the usage_snapshot rollup.
   */
  async runAgent(
    taskId: string,
    prompt: string,
    opts?: {
      model?: string;
      /**
       * Pi thinking level: `off | minimal | low | medium | high | xhigh`.
       * Validated against the closed set before being shell-interpolated.
       */
      thinking?: string;
      /** agentic-pi GitHub profile: `read | issues-write | review-write | repo-write`. */
      profile?: string;
      /**
       * Env forwarded INTO the sandboxed run via repeated `--sandbox-env`
       * flags. Used to inject git identity. Keys / values are charset-asserted
       * before shell interpolation.
       */
      sandboxEnv?: Record<string, string>;
      /**
       * Working directory for the agent process inside the container.
       * Defaults to WORKSPACE_DIR (the workspace root). When the harness
       * pre-cloned the target repo, the executor passes
       * `<WORKSPACE_DIR>/<repo>` so the agent starts inside the checked-out
       * tree. The path is asserted against an allowlist before being passed
       * to `docker exec -w` to keep it shell-safe.
       */
      agentCwd?: string;
      /**
       * Enable agentic-pi's web-search extension. When false (or omitted),
       * `--no-web-search` is appended to suppress auto-enable. When true,
       * the flag is omitted and agentic-pi auto-detects the provider from
       * whichever `*_API_KEY` env var the container received.
       */
      webSearch?: boolean;
      /** Force a specific web-search provider. Validated against a closed set. */
      webSearchProvider?: "tavily" | "brave" | "exa";
      /**
       * Per-phase skill directories to load, as absolute in-container paths
       * under WORKSPACE_DIR (e.g. `/home/agent/workspace/.lastlight-skills/
       * <phase>/<skill>`). Each becomes a repeated `--skill <dir>` flag.
       * Charset/prefix-asserted before shell interpolation.
       */
      skillDirs?: string[];
      /** Called for each newline-terminated stdout line as it arrives. */
      onLine?: (line: string) => void;
    },
  ): Promise<void> {
    const info = this.activeContainers.get(taskId);
    if (!info) throw new Error(`No sandbox for task ${taskId}`);

    const model = opts?.model || "anthropic/claude-sonnet-4-6";
    const timeout = this.config.timeoutSeconds || 1800;

    // `cmd` is interpolated into `sh -c <cmd>` below, so any value we
    // append here is shell-parsed. Assert each opt-supplied flag against
    // a tight allowlist before embedding — defense in depth in case any
    // of these ever gets sourced from user input.
    const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
    const PROFILES = new Set(["read", "issues-write", "review-write", "repo-write"]);
    const WEB_SEARCH_PROVIDERS = new Set(["tavily", "brave", "exa"]);

    const extraArgs: string[] = [];
    if (opts?.thinking) {
      if (!THINKING.has(opts.thinking)) {
        throw new Error(`Refusing to pass thinking "${opts.thinking}" — must be one of ${[...THINKING].join("|")}`);
      }
      extraArgs.push("--thinking", opts.thinking);
    }
    if (opts?.profile) {
      if (!PROFILES.has(opts.profile)) {
        throw new Error(`Refusing to pass profile "${opts.profile}" — must be one of ${[...PROFILES].join("|")}`);
      }
      extraArgs.push("--profile", opts.profile);
    }
    // Web search defaults off — agentic-pi's auto-enable triggers on any
    // provider key env var, so silence it explicitly when the caller didn't
    // opt in. When opted in, omit the flag and let agentic-pi pick up the
    // forwarded TAVILY_API_KEY / BRAVE_SEARCH_API_KEY / EXA_API_KEY.
    if (opts?.webSearch === true) {
      if (opts.webSearchProvider) {
        if (!WEB_SEARCH_PROVIDERS.has(opts.webSearchProvider)) {
          throw new Error(
            `Refusing to pass web-search-provider "${opts.webSearchProvider}" — must be one of ${[...WEB_SEARCH_PROVIDERS].join("|")}`,
          );
        }
        extraArgs.push("--web-search-provider", opts.webSearchProvider);
      }
    } else {
      extraArgs.push("--no-web-search");
    }
    // Per-phase skill bundles. Each must be an in-container path under the
    // workspace root; assert the charset + prefix before it's embedded into
    // the `sh -c` command, mirroring the agentCwd guard below.
    for (const dir of opts?.skillDirs ?? []) {
      if (!dir.startsWith(WORKSPACE_DIR) || !/^[A-Za-z0-9/_.-]+$/.test(dir)) {
        throw new Error(`Refusing to pass skill dir "${dir}" — must live under ${WORKSPACE_DIR}`);
      }
      extraArgs.push("--skill", dir);
    }
    if (!/^[A-Za-z0-9/_.-]+$/.test(model)) {
      throw new Error(`Refusing to pass model "${model}" — bad charset`);
    }
    // Git identity + auth env (and anything else the orchestrator passes) reaches
    // the agent via real `docker exec -e KEY=VALUE` argv flags — NOT `agentic-pi
    // --sandbox-env`, which is a no-op here: agentic-pi runs `--sandbox none`, and
    // its buildSandbox only honours env on the gondolin backend. Mirror runCommand
    // (values travel as argv, so no shell re-parse — reject only newlines).
    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(opts?.sandboxEnv ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
        throw new Error(`Refusing sandbox-env key "${k}" — must be UPPER_SNAKE`);
      }
      if (/[\n\r]/.test(v)) {
        throw new Error(`Refusing sandbox-env value for "${k}" — contains newline`);
      }
      envFlags.push("-e", `${k}=${v}`);
    }

    const cmd = [
      "agentic-pi", "run",
      "--model", model,
      "--sandbox", "none",
      ...extraArgs,
    ].join(" ");

    // Resolve the agent's cwd. Defaults to the workspace root; callers may
    // pass a `<WORKSPACE_DIR>/<repo>` subdir when the harness pre-cloned the
    // target repo. Asserted against an allowlist before going into
    // `docker exec -w` (which is a separate argv slot, but defensive
    // narrowing keeps surprise paths out).
    const workdir = opts?.agentCwd ?? WORKSPACE_DIR;
    if (!workdir.startsWith(WORKSPACE_DIR) || !/^[A-Za-z0-9/_.-]+$/.test(workdir)) {
      throw new Error(`Refusing to pass agent cwd "${workdir}" — must live under ${WORKSPACE_DIR}`);
    }
    // -i connects stdin so the prompt can be written to the container process.
    // Run as agent user so workspace writes land with the right ownership.
    const args = ["exec", "-i", "--user", "agent", "-w", workdir, ...envFlags, info.containerName, "sh", "-c", cmd];

    // The structured event stream is consumed line-by-line via `onLine` and
    // mirrored to the AgenticShim, which writes envelope jsonl to
    // `<sessionsDir>/projects/.../` (read by the admin SessionReader).
    // That is the on-disk log. We deliberately do NOT buffer the full stdout
    // here — for a "read a large repo" run the stream is hundreds of MB and
    // accumulating it in a single string is what OOM'd the harness.
    //
    // We keep only a small bounded tail of stderr so the error-path message
    // is still useful.
    const STDERR_TAIL_BYTES = 8 * 1024;
    return await new Promise<void>((resolvePromise, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.write(prompt);
      child.stdin.end();
      let stderrTail = "";
      let buf = "";

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Sandbox agent timed out after ${timeout}s`));
      }, timeout * 1000);

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        if (!opts?.onLine) return;
        // Emit complete lines to the caller as they arrive — keeps a partial
        // tail in `buf` for the next chunk.
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            try { opts.onLine(line); } catch { /* swallow listener errors */ }
          }
        }
      });

      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail += chunk;
        if (stderrTail.length > STDERR_TAIL_BYTES) {
          stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
        }
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Sandbox agent spawn failed: ${err.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        // Flush any trailing partial line
        if (buf.length > 0 && opts?.onLine) {
          try { opts.onLine(buf); } catch { /* ignore */ }
          buf = "";
        }
        if (code === 0) {
          resolvePromise();
        } else {
          reject(new Error(`Sandbox agent failed (exit ${code}): ${stderrTail || "no output"}`));
        }
      });
    });
  }

  /**
   * Run a deterministic shell command inside an already-provisioned sandbox
   * container and return its exit code + captured output. This is the
   * non-agent sibling of {@link runAgent}: same `docker exec --user agent -w
   * <workdir> … sh -c <cmd>` machinery, but it captures a bounded stdout tail
   * (runAgent discards stdout) and RESOLVES with the exit code instead of
   * rejecting on non-zero — the caller decides success/failure.
   *
   * Powers `type: bash` / `type: script` workflow phases (and the in-sandbox
   * `generic_loop.until_bash` check). `command` is passed as a single argv slot
   * to `sh -c`, so it is NOT re-parsed by the host shell — it is the script we
   * intend to run. Env is forwarded via `docker exec -e KEY=VALUE` (argv, not
   * shell-interpolated); keys are charset-asserted defensively.
   */
  async runCommand(
    taskId: string,
    command: string,
    opts?: {
      /**
       * Working directory inside the container. Defaults to WORKSPACE_DIR.
       * Asserted against the workspace-root allowlist (same guard as runAgent).
       */
      cwd?: string;
      /** Env forwarded into the command via `docker exec -e`. */
      sandboxEnv?: Record<string, string>;
      /** Per-command timeout in seconds (default: the sandbox config timeout). */
      timeoutSeconds?: number;
      /** Called for each newline-terminated stdout line as it arrives. */
      onLine?: (line: string) => void;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    const info = this.activeContainers.get(taskId);
    if (!info) throw new Error(`No sandbox for task ${taskId}`);

    const timeout = opts?.timeoutSeconds || this.config.timeoutSeconds || 1800;

    const workdir = opts?.cwd ?? WORKSPACE_DIR;
    if (!workdir.startsWith(WORKSPACE_DIR) || !/^[A-Za-z0-9/_.-]+$/.test(workdir)) {
      throw new Error(`Refusing to run command in cwd "${workdir}" — must live under ${WORKSPACE_DIR}`);
    }

    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(opts?.sandboxEnv ?? {})) {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) {
        throw new Error(`Refusing sandbox-env key "${k}" — must be UPPER_SNAKE`);
      }
      // Values travel as argv (no shell re-parse), so any value is safe — but a
      // newline would let a value smuggle a second `-e` token in some shells;
      // reject defensively to match runAgent's posture.
      if (/[\n\r]/.test(v)) {
        throw new Error(`Refusing sandbox-env value for "${k}" — contains newline`);
      }
      envFlags.push("-e", `${k}=${v}`);
    }

    const args = ["exec", "--user", "agent", "-w", workdir, ...envFlags, info.containerName, "sh", "-c", command];

    // Bounded tails so a runaway command (e.g. a build dumping MB of logs)
    // can't OOM the harness — keep enough stdout for the downstream
    // `{{phaseOutputs.*}}` reference to be useful.
    const STDOUT_TAIL_BYTES = 256 * 1024;
    const STDERR_TAIL_BYTES = 32 * 1024;
    return await new Promise((resolvePromise, reject) => {
      const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdoutTail = "";
      let stderrTail = "";
      let buf = "";
      let timedOut = false;

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeout * 1000);

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdoutTail += chunk;
        if (stdoutTail.length > STDOUT_TAIL_BYTES) stdoutTail = stdoutTail.slice(-STDOUT_TAIL_BYTES);
        if (!opts?.onLine) return;
        buf += chunk;
        let nl: number;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (line.length > 0) {
            try { opts.onLine(line); } catch { /* swallow listener errors */ }
          }
        }
      });

      child.stderr.setEncoding("utf-8");
      child.stderr.on("data", (chunk: string) => {
        stderrTail += chunk;
        if (stderrTail.length > STDERR_TAIL_BYTES) stderrTail = stderrTail.slice(-STDERR_TAIL_BYTES);
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new Error(`Sandbox command spawn failed: ${err.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (buf.length > 0 && opts?.onLine) {
          try { opts.onLine(buf); } catch { /* ignore */ }
        }
        resolvePromise({
          exitCode: timedOut ? 124 : (code ?? 1),
          stdout: stdoutTail,
          stderr: stderrTail,
          timedOut,
        });
      });
    });
  }

  /**
   * Remove a sandbox container.
   */
  async destroy(taskId: string): Promise<void> {
    const info = this.activeContainers.get(taskId);
    if (!info) return;

    execSafe("docker", ["rm", "-f", info.containerName]);
    this.activeContainers.delete(taskId);
    console.log(`[sandbox] Destroyed: ${info.containerName}`);
  }

  async destroyAll(): Promise<void> {
    for (const taskId of this.activeContainers.keys()) {
      await this.destroy(taskId);
    }
  }

  private resolveGitMounts(worktreePath: string): string[] {
    const gitPath = join(worktreePath, ".git");
    if (!existsSync(gitPath)) return [];

    try {
      const content = readFileSync(gitPath, "utf-8").trim();
      const match = content.match(/^gitdir:\s*(.+)$/);
      if (match) {
        // Resolve relative to the .git file location (not process cwd).
        const gitdirPath = resolve(dirname(gitPath), match[1]);
        const parentGitDir = resolve(gitdirPath, "..", "..");
        const sandboxRoot = resolve(worktreePath, "..");
        if (!isSubpath(sandboxRoot, parentGitDir)) {
          console.warn(
            `[sandbox] Blocking unsafe gitdir mount outside sandbox root: ${parentGitDir}`,
          );
          return [];
        }
        if (!existsSync(parentGitDir)) {
          console.warn(`[sandbox] Skipping missing gitdir parent mount: ${parentGitDir}`);
          return [];
        }
        return [
          `${gitPath}:${gitPath}`,
          `${parentGitDir}:${parentGitDir}`,
        ];
      }
    } catch { /* fall through */ }

    // Normal repo clone with a real .git directory needs no extra mount.
    return [];
  }
}

function execCmd(cmd: string, args: string[], opts?: { timeout?: number }): string {
  return execFileSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: opts?.timeout,
  });
}

function execSafe(cmd: string, args: string[]): void {
  try { execFileSync(cmd, args, { stdio: "ignore" }); } catch { /* ignore */ }
}

function isSubpath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * A SANDBOX_DATA_VOLUME value is a host filesystem path (rather than a Docker
 * named volume) when it begins with `/`, `./`, `../`, or `~`. Named volumes
 * cannot contain those characters, so this disambiguation is unambiguous.
 */
function isPathLike(value: string): boolean {
  return value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~");
}

/**
 * Resolve a path-like SANDBOX_DATA_VOLUME value to an absolute host path
 * suitable for `docker run -v <host>:/data`. Expands `~` and resolves
 * relative paths against the harness cwd.
 */
function resolveHostPath(value: string): string {
  let p = value;
  if (p.startsWith("~")) {
    p = (process.env.HOME || "") + p.slice(1);
  }
  return resolve(p);
}
