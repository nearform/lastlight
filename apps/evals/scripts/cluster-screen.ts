/**
 * $0 screen: does deterministic clustering collapse a unit-survey hypothesis
 * set into something a per-cluster verifier and a small tournament can handle,
 * without merging two gold defects into one cluster — and is the order it
 * ranks those clusters in actually signal?
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * The unit survey writes 39–234 rows per case (1,794 over 16 case-arms, 14
 * gold-matched), and every cut tried after it failed: `top:40` filed 7 of the
 * 14 gold, the jev rule filed 473 rows and no gold, and one `adjudicate` call
 * over a 130–220k-char dossier does not finish. The proposed replacement
 * (docs/plans/adjudicate-falsify-replay.md) is cluster → refute each cluster →
 * setwise tournament. This measures its first step before anything is spent.
 *
 * ── What it measures ───────────────────────────────────────────────────────
 *
 * Clusters are `lastlight-code-facts`' `clusterSites` — the module the
 * pipeline would run — so the screen measures the shipped definition: a run
 * of rows in one file whose anchor lines sit within `window` lines of each
 * other (single linkage), `--by-family` as the ablation. The key reads only
 * the anchor — path and line — never claim text. Every `--order` re-sorts the
 * SAME sites; only the order changes, never the clustering.
 *
 *  - rows vs clusters per case (the collapse ratio).
 *  - gold collisions: two gold rows in one cluster — one comment for two
 *    defects, the only way clustering itself loses recall.
 *  - how the gold clusters rank under `--order` — against the gold `top:40` kept.
 *
 * ── Orders (docs/plans/unit-pr-review-revise.md, screen 1) ─────────────────
 *
 * `severity` and `support` read the survey's rows; everything else is a NULL
 * MODEL that reads no model output past the site's own path and line extent.
 * If a null model puts as many gold in the top 5 as `support` does, support is
 * measuring "a big changed function", not agreement, and the survey adds
 * recall but no ranking signal.
 *
 *  - `severity` — strongest derived severity, then support, then `clusterSites`
 *    rank (the screen's original comparator).
 *  - `support` — `clusterSites`' own order: rows in the site (or distinct
 *    voters, see `--voters`), then severity, then declaration order.
 *  - `lines` — changed lines (facts.json `extractors.facts.files[].changedLines`)
 *    inside the site's HOME units: every unit in units.json in the site's file
 *    whose `lines` span overlaps the site's anchor extent. The size of the
 *    changed function(s) the site sits in. No home unit → changed lines inside
 *    the anchor extent itself.
 *  - `lines-local` — changed lines within ±window of the site's anchor extent:
 *    how much of the diff is right there, regardless of unit boundaries.
 *    CONFOUNDED: a site with more rows tends to span more lines, so its
 *    ±window reaches more of the diff — part of this key is support again.
 *  - `lines-mid` — changed lines within ±window of the site's MIDPOINT: a
 *    fixed-width (2·window+1) neighbourhood, so it no longer grows with the
 *    site's extent. The de-confounded form of `lines-local`.
 *  - `extent` — the anchor extent itself (endLine − startLine). Not a null
 *    model: it is shaped by how many rows landed there. Printed as the
 *    confound's own score, to read `lines-local` against.
 *  - `callers` — references (facts.json `symbols[].references`) to the symbols
 *    declared in the site's home units (declaredAt inside a home span).
 *  - `untouched-callers` — the same, only references with `inDiff: false`:
 *    call sites the PR did not update, i.e. where a contract break would land.
 *  - `random` — no key at all: the chance baseline.
 *
 * Null-model ties (common: sibling sites in one unit share its `lines`) and
 * `random` are broken by a seeded shuffle, averaged over `--shuffles` (default
 * 200), so those rows print MEAN gold counts and mean ranks. Unanchored sites
 * (no path/line) score 0 on every null key.
 *
 * ── Voters (screen 3: is the vote an echo?) ────────────────────────────────
 *
 * A unit over 40 changed lines splits into up to six family siblings
 * (`splitOf` in units.json, id `<splitOf>-<family>`), each re-reading the same
 * lines, and one unit often writes several rows about one spot. Row-count
 * support counts every one of those as a vote.
 *
 *  - `--voters rows` (default) — support = rows in the site (shipped).
 *  - `--voters unit` — support = DISTINCT voters in the site, a voter being the
 *    row's `unitId` with a split sibling collapsed to its `splitOf`. Ties then
 *    break by severity, then by `--tiebreak`: `random` (seeded, averaged — no
 *    row count leaks back in) or `rows` (row support, then declaration order).
 *    `clusterSites` has no voter key, so it is computed here; if it ships it
 *    belongs in `site-cluster.ts`.
 *
 * If gold falls out of the top 5 under distinct voters, the vote was an echo.
 *
 * `--order all` prints one summary line per order × voters combination.
 *
 * Gold comes from a `micro-adjudicate --audit` report (its `goldRows` is the
 * cached gold→row map), so the screen spends nothing. That script was removed
 * with the adjudicate phase; the screen still reads the reports it left.
 *
 * Usage:
 *   npx tsx <monorepo>/apps/evals/scripts/cluster-screen.ts \
 *     [--report eval-results/phase-replay/<…>-adjudicate-audit-top:40.json] \
 *     [--windows 0,5,15,40] [--by-family] \
 *     [--order severity|support|lines|lines-local|lines-mid|extent|callers|untouched-callers|random|all] \
 *     [--voters rows|unit] [--tiebreak random|rows] [--shuffles 200]
 *
 * Run from the evals workspace; the report defaults to the newest
 * `*-adjudicate-audit-top:*.json` under `eval-results/phase-replay/`.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { clusterSites, readHypothesisSet, type HypothesisSet, type Site } from "lastlight-code-facts";

import { PHASE_REPLAY_DIR, type PhaseReplayCase, type PhaseReplayReport } from "../src/phase-replay.js";
import { resolveFixtures } from "../src/phase-replay-node.js";

/** The shape `micro-adjudicate --audit` (since removed) wrote — read-only here. */
type AdjudicateAuditReport = Omit<PhaseReplayReport, "kind" | "cases"> & {
  kind: string;
  config: PhaseReplayReport["config"] & { rules?: string };
  cases: (PhaseReplayCase & { adjudicate?: { goldFiled: string[] } })[];
};

const ORDERS = [
  "severity",
  "support",
  "lines",
  "lines-local",
  "lines-mid",
  "extent",
  "callers",
  "untouched-callers",
  "random",
] as const;
type Order = (typeof ORDERS)[number];
type Voters = "rows" | "unit";
type Tiebreak = "random" | "rows";

const SEVERITY_RANK: Record<string, number> = { Critical: 0, Important: 1, Minor: 2 };
const sev = (s: Site): number => SEVERITY_RANK[s.severity ?? ""] ?? 3;

// ── deterministic facts about a site (no model output) ──────────────────────

interface UnitSpan {
  id: string;
  file: string | null;
  lines: [number, number] | null;
  splitOf?: string;
}

interface SymbolFact {
  file: string;
  line: number;
  references: { inDiff?: boolean }[];
}

interface CaseFacts {
  changed: Map<string, Set<number>>;
  units: UnitSpan[];
  /** unitId → voter key (a split sibling's `splitOf`, else its own id). */
  voterOf: Map<string, string>;
  symbols: SymbolFact[];
}

function readCaseFacts(prDir: string): CaseFacts {
  const changed = new Map<string, Set<number>>();
  const symbols: SymbolFact[] = [];
  const factsPath = join(prDir, "facts.json");
  if (existsSync(factsPath)) {
    const facts = JSON.parse(readFileSync(factsPath, "utf8")) as {
      extractors?: {
        facts?: {
          files?: { path: string; changedLines?: number[] }[];
          symbols?: { declaredAt?: string; references?: { inDiff?: boolean }[] }[];
        };
      };
    };
    for (const f of facts.extractors?.facts?.files ?? []) changed.set(f.path, new Set(f.changedLines ?? []));
    for (const s of facts.extractors?.facts?.symbols ?? []) {
      const m = typeof s.declaredAt === "string" ? /^(.*):(\d+)$/.exec(s.declaredAt) : null;
      if (m) symbols.push({ file: m[1], line: Number(m[2]), references: s.references ?? [] });
    }
  } else console.warn(`  ! no facts.json under ${prDir}: null keys score 0`);

  const unitsPath = join(prDir, "units.json");
  const units: UnitSpan[] = existsSync(unitsPath)
    ? (JSON.parse(readFileSync(unitsPath, "utf8")) as { units: UnitSpan[] }).units
    : [];
  if (!units.length) console.warn(`  ! no units under ${prDir}: home units fall back to the anchor extent`);
  const voterOf = new Map(units.map((u) => [u.id, u.splitOf ?? u.id]));
  return { changed, units, voterOf, symbols };
}

interface SiteKeys {
  lines: number;
  linesLocal: number;
  linesMid: number;
  extent: number;
  callers: number;
  untouchedCallers: number;
  /** Distinct voters (unit, split siblings collapsed). */
  voters: number;
}

function siteKeys(site: Site, facts: CaseFacts, set: HypothesisSet, window: number): SiteKeys {
  const voters = new Set(
    site.rows.map((id) => {
      const unitId = (set.byId.get(id)?.row as { unitId?: unknown } | undefined)?.unitId;
      return typeof unitId === "string" ? (facts.voterOf.get(unitId) ?? unitId) : `row:${id}`;
    }),
  ).size;
  if (site.path === null || site.startLine === null || site.endLine === null) {
    return { lines: 0, linesLocal: 0, linesMid: 0, extent: 0, callers: 0, untouchedCallers: 0, voters };
  }
  const { path, startLine: lo, endLine: hi } = site;
  const changed = facts.changed.get(path) ?? new Set<number>();
  const home = facts.units
    .filter((u) => u.file === path && u.lines && u.lines[0] <= hi && u.lines[1] >= lo)
    .map((u) => u.lines as [number, number]);
  const spans: [number, number][] = home.length ? home : [[lo, hi]];
  const inSpans = (n: number): boolean => spans.some(([a, b]) => n >= a && n <= b);

  const lines = [...changed].filter(inSpans).length;
  const linesLocal = [...changed].filter((n) => n >= lo - window && n <= hi + window).length;
  const mid = (lo + hi) / 2;
  const linesMid = [...changed].filter((n) => Math.abs(n - mid) <= window).length;
  const syms = facts.symbols.filter((s) => s.file === path && inSpans(s.line));
  const callers = syms.reduce((n, s) => n + s.references.length, 0);
  const untouchedCallers = syms.reduce((n, s) => n + s.references.filter((r) => r.inDiff === false).length, 0);
  return { lines, linesLocal, linesMid, extent: hi - lo, callers, untouchedCallers, voters };
}

// ── ordering ────────────────────────────────────────────────────────────────

/** mulberry32 — a fixed-seed PRNG so a re-run prints the same means. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Mode {
  order: Order;
  voters: Voters;
  tiebreak: Tiebreak;
}

const modeName = (m: Mode): string =>
  m.order === "severity" || m.order === "support"
    ? `${m.order} · voters ${m.voters}${m.voters === "unit" ? ` · ties ${m.tiebreak}` : ""}`
    : m.order;

/** Does this mode's order ever consult the seeded tiebreak? */
const shuffled = (m: Mode): boolean =>
  !(m.order === "severity" || m.order === "support") || (m.voters === "unit" && m.tiebreak === "random");

/**
 * One ordering of the sites: a list of site indices, best first. `tie` is a
 * per-site random draw, used only where the mode says ties go to chance.
 */
function orderSites(sites: Site[], keys: SiteKeys[], mode: Mode, tie: number[]): number[] {
  const support = (i: number): number => (mode.voters === "unit" ? keys[i].voters : sites[i].support);
  const rest = (a: number, b: number): number =>
    mode.voters === "unit" && mode.tiebreak === "random" ? tie[a] - tie[b] : sites[b].support - sites[a].support || a - b;
  const cmp: Record<Order, (a: number, b: number) => number> = {
    severity: (a, b) => sev(sites[a]) - sev(sites[b]) || support(b) - support(a) || rest(a, b),
    support: (a, b) => support(b) - support(a) || sev(sites[a]) - sev(sites[b]) || rest(a, b),
    lines: (a, b) => keys[b].lines - keys[a].lines || tie[a] - tie[b],
    "lines-local": (a, b) => keys[b].linesLocal - keys[a].linesLocal || tie[a] - tie[b],
    "lines-mid": (a, b) => keys[b].linesMid - keys[a].linesMid || tie[a] - tie[b],
    extent: (a, b) => keys[b].extent - keys[a].extent || tie[a] - tie[b],
    callers: (a, b) => keys[b].callers - keys[a].callers || tie[a] - tie[b],
    "untouched-callers": (a, b) => keys[b].untouchedCallers - keys[a].untouchedCallers || tie[a] - tie[b],
    random: (a, b) => tie[a] - tie[b],
  };
  return sites.map((_, i) => i).sort(cmp[mode.order]);
}

// ── the screen ──────────────────────────────────────────────────────────────

const TOPS = [5, 10, 20, 40];

interface CaseInput {
  label: string;
  set: HypothesisSet;
  sites: Site[];
  keys: SiteKeys[];
  goldIds: string[];
  goldSites: number[];
  filed: Set<string>;
}

interface ModeResult {
  within: Record<number, number>;
  lines: string[];
}

function runMode(cases: CaseInput[], mode: Mode, shuffles: number): ModeResult {
  const n = shuffled(mode) ? shuffles : 1;
  const within = Object.fromEntries(TOPS.map((k) => [k, 0])) as Record<number, number>;
  const lines: string[] = [];
  for (const c of cases) {
    const rankSum = c.goldSites.map(() => 0);
    const distinct = [...new Set(c.goldSites)].filter((i) => i >= 0);
    for (let s = 0; s < n; s++) {
      const rand = prng(0x5eed + s);
      const tie = c.sites.map(() => rand());
      const pos = new Map(orderSites(c.sites, c.keys, mode, tie).map((site, rank) => [site, rank]));
      c.goldSites.forEach((i, g) => (rankSum[g] += i < 0 ? NaN : (pos.get(i) as number) + 1));
      for (const k of TOPS) within[k] += distinct.filter((i) => (pos.get(i) as number) < k).length / n;
    }
    const ranks = c.goldIds.map((id, g) => {
      const i = c.goldSites[g];
      const r = rankSum[g] / n;
      const tag = i < 0 ? "" : `(rows ${c.sites[i].support}/voters ${c.keys[i].voters})`;
      return `${id}@${n === 1 ? r : r.toFixed(1)}${tag}${c.filed.has(id) ? "(top:filed)" : ""}`;
    });
    lines.push(
      `  ${c.label.padEnd(38)} rows ${String(c.set.records.length).padStart(3)} → clusters ${String(c.sites.length).padStart(3)}` +
        `  largest ${String(Math.max(...c.sites.map((x) => x.support))).padStart(2)}` +
        (ranks.length ? `  gold ${ranks.join(" ")}` : ""),
    );
  }
  return { within, lines };
}

const fmt = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(2));
const tops = (w: Record<number, number>): string => TOPS.map((k) => fmt(w[k])).join("/");

function parseArgs(argv: string[]): {
  report: string;
  windows: number[];
  byFamily: boolean;
  modes: Mode[];
  shuffles: number;
} {
  let report: string | null = null;
  let order: Order | "all" = "severity";
  let voters: Voters = "rows";
  let tiebreak: Tiebreak = "random";
  let windows = [0, 5, 15, 40];
  let byFamily = false;
  let shuffles = 200;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") report = argv[++i];
    else if (a === "--windows") windows = argv[++i].split(",").map(Number);
    else if (a === "--by-family") byFamily = true;
    else if (a === "--shuffles") shuffles = Math.max(1, Number(argv[++i]));
    else if (a === "--order") {
      const o = argv[++i];
      if (o !== "all" && !(ORDERS as readonly string[]).includes(o)) throw new Error(`--order: ${ORDERS.join(" | ")} | all, not ${o}`);
      order = o as Order | "all";
    } else if (a === "--voters") {
      const v = argv[++i];
      if (v !== "rows" && v !== "unit") throw new Error(`--voters: rows | unit, not ${v}`);
      voters = v;
    } else if (a === "--tiebreak") {
      const t = argv[++i];
      if (t !== "random" && t !== "rows") throw new Error(`--tiebreak: random | rows, not ${t}`);
      tiebreak = t;
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (!report) {
    const dir = join(process.cwd(), "eval-results", PHASE_REPLAY_DIR);
    const hit = readdirSync(dir)
      .filter((f) => /-adjudicate-audit-top:\d+\.json$/.test(f))
      .sort()
      .pop();
    if (!hit) throw new Error(`no *-adjudicate-audit-top:<n>.json under ${dir}; pass --report`);
    report = join(dir, hit);
  }
  const modes: Mode[] =
    order === "all"
      ? [
          { order: "support", voters: "rows", tiebreak },
          { order: "support", voters: "unit", tiebreak: "random" },
          { order: "support", voters: "unit", tiebreak: "rows" },
          { order: "severity", voters: "rows", tiebreak },
          ...ORDERS.filter((o) => o !== "support" && o !== "severity").map((o): Mode => ({ order: o, voters, tiebreak })),
        ]
      : [{ order, voters, tiebreak }];
  return { report, windows, byFamily, modes, shuffles };
}

function main(): void {
  const { report, windows, byFamily, modes, shuffles } = parseArgs(process.argv.slice(2));
  // A historical `micro-adjudicate --audit` report: the phase-replay shape plus
  // the admission fields the removed `adjudicate` kind carried.
  const r = JSON.parse(readFileSync(report, "utf8")) as AdjudicateAuditReport;
  const summary = modes.length > 1;
  console.log(
    `report ${report}  (${r.config.rules})  key: path${byFamily ? "+family" : ""}+line window` +
      (summary ? `  orders: all` : `  order: ${modeName(modes[0])}`) +
      `  shuffles ${shuffles}\n`,
  );

  for (const window of windows) {
    let rows = 0;
    let clusters = 0;
    let gold = 0;
    let collisions = 0;
    let topKept = 0;
    const cases: CaseInput[] = [];

    for (const c of r.cases) {
      if (!c.ok) continue;
      const [fx] = resolveFixtures([c.fixture]);
      const set = readHypothesisSet(fx.prDir);
      const facts = readCaseFacts(fx.prDir);
      const sites = clusterSites(set, { window, byFamily }).sites;
      const keys = sites.map((s) => siteKeys(s, facts, set, window));
      const siteOf = new Map<string, number>();
      sites.forEach((cl, i) => cl.rows.forEach((id) => siteOf.set(id, i)));

      const goldIds = [...new Set((c.goldRows ?? []).filter((id): id is string => id !== null))];
      const goldSites = goldIds.map((id) => siteOf.get(id) ?? -1);
      const filed = new Set(c.adjudicate?.goldFiled ?? []);

      rows += set.records.length;
      clusters += sites.length;
      gold += goldIds.length;
      collisions += goldIds.length - new Set(goldSites).size;
      topKept += goldIds.filter((id) => !filed.has(id)).length;
      cases.push({ label: `${c.arm}/${c.instanceId}`, set, sites, keys, goldIds, goldSites, filed });
    }

    const head =
      `  total rows ${rows} → clusters ${clusters} (×${(rows / Math.max(1, clusters)).toFixed(2)})  gold ${gold}` +
      `  collisions ${collisions}  (${r.config.rules} rows kept ${topKept})`;
    console.log(`window ±${window}`);
    if (summary) {
      console.log(head);
      console.log(`  ${"order".padEnd(40)} gold sites in top ${TOPS.join("/")}`);
      for (const m of modes) console.log(`  ${modeName(m).padEnd(40)} ${tops(runMode(cases, m, shuffles).within)}`);
      console.log("");
    } else {
      const res = runMode(cases, modes[0], shuffles);
      for (const l of res.lines) console.log(l);
      console.log(`${head}  gold clusters in top ${TOPS.join("/")}: ${tops(res.within)}\n`);
    }
  }
}

main();
