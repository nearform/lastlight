/**
 * File-search extension entry point.
 *
 * Bundles FFF (`@ff-labs/pi-fff`) — a Rust-backed, git-aware,
 * frecency-ranked fuzzy file/content search — as agentic-pi's default
 * file-search backend, so every run gets it without a per-host
 * `pi install`.
 *
 * Unlike the `github` and `web-search` extensions, this one does NOT
 * contribute a `customTools` array. pi-fff is a full Pi extension
 * (registers tools + an `@`-mention enhancer via an ExtensionFactory), so
 * it is loaded through Pi's resource loader, not the SDK's `customTools`
 * channel. This module's job is to:
 *
 *   1. Resolve the installed pi-fff package directory (the value the
 *      runner hands to `DefaultResourceLoader.additionalExtensionPaths`).
 *   2. Decide the FFF mode the runner publishes via the `PI_FFF_MODE` env.
 *
 * Mirrors the other extensions' "safe by default" contract: if the
 * package can't be resolved (missing / incompatible native binary), we
 * skip with a reason rather than aborting the run, and the agent falls
 * back to Pi's built-in `find`/`grep`.
 */

import { createRequire } from "node:module";
import { dirname } from "node:path";

/** FFF mode. `override` replaces Pi's built-in find/grep under the same names. */
export type FileSearchMode = "override" | "tools-only" | "tools-and-ui";

export const VALID_FILE_SEARCH_MODES: FileSearchMode[] = ["override", "tools-only", "tools-and-ui"];

export const DEFAULT_FILE_SEARCH_MODE: FileSearchMode = "override";

export type FileSearchSkipReason = "disabled-by-flag" | "resolve-failed";

export interface FileSearchExtensionConfig {
  /** When false, the extension is force-skipped (disabled-by-flag). Default: true. */
  fileSearch?: boolean;
  /** FFF mode. Default: "override". */
  fileSearchMode?: FileSearchMode;
  /**
   * Resolver override (injected by tests). Returns the absolute path to the
   * installed `@ff-labs/pi-fff` package directory, or throws.
   */
  resolvePackageDir?: () => string;
}

export interface FileSearchExtensionResult {
  status: "configured" | "skipped";
  reason?: FileSearchSkipReason;
  message?: string;
  /** The FFF mode in effect (echoed for observability). */
  mode?: FileSearchMode;
  /**
   * Absolute path to the pi-fff package directory. The runner passes this
   * to `DefaultResourceLoader.additionalExtensionPaths`. Undefined when
   * skipped.
   */
  packageDir?: string;
  /**
   * Tool names the agent will see, derived from `mode` (for the
   * `extension_status` event only — the tools themselves are registered by
   * pi-fff, not here).
   */
  toolNames: string[];
}

/** Tool names FFF exposes per mode (see @ff-labs/pi-fff src/index.ts). */
function toolNamesForMode(mode: FileSearchMode): string[] {
  return mode === "override"
    ? ["find", "grep", "multi_grep"]
    : ["fffind", "ffgrep", "fff-multi-grep"];
}

function defaultResolvePackageDir(): string {
  // Resolve relative to this module so it works regardless of the
  // consumer's cwd. `@ff-labs/pi-fff/package.json` is always present; its
  // directory is what the loader's package resolver reads the `pi`
  // manifest from.
  const require = createRequire(import.meta.url);
  return dirname(require.resolve("@ff-labs/pi-fff/package.json"));
}

export function loadFileSearchExtension(
  config: FileSearchExtensionConfig = {},
): FileSearchExtensionResult {
  if (config.fileSearch === false) {
    return {
      status: "skipped",
      reason: "disabled-by-flag",
      message: "file search disabled via --no-file-search",
      toolNames: [],
    };
  }

  const mode = config.fileSearchMode ?? DEFAULT_FILE_SEARCH_MODE;
  const resolve = config.resolvePackageDir ?? defaultResolvePackageDir;

  let packageDir: string;
  try {
    packageDir = resolve();
  } catch (err) {
    return {
      status: "skipped",
      reason: "resolve-failed",
      message: `could not resolve @ff-labs/pi-fff: ${(err as Error).message}`,
      mode,
      toolNames: [],
    };
  }

  return {
    status: "configured",
    mode,
    packageDir,
    toolNames: toolNamesForMode(mode),
  };
}

/**
 * True if the skip is something the user almost certainly wants surfaced
 * as a warning. A resolve failure means file search was meant to work but
 * the install/binary is broken; `disabled-by-flag` is an explicit choice
 * and stays silent.
 */
export function isMisconfigurationSkip(result: FileSearchExtensionResult): boolean {
  return result.status === "skipped" && result.reason === "resolve-failed";
}
