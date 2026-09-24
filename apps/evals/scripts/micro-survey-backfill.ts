#!/usr/bin/env -S npx tsx
/**
 * Fill the micro-survey report fields added after a report was written, from
 * what the report already kept — $0, no model call.
 *
 * Every repeat's raw rows are copied to `rows/<report-id>/repeat-N.jsonl`, and
 * the fixture still holds the seeded `obligations.json`, so these are pure
 * functions of files on disk:
 *
 *   rowsView        per row: the check it answers, why it probes, reassurance
 *   seed            the discharge gate's ledger (seeded / answered / skipped /
 *                   own rows / lines lost / gate)
 *   baselineSeed    the same over the preserved arm's rows
 *   checks          the family's seeded checks, id → question
 *   gold.claimed    re-counted under the current claim rule, which excludes
 *                   clean discharges — the judge's credits (`cells`) are kept
 *                   as they were, never re-bought
 *
 * A report still being written (live, heartbeat fresh) is skipped: its writer
 * would overwrite the fill on its next repeat.
 *
 * Usage (from an evals workspace):
 *   npx tsx <lastlight>/apps/evals/scripts/micro-survey-backfill.ts [--dry-run] [--only <substring>]
 */
import { existsSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type MicroGoldRepeat, type MicroSurveyReport, microStatus } from "../src/micro-survey.js";
import { checksOf, claimOf, parseRows, rowsViewOf, seedStatsIn, seedStatsOfRowsFile } from "../src/micro-survey-node.js";

const argv = process.argv.slice(2);
const dryRun = argv.includes("--dry-run");
const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : undefined;
const dir = join(process.cwd(), "eval-results", "micro-survey");
if (!existsSync(dir)) {
  console.error(`no ${dir} — run from an evals workspace`);
  process.exit(2);
}

/** `<fixture>/sandboxes/<task>/<repo>` — the same resolution the replay uses. */
function checkoutOf(fixture: string): string | null {
  const sandboxes = join(fixture, "sandboxes");
  if (!existsSync(sandboxes)) return null;
  const task = join(sandboxes, readdirSync(sandboxes)[0]);
  const repo = readdirSync(task).find((e) => existsSync(join(task, e, ".git")));
  return repo ? join(task, repo) : null;
}

let filled = 0;
for (const name of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
  const id = name.replace(/\.json$/, "");
  if (only && !id.includes(only)) continue;
  const path = join(dir, name);
  const report = JSON.parse(readFileSync(path, "utf8")) as MicroSurveyReport & { baselineSeed?: unknown; checks?: unknown };
  if (!report?.family || !Array.isArray(report.results)) continue;
  if (microStatus(report, Date.now()) === "running") {
    console.log(`skip ${id} — still running`);
    continue;
  }
  const checkout = report.fixture ? checkoutOf(report.fixture) : null;
  if (!checkout) {
    console.log(`skip ${id} — fixture ${report.fixture} not on disk`);
    continue;
  }
  const obligationsPath = join(checkout, ".lastlight/pr-review/obligations.json");
  const checks = checksOf(obligationsPath, report.family);
  const checkIds = new Set(checks.map((c) => c.id));
  const rowsDir = join(dir, "rows", id);

  let touched = 0;
  report.results.forEach((res, i) => {
    const file = join(rowsDir, `repeat-${i + 1}.jsonl`);
    const rows = existsSync(file) ? parseRows(readFileSync(file, "utf8")) : [];
    res.rowsView = rowsViewOf(rows, checkIds);
    const seed = seedStatsOfRowsFile(obligationsPath, report.family, existsSync(file) ? file : null);
    if (seed) res.seed = seed;
    const g = res.gold as MicroGoldRepeat | undefined;
    if (g && Array.isArray(g.cells)) {
      // Re-count claims only. The credited rows are the judge's, carried as-is.
      // Same rule as `microGoldRepeat`: a credited row is a claim.
      const credited = new Set(g.cells.filter((c) => c.verdict === "asserted").flatMap((c) => c.rows));
      const claims = new Set([
        ...rows.map((r, k) => ({ r, id: r.id ?? `row-${k}` })).filter(({ r }) => claimOf(r)).map(({ id: rid }) => rid),
        ...credited,
      ]);
      g.claimed = claims.size;
      g.claimedAsserting = [...claims].filter((rid) => credited.has(rid)).length;
    }
    touched++;
  });
  const baselineSeed = seedStatsIn(join(checkout, ".lastlight/pr-review"), report.family);
  if (baselineSeed) report.baselineSeed = baselineSeed;
  report.checks = checks;

  console.log(`${dryRun ? "would fill" : "filled"} ${id} — ${touched} repeat(s), ${checks.length} check(s)`);
  if (!dryRun) {
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(report, null, 2));
    renameSync(tmp, path);
  }
  filled++;
}
console.log(`\n${filled} report(s) ${dryRun ? "would be" : ""} filled`);
