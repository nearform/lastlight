/**
 * Filesystem anchors for the eval package.
 *
 * Built-in assets (the shipped sample `datasets/` + `models.json`) live at the
 * PACKAGE ROOT — one level above this file's dir, which is `src/` under tsx in
 * dev and `dist/` when built+installed. Resolving relative to `import.meta.url`
 * (not `process.cwd()`) keeps them findable no matter where the CLI is invoked
 * from — including out of `node_modules/lastlight-evals/`.
 *
 * Run OUTPUT, by contrast, is written under the caller's cwd (an installed
 * package dir is read-only), overridable via `LASTLIGHT_EVALS_OUT`.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/** Package root: the dir holding `datasets/`, `models.json`, `package.json`. */
export function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

/** Shipped sample datasets root (`<pkg>/datasets`). */
export function builtinDatasetsRoot(): string {
  return resolve(packageRoot(), "datasets");
}

/** Shipped default model registry (`<pkg>/models.json`). */
export function builtinModelsPath(): string {
  return resolve(packageRoot(), "models.json");
}

/**
 * Built dashboard SPA assets (`<pkg>/dashboard/dist`) served by `serve`. Shipped
 * prebuilt in the npm package so an installed CLI needs no Vite at runtime; in
 * this repo it's produced by `npm run build` (which also builds the harness).
 * Overridable via `LASTLIGHT_EVALS_DASHBOARD` for development.
 */
export function dashboardDistRoot(): string {
  return process.env.LASTLIGHT_EVALS_DASHBOARD
    ? resolve(process.env.LASTLIGHT_EVALS_DASHBOARD)
    : resolve(packageRoot(), "dashboard", "dist");
}

/** Where scorecards/artifacts are written (cwd-relative, NOT the package dir). */
export function resultsRoot(): string {
  return process.env.LASTLIGHT_EVALS_OUT
    ? resolve(process.env.LASTLIGHT_EVALS_OUT)
    : resolve(process.cwd(), "eval-results");
}

/**
 * The tier-combo directory — `<resultsRoot>/<tiersKey>`. It holds the
 * overview/history `index.html` plus one timestamped subdir per run, so runs
 * accumulate instead of overwriting each other.
 */
export function tierResultsDir(tiersKey: string): string {
  return join(resultsRoot(), tiersKey);
}

/** This package's own version, read from the resolved `package.json`. `"?"` if
 * unreadable — a provenance stamp must never abort a run. */
export function harnessVersion(): string {
  try {
    const raw = readFileSync(join(packageRoot(), "package.json"), "utf8");
    return (JSON.parse(raw) as { version?: string }).version ?? "?";
  } catch {
    return "?";
  }
}

/**
 * The `lastlight-facts` binary this run would use, following §D1's order —
 * `LASTLIGHT_FACTS_BIN` → `lastlight-facts` on `PATH` → the baked
 * `/opt/lastlight/bin/` path. `null` when nothing resolves.
 *
 * Re-implemented here rather than imported from `lastlight-code-facts`: that
 * package is a CLI dependency, not an evals one, and the eval harness runs
 * `--sandbox none` on the host where the baked path does not exist. An env var
 * pointing at a NON-executable path resolves to `null` rather than falling
 * through — a wrong pointer is a configuration error worth seeing, and a run
 * that silently used a different binary than the operator named is exactly the
 * provenance gap this stamp exists to close.
 */
export const BAKED_FACTS_BIN = "/opt/lastlight/bin/lastlight-facts";

export function resolveFactsBin(env: NodeJS.ProcessEnv = process.env): string | null {
  const executable = (p: string): boolean => {
    try {
      accessSync(p, constants.X_OK);
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  const override = env.LASTLIGHT_FACTS_BIN;
  if (override) return executable(override) ? override : null;
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) {
    const cand = join(dir, "lastlight-facts");
    if (executable(cand)) return cand;
  }
  if (executable(BAKED_FACTS_BIN)) return BAKED_FACTS_BIN;
  // Monorepo fallback: a harness run from `apps/evals` in the `nearform/lastlight`
  // workspace has the sibling `packages/code-facts` build on disk but nothing
  // linking it onto PATH (`code-facts` is a CLI dependency, not an evals one).
  // Without this, a shell that lost its `LASTLIGHT_FACTS_BIN` runs the whole
  // pr-review pipeline with the conservation gate AND the reconcile floor dead —
  // measured 2026-08-25: 32/32 case-runs exited the gate 127, every adjudication
  // ran to max_iterations, and reconcile repaired nothing, while the scorecard
  // stamped only `factsBin: null`.
  const workspaceBin = join(packageRoot(), "..", "..", "packages", "code-facts", "dist", "cli.js");
  return executable(workspaceBin) ? workspaceBin : null;
}

/**
 * `lastlight-facts toolchain` → its probed binaries, flattened to
 * `tool → "<resolved> (<status>)"`.
 *
 * Flattened rather than stored raw so it matches the per-case
 * `ReviewPipelineStats.toolchain` (`Record<string, string>`) — one shape for the
 * same fact at two levels. `status` rides along because `mismatch` is not an
 * error and a bare version string would hide it.
 *
 * Best-effort and bounded: it spawns the CLI once with a hard timeout and
 * returns `undefined` on any failure. Called only when {@link resolveFactsBin}
 * found something, so a host without the binary pays nothing.
 */
export function factsToolchainStamp(bin: string | null): Record<string, string> | undefined {
  if (!bin) return undefined;
  try {
    const r = spawnSync(bin, ["toolchain"], { encoding: "utf8", timeout: 30_000 });
    if (r.status !== 0 || !r.stdout) return undefined;
    const parsed = JSON.parse(r.stdout) as { resolved?: ToolchainReport };
    return flattenToolchain(parsed.resolved);
  } catch {
    return undefined;
  }
}

/** What `lastlight-facts` reports about its own toolchain, at either level. */
export interface ToolchainReport {
  bundled?: Record<string, string>;
  binaries?: Record<string, { resolved?: string | null; status?: string }>;
}

/**
 * Flatten a toolchain report to `tool → "<resolved> (<status>)"`.
 *
 * Shared by the run-level stamp above and the per-case
 * `ReviewPipelineStats.toolchain` (`review-pipeline-stats.ts`), which reads the
 * same structure out of a case's own `facts.json`. One implementation because
 * they are one fact recorded at two levels — two flatteners would let the run
 * and the case disagree about which opengrep produced a measurement, which is
 * precisely the drift the stamp exists to make visible.
 */
export function flattenToolchain(report: ToolchainReport | undefined): Record<string, string> | undefined {
  if (!report) return undefined;
  const out: Record<string, string> = { ...(report.bundled ?? {}) };
  for (const [tool, stamp] of Object.entries(report.binaries ?? {})) {
    out[tool] = `${stamp?.resolved ?? "—"} (${stamp?.status ?? "unknown"})`;
  }
  return Object.keys(out).length ? out : undefined;
}

/** Short git SHA of HEAD, or `undefined` outside a repo / on any failure. */
export function gitShortSha(): string | undefined {
  try {
    const r = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" });
    const sha = r.status === 0 ? r.stdout.trim() : "";
    return sha || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A sortable, filesystem-safe run id: `YYYY-MM-DD_HHMMSS` (UTC, matching the
 * `toISOString()` timestamps used elsewhere) optionally suffixed with the short
 * git SHA of the code under test (e.g. `2026-06-28_143052-a0229c5`). If
 * `parentDir` already holds that id, a numeric `-2`/`-3` suffix is appended so
 * two runs in the same second never collide.
 */
export function makeRunId(date: Date, gitSha?: string, parentDir?: string): string {
  // 2026-06-28T14:30:52.123Z → 2026-06-28_143052
  const stamp = date.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "").replace("T", "_");
  const base = gitSha ? `${stamp}-${gitSha}` : stamp;
  if (!parentDir) return base;
  let id = base;
  for (let n = 2; existsSync(join(parentDir, id)); n++) id = `${base}-${n}`;
  return id;
}

/**
 * Pre-assign `count` sibling run ids for a `--repeat-concurrency` batch, BEFORE
 * any repeat launches.
 *
 * {@link makeRunId} alone cannot serve concurrent repeats: it dedupes against
 * what is already ON DISK, and a pre-assigned id has no dir yet — so N
 * simultaneous launches inside one second would all resolve to the same id.
 * This walks the clock forward one second per id (and keeps walking past any
 * collision, on disk or within the batch), so every id keeps the plain
 * `<YYYY-MM-DD_HHMMSS>[-<sha>]` shape the dashboard's two-level walk and
 * `clean.ts` expect, AND a timestamp stamp unique within the batch — which
 * `backfill-pipeline.ts`'s `runStampOf` archive-matching treats as a per-run
 * key. The ids are in launch order; index 0 doubles as the band's
 * `meta.repeat.group`. The later stamps run up to `count-1` seconds ahead of
 * the wall clock, which is the price of collision-free pre-assignment.
 */
export function assignRunIds(count: number, start: Date, gitSha?: string, parentDir?: string): string[] {
  const ids: string[] = [];
  const taken = new Set<string>();
  let at = start;
  for (let i = 0; i < count; i++) {
    let id = makeRunId(at, gitSha, parentDir);
    while (taken.has(id)) {
      at = new Date(at.getTime() + 1000);
      id = makeRunId(at, gitSha, parentDir);
    }
    taken.add(id);
    ids.push(id);
    at = new Date(at.getTime() + 1000); // the next repeat starts at least a second later
  }
  return ids;
}
