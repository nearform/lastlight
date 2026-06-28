import { execFileSync, execFile as execFileCb, spawn } from "child_process";
import { promisify } from "util";
import { lookup } from "node:dns/promises";
import { existsSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { randomUUID } from "crypto";

const execFileAsync = promisify(execFileCb);

/**
 * smolvm sandbox manager — runs agent tasks inside local micro-VMs.
 *
 * Structural peer of {@link DockerSandbox}: Last Light owns the isolation
 * boundary, bind-mounts the per-task workspace, runs `agentic-pi run --sandbox
 * none` *inside* the machine, and parses the JSONL event stream exactly as the
 * docker path does. Differences from docker:
 *
 *  - **Isolation** is a real micro-VM (own kernel) via smolvm's host
 *    hypervisor (Apple Silicon Hypervisor.framework / Linux KVM), not a
 *    sibling container. No daemon, no Docker (smolvm drives the hypervisor
 *    directly).
 *  - **Egress** is enforced natively per-machine via `--allow-host` (sourced
 *    from `egress-allowlist.ts`), so this backend needs none of the coredns +
 *    nginx-egress sidecar stack. `--allow-host` implies `--net`; we always
 *    enable networking (the agent must reach the LLM provider).
 *  - **Secrets** (provider keys, GITHUB_TOKEN) are injected via smolvm's
 *    `--secret-env GUEST=HOST` so values never appear on the argv — the host
 *    env of the spawned `smolvm` process carries them; smolvm resolves them
 *    into the guest at start.
 *  - **Image** is whatever `SMOLVM_IMAGE` names. smolvm's `-I` accepts a
 *    registry ref OR a local `docker save` archive (`./img.tar`) / unpacked
 *    rootfs dir — the latter needs NO registry, so it works under the strict
 *    egress allowlist. The lastlight sandbox image (built locally by docker)
 *    is consumed offline via `docker save lastlight-sandbox:latest -o img.tar`
 *    then `SMOLVM_IMAGE=img.tar`. Archives are cached by hash; `start` resolves
 *    from cache, not the network.
 *
 * Driven via the **smolvm CLI** (`execFile`), verified against smolvm 1.2.5.
 *
 * Feasibility-spike scope (documented gaps vs docker):
 *  - We exec `agentic-pi` directly rather than running the sandbox image's
 *    entrypoint, so the entrypoint's git-credential-helper setup is skipped.
 *    Read-only profiles (agentic-pi's built-in github tools + minted
 *    GITHUB_TOKEN) work; repo-write `git push` from the workspace is out of
 *    scope here.
 *  - The workload runs VM-grade (root) by default; workspace writes land as
 *    root on the host bind mount. No shared package-manager cache, no SSRF
 *    metadata floor in unrestricted mode, no in-network OTEL collector.
 *  - The image (`SMOLVM_IMAGE`) must be resolvable by smolvm (a registry ref,
 *    or a local image it can load) — see the spike plan's verification steps.
 */

/**
 * Where the per-task workspace is bind-mounted inside the guest. smolvm treats
 * `/workspace` specially — a `-v <host>:/workspace` mount "takes priority" and
 * the host share is used directly (instead of the VM's storage-disk workspace),
 * which avoids the `virtiofs` carve-out other mount targets get. The probe in
 * {@link SmolSandbox.resolveHostWorkspace} still confirms the actual host path.
 */
export const SMOL_WORKSPACE_DIR = "/workspace";

/** Binary used to drive smolvm. Overridable for dev/CI (e.g. a vendored build). */
function smolBin(): string {
  return process.env.SMOLVM_BIN || "smolvm";
}

/**
 * OCI image the micro-VM boots. Reuses the lean lastlight sandbox image by
 * default (agentic-pi + node + git + gh baked in); the image must be
 * resolvable by smolvm (see the spike plan's verification steps).
 */
function smolImage(): string {
  return process.env.SMOLVM_IMAGE || "lastlight-sandbox:latest";
}

/** Cached probe — only check the smolvm binary once per process. */
let _smolAvailable: boolean | null = null;

/** True when the smolvm CLI is invocable on this host. */
export function smolAvailable(): boolean {
  if (_smolAvailable === null) {
    try {
      execFileSync(smolBin(), ["--version"], { stdio: "ignore", timeout: 5000 });
      _smolAvailable = true;
      console.log(`[smol] smolvm available (image: ${smolImage()})`);
    } catch {
      _smolAvailable = false;
      console.log("[smol] smolvm CLI not available — smol backend unavailable");
    }
  }
  return _smolAvailable;
}

export interface SmolSandboxConfig {
  /** OCI image to boot (default: SMOLVM_IMAGE / lastlight-sandbox:latest). */
  imageName?: string;
  /**
   * Env vars injected into in-guest commands (provider keys, GITHUB_TOKEN,
   * OTEL…). Forwarded via `--secret-env` so values stay off the argv.
   */
  env: Record<string, string>;
  /** Timeout in seconds for an agent run (default 1800 = 30 min). */
  timeoutSeconds?: number;
  /**
   * Egress allowlist (apex hostnames). Each becomes a repeated `--allow-host`.
   * `null` → no allowlist (open egress, still `--net`); used for
   * `unrestricted_egress` phases.
   */
  allowHosts: string[] | null;
}

export interface SmolMachineInfo {
  machineName: string;
  /** Host dir passed to `-v` (the mount source). */
  worktreePath: string;
  /**
   * Host dir that actually backs the guest workspace. smolvm's `-v` does not
   * always share the source root directly — depending on version it carves a
   * `<source>/virtiofs/<tag>` subdir and shares THAT. We probe for it after
   * boot (see {@link SmolSandbox.resolveHostWorkspace}) so host-side staging
   * (clone / AGENTS.md / skills) lands where the guest can see it, regardless
   * of which mount semantics the installed smolvm uses.
   */
  hostWorkspace: string;
}

const THINKING = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const PROFILES = new Set(["read", "issues-write", "review-write", "repo-write"]);
const WEB_SEARCH_PROVIDERS = new Set(["tavily", "brave", "exa"]);
const HOST_RE = /^[A-Za-z0-9.-]+$/;
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PATH_RE = /^[A-Za-z0-9/_.-]+$/;

export class SmolSandbox {
  private config: SmolSandboxConfig;
  private machines: Map<string, SmolMachineInfo> = new Map();

  constructor(config: SmolSandboxConfig) {
    this.config = config;
  }

  /** Create + start a micro-VM with the workspace bind-mounted and egress locked. */
  async create(opts: { taskId: string; worktreePath: string }): Promise<SmolMachineInfo> {
    const machineName = `lastlight-smol-${sanitizeName(opts.taskId)}-${randomUUID().slice(0, 8)}`;
    const worktreePath = resolve(opts.worktreePath);

    //   smolvm machine create -n <name> -I <image> -v <host>:<guest> \
    //     --net [--allow-host <h>]...
    //   smolvm machine start --name <name>
    const allowFlags = (await this.resolvableAllowHosts()).flatMap((h) => ["--allow-host", h]);
    const args = [
      "machine", "create",
      "-n", machineName,
      "-I", this.config.imageName || smolImage(),
      "-v", `${worktreePath}:${SMOL_WORKSPACE_DIR}`,
      "--net",
      ...allowFlags,
    ];
    try {
      execCmd(smolBin(), args, { timeout: 60_000 });
      execCmd(smolBin(), ["machine", "start", "--name", machineName], { timeout: 120_000 });
    } catch (err: any) {
      execSafe(smolBin(), ["machine", "delete", "-f", "--name", machineName]);
      throw new Error(`Failed to create smol sandbox: ${err.message}`);
    }

    console.log(`[smol] Created: ${machineName}`);
    await this.waitForReady(machineName);
    const hostWorkspace = await this.resolveHostWorkspace(machineName, worktreePath);
    const info: SmolMachineInfo = { machineName, worktreePath, hostWorkspace };
    this.machines.set(opts.taskId, info);
    return info;
  }

  /**
   * Discover the host directory that backs the guest workspace mount. Writes a
   * sentinel file from inside the guest at {@link SMOL_WORKSPACE_DIR}, then
   * locates it under the mount source on the host — its parent dir is the
   * host-side workspace root. Falls back to the source root if not found
   * (e.g. a future smolvm that shares the source directly and the scan misses).
   */
  private async resolveHostWorkspace(machineName: string, worktreePath: string): Promise<string> {
    const sentinel = `.smol-probe-${randomUUID().slice(0, 8)}`;
    try {
      await execFileAsync(
        smolBin(),
        ["machine", "exec", "--name", machineName, "--", "sh", "-c", `: > ${SMOL_WORKSPACE_DIR}/${sentinel}`],
        { timeout: 10_000 },
      );
      const hit = findFileUnder(worktreePath, sentinel, 4);
      await execFileAsync(
        smolBin(),
        ["machine", "exec", "--name", machineName, "--", "rm", "-f", `${SMOL_WORKSPACE_DIR}/${sentinel}`],
        { timeout: 10_000 },
      ).catch(() => { /* best effort */ });
      if (hit) {
        const dir = hit.slice(0, hit.length - sentinel.length - 1);
        if (dir !== worktreePath) console.log(`[smol] Workspace share lands at ${dir} (not the source root)`);
        return dir;
      }
    } catch (err: any) {
      console.warn(`[smol] Could not probe workspace mount (${err.message}) — assuming source root`);
    }
    return worktreePath;
  }

  /** Wait until the machine can run a trivial command (boot completion). */
  private async waitForReady(machineName: string, timeoutMs = 20000): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        await execFileAsync(smolBin(), ["machine", "exec", "--name", machineName, "--", "true"], { timeout: 5000 });
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    console.warn(`[smol] Timed out waiting for ${machineName} to be ready — proceeding anyway`);
  }

  /**
   * Run `agentic-pi run --sandbox none …` inside the machine. Mirrors
   * {@link DockerSandbox.runAgent}: streams stdout line-by-line for the live
   * shim and writes the prompt to the child's stdin (`-i`). The agentic-pi
   * argv is passed directly after `--` (no `sh -c`), so no shell quoting.
   */
  async runAgent(
    taskId: string,
    prompt: string,
    opts?: {
      model?: string;
      thinking?: string;
      profile?: string;
      /** Forwarded to the inner agentic-pi run via its own `--sandbox-env`. */
      sandboxEnv?: Record<string, string>;
      agentCwd?: string;
      webSearch?: boolean;
      webSearchProvider?: "tavily" | "brave" | "exa";
      skillDirs?: string[];
      onLine?: (line: string) => void;
    },
  ): Promise<void> {
    const info = this.machines.get(taskId);
    if (!info) throw new Error(`No smol machine for task ${taskId}`);

    const model = opts?.model || "anthropic/claude-sonnet-4-6";
    const timeout = this.config.timeoutSeconds || 1800;

    const piArgs: string[] = ["agentic-pi", "run", "--model", model, "--sandbox", "none"];
    if (opts?.thinking) {
      if (!THINKING.has(opts.thinking)) {
        throw new Error(`Refusing to pass thinking "${opts.thinking}" — must be one of ${[...THINKING].join("|")}`);
      }
      piArgs.push("--thinking", opts.thinking);
    }
    if (opts?.profile) {
      if (!PROFILES.has(opts.profile)) {
        throw new Error(`Refusing to pass profile "${opts.profile}" — must be one of ${[...PROFILES].join("|")}`);
      }
      piArgs.push("--profile", opts.profile);
    }
    if (opts?.webSearch === true) {
      if (opts.webSearchProvider) {
        if (!WEB_SEARCH_PROVIDERS.has(opts.webSearchProvider)) {
          throw new Error(`Refusing to pass web-search-provider "${opts.webSearchProvider}" — must be one of ${[...WEB_SEARCH_PROVIDERS].join("|")}`);
        }
        piArgs.push("--web-search-provider", opts.webSearchProvider);
      }
    } else {
      piArgs.push("--no-web-search");
    }
    for (const dir of opts?.skillDirs ?? []) {
      if (!dir.startsWith(SMOL_WORKSPACE_DIR) || !PATH_RE.test(dir)) {
        throw new Error(`Refusing to pass skill dir "${dir}" — must live under ${SMOL_WORKSPACE_DIR}`);
      }
      piArgs.push("--skill", dir);
    }
    if (!PATH_RE.test(model)) {
      throw new Error(`Refusing to pass model "${model}" — bad charset`);
    }
    // Passed as a single argv token each (no shell), so `KEY=VALUE` is literal.
    for (const [k, v] of Object.entries(opts?.sandboxEnv ?? {})) {
      if (!ENV_KEY_RE.test(k)) throw new Error(`Refusing sandbox-env key "${k}" — bad charset`);
      if (/[\n\r]/.test(v)) throw new Error(`Refusing sandbox-env value for "${k}" — contains newline`);
      piArgs.push("--sandbox-env", `${k}=${v}`);
    }

    const workdir = opts?.agentCwd ?? SMOL_WORKSPACE_DIR;
    if (!workdir.startsWith(SMOL_WORKSPACE_DIR) || !PATH_RE.test(workdir)) {
      throw new Error(`Refusing to pass agent cwd "${workdir}" — must live under ${SMOL_WORKSPACE_DIR}`);
    }

    const { flags: secretFlags, childEnv } = this.secretEnv();
    const argv = [
      "machine", "exec", "--name", info.machineName,
      "-w", workdir, "-i",
      ...secretFlags,
      "--", ...piArgs,
    ];

    const STDERR_TAIL_BYTES = 8 * 1024;
    return await new Promise<void>((resolvePromise, reject) => {
      const child = spawn(smolBin(), argv, { stdio: ["pipe", "pipe", "pipe"], env: childEnv });
      child.stdin.write(prompt);
      child.stdin.end();
      let stderrTail = "";
      let buf = "";

      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`Smol agent timed out after ${timeout}s`));
      }, timeout * 1000);

      child.stdout.setEncoding("utf-8");
      child.stdout.on("data", (chunk: string) => {
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
        reject(new Error(`Smol agent spawn failed: ${err.message}`));
      });

      child.on("close", (code) => {
        clearTimeout(timer);
        if (buf.length > 0 && opts?.onLine) {
          try { opts.onLine(buf); } catch { /* ignore */ }
        }
        if (code === 0) resolvePromise();
        else reject(new Error(`Smol agent failed (exit ${code}): ${stderrTail || "no output"}`));
      });
    });
  }

  /**
   * Run a deterministic shell command in the machine and resolve with its exit
   * code + bounded output. Non-agent sibling of {@link runAgent}; powers
   * `type: bash` / `type: script` phases. The command is a shell string, so it
   * runs under `sh -c`.
   */
  async runCommand(
    taskId: string,
    command: string,
    opts?: {
      cwd?: string;
      /** Non-secret env forwarded via `-e KEY=VALUE` (e.g. LL_OUT_*, git identity). */
      sandboxEnv?: Record<string, string>;
      timeoutSeconds?: number;
      onLine?: (line: string) => void;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut: boolean }> {
    const info = this.machines.get(taskId);
    if (!info) throw new Error(`No smol machine for task ${taskId}`);

    const timeout = opts?.timeoutSeconds || this.config.timeoutSeconds || 1800;
    const workdir = opts?.cwd ?? SMOL_WORKSPACE_DIR;
    if (!workdir.startsWith(SMOL_WORKSPACE_DIR) || !PATH_RE.test(workdir)) {
      throw new Error(`Refusing to run command in cwd "${workdir}" — must live under ${SMOL_WORKSPACE_DIR}`);
    }

    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(opts?.sandboxEnv ?? {})) {
      if (!ENV_KEY_RE.test(k)) throw new Error(`Refusing sandbox-env key "${k}" — bad charset`);
      if (/[\n\r]/.test(v)) throw new Error(`Refusing sandbox-env value for "${k}" — contains newline`);
      envFlags.push("-e", `${k}=${v}`);
    }

    const { flags: secretFlags, childEnv } = this.secretEnv();
    const argv = [
      "machine", "exec", "--name", info.machineName,
      "-w", workdir,
      ...envFlags, ...secretFlags,
      "--", "sh", "-c", command,
    ];

    const STDOUT_TAIL_BYTES = 256 * 1024;
    const STDERR_TAIL_BYTES = 32 * 1024;
    return await new Promise((resolvePromise, reject) => {
      const child = spawn(smolBin(), argv, { stdio: ["ignore", "pipe", "pipe"], env: childEnv });
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
        reject(new Error(`Smol command spawn failed: ${err.message}`));
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

  /** Stop + delete the machine. */
  async destroy(taskId: string): Promise<void> {
    const info = this.machines.get(taskId);
    if (!info) return;
    execSafe(smolBin(), ["machine", "stop", "--name", info.machineName]);
    execSafe(smolBin(), ["machine", "delete", "-f", "--name", info.machineName]);
    this.machines.delete(taskId);
    console.log(`[smol] Destroyed: ${info.machineName}`);
  }

  /**
   * The allowlist hosts that smolvm can actually use, in original order.
   *
   * smolvm resolves every `--allow-host` to its IP(s) AT VM START and aborts
   * `create` if ANY entry fails to resolve. Our `egress-allowlist.ts` follows an
   * apex+subdomain convention (e.g. `githubusercontent.com`), and some of those
   * bare apexes have no A record — they'd abort the whole VM. So we pre-resolve
   * here and drop the unresolvable ones.
   *
   * CAVEAT: unlike docker (SNI) / gondolin (hostname), smolvm's filter is
   * IP-pinned at start — `--allow-host github.com` allows github.com's IPs only,
   * NOT api.github.com or rotating CDN IPs. A faithful apex+subdomain policy
   * would need each concrete subdomain enumerated; that's a spike gap.
   */
  private async resolvableAllowHosts(): Promise<string[]> {
    if (!this.config.allowHosts) return [];
    const ok = new Set<string>();
    const dropped: string[] = [];
    await Promise.all(this.config.allowHosts.map(async (h) => {
      if (!HOST_RE.test(h)) throw new Error(`Refusing to pass allow-host "${h}" — bad charset`);
      try { await lookup(h); ok.add(h); } catch { dropped.push(h); }
    }));
    if (dropped.length) {
      console.warn(`[smol] Dropping unresolvable allow-host entries (smolvm resolves each at VM start): ${dropped.join(", ")}`);
    }
    return this.config.allowHosts.filter((h) => ok.has(h));
  }

  /**
   * Build `--secret-env GUEST=GUEST` flags for every machine-env var plus the
   * child-process env that carries their values, so secrets (tokens, provider
   * keys) reach the guest via smolvm's secret channel rather than the argv.
   */
  private secretEnv(): { flags: string[]; childEnv: NodeJS.ProcessEnv } {
    const flags: string[] = [];
    const childEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const [k, v] of Object.entries(this.config.env)) {
      if (!ENV_KEY_RE.test(k) || /[\n\r]/.test(v)) continue;
      flags.push("--secret-env", `${k}=${k}`);
      childEnv[k] = v;
    }
    return { flags, childEnv };
  }
}

/** Strip a taskId down to the charset smolvm accepts in a machine name. */
function sanitizeName(taskId: string): string {
  return taskId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 48);
}

/**
 * Depth-limited search for a file named `name` under `root`, returning its
 * absolute path (or null). Used to locate the mount-probe sentinel; the share
 * lands at most a couple of levels deep, so a shallow walk suffices and avoids
 * descending into a large checkout.
 */
function findFileUnder(root: string, name: string, maxDepth: number): string | null {
  if (!existsSync(root)) return null;
  let entries: import("fs").Dirent[];
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (e.isFile() && e.name === name) return join(root, name);
  }
  if (maxDepth <= 0) return null;
  for (const e of entries) {
    if (e.isDirectory()) {
      const hit = findFileUnder(join(root, e.name), name, maxDepth - 1);
      if (hit) return hit;
    }
  }
  return null;
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
