/**
 * Sandbox backend dispatcher.
 *
 * Currently supports two backends: `none` (the default — Pi's built-in
 * tools run on the host) and `gondolin` (tool ops routed through a
 * micro-VM). See SPIKE-gondolin.md for the design context.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { buildGondolinSandbox, type GondolinSandbox } from "./gondolin.js";
import { preflightGondolin, type PreflightStatus } from "./preflight.js";

export type SandboxBackend = "none" | "gondolin";

export interface SandboxNone {
  backend: "none";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customTools: ToolDefinition<any>[];
  /** Whether Pi's built-in read/write/edit/bash should be suppressed. */
  suppressBuiltins: boolean;
  close: () => Promise<void>;
  status: Record<string, unknown>;
}

export type SandboxResult =
  | SandboxNone
  | (Omit<GondolinSandbox, "status"> & {
      backend: "gondolin";
      suppressBuiltins: true;
      status: GondolinSandbox["status"];
    });

export interface BuildSandboxOptions {
  backend: SandboxBackend;
  cwd: string;
  /** Env vars to inject into the sandbox (ignored when backend === "none"). */
  env?: Record<string, string>;
  /**
   * Absolute path to a gondolin build output directory to mount as the
   * guest. When `undefined`, gondolin uses its built-in `alpine-base`.
   * Ignored when `backend === "none"`. The runner is responsible for
   * resolving `--sandbox-image` (default / gondolin-builtin / path) to
   * this path before calling buildSandbox.
   */
  imagePath?: string;
  /**
   * Optional descriptor of which image is being used, surfaced verbatim
   * in `sandbox_status.image`. The sandbox layer does not interpret it —
   * the runner builds it from the loader result.
   */
  image?: ImageDescriptor;
  /**
   * Allowed HTTP egress hosts for the sandboxed guest. See
   * `GondolinSandboxOptions.allowedHttpHosts` for the semantics:
   *   - `undefined` (default): GitHub-only allowlist
   *   - explicit `string[]`: caller-supplied allowlist
   *   - `null`: skip HTTP hooks entirely (gondolin blocks everything)
   *
   * Ignored when `backend === "none"`.
   */
  allowedHttpHosts?: string[] | null;
}

export interface ImageDescriptor {
  name: string;
  version?: string;
  source: "builtin" | "local-path" | "cached" | "downloaded";
  downloadMs?: number;
}

export type BuildSandboxOutcome =
  | { ok: true; sandbox: SandboxResult }
  | {
      ok: false;
      backend: SandboxBackend;
      reason: string;
      hint: string;
    };

export async function buildSandbox(opts: BuildSandboxOptions): Promise<BuildSandboxOutcome> {
  if (opts.backend === "none") {
    return {
      ok: true,
      sandbox: {
        backend: "none",
        customTools: [],
        suppressBuiltins: false,
        close: async () => undefined,
        status: { backend: "none" },
      },
    };
  }

  // backend === "gondolin"
  const preflight: PreflightStatus = preflightGondolin();
  if (!preflight.ok) {
    return {
      ok: false,
      backend: "gondolin",
      reason: preflight.reason,
      hint: preflight.hint,
    };
  }

  try {
    const sandbox = await buildGondolinSandbox(opts.cwd, {
      env: opts.env,
      imagePath: opts.imagePath,
      image: opts.image,
      allowedHttpHosts: opts.allowedHttpHosts,
    });
    return {
      ok: true,
      sandbox: {
        backend: "gondolin",
        customTools: sandbox.customTools,
        suppressBuiltins: true,
        close: sandbox.close,
        status: sandbox.status,
      },
    };
  } catch (err) {
    return {
      ok: false,
      backend: "gondolin",
      reason: "vm-create-failed",
      hint: (err as Error).message,
    };
  }
}
