#!/usr/bin/env -S npx tsx
/**
 * Is the per-family obligation ceiling BINDING, and on what?
 *
 * `docs/plans/review-pipeline-improvements.md` proposes replaying the seeder
 * over stored envelopes to answer "is ceiling pressure general, or was
 * `drizzle-cube#937` an outlier?". **No replay is needed.** Every scorecard
 * already carries the answer per case: `review.pipeline.byFamily[*].obligations`
 * is what each family kept, and `review.pipeline.obligationsDropped[]` carries
 * one reason per family naming the ceiling that refused the rest. This reads
 * those, over any number of runs, for $0.
 *
 * ── The two shapes, which are not the same problem ──────────────────────────
 *
 * `#937` is *one family at its ceiling while three mint nothing* — a starved
 * document that is also capped, where reallocating unclaimed slots would at
 * least have something to move. Measured across the ceilings-era gate runs, the
 * COMMONER shape on that set is **everything capped at once**: four families at
 * their ceilings with one unused slot between them. On those cases there is no
 * surplus to sweep and only a higher ceiling does anything. A mechanism chosen
 * from the first shape and deployed against the second moves nothing.
 *
 * So the output separates them, per case, and never averages them together.
 *
 * ── What this cannot tell you ───────────────────────────────────────────────
 *
 * Whether the refused obligations were WORTH asking. Pressure is a fact about
 * the budget, not about conversion — `scripts/cap-sweep.ts` is the script that
 * looks in the tail. Read this one first to find out whether the tail is worth
 * looking in.
 *
 * It also reports, unprompted, any repeat group whose runs graded DIFFERENT case
 * sets. That is not this script's subject; it is here because the check is free
 * once the cards are loaded and because a band computed across unequal case sets
 * is the money trap that `diff-runs.ts` refuses a verdict over — and one such
 * group is sitting in the stored results today, four repeats of which two graded
 * six and four cases.
 *
 * READ-ONLY. No model, no network, no spend.
 *
 * Usage:
 *   npx tsx scripts/ceiling-pressure.ts <run|scorecard.json|dir-of-runs> [more ...]
 *       [--model <arm>] [--by-case] [--min-cases <n>]
 *
 * A positional may be a `scorecard.json`, the run directory holding one, or a
 * directory of run directories (`eval-results/pr-review`), which is expanded one
 * level — the same two-level layout `indexTier` and `clean.ts` walk.
 *
 * Examples:
 *   # every stored pr-review run
 *   npx tsx scripts/ceiling-pressure.ts ~/work/nearform-evals/eval-results/pr-review
 *
 *   # one arm's repeats, with the per-case detail
 *   npx tsx scripts/ceiling-pressure.ts .../2026-08-25_1118{01,02}-1c05f2d --by-case
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import chalk from "chalk";

import type { Scorecard } from "../src/report.js";
import type { InstanceResult, ReviewFamilyStats } from "../src/schema.js";

/**
 * The families this package's seeder holds a ceiling for.
 *
 * `spec` is deliberately absent — it is seeded harness-side by `review-spec.ts`
 * under its own `maxSpecObligations`, so it has no `FAMILY_CAPS` entry and its
 * zero is "seeded elsewhere", not "refused". Counting it as a zero-mint family
 * would report a fifth starving family on every case ever run.
 */
const CAPPED_FAMILIES = [
  "contract",
  "enforcement",
  "security",
  "state",
  "tests",
] as const;
type CappedFamily = (typeof CAPPED_FAMILIES)[number];

/**
 * The shipped ceilings, as a FALLBACK only.
 *
 * Runs measured before `code-facts` recorded `cap` on each family row carry no
 * ceiling of their own, and this is what they were measured under. A run that
 * DOES record one wins — an arm that varied a cap must not be read against the
 * shipped table, which is exactly the misreading this fallback could cause if it
 * were preferred. Marked in the output whenever it is used.
 */
const SHIPPED_CAPS: Record<CappedFamily, number> = {
  contract: 12,
  enforcement: 12,
  state: 8,
  security: 8,
  tests: 8,
};

/**
 * `tests` is dead at both ends — no seeder function, and the `coverage`
 * extractor it would read needs an artifact only `prepare` produces. It mints
 * zero on every case that has ever run, so including it in the zero-mint count
 * would put a permanent +1 on every row and drown the families whose zero means
 * something. Its ceiling is still reported when it is somehow non-zero.
 */
const STRUCTURALLY_DEAD: CappedFamily[] = ["tests"];

// ── Loading ─────────────────────────────────────────────────────────────────

function die(msg: string): never {
  console.error(chalk.red(`ceiling-pressure: ${msg}`));
  process.exit(1);
}

/**
 * Expand a positional into scorecard paths.
 *
 * Three accepted shapes, because all three are things a reader has in hand: the
 * card, the run dir (the id in every note and dashboard URL), and the tier dir
 * holding every run. The tier dir is expanded exactly ONE level — runs are
 * siblings and never nested, the same invariant `buildIndex` relies on.
 */
export function expandPositional(p: string): string[] {
  const abs = resolve(p);
  if (!existsSync(abs)) die(`no such path: ${abs}`);
  if (!statSync(abs).isDirectory()) return [abs];

  const own = join(abs, "scorecard.json");
  if (existsSync(own)) return [own];

  const children = readdirSync(abs)
    .map((child) => join(abs, child, "scorecard.json"))
    .filter((card) => existsSync(card))
    .sort();
  if (children.length === 0)
    die(`${abs} holds neither a scorecard.json nor any run that does`);
  return children;
}

export interface LoadedRun {
  /** The run id — the directory name, which is what every note refers to. */
  runId: string;
  path: string;
  card: Scorecard;
}

function loadRun(cardPath: string): LoadedRun | undefined {
  try {
    const card = JSON.parse(readFileSync(cardPath, "utf8")) as Scorecard;
    return { runId: basename(join(cardPath, "..")), path: cardPath, card };
  } catch {
    // A half-written card from a killed run is normal in a results tree. Skip
    // it by name rather than failing the sweep — the point is the aggregate.
    console.error(chalk.dim(`  (skipped unreadable ${cardPath})`));
    return undefined;
  }
}

// ── The per-case reading ────────────────────────────────────────────────────

export interface FamilyPressure {
  family: CappedFamily;
  kept: number;
  /** Pre-ceiling count. `undefined` on a run measured before it was recorded. */
  minted?: number;
  cap: number;
  /** Whether `cap` came off the run or from {@link SHIPPED_CAPS}. */
  capRecorded: boolean;
  /** From `obligationsDropped[]` — how many this family lost to its own ceiling. */
  droppedByCeiling: number;
  atCap: boolean;
  zeroMint: boolean;
}

export interface CasePressure {
  instanceId: string;
  families: FamilyPressure[];
  /** Σ (cap − kept) over the live families — what the budget did not spend. */
  unusedSlots: number;
  droppedByCeiling: number;
  /** Dropped at the document-wide backstop, which is a different claim. */
  droppedByBackstop: number;
  atCap: CappedFamily[];
  zeroMint: CappedFamily[];
  /** BOTH at once — the `#937` shape, where a surplus exists to reallocate. */
  starvedAndCapped: boolean;
  /** Every live family at its ceiling — the shape only a raise can move. */
  saturated: boolean;
}

/**
 * How many of THIS family's obligations a ceiling refused.
 *
 * The seeder writes one reason per family and names the family in it, which is
 * the only place the number lives on a run that predates the `minted` field. It
 * is matched on the reason's stable prefix plus ` for <family> —`; the em dash
 * is part of the emitted string and keeps `for security` from matching a reason
 * about a family whose name merely starts the same way.
 */
export function droppedFor(result: InstanceResult, family: string): number {
  const dropped = result.review?.pipeline?.obligationsDropped ?? [];
  for (const d of dropped) {
    const reason = d.reason ?? "";
    if (
      reason.startsWith("over the per-family ceiling of ") &&
      reason.includes(` for ${family} —`)
    ) {
      return d.count ?? 0;
    }
  }
  return 0;
}

function droppedByBackstop(result: InstanceResult): number {
  const dropped = result.review?.pipeline?.obligationsDropped ?? [];
  return (
    dropped.find((d) =>
      (d.reason ?? "").startsWith("over the total backstop of "),
    )?.count ?? 0
  );
}

/**
 * Which truncation mechanism was in force — and it is NOT safe to assume.
 *
 * Per-family ceilings landed 2026-08-25, superseding a pooled budget with
 * per-family floors. Reading a pre-ceilings run against `SHIPPED_CAPS` reports
 * "at its ceiling" for a family that had no ceiling: on the floors-era envelopes
 * `contract` took 17, 15 and 8 slots on three near-identical `1587` documents,
 * every one of which would read as capped-at-12 here and two of which EXCEED the
 * cap, which is impossible under the mechanism this script is about.
 *
 * So each run is classified, and only `ceilings` runs reach the aggregate:
 *
 * - `ceilings` — a recorded `cap`, or a `dropped[]` reason naming a per-family
 *   ceiling. Positive evidence, in the run's own artifacts.
 * - `pooled` — the pre-2026-08-25 wording (`per-PR budget`), or a family holding
 *   MORE than its shipped cap, which the ceilings make unreachable.
 * - `unknown` — neither. A run where no family came near a ceiling leaves no
 *   trace of which mechanism refused nothing, and guessing would put a
 *   zero-pressure row into whichever era's denominator the guess picked.
 */
export type Era = "ceilings" | "pooled" | "unknown";

export function eraOf(results: InstanceResult[]): Era {
  let sawCeilingReason = false;
  for (const r of results) {
    const pipeline = r.review?.pipeline;
    if (!pipeline?.byFamily) continue;
    for (const d of pipeline.obligationsDropped ?? []) {
      const reason = d.reason ?? "";
      if (reason.includes("per-PR budget")) return "pooled";
      if (reason.includes("per-family ceiling of ")) sawCeilingReason = true;
    }
    for (const family of CAPPED_FAMILIES) {
      const stats = pipeline.byFamily[family];
      if (stats?.cap !== undefined) sawCeilingReason = true;
      if ((stats?.obligations ?? 0) > (stats?.cap ?? SHIPPED_CAPS[family]))
        return "pooled";
    }
  }
  return sawCeilingReason ? "ceilings" : "unknown";
}

export function readCase(result: InstanceResult): CasePressure | undefined {
  const byFamily = result.review?.pipeline?.byFamily;
  if (!byFamily) return undefined;

  const families: FamilyPressure[] = [];
  for (const family of CAPPED_FAMILIES) {
    const stats: ReviewFamilyStats | undefined = byFamily[family];
    const kept = stats?.obligations ?? 0;
    const capRecorded = stats?.cap !== undefined;
    const cap = stats?.cap ?? SHIPPED_CAPS[family];
    // `minted` when the run recorded it; otherwise reconstruct it from the drop
    // count, which is exact for the same reason the truncation notice can use
    // it. Absent on a family the seeder never reached — 0 is a count, and
    // nobody counted.
    const reasonDrop = droppedFor(result, family);
    const minted =
      stats?.minted ??
      (reasonDrop > 0 || kept > 0 ? kept + reasonDrop : undefined);
    // The STRUCTURED field wins where it exists. Deriving this from the prose
    // reason is the dependency that let a reason rename kill the survey brief's
    // truncation notice for a week; the same rename would silence this number.
    const dropped =
      minted !== undefined ? Math.max(0, minted - kept) : reasonDrop;
    families.push({
      family,
      kept,
      minted,
      cap,
      capRecorded,
      droppedByCeiling: dropped,
      // At its ceiling is `kept >= cap`, not `dropped > 0`: a family that minted
      // exactly its cap is saturated and had nothing refused, and the budget
      // question is about the slot, not about the loss.
      atCap: cap > 0 && kept >= cap,
      zeroMint: kept === 0 && dropped === 0,
    });
  }

  const live = families.filter((f) => !STRUCTURALLY_DEAD.includes(f.family));
  const atCap = live.filter((f) => f.atCap).map((f) => f.family);
  const zeroMint = live.filter((f) => f.zeroMint).map((f) => f.family);
  const unusedSlots = live.reduce(
    (sum, f) => sum + Math.max(0, f.cap - f.kept),
    0,
  );

  return {
    instanceId: result.instance_id,
    families,
    unusedSlots,
    droppedByCeiling: live.reduce((sum, f) => sum + f.droppedByCeiling, 0),
    droppedByBackstop: droppedByBackstop(result),
    atCap,
    zeroMint,
    starvedAndCapped: atCap.length > 0 && zeroMint.length > 0,
    saturated: atCap.length > 0 && atCap.length === live.length,
  };
}

// ── Rendering ───────────────────────────────────────────────────────────────

const pad = (s: string, n: number) => s.padEnd(n);
const num = (n: number, w = 3) => String(n).padStart(w);

function renderRun(
  run: LoadedRun,
  cases: CasePressure[],
  era: Era,
  byCase: boolean,
): void {
  const overlay =
    run.card.meta?.overlay ?? run.card.meta?.model ?? "(unrecorded)";
  const usingFallback = cases.some((c) =>
    c.families.some((f) => !f.capRecorded),
  );
  const eraTag =
    era === "ceilings"
      ? ""
      : era === "pooled"
        ? chalk.red("  [pooled budget — pre-2026-08-25, no ceilings existed]")
        : chalk.yellow(
            "  [era unknown — nothing was refused, so nothing recorded which mechanism]",
          );

  console.log(
    `\n${chalk.bold(run.runId)}  ${chalk.dim(overlay)}  ${chalk.dim(`${cases.length} case(s) with a pipeline`)}${eraTag}`,
  );
  if (usingFallback && era === "ceilings") {
    console.log(
      chalk.dim(
        "  ceilings not recorded on this run — read against the SHIPPED table (12/12/8/8/8)",
      ),
    );
  }

  if (byCase) {
    const live = CAPPED_FAMILIES.filter((f) => !STRUCTURALLY_DEAD.includes(f));
    console.log(
      chalk.dim(
        `  ${pad("case", 28)}${live.map((f) => pad(f.slice(0, 7), 9)).join("")}  drop  unused  shape`,
      ),
    );
    for (const c of cases) {
      const cells = live.map((family) => {
        const f = c.families.find((x) => x.family === family);
        if (!f) return pad("-", 9);
        // Pad FIRST, colour second. Padding a chalk-wrapped string counts the
        // ANSI escapes as width and the columns walk off to the right.
        const cell = pad(`${f.kept}/${f.cap === Infinity ? "∞" : f.cap}`, 9);
        return f.atCap
          ? chalk.yellow.bold(cell)
          : f.zeroMint
            ? chalk.red(cell)
            : cell;
      });
      const shape = c.saturated
        ? chalk.yellow("SATURATED")
        : c.starvedAndCapped
          ? chalk.red("STARVED+CAPPED")
          : c.atCap.length
            ? "capped"
            : "";
      console.log(
        `  ${pad(c.instanceId.replace(/^prreview__/, ""), 28)}${cells.join("")}${num(c.droppedByCeiling, 6)}${num(c.unusedSlots, 8)}  ${shape}`,
      );
    }
  }

  const saturated = cases.filter((c) => c.saturated).length;
  const starved = cases.filter((c) => c.starvedAndCapped).length;
  const anyCap = cases.filter((c) => c.atCap.length > 0).length;
  const backstop = cases.filter((c) => c.droppedByBackstop > 0).length;
  console.log(
    `  ${chalk.bold("pressure")}  ${anyCap}/${cases.length} case(s) with a family at its ceiling` +
      `  ·  ${chalk.yellow(`${saturated} saturated`)}` +
      `  ·  ${chalk.red(`${starved} starved+capped`)}` +
      (backstop > 0 ? `  ·  ${backstop} hit the document backstop` : ""),
  );
}

/**
 * A repeat group whose runs graded different case sets.
 *
 * Free to check once the cards are loaded, and worth checking every time: a
 * band over unequal case sets has a moving gold denominator, which is why
 * `diff-runs.ts` refuses a verdict on one. It has happened — and went unnoticed
 * — on a four-repeat group in the stored results.
 */
function renderIncompleteGroups(runs: LoadedRun[]): void {
  const groups = new Map<string, LoadedRun[]>();
  for (const run of runs) {
    const group = run.card.meta?.repeat?.group;
    if (!group) continue;
    groups.set(group, [...(groups.get(group) ?? []), run]);
  }

  const bad: string[] = [];
  for (const [group, members] of groups) {
    const sizes = members.map((m) => m.card.results?.length ?? 0);
    if (new Set(sizes).size > 1) {
      bad.push(
        `  ${chalk.red(group)}  graded ${members
          .map((m, i) => `${m.runId.slice(11, 17)}=${sizes[i]}`)
          .join(", ")} case(s)`,
      );
    }
  }
  if (bad.length === 0) return;
  console.log(chalk.bold.red("\nREPEAT GROUPS THAT ARE NOT A BAND"));
  console.log(
    chalk.dim(
      "  The gold denominator moves with the case set, so mean recall across these is not comparable\n" +
        "  and diff-runs.ts refuses a verdict over them. Re-run the short repeats before reading the band.",
    ),
  );
  for (const line of bad) console.log(line);
}

// ── Entry ───────────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)): number {
  const positionals: string[] = [];
  let byCase = false;
  let minCases = 1;
  let arm: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--by-case") byCase = true;
    else if (a === "--model") arm = argv[++i];
    else if (a === "--min-cases") minCases = Number(argv[++i]);
    else if (a.startsWith("--")) die(`unknown flag ${a}`);
    else positionals.push(a);
  }
  if (positionals.length === 0) {
    die("give me a run dir, a scorecard.json, or a directory of runs");
  }

  const cardPaths = [...new Set(positionals.flatMap(expandPositional))];
  const runs = cardPaths
    .map(loadRun)
    .filter((r): r is LoadedRun => r !== undefined);

  console.log(
    chalk.bold(
      `\nCEILING PRESSURE  ${chalk.dim(`— ${runs.length} run(s), read from stored scorecards. No spend.`)}`,
    ),
  );

  let totalCases = 0;
  let totalSaturated = 0;
  let totalStarved = 0;
  let totalAnyCap = 0;
  let shown = 0;
  let countedRuns = 0;
  const excluded: Record<Exclude<Era, "ceilings">, number> = {
    pooled: 0,
    unknown: 0,
  };

  for (const run of runs) {
    const results = (run.card.results ?? []).filter(
      (r) => !arm || r.model === arm,
    );
    const cases = results
      .map(readCase)
      .filter((c): c is CasePressure => c !== undefined);
    if (cases.length < minCases) continue;
    shown++;
    const era = eraOf(results);
    renderRun(run, cases, era, byCase);
    if (era !== "ceilings") {
      excluded[era]++;
      continue;
    }
    countedRuns++;
    totalCases += cases.length;
    totalSaturated += cases.filter((c) => c.saturated).length;
    totalStarved += cases.filter((c) => c.starvedAndCapped).length;
    totalAnyCap += cases.filter((c) => c.atCap.length > 0).length;
  }

  if (shown === 0) {
    // Absent is not zero: a baseline arm runs no pipeline and writes no
    // byFamily, and reporting "0 pressure" for it would be a claim about a
    // mechanism that never ran.
    console.log(
      chalk.yellow(
        "\n  No run carried review.pipeline.byFamily — these arms ran no evidence pipeline.",
      ),
    );
    renderIncompleteGroups(runs);
    return 0;
  }

  if (countedRuns === 0) {
    console.log(
      chalk.yellow(
        `\n  No CEILINGS-ERA run among the ${shown} shown — nothing to aggregate. The per-family ceiling\n` +
          "  landed 2026-08-25; before it a pooled budget with floors was in force, and reading those\n" +
          "  runs against today's table reports a ceiling that did not exist.",
      ),
    );
    renderIncompleteGroups(runs);
    console.log("");
    return 0;
  }

  const pct = (n: number) =>
    totalCases ? ((100 * n) / totalCases).toFixed(0) : "0";
  console.log(
    chalk.bold(
      `\nACROSS ${countedRuns} CEILINGS-ERA RUN(S), ${totalCases} CASE-RUNS`,
    ),
  );
  if (excluded.pooled || excluded.unknown) {
    console.log(
      chalk.dim(
        `  excluded: ${excluded.pooled} pooled-budget run(s), ${excluded.unknown} of unknown era — a mechanism\n` +
          "  that did not exist cannot have bound, and averaging them in would understate today's pressure.",
      ),
    );
  }
  const row = (label: string, n: number, note: string) =>
    `  ${pad(label, 34)}${num(n, 4)}  (${pct(n).padStart(3)}%)   ${chalk.dim(note)}`;
  console.log(
    [
      row("a family at its ceiling", totalAnyCap, ""),
      row(
        "every live family capped",
        totalSaturated,
        "← only a raised ceiling moves these",
      ),
      row(
        "capped, and a family minted zero",
        totalStarved,
        "← the #937 shape; a surplus exists here",
      ),
    ].join("\n"),
  );
  console.log(
    chalk.dim(
      "\n  Pressure is a fact about the budget, not about conversion. Whether the refused\n" +
        "  obligations were worth asking is scripts/cap-sweep.ts, which looks in the tail.",
    ),
  );

  renderIncompleteGroups(runs);
  console.log("");
  return 0;
}

// Only when run as a script, so the helpers above stay importable from a test.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
