#!/usr/bin/env -S npx tsx
/**
 * Read N repeats of ONE arm as a **band** — the headless counterpart to the
 * dashboard's repeat view.
 *
 * `varianceRollup` / `bandVerdict` / `groupRepeats` have existed (and been
 * tested) since `--repeats N` shipped, and nothing on the CLI ever called them:
 * union and intersection recall — the two numbers a repeat group exists to
 * produce — were reachable only through the browser. This is that path.
 *
 * It prints, for each arm:
 *   - the per-repeat points (runId, micro-recall, precision, SNR, posted, matched),
 *   - mean / min / max and the **band** (`max − min`, and NULL below two repeats:
 *     one run cannot bound its own noise, and a zero band lets any delta clear it),
 *   - **union** recall (found by ≥ 1 repeat — the ceiling sampling throws away)
 *     and **intersection** recall (found by EVERY repeat — what a user actually
 *     gets each time),
 *   - the per-gold hit matrix, one row per gold finding, one column per repeat,
 *   - and every case that could not be aligned across the repeats, BY NAME.
 *
 * With a `--vs` group it runs {@link bandVerdict}: the first group is the
 * BASELINE and the group after `--vs` is the CANDIDATE, the same order as
 * `diff-runs.ts`. A delta only counts if it clears the baseline's measured band.
 *
 * ── The arm→run mapping is an INPUT, never an inference ──────────────────────
 *
 * The paths you pass ARE the group. `meta.repeat` is used only to *audit* that
 * choice (and to order the columns when it is present) — never to expand it.
 * The three preserved 2026-08-22 `wp3` runs carry no `meta.repeat` and no
 * `meta.overlay` at all: they predate both stamps, and the *baseline* run of the
 * same day has the same tier, the same run type, the same arm label and the same
 * eight cases. Any heuristic that groups on those fields groups the baseline in
 * with the candidates and reports a band that spans two configurations. So this
 * script infers nothing and says so in its output.
 *
 * READ-ONLY — it never writes or mutates anything. No model, no spend.
 *
 * Usage:
 *   npx tsx scripts/band.ts <run|scorecard.json> [more ...] \
 *       [--model <arm>] [--tier <tier>] [--no-matrix] \
 *       [--vs <run|scorecard.json> [more ...]]
 *
 * A positional may be a `scorecard.json` or the run directory holding one.
 * `--model` picks the arm when a card carries several (exact, else a unique
 * case-insensitive substring) — `varianceRollup` micro-aggregates every arm in a
 * card together if you don't. `--tier` does the same for a run spanning tiers.
 *
 * Examples:
 *   # the preserved wp3 band (union 0.440, intersection 0.040 over 25 gold)
 *   npx tsx scripts/band.ts ~/work/nearform-evals/eval-results/pr-review/2026-08-22_{184650-00cc469,194234-00cc469,201607-64862d5}
 *
 *   # baseline (1 run) vs that band
 *   npx tsx scripts/band.ts .../2026-08-22_183835-00cc469 --vs .../2026-08-22_184650-00cc469 ...
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import chalk from "chalk";

import type { InstanceResult } from "../src/schema.js";
import { groupRepeats, type Scorecard } from "../src/report.js";
import {
  DETECTION_FLOOR_MICRO_RECALL,
  bandVerdict,
  varianceRollup,
  type RepeatCard,
  type VarianceRollup,
} from "../src/review-metrics.js";

// ── Loading ─────────────────────────────────────────────────────────────────

export interface LoadedCard {
  /** The path as given, for error messages. */
  path: string;
  card: Scorecard;
}

function die(msg: string): never {
  console.error(chalk.red(`band: ${msg}`));
  process.exit(1);
}

/**
 * Accept either a `scorecard.json` or the run directory that holds one.
 *
 * A run dir is what a reader has in hand (it is the id in every note and every
 * dashboard URL); making them append the filename is friction with no upside.
 */
export function resolveScorecardPath(p: string): string {
  const abs = resolve(p);
  if (existsSync(abs) && statSync(abs).isDirectory()) return join(abs, "scorecard.json");
  return abs;
}

export function loadCard(path: string): Scorecard {
  const abs = resolveScorecardPath(path);
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    die(`cannot read a scorecard at ${abs}`);
  }
  try {
    return JSON.parse(raw) as Scorecard;
  } catch {
    die(`${abs} is not valid JSON`);
  }
}

// ── Arm + tier selection ────────────────────────────────────────────────────

/** Every arm label appearing across a group's cards, in first-seen order. */
export function armLabels(cards: Scorecard[]): string[] {
  const seen = new Set<string>();
  for (const c of cards) for (const r of c.results ?? []) seen.add(r.model);
  return [...seen];
}

/**
 * Pick the arm: an explicit `--model` (exact, else a unique case-insensitive
 * substring), else the sole arm when the group has exactly one.
 *
 * There is no "all arms" mode on purpose. `varianceRollup` has no arm selector,
 * so handing it a multi-arm card silently micro-aggregates two different
 * configurations into one band — the single most misleading thing this script
 * could print.
 */
export function pickArm(cards: Scorecard[], want: string | undefined, which: string): string {
  const labels = armLabels(cards);
  if (want) {
    const exact = labels.find((l) => l === want);
    if (exact) return exact;
    const fuzzy = labels.filter((l) => l.toLowerCase().includes(want.toLowerCase()));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) die(`--model "${want}" is ambiguous in the ${which} group: ${fuzzy.join(", ")}`);
    die(`--model "${want}" is not in the ${which} group (have: ${labels.join(", ") || "none"})`);
  }
  if (labels.length === 1) return labels[0];
  if (!labels.length) die(`the ${which} group has no results at all`);
  die(`the ${which} group has ${labels.length} arms (${labels.join(", ")}); pass --model to choose one`);
}

/** A result's tier, falling back to the run's first tier for cards that predate
 * the per-result `tier` field. */
function tierOf(r: InstanceResult, card: Scorecard): string | undefined {
  return r.tier ?? card.meta?.tiers?.[0];
}

/**
 * One card narrowed to a single arm (and optionally a single tier), in the
 * structural shape `varianceRollup` reads.
 *
 * `meta` rides along unchanged so each repeat point keeps its real `runId`.
 */
export function armCard(card: Scorecard, arm: string, tier?: string): RepeatCard {
  const results = (card.results ?? []).filter((r) => r.model === arm && (!tier || tierOf(r, card) === tier));
  return { results, meta: card.meta };
}

// ── The audit (what the paths claim, checked against what they carry) ────────

export interface ArmAudit {
  /** The single `meta.repeat.group` when every card declares one. */
  group?: string;
  /** `meta.repeat.of` — how many repeats the band was launched as. */
  declaredOf?: number;
  /** Cards re-ordered by `meta.repeat.index` when every card carries one;
   * otherwise the order given on the command line, untouched. */
  ordered: LoadedCard[];
  /** Things a reader must know before believing the band. */
  warnings: string[];
  /** Things that are fine but worth stating (absent stamps, mostly). */
  notes: string[];
}

/**
 * Check the group the user asserted against what the scorecards actually say.
 *
 * This never CHANGES the group — the paths win, always (see the header). It only
 * reports: a mixed/absent `meta.repeat` stamp, a band launched as N with fewer
 * than N cards given, repeats that graded different case sets, and arms whose
 * recorded provenance differs (or, for the preserved runs, is absent entirely,
 * which means nothing here can prove they ran the same configuration).
 */
export function auditArm(cards: LoadedCard[], arm: string, tier?: string): ArmAudit {
  const warnings: string[] = [];
  const notes: string[] = [];

  const stamped = cards.filter((c) => c.card.meta?.repeat);
  let group: string | undefined;
  let declaredOf: number | undefined;
  let ordered = cards;

  if (stamped.length === cards.length && cards.length > 0) {
    // Every card is stamped — `groupRepeats` is authoritative about which band
    // they belong to and what order they ran in.
    const bands = groupRepeats(cards.map((c) => c.card));
    if (bands.length === 1) {
      group = bands[0].group;
      declaredOf = bands[0].of;
      const byRunId = new Map(cards.map((c) => [c.card.meta?.runId, c]));
      ordered = bands[0].cards.map((c) => byRunId.get(c.meta?.runId)!).filter(Boolean);
      if (cards.length < declaredOf) {
        warnings.push(
          `INTERRUPTED BAND — group ${group} was launched as ${declaredOf} repeats and you passed ${cards.length}. ` +
            `The missing repeat(s) are not "no data", they are unmeasured: mean/band/union are all over a truncated sample.`,
        );
      }
    } else {
      warnings.push(
        `these paths span ${bands.length} DIFFERENT repeat groups (${bands.map((b) => b.group).join(", ")}). ` +
          `They were not run as one band; the spread below mixes configurations unless you meant to.`,
      );
    }
  } else if (stamped.length) {
    warnings.push(
      `${stamped.length} of ${cards.length} card(s) carry meta.repeat and the rest do not — the group is exactly the ` +
        `paths you gave, and nothing verified the unstamped one belongs in it.`,
    );
  } else if (cards.length) {
    notes.push(
      `no card carries meta.repeat (they predate the stamp) — the arm→run mapping is exactly the paths you gave. ` +
        `Nothing here inferred it, deliberately: same tier + same arm + same case set also describes an unrelated run.`,
    );
  }

  // Repeats of one arm re-run the same cases. Different case sets ⇒ the micro
  // denominators differ and the band is over two different questions.
  const caseSets = cards.map((c) => {
    const ids = (c.card.results ?? [])
      .filter((r) => r.model === arm && (!tier || tierOf(r, c.card) === tier))
      .map((r) => r.instance_id);
    return [...new Set(ids)].sort();
  });
  const first = caseSets[0] ?? [];
  const differing = cards.filter((_, i) => caseSets[i].join("|") !== first.join("|"));
  if (differing.length) {
    warnings.push(
      `the repeats did NOT grade the same case set — ` +
        cards.map((c, i) => `${c.card.meta?.runId ?? c.path}: ${caseSets[i].length} case(s)`).join(", ") +
        `. Micro-recall over different denominators is not a band.`,
    );
  }

  // Provenance: two runs of "the same arm" that used different overlays are two
  // arms. Absent is its own answer and must not read as "the same".
  const overlays = new Set(cards.map((c) => c.card.meta?.overlay ?? " absent"));
  if (overlays.size > 1) {
    warnings.push(
      `the cards record DIFFERENT meta.overlay values (${[...overlays].map((o) => (o === " absent" ? "«absent»" : o)).join(", ")}) — ` +
        `these are not repeats of one arm.`,
    );
  } else if (overlays.has(" absent")) {
    notes.push(
      `no card records meta.overlay, so nothing in these artifacts can confirm they ran the same configuration. ` +
        `The grouping rests entirely on the paths you passed.`,
    );
  }

  return { group, declaredOf, ordered, warnings, notes };
}

// ── Gold descriptions (for a legible matrix) ────────────────────────────────

/**
 * `instance_id` → the gold findings' descriptions, from the first repeat that
 * carries a judge trace for that case.
 *
 * `varianceRollup` deliberately carries only the hit booleans (gold text is
 * private customer data and never enters an artifact this repo keeps), so the
 * labels are looked up here from the loaded cards and truncated on render.
 */
export function goldDescriptions(cards: Scorecard[], arm: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const card of cards) {
    for (const r of card.results ?? []) {
      if (r.model !== arm || out.has(r.instance_id)) continue;
      const gold = r.review?.trace?.gold;
      if (gold?.length) out.set(r.instance_id, gold.map((g) => g.description ?? ""));
    }
  }
  return out;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const ratio = (x: number | null | undefined): string =>
  x === null || x === undefined || !Number.isFinite(x) ? "  n/a" : x.toFixed(3);

const HIT = "●";
const MISS = "·";

function clip(s: string, n: number): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`;
}

function renderArm(
  title: string,
  roll: VarianceRollup,
  audit: ArmAudit,
  descriptions: Map<string, string[]>,
  showMatrix: boolean,
): void {
  const n = roll.repeats.length;
  console.log(chalk.bold.cyan(`\n${title}  —  ${n} repeat${n === 1 ? "" : "s"}`));
  if (audit.group) {
    console.log(chalk.dim(`  group ${audit.group}${audit.declaredOf ? `  (launched as ${audit.declaredOf})` : ""}`));
  }
  for (const w of audit.warnings) console.log(chalk.yellow(`  ⚠ ${w}`));
  for (const note of audit.notes) console.log(chalk.dim(`  · ${note}`));

  // ── The points ────────────────────────────────────────────────────────────
  console.log("");
  console.log(chalk.bold(`  ${"runId".padEnd(28)}  ${"μrec".padStart(6)}  ${"prec".padStart(6)}  ${"SNR".padStart(6)}  ${"posted".padStart(6)}  ${"matched".padStart(7)}  ${"gold".padStart(4)}`));
  console.log(chalk.dim(`  ${"-".repeat(28)}  ------  ------  ------  ------  -------  ----`));
  for (const p of roll.repeats) {
    console.log(
      `  ${p.runId.padEnd(28)}  ${ratio(p.microRecall).padStart(6)}  ${ratio(p.microPrecision).padStart(6)}  ` +
        `${ratio(p.snr).padStart(6)}  ${String(p.posted).padStart(6)}  ${String(p.matched).padStart(7)}  ${String(p.gold).padStart(4)}`,
    );
  }

  // ── The band ──────────────────────────────────────────────────────────────
  console.log("");
  console.log(
    `  mean ${chalk.bold(ratio(roll.meanMicroRecall))}   min ${ratio(roll.minMicroRecall)}   max ${ratio(roll.maxMicroRecall)}`,
  );
  if (roll.band === null) {
    // `VarianceRollup.band`'s own rule, printed rather than papered over: one
    // point's max − min is 0, and a zero band lets ANY delta clear it.
    console.log(
      chalk.yellow(
        `  BAND ${"NOT MEASURED".padEnd(6)}   — ${n} repeat${n === 1 ? "" : "s"}. A single run cannot bound its own noise; ` +
          `this arm has an UNKNOWN band, not a zero one.`,
      ),
    );
  } else {
    console.log(chalk.bold(`  BAND ${ratio(roll.band)}`) + chalk.dim(`   (max − min, over ${n} repeats)`));
    if (roll.band >= DETECTION_FLOOR_MICRO_RECALL) {
      console.log(
        chalk.yellow(
          `  ⚠ the band alone is ≥ the ${DETECTION_FLOOR_MICRO_RECALL.toFixed(2)} detection floor — this arm's run-to-run noise ` +
            `is as large as the largest effect this gold set can resolve.`,
        ),
      );
    }
  }

  // ── The numbers that matter ───────────────────────────────────────────────
  console.log("");
  const cases = roll.perInstance.length;
  console.log(chalk.bold(`  UNION / INTERSECTION`) + chalk.dim(`  (over ${roll.gold} gold in ${cases} aligned case${cases === 1 ? "" : "s"})`));
  console.log(
    `    union         ${chalk.bold(ratio(roll.unionRecall))}   (${roll.unionMatched} of ${roll.gold})   ` +
      chalk.dim("found by ≥ 1 repeat — the ceiling sampling is throwing away"),
  );
  console.log(
    `    intersection  ${chalk.bold(ratio(roll.intersectionRecall))}   (${roll.intersectionMatched} of ${roll.gold})   ` +
      chalk.dim("found by EVERY repeat — what a user would actually get each time"),
  );

  // ── Per-gold hit matrix ───────────────────────────────────────────────────
  if (showMatrix && roll.perInstance.length) {
    console.log("");
    console.log(chalk.bold(`  HIT MATRIX`) + chalk.dim(`  (one row per gold finding, one column per repeat — ${HIT} hit, ${MISS} miss)`));
    for (const m of roll.perInstance) {
      const descs = descriptions.get(m.instanceId) ?? [];
      console.log(chalk.dim(`\n    ${m.instanceId}   ${m.union}/${m.gold} union, ${m.intersection}/${m.gold} intersection`));
      m.rows.forEach((row, j) => {
        const cells = row.map((h) => (h ? chalk.green(HIT) : chalk.dim(MISS))).join(" ");
        const label = descs[j] ? clip(descs[j], 78) : `gold #${j + 1}`;
        console.log(`      ${String(j + 1).padStart(2)}  ${cells}   ${label}`);
      });
    }
  }

  // ── Untraced ──────────────────────────────────────────────────────────────
  console.log("");
  if (roll.untraced.length) {
    console.log(
      chalk.yellow(`  UNTRACED (${roll.untraced.length}) — excluded from the union/intersection maths entirely, not folded in as misses:`),
    );
    for (const id of roll.untraced) console.log(chalk.yellow(`    ${id}`));
    console.log(
      chalk.dim(
        `    A case lands here when a repeat had no judge trace for it, when a repeat did not grade it at all,\n` +
          `    or when the repeats' gold arrays differ in LENGTH (dataset drift — go and fix that, never pad it).`,
      ),
    );
  } else {
    console.log(chalk.dim(`  untraced: none — every case aligned across all ${n} repeat${n === 1 ? "" : "s"}.`));
  }
}

// ── Argv ────────────────────────────────────────────────────────────────────

export interface Args {
  base: string[];
  vs: string[];
  model?: string;
  tier?: string;
  matrix: boolean;
}

const VALUE_FLAGS = new Set(["--model", "--tier"]);

/** `--vs` is a SEPARATOR, not a flag with one value: every positional after it
 * belongs to the candidate group. Value flags may appear on either side. */
export function parseArgs(argv: string[]): Args {
  const out: Args = { base: [], vs: [], matrix: true };
  let target = out.base;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vs") {
      target = out.vs;
      continue;
    }
    if (a === "--no-matrix") {
      out.matrix = false;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      if (a === "--model") out.model = v;
      else out.tier = v;
      continue;
    }
    if (a.startsWith("--")) die(`unknown flag ${a}`);
    target.push(a);
  }
  return out;
}

// ── main ────────────────────────────────────────────────────────────────────

function buildArm(paths: string[], model: string | undefined, tier: string | undefined, which: string) {
  const loaded: LoadedCard[] = paths.map((p) => ({ path: p, card: loadCard(p) }));
  const arm = pickArm(loaded.map((l) => l.card), model, which);
  const audit = auditArm(loaded, arm, tier);
  const roll = varianceRollup(audit.ordered.map((l) => armCard(l.card, arm, tier)));
  const descriptions = goldDescriptions(audit.ordered.map((l) => l.card), arm);
  return { arm, audit, roll, descriptions };
}

export function main(argv: string[] = process.argv.slice(2)): number {
  const args = parseArgs(argv);
  if (!args.base.length) {
    die("need at least one scorecard path or run dir. See the usage header in this file.");
  }

  const base = buildArm(args.base, args.model, args.tier, "first");
  renderArm(`ARM  ${base.arm}${args.tier ? `  [tier ${args.tier}]` : ""}`, base.roll, base.audit, base.descriptions, args.matrix);

  if (!args.vs.length) {
    console.log("");
    return 0;
  }

  const cand = buildArm(args.vs, args.model, args.tier, "--vs");
  renderArm(
    `ARM (--vs)  ${cand.arm}${args.tier ? `  [tier ${args.tier}]` : ""}`,
    cand.roll,
    cand.audit,
    cand.descriptions,
    args.matrix,
  );

  // Baseline = the first group, candidate = the `--vs` group — the same order
  // `diff-runs.ts` takes its two scorecards in.
  const { verdict, reason, delta } = bandVerdict(base.roll, cand.roll);
  const colour = verdict === "KEEP" ? chalk.green : verdict === "REVERT" ? chalk.red : chalk.yellow;
  console.log(chalk.bold(`\nBAND VERDICT  (baseline = the first group, candidate = --vs)`));
  console.log(`  ${colour.bold(verdict)}${delta === null ? "" : chalk.dim(`   Δ ${delta >= 0 ? "+" : ""}${delta.toFixed(3)}`)}`);
  console.log(`  ${reason}`);
  console.log("");
  return 0;
}

// Only when run as a script — so the pure helpers above stay importable from a
// test (`main()` at module scope is what makes `run.ts` untestable).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
