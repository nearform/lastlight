/**
 * Binary resolution and the toolchain stamp (design review §D1/§D2/§D3).
 *
 * TWO TIERS, and which tier a tool is in is not a detail:
 *
 *   - **Bundled (pure JS).** ts-morph and `@ast-grep/napi` are npm dependencies
 *     of this package, so `facts` / `contracts` / `constants` / `deps` work
 *     everywhere the CLI is installed — including a Mac running the eval
 *     harness at `--sandbox none`, which cannot see `/opt/lastlight/` at all.
 *     That is the whole reason `code-facts` ships inside the `lastlight` CLI.
 *   - **Probed (release binaries).** Opengrep and gitleaks are NOT installable
 *     from npm — the `opengrep` npm name is a 145-byte empty stub held by
 *     Aikido, and the `gitleaks` npm name is an unrelated third-party package.
 *     So `patterns` probes them and, when they are absent, emits
 *     `coverage: "degraded"` with a populated `degraded[]` rather than an empty
 *     finding list.
 *
 * RESOLUTION ORDER, per §D1: `LASTLIGHT_<TOOL>_BIN` → `PATH` → the baked
 * `/opt/lastlight/bin/<tool>` path. The env var is what lets the eval point at
 * a host install without the image; `PATH` is the sandbox and dev case; the
 * baked path is the belt-and-braces for an image whose `PATH` a phase narrowed.
 *
 * `resolveFactsBin()` applies the same order to THIS CLI, for the phase that
 * has to spawn it.
 */
import { createRequire } from "node:module";
import { accessSync, constants as fsConstants, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { delimiter } from "node:path";
import { spawnSync } from "node:child_process";
import type { ToolStamp, ToolchainStamp } from "./schema.js";

const require_ = createRequire(import.meta.url);

/** The directory the sandbox image bakes the toolchain into (WP2). */
export const BAKED_BIN_DIR = "/opt/lastlight/bin";

export interface ToolManifestEntry {
  version: string;
  tier: string;
  usedBy: string[];
  probe: string[];
  source: string;
  note?: string;
}

export interface ToolManifest {
  version: number;
  binaries: Record<string, ToolManifestEntry>;
}

/** This package's own root, resolved from the compiled/loaded module. */
export function packageRoot(): string {
  // `dist/toolchain.js` → `..` is the package root; `src/toolchain.ts` → `..`
  // is the package root too. Both layouts are one level below it.
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

let manifestCache: ToolManifest | undefined;

/** `toolchain.json` — the single source of truth (§D3). */
export function loadManifest(): ToolManifest {
  if (!manifestCache) {
    const raw = readFileSync(join(packageRoot(), "toolchain.json"), "utf8");
    manifestCache = JSON.parse(raw) as ToolManifest;
  }
  return manifestCache;
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const pathValue = env.PATH ?? "";
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutable(candidate)) return candidate;
  }
  return null;
}

/** `opengrep` → `LASTLIGHT_OPENGREP_BIN`; `ast-grep` → `LASTLIGHT_AST_GREP_BIN`. */
export function envVarFor(tool: string): string {
  return `LASTLIGHT_${tool.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BIN`;
}

/**
 * `LASTLIGHT_<TOOL>_BIN` → `PATH` → `/opt/lastlight/bin/<tool>`.
 *
 * An env var that points at a non-executable path resolves to `null` rather
 * than silently falling through: a pointer that is wrong is a configuration
 * error the operator wants to see, not a reason to quietly use a different
 * binary than the one they named.
 */
export function resolveToolBin(
  tool: string,
  env: NodeJS.ProcessEnv = process.env,
  envVar = envVarFor(tool),
): string | null {
  const override = env[envVar];
  if (override) return isExecutable(override) ? override : null;
  const found = onPath(tool, env);
  if (found) return found;
  const baked = join(BAKED_BIN_DIR, tool);
  return isExecutable(baked) ? baked : null;
}

/**
 * The same order applied to this CLI itself, for whoever has to spawn it —
 * `LASTLIGHT_FACTS_BIN` → `lastlight-facts` on `PATH` → the baked path. The
 * eval points the env var at the built workspace bundle (§D1).
 *
 * The env var is `LASTLIGHT_FACTS_BIN`, not the `envVarFor()` derivation — §D1
 * names it, and a spelling nobody uses is the same as no override at all.
 */
export function resolveFactsBin(env: NodeJS.ProcessEnv = process.env): string | null {
  return resolveToolBin("lastlight-facts", env, "LASTLIGHT_FACTS_BIN");
}

/**
 * `--version` output → the first version-shaped token, or the whole line.
 *
 * No leading `\b`: gitleaks prints `v8.21.2`, and a word boundary between `v`
 * and `8` does not exist, so the anchored form silently parsed `21.2` and every
 * gitleaks stamp would have read `mismatch`.
 */
export function parseVersion(output: string): string | null {
  const match = /\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?/.exec(output);
  if (match) return match[0];
  const line = output.trim().split("\n")[0];
  return line ? line.trim() : null;
}

function probeVersion(bin: string, args: string[]): string | null {
  try {
    const result = spawnSync(bin, args, { encoding: "utf8", timeout: 10_000 });
    if (result.error) return null;
    return parseVersion(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  } catch {
    return null;
  }
}

/**
 * Probe one manifest binary and produce its stamp. `mismatch` is deliberately
 * NOT an error: the run is still usable, and recording the deviation is what
 * keeps a scorecard readable months later.
 */
export function stampTool(tool: string, env: NodeJS.ProcessEnv = process.env): ToolStamp {
  const entry = loadManifest().binaries[tool];
  const expected = entry?.version ?? null;
  const bin = resolveToolBin(tool, env);
  if (!bin) return { expected, resolved: null, path: null, status: "missing" };
  const resolved = probeVersion(bin, entry?.probe ?? ["--version"]);
  if (!resolved) return { expected, resolved: null, path: bin, status: "missing" };
  return {
    expected,
    resolved,
    path: bin,
    status: expected && resolved !== expected ? "mismatch" : "ok",
  };
}

/**
 * The npm-resolved engines, read off the INSTALLED package.json rather than
 * copied into `toolchain.json`. The lockfile is the stronger pin, and a second
 * hand-maintained copy is exactly the drift the manifest exists to prevent.
 */
export function bundledVersions(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of ["ts-morph", "@ast-grep/napi"]) {
    try {
      const pkgPath = require_.resolve(`${name}/package.json`);
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
      if (pkg.version) out[name] = pkg.version;
    } catch {
      // A missing bundled engine is a broken install, and the extractor that
      // needs it will say so in `degraded[]`. The stamp just records absence.
    }
  }
  try {
    const self = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    if (self.version) out["lastlight-code-facts"] = self.version;
  } catch {
    /* istanbul ignore next — only reachable on a broken bundle */
  }
  return out;
}

/**
 * The full stamp that goes in every envelope. `tools` names which binaries this
 * run actually needed; everything else in the manifest is stamped `unprobed`
 * so the document still records what the manifest pins.
 */
export function toolchainStamp(
  tools: string[],
  env: NodeJS.ProcessEnv = process.env,
): ToolchainStamp {
  const manifest = loadManifest();
  const binaries: Record<string, ToolStamp> = {};
  for (const [name, entry] of Object.entries(manifest.binaries)) {
    binaries[name] = tools.includes(name)
      ? stampTool(name, env)
      : { expected: entry.version, resolved: null, path: null, status: "unprobed" };
  }
  return { manifest: manifest.version, bundled: bundledVersions(), binaries };
}
