/**
 * `coverage` — changed lines executed by zero tests.
 *
 * **This extractor exists because `mutants` was cut** (design review §D13). The
 * reasoning is worth keeping next to the code, because this is a removal:
 *
 *  - `mutants` was the plan's most expensive input and the `tests` family
 *    plausibly contributes one or two findings across the whole gold set, which
 *    sits permanently inside §D6's detection floor. So rung 2b — the
 *    measurement whose entire purpose was to decide whether mutation seeding
 *    earned its keep — could not have returned a readable answer.
 *  - *"this changed line at `src/auth.ts:73` is executed by zero tests"* is
 *    mechanical and has better provenance than a surviving mutant, which needs
 *    equivalent-mutant filtering to avoid being noise (Meta ACH: 0.79/0.47 raw,
 *    0.95/0.96 with preprocessing).
 *  - It needs **no green baseline**, so coverage over a red suite is still
 *    valid data, and it costs one instrumented run rather than N mutation runs.
 *
 * WHAT THIS DOES AND DOES NOT DO. It READS an existing coverage artifact and
 * intersects it with the diff. It does not install anything and it does not run
 * a test suite — that is [WP4](../../docs/plans/review-evidence-pipeline/04-probe-oracle.md)'s
 * `prepare`, and running a suite here would smuggle the wall-clock item §D13
 * deleted back into the pipeline. When there is no report, the document says so
 * in `degraded[]`. "No uncovered lines" and "nobody measured coverage" must
 * never look the same — that is the rule with money on it, because the second
 * one reads as *"well tested"*.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep, isAbsolute } from "node:path";
import type { CoverageFormat, CoveragePayload, DegradedEntry } from "./schema.js";
import type { ChangedFileIndex } from "./facts.js";

/**
 * Where test runners put coverage, newest-idiom first.
 *
 * The last four are the fix for a structural blind spot: this extractor read
 * istanbul and lcov only, and **none of the corpus's four non-JS ecosystems
 * emits either**. So on a Java, Go, Python or Ruby PR — 59% of the gold
 * findings — `coverage` could not answer its own question, and answered it with
 * an empty uncovered-line list, which reads as *"well tested"*. That is the one
 * failure mode this file's header says has money on it.
 */
export const DEFAULT_REPORT_CANDIDATES = [
  "coverage/coverage-final.json",
  "coverage/coverage-summary.json",
  ".nyc_output/coverage-final.json",
  "coverage/lcov.info",
  "target/site/jacoco/jacoco.xml",
  "coverage.xml",
  "coverage.out",
  "coverage/.resultset.json",
];

export interface LineHits {
  /** line → execution count. A line absent here was never instrumented. */
  hits: Map<number, number>;
}

/** Istanbul `coverage-final.json`: `{ "<abs path>": { statementMap, s } }`. */
export function parseIstanbul(raw: string, repo: string): Map<string, LineHits> {
  const parsed = JSON.parse(raw) as Record<
    string,
    {
      path?: string;
      statementMap?: Record<string, { start?: { line?: number }; end?: { line?: number } }>;
      s?: Record<string, number>;
    }
  >;
  const out = new Map<string, LineHits>();
  for (const [key, entry] of Object.entries(parsed)) {
    const filePath = entry.path ?? key;
    const path = normalisePath(filePath, repo);
    const hits = out.get(path)?.hits ?? new Map<number, number>();
    for (const [id, location] of Object.entries(entry.statementMap ?? {})) {
      const start = location.start?.line;
      const end = location.end?.line ?? start;
      if (start === undefined || end === undefined) continue;
      const count = entry.s?.[id] ?? 0;
      for (let line = start; line <= end; line++) {
        hits.set(line, Math.max(hits.get(line) ?? 0, count));
      }
    }
    out.set(path, { hits });
  }
  return out;
}

/** `lcov.info`: `SF:<path>` … `DA:<line>,<count>` … `end_of_record`. */
export function parseLcov(raw: string, repo: string): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  let current: LineHits | null = null;
  for (const line of raw.split("\n")) {
    if (line.startsWith("SF:")) {
      const path = normalisePath(line.slice(3).trim(), repo);
      current = out.get(path) ?? { hits: new Map<number, number>() };
      out.set(path, current);
      continue;
    }
    if (line.startsWith("DA:") && current) {
      const [lineNumber, count] = line.slice(3).trim().split(",");
      const parsedLine = Number(lineNumber);
      if (!Number.isFinite(parsedLine)) continue;
      current.hits.set(parsedLine, Math.max(current.hits.get(parsedLine) ?? 0, Number(count) || 0));
      continue;
    }
    if (line.startsWith("end_of_record")) current = null;
  }
  return out;
}

// ── the four non-JS formats ──────────────────────────────────────────────────
//
// Hand-rolled regex scraping, and that is a decision rather than laziness: these
// are two fixed, well-known, machine-GENERATED document shapes, this package is
// vendored into a sandbox image, and an XML parser would be a new dependency on
// the `lastlight` CLI's install (already ~22 MB) to read two attributes off two
// element types. Everything below is deliberately biased the same way as the
// rest of the file — anything it cannot read produces NO entry for that file,
// which surfaces as "does not appear in the report at all" in `degraded[]`,
// never as a covered line.

interface XmlElement {
  attrs: string;
  body: string;
}

/**
 * Every `<tag …>…</tag>` at any depth, self-closing tags skipped.
 *
 * Sound for these two documents specifically because neither nests the elements
 * we ask for (`<class>` inside `<class>`, `<sourcefile>` inside `<sourcefile>`)
 * — which is the property that makes the lazy `[\s\S]*?` match the right body.
 */
function* elements(raw: string, tag: string): Generator<XmlElement> {
  const open = new RegExp(`<${tag}\\b([^>]*)>`, "g");
  for (const match of raw.matchAll(open)) {
    if (match[1].trimEnd().endsWith("/")) continue; // `<class … />` — no body
    const from = match.index + match[0].length;
    const close = raw.indexOf(`</${tag}>`, from);
    if (close === -1) continue;
    yield { attrs: match[1], body: raw.slice(from, close) };
  }
}

function attr(attrs: string, name: string): string | null {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(attrs)?.[1] ?? null;
}

/**
 * JaCoCo XML (`target/site/jacoco/jacoco.xml`) — Maven and Gradle both emit it.
 *
 * `<package name="org/keycloak/foo"><sourcefile name="Bar.java">
 *    <line nr="12" mi="0" ci="3" mb="0" cb="0"/>`
 *
 * `ci` is COVERED instructions and `mi` missed, so a line is covered iff
 * `ci > 0` — a line with `mi > 0` and `ci > 0` is a partially-covered branch,
 * which is executed, and calling it uncovered would put a false obligation in
 * front of the reviewer.
 *
 * The key is `<package>/<sourcefile>`, i.e. the JAVA package path, which is not
 * the repo path (`services/src/main/java/` prefixes it). `resolveReportKey`
 * closes that gap by suffix, and every emitted `path` is the repo's, never the
 * report's.
 */
export function parseJaCoCo(raw: string, repo: string): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  for (const pkg of elements(raw, "package")) {
    const packageName = (attr(pkg.attrs, "name") ?? "").replace(/^\/+|\/+$/g, "");
    for (const file of elements(pkg.body, "sourcefile")) {
      const name = attr(file.attrs, "name");
      if (!name) continue;
      const path = normalisePath(packageName ? `${packageName}/${name}` : name, repo);
      const hits = out.get(path)?.hits ?? new Map<number, number>();
      for (const line of file.body.matchAll(/<line\b([^>]*)\/?>/g)) {
        const nr = Number(attr(line[1], "nr"));
        const covered = Number(attr(line[1], "ci") ?? "0");
        if (!Number.isFinite(nr) || nr < 1) continue;
        hits.set(nr, Math.max(hits.get(nr) ?? 0, Number.isFinite(covered) ? covered : 0));
      }
      out.set(path, { hits });
    }
  }
  return out;
}

/**
 * Cobertura XML (`coverage.xml`) — coverage.py, pytest-cov, simplecov-cobertura,
 * gocover-cobertura and most CI uploaders all speak it.
 *
 * `<class filename="src/foo.py"><lines><line number="7" hits="0"/>`. `filename`
 * is relative to whatever `<sources>` said, which is usually but not always the
 * repo root — again `resolveReportKey`'s problem, not this parser's.
 */
export function parseCobertura(raw: string, repo: string): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  for (const klass of elements(raw, "class")) {
    const filename = attr(klass.attrs, "filename");
    if (!filename) continue;
    const path = normalisePath(filename, repo);
    const hits = out.get(path)?.hits ?? new Map<number, number>();
    for (const line of klass.body.matchAll(/<line\b([^>]*)\/?>/g)) {
      const number = Number(attr(line[1], "number"));
      const count = Number(attr(line[1], "hits") ?? "0");
      if (!Number.isFinite(number) || number < 1) continue;
      hits.set(number, Math.max(hits.get(number) ?? 0, Number.isFinite(count) ? count : 0));
    }
    out.set(path, { hits });
  }
  return out;
}

/**
 * A Go coverprofile (`go test -coverprofile=coverage.out`).
 *
 *   mode: set
 *   github.com/grafana/grafana/pkg/api/foo.go:31.24,35.3 2 1
 *                                   ^start   ^end  ^stmts ^count
 *
 * Blocks OVERLAP, so a line is covered iff ANY block covering it has
 * `count > 0` — which `Math.max` is exactly. Taking the last block to mention
 * a line (the obvious loop) would report a covered line as uncovered whenever
 * an untaken `if` branch happened to come second.
 *
 * The key is the IMPORT path, so here the report key is LONGER than the repo
 * path — the opposite direction to JaCoCo, and why `resolveReportKey` matches
 * both ways.
 */
export function parseGoCoverProfile(raw: string, repo: string): Map<string, LineHits> {
  const out = new Map<string, LineHits>();
  const line = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/;
  for (const text of raw.split("\n")) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.startsWith("mode:")) continue;
    const match = line.exec(trimmed);
    if (!match) continue;
    const path = normalisePath(match[1], repo);
    const from = Number(match[2]);
    const to = Number(match[3]);
    const count = Number(match[4]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) continue;
    const hits = out.get(path)?.hits ?? new Map<number, number>();
    for (let n = from; n <= to; n++) hits.set(n, Math.max(hits.get(n) ?? 0, count));
    out.set(path, { hits });
  }
  return out;
}

/**
 * SimpleCov (`coverage/.resultset.json`) — Ruby.
 *
 *   { "RSpec": { "coverage": { "/app/lib/foo.rb": { "lines": [null, 1, 0] } } } }
 *
 * **Index 0 is line 1**, and `null` is NOT INSTRUMENTED (a blank line, a
 * comment, an `end`) rather than uncovered — dropping it from the map is what
 * makes it land in `uninstrumentedChangedLines` instead of manufacturing an
 * obligation about a `def` keyword. The older SimpleCov wrote the bare array in
 * place of the `{ lines: … }` object; both are accepted, because a repo pinning
 * an old SimpleCov is exactly the repo nobody will notice went unread.
 *
 * Several suites merge with `max`: a line run by the RSpec suite is executed,
 * whatever Cucumber did.
 */
export function parseSimpleCov(raw: string, repo: string): Map<string, LineHits> {
  const parsed = JSON.parse(raw) as Record<
    string,
    { coverage?: Record<string, { lines?: (number | null)[] } | (number | null)[]> }
  >;
  const out = new Map<string, LineHits>();
  for (const suite of Object.values(parsed)) {
    for (const [file, entry] of Object.entries(suite?.coverage ?? {})) {
      const lines = Array.isArray(entry) ? entry : entry?.lines;
      if (!Array.isArray(lines)) continue;
      const path = normalisePath(file, repo);
      const hits = out.get(path)?.hits ?? new Map<number, number>();
      lines.forEach((count, index) => {
        if (count === null || count === undefined) return;
        const n = index + 1;
        hits.set(n, Math.max(hits.get(n) ?? 0, Number(count) || 0));
      });
      out.set(path, { hits });
    }
  }
  return out;
}

// ── format detection + path reconciliation ───────────────────────────────────

/**
 * Which format an artifact is, from its name and — for the two that share
 * `.xml` — one look at its root element. Content sniffing rather than path
 * matching because `--report` can point anywhere, and a Cobertura file read as
 * JaCoCo produces zero entries, i.e. silence.
 */
export function formatOf(path: string, raw: string): CoverageFormat {
  const name = path.split(/[/\\]/).pop() ?? path;
  if (name.endsWith(".info")) return "lcov";
  if (name.endsWith(".out")) return "go-coverprofile";
  if (name === ".resultset.json" || name.endsWith(".resultset.json")) return "simplecov";
  if (name.endsWith(".xml")) {
    return /<\s*report\b|JACOCO/i.test(raw.slice(0, 2000)) ? "jacoco" : "cobertura";
  }
  // A coverprofile under any other name still starts with its mode line.
  if (/^\s*mode:\s*(set|count|atomic)\s*$/m.test(raw.slice(0, 200))) return "go-coverprofile";
  return "istanbul";
}

const PARSERS: Record<CoverageFormat, (raw: string, repo: string) => Map<string, LineHits>> = {
  istanbul: parseIstanbul,
  lcov: parseLcov,
  jacoco: parseJaCoCo,
  cobertura: parseCobertura,
  "go-coverprofile": parseGoCoverProfile,
  simplecov: parseSimpleCov,
};

/**
 * The report's key for a repo path, when the two are not spelled the same.
 *
 * They routinely are not: JaCoCo keys by java package (`org/kc/Bar.java`, a
 * SUFFIX of the repo path), Go by import path
 * (`github.com/org/repo/pkg/a.go`, of which the repo path is a suffix),
 * Cobertura by whatever `<sources>` was. Exact match first, then a
 * separator-aligned suffix match in either direction.
 *
 * **A match must be UNIQUE.** Two files named `util.go` in different packages
 * would otherwise let one file's coverage be reported under the other's name —
 * a wrong uncovered line is a false obligation, and this file's whole thesis is
 * that a wrong answer is worse than an absent one. Ambiguity therefore reads as
 * "not in the report", which `degraded[]` already names.
 */
export function resolveReportKey(byFile: Map<string, LineHits>, path: string): string | null {
  if (byFile.has(path)) return path;
  let found: string | null = null;
  for (const key of byFile.keys()) {
    if (!key.endsWith(`/${path}`) && !path.endsWith(`/${key}`)) continue;
    if (found) return null; // ambiguous — refuse rather than guess
    found = key;
  }
  return found;
}

function normalisePath(path: string, repo: string): string {
  const relativePath = isAbsolute(path) ? relative(repo, path) : path;
  return relativePath.split(sep).join("/");
}

export interface ExtractCoverageOptions {
  repo: string;
  hunkIndex: Map<string, ChangedFileIndex>;
  /** Explicit artifact path; otherwise `DEFAULT_REPORT_CANDIDATES` are tried. */
  reportPath?: string;
}

export interface ExtractCoverageResult {
  payload: CoveragePayload;
  degraded: DegradedEntry[];
}

export function extractCoverage(options: ExtractCoverageOptions): ExtractCoverageResult {
  const degraded: DegradedEntry[] = [];
  const changedTotal = [...options.hunkIndex.values()].reduce(
    (sum, entry) => sum + entry.changedLines.size,
    0,
  );

  const candidates = options.reportPath ? [options.reportPath] : DEFAULT_REPORT_CANDIDATES;
  const found = candidates.find((candidate) => existsSync(join(options.repo, candidate)));

  if (!found) {
    degraded.push({
      extractor: "coverage",
      reason: `no coverage artifact found (looked for ${candidates.join(", ")}) — the tests family was NOT MEASURED. An empty uncovered-line list here would read as "well tested"`,
    });
    return {
      payload: {
        report: null,
        reportFormat: null,
        files: [],
        totals: { changedLines: changedTotal, uncoveredChangedLines: 0 },
      },
      degraded,
    };
  }

  let format: CoverageFormat = "istanbul";
  let byFile: Map<string, LineHits>;
  try {
    const raw = readFileSync(join(options.repo, found), "utf8");
    format = formatOf(found, raw);
    byFile = PARSERS[format](raw, options.repo);
  } catch (err) {
    degraded.push({
      extractor: "coverage",
      reason: `the coverage artifact ${found} could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return {
      payload: {
        report: found,
        reportFormat: format,
        files: [],
        totals: { changedLines: changedTotal, uncoveredChangedLines: 0 },
      },
      degraded,
    };
  }

  const files: CoveragePayload["files"] = [];
  let uncoveredTotal = 0;
  const unreported: string[] = [];

  for (const [path, entry] of options.hunkIndex) {
    const changedLines = [...entry.changedLines].sort((a, b) => a - b);
    if (changedLines.length === 0) continue;
    const key = resolveReportKey(byFile, path);
    const coverage = key === null ? undefined : byFile.get(key);
    if (!coverage) {
      unreported.push(path);
      continue;
    }
    const uncovered: number[] = [];
    const uninstrumented: number[] = [];
    for (const line of changedLines) {
      const count = coverage.hits.get(line);
      if (count === undefined) uninstrumented.push(line);
      else if (count === 0) uncovered.push(line);
    }
    uncoveredTotal += uncovered.length;
    files.push({
      path,
      changedLines,
      uncoveredChangedLines: uncovered,
      uninstrumentedChangedLines: uninstrumented,
    });
  }

  if (unreported.length > 0) {
    // A changed file the report never mentions is the "well tested" trap in
    // miniature: it has no uncovered lines because it has no lines at all.
    degraded.push({
      extractor: "coverage",
      reason: `${unreported.length} changed file(s) do not appear in ${found} at all, so their coverage is unknown rather than complete: ${unreported.slice(0, 10).join(", ")}`,
    });
  }

  return {
    payload: {
      report: found,
      reportFormat: format,
      files: files.sort((a, b) => a.path.localeCompare(b.path)),
      totals: { changedLines: changedTotal, uncoveredChangedLines: uncoveredTotal },
    },
    degraded,
  };
}
