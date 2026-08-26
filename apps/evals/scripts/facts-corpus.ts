#!/usr/bin/env -S npx tsx
/**
 * Run `lastlight-code-facts` over the real pr-review corpus and report WHAT IT SAW.
 *
 * This is a **measurement script**, not a test: it never asserts, never tunes,
 * and exits non-zero only on harness error. The deliverable is the roll-up —
 * how many of the 50 Martian Code Review Bench PRs the deterministic layer can
 * actually analyse, at which tier, at what wall-clock/RSS cost, and (the thing
 * that matters most) how often a healthy-looking envelope hides near-total
 * blindness.
 *
 * Usage:
 *   npx tsx scripts/facts-corpus.ts [--profile smoke|full] [--only id,id]
 *       [--dataset <instances.json|datasetsDir>] [--cache <.eval-cache>]
 *       [--timeout <ms>] [--keep] [--install] [--out <dir>]
 *       [--compare <runId> [--against <runId>]]
 *
 *   --profile smoke   8 cases: one per repo + the two largest diffs (default: full)
 *   --only            exact instance_ids, comma separated (overrides --profile)
 *   --timeout         per-case wall clock ceiling, default 300000 ms
 *   --keep            keep the worktrees (and print where) instead of removing them
 *   --install         WP4's arm: run `lastlight-facts prepare` in each worktree
 *                     BEFORE `all`, so the analysis sees an installed tree.
 *                     Costs the network, gigabytes of node_modules and minutes
 *                     per case. Compare a `--install` run against a bare one
 *                     with `--compare`; do not mix them in one table.
 *   --compare <old>   after the run, diff it against an earlier run's report.json
 *   --against <new>   with --compare: diff two STORED runs and measure nothing
 *
 * Artifacts land in `<out>/facts-corpus/<runId>/` (`runId` = `<timestamp>-<git-sha>`,
 * the same convention as `src/run.ts`): `report.json`, `report.md`, and the raw
 * per-case envelopes under `case/<instanceId>.json`.
 *
 * ── Four decisions that are load-bearing ─────────────────────────────────────
 *
 * 1. **The CLI is SPAWNED, never imported.** An exit code is only real for a
 *    process; peak RSS is only meaningful for a process; and the documented
 *    `exit 134, no envelope` OOM trap (`packages/code-facts/CLAUDE.md`, "`--never-fail`
 *    covers thrown errors, not a dead process") is *invisible* in-process.
 *    Catching that is the whole point of this harness.
 * 2. **No `--never-fail`.** That flag is the workflow-phase wrapper, whose job is
 *    to keep a failed analysis from failing a 30-minute-re-dispatch cron. Here a
 *    human reads the result, so the exit code is the right signal and we want it
 *    unmasked (0 trustworthy / 2 could not run / 3 degraded).
 * 3. **Never clone; `git worktree` off the shared bare mirror.** The mirrors in
 *    `.eval-cache/repos/` are ~4.9 GB across six repos; a clone would copy up to
 *    1.8 GB per case. `worktree add --detach` costs 1.3–3.8 s and shares object
 *    storage. Every worktree is removed + pruned in a `finally`.
 * 4. **Concurrency is fixed at 1.** Peak RSS is meaningless when two analyses
 *    share a machine, and wall clock nearly so. There is no `--jobs` flag on
 *    purpose.
 *
 * The worktrees have **no `node_modules`** — and that is production's exact
 * shape (the review workspace has none), so it is the right measurement, not a
 * defect to paper over. It is recorded per case as `nodeModules: false`.
 *
 * **`--install` is the exception, and it is a second population rather than a
 * better one.** WP4's `prepare` phase changes that shape deliberately: on a bare
 * tree a `tsconfig` that `extends` a bare package specifier does not resolve,
 * tsgo excludes the project, and the case drops to tier 2 with `contracts`
 * emitting nothing. This flag is how that claim gets read instead of argued —
 * the two arms differ in exactly one variable, and `meta.install` marks which is
 * which so a report can never be mistaken for the other.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";

import type { SweBenchInstance } from "../src/schema.js";
import { gitShortSha, makeRunId, resultsRoot } from "../src/paths.js";

// ── CLI plumbing (shared shape with scripts/mine-failures.ts) ────────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
}
function list(name: string): string[] {
  return (flag(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
function die(msg: string): never {
  console.error(`facts-corpus: ${msg}`);
  process.exit(1);
}

// ── Types ────────────────────────────────────────────────────────────────────

interface CaseRecord {
  instanceId: string;
  repo: string;
  baseSha: string;
  headSha: string;
  /** `git diff --name-only base..head` — TWO dots. This is NO LONGER what the
   * tool diffs: `git.ts` moved to the merge base, and `changedFilesMergeBase`
   * below is the denominator that matches it. Kept because the divergence
   * table needs both, and because every pre-2026-08-21 run in eval-results/
   * reports against this one. `filesAnalysed / changedFiles` is therefore a
   * LOWER bound on coverage wherever the two disagree — report both, and never
   * switch denominators mid-comparison. */
  changedFiles: number;
  /** The THREE-dot (merge-base) count. Recorded because a PR's stored
   * `base_commit` is the base *branch tip* at import time, not necessarily the
   * merge base — where the two disagree, the tool analysed the two-dot set. */
  changedFilesMergeBase: number;
  /** Extension histogram over the changed files. */
  languageMix: Record<string, number>;
  /** Modal extension. A HEURISTIC label, not language detection: a Java PR
   * carrying 40 `.properties` files is labelled `.properties`, and that is the
   * honest answer to "what does this diff mostly consist of". */
  primaryLanguage: string;
  /** Whether `node_modules` existed at the moment `all` ran.
   *
   * False on every ordinary run, and that is production's exact shape: the
   * review workspace is a bare pre-clone. `--install` is what makes it true —
   * see {@link CaseRecord.prepare} and the header. Recorded so nobody has to
   * re-derive why symbols are missing. */
  nodeModules: boolean;
  /**
   * `lastlight-facts prepare`'s own answer, when `--install` asked for one.
   *
   * `null` on the bare arm. This is the WP4 measurement: `prepare` claims that
   * installing dependencies is what lets a `tsconfig` that `extends` a bare
   * package specifier resolve, and therefore what lets `contracts` emit
   * anything at all on a normal monorepo. That claim is deterministic and costs
   * no model spend, so it is read here rather than argued.
   */
  prepare: {
    packageManager: string | null;
    install: string;
    installed: boolean;
    durationMs: number;
    degradedReasons: string[];
  } | null;
  run: {
    exitCode: number | null;
    signal: string | null;
    wallClockMs: number;
    peakRssMb: number | null;
    envelopeWritten: boolean;
    stderrTail: string;
  };
  envelope: {
    tier: number | null;
    coverage: string | null;
    degradedCount: number;
    degradedByExtractor: Record<string, number>;
    degradedReasons: string[];
  };
  payloadCounts: {
    facts: { files: number; filesAnalysed: number; symbols: number; referencesTotal: number; referencesInDiffTotal: number } | null;
    contracts: { total: number; added: number; removed: number; changed: number; consumersOutsideDiff: number } | null;
    constants: { total: number; withDuplicates: number } | null;
    deps: { changes: number } | null;
    patterns: { findings: number } | null;
    coverage: { changedLines: number; uncovered: number } | null;
  };
}

interface Report {
  meta: {
    runId: string;
    generatedAt: string;
    gitSha?: string;
    profile: string;
    dataset: string;
    cache: string;
    factsCli: string;
    factsVersion: string | null;
    platform: string;
    node: string;
    timeoutMs: number;
    concurrency: 1;
    neverFail: false;
    /** `--install`: dependencies were installed before `all` ran. THE arm
     * marker — a report with this true is not comparable, case for case, to one
     * with it false except as the comparison it exists to make. */
    install: boolean;
    cases: number;
  };
  rollup: Rollup;
  cases: CaseRecord[];
}

interface Rollup {
  byTier: Record<string, number>;
  byCoverage: Record<string, number>;
  byExitCode: Record<string, number>;
  /** Cases whose process died without leaving an envelope. READ THIS FIRST. */
  noEnvelope: string[];
  /**
   * Cases where `base..head` and `base...head` disagree — i.e. the stored
   * `base_commit` is far behind the merge base, so the tool analyses the base
   * branch's own history as if the PR had changed it. This is the single
   * biggest driver of wall clock and RSS in the corpus, and it inflates the
   * `changedFiles` denominator in `blindSpots` for exactly those cases.
   */
  diffRangeDivergence: { instanceId: string; twoDot: number; threeDot: number; excess: number }[];
  /** Tier 1/2 cases where the tool analysed far fewer files than changed — a
   * good-looking tier hiding near-total blindness. */
  blindSpots: { instanceId: string; tier: number | null; changedFiles: number; filesAnalysed: number; ratio: number }[];
  wallClockMs: { p50: number; p90: number; max: number; over90s: number };
  peakRssMb: { p50: number; p90: number; max: number };
  topDegradedReasons: { reason: string; count: number; cases: number }[];
  /**
   * `--install` only. What `prepare` actually did, per case — because "the
   * contract deltas did not move" and "nothing installed" are the same table
   * with opposite conclusions, and only this section can tell them apart.
   */
  prepare: {
    attempted: number;
    installed: number;
    byOutcome: Record<string, number>;
    byPackageManager: Record<string, number>;
    wallClockMs: { p50: number; p90: number; max: number };
    /** Cases where `prepare` ran and `node_modules` still does not exist. */
    failures: { instanceId: string; install: string; reason: string }[];
  } | null;
  byLanguage: {
    language: string;
    cases: number;
    tiers: Record<string, number>;
    meanSymbols: number;
    meanAnalysedRatio: number;
  }[];
  totals: Record<string, number>;
}

// ── Resolution: repo root, dataset, mirror cache ─────────────────────────────

/** Walk up from this file to the monorepo root (the dir holding `packages/`). */
function monorepoRoot(): string {
  let dir = resolve(import.meta.dirname, "..", "..", "..");
  for (let i = 0; i < 5; i++) {
    if (existsSync(join(dir, "packages", "code-facts", "package.json"))) return dir;
    dir = resolve(dir, "..");
  }
  die("could not locate the monorepo root (no packages/code-facts above this script)");
}

/**
 * The mirror cache: `--cache` → `LASTLIGHT_EVALS_CACHE` → `<cwd>/.eval-cache`.
 * `<cache>/repos/<owner>__<name>.git` are the bare mirrors `src/seed.ts` keeps.
 */
function resolveCache(): string {
  const explicit = flag("cache") ?? process.env.LASTLIGHT_EVALS_CACHE;
  if (explicit) return resolve(explicit);
  return resolve(process.cwd(), ".eval-cache");
}

/**
 * The dataset: `--dataset` (an `instances.json` OR a datasets dir) →
 * `LASTLIGHT_EVALS_DATASETS` → the in-repo copy (gitignored, often absent) →
 * the standalone evals workspace that owns the same cache dir. That last
 * candidate is what makes one invocation work against either location.
 */
function resolveDataset(cache: string): string {
  const candidates: string[] = [];
  const push = (p: string | undefined): void => {
    if (!p) return;
    const r = resolve(p);
    candidates.push(r.endsWith(".json") ? r : join(r, "pr-review", "instances.json"));
  };
  push(flag("dataset"));
  push(process.env.LASTLIGHT_EVALS_DATASETS);
  push(resolve(import.meta.dirname, "..", "datasets"));
  push(resolve(cache, "..", "datasets"));
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) {
    die(
      `no pr-review instances.json found. Tried:\n  ${candidates.join("\n  ")}\n` +
        `Pass --dataset <path/to/instances.json> or set LASTLIGHT_EVALS_DATASETS.`,
    );
  }
  return hit;
}

function mirrorPath(cache: string, repo: string): string {
  return join(cache, "repos", `${repo.replace("/", "__")}.git`);
}

// ── git helpers (all read-only against the BARE mirror) ──────────────────────

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", ["-C", repoDir, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_CONFIG_PARAMETERS: "'safe.directory=*'" },
  });
}

function hasCommit(mirror: string, sha: string): boolean {
  try {
    git(mirror, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

function nameOnly(mirror: string, range: string): string[] {
  try {
    return git(mirror, ["diff", "--name-only", range]).split("\n").map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** Extension histogram. Extensionless files key on their basename (`Dockerfile`,
 * `Makefile`) rather than collapsing to one meaningless bucket. */
function histogram(files: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of files) {
    const ext = extname(f).toLowerCase() || basename(f).toLowerCase();
    out[ext] = (out[ext] ?? 0) + 1;
  }
  return out;
}

function modal(hist: Record<string, number>): string {
  let best = "(none)";
  let n = -1;
  for (const [k, v] of Object.entries(hist).sort(([a], [b]) => a.localeCompare(b))) {
    if (v > n) [best, n] = [k, v];
  }
  return best;
}

// ── Peak RSS: the portability wart, stated out loud ──────────────────────────
//
// `process.resourceUsage()` reports THIS process, never a child's peak, so it
// cannot answer "how much memory did the analysis need". Node exposes no child
// peak-RSS API at all. So we wrap the child in the platform's `time(1)`:
//   darwin: `/usr/bin/time -l`  → "  172408832  maximum resident set size"  (BYTES)
//   linux:  `/usr/bin/time -v`  → "Maximum resident set size (kbytes): 168368" (KB)
// Two different binaries, two different units. Anywhere else (or with no
// `/usr/bin/time`) we run the child bare and report `peakRssMb: null` rather
// than inventing a number.
const TIME_BIN = "/usr/bin/time";
const timeSupported = existsSync(TIME_BIN) && (process.platform === "darwin" || process.platform === "linux");

function parsePeakRssMb(stderr: string): number | null {
  if (process.platform === "darwin") {
    const m = stderr.match(/^\s*(\d+)\s+maximum resident set size/m);
    return m ? Number(m[1]) / (1024 * 1024) : null;
  }
  const m = stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  return m ? Number(m[1]) / 1024 : null;
}

/** Strip `time(1)`'s resource table so `stderrTail` shows the TOOL's output. */
function stripTimeBlock(stderr: string): string {
  return stderr
    .split("\n")
    .filter(
      (l) =>
        !/^\s*[\d.]+\s+real\s/.test(l) &&
        !/^\s*\d+\s+[a-z][a-z ()\/]*$/.test(l) &&
        !/^\s*[A-Z][A-Za-z ()\/]+:\s/.test(l) &&
        !/^\s*Command being timed:/.test(l) &&
        !/^time: command terminated abnormally/.test(l),
    )
    .join("\n")
    .trim();
}

// ── The run ──────────────────────────────────────────────────────────────────

interface Selected {
  inst: SweBenchInstance;
  baseSha: string;
  headSha: string;
  mirror: string;
  files: string[];
  mergeBaseFiles: number;
}

function shas(inst: SweBenchInstance): { base: string; head: string } | null {
  const base = inst.pr?.base_commit ?? inst.base_commit;
  const head = inst.pr?.head_commit ?? inst.head_commit;
  return base && head ? { base, head } : null;
}

/**
 * Run `lastlight-facts prepare` in the worktree and return what it recorded.
 *
 * Spawned exactly like `all` below — a separate process, no `--never-fail`, so
 * an exit code still means something to the human reading the report. Its
 * lifecycle scripts stay OFF (the CLI's default), which matters more here than
 * in production: this installs six real third-party repositories on somebody's
 * laptop.
 */
function runPrepare(
  wt: string,
  factsCli: string,
  timeoutMs: number,
): CaseRecord["prepare"] {
  const envPath = join(wt, ".lastlight", "pr-review", "probes", "env.json");
  const started = Date.now();
  const r = spawnSync(
    process.execPath,
    [factsCli, "prepare", "--repo", wt, "--out", envPath],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_PARAMETERS: "'safe.directory=*'" },
    },
  );
  const elapsed = Date.now() - started;
  if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
    spawnSync("pkill", ["-9", "-f", wt], { stdio: "ignore" });
  }

  if (!existsSync(envPath)) {
    // A prepare that wrote nothing is the §D12 shape, and it must not read as
    // "nothing needed installing".
    return {
      packageManager: null,
      install: "no-envelope",
      installed: existsSync(join(wt, "node_modules")),
      durationMs: elapsed,
      degradedReasons: [`prepare wrote no env.json (exit ${r.status ?? "none"}): ${(r.stderr ?? "").slice(-400)}`],
    };
  }
  try {
    const env = JSON.parse(readFileSync(envPath, "utf8")) as Record<string, any>;
    return {
      packageManager: env.packageManager ?? null,
      install: String(env.install),
      installed: env.installed === true,
      durationMs: elapsed,
      degradedReasons: ((env.degraded ?? []) as { extractor: string; reason: string }[]).map(
        (d) => `${d.extractor}: ${d.reason}`,
      ),
    };
  } catch (err) {
    return {
      packageManager: null,
      install: "unparseable",
      installed: existsSync(join(wt, "node_modules")),
      durationMs: elapsed,
      degradedReasons: [`env.json is not parseable: ${(err as Error).message}`],
    };
  }
}

function runOne(
  sel: Selected,
  opts: { factsCli: string; caseDir: string; wtRoot: string; timeoutMs: number; keep: boolean; install: boolean },
): CaseRecord {
  const id = sel.inst.instance_id;
  const wt = join(opts.wtRoot, id);
  const outPath = join(opts.caseDir, `${id}.json`);

  const rec: CaseRecord = {
    instanceId: id,
    repo: sel.inst.repo,
    baseSha: sel.baseSha,
    headSha: sel.headSha,
    changedFiles: sel.files.length,
    changedFilesMergeBase: sel.mergeBaseFiles,
    languageMix: histogram(sel.files),
    primaryLanguage: modal(histogram(sel.files)),
    nodeModules: false,
    prepare: null,
    run: { exitCode: null, signal: null, wallClockMs: 0, peakRssMb: null, envelopeWritten: false, stderrTail: "" },
    envelope: { tier: null, coverage: null, degradedCount: 0, degradedByExtractor: {}, degradedReasons: [] },
    payloadCounts: { facts: null, contracts: null, constants: null, deps: null, patterns: null, coverage: null },
  };

  try {
    git(sel.mirror, ["worktree", "add", "--detach", wt, sel.headSha]);

    // WP4's arm. BEFORE `all`, and that ordering is the measurement: an install
    // that arrives after the analysis cannot make an unresolvable `extends`
    // resolve. Its wall clock is recorded separately so it never contaminates
    // the `all` figure this harness exists to report.
    if (opts.install) {
      rec.prepare = runPrepare(wt, opts.factsCli, opts.timeoutMs);
    }
    // Asked of the filesystem, not of `prepare` — a failed install can still
    // leave a partial tree, and what the compiler sees is what is there.
    rec.nodeModules = existsSync(join(wt, "node_modules"));

    const argv = ["all", "--repo", wt, "--base", sel.baseSha, "--head", sel.headSha, "--out", outPath];
    const bin = timeSupported ? TIME_BIN : process.execPath;
    const args = timeSupported
      ? [process.platform === "darwin" ? "-l" : "-v", process.execPath, opts.factsCli, ...argv]
      : [opts.factsCli, ...argv];

    const started = Date.now();
    const r = spawnSync(bin, args, {
      encoding: "utf8",
      timeout: opts.timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_PARAMETERS: "'safe.directory=*'" },
    });
    rec.run.wallClockMs = Date.now() - started;
    // `spawnSync` has no `detached` (the sync path never reads it), so a timeout
    // kills only `time(1)` and ORPHANS the node analysis — whose CPU would then
    // corrupt every later case's wall clock, on a run whose whole point is wall
    // clock. The worktree path is unique per case, so `pkill -f` on it is an
    // exact, safe reap.
    if (r.error && (r.error as NodeJS.ErrnoException).code === "ETIMEDOUT") {
      spawnSync("pkill", ["-9", "-f", wt], { stdio: "ignore" });
    }

    const stderr = r.stderr ?? "";
    const rssMb = timeSupported ? parsePeakRssMb(stderr) : null;
    // 0.1 MB is already below the run-to-run noise floor (the same case has been
    // measured 1660 MB and 2775 MB on consecutive runs), so more digits are lies.
    rec.run.peakRssMb = rssMb == null ? null : round(rssMb);
    rec.run.exitCode = r.status;
    // With the `time(1)` wrapper our direct child is `time`, so spawnSync's
    // `signal` is null even when the ANALYSIS died on one; BSD/GNU time both
    // report 128+signo, which is how `exit 134` (SIGABRT/OOM) surfaces here.
    rec.run.signal = r.signal ?? (typeof r.status === "number" && r.status > 128 ? `SIG${r.status - 128}` : null);
    if (r.error) rec.run.stderrTail = `spawn error: ${r.error.message}\n`;
    rec.run.stderrTail += stripTimeBlock(stderr).slice(-1200);

    if (existsSync(outPath)) {
      try {
        const doc = JSON.parse(readFileSync(outPath, "utf8")) as Record<string, any>;
        rec.run.envelopeWritten = true;
        rec.envelope.tier = doc.tier ?? null;
        rec.envelope.coverage = doc.coverage ?? null;
        const degraded = (doc.degraded ?? []) as { extractor: string; reason: string }[];
        rec.envelope.degradedCount = degraded.length;
        for (const d of degraded) {
          rec.envelope.degradedByExtractor[d.extractor] = (rec.envelope.degradedByExtractor[d.extractor] ?? 0) + 1;
          rec.envelope.degradedReasons.push(`${d.extractor}: ${d.reason}`);
        }
        rec.payloadCounts = countPayloads(doc.extractors ?? {});
      } catch (err) {
        rec.run.stderrTail += `\n[harness] envelope at ${outPath} is not parseable: ${(err as Error).message}`;
      }
    }
  } finally {
    if (!opts.keep) {
      try {
        git(sel.mirror, ["worktree", "remove", "--force", wt]);
      } catch {
        try {
          rmSync(wt, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      try {
        git(sel.mirror, ["worktree", "prune"]);
      } catch {
        /* best effort */
      }
    }
  }
  return rec;
}

function countPayloads(ex: Record<string, any>): CaseRecord["payloadCounts"] {
  const out: CaseRecord["payloadCounts"] = { facts: null, contracts: null, constants: null, deps: null, patterns: null, coverage: null };
  if (ex.facts) {
    const files = (ex.facts.files ?? []) as { analysed?: boolean }[];
    const symbols = (ex.facts.symbols ?? []) as { referenceCount?: number; referencesInDiff?: number }[];
    out.facts = {
      files: files.length,
      filesAnalysed: files.filter((f) => f.analysed).length,
      symbols: symbols.length,
      referencesTotal: symbols.reduce((n, s) => n + (s.referenceCount ?? 0), 0),
      referencesInDiffTotal: symbols.reduce((n, s) => n + (s.referencesInDiff ?? 0), 0),
    };
  }
  if (ex.contracts) {
    const cs = (ex.contracts.contracts ?? []) as { change: string; consumersOutsideDiff?: string[] }[];
    out.contracts = {
      total: cs.length,
      added: cs.filter((c) => c.change === "added").length,
      removed: cs.filter((c) => c.change === "removed").length,
      changed: cs.filter((c) => c.change === "changed").length,
      consumersOutsideDiff: cs.reduce((n, c) => n + (c.consumersOutsideDiff?.length ?? 0), 0),
    };
  }
  if (ex.constants) {
    const cs = (ex.constants.constants ?? []) as { hardCodedDuplicates?: string[] }[];
    out.constants = { total: cs.length, withDuplicates: cs.filter((c) => (c.hardCodedDuplicates?.length ?? 0) > 0).length };
  }
  if (ex.deps) out.deps = { changes: (ex.deps.changes ?? []).length };
  if (ex.patterns) out.patterns = { findings: (ex.patterns.findings ?? []).length };
  if (ex.coverage) {
    out.coverage = {
      changedLines: ex.coverage.totals?.changedLines ?? 0,
      uncovered: ex.coverage.totals?.uncoveredChangedLines ?? 0,
    };
  }
  return out;
}

// ── Roll-up ──────────────────────────────────────────────────────────────────

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

/** Collapse a degraded reason to its SHAPE: counts and paths vary per case, the
 * failure mode does not. `37 changed file(s) …` and `4 changed file(s) …` are
 * one reason. */
function normaliseReason(reason: string): string {
  return reason
    .replace(/\/[^\s'"]*\/[^\s'"]*/g, "<path>")
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 140);
}

function tally<T extends string | number>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const v of values) out[String(v)] = (out[String(v)] ?? 0) + 1;
  return out;
}

/**
 * The `--install` arm's own summary. `null` when no case was prepared, which is
 * how a bare report stays exactly the document it always was.
 */
function prepareRollup(cases: CaseRecord[]): Rollup["prepare"] {
  const prepared = cases.filter((c) => c.prepare !== null);
  if (prepared.length === 0) return null;
  const wall = prepared.map((c) => c.prepare!.durationMs).sort((a, b) => a - b);
  return {
    attempted: prepared.length,
    installed: prepared.filter((c) => c.prepare!.installed).length,
    byOutcome: tally(prepared.map((c) => c.prepare!.install)),
    byPackageManager: tally(prepared.map((c) => c.prepare!.packageManager ?? "none")),
    wallClockMs: { p50: pct(wall, 50), p90: pct(wall, 90), max: wall.at(-1) ?? 0 },
    failures: prepared
      .filter((c) => !c.prepare!.installed)
      .map((c) => ({
        instanceId: c.instanceId,
        install: c.prepare!.install,
        // The LAST reason, not the first. `prepare` records the strict→loose
        // downgrade before it records the failure, so `[0]` on a failed case is
        // a note about the lockfile and `.at(-1)` is what actually went wrong —
        // measured, on the first case this ever ran against.
        reason: c.prepare!.degradedReasons.at(-1) ?? "(no reason recorded)",
      })),
  };
}

function rollup(cases: CaseRecord[]): Rollup {
  const wall = cases.map((c) => c.run.wallClockMs).sort((a, b) => a - b);
  const rss = cases.map((c) => c.run.peakRssMb).filter((n): n is number => n != null).sort((a, b) => a - b);

  const reasonCounts = new Map<string, { count: number; cases: Set<string> }>();
  for (const c of cases) {
    for (const r of c.envelope.degradedReasons) {
      const key = normaliseReason(r);
      const e = reasonCounts.get(key) ?? { count: 0, cases: new Set<string>() };
      e.count += 1;
      e.cases.add(c.instanceId);
      reasonCounts.set(key, e);
    }
  }

  const byLangMap = new Map<string, CaseRecord[]>();
  for (const c of cases) byLangMap.set(c.primaryLanguage, [...(byLangMap.get(c.primaryLanguage) ?? []), c]);

  const analysedRatio = (c: CaseRecord): number =>
    c.changedFiles > 0 ? (c.payloadCounts.facts?.filesAnalysed ?? 0) / c.changedFiles : 0;

  const totals: Record<string, number> = {
    symbols: 0,
    referencesTotal: 0,
    referencesInDiffTotal: 0,
    contracts: 0,
    consumersOutsideDiff: 0,
    constants: 0,
    constantsWithDuplicates: 0,
    depChanges: 0,
    patternFindings: 0,
    coverageChangedLines: 0,
    coverageUncovered: 0,
    /** Cases whose envelope carried NOTHING but a tier + degraded[]. */
    emptyEnvelopes: 0,
  };
  for (const c of cases) {
    const p = c.payloadCounts;
    totals.symbols += p.facts?.symbols ?? 0;
    totals.referencesTotal += p.facts?.referencesTotal ?? 0;
    totals.referencesInDiffTotal += p.facts?.referencesInDiffTotal ?? 0;
    totals.contracts += p.contracts?.total ?? 0;
    totals.consumersOutsideDiff += p.contracts?.consumersOutsideDiff ?? 0;
    totals.constants += p.constants?.total ?? 0;
    totals.constantsWithDuplicates += p.constants?.withDuplicates ?? 0;
    totals.depChanges += p.deps?.changes ?? 0;
    totals.patternFindings += p.patterns?.findings ?? 0;
    totals.coverageChangedLines += p.coverage?.changedLines ?? 0;
    totals.coverageUncovered += p.coverage?.uncovered ?? 0;
    const anything =
      (p.facts?.symbols ?? 0) + (p.contracts?.total ?? 0) + (p.constants?.total ?? 0) + (p.deps?.changes ?? 0) + (p.patterns?.findings ?? 0);
    if (c.run.envelopeWritten && anything === 0) totals.emptyEnvelopes += 1;
  }

  return {
    byTier: tally(cases.map((c) => (c.envelope.tier == null ? "none" : String(c.envelope.tier)))),
    byCoverage: tally(cases.map((c) => c.envelope.coverage ?? "none(no envelope)")),
    byExitCode: tally(cases.map((c) => (c.run.exitCode == null ? "null" : String(c.run.exitCode)))),
    noEnvelope: cases.filter((c) => !c.run.envelopeWritten).map((c) => c.instanceId),
    diffRangeDivergence: cases
      .filter((c) => c.changedFiles !== c.changedFilesMergeBase)
      .map((c) => ({
        instanceId: c.instanceId,
        twoDot: c.changedFiles,
        threeDot: c.changedFilesMergeBase,
        excess: c.changedFiles - c.changedFilesMergeBase,
      }))
      .sort((a, b) => b.excess - a.excess),
    // A tier-1 label can hide near-total blindness: `prreview__cal-com-11059` is
    // tier 1 and still reports "37 changed file(s) are not in the compiled
    // project and were not analysed". Anything under half is flagged.
    blindSpots: cases
      .filter((c) => c.envelope.tier != null && c.changedFiles > 0 && analysedRatio(c) < 0.5)
      .map((c) => ({
        instanceId: c.instanceId,
        tier: c.envelope.tier,
        changedFiles: c.changedFiles,
        filesAnalysed: c.payloadCounts.facts?.filesAnalysed ?? 0,
        ratio: Number(analysedRatio(c).toFixed(3)),
      }))
      .sort((a, b) => b.changedFiles - a.changedFiles),
    wallClockMs: {
      p50: pct(wall, 50),
      p90: pct(wall, 90),
      max: wall.at(-1) ?? 0,
      // WP1 AC6: the deterministic layer must not dominate a review's latency.
      over90s: cases.filter((c) => c.run.wallClockMs > 90_000).length,
    },
    peakRssMb: { p50: round(pct(rss, 50)), p90: round(pct(rss, 90)), max: round(rss.at(-1) ?? 0) },
    prepare: prepareRollup(cases),
    topDegradedReasons: [...reasonCounts.entries()]
      .map(([reason, e]) => ({ reason, count: e.count, cases: e.cases.size }))
      .sort((a, b) => b.count - a.count || b.cases - a.cases)
      .slice(0, 20),
    byLanguage: [...byLangMap.entries()]
      .map(([language, cs]) => ({
        language,
        cases: cs.length,
        tiers: tally(cs.map((c) => (c.envelope.tier == null ? "none" : String(c.envelope.tier)))),
        meanSymbols: round(cs.reduce((n, c) => n + (c.payloadCounts.facts?.symbols ?? 0), 0) / cs.length),
        meanAnalysedRatio: Number((cs.reduce((n, c) => n + analysedRatio(c), 0) / cs.length).toFixed(3)),
      }))
      .sort((a, b) => b.cases - a.cases || a.language.localeCompare(b.language)),
    totals,
  };
}

function round(n: number): number {
  return Number(n.toFixed(1));
}

// ── Rendering ────────────────────────────────────────────────────────────────

function kv(rec: Record<string, number>): string {
  return Object.entries(rec)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

function renderMarkdown(report: Report): string {
  const { meta, rollup: r, cases } = report;
  const L: string[] = [];
  L.push(`# code-facts corpus run \`${meta.runId}\``);
  L.push("");
  L.push(`${meta.cases} case(s), profile \`${meta.profile}\`, concurrency 1, no \`--never-fail\`. ${meta.generatedAt}`);
  L.push("");
  L.push(`- dataset: \`${meta.dataset}\``);
  L.push(`- mirrors: \`${meta.cache}/repos\` (bare, \`git worktree add --detach\` — never cloned)`);
  L.push(`- CLI: \`${meta.factsCli}\` (lastlight-code-facts ${meta.factsVersion ?? "?"}), node ${meta.node}, ${meta.platform}`);
  L.push(
    meta.install
      ? `- **\`--install\` ARM**: \`lastlight-facts prepare\` ran in each worktree before \`all\`, so the analysis saw an INSTALLED tree. This is not production's shape (the review workspace is a bare pre-clone) — it is the shape WP4's \`prepare\` phase creates. Compare it only against a bare run of the same cases.`
      : `- worktrees carry **no node_modules** — that is production's shape, not a defect.`,
  );
  L.push("");

  L.push(`## Roll-up`);
  L.push("");
  L.push(`| | |`);
  L.push(`|---|---|`);
  L.push(`| byTier | ${kv(r.byTier)} |`);
  L.push(`| byCoverage | ${kv(r.byCoverage)} |`);
  L.push(`| byExitCode | ${kv(r.byExitCode)} (0 ok · 2 could-not-run · 3 degraded) |`);
  L.push(`| noEnvelope | ${r.noEnvelope.length ? r.noEnvelope.join(", ") : "none"} |`);
  L.push(`| wall clock | p50 ${r.wallClockMs.p50} ms · p90 ${r.wallClockMs.p90} ms · max ${r.wallClockMs.max} ms · **${r.wallClockMs.over90s} over 90 s** |`);
  L.push(`| peak RSS | p50 ${r.peakRssMb.p50} MB · p90 ${r.peakRssMb.p90} MB · max ${r.peakRssMb.max} MB |`);
  L.push(`| empty envelopes | ${r.totals.emptyEnvelopes} case(s) produced an envelope with zero facts of any kind |`);
  L.push("");

  if (r.prepare) {
    const p = r.prepare;
    L.push(`### \`prepare\` — what the install actually did`);
    L.push("");
    L.push(
      `Read this table BEFORE the tier and contract numbers above. "The contract deltas did not move" and "nothing installed" are the same roll-up with opposite conclusions, and this is the only section that separates them.`,
    );
    L.push("");
    L.push(`| | |`);
    L.push(`|---|---|`);
    L.push(`| node_modules present after prepare | **${p.installed} / ${p.attempted}** |`);
    L.push(`| by outcome | ${kv(p.byOutcome)} |`);
    L.push(`| by package manager | ${kv(p.byPackageManager)} |`);
    L.push(`| prepare wall clock | p50 ${p.wallClockMs.p50} ms · p90 ${p.wallClockMs.p90} ms · max ${p.wallClockMs.max} ms |`);
    L.push("");
    if (p.failures.length) {
      L.push(`Cases where \`prepare\` ran and left no \`node_modules\` — for these the arm measured **nothing**, and their rows below are a bare-tree result wearing an install-arm label:`);
      L.push("");
      L.push(`| instance | install | why |`);
      L.push(`|---|---|---|`);
      for (const f of p.failures) L.push(`| ${f.instanceId} | ${f.install} | ${f.reason.replace(/\|/g, "\\|").slice(0, 300)} |`);
      L.push("");
    }
  }

  L.push(`### Blind spots — a tier label is not coverage`);
  L.push("");
  L.push(`Cases where the tool analysed **under half** the changed files. A tier-1 envelope with \`filesAnalysed ≪ changedFiles\` looks healthy and is nearly blind.`);
  L.push("");
  if (!r.blindSpots.length) {
    L.push(`_none_`);
  } else {
    L.push(`| instance | tier | changed | analysed | ratio |`);
    L.push(`|---|---|---|---|---|`);
    for (const b of r.blindSpots) L.push(`| ${b.instanceId} | ${b.tier} | ${b.changedFiles} | ${b.filesAnalysed} | ${b.ratio} |`);
  }
  L.push("");

  L.push(`### Diff-range divergence — \`base..head\` vs \`base...head\``);
  L.push("");
  L.push(`code-facts diffs the **merge base** (\`git.ts\`, since 2026-08-21); this harness still counts \`changedFiles\` two-dot so this table stays readable. Where a case's stored \`base_commit\` sits behind the merge base the two disagree, and the two-dot column is then the base branch's own history — files the PR never touched. Read \`analysed/changed\` against \`base...head\`; against \`base..head\` it understates coverage on exactly these rows.`);
  L.push("");
  if (!r.diffRangeDivergence.length) {
    L.push(`_none — every case's base is the merge base_`);
  } else {
    L.push(`| instance | base..head | base...head | excess |`);
    L.push(`|---|---|---|---|`);
    for (const d of r.diffRangeDivergence) L.push(`| ${d.instanceId} | ${d.twoDot} | ${d.threeDot} | +${d.excess} |`);
  }
  L.push("");

  L.push(`### Top degraded reasons (normalised)`);
  L.push("");
  L.push(`| n | cases | reason |`);
  L.push(`|---|---|---|`);
  for (const d of r.topDegradedReasons) L.push(`| ${d.count} | ${d.cases} | ${d.reason.replace(/\|/g, "\\|")} |`);
  L.push("");

  L.push(`### By primary language (modal changed-file extension — a heuristic)`);
  L.push("");
  L.push(`| lang | cases | tiers | mean symbols | mean analysed/changed |`);
  L.push(`|---|---|---|---|---|`);
  for (const b of r.byLanguage) L.push(`| ${b.language} | ${b.cases} | ${kv(b.tiers)} | ${b.meanSymbols} | ${b.meanAnalysedRatio} |`);
  L.push("");

  L.push(`### Payload totals across the corpus`);
  L.push("");
  L.push(`| field | total |`);
  L.push(`|---|---|`);
  for (const [k, v] of Object.entries(r.totals)) L.push(`| ${k} | ${v} |`);
  L.push("");

  L.push(`## Per case`);
  L.push("");
  L.push(`| instance | lang | chg | anly | tier | cov | deg | exit | ms | RSS MB | sym | refs (inDiff) | contr (consumers) | const (dup) | deps | patt | cov lines (unc) |`);
  L.push(`|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|`);
  for (const c of cases) {
    const p = c.payloadCounts;
    L.push(
      `| ${c.instanceId} | ${c.primaryLanguage} | ${c.changedFiles} | ${p.facts?.filesAnalysed ?? "–"} | ${c.envelope.tier ?? "–"} | ${c.envelope.coverage ?? "–"} | ${c.envelope.degradedCount} | ${c.run.exitCode ?? "–"}${c.run.signal ? `/${c.run.signal}` : ""} | ${c.run.wallClockMs} | ${c.run.peakRssMb ?? "–"} | ${p.facts?.symbols ?? "–"} | ${p.facts?.referencesTotal ?? "–"} (${p.facts?.referencesInDiffTotal ?? "–"}) | ${p.contracts?.total ?? "–"} (${p.contracts?.consumersOutsideDiff ?? "–"}) | ${p.constants?.total ?? "–"} (${p.constants?.withDuplicates ?? "–"}) | ${p.deps?.changes ?? "–"} | ${p.patterns?.findings ?? "–"} | ${p.coverage?.changedLines ?? "–"} (${p.coverage?.uncovered ?? "–"}) |`,
    );
  }
  L.push("");
  return L.join("\n");
}

function printRollup(report: Report): void {
  const r = report.rollup;
  console.log(`\n── ROLL-UP  (${report.meta.cases} case(s), run ${report.meta.runId}) ──────────────────`);
  console.log(`  byTier        ${kv(r.byTier)}`);
  console.log(`  byCoverage    ${kv(r.byCoverage)}`);
  console.log(`  byExitCode    ${kv(r.byExitCode)}     (0 ok · 2 could-not-run · 3 degraded)`);
  console.log(`  noEnvelope    ${r.noEnvelope.length ? r.noEnvelope.join(", ") : "none"}   ← read this first`);
  console.log(`  wallClockMs   p50 ${r.wallClockMs.p50}  p90 ${r.wallClockMs.p90}  max ${r.wallClockMs.max}   (${r.wallClockMs.over90s} over 90s)`);
  console.log(`  peakRssMb     p50 ${r.peakRssMb.p50}  p90 ${r.peakRssMb.p90}  max ${r.peakRssMb.max}`);
  console.log(`  emptyEnvelopes ${r.totals.emptyEnvelopes}`);
  console.log(`\n  BLIND SPOTS (analysed < half of changed files):`);
  if (!r.blindSpots.length) console.log(`    none`);
  for (const b of r.blindSpots) {
    console.log(`    ${b.instanceId.padEnd(34)} tier ${b.tier}  ${String(b.filesAnalysed).padStart(4)} / ${String(b.changedFiles).padEnd(4)} = ${b.ratio}`);
  }
  console.log(`\n  DIFF-RANGE DIVERGENCE (base..head vs base...head — the tool uses the MERGE BASE; the two-dot column is this harness's denominator only):`);
  if (!r.diffRangeDivergence.length) console.log(`    none`);
  for (const d of r.diffRangeDivergence) {
    console.log(`    ${d.instanceId.padEnd(34)} ${String(d.twoDot).padStart(5)} vs ${String(d.threeDot).padStart(4)}   (+${d.excess} files the PR never touched)`);
  }
  console.log(`\n  TOP DEGRADED REASONS:`);
  for (const d of r.topDegradedReasons) console.log(`    ${String(d.count).padStart(3)}  (${String(d.cases).padStart(2)} case) ${d.reason}`);
  console.log(`\n  BY LANGUAGE (modal changed-file extension — heuristic):`);
  console.log(`    ${"lang".padEnd(14)} cases  tiers                   meanSymbols  meanAnalysed/changed`);
  for (const b of r.byLanguage) {
    console.log(`    ${b.language.padEnd(14)} ${String(b.cases).padStart(5)}  ${kv(b.tiers).padEnd(23)} ${String(b.meanSymbols).padStart(11)}  ${b.meanAnalysedRatio}`);
  }
  console.log("");
}

// ── --compare ────────────────────────────────────────────────────────────────

function loadRun(root: string, runId: string): Report {
  const p = join(root, runId, "report.json");
  if (!existsSync(p)) die(`no report at ${p}`);
  return JSON.parse(readFileSync(p, "utf8")) as Report;
}

function printCompare(older: Report, newer: Report): void {
  console.log(`\n── COMPARE  ${older.meta.runId}  →  ${newer.meta.runId} ────────────────────────`);
  const a = new Map(older.cases.map((c) => [c.instanceId, c]));
  const b = new Map(newer.cases.map((c) => [c.instanceId, c]));

  const gone = [...a.keys()].filter((k) => !b.has(k));
  const fresh = [...b.keys()].filter((k) => !a.has(k));
  if (gone.length) console.log(`  cases only in ${older.meta.runId}: ${gone.join(", ")}`);
  if (fresh.length) console.log(`  cases only in ${newer.meta.runId}: ${fresh.join(", ")}`);
  if (gone.length || fresh.length) console.log(`  (the roll-up diff below spans DIFFERENT case sets — read it with that in mind)`);

  const num = (c: CaseRecord): Record<string, number> => ({
    tier: c.envelope.tier ?? -1,
    exit: c.run.exitCode ?? -1,
    analysed: c.payloadCounts.facts?.filesAnalysed ?? 0,
    symbols: c.payloadCounts.facts?.symbols ?? 0,
    refs: c.payloadCounts.facts?.referencesTotal ?? 0,
    contracts: c.payloadCounts.contracts?.total ?? 0,
    constants: c.payloadCounts.constants?.total ?? 0,
    deps: c.payloadCounts.deps?.changes ?? 0,
    patterns: c.payloadCounts.patterns?.findings ?? 0,
    degraded: c.envelope.degradedCount,
    ms: c.run.wallClockMs,
    rss: c.run.peakRssMb ?? 0,
  });

  console.log(`\n  PER CASE (only rows that moved):`);
  let moved = 0;
  for (const [id, nb] of b) {
    const oa = a.get(id);
    if (!oa) continue;
    const x = num(oa);
    const y = num(nb);
    const deltas = Object.keys(y)
      .filter((k) => y[k] !== x[k])
      // wall clock and RSS jitter run-to-run; only flag a real move.
      .filter((k) => (k === "ms" || k === "rss" ? Math.abs(y[k] - x[k]) > Math.max(50, 0.25 * (x[k] || 1)) : true))
      .map((k) => `${k} ${x[k]}→${y[k]}`);
    if (!deltas.length) continue;
    moved += 1;
    const cov = oa.envelope.coverage !== nb.envelope.coverage ? `  coverage ${oa.envelope.coverage}→${nb.envelope.coverage}` : "";
    console.log(`    ${id.padEnd(34)} ${deltas.join("  ")}${cov}`);
  }
  if (!moved) console.log(`    (nothing moved)`);

  console.log(`\n  ROLL-UP:`);
  const ra = older.rollup;
  const rb = newer.rollup;
  const line = (label: string, x: string, y: string): void => console.log(`    ${label.padEnd(16)} ${x}${x === y ? "   (unchanged)" : `\n    ${"".padEnd(16)} ${y}   ← new`}`);
  line("byTier", kv(ra.byTier), kv(rb.byTier));
  line("byCoverage", kv(ra.byCoverage), kv(rb.byCoverage));
  line("byExitCode", kv(ra.byExitCode), kv(rb.byExitCode));
  line("noEnvelope", ra.noEnvelope.join(",") || "none", rb.noEnvelope.join(",") || "none");
  line("wall p50/p90/max", `${ra.wallClockMs.p50}/${ra.wallClockMs.p90}/${ra.wallClockMs.max} (${ra.wallClockMs.over90s}>90s)`, `${rb.wallClockMs.p50}/${rb.wallClockMs.p90}/${rb.wallClockMs.max} (${rb.wallClockMs.over90s}>90s)`);
  line("rss p50/p90/max", `${ra.peakRssMb.p50}/${ra.peakRssMb.p90}/${ra.peakRssMb.max}`, `${rb.peakRssMb.p50}/${rb.peakRssMb.p90}/${rb.peakRssMb.max}`);
  console.log(`\n    totals:`);
  for (const k of Object.keys(rb.totals)) {
    const x = ra.totals[k] ?? 0;
    const y = rb.totals[k];
    const d = y - x;
    console.log(`      ${k.padEnd(24)} ${String(x).padStart(8)} → ${String(y).padStart(8)}   ${d === 0 ? "=" : d > 0 ? `+${d}` : String(d)}`);
  }
  console.log("");
}

// ── main ─────────────────────────────────────────────────────────────────────

function main(): void {
  if (has("help") || has("h")) {
    console.log(readFileSync(import.meta.filename, "utf8").split("*/")[0]);
    return;
  }

  const outRoot = join(flag("out") ? resolve(flag("out")!) : resultsRoot(), "facts-corpus");

  // Pure offline diff of two stored runs — measures nothing.
  const compareWith = flag("compare");
  const against = flag("against");
  if (compareWith && against) {
    printCompare(loadRun(outRoot, compareWith), loadRun(outRoot, against));
    return;
  }

  const repoRoot = monorepoRoot();
  const factsCli = join(repoRoot, "packages", "code-facts", "dist", "cli.js");
  if (!existsSync(factsCli)) {
    die(
      `the code-facts CLI is not built — ${factsCli} is absent.\n` +
        `  Build it first:  pnpm --filter lastlight-code-facts build`,
    );
  }

  const cache = resolveCache();
  const datasetPath = resolveDataset(cache);
  const timeoutMs = Number(flag("timeout") ?? 300_000);
  const keep = has("keep");
  // WP4's arm. It INSTALLS DEPENDENCIES for every selected case, in a real
  // third-party repository, over the network — gigabytes of `node_modules` and
  // minutes per case, against seconds for the analysis itself. Off by default
  // for that reason, and because the bare tree is production's exact shape.
  const install = has("install");
  const profile = list("only").length ? "only" : (flag("profile") ?? "full");
  if (!["smoke", "full", "only"].includes(profile)) die(`--profile must be smoke or full (got ${profile})`);

  const instances = JSON.parse(readFileSync(datasetPath, "utf8")) as SweBenchInstance[];

  // ── Preflight: mirrors + SHAs, ALL of them, before a single case runs. ──────
  const problems: string[] = [];
  const all: Selected[] = [];
  for (const inst of instances) {
    const s = shas(inst);
    if (!s) {
      problems.push(`${inst.instance_id}: no base/head commit in the instance`);
      continue;
    }
    const mirror = mirrorPath(cache, inst.repo);
    if (!existsSync(mirror)) {
      problems.push(`${inst.instance_id}: no bare mirror at ${mirror} (this script NEVER clones — run the eval prefetch first)`);
      continue;
    }
    if (!hasCommit(mirror, s.base) || !hasCommit(mirror, s.head)) {
      problems.push(`${inst.instance_id}: ${s.base.slice(0, 8)}/${s.head.slice(0, 8)} not present in ${basename(mirror)}`);
      continue;
    }
    all.push({
      inst,
      baseSha: s.base,
      headSha: s.head,
      mirror,
      files: nameOnly(mirror, `${s.base}..${s.head}`),
      mergeBaseFiles: nameOnly(mirror, `${s.base}...${s.head}`).length,
    });
  }
  if (problems.length) {
    console.error(`facts-corpus: ${problems.length} case(s) cannot be measured:`);
    for (const p of problems) console.error(`  - ${p}`);
    if (!all.length) die("nothing left to run");
  }

  // ── Selection ──────────────────────────────────────────────────────────────
  let selected = all;
  const only = list("only");
  if (only.length) {
    const wanted = new Set(only);
    selected = all.filter((s) => wanted.has(s.inst.instance_id));
    const missing = only.filter((id) => !selected.some((s) => s.inst.instance_id === id));
    if (missing.length) die(`--only: unknown instance_id(s): ${missing.join(", ")}`);
  } else if (profile === "smoke") {
    // One case per repo (smallest diff — fastest) + the two largest overall, so
    // the smoke run touches every language AND the two worst-case sizes.
    const perRepo = new Map<string, Selected>();
    for (const s of [...all].sort((a, b) => a.files.length - b.files.length)) {
      if (!perRepo.has(s.inst.repo)) perRepo.set(s.inst.repo, s);
    }
    const picked = new Map([...perRepo.values()].map((s) => [s.inst.instance_id, s]));
    for (const s of [...all].sort((a, b) => b.files.length - a.files.length)) {
      if (picked.size >= perRepo.size + 2) break;
      picked.set(s.inst.instance_id, s);
    }
    selected = all.filter((s) => picked.has(s.inst.instance_id));
  }

  // ── Set up the run dir ─────────────────────────────────────────────────────
  mkdirSync(outRoot, { recursive: true });
  const gitSha = gitShortSha();
  const runId = makeRunId(new Date(), gitSha, outRoot);
  const runDir = join(outRoot, runId);
  const caseDir = join(runDir, "case");
  mkdirSync(caseDir, { recursive: true });
  const wtRoot = mkdtempSync(join(tmpdir(), "facts-corpus-"));

  let factsVersion: string | null = null;
  try {
    factsVersion = (JSON.parse(readFileSync(join(repoRoot, "packages", "code-facts", "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    /* stamped as null */
  }

  console.log(`facts-corpus  run ${runId}`);
  console.log(`  dataset  ${datasetPath}`);
  console.log(`  mirrors  ${join(cache, "repos")}`);
  console.log(`  cli      ${factsCli} (lastlight-code-facts ${factsVersion ?? "?"})`);
  console.log(`  profile  ${profile} — ${selected.length} case(s), concurrency 1, timeout ${timeoutMs} ms, no --never-fail`);
  console.log(`  out      ${runDir}`);
  if (install) {
    console.log(
      `  --install: WP4's arm — \`prepare\` runs in each worktree first. This DOWNLOADS AND WRITES\n` +
        `             node_modules into ${selected.length} real third-party checkout(s); expect minutes and\n` +
        `             gigabytes. Lifecycle scripts stay OFF (the CLI's default).`,
    );
  }
  if (!timeSupported) console.log(`  ⚠ no ${TIME_BIN} on ${process.platform} — peakRssMb will be null`);
  console.log("");

  const cases: CaseRecord[] = [];
  let n = 0;
  for (const sel of selected) {
    n += 1;
    process.stdout.write(`  [${String(n).padStart(2)}/${selected.length}] ${sel.inst.instance_id.padEnd(34)} `);
    const rec = runOne(sel, { factsCli, caseDir, wtRoot, timeoutMs, keep, install });
    cases.push(rec);
    const bad = !rec.run.envelopeWritten ? "  ✗ NO ENVELOPE" : "";
    console.log(
      `tier ${rec.envelope.tier ?? "–"}  ${(rec.envelope.coverage ?? "–").padEnd(8)} exit ${rec.run.exitCode}  ` +
        `${String(rec.run.wallClockMs).padStart(6)} ms  ${String(rec.run.peakRssMb ?? "–").padStart(6)} MB  ` +
        `${String(rec.payloadCounts.facts?.filesAnalysed ?? 0).padStart(3)}/${String(rec.changedFiles).padEnd(4)} files  ` +
        `${rec.envelope.degradedCount} deg${bad}`,
    );
  }

  const report: Report = {
    meta: {
      runId,
      generatedAt: new Date().toISOString(),
      gitSha,
      profile,
      dataset: datasetPath,
      cache,
      factsCli,
      factsVersion,
      platform: `${process.platform}-${process.arch}`,
      node: process.version,
      timeoutMs,
      concurrency: 1,
      neverFail: false,
      install,
      cases: cases.length,
    },
    rollup: rollup(cases),
    cases,
  };

  writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(runDir, "report.md"), renderMarkdown(report) + "\n");
  printRollup(report);
  console.log(`  report.json / report.md / case/*.json  →  ${runDir}`);
  if (keep) console.log(`  --keep: worktrees left at ${wtRoot} (remove them with \`git -C <mirror> worktree prune\` after)`);
  else rmSync(wtRoot, { recursive: true, force: true });

  if (compareWith) printCompare(loadRun(outRoot, compareWith), report);
}

main();
