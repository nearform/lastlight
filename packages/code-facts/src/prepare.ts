/**
 * `prepare` — the probe affordance.
 *
 * WP4 (`docs/plans/review-evidence-pipeline/04-probe-oracle.md`). It installs
 * dependencies if they are absent, optionally typechecks, optionally produces a
 * coverage artifact, and writes `.lastlight/pr-review/probes/env.json` so every
 * downstream phase reads a FACT instead of grepping stdout.
 *
 * ── What it is NOT ───────────────────────────────────────────────────────────
 *
 * **It is not a second CI**, and an earlier draft of the design was wrong about
 * this. `checksState` / `ciSection` are already projected into the run context
 * and consumed by `skills/pr-review/SKILL.md`; re-deriving red/green here would
 * duplicate a matrix build we cannot match, on one machine (locked decision 11).
 * What execution buys is a **probe**, and a probe needs an install, not a test
 * run. `--coverage` is the one exception and it is opt-in for exactly that
 * reason — see below.
 *
 * ── Why it is a subcommand of this CLI ───────────────────────────────────────
 *
 * WP4's YAML sketch spelled `/opt/lastlight/code-facts/bin/prepare-tree.sh`,
 * a path **nothing installs**. Living here instead means it resolves through the
 * order §D1 already defines — `LASTLIGHT_FACTS_BIN` → `PATH` →
 * `/opt/lastlight/bin/` — which is the only order that reaches the eval host,
 * where the harness runs `--sandbox none` and can never see `/opt/lastlight/`.
 * It also makes the branching testable against real repos rather than a shell
 * script nobody can call.
 *
 * ── The three things this phase changes elsewhere, all measured ──────────────
 *
 * 1. **It makes `contracts` live on a normal monorepo.** A `tsconfig` that
 *    `extends` a bare package specifier (`@calcom/tsconfig/react-library.json`)
 *    does not resolve on a bare checkout; tsgo reports a config parsing error
 *    and EXCLUDES the project, so the case drops to tier 2 and `contracts`
 *    emits nothing. Measured across the 50-PR corpus: tier-1 cases 21 → 5,
 *    contract deltas 73 → 19, one cause, all 16 demoted cases
 *    ([03](../../../docs/plans/review-evidence-pipeline/03-seed-and-survey.md)).
 * 2. **It is what makes the `tests` family measurable at all.** The `coverage`
 *    extractor READS a report and never runs a suite; across all 50 corpus
 *    cases and all 8 gate cases it found **zero artifacts**. Until this phase
 *    produces one, `tests` is `notMeasured` — which is a different row from
 *    "did not convert" (§D2, §D13).
 * 3. **It changes another phase's memory profile.** `facts` inherits whatever
 *    tree this leaves behind, on every re-review too, because the cross-run
 *    refresh is deliberately `git clean -fdx -e node_modules`. Peak RSS for the
 *    tsgo engine on an INSTALLED tree is **unmeasured** — the compiler is a
 *    child process, so every `rss()` figure in that plan is ts-morph's. Do not
 *    carry the old numbers across this line.
 *
 * ── Lifecycle scripts are OFF by default ─────────────────────────────────────
 *
 * The plan priced this phase in time, money and disk. It did not price the
 * fourth thing: an install runs `postinstall` from a **pull request head**,
 * which is arbitrary code the PR author wrote, executing on the operator's
 * infrastructure. The review workspace has never installed anything, so this is
 * the first thing in `pr-review` that could. Neither of the two reasons above
 * needs the scripts — an `extends` resolves off files on disk — so they are
 * disabled unless a caller asks, and the answer is recorded in `env.json`.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_REPORT_CANDIDATES } from "./coverage.js";
import { repoSlug } from "./git.js";
import { noopLogger, type LoggerPort } from "./log.js";
import { ProbeEnvSchema, type DegradedEntry, type ProbeEnv } from "./schema.js";

/** How many `tsc` diagnostics reach `env.json` before the list is truncated. */
export const MAX_TYPECHECK_DIAGNOSTICS = 100;

export type PackageManagerId = "pnpm" | "npm" | "yarn" | "bun";

export interface ExecResult {
  status: number | null;
  stdout: string;
  stderr: string;
  /** The step hit its own ceiling. Distinct from a non-zero exit. */
  timedOut: boolean;
  /** The process could not be started at all (no such binary). */
  spawnError?: string;
}

/**
 * The one seam in this module.
 *
 * Package-manager detection, the fallback ladder, the loudness rules and the
 * `env.json` contract are all OURS and are tested against real repos. What npm
 * does when a lockfile is out of sync is not, and a unit test that shells out to
 * a registry is a test of the network. So the runner is injectable, and the
 * default is the real thing.
 */
export type ExecFn = (
  command: string,
  args: string[],
  opts: { cwd: string; timeoutMs: number; env?: NodeJS.ProcessEnv },
) => ExecResult;

export const realExec: ExecFn = (command, args, opts) => {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    timeout: opts.timeoutMs,
    encoding: "utf8",
    env: opts.env ?? process.env,
    maxBuffer: 32 * 1024 * 1024,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    // `spawnSync` reports a timeout as SIGTERM, which is otherwise
    // indistinguishable from an operator killing the phase.
    timedOut: result.signal === "SIGTERM" || result.error?.name === "ETIMEDOUT",
    spawnError: result.error && result.error.name !== "ETIMEDOUT" ? result.error.message : undefined,
  };
};

interface PackageManagerSpec {
  id: PackageManagerId;
  lockfiles: string[];
  /** The reproducible install — refuses when the lockfile is out of sync. */
  strict: string[];
  /** The fallback, taken (and RECORDED) when `strict` refuses. */
  loose: string[];
  /** Flag form of "do not run this package's own scripts", when there is one. */
  ignoreScripts: string[];
}

/**
 * Ordered by lockfile specificity, not popularity: a repo carrying both a
 * `pnpm-lock.yaml` and a stale `package-lock.json` is pnpm's.
 *
 * `strict` before `loose` on purpose. `npm ci` / `pnpm --frozen-lockfile` are
 * the reproducible spellings and they REFUSE when `package.json` and the
 * lockfile disagree — which is a real and common state on a PR that edits
 * dependencies, i.e. exactly the PRs `deps` cares most about. So the refusal is
 * caught and downgraded rather than treated as a failed install, and the
 * downgrade lands in `degraded[]`: an install that silently resolved different
 * versions than the lockfile pinned is a different tree from the one CI tested.
 *
 * **Every `loose` entry names its escape hatch EXPLICITLY, and that was
 * measured.** The first version spelled yarn's fallback as a bare
 * `yarn install`, on the assumption that immutability is something you opt into.
 * It is not: yarn Berry and pnpm both read `CI` — which `envFor` sets, to stop
 * an interactive prompt hanging the phase — and turn immutable installs **on**.
 * So the fallback re-ran the identical command, failed identically
 * (`YN0028: The lockfile would have been modified by this install, which is
 * explicitly forbidden`), and reported `install: "failed"` on a tree that would
 * have installed fine. A fallback that is bit-identical to the thing it falls
 * back from is not a fallback; it is a second copy of the failure.
 */
export const PACKAGE_MANAGERS: PackageManagerSpec[] = [
  {
    id: "pnpm",
    lockfiles: ["pnpm-lock.yaml"],
    strict: ["install", "--frozen-lockfile"],
    loose: ["install", "--no-frozen-lockfile"],
    ignoreScripts: ["--ignore-scripts"],
  },
  {
    id: "yarn",
    lockfiles: ["yarn.lock"],
    strict: ["install", "--immutable"],
    // `--no-immutable`, not a bare `install` — see the note above. Yarn 1
    // ignores the flag (it has no immutable mode to turn off), which is the
    // behaviour we want on that side too.
    loose: ["install", "--no-immutable"],
    // Yarn 1 takes `--ignore-scripts`; Berry does not (it is `enableScripts`
    // config). `envFor` sets `YARN_ENABLE_SCRIPTS=false`, which covers both.
    ignoreScripts: [],
  },
  {
    id: "bun",
    lockfiles: ["bun.lockb", "bun.lock"],
    strict: ["install", "--frozen-lockfile"],
    // Bun reads `CI` the same way, so the same shape is LIKELY here — but it is
    // unmeasured (no corpus repo uses bun), and a flag this package has never
    // run is not better than a flag it has. Left as the plain form deliberately;
    // if a bun repo ever reports `failed` with a frozen-lockfile message, this
    // is the line.
    loose: ["install"],
    ignoreScripts: ["--ignore-scripts"],
  },
  {
    id: "npm",
    lockfiles: ["package-lock.json", "npm-shrinkwrap.json"],
    strict: ["ci"],
    loose: ["install"],
    ignoreScripts: ["--ignore-scripts"],
  },
];

/**
 * Which package manager this tree wants, in corepack's own order of authority.
 *
 * `package.json`'s `packageManager` field first, because it is the only one the
 * repo STATED; then the lockfile; then npm for a package.json with neither,
 * which is what `npm install` would do anyway. `null` means there is no npm
 * project at the root — the right answer for a Java or Go PR, and not a
 * failure. Everything non-npm is out of scope by locked decision 14
 * (TypeScript-first), and `prepare` says so in `degraded[]` rather than
 * pretending it looked.
 */
export function detectPackageManager(repo: string): PackageManagerId | null {
  if (!existsSync(join(repo, "package.json"))) return null;

  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      packageManager?: unknown;
    };
    if (typeof pkg.packageManager === "string") {
      const declared = pkg.packageManager.split("@")[0].trim();
      const known = PACKAGE_MANAGERS.find((candidate) => candidate.id === declared);
      if (known) return known.id;
    }
  } catch {
    // An unparseable package.json is not this function's problem to report —
    // the install below will fail loudly and land in `degraded[]` with the
    // package manager's own message, which is more useful than ours.
  }

  for (const candidate of PACKAGE_MANAGERS) {
    if (candidate.lockfiles.some((lock) => existsSync(join(repo, lock)))) return candidate.id;
  }
  return "npm";
}

/**
 * The install's environment.
 *
 * `npm_config_ignore_scripts` and `YARN_ENABLE_SCRIPTS` cover the two managers
 * whose flag form is missing or version-dependent, so the guarantee does not
 * rest on which yarn a repo pinned. `CI=1` stops interactive prompts from
 * hanging a phase to its timeout.
 *
 * **`COREPACK_ENABLE_DOWNLOAD_PROMPT=0` was measured, not anticipated.** The
 * first corpus case this ran against — `cal-com-10600`, a yarn 3.4.1 monorepo —
 * failed both the strict and the loose install with
 * *"! Corepack is about to download https://repo.yarnpkg.com/3.4.1/…"*. That is
 * Corepack's **confirmation prompt**, and `CI=1` does not silence it: a repo
 * that pins its package manager through the `packageManager` field (which is
 * most of them, and every one where `prepare` matters most, since that field is
 * also what `detectPackageManager` reads first) needs a manager Corepack must
 * fetch before it can install anything. Without this the phase reports
 * `install: "failed"` on exactly the monorepos it exists for — honestly, but
 * uselessly.
 */
export function envFor(lifecycleScripts: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    CI: "1",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  if (!lifecycleScripts) {
    env.npm_config_ignore_scripts = "true";
    env.YARN_ENABLE_SCRIPTS = "false";
  }
  return env;
}

export interface PrepareOptions {
  repo: string;
  /** Install dependencies when `node_modules` is absent. */
  install?: boolean;
  /** Let the tree's own `postinstall` etc. run. Off by default — see the header. */
  lifecycleScripts?: boolean;
  /** Run the repo's `tsc --noEmit` for per-line diagnostics. */
  typecheck?: boolean;
  /** Run a coverage command so the `tests` family has an input. */
  coverage?: boolean;
  /** Explicit coverage command, run through `sh -c`. Beats script detection. */
  coverageCommand?: string;
  installTimeoutMs?: number;
  typecheckTimeoutMs?: number;
  coverageTimeoutMs?: number;
  exec?: ExecFn;
  log?: LoggerPort;
}

const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
const DEFAULT_TYPECHECK_TIMEOUT_MS = 300_000;
const DEFAULT_COVERAGE_TIMEOUT_MS = 900_000;

/** The last few lines of a failure, for a `degraded[]` reason a human can act on. */
function tail(text: string, lines = 8): string {
  const kept = text.trimEnd().split("\n").filter(Boolean).slice(-lines);
  return kept.join(" · ").slice(0, 800);
}

function why(result: ExecResult): string {
  if (result.spawnError) return `could not be started: ${result.spawnError}`;
  if (result.timedOut) return "timed out";
  return `exited ${result.status ?? "with no status"}: ${tail(result.stderr) || tail(result.stdout) || "no output"}`;
}

/**
 * Prepare the tree. **Never throws**, and that is the §D12 contract rather than
 * defensive style: `cron-review.yaml` re-dispatches every thirty minutes and
 * `assessedHeadShaByWorkflow` is populated from SUCCEEDED runs only, so a phase
 * that fails hard is retried forever at the operator's expense. Every failure
 * here is a recorded fact plus a `degraded[]` entry, and the run continues with
 * `installed: false`.
 */
export function prepareTree(options: PrepareOptions): ProbeEnv {
  const log = options.log ?? noopLogger;
  const exec = options.exec ?? realExec;
  const repo = options.repo;
  const lifecycleScripts = options.lifecycleScripts === true;
  const degraded: DegradedEntry[] = [];
  const started = Date.now();
  const durations = { install: 0, typecheck: 0, coverage: 0 };

  const packageManager = detectPackageManager(repo);
  const nodeModules = () => existsSync(join(repo, "node_modules"));

  // ── install ────────────────────────────────────────────────────────────────
  let install: ProbeEnv["install"] = "skipped";
  if (options.install === false || options.install === undefined) {
    install = "skipped";
  } else if (packageManager === null) {
    install = "no-project";
    degraded.push({
      extractor: "prepare",
      reason:
        "no package.json at the repo root, so no dependencies were installed — a tsconfig that `extends` a bare package specifier will NOT resolve and `contracts` may emit nothing. Non-npm ecosystems are out of scope (locked decision 14, TypeScript-first)",
    });
  } else if (nodeModules()) {
    // The common case on a re-review: `pr-review` is in
    // PER_TARGET_REUSE_WORKFLOWS and the cross-run refresh is deliberately
    // `git clean -fdx -e node_modules`, so dependencies survive.
    install = "already-present";
  } else {
    const spec = PACKAGE_MANAGERS.find((candidate) => candidate.id === packageManager)!;
    const scriptFlags = lifecycleScripts ? [] : spec.ignoreScripts;
    const env = envFor(lifecycleScripts);
    const timeoutMs = options.installTimeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
    const at = Date.now();

    log.info("prepare: installing", { packageManager, lifecycleScripts });
    let result = exec(spec.id, [...spec.strict, ...scriptFlags], { cwd: repo, timeoutMs, env });
    if (result.status !== 0 && !result.timedOut && !result.spawnError) {
      // The lockfile is out of sync with package.json — routine on a PR that
      // edits dependencies. Fall back, and SAY SO: the resolved tree is no
      // longer the one the lockfile pins, so a version-sensitive reading of
      // anything downstream is on a different tree than CI tested.
      degraded.push({
        extractor: "prepare",
        reason: `\`${spec.id} ${spec.strict.join(" ")}\` refused (${why(result)}), so the install fell back to \`${spec.id} ${spec.loose.join(" ")}\` — the resolved dependency versions are NOT the lockfile's, and may not be the ones CI tested`,
      });
      result = exec(spec.id, [...spec.loose, ...scriptFlags], { cwd: repo, timeoutMs, env });
    }
    durations.install = Date.now() - at;

    if (result.status === 0) {
      install = "installed";
    } else {
      install = "failed";
      degraded.push({
        extractor: "prepare",
        reason: `\`${spec.id} install\` ${why(result)} — dependencies are absent or partial, so a package-extending tsconfig will not resolve and "open the library source" remains structurally impossible. NOTHING downstream may read a thin result as "nothing to find"`,
      });
    }
  }

  // Asked at the END and from the filesystem, never inferred from the exit
  // code: a failed install can still leave a partially-populated tree, and
  // `already-present` and `installed` are the same answer to the only question
  // a downstream phase actually has.
  const installed = nodeModules();

  // ── typecheck ──────────────────────────────────────────────────────────────
  let typecheck: ProbeEnv["typecheck"] = "skipped";
  const typecheckDiagnostics: ProbeEnv["typecheckDiagnostics"] = [];
  if (options.typecheck === true) {
    const tsc = join(repo, "node_modules", "typescript", "bin", "tsc");
    const hasConfig = existsSync(join(repo, "tsconfig.json"));
    if (!existsSync(tsc) || !hasConfig) {
      // `unavailable`, never `clean`. "We could not look" and "we looked and it
      // is fine" are the same empty diagnostic list and opposite conclusions.
      typecheck = "unavailable";
      degraded.push({
        extractor: "prepare",
        reason: !hasConfig
          ? "no tsconfig.json at the repo root, so no local typecheck was run — this is NOT a clean typecheck"
          : "typescript is not installed in the tree, so no local typecheck was run — this is NOT a clean typecheck",
      });
    } else {
      const at = Date.now();
      // The REPO's typescript, deliberately — the opposite of the rule that
      // governs the fact engine. `src/tsgo.ts` must never resolve a compiler
      // out of the code it is auditing, because it is producing a document
      // about that code; here the question IS "what does this repo's own
      // toolchain say about this repo", which is what CI answers and what a
      // hypothesis wants to be attached to.
      const result = exec(process.execPath, [tsc, "--noEmit", "--pretty", "false"], {
        cwd: repo,
        timeoutMs: options.typecheckTimeoutMs ?? DEFAULT_TYPECHECK_TIMEOUT_MS,
        env: envFor(lifecycleScripts),
      });
      durations.typecheck = Date.now() - at;

      if (result.timedOut || result.spawnError) {
        typecheck = "failed";
        degraded.push({ extractor: "prepare", reason: `the local typecheck ${why(result)}` });
      } else {
        const all = parseTscDiagnostics(result.stdout + result.stderr);
        typecheckDiagnostics.push(...all.slice(0, MAX_TYPECHECK_DIAGNOSTICS));
        typecheck = all.length > 0 ? "errors" : "clean";
        if (all.length > MAX_TYPECHECK_DIAGNOSTICS) {
          degraded.push({
            extractor: "prepare",
            reason: `the local typecheck produced ${all.length} diagnostics and only the first ${MAX_TYPECHECK_DIAGNOSTICS} are recorded`,
          });
        }
        // A repo whose HEAD does not typecheck is a fact about the PR, not a
        // failure of this phase — and CI already said so. It is recorded, not
        // degraded.
      }
    }
  }

  // ── coverage ───────────────────────────────────────────────────────────────
  //
  // The one step here that runs the repo's test suite, and therefore the one
  // that re-introduces the wall-clock item §D13 deleted with `suite`. It is
  // opt-in for that reason, and it buys exactly one thing: an input for the
  // `tests` obligation family, which has never had one.
  let coverage: ProbeEnv["coverage"] = "skipped";
  let coverageReport: string | null = null;
  if (options.coverage === true) {
    const command = resolveCoverageCommand(repo, options.coverageCommand, packageManager);
    if (!command) {
      coverage = "unavailable";
      degraded.push({
        extractor: "prepare",
        reason:
          "no coverage command could be resolved (no --coverage-cmd, and no `coverage` / `test:coverage` script in package.json), so the `tests` family was NOT MEASURED — an empty uncovered-line list would read as \"well tested\"",
      });
    } else {
      const at = Date.now();
      const result = exec("sh", ["-c", command], {
        cwd: repo,
        timeoutMs: options.coverageTimeoutMs ?? DEFAULT_COVERAGE_TIMEOUT_MS,
        env: envFor(lifecycleScripts),
      });
      durations.coverage = Date.now() - at;

      // A RED suite is still valid coverage data — that is the whole reason
      // `coverage` replaced `mutants`, which needed a green baseline to mutate
      // against. So the artifact is looked for regardless of the exit code.
      coverageReport = DEFAULT_REPORT_CANDIDATES.find((candidate) => existsSync(join(repo, candidate))) ?? null;
      if (coverageReport) {
        coverage = "produced";
      } else if (result.timedOut || result.spawnError) {
        coverage = "failed";
        degraded.push({ extractor: "prepare", reason: `the coverage command \`${command}\` ${why(result)}` });
      } else {
        coverage = "absent";
        degraded.push({
          extractor: "prepare",
          reason: `\`${command}\` ran but produced no report in any format the coverage extractor reads (${DEFAULT_REPORT_CANDIDATES.join(", ")}), so the \`tests\` family was NOT MEASURED`,
        });
      }
    }
  }

  const env: ProbeEnv = {
    version: 1,
    generatedAt: new Date().toISOString(),
    repo: repoSlug(repo),
    packageManager,
    install,
    installed,
    lifecycleScripts,
    typecheck,
    typecheckDiagnostics,
    coverage,
    coverageReport,
    durationMs: { ...durations, total: Date.now() - started },
    degraded,
  };

  // Validated before it is handed back, like every other document this package
  // emits: a malformed env.json in front of a phase is worse than none.
  return ProbeEnvSchema.parse(env);
}

/**
 * `tsc --pretty false` diagnostics: `path(line,col): error TS2345: message`.
 *
 * Only `error` rows — a `warning` or the trailing "Found N errors" summary line
 * is not something a hypothesis can be anchored to.
 */
export function parseTscDiagnostics(output: string): ProbeEnv["typecheckDiagnostics"] {
  const out: ProbeEnv["typecheckDiagnostics"] = [];
  const line = /^(.+?)\((\d+),\d+\):\s+error\s+(TS\d+):\s+(.*)$/;
  for (const text of output.split("\n")) {
    const match = line.exec(text.trim());
    if (!match) continue;
    out.push({
      file: match[1].split("\\").join("/"),
      line: Number(match[2]),
      code: match[3],
      message: match[4].trim(),
    });
  }
  return out;
}

/**
 * The command that produces a coverage report, or `null`.
 *
 * Deliberately shallow: an explicit `--coverage-cmd`, else a package.json script
 * the repo itself named `coverage` or `test:coverage`. Guessing
 * (`npm test -- --coverage`) would run the whole suite on a repo that never
 * asked, produce nothing, and cost fifteen minutes — and `absent` and
 * `unavailable` would then be indistinguishable.
 */
export function resolveCoverageCommand(
  repo: string,
  explicit: string | undefined,
  packageManager: PackageManagerId | null,
): string | null {
  if (explicit) return explicit;
  if (packageManager === null) return null;
  try {
    const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    for (const name of ["coverage", "test:coverage"]) {
      if (typeof pkg.scripts?.[name] === "string") return `${packageManager} run ${name}`;
    }
  } catch {
    return null;
  }
  return null;
}
