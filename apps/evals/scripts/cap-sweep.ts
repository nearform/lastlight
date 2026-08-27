#!/usr/bin/env -S npx tsx
/**
 * What is in the tail the per-family ceiling refused — and would any of it have
 * reached gold?
 *
 * `scripts/ceiling-pressure.ts` establishes that the ceilings BIND, on most of
 * the gate cases. That is a fact about the budget and says nothing about whether
 * the refused obligations were worth asking. This script answers the second
 * question, offline and for **$0**: the seeder is a pure function of `facts.json`
 * with no network and no model, so the same envelope can be re-seeded at any
 * ceiling and the resulting obligation sets compared against the human gold.
 *
 * ── The oracle, and exactly how weak it is ──────────────────────────────────
 *
 * Gold carries `file` + `line`. An obligation names two sites — where a
 * mechanism is introduced, and where it would have to be enforced. This reports
 * a gold as **NAMED** when some obligation names a site in the gold's file
 * within `--window` lines of it.
 *
 * That is a *necessary-ish, not sufficient* condition, in both directions, and
 * neither slack is small:
 *
 * - **Naming a line is not finding the defect.** The survey still has to convert
 *   it, and LD3's IRIS ablation measured a badly-shaped seed at −3 — worse than
 *   no seed. A gold that goes from unnamed to named has become *reachable*, not
 *   found.
 * - **An unnamed gold is not unreachable.** Four of the five families work the
 *   diff directly when they mint nothing, and the `spec` axis is seeded from the
 *   PR body, which this envelope cannot see at all.
 *
 * So the number this produces bounds a decision — *is there anything in the
 * tail?* — and cannot settle one. If the tail names gold the shipped ceiling
 * does not, that is the case for a paid arm at a raised ceiling. If it names
 * nothing new, the ceiling is not the constraint and no arm should be bought.
 *
 * ── Why the marginal RANK is the number to read ─────────────────────────────
 *
 * "Uncapped names two more gold" is not actionable — uncapped is not a shipping
 * configuration, and the cost is per survey branch, so an unbounded `contract`
 * brief is the fattest branch of a fan-out whose wall clock is its maximum. What
 * IS actionable is the position, within its own family's rank order, of the
 * obligation that named the gold: a gold named at contract-position 15 says
 * "ceiling 15 would have reached it", against today's 12. That is a ceiling
 * proposal with a price attached.
 *
 * NO MODEL, NO NETWORK, NO SPEND. It shells out to `lastlight-facts` (resolved
 * through §D1's order, same as every arm) and caches each envelope, because the
 * envelope is deterministic and the second sweep should be free.
 *
 * Usage:
 *   npx tsx scripts/cap-sweep.ts [--cases all|<id,...>] [--caps <arm,...>]
 *       [--datasets <dir>] [--repos <dir>] [--cache <dir>] [--window <n>]
 *       [--mint <spec>] [--refresh]
 *
 *   --caps    comma-list of arms. Each is a preset (`shipped`, `2x`, `uncapped`)
 *             or a literal `--family-caps` spec (`contract=20,state=12`).
 *             Default `shipped,2x,uncapped`.
 *   --window  how near a gold's line an obligation site must be. Default 25.
 *   --refresh re-extract the facts envelopes even when cached.
 *
 * Example:
 *   npx tsx scripts/cap-sweep.ts --cases prreview__skillspro-1587-r3 --caps shipped,uncapped
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import chalk from "chalk";

import { resolveFactsBin } from "../src/paths.js";

const DEFAULT_DATASETS = join(
  homedir(),
  "work",
  "nearform-evals",
  "evals",
  "datasets",
  "pr-review",
);
const DEFAULT_REPOS = join(
  homedir(),
  "work",
  "nearform-evals",
  ".eval-cache",
  "repos",
);
const DEFAULT_CACHE = join(homedir(), ".cache", "lastlight-cap-sweep");

/**
 * The mint arms the gate set is measured under.
 *
 * Defaulted to the SHIPPED measurement configuration (`wp3-minimal-d2ab`) rather
 * than to the seeder's own baseline, because the question is about the ceiling
 * that binds on the documents we actually produce. A sweep run at the seeder
 * default would be truncating a different, smaller candidate set and its
 * "uncapped" arm would understate the tail.
 */
const DEFAULT_MINT = "all-in-diff,registrations";

const CAP_PRESETS: Record<string, string> = {
  shipped: "",
  "2x": "contract=24,enforcement=24,state=16,security=16,tests=16",
  uncapped:
    "contract=none,enforcement=none,state=none,security=none,tests=none",
};

interface GoldComment {
  file?: string;
  line?: number;
  severity?: string;
  description?: string;
}

interface Instance {
  instance_id: string;
  pr?: { base_commit?: string; head_commit?: string };
  review_gold?: GoldComment[];
}

interface Obligation {
  id: string;
  family: string;
  rank: number;
  introducedAt: { path: string; line: number; quote: string };
  enforcedAt: { candidates: string[] };
  question: string;
}

interface ObligationsDocument {
  families: {
    family: string;
    obligations: number;
    minted?: number;
    cap?: number | null;
  }[];
  obligations: Obligation[];
  dropped: { reason: string; count: number }[];
}

function die(msg: string): never {
  console.error(chalk.red(`cap-sweep: ${msg}`));
  process.exit(1);
}

function sh(cmd: string, args: string[], cwd?: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}

// ── Facts, extracted once and cached ────────────────────────────────────────

/**
 * Materialise a checkout and extract the envelope.
 *
 * `clone --shared` links the object store of the eval cache's bare repo instead
 * of copying it — seconds rather than minutes, and the cache is only ever read.
 * The checkout is DETACHED at the PR head, which is what `seedWorkspacePrReview`
 * does at run time; anything else would extract facts about a tree no arm ever
 * reviewed.
 */
function extractFacts(
  instance: Instance,
  // No `mint` here on purpose — the envelope is mint-INDEPENDENT, so one cached
  // extraction serves every minting arm and the cache key must not pretend
  // otherwise.
  opts: { factsBin: string; repos: string; cache: string; refresh: boolean },
): string {
  const out = join(opts.cache, `${instance.instance_id}.facts.json`);
  if (existsSync(out) && !opts.refresh) return out;

  const base = instance.pr?.base_commit;
  const head = instance.pr?.head_commit;
  if (!base || !head)
    die(`${instance.instance_id} has no pr.base_commit / pr.head_commit`);

  // `nearform/skillspro` → `nearform__skillspro.git`, the eval cache's layout.
  const bare = join(
    opts.repos,
    `${(instance as { repo?: string }).repo?.replace("/", "__") ?? ""}.git`,
  );
  if (!existsSync(bare)) {
    die(
      `no cached clone at ${bare}. The sweep reads the eval cache rather than the network — ` +
        `run the tier once, or point --repos at a directory that has it.`,
    );
  }

  const work = join(opts.cache, `work-${instance.instance_id}`);
  rmSync(work, { recursive: true, force: true });
  console.log(
    chalk.dim(`  ${instance.instance_id}: checkout @ ${head.slice(0, 8)}`),
  );
  sh("git", [
    "-c",
    "advice.detachedHead=false",
    "clone",
    "--shared",
    "--no-checkout",
    bare,
    work,
  ]);
  sh("git", ["-C", work, "checkout", "--detach", head]);

  console.log(chalk.dim(`  ${instance.instance_id}: lastlight-facts all …`));
  try {
    // NOTE: `--mint` is a `seed` flag, NOT an `all` flag — the minting rules run
    // over this envelope, they do not change it. Passing it here silently did
    // nothing and every arm seeded at baseline minting, which showed up as
    // `contract` 5 against the stored run's 59 while `enforcement` and `state`
    // — the two families no mint arm touches — matched to the obligation.
    sh(opts.factsBin, [
      "all",
      "--repo",
      work,
      "--base",
      base,
      "--head",
      head,
      "--out",
      out,
      "--never-fail",
    ]);
  } finally {
    // The tree was only ever an input to the extractor. Keeping eight checkouts
    // of a monorepo around to re-read a cached JSON file is not a trade.
    rmSync(work, { recursive: true, force: true });
  }
  if (!existsSync(out))
    die(`lastlight-facts wrote no envelope for ${instance.instance_id}`);
  return out;
}

/** Re-seed a cached envelope at one cap arm. Pure, offline, free. */
function seedAt(
  factsPath: string,
  spec: string,
  factsBin: string,
  mint: string,
): ObligationsDocument {
  const args = ["seed", "--facts", factsPath];
  // `--mint` belongs HERE, not on the extraction: the D2 rules are SEEDING rules
  // over a fixed envelope. Passing it to `all` is silently inert, and seeding the
  // gate set at baseline minting truncates a different, smaller candidate set —
  // so the "uncapped" arm understates the tail by exactly the obligations the
  // shipped configuration would have had. Measured while writing this: contract
  // read 5 against the stored run's 59, while `enforcement` and `state` — the two
  // families no mint arm touches — matched it to the obligation.
  if (mint) args.push("--mint", mint);
  if (spec) args.push("--family-caps", spec);
  // The total backstop is the ceilings' SUM by construction, so raising a
  // ceiling without raising it would silently re-truncate at 48 and the sweep
  // would measure the backstop while reporting the ceiling.
  if (spec) args.push("--max-obligations", "100000");
  return JSON.parse(sh(factsBin, args)) as ObligationsDocument;
}

// ── The oracle ──────────────────────────────────────────────────────────────

export interface Site {
  path: string;
  line: number;
}

/** Every site an obligation names: both ends of its mechanism. */
export function sitesOf(o: Obligation): Site[] {
  const sites: Site[] = [
    { path: o.introducedAt.path, line: o.introducedAt.line },
  ];
  for (const candidate of o.enforcedAt?.candidates ?? []) {
    // `path:line`, and a path may itself contain a colon on no platform we
    // support — split from the RIGHT so a Windows-ish drive letter could not
    // steal the line number.
    const at = candidate.lastIndexOf(":");
    if (at < 0) continue;
    const line = Number(candidate.slice(at + 1));
    if (Number.isFinite(line))
      sites.push({ path: candidate.slice(0, at), line });
  }
  return sites;
}

/**
 * Position of each obligation within its OWN family's rank order.
 *
 * This is what a ceiling cuts on, so it is what a "would ceiling N have reached
 * it?" answer has to be expressed in. Computed off the document's own order,
 * which the seeder guarantees is global rank order — the same single pass
 * `applyFamilyCaps` makes.
 */
export function familyPositions(doc: ObligationsDocument): Map<string, number> {
  const seen = new Map<string, number>();
  const position = new Map<string, number>();
  for (const o of doc.obligations) {
    const next = (seen.get(o.family) ?? 0) + 1;
    seen.set(o.family, next);
    position.set(o.id, next);
  }
  return position;
}

export interface GoldHit {
  gold: GoldComment;
  /** The nearest obligation naming this gold's file, if any. */
  obligation?: Obligation;
  /** That obligation's position within its own family — the ceiling it needs. */
  position?: number;
  distance?: number;
}

/**
 * Which obligations name a gold's site, nearest first.
 *
 * Nearest wins because the cheapest ceiling is the number we want to report: if
 * two obligations name the gold, the one earlier in its family's order is the
 * one a smaller raise would have kept.
 */
export function matchGold(
  gold: GoldComment,
  doc: ObligationsDocument,
  positions: Map<string, number>,
  window: number,
): GoldHit {
  if (!gold.file || gold.line === undefined) return { gold };
  let best: GoldHit = { gold };
  for (const o of doc.obligations) {
    for (const site of sitesOf(o)) {
      if (site.path !== gold.file) continue;
      const distance = Math.abs(site.line - gold.line);
      if (distance > window) continue;
      const position = positions.get(o.id) ?? Infinity;
      // Nearer wins; on a tie the earlier family position wins, because that is
      // the one a smaller ceiling would have kept.
      if (
        best.obligation === undefined ||
        position < (best.position ?? Infinity) ||
        (position === best.position && distance < (best.distance ?? Infinity))
      ) {
        best = { gold, obligation: o, position, distance };
      }
    }
  }
  return best;
}

// ── Entry ───────────────────────────────────────────────────────────────────

interface Args {
  cases: string[] | "all";
  caps: string[];
  datasets: string;
  repos: string;
  cache: string;
  window: number;
  mint: string;
  refresh: boolean;
}

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    cases: "all",
    caps: ["shipped", "2x", "uncapped"],
    datasets: DEFAULT_DATASETS,
    repos: DEFAULT_REPOS,
    cache: DEFAULT_CACHE,
    window: 25,
    mint: DEFAULT_MINT,
    refresh: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--cases")
      ((a.cases = value === "all" ? "all" : value.split(",")), i++);
    else if (flag === "--caps") ((a.caps = value.split(",")), i++);
    else if (flag === "--datasets") ((a.datasets = resolve(value)), i++);
    else if (flag === "--repos") ((a.repos = resolve(value)), i++);
    else if (flag === "--cache") ((a.cache = resolve(value)), i++);
    else if (flag === "--window") ((a.window = Number(value)), i++);
    else if (flag === "--mint") ((a.mint = value), i++);
    else if (flag === "--refresh") a.refresh = true;
    else die(`unknown flag ${flag}`);
  }
  if (!Number.isFinite(a.window) || a.window < 0)
    die(`--window must be a non-negative number`);
  return a;
}

export function main(argv = process.argv.slice(2)): number {
  const args = parseArgs(argv);

  const factsBin = resolveFactsBin();
  if (!factsBin) {
    die(
      "no lastlight-facts on LASTLIGHT_FACTS_BIN, PATH, or the baked path. Build it first:\n" +
        "  pnpm --filter lastlight-code-facts build\n" +
        "  export LASTLIGHT_FACTS_BIN=$PWD/packages/code-facts/dist/cli.js",
    );
  }

  const instancesPath = join(args.datasets, "instances.json");
  if (!existsSync(instancesPath)) die(`no instances.json at ${instancesPath}`);
  const all = JSON.parse(readFileSync(instancesPath, "utf8")) as Instance[];
  const instances =
    args.cases === "all"
      ? all
      : all.filter((i) => (args.cases as string[]).includes(i.instance_id));
  if (instances.length === 0)
    die(`no case matched ${JSON.stringify(args.cases)}`);

  mkdirSync(args.cache, { recursive: true });

  console.log(
    chalk.bold(
      `\nCAP SWEEP  ${chalk.dim(`— ${instances.length} case(s), ${args.caps.length} arm(s). No model, no network, no spend.`)}`,
    ),
  );
  console.log(
    chalk.dim(
      `  facts: ${factsBin}\n  mint:  ${args.mint}\n  gold is NAMED when an obligation names a site within ±${args.window} lines of it.`,
    ),
  );

  const goldTotals = { shipped: 0, best: 0, total: 0 };
  const reachable: string[] = [];

  for (const instance of instances) {
    const gold = instance.review_gold ?? [];
    const facts = extractFacts(instance, { factsBin, ...args });

    console.log(
      `\n${chalk.bold(instance.instance_id.replace(/^prreview__/, ""))}  ${chalk.dim(`${gold.length} gold`)}`,
    );
    if (gold.length === 0) {
      console.log(
        chalk.dim(
          "  no gold — the precision canary. Nothing for this oracle to say.",
        ),
      );
      continue;
    }

    // Arm → per-gold hit, so the marginal golds can be named at the end.
    const perArm = new Map<string, GoldHit[]>();
    for (const arm of args.caps) {
      const spec = arm in CAP_PRESETS ? CAP_PRESETS[arm] : arm;
      const doc = seedAt(facts, spec, factsBin, args.mint);
      const positions = familyPositions(doc);
      const hits = gold.map((g) => matchGold(g, doc, positions, args.window));
      perArm.set(arm, hits);

      const named = hits.filter((h) => h.obligation).length;
      const counts = doc.families
        .filter((f) => f.family !== "spec" && f.family !== "tests")
        .map((f) => `${f.family.slice(0, 4)} ${f.obligations}`)
        .join("  ");
      console.log(
        `  ${chalk.bold(arm.padEnd(9))} ${String(doc.obligations.length).padStart(4)} obligations  ` +
          `${chalk.dim(counts.padEnd(38))}  gold named ${named === gold.length ? chalk.green(`${named}/${gold.length}`) : `${named}/${gold.length}`}`,
      );
    }

    // The marginal golds: named by some arm, NOT named at the shipped ceiling.
    const shipped = perArm.get("shipped");
    const shippedNamed = new Set(
      (shipped ?? [])
        .map((h, i) => (h.obligation ? i : -1))
        .filter((i) => i >= 0),
    );
    goldTotals.total += gold.length;
    goldTotals.shipped += shippedNamed.size;

    const bestNamed = new Set(shippedNamed);
    for (const [arm, hits] of perArm) {
      if (arm === "shipped") continue;
      hits.forEach((h, i) => {
        if (!h.obligation || shippedNamed.has(i)) return;
        bestNamed.add(i);
        const g = h.gold;
        const family = h.obligation.family;
        console.log(
          `    ${chalk.yellow("↑")} gold @ ${chalk.bold(`${g.file}:${g.line}`)} ${chalk.dim(`(${g.severity})`)}\n` +
            `      named only past the ceiling, by ${chalk.bold(`${family}#${h.position}`)}` +
            ` ${chalk.dim(`(±${h.distance} lines, rank ${h.obligation.rank})`)}\n` +
            `      ${chalk.dim(`→ a ${family} ceiling of ${h.position} would have kept it; today it is 12/12/8/8.`)}\n` +
            `      ${chalk.dim(h.obligation.question.slice(0, 110))}`,
        );
        reachable.push(
          `${instance.instance_id} ${g.file}:${g.line} → ${family}#${h.position}`,
        );
      });
    }
    goldTotals.best += bestNamed.size;
  }

  console.log(chalk.bold(`\nACROSS ${instances.length} CASE(S)`));
  console.log(
    `  gold named at the SHIPPED ceiling   ${String(goldTotals.shipped).padStart(3)}/${goldTotals.total}\n` +
      `  gold named by ANY arm               ${String(goldTotals.best).padStart(3)}/${goldTotals.total}\n` +
      `  reachable only past the ceiling     ${String(goldTotals.best - goldTotals.shipped).padStart(3)}`,
  );
  if (goldTotals.best === goldTotals.shipped) {
    console.log(
      chalk.green(
        "\n  The tail names no gold the shipped ceiling does not. On this evidence the ceiling\n" +
          "  is not what is costing recall, and no paid arm should be bought to raise it.",
      ),
    );
  } else {
    console.log(chalk.yellow(`\n  Reachable only past the ceiling:`));
    for (const line of reachable) console.log(`    ${line}`);
    console.log(
      chalk.dim(
        "\n  NAMED is not FOUND. The survey still has to convert the obligation, and IRIS measured a\n" +
          "  badly-shaped seed at −3 against no seed at all. This bounds the decision; it does not make it.",
      ),
    );
  }
  console.log("");
  return 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  process.exit(main());
}
