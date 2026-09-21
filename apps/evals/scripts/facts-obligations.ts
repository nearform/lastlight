#!/usr/bin/env -S npx tsx
/**
 * The seeder's own funnel: of the gold a human reviewer wrote, how much did an
 * OBLIGATION ever name — and where in the seeder did the rest fall out?
 *
 * ## Why this exists
 *
 * `scripts/facts-evidence.ts` answers the question one step upstream: does the
 * deterministic *envelope* name the identifier the gold finding is about. That
 * is the ceiling on what facts-seeding could contribute. It does not ask
 * whether the seeder then **minted** an obligation about it, whether that
 * obligation **survived its family ceiling**, whether it reached a **brief**,
 * and whether a survey arm **discharged** it. Those four steps are where the
 * seeder's ranking decisions live, and until now nothing measured them.
 *
 * Five bars, each a subset of the one before:
 *
 *   located    the gold finding carries a file (skillspro gold does; Martian's
 *              does not, which is why `facts-anchors.ts` exists for that set)
 *   named      the envelope names that file at all
 *   minted     an obligation candidate names it at either end, ceilings OFF
 *   kept       it is still there with the shipped ceilings ON
 *   rendered   it reached the family brief the survey arm actually reads
 *   discharged a hypothesis cites that obligation's id
 *
 * The gap between `minted` and `kept` is the ceilings' cost in gold. The gap
 * between `kept` and `discharged` is the arm's. Both were guesses before this.
 *
 * ## What this is NOT
 *
 * **Every number here is a ceiling, exactly as in `facts-evidence.ts`.** An
 * obligation that names `users.ts:115` has not noticed that the netsuite
 * fallback returns `200 []`; it has put the file on the table. Naming is
 * necessary, never sufficient.
 *
 * It is also a **coarser bar than `facts-evidence.ts`'s**. That script scores at
 * the entity level against a frozen tokenizer. This one scores at file level,
 * with an optional line window, because skillspro gold carries `{file, line}`
 * and the preserved artifacts do not include the checkout needed to resolve
 * identifiers. File-level is reported as the headline; the window is reported
 * beside it and is strictly smaller. Do not mix these numbers with
 * `facts-evidence.ts`'s in one table.
 *
 * No model is involved anywhere, nothing is written unless `--out` is passed,
 * and this never asserts or tunes. It is a measurement script.
 *
 * ## Inputs, and why they are what they are
 *
 * The `$TMPDIR/ll-eval-*` workspaces the scorecards point at have been reaped
 * by macOS — the directories survive, their contents do not. The only preserved
 * pipeline artifacts are the copied-out keepers under
 * `~/lastlight-run-artifacts/`. That is fine for this measurement and it is the
 * reason it can run at all: `facts.json` is preserved, and **`seed` is a pure
 * function of it**, so the shipped seeder can be replayed over an envelope
 * captured before the seeder existed in its current form. The `minted`/`kept`/
 * `rendered` bars therefore describe TODAY'S seeder, not the run's.
 *
 * `discharged` is the exception: it reads the run's own `hypotheses/*.jsonl`,
 * which were produced against the run's obligation ids. It is reported only
 * when `--as-run` is passed, where the obligation document is the preserved one
 * and the ids line up.
 *
 * Usage:
 *   npx tsx scripts/facts-obligations.ts
 *       [--keepers <dir>]     default ~/lastlight-run-artifacts
 *       [--run <name>]        one keeper run (default: every run with >1 case)
 *       [--dataset <file>]    default <nearform-evals>/evals/datasets/pr-review/instances.json
 *       [--facts-bin <path>]  default the monorepo's built dist/cli.js
 *       [--window <n>]        line window for the tighter bar, default 40
 *       [--as-run]            score the run's OWN obligations.json instead of a
 *                             replay, and enable the `discharged` bar
 *       [--out <file.json>]   write the full per-gold scoring
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** The five bars, in order. Each is a subset of its predecessor. */
const BARS = ["located", "named", "minted", "kept", "rendered", "discharged"] as const;
type Bar = (typeof BARS)[number];

interface GoldFinding {
  file?: string;
  line?: number;
  severity?: string;
  description: string;
}

interface Instance {
  instance_id: string;
  review_gold?: GoldFinding[];
}

interface MechanismEnd {
  path: string;
  line: number;
  quote: string;
}

interface Obligation {
  id: string;
  family: string;
  mechanism: string;
  introducedAt: MechanismEnd;
  enforcedAt: { candidates: string[]; found: false };
  rank: number;
}

interface ObligationsDocument {
  obligations: Obligation[];
  families?: { family: string; obligations: number; minted: number; cap: number | null }[];
  dropped?: { reason: string; count: number }[];
}

/** One gold finding's walk down the funnel, plus why it stopped. */
interface GoldScore {
  run: string;
  case: string;
  file: string | null;
  line: number | null;
  severity: string | null;
  headline: string;
  bars: Record<Bar, boolean>;
  /** Tighter variant of `minted`/`kept`/`rendered`: file AND within the window. */
  barsWindowed: Record<Bar, boolean>;
  /** The obligations that named this gold's file, whichever bar they reached. */
  namedBy: {
    id: string;
    family: string;
    end: "introduced" | "enforced";
    line: number;
    rank: number;
    /** False when a family ceiling refused it — the `minted` ∖ `kept` set. */
    kept: boolean;
  }[];
  /** Present when the gold was minted but a ceiling refused it. */
  lostToCeiling: string[];
}

// ── arg parsing ──────────────────────────────────────────────────────────────

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  return next && !next.startsWith("--") ? next : "";
}
const has = (name: string): boolean => process.argv.includes(`--${name}`);

const KEEPERS = resolve(flag("keepers") ?? join(homedir(), "lastlight-run-artifacts"));
const DATASET = resolve(
  flag("dataset") ?? join(homedir(), "work/nearform-evals/evals/datasets/pr-review/instances.json"),
);
const FACTS_BIN = resolve(
  flag("facts-bin") ?? join(homedir(), "work/lastlight/packages/code-facts/dist/cli.js"),
);
const WINDOW = Number(flag("window") ?? 40);
const AS_RUN = has("as-run");
const ONLY_RUN = flag("run");
const OUT = flag("out");
/** Passed straight through to `seed --mint`, so the D2 arms are scorable here. */
const MINT = flag("mint");

// ── helpers ──────────────────────────────────────────────────────────────────

const readJson = <T>(p: string): T => JSON.parse(readFileSync(p, "utf8")) as T;

/** `src/a.ts:115 (test)` → `{path, line}`; a bare path yields line 0. */
function splitSite(site: string): { path: string; line: number } {
  const bare = site.replace(/\s+\(test\)$/, "");
  const m = /^(.*):(\d+)(?:-\d+)?$/.exec(bare);
  return m ? { path: m[1], line: Number(m[2]) } : { path: bare, line: 0 };
}

/**
 * Replay the SHIPPED seeder over a preserved envelope.
 *
 * `--family-caps <f>=none` for every family plus a very large backstop is the
 * uncapped run; the default invocation is the shipped one. Both go through the
 * real CLI rather than an in-process call, so what is measured is what ships.
 */
function seed(factsPath: string, uncapped: boolean): { doc: ObligationsDocument; blocks: Map<string, string> } {
  const dir = mkdtempSync(join(tmpdir(), "facts-obligations-"));
  try {
    const args = [
      FACTS_BIN,
      "seed",
      "--facts",
      factsPath,
      "--out",
      join(dir, "obligations.json"),
      "--blocks",
      join(dir, "blocks"),
    ];
    if (MINT) args.push("--mint", MINT);
    if (uncapped) {
      args.push(
        "--family-caps",
        "contract=none,enforcement=none,state=none,security=none,tests=none",
        "--max-obligations",
        "100000",
      );
    }
    execFileSync(process.execPath, args, { stdio: ["ignore", "ignore", "pipe"] });
    const doc = readJson<ObligationsDocument>(join(dir, "obligations.json"));
    const blocks = new Map<string, string>();
    const blockDir = join(dir, "blocks");
    if (existsSync(blockDir)) {
      for (const f of readdirSync(blockDir)) {
        blocks.set(f.replace(/\.md$/, ""), readFileSync(join(blockDir, f), "utf8"));
      }
    }
    return { doc, blocks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Every file the envelope names, from whichever extractor named it. */
function envelopeFiles(factsPath: string): Set<string> {
  const env = readJson<Record<string, any>>(factsPath);
  const x = env.extractors ?? {};
  const out = new Set<string>();
  for (const f of x.facts?.files ?? []) if (f?.path) out.add(f.path);
  for (const s of x.facts?.symbols ?? []) {
    const site = s?.declaredAt ? splitSite(s.declaredAt) : null;
    if (site) out.add(site.path);
    for (const r of s.references ?? []) out.add(splitSite(r.at).path);
  }
  for (const c of x.contracts?.contracts ?? []) if (c?.file) out.add(c.file);
  for (const c of x.constants?.constants ?? []) {
    if (c?.declaredAt) out.add(splitSite(c.declaredAt).path);
  }
  for (const p of x.patterns?.findings ?? []) if (p?.file) out.add(p.file);
  for (const c of x.coverage?.files ?? []) if (c?.path) out.add(c.path);
  return out;
}

/** Which obligations name `file`, at which end, and how far from `line`. */
function namersOf(
  obligations: Obligation[],
  file: string,
): { id: string; family: string; end: "introduced" | "enforced"; line: number; rank: number }[] {
  const out: ReturnType<typeof namersOf> = [];
  for (const o of obligations) {
    if (o.introducedAt?.path === file) {
      out.push({ id: o.id, family: o.family, end: "introduced", line: o.introducedAt.line, rank: o.rank });
    }
    for (const cand of o.enforcedAt?.candidates ?? []) {
      const s = splitSite(cand);
      if (s.path === file) {
        out.push({ id: o.id, family: o.family, end: "enforced", line: s.line, rank: o.rank });
      }
    }
  }
  return out;
}

// ── scoring ──────────────────────────────────────────────────────────────────

function scoreCase(run: string, caseDir: string, instanceId: string, gold: GoldFinding[]): GoldScore[] {
  const pr = join(caseDir, "pr-review");
  const factsPath = join(pr, "facts.json");
  if (!existsSync(factsPath)) return [];

  const named = envelopeFiles(factsPath);

  let keptDoc: ObligationsDocument;
  let mintedDoc: ObligationsDocument;
  let blocks: Map<string, string>;
  if (AS_RUN) {
    keptDoc = readJson<ObligationsDocument>(join(pr, "obligations.json"));
    // No uncapped counterpart exists for an as-run document; the replay supplies it.
    mintedDoc = seed(factsPath, true).doc;
    blocks = new Map();
    const blockDir = join(pr, "obligations");
    if (existsSync(blockDir)) {
      for (const f of readdirSync(blockDir)) {
        blocks.set(f.replace(/\.md$/, ""), readFileSync(join(blockDir, f), "utf8"));
      }
    }
  } else {
    const shipped = seed(factsPath, false);
    keptDoc = shipped.doc;
    blocks = shipped.blocks;
    mintedDoc = seed(factsPath, true).doc;
  }

  // Hypothesis → obligation ids, only meaningful when the ids are the run's own.
  const dischargedIds = new Set<string>();
  const hypDir = join(pr, "hypotheses");
  if (AS_RUN && existsSync(hypDir)) {
    for (const f of readdirSync(hypDir)) {
      for (const line of readFileSync(join(hypDir, f), "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const h = JSON.parse(line) as { obligation?: string; obligationId?: string };
          const id = h.obligation ?? h.obligationId;
          if (id) dischargedIds.add(id);
        } catch {
          /* a malformed line is the arm's problem, not the measurement's */
        }
      }
    }
  }

  return gold.map((g) => {
    const file = g.file ?? null;
    const line = g.line ?? null;
    const mintedNamers = file ? namersOf(mintedDoc.obligations, file) : [];
    const keptNamers = file ? namersOf(keptDoc.obligations, file) : [];
    const renderedNamers = keptNamers.filter((n) => (blocks.get(n.family) ?? "").includes(n.id));
    const dischargedNamers = renderedNamers.filter((n) => dischargedIds.has(n.id));

    const within = (ns: typeof keptNamers): boolean =>
      line === null ? false : ns.some((n) => n.line > 0 && Math.abs(n.line - line) <= WINDOW);

    const bars: Record<Bar, boolean> = {
      located: file !== null,
      named: file !== null && named.has(file),
      minted: mintedNamers.length > 0,
      kept: keptNamers.length > 0,
      rendered: renderedNamers.length > 0,
      discharged: dischargedNamers.length > 0,
    };
    const barsWindowed: Record<Bar, boolean> = {
      located: bars.located,
      named: bars.named,
      minted: within(mintedNamers),
      kept: within(keptNamers),
      rendered: within(renderedNamers),
      discharged: within(dischargedNamers),
    };

    const keptIds = new Set(keptNamers.map((n) => n.id));
    const lostToCeiling = bars.minted && !bars.kept ? [...new Set(mintedNamers.map((n) => n.family))] : [];

    return {
      run,
      case: instanceId,
      file,
      line,
      severity: g.severity ?? null,
      headline: (g.description.split("\n")[0] ?? "").replace(/^\*\*|\*\*$/g, "").slice(0, 110),
      bars,
      barsWindowed,
      namedBy: mintedNamers.map((n) => ({ ...n, kept: keptIds.has(n.id) })),
      lostToCeiling,
    };
  });
}

// ── main ─────────────────────────────────────────────────────────────────────

const instances = readJson<Instance[]>(DATASET);
const goldByCase = new Map(instances.map((i) => [i.instance_id, i.review_gold ?? []]));
const goldTotal = [...goldByCase.values()].reduce((a, g) => a + g.length, 0);

const runs = readdirSync(KEEPERS)
  .filter((r) => !ONLY_RUN || r === ONLY_RUN)
  .filter((r) => {
    const cases = readdirSync(join(KEEPERS, r)).filter((c) => goldByCase.has(c));
    return cases.length > 0;
  });

if (runs.length === 0) {
  console.error(`no keeper runs with scorable cases under ${KEEPERS}`);
  process.exit(1);
}

const scores: GoldScore[] = [];
for (const run of runs) {
  for (const c of readdirSync(join(KEEPERS, run))) {
    const gold = goldByCase.get(c);
    if (!gold || gold.length === 0) continue;
    scores.push(...scoreCase(run, join(KEEPERS, run, c), c, gold));
  }
}

// ── report ───────────────────────────────────────────────────────────────────

const pct = (n: number, d: number): string => (d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(0).padStart(3)}%`);

console.log(`\ncode-facts seeder funnel — ${AS_RUN ? "AS RUN" : "SHIPPED SEEDER replayed over preserved envelopes"}`);
console.log(`keepers   ${KEEPERS}`);
console.log(`dataset   ${DATASET}  (${goldTotal} gold over ${goldByCase.size} cases)`);
console.log(`window    ±${WINDOW} lines for the tighter bar`);
// `--mint` absent is the LIBRARY default (`seed.ts` mints neither D2 arm), which
// is NOT the shipped pipeline: `config/default.yaml` sets
// `review.analysis.mint: all-in-diff,registrations` and the workflow passes it
// through. Say so, or a bare replay reads as "the defaults" and is the baseline.
console.log(`mint      ${MINT || "(none passed — the LIBRARY default = the pre-D2 baseline)"}`);
if (!MINT) {
  console.log(`          the SHIPPED pipeline runs \`all-in-diff,registrations\` (config/default.yaml)`);
}
console.log();

for (const run of runs) {
  const rows = scores.filter((s) => s.run === run);
  if (rows.length === 0) continue;
  const d = rows.length;
  console.log(`── ${run}  (${d} gold scored)`);
  console.log(`   bar          file-level        within ±${WINDOW}`);
  for (const bar of BARS) {
    if (bar === "discharged" && !AS_RUN) continue;
    const f = rows.filter((r) => r.bars[bar]).length;
    const w = rows.filter((r) => r.barsWindowed[bar]).length;
    console.log(`   ${bar.padEnd(11)} ${String(f).padStart(3)}/${d}  ${pct(f, d)}    ${String(w).padStart(3)}/${d}  ${pct(w, d)}`);
  }
  const lost = rows.filter((r) => r.lostToCeiling.length > 0);
  if (lost.length > 0) {
    console.log(`   ceilings refused an obligation naming ${lost.length} gold: ${lost.map((r) => `${r.case}:${r.file}`).join(", ")}`);
  }
  console.log();
}

console.log("── the gold no obligation ever named (file level, shipped seeder)");
const unnamed = scores.filter((s) => !s.bars.kept);
for (const s of unnamed) {
  console.log(`   ${s.case.padEnd(30)} ${(s.file ?? "(no file)").padEnd(52)} ${s.bars.named ? "envelope named it" : "ENVELOPE BLIND"}`);
}
console.log(`   ${unnamed.length} of ${scores.length} scored gold-findings\n`);

console.log("   Read every number above as a CEILING: naming a file is not noticing a defect.");
console.log("   File-level here is coarser than facts-evidence.ts's entity bar — do not mix them.\n");

if (OUT) {
  writeFileSync(OUT, `${JSON.stringify({ keepers: KEEPERS, dataset: DATASET, window: WINDOW, asRun: AS_RUN, scores }, null, 2)}\n`);
  console.log(`wrote ${OUT}`);
}
