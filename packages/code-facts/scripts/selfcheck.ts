#!/usr/bin/env -S npx tsx
/**
 * Run `all` against THIS repo and print what it actually said.
 *
 * The unit suite asserts what the extractors say about fixtures WE wrote. That
 * is exactly the oracle that stayed green while `contracts`, on a real commit of
 * this monorepo, reported **227 deltas of which one was real** — 65 of them
 * "removed export `foo`" for a symbol still sitting at head. A fixture cannot
 * catch that, because a fixture is small enough that every phantom is visible in
 * a diff you already read.
 *
 * So this is the other end of the telescope: a real commit, a real tsconfig
 * layout, real `node_modules`, and a census you READ. Its three exit conditions
 * are the ones that were silently violated before, not a snapshot:
 *
 *   1. a `removed` delta while the diff contains no deletion and no rename —
 *      the phantom-removal shape, and the only one IRIS measured as ACTIVELY
 *      HARMFUL (−3, worse than seeding nothing at all);
 *   2. more than 40 contract deltas — WP1's landed number on a real commit was
 *      19, so 40 is a DOUBLING before anyone is disturbed, not a pin;
 *   3. more than 90 seconds of wall clock (WP1 AC6).
 *
 * NOT wired into CI, deliberately: `actions/checkout` defaults to
 * `fetch-depth: 1`, so `HEAD~1` does not exist on a runner and this would fail
 * for a reason that has nothing to do with the code. Run it by hand, or before
 * you change an extractor.
 *
 * `src/selfcheck.ts` is the complementary piece and a different thing: pure
 * invariants answerable from git alone, meant to run inside the phase.
 *
 * Usage:
 *   npx tsx scripts/selfcheck.ts [--repo <dir>] [--base <ref>] [--head <ref>]
 *                               [--tsconfig <file>] [--resolution <tier>] [--json]
 */
import { relative, resolve } from "node:path";
import { runExtractor } from "../src/run.js";
import {
  isResolutionTier,
  DEFAULT_RESOLUTION_TIER,
  RESOLUTION_TIERS,
  type ResolutionTier,
} from "../src/resolution.js";
import { changedPaths } from "../src/git.js";
import { noopLogger } from "../src/log.js";
import type { AllDocument, ContractDelta } from "../src/schema.js";

/**
 * WP1 landed 19 on a real commit. A doubling is the alarm; 19 is not a target.
 *
 * It counts the deltas that COULD be phantom, which is not the same as all of
 * them — see `couldBePhantom`. The bound was calibrated when the loader
 * compiled one tsconfig for the whole diff and therefore analysed 1 of this
 * repo's 31 changed source files; one program per tsconfig analyses 30 of 31,
 * and the raw count went to 220 without a single one of them being wrong. A
 * ceiling that a coverage FIX trips is a ceiling measuring the wrong thing.
 */
const MAX_CONTRACTS = 40;
/** WP1 AC6. */
const MAX_WALL_CLOCK_MS = 90_000;
const TOP_N = 20;

interface Args {
  repo: string;
  base: string;
  head: string;
  tsConfigPath?: string;
  resolution: ResolutionTier;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") {
      json = true;
      continue;
    }
    if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[++i]);
    }
  }
  return {
    repo: resolve(flags.get("repo") ?? process.cwd()),
    // `HEAD~1` and not `main`: the question this answers is "what does the
    // analyser say about the commit I just made". Note that `--base main` would
    // NOT drag in everyone else's churn — every diff resolves to the merge base
    // now (`git.mergeBase`), so it would answer "the whole branch" rather than
    // "the last commit". Both are useful; this is the one you want by default.
    base: flags.get("base") ?? "HEAD~1",
    head: flags.get("head") ?? "HEAD",
    // An ESCAPE HATCH, and no longer the routine workaround: the loader opens
    // one program per tsconfig the diff touches, so this monorepo's diff is
    // covered without help. Passing the flag FORCES a single program — which is
    // exactly what the loader used to do, and what took the "analysed" line
    // below from 30 of 31 down to 1 of 31 — and disables the glob fallback with
    // it.
    tsConfigPath: flags.get("tsconfig") ? resolve(flags.get("tsconfig")!) : undefined,
    // PROTOTYPE. Defaults to `full`, so the census a human reads by habit is
    // still the census of what production does. Pass a tier to measure the
    // trade — the peak-RSS line below is the number the sandbox cap cares
    // about, and the `contracts` count is what it costs.
    resolution: resolutionOf(flags.get("resolution")),
    json,
  };
}

function resolutionOf(raw: string | undefined): ResolutionTier {
  if (raw === undefined) return DEFAULT_RESOLUTION_TIER;
  if (!isResolutionTier(raw)) {
    // A typo must not read as the default — the whole point of running this is
    // to see a number change.
    throw new Error(`--resolution must be one of: ${RESOLUTION_TIERS.join(", ")} (got "${raw}")`);
  }
  return raw;
}

function tally<T>(items: T[], key: (item: T) => string): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]);
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  // NOT `runWrapped`: a self-check wants the throw. The §D12 wrapper exists so a
  // phase does not fail the RUN, and swallowing the failure here would print a
  // clean-looking census of an analysis that never happened.
  // WHICH TSCONFIGS got picked, and how much of the diff they covered between
  // them, is the single most useful line in the census: it is what decides which
  // files are in a program at ALL. It is now a list, because a monorepo diff is
  // covered by one program per package and by no single one of them.
  let programs: { tsConfigPaths: string[]; analysed: number; missing: number } | null = null;
  const result = runExtractor({
    extractor: "all",
    repo: args.repo,
    base: args.base,
    head: args.head,
    tsConfigPath: args.tsConfigPath,
    resolution: args.resolution,
    log: {
      ...noopLogger,
      debug(message: string, fields?: Record<string, unknown>) {
        // The HEAD projects load first, so the first line is the one that says
        // what the analysis actually ran against.
        if (message === "code-facts project loaded" && programs === null) {
          programs = {
            tsConfigPaths: (fields?.tsConfigPaths as string[] | undefined) ?? [],
            analysed: (fields?.changedAnalysed as number | undefined) ?? 0,
            missing: (fields?.changedNotInProject as number | undefined) ?? 0,
          };
        }
      },
    },
  });
  const elapsedMs = Date.now() - started;
  const document = result.document as unknown as AllDocument;

  const contracts: ContractDelta[] = document.extractors.contracts?.contracts ?? [];
  const changed = changedPaths(args.repo, document.baseSha, document.headSha);
  const removed = contracts.filter((c) => c.change === "removed");
  const destructive = changed.filter((c) => c.status === "deleted" || c.status === "renamed");

  /**
   * The deltas a phantom could hide in.
   *
   * An `added` export in a file the diff `added` is trivially true — there is no
   * base declaration for it to be wrong about — and a commit that adds a whole
   * package produces hundreds of them (this one: 220, every one correct). The
   * shapes that were actually wrong when this guard was written are `removed`
   * and `changed`, plus an `added` on a file that already existed, which is the
   * "the head program has a symbol the base program's copy of the same file
   * does not" reading. So the ceiling is charged against those, and the raw
   * count stays in the census where a human can see it.
   */
  const addedFiles = new Set(changed.filter((c) => c.status === "added").map((c) => c.path));
  const couldBePhantom = contracts.filter(
    (delta) => delta.change !== "added" || !addedFiles.has(delta.file),
  );

  const violations: string[] = [];
  if (removed.length > 0 && destructive.length === 0) {
    violations.push(
      `${removed.length} REMOVED delta(s) on a diff with no deletion and no rename — these cannot be true: ${removed
        .slice(0, 10)
        .map((c) => `${c.file}#${c.symbol}`)
        .join(", ")}`,
    );
  }
  if (couldBePhantom.length > MAX_CONTRACTS) {
    violations.push(
      `${couldBePhantom.length} contract deltas that are not an added export in an added file, above the ${MAX_CONTRACTS} ceiling (WP1 landed 19 on a real commit) — read the census above and find the systematic one: ${couldBePhantom
        .slice(0, 10)
        .map((c) => `${c.change} ${c.file}#${c.symbol}`)
        .join(", ")}`,
    );
  }
  if (elapsedMs > MAX_WALL_CLOCK_MS) {
    violations.push(
      `${(elapsedMs / 1000).toFixed(1)}s wall clock, above the ${MAX_WALL_CLOCK_MS / 1000}s budget (WP1 AC6)`,
    );
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        {
          repo: relative(process.cwd(), args.repo) || ".",
          baseSha: document.baseSha,
          headSha: document.headSha,
          tier: document.tier,
          coverage: document.coverage,
          elapsedMs,
          changedPaths: changed.length,
          programs,
          contracts: contracts.length,
          couldBePhantom: couldBePhantom.length,
          byChange: Object.fromEntries(tally(contracts, (c) => c.change)),
          degraded: document.degraded,
          violations,
        },
        null,
        2,
      ),
    );
    return violations.length > 0 ? 1 : 0;
  }

  const line = "─".repeat(78);
  console.log(line);
  console.log(
    `code-facts selfcheck — ${relative(process.cwd(), args.repo) || "."}  ${document.baseSha.slice(0, 8)}..${document.headSha.slice(0, 8)}`,
  );
  console.log(
    `tier ${document.tier}   coverage ${document.coverage}   exit ${result.exitCode}   ${(elapsedMs / 1000).toFixed(1)}s   ${changed.length} changed path(s)`,
  );
  /**
   * THE COVERAGE LINE, and the reason it is second from the top: a tier-1
   * envelope over one file of forty reads far better than it deserves to, and
   * this is the number that says which it was. Measured on this repo's own WP1
   * commit: 1 of 31 before one program per tsconfig, 30 of 31 after.
   */
  const analysable = programs
    ? (programs as { analysed: number; missing: number }).analysed +
      (programs as { analysed: number; missing: number }).missing
    : 0;
  console.log(
    `analysed: ${programs ? (programs as { analysed: number }).analysed : 0} of ${analysable} analysable changed file(s), across ${
      programs ? (programs as { tsConfigPaths: string[] }).tsConfigPaths.length : 0
    } program(s)`,
  );
  for (const path of programs ? (programs as { tsConfigPaths: string[] }).tsConfigPaths : []) {
    console.log(`  ${path.startsWith("/") ? relative(args.repo, path) : path}`);
  }
  console.log(line);

  console.log(`\ncontracts: ${contracts.length} delta(s), ${couldBePhantom.length} of them able to be phantom`);
  for (const [change, count] of tally(contracts, (c) => c.change)) {
    console.log(`  ${change.padEnd(9)} ${count}`);
  }
  console.log(
    `  ${"(diff)".padEnd(9)} ${destructive.length} deletion/rename(s) in the diff — a removed delta needs one of these to be true`,
  );

  const byFile = tally(contracts, (c) => c.file);
  if (byFile.length > 0) {
    console.log(`\ntop files by delta count`);
    for (const [file, count] of byFile.slice(0, 10)) console.log(`  ${String(count).padStart(3)}  ${file}`);
  }

  /**
   * The most productive field in the whole document: a symbol whose shape moved
   * and whose consumers are mostly OUTSIDE the diff is the cross-file contract
   * bug, invisible because each file reads correctly on its own.
   */
  const ranked = [...contracts].sort(
    (a, b) => b.consumersOutsideDiff.length - a.consumersOutsideDiff.length,
  );
  console.log(`\ntop ${TOP_N} by consumersOutsideDiff`);
  if (ranked.length === 0) console.log("  (none)");
  for (const delta of ranked.slice(0, TOP_N)) {
    console.log(
      `  ${String(delta.consumersOutsideDiff.length).padStart(3)}  ${delta.change.padEnd(8)} ${delta.file}#${delta.symbol}`,
    );
  }

  console.log(`\ndegraded[]: ${document.degraded.length}`);
  for (const entry of document.degraded) {
    console.log(`  [${entry.extractor}] ${entry.reason}`);
  }

  const extractors = document.extractors;
  console.log(`\nother payloads`);
  console.log(`  facts      ${extractors.facts?.symbols.length ?? 0} symbol(s)`);
  console.log(`  constants  ${extractors.constants?.constants.length ?? 0} constant(s)`);
  console.log(`  deps       ${extractors.deps?.changes.length ?? 0} change(s)`);
  console.log(`  patterns   ${extractors.patterns?.findings.length ?? 0} finding(s)`);
  console.log(
    `  coverage   ${extractors.coverage?.totals.uncoveredChangedLines ?? 0} uncovered of ${extractors.coverage?.totals.changedLines ?? 0} changed line(s)`,
  );

  console.log(`\n${line}`);
  if (violations.length === 0) {
    console.log("selfcheck: OK");
    return 0;
  }
  for (const violation of violations) console.log(`selfcheck: FAIL — ${violation}`);
  return 1;
}

process.exitCode = main();
