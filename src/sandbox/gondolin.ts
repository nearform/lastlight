/**
 * Gondolin sandbox backend for agentic-pi.
 *
 * Routes Pi's built-in `read`/`write`/`edit`/`bash` tools through a Gondolin
 * micro-VM. The agent's tool calls execute against `/workspace` inside the
 * VM, where the host's current working directory has been mounted RW. Files
 * the agent writes appear on the host because RealFSProvider is a passthrough.
 *
 * Pattern adapted from gondolin/host/examples/pi-gondolin.ts but adjusted
 * for SDK mode (no Pi extension hooks; we drive `createAgentSession`
 * directly).
 *
 * Note: `grep`/`find`/`ls` are NOT routed through the VM in this version —
 * they run on the host but they read the *same* files (because the mount
 * is a passthrough), so the agent sees consistent state. This matches the
 * upstream example. If full FS isolation is needed later, route those too.
 */

import path from "node:path";

import {
  type BashOperations,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { RealFSProvider, VM, createHttpHooks } from "@earendil-works/gondolin";

import type { ImageDescriptor } from "./index.js";

const GUEST_WORKSPACE = "/workspace";

function shQuote(value: string): string {
  // POSIX shell quoting: wrap in single quotes; escape any internal quote.
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function toGuestPath(localCwd: string, localPath: string): string {
  const rel = path.relative(localCwd, localPath);
  if (rel === "") return GUEST_WORKSPACE;
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  const posixRel = rel.split(path.sep).join(path.posix.sep);
  return path.posix.join(GUEST_WORKSPACE, posixRel);
}

function sanitizeEnv(env?: NodeJS.ProcessEnv): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/cat", guestPath]);
      if (!r.ok) throw new Error(`cat failed (${r.exitCode}): ${r.stderr}`);
      return r.stdoutBuffer;
    },
    access: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      const r = await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(guestPath)}`]);
      if (!r.ok) throw new Error(`not readable: ${p}`);
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        const r = await vm.exec(["/bin/sh", "-lc", `file --mime-type -b ${shQuote(guestPath)}`]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      const dir = path.posix.dirname(guestPath);
      const b64 = Buffer.from(content, "utf8").toString("base64");
      const script = [
        `set -eu`,
        `mkdir -p ${shQuote(dir)}`,
        `echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`,
      ].join("\n");
      const r = await vm.exec(["/bin/sh", "-lc", script]);
      if (!r.ok) throw new Error(`write failed (${r.exitCode}): ${r.stderr}`);
    },
    mkdir: async (dir) => {
      const guestDir = toGuestPath(localCwd, dir);
      const r = await vm.exec(["/bin/mkdir", "-p", guestDir]);
      if (!r.ok) throw new Error(`mkdir failed (${r.exitCode}): ${r.stderr}`);
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd);
      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });
      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;
      try {
        const proc = vm.exec(["/bin/sh", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe",
        });
        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }
        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export interface GondolinSandboxOptions {
  /**
   * Environment variables to set inside the guest VM. Available to every
   * `bash` invocation the agent makes. Use this to hand credentials,
   * workflow context, or feature flags to the sandboxed process.
   *
   * Note: gondolin docs explicitly warn against baking secrets into
   * pre-built images; runtime env is the supported channel for
   * credentials, which is what this option exists for.
   */
  env?: Record<string, string>;
  /**
   * Absolute path to a gondolin build output directory. When set, the VM
   * boots from these assets instead of gondolin's built-in
   * `alpine-base:latest`. The caller (typically `runner.ts`) is
   * responsible for resolving the user-facing `--sandbox-image` value
   * (default / gondolin-builtin / path) to this absolute path.
   */
  imagePath?: string;
  /** Descriptor surfaced verbatim in `status.image`. */
  image?: ImageDescriptor;
  /**
   * Hosts the sandboxed guest is allowed to make HTTP(S) egress to.
   * Without an HTTP hook configured, gondolin's HTTP interceptor returns
   * 502 to every outbound request — `git clone`, `git push`, `gh ...`,
   * `npm install`, `pip install` all fail. When this option is set
   * (or left at its default), `createHttpHooks({ allowedHosts })` wires
   * up the egress proxy.
   *
   * Accepted shapes:
   *  - **omit (`undefined`)** — use the built-in `DEFAULT_GUEST_ALLOWED_HOSTS`
   *    (GitHub + common public package registries).
   *  - **explicit array** — caller-provided allowlist. Tightens or broadens
   *    the default. Hosts are matched by exact name plus `*.` wildcards
   *    (see `@earendil-works/gondolin`'s host pattern docs).
   *  - **`["*"]`** — wildcard allow-all. Lets the guest reach any host.
   *    Useful for explore-style phases that need broad web access (e.g.
   *    a third-party docs search). Skips the QEMU-layer block while
   *    still routing through the HTTP hook layer (so request shape
   *    rewrites still apply if you configure them).
   *  - **`null`** — disable HTTP hooks entirely; gondolin then blocks all
   *    HTTP egress at the QEMU layer (the strictest setting).
   */
  allowedHttpHosts?: string[] | null;
}

/**
 * Hosts the sandboxed guest can reach by default. The set covers the
 * everyday needs of a coding-agent `bash` session: git over HTTPS, gh,
 * and the common public package registries so `npm install`, `pip
 * install`, `cargo build`, `go mod download`, `bundle install`, and
 * `apk add` work without extra configuration.
 *
 * Model-provider hosts (`api.anthropic.com`, `api.openai.com`, etc.)
 * are deliberately omitted — agentic-pi calls the LLM from the host
 * process, not from inside the sandbox, so the VM never needs to reach
 * them.
 *
 * The list is intentionally limited to **public** registries. Anything
 * private (internal artifact repos, npm enterprise, etc.) must be added
 * explicitly via `--allow-host` / `allowedHttpHosts: [...]`.
 */
export const DEFAULT_GUEST_ALLOWED_HOSTS: readonly string[] = [
  // GitHub — git over HTTPS + gh CLI
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
  "raw.githubusercontent.com",
  // npm / yarn / pnpm
  "registry.npmjs.org",
  "registry.yarnpkg.com",
  // Python — pypi + wheels CDN
  "pypi.org",
  "files.pythonhosted.org",
  // Rust
  "crates.io",
  "static.crates.io",
  "index.crates.io",
  // Go modules
  "proxy.golang.org",
  "sum.golang.org",
  // Ruby
  "rubygems.org",
  // Alpine apk + Debian apt mirrors (the apk on `apk add` etc.)
  "dl-cdn.alpinelinux.org",
  "deb.debian.org",
  "security.debian.org",
];

export interface GondolinSandbox {
  /** Tools to pass into `createAgentSession({ customTools })`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customTools: ToolDefinition<any>[];
  /** Tear down the VM. Idempotent. */
  close: () => Promise<void>;
  /** For the `sandbox_status` event. */
  status: {
    backend: "gondolin";
    cwd: string;
    guestPath: string;
    createMs: number;
    /** Sorted list of env var KEY names injected (values omitted for safety). */
    envKeys: string[];
    /** Image descriptor (omitted when caller didn't supply one). */
    image?: ImageDescriptor;
    /**
     * Resolved HTTP egress allowlist. `null` when HTTP hooks were disabled
     * (caller passed `allowedHttpHosts: null`). Omitted when the backend
     * doesn't have a meaningful HTTP policy.
     */
    allowedHttpHosts?: string[] | null;
  };
}

/**
 * Boot a Gondolin VM mounting `cwd` at /workspace, and build the four
 * Pi tool overrides (read, write, edit, bash) that route through it.
 *
 * Throws if VM.create rejects. The preflight check is the caller's
 * responsibility — call `preflightGondolin()` first.
 */
export async function buildGondolinSandbox(
  cwd: string,
  options: GondolinSandboxOptions = {},
): Promise<GondolinSandbox> {
  const env = options.env;
  const imagePath = options.imagePath;

  // HTTP egress policy. The four valid input shapes (see GondolinSandboxOptions
  // for the full rules):
  //   undefined → default allowlist (GitHub + public registries)
  //   ["*"]     → wildcard allow-all (matches every hostname)
  //   [...]     → caller-provided allowlist (exact + wildcard patterns)
  //   null      → skip hooks entirely; QEMU layer blocks all HTTP egress
  //
  // The `"*"` wildcard is recognized by the underlying
  // `@earendil-works/gondolin` host-pattern matcher: a list containing it
  // collapses to allow-all, matching any hostname.
  const allowedHosts =
    options.allowedHttpHosts === undefined
      ? [...DEFAULT_GUEST_ALLOWED_HOSTS]
      : options.allowedHttpHosts;
  const httpConfig = allowedHosts === null ? undefined : createHttpHooks({ allowedHosts });

  const t0 = Date.now();
  const vm = await VM.create({
    vfs: {
      mounts: {
        [GUEST_WORKSPACE]: new RealFSProvider(cwd),
      },
    },
    ...(imagePath ? { sandbox: { imagePath } } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...(httpConfig ? { httpHooks: httpConfig.httpHooks } : {}),
  });
  const createMs = Date.now() - t0;

  // Confirm the VM is actually executable before returning. Without this
  // probe, a hung VM (see SPIKE-gondolin.md / upstream issue #51) would
  // slip through and the orchestrator would inherit the hang at first
  // tool call. Two-second budget is generous — a working guest responds in
  // a few hundred ms.
  const probe = await Promise.race([
    vm.exec(["/bin/true"]),
    new Promise<{ ok: false; exitCode: number; stderr: string }>((resolve) =>
      setTimeout(
        () => resolve({ ok: false, exitCode: -1, stderr: "vm-exec-probe-timeout" }),
        5_000,
      ),
    ),
  ]);
  if (!probe.ok) {
    await vm.close().catch(() => undefined);
    throw new Error(
      `Gondolin VM started but is not executing commands ` +
        `(probe: ${probe.stderr || "no stderr"}). ` +
        `This matches upstream issue #51 — likely no working accelerator. ` +
        `See SPIKE-gondolin.md.`,
    );
  }

  // Names match Pi's built-ins (read/write/edit/bash). Pi's host
  // versions are suppressed by the runner via noTools:"builtin" so these
  // do not collide.
  const customTools = [
    createReadTool(cwd, { operations: createGondolinReadOps(vm, cwd) }),
    createWriteTool(cwd, { operations: createGondolinWriteOps(vm, cwd) }),
    createEditTool(cwd, { operations: createGondolinEditOps(vm, cwd) }),
    createBashTool(cwd, { operations: createGondolinBashOps(vm, cwd) }),
  ];

  let closed = false;
  return {
    customTools,
    status: {
      backend: "gondolin",
      cwd,
      guestPath: GUEST_WORKSPACE,
      createMs,
      envKeys: env ? Object.keys(env).sort() : [],
      ...(options.image ? { image: options.image } : {}),
      allowedHttpHosts: allowedHosts === null ? null : [...allowedHosts],
    },
    close: async () => {
      if (closed) return;
      closed = true;
      await vm.close().catch(() => undefined);
    },
  };
}
