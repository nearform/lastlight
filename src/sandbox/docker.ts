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
 * - Shared data volume (/data): Claude auth, secrets (app.pem), session logs
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
   * Default: 2g — enough headroom for `npm install`, vite build, and a Claude
   * agent loop, but small enough that several concurrent sandboxes can't
   * exhaust a 16 GB host. Override via the `SANDBOX_MEMORY_LIMIT` env var.
   */
  memoryLimit?: string;
}

export interface SandboxInfo {
  containerId: string;
  containerName: string;
  worktreePath: string;
}

const WORKSPACE_DIR = "/home/agent/workspace";

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
  }): Promise<SandboxInfo> {
    const containerName = `lastlight-sandbox-${opts.taskId}-${randomUUID().slice(0, 8)}`;
    const worktreePath = resolve(opts.worktreePath);

    // Shared data — mounted at /data inside the sandbox. Contains claude auth,
    // session logs, etc. (see deploy/sandbox-entrypoint.sh for the layout it
    // expects).
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

    const volumes = [
      `${dataMount}:/data`,                    // shared state (claude-home, sessions)
      `${worktreePath}:${WORKSPACE_DIR}`,      // task worktree
    ];

    // Resolve git mounts for worktrees (if .git is a file pointing elsewhere)
    const gitMounts = this.resolveGitMounts(worktreePath);
    volumes.push(...gitMounts);

    // Env flags — passed to entrypoint for MCP config template expansion
    const envFlags = Object.entries(this.config.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);

    // Per-sandbox memory cap. Without this, a runaway agent (or a hot
    // `npm install` / vite build inside the workspace) can OOM the host
    // and take every other container with it. We set --memory-swap to the
    // same value so swap can't be used to silently exceed the cap.
    const memoryLimit = this.config.memoryLimit || "2g";

    // The entrypoint runs as root to fix permissions, then drops to agent via gosu.
    // No --user flag needed.
    const args = [
      "run", "-d",
      "--name", containerName,
      "--memory", memoryLimit,
      "--memory-swap", memoryLimit,
      ...envFlags,
      ...volumes.flatMap(v => ["-v", v]),
      "-w", WORKSPACE_DIR,
      this.config.imageName,
    ];

    try {
      // The entrypoint handles all setup: claude auth, skills, CLAUDE.md,
      // .mcp.json, and git config. No docker exec calls needed.
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
   * Run the OpenCode CLI inside the sandbox with a prompt.
   *
   * Streams stdout line-by-line so the caller can react to JSON events
   * (e.g. capture the top-level `sessionID` field) before the agent has
   * finished. The full stdout is also buffered and returned for post-run
   * parsing of `step_finish` accounting.
   */
  async runAgent(
    taskId: string,
    prompt: string,
    opts?: {
      model?: string;
      /** Called for each newline-terminated stdout line as it arrives. */
      onLine?: (line: string) => void;
    },
  ): Promise<string> {
    const info = this.activeContainers.get(taskId);
    if (!info) throw new Error(`No sandbox for task ${taskId}`);

    const model = opts?.model || "openai/gpt-5.3-codex";
    const timeout = this.config.timeoutSeconds || 1800;

    const cmd = [
      "opencode", "run",
      "--format", "json",
      "-m", model,
      "--dangerously-skip-permissions",
    ].join(" ");

    // -i connects stdin so the prompt can be written to the container process.
    // Run as agent user so workspace writes land with the right ownership.
    const args = ["exec", "-i", "--user", "agent", "-w", WORKSPACE_DIR, info.containerName, "sh", "-c", cmd];

    return await new Promise<string>((resolvePromise, reject) => {
      const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
      child.stdin.write(prompt);
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      let buf = "";

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Sandbox agent timed out after ${timeout}s`));
      }, timeout * 1000);

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
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
      child.stderr.on("data", (chunk: string) => { stderr += chunk; });

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
          resolvePromise(stdout);
        } else {
          reject(new Error(`Sandbox agent failed (exit ${code}): ${stderr || stdout || "no output"}`));
        }
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
