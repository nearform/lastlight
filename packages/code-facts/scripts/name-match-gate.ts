#!/usr/bin/env -S npx tsx
/**
 * THE MEASUREMENT GATE — is a name-matched reference set good enough to ship?
 *
 * Before anyone spends +36.5 MB on four tree-sitter grammars, one question has
 * to be answered with numbers: **when you replace a type-resolved reference set
 * with a name-matched one, what do you actually get?** TypeScript is the only
 * language where that is answerable offline, because it is the only one where
 * BOTH engines exist — ts-morph gives the ground truth and `syntactic.ts` gives
 * the candidate. Run them over the same symbols in the same repository and diff
 * the two reference sets.
 *
 * ```
 * npx tsx scripts/name-match-gate.ts --repo ../.. --base HEAD~1 --head HEAD
 * npx tsx scripts/name-match-gate.ts --bare ~/…/calcom__cal.com.git --base <sha> --head <sha>
 * ```
 *
 * ## What the numbers mean
 *
 * For one symbol, `T` is the type-resolved reference set and `N` the
 * name-matched one:
 *
 *   precision = |T ∩ N| / |N|   — how much of what name matching offers is real
 *   recall    = |T ∩ N| / |T|   — how much of the truth name matching finds
 *
 * Both are reported under THREE restrictions, and the spread between them is
 * the difference between an honest number and a rhetorical one. Controlling for
 * a known confound is not tuning the matcher — the matcher is not touched by
 * any of these:
 *
 *   **strict**      over every site either engine produced. This is what a
 *                   consumer would actually be handed, so it is the number that
 *                   decides whether to ship.
 *   **comparable**  restricted to files BOTH engines could see — the compiled
 *                   programs ∩ the indexed tree. A name-matched hit in a file no
 *                   tsconfig covers is not a false positive, it is a file the
 *                   compiler was never asked about; a type-resolved hit in a
 *                   file the index skipped (over the size ceiling, minified) is
 *                   not a miss.
 *   **own-program** restricted to the ONE program that holds the declaration.
 *                   The tightest like-for-like, and the one that measures the
 *                   MATCHER rather than the loader: "reference queries stay
 *                   inside their own program" is a documented property of the
 *                   type-aware engine, so a name-matched hit in a sibling
 *                   package is a reference ts-morph was never in a position to
 *                   find. On this monorepo that single correction is worth tens
 *                   of points of apparent precision.
 *
 * `micro` pools every site across every symbol (what the seeder sees in
 * aggregate); `macro` averages the per-symbol figures (what one obligation
 * looks like). They differ a lot when a few common names dominate, which is
 * itself the finding.
 *
 * ## Bucketed by nameAmbiguity
 *
 * The hypothesis under test: **precision is high at `nameAmbiguity == 1` and
 * collapses above it.** If that holds, name matching is shippable with the
 * ambiguity carried as a rank; if precision is poor even at 1, it is not
 * shippable at all and four grammars would have bought noise.
 *
 * ## The `referencesInDiff` vs `referenceCount` column
 *
 * CLAUDE.md calls that pair the most productive field in the document: a symbol
 * whose shape changed and whose references are mostly OUTSIDE the diff is the
 * cross-file contract bug. So the gate also asks how often the two engines lead
 * to a DIFFERENT conclusion there — that is the decision the reviewer actually
 * takes, and a precision number that looks bad can still leave it intact (or a
 * precision number that looks fine can wreck it).
 *
 * Not wired into CI, like `selfcheck.ts`: it needs a tier-1 repo and real
 * history. It reports; it does not gate a build.
 */
import { relative, resolve } from "node:path";
import { changedPaths, diffHunks, resolveDiffBase, resolveSha, withWorktree } from "../src/git.js";
import { extractFacts } from "../src/facts.js";
import { buildSyntacticIndex, extractFactsByName } from "../src/syntactic.js";
import { loadProject, repoRelative } from "../src/project.js";
import { noopLogger } from "../src/log.js";
import type { SymbolFact } from "../src/schema.js";

interface Args {
  repo: string;
  /** A bare clone to materialise `head` out of, into a throwaway worktree. */
  bare: string | null;
  base: string;
  head: string;
  label: string;
  maxFiles?: number;
  /** Analyse the checkout as it is, dirty tree and all. See `--in-place`. */
  inPlace: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string>();
  let json = false;
  let inPlace = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--json") {
      json = true;
      continue;
    }
    if (argv[i] === "--in-place") {
      inPlace = true;
      continue;
    }
    if (argv[i].startsWith("--") && argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags.set(argv[i].slice(2), argv[++i]);
    }
  }
  const bare = flags.get("bare") ? resolve(flags.get("bare")!) : null;
  return {
    repo: resolve(flags.get("repo") ?? process.cwd()),
    bare,
    base: flags.get("base") ?? "HEAD~1",
    head: flags.get("head") ?? "HEAD",
    label: flags.get("label") ?? (bare ?? flags.get("repo") ?? ".").split("/").pop() ?? ".",
    maxFiles: flags.get("max-files") ? Number(flags.get("max-files")) : undefined,
    inPlace,
    json,
  };
}

/** One symbol, seen by both engines. */
interface Pair {
  name: string;
  kind: string;
  declaredAt: string;
  nameAmbiguity: number;
  typed: Set<string>;
  named: Set<string>;
  /** The same two sets, restricted to files BOTH engines could see. */
  typedComparable: Set<string>;
  namedComparable: Set<string>;
  /**
   * …and restricted to the files of the ONE program that holds the
   * declaration.
   *
   * This is the strictest like-for-like and the one that matters most, because
   * "reference queries stay inside their own program" is a documented property
   * of the type-aware engine, not an accident: a cross-project reference is not
   * resolvable without project references. On this monorepo `FactsDocument`
   * scored 0% precision with 15 offered sites against 0 "real" ones — and every
   * one of those 15 is a genuine reference, in a package whose tsconfig is a
   * different program. Counting them as false positives would have measured the
   * loader's scope, not the matcher's.
   */
  typedOwn: Set<string>;
  namedOwn: Set<string>;
  typedCount: number;
  namedCount: number;
  typedInDiff: number;
  namedInDiff: number;
}

interface Counts {
  hit: number;
  named: number;
  typed: number;
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function pct(value: number | null): string {
  return value === null ? "  n/a" : `${(value * 100).toFixed(1)}%`;
}

/**
 * What a reviewer would CONCLUDE from `referencesInDiff` beside
 * `referenceCount` — the decision, not the number.
 */
type Conclusion = "unreferenced" | "all-in-diff" | "mostly-outside" | "mixed";

function conclusionOf(count: number, inDiff: number): Conclusion {
  if (count === 0) return "unreferenced";
  const outside = count - inDiff;
  if (outside === 0) return "all-in-diff";
  return outside > inDiff ? "mostly-outside" : "mixed";
}

function fileOf(site: string): string {
  return site.slice(0, site.lastIndexOf(":"));
}

function restrict(sites: Iterable<string>, files: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const site of sites) if (files.has(fileOf(site))) out.add(site);
  return out;
}

/** Which of the three restrictions a figure is computed under. */
type Scope = "strict" | "comparable" | "own-program";

function setsOf(pair: Pair, scope: Scope): [Set<string>, Set<string>] {
  if (scope === "comparable") return [pair.typedComparable, pair.namedComparable];
  if (scope === "own-program") return [pair.typedOwn, pair.namedOwn];
  return [pair.typed, pair.named];
}

function pool(pairs: Pair[], scope: Scope): Counts {
  let hit = 0;
  let named = 0;
  let typed = 0;
  for (const pair of pairs) {
    const [t, n] = setsOf(pair, scope);
    named += n.size;
    typed += t.size;
    for (const site of n) if (t.has(site)) hit++;
  }
  return { hit, named, typed };
}

/** Mean of the per-symbol figures, over the symbols where they are defined. */
function macro(pairs: Pair[], scope: Scope): { precision: number | null; recall: number | null } {
  const precisions: number[] = [];
  const recalls: number[] = [];
  for (const pair of pairs) {
    const [t, n] = setsOf(pair, scope);
    let hit = 0;
    for (const site of n) if (t.has(site)) hit++;
    if (n.size > 0) precisions.push(hit / n.size);
    if (t.size > 0) recalls.push(hit / t.size);
  }
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
  return { precision: mean(precisions), recall: mean(recalls) };
}

const BUCKETS: { label: string; test: (n: number) => boolean }[] = [
  { label: "1", test: (n) => n <= 1 },
  { label: "2-3", test: (n) => n >= 2 && n <= 3 },
  { label: "4-10", test: (n) => n >= 4 && n <= 10 },
  { label: ">10", test: (n) => n > 10 },
];

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const started = Date.now();

  const run = (repo: string) => measure(repo, args);
  /**
   * **THE MEASUREMENT RUNS IN A DETACHED WORKTREE OF `head`, ALWAYS.**
   *
   * Not tidiness — the first run of this gate was wrong because of it. The
   * type-aware engine reads HEAD off the FILESYSTEM (CLAUDE.md, "Known, not
   * fixed") while the syntactic index reads blobs at `headSha`, so on a dirty
   * checkout the two engines cite different line numbers for every modified
   * file and every site "disagrees". Measured on this repo with uncommitted
   * work in the tree: `makeFixture` scored 0% precision with 6 offered sites
   * against 30 real ones, entirely because the two sides were reading different
   * text. Materialising `head` makes the filesystem and the commit the same
   * thing, which is the only condition under which the comparison means
   * anything.
   *
   * `--in-place` opts out, for when you want to measure the checkout you have.
   * `mirrorNodeModules` is off for a bare source (there is nothing to mirror,
   * and the walk would descend into the object database) and on otherwise, so
   * the tier-1 program resolves what it normally resolves.
   */
  const source = args.bare ?? (args.inPlace ? null : args.repo);
  const report =
    source === null
      ? run(args.repo)
      : withWorktree(source, resolveSha(source, args.head), run, {
          mirrorNodeModules: args.bare === null,
        });
  if (report === null) return 2;

  const elapsedMs = Date.now() - started;
  const peakRssMb = process.resourceUsage().maxRSS / 1024;

  if (args.json) {
    console.log(JSON.stringify({ ...report, elapsedMs, peakRssMb }, null, 2));
    return 0;
  }
  print(report, elapsedMs, peakRssMb);
  return 0;
}

interface Half {
  micro: { precision: number | null; recall: number | null };
  macro: { precision: number | null; recall: number | null };
  pooled: Counts;
}

interface Report {
  label: string;
  repo: string;
  baseSha: string;
  headSha: string;
  changedPaths: number;
  tier: number;
  programFiles: number;
  indexedFiles: number;
  comparableFiles: number;
  typedSymbols: number;
  namedSymbols: number;
  pairedSymbols: number;
  typedOnly: string[];
  namedOnly: string[];
  strict: Half;
  comparable: Half;
  ownProgram: Half;
  /** Bucketed by `nameAmbiguity`, under `strict` and under `own-program`. */
  buckets: {
    label: string;
    symbols: number;
    precision: number | null;
    recall: number | null;
    namedSites: number;
    typedSites: number;
    ownPrecision: number | null;
    ownRecall: number | null;
    ownNamedSites: number;
    ownTypedSites: number;
  }[];
  /**
   * The same figures per SYMBOL KIND. A member name (`error`, `run`, `get`) is
   * a different measurement from a module-level name, and averaging the two
   * hides which half of the idea works.
   */
  byKind: {
    kind: string;
    symbols: number;
    precision: number | null;
    recall: number | null;
    namedSites: number;
    typedSites: number;
  }[];
  poolInflation: number | null;
  conclusions: {
    agree: number;
    disagree: number;
    matrix: Record<string, number>;
    lostProductive: number;
    falseProductive: number;
  };
  worstPrecision: { name: string; nameAmbiguity: number; precision: number; named: number; typed: number }[];
}

function measure(repo: string, args: Args): Report | null {
  const headSha = resolveSha(repo, args.head);
  const diffBase = resolveDiffBase(repo, resolveSha(repo, args.base), headSha);
  const changed = changedPaths(repo, diffBase.sha, headSha);
  const hunks = diffHunks(repo, diffBase.sha, headSha);

  // ── engine A: the ground truth ───────────────────────────────────────────
  const loaded = loadProject({
    repo,
    changedPaths: changed.map((c) => c.path),
    maxFiles: args.maxFiles,
    log: noopLogger,
  });
  if (loaded.tier !== 1 || loaded.projects.length === 0) {
    console.error(
      `name-match-gate: ${repo} loaded at tier ${loaded.tier}, so there is NO type-resolved reference set to measure against. ` +
        `This gate needs ground truth; a tier-2 repo is the thing being measured, not the measurement.\n` +
        loaded.degraded.map((d) => `  [${d.extractor}] ${d.reason}`).join("\n"),
    );
    return null;
  }
  const programFiles = new Set<string>();
  // Per GROUP, not merged: a symbol's reference query only ever ran inside the
  // one program that holds its declaration, so that program's file set is the
  // only fair denominator for it.
  const groupFiles: Set<string>[] = [];
  for (const project of loaded.projects) {
    const files = new Set<string>();
    for (const file of project.getSourceFiles()) {
      const path = repoRelative(repo, file.getFilePath());
      files.add(path);
      programFiles.add(path);
    }
    groupFiles.push(files);
  }
  /** The file set of the FIRST program holding this file — `sourceFileAt`'s rule. */
  const ownProgramOf = (path: string): Set<string> =>
    groupFiles.find((files) => files.has(path)) ?? new Set<string>();
  const typedFacts = extractFacts({
    repo,
    project: loaded.projects,
    hunks,
    changed,
    // Unbounded on BOTH sides: comparing two differently-truncated sets would
    // measure the truncation.
    maxReferences: 0,
  });

  // ── engine B: the candidate ──────────────────────────────────────────────
  const named = extractFactsByName({
    repo,
    headSha,
    hunks,
    changed,
    maxFiles: args.maxFiles,
    maxReferences: 0,
    maxSitesPerName: 0,
    log: noopLogger,
  });
  // `scannedPaths` is the other half of the comparable set. Rebuilt rather than
  // threaded through `extractFactsByName`, because nothing in the pipeline wants
  // it and a measurement should not widen a production shape.
  const indexed = buildSyntacticIndex({
    repo,
    ref: headSha,
    names: new Set(named.payload.symbols.map((s) => s.name.split(".").pop() as string)),
    maxFiles: args.maxFiles,
    maxSitesPerName: 0,
    recordScannedPaths: true,
  });
  const indexedFiles = indexed.scannedPaths ?? new Set<string>();
  const comparableFiles = new Set([...programFiles].filter((path) => indexedFiles.has(path)));

  // ── the join ─────────────────────────────────────────────────────────────
  const key = (symbol: SymbolFact): string => `${symbol.declaredAt}#${symbol.name}`;
  const namedByKey = new Map(named.payload.symbols.map((s) => [key(s), s]));
  const typedByKey = new Map(typedFacts.symbols.map((s) => [key(s), s]));

  const pairs: Pair[] = [];
  for (const typed of typedFacts.symbols) {
    const twin = namedByKey.get(key(typed));
    if (!twin) continue;
    const typedSites = new Set(typed.references.map((r) => r.at));
    const namedSites = new Set(twin.references.map((r) => r.at));
    const own = ownProgramOf(fileOf(typed.declaredAt));
    pairs.push({
      name: typed.name,
      kind: typed.kind,
      declaredAt: typed.declaredAt,
      nameAmbiguity: twin.nameAmbiguity ?? 0,
      typed: typedSites,
      named: namedSites,
      typedComparable: restrict(typedSites, comparableFiles),
      namedComparable: restrict(namedSites, comparableFiles),
      typedOwn: restrict(typedSites, own),
      namedOwn: restrict(namedSites, own),
      typedCount: typed.referenceCount,
      namedCount: twin.referenceCount,
      typedInDiff: typed.referencesInDiff,
      namedInDiff: twin.referencesInDiff,
    });
  }

  // ── the `referencesInDiff` column ────────────────────────────────────────
  const matrix: Record<string, number> = {};
  let agree = 0;
  let lostProductive = 0;
  let falseProductive = 0;
  for (const pair of pairs) {
    const typedConclusion = conclusionOf(pair.typedCount, pair.typedInDiff);
    const namedConclusion = conclusionOf(pair.namedCount, pair.namedInDiff);
    if (typedConclusion === namedConclusion) agree++;
    else {
      matrix[`${typedConclusion} → ${namedConclusion}`] =
        (matrix[`${typedConclusion} → ${namedConclusion}`] ?? 0) + 1;
      if (typedConclusion === "mostly-outside") lostProductive++;
      if (namedConclusion === "mostly-outside") falseProductive++;
    }
  }

  const strictPooled = pool(pairs, "strict");
  const comparablePooled = pool(pairs, "comparable");
  const ownPooled = pool(pairs, "own-program");
  const half = (pooled: Counts, scope: Scope): Half => ({
    micro: { precision: ratio(pooled.hit, pooled.named), recall: ratio(pooled.hit, pooled.typed) },
    macro: macro(pairs, scope),
    pooled,
  });

  const worst = pairs
    .filter((pair) => pair.namedOwn.size > 0)
    .map((pair) => {
      let hit = 0;
      for (const site of pair.namedOwn) if (pair.typedOwn.has(site)) hit++;
      return {
        name: pair.name,
        nameAmbiguity: pair.nameAmbiguity,
        precision: hit / pair.namedOwn.size,
        named: pair.namedOwn.size,
        typed: pair.typedOwn.size,
      };
    })
    .sort((a, b) => a.precision - b.precision || b.named - a.named)
    .slice(0, 10);

  return {
    label: args.label,
    repo: relative(process.cwd(), repo) || ".",
    baseSha: diffBase.sha,
    headSha,
    changedPaths: changed.length,
    tier: loaded.tier,
    programFiles: programFiles.size,
    indexedFiles: indexedFiles.size,
    comparableFiles: comparableFiles.size,
    typedSymbols: typedByKey.size,
    namedSymbols: namedByKey.size,
    pairedSymbols: pairs.length,
    typedOnly: [...typedByKey.keys()].filter((k) => !namedByKey.has(k)).slice(0, 10),
    namedOnly: [...namedByKey.keys()].filter((k) => !typedByKey.has(k)).slice(0, 10),
    strict: half(strictPooled, "strict"),
    comparable: half(comparablePooled, "comparable"),
    ownProgram: half(ownPooled, "own-program"),
    buckets: BUCKETS.map((bucket) => {
      const inBucket = pairs.filter((pair) => bucket.test(pair.nameAmbiguity));
      const pooled = pool(inBucket, "strict");
      const own = pool(inBucket, "own-program");
      return {
        label: bucket.label,
        symbols: inBucket.length,
        precision: ratio(pooled.hit, pooled.named),
        recall: ratio(pooled.hit, pooled.typed),
        namedSites: pooled.named,
        typedSites: pooled.typed,
        ownPrecision: ratio(own.hit, own.named),
        ownRecall: ratio(own.hit, own.typed),
        ownNamedSites: own.named,
        ownTypedSites: own.typed,
      };
    }),
    byKind: [...new Set(pairs.map((pair) => pair.kind))]
      .map((kind) => {
        const inKind = pairs.filter((pair) => pair.kind === kind);
        const pooled = pool(inKind, "own-program");
        return {
          kind,
          symbols: inKind.length,
          precision: ratio(pooled.hit, pooled.named),
          recall: ratio(pooled.hit, pooled.typed),
          namedSites: pooled.named,
          typedSites: pooled.typed,
        };
      })
      .sort((a, b) => b.namedSites - a.namedSites),
    poolInflation: ratio(strictPooled.named, strictPooled.typed),
    conclusions: {
      agree,
      disagree: pairs.length - agree,
      matrix,
      lostProductive,
      falseProductive,
    },
    worstPrecision: worst,
  };
}

function print(report: Report, elapsedMs: number, peakRssMb: number): void {
  const line = "─".repeat(78);
  console.log(line);
  console.log(
    `name-match gate — ${report.label}  ${report.baseSha.slice(0, 8)}..${report.headSha.slice(0, 8)}`,
  );
  console.log(
    `tier ${report.tier}   ${report.changedPaths} changed path(s)   ${(elapsedMs / 1000).toFixed(1)}s   ${peakRssMb.toFixed(0)} MB peak RSS`,
  );
  console.log(
    `files: ${report.programFiles} in the program, ${report.indexedFiles} indexed, ${report.comparableFiles} comparable (both)`,
  );
  console.log(
    `symbols: ${report.typedSymbols} type-aware, ${report.namedSymbols} name-match, ${report.pairedSymbols} paired`,
  );
  console.log(line);

  const table = (title: string, half: Report["strict"]): void => {
    console.log(`\n${title}`);
    console.log(
      `  micro   precision ${pct(half.micro.precision)}   recall ${pct(half.micro.recall)}   (${half.pooled.hit} hit / ${half.pooled.named} name-matched / ${half.pooled.typed} type-resolved sites)`,
    );
    console.log(
      `  macro   precision ${pct(half.macro.precision)}   recall ${pct(half.macro.recall)}   (mean over symbols)`,
    );
  };
  table("STRICT — every site either engine produced (what a consumer is handed)", report.strict);
  table("COMPARABLE — restricted to files both engines could see", report.comparable);
  table("OWN-PROGRAM — restricted to the program that holds the declaration", report.ownProgram);

  console.log(`\nby nameAmbiguity — THE HYPOTHESIS UNDER TEST`);
  console.log(
    `  ${"bucket".padEnd(7)} ${"symbols".padStart(8)}   ${"strict P".padStart(9)} ${"strict R".padStart(8)}   ${"own P".padStart(8)} ${"own R".padStart(7)}   sites N/T (own)`,
  );
  for (const bucket of report.buckets) {
    console.log(
      `  ${bucket.label.padEnd(7)} ${String(bucket.symbols).padStart(8)}   ${pct(bucket.precision).padStart(9)} ${pct(bucket.recall).padStart(8)}   ${pct(bucket.ownPrecision).padStart(8)} ${pct(bucket.ownRecall).padStart(7)}   ${bucket.ownNamedSites} / ${bucket.ownTypedSites}`,
    );
  }
  console.log(
    `  pool inflation: name matching offers ${report.poolInflation === null ? "n/a" : `${report.poolInflation.toFixed(2)}x`} the sites the compiler resolves`,
  );

  console.log(`\nby symbol kind (own-program)`);
  console.log(`  ${"kind".padEnd(17)} ${"symbols".padStart(8)} ${"precision".padStart(10)} ${"recall".padStart(8)}   sites (N / T)`);
  for (const kind of report.byKind) {
    console.log(
      `  ${kind.kind.padEnd(17)} ${String(kind.symbols).padStart(8)} ${pct(kind.precision).padStart(10)} ${pct(kind.recall).padStart(8)}   ${kind.namedSites} / ${kind.typedSites}`,
    );
  }

  console.log(`\nreferencesInDiff vs referenceCount — the conclusion, not the number`);
  console.log(
    `  ${report.conclusions.agree} of ${report.pairedSymbols} symbols reach the SAME conclusion (${report.conclusions.disagree} differ)`,
  );
  for (const [flip, count] of Object.entries(report.conclusions.matrix).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(count).padStart(4)}  ${flip}`);
  }
  console.log(
    `  ${report.conclusions.lostProductive} symbol(s) LOSE the "mostly outside the diff" reading, ${report.conclusions.falseProductive} gain a false one`,
  );

  if (report.worstPrecision.length > 0) {
    console.log(`\nworst 10 symbols by precision (own-program)`);
    for (const entry of report.worstPrecision) {
      console.log(
        `  ${pct(entry.precision).padStart(6)}  ambiguity ${String(entry.nameAmbiguity).padStart(3)}  ${entry.named} offered / ${entry.typed} real   ${entry.name}`,
      );
    }
  }

  if (report.typedOnly.length > 0) {
    console.log(`\nsymbols only the TYPE-aware engine found (first 10)`);
    for (const entry of report.typedOnly) console.log(`  ${entry}`);
  }
  if (report.namedOnly.length > 0) {
    console.log(`\nsymbols only the NAME-match engine found (first 10)`);
    for (const entry of report.namedOnly) console.log(`  ${entry}`);
  }
  console.log(`\n${line}`);
}

process.exitCode = main();
