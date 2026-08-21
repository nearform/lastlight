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
import type { CoveragePayload, DegradedEntry } from "./schema.js";
import type { ChangedFileIndex } from "./facts.js";

/** Where test runners put coverage, newest-idiom first. */
export const DEFAULT_REPORT_CANDIDATES = [
  "coverage/coverage-final.json",
  "coverage/coverage-summary.json",
  ".nyc_output/coverage-final.json",
  "coverage/lcov.info",
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

  const format = found.endsWith(".info") ? "lcov" : "istanbul";
  let byFile: Map<string, LineHits>;
  try {
    const raw = readFileSync(join(options.repo, found), "utf8");
    byFile = format === "lcov" ? parseLcov(raw, options.repo) : parseIstanbul(raw, options.repo);
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
    const coverage = byFile.get(path);
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
