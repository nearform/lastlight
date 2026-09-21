/**
 * Where does a gold finding die?
 *
 * The campaign has measured both ends of the pipeline for a month — the
 * seeder's funnel on one side (`facts-obligations.ts`), posted recall on the
 * other (`review-metrics.ts`) — and nothing in between attributes a SINGLE lost
 * gold to the stage that lost it. `boundaryMetrics()` reports internal recall
 * against posted recall in aggregate; `withInternalRecall()` credits matches
 * per family. Neither can answer the only question that decides what to build:
 * when the pipeline found a defect and did not say it, was it the adjudicator's
 * own `tier`, or a cap the attention boundary applied afterwards?
 *
 * Those are different bugs. Burying at `tier` is a prompt/mechanism problem in
 * `review-adjudicate.md`. Losing at `body-budget` is a budget problem in
 * `review-poster.ts`. For a year the plan documents have blamed both,
 * alternately, on the same evidence.
 *
 * ── The ledger ─────────────────────────────────────────────────────────────
 *
 * Every gold finding lands in exactly one terminal state:
 *
 *   never-found    no finding in `findings.json` matched it. A DISCOVERY miss.
 *   withheld       matched a finding the boundary filed `internal`, sub-split
 *                  by the boundary's own reason token.
 *   demoted        matched a finding that was posted, but to the body rather
 *                  than inline, sub-split by reason. Still said — counted
 *                  separately because it is attention, not recall.
 *   posted-inline  matched a finding that reached the diff.
 *   untiered       matched a finding the join could not place. Its own row, so
 *                  a broken join can never masquerade as a clean result.
 *
 * `never-found` deliberately does NOT separate "no pass hypothesised it" from
 * "a pass hypothesised it and the adjudicator dropped the row", and the reason
 * is a property of the pipeline rather than a limitation here: the conservation
 * floor (`lastlight-facts findings --repair`) guarantees every hypothesis
 * reaches `findings.json` with exactly one disposition, restoring dropped rows
 * at `internal`. In a conserved run the intermediate state is empty by
 * construction.
 *
 * ── What this costs ────────────────────────────────────────────────────────
 *
 * Nothing. Labels come from the `finding-calibration` cache — the same
 * `gradeInternalRecall` MATCH pass a live run makes, already bought for every
 * gold-bearing case in the archive. This script never calls a model; if a case
 * has no cached label it is reported as unlabelled and excluded, never
 * silently scored as zero.
 *
 * ── Reading it ─────────────────────────────────────────────────────────────
 *
 * `withheld` + `demoted` is the found→said gap. `never-found` is the discovery
 * gap. The standing result they have to be read against: internal union
 * 18–21/25 against posted 4–17, i.e. the found→said gap is the bigger of the
 * two.
 *
 * **The denominator trap that made that claim wrong.** "found 18, said 4" reads
 * an internal UNION across repeats against a posted MEAN of one repeat. Union to
 * union on the same arm (`band.ts`, and confirmed independently) the ceilings arm
 * is 18 internal / 8 posted, and pooled over all 58 pipeline-carrying runs in the
 * results tree it is 336 internal / 232 posted against 753 gold — a discovery gap
 * of 417 and a found→said gap of 104. Discovery is the larger gap in every arm
 * but one. Use `band.ts` for the union read; this script is the per-stage one.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   tsx scripts/say-gap.ts --archive ~/lastlight-run-artifacts \
 *       --instances <path to pr-review instances.json> [--reasons] [--by-case] [--gold]
 *
 * `--reasons` breaks `withheld`/`demoted` down by the boundary's reason token.
 * **Pre-`47ee595c` runs are excluded from that breakdown**: the original WP6b
 * `recordDisposition` hard-coded `"below the internal floor"` on every internal
 * row, so five of the eight archived runs carry a reason vocabulary that means
 * nothing. They still count toward the tier-level ledger, which is sound.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  readPipelineArtifacts,
  type PipelineFinding,
} from "../src/review-pipeline-stats.js";
import type { GoldComment } from "../src/schema.js";

// ── CLI plumbing (same shape as scripts/finding-calibration.ts) ─────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--"))
    return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
}
function die(msg: string): never {
  console.error(`say-gap: ${msg}`);
  process.exit(1);
}

/**
 * The reason vocabulary only became real in `47ee595c` (2026-08-23 08:29 BST).
 * Before it, every internal row was labelled `"below the internal floor"` by a
 * hard-coded string in `recordDisposition` — measured: 255 of those 259 rows
 * carry a confidence at or above the 0.15 floor they are supposed to have
 * failed, 116 of them at exactly 1.00. A reason breakdown that pools these with
 * honest rows reports a filter that never fired as the pipeline's largest sink.
 */
const VOID_REASON = "below the internal floor";

// ── Terminal states ─────────────────────────────────────────────────────────

type State = "posted-inline" | "demoted" | "withheld" | "untiered" | "never-found";

const STATE_ORDER: State[] = ["posted-inline", "demoted", "withheld", "untiered", "never-found"];

/** One gold finding's fate in one case-run. */
interface Row {
  run: string;
  instanceId: string;
  goldIndex: number;
  gold: string;
  state: State;
  /** The boundary's reason token, where one applies and is not void. */
  reason: string | null;
  /** Title of the finding that matched, for the per-case listing. */
  finding: string | null;
}

// ── Archive ─────────────────────────────────────────────────────────────────

interface ArchivedCase {
  run: string;
  instanceId: string;
  findings: PipelineFinding[];
}

function loadArchive(root: string): ArchivedCase[] {
  if (!existsSync(root)) die(`no archive at ${root}`);
  const cases: ArchivedCase[] = [];
  for (const run of readdirSync(root)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(join(root, run));
    } catch {
      continue;
    }
    for (const instanceId of entries) {
      const readout = readPipelineArtifacts(join(root, run, instanceId, "pr-review"));
      if (!readout || !readout.findings.length) continue;
      cases.push({ run, instanceId, findings: readout.findings });
    }
  }
  return cases;
}

function loadGold(path: string): Map<string, GoldComment[]> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { instances?: unknown[] }).instances) as
    | { instance_id: string; review_gold?: GoldComment[] }[]
    | undefined;
  if (!list) die(`${path} is neither an array nor { instances: [...] }`);
  const out = new Map<string, GoldComment[]>();
  for (const inst of list) if (inst.review_gold?.length) out.set(inst.instance_id, inst.review_gold);
  return out;
}

// ── Labels ──────────────────────────────────────────────────────────────────

type LabelCache = Record<string, { goldToFinding: (number | null)[]; matched: number; error?: string }>;

function cachePath(): string {
  return resolve(process.env.LASTLIGHT_EVALS_CACHE ?? ".eval-cache", "finding-calibration", "labels.json");
}

/**
 * Must match `finding-calibration.ts`'s `caseDigest` byte for byte — this
 * script reads that script's cache and a drifted key silently reports every
 * case unlabelled.
 */
function caseDigest(c: ArchivedCase, gold: GoldComment[]): string {
  const h = createHash("sha256");
  for (const f of c.findings) h.update(`${f.title}\u0000${f.path ?? ""}\u0000`);
  for (const g of gold) h.update(`${g.description}\u0000`);
  return h.digest("hex").slice(0, 16);
}

// ── Classification ──────────────────────────────────────────────────────────

function stateOf(f: PipelineFinding): { state: State; reason: string | null } {
  const reason = f.reason === VOID_REASON ? null : (f.reason ?? null);
  if (f.tier === "internal") return { state: "withheld", reason };
  if (f.tier === "body") return { state: "demoted", reason };
  if (f.tier === "inline") return { state: "posted-inline", reason: null };
  return { state: "untiered", reason: null };
}

function rowsFor(c: ArchivedCase, gold: GoldComment[], label: LabelCache[string]): Row[] {
  const g2f = label.goldToFinding ?? [];
  return gold.map((g, j) => {
    const idx = g2f[j];
    const f = idx === null || idx === undefined ? undefined : c.findings[idx];
    if (!f)
      return {
        run: c.run,
        instanceId: c.instanceId,
        goldIndex: j,
        gold: g.description,
        state: "never-found" as const,
        reason: null,
        finding: null,
      };
    const { state, reason } = stateOf(f);
    return {
      run: c.run,
      instanceId: c.instanceId,
      goldIndex: j,
      gold: g.description,
      state,
      reason,
      finding: f.title,
    };
  });
}

// ── Report ──────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d ? `${((100 * n) / d).toFixed(1).padStart(5)}%` : "    —";
}

function bar(n: number, d: number, width = 28): string {
  const filled = d ? Math.round((n / d) * width) : 0;
  return "█".repeat(filled) + "·".repeat(width - filled);
}

function main(): void {
  const archive = flag("archive") ?? join(process.env.HOME ?? "", "lastlight-run-artifacts");
  const instances = flag("instances");
  if (!instances) die("--instances <path to pr-review instances.json> is required");

  const cases = loadArchive(archive);
  if (!cases.length) die(`no case with findings under ${archive}`);
  const gold = loadGold(instances);
  const cache: LabelCache = (() => {
    try {
      return JSON.parse(readFileSync(cachePath(), "utf8")) as LabelCache;
    } catch {
      return {};
    }
  })();

  const rows: Row[] = [];
  const unlabelled: string[] = [];
  const noGold: string[] = [];
  for (const c of cases) {
    const g = gold.get(c.instanceId);
    if (!g?.length) {
      noGold.push(`${c.run}/${c.instanceId}`);
      continue;
    }
    const label = cache[caseDigest(c, g)];
    if (!label || label.error) {
      unlabelled.push(`${c.run}/${c.instanceId}${label?.error ? ` (${label.error})` : ""}`);
      continue;
    }
    rows.push(...rowsFor(c, g, label));
  }
  if (!rows.length)
    die(
      `no labelled case. ${unlabelled.length} unlabelled — run finding-calibration.ts first to populate ${cachePath()}`,
    );

  const n = rows.length;
  const count = (s: State) => rows.filter((r) => r.state === s).length;
  const said = count("posted-inline") + count("demoted");
  const found = said + count("withheld") + count("untiered");

  console.log(`\n── SAY-GAP LEDGER ──`);
  console.log(`   archive   ${archive}`);
  console.log(`   case-runs ${new Set(rows.map((r) => `${r.run}/${r.instanceId}`)).size} · gold instances ${n}`);
  if (noGold.length) console.log(`   no gold   ${noGold.length} case-run(s) — excluded (the zero-gold canary lives here)`);
  if (unlabelled.length) {
    console.log(`   UNLABELLED ${unlabelled.length} case-run(s), excluded rather than scored as zero:`);
    for (const u of unlabelled) console.log(`     · ${u}`);
  }

  console.log(`\n   ${"terminal state".padEnd(16)} ${"n".padStart(5)}  ${"share".padStart(6)}  distribution`);
  for (const s of STATE_ORDER) {
    const c = count(s);
    console.log(`   ${s.padEnd(16)} ${String(c).padStart(5)}  ${pct(c, n)}  ${bar(c, n)}`);
  }

  console.log(`\n   found (any tier)      ${String(found).padStart(4)} / ${n}   ${pct(found, n)}`);
  console.log(`   said  (inline+body)   ${String(said).padStart(4)} / ${n}   ${pct(said, n)}`);
  console.log(`   ── the found→said gap ${String(found - said).padStart(4)} / ${n}   ${pct(found - said, n)}`);
  console.log(`   ── the discovery gap  ${String(count("never-found")).padStart(4)} / ${n}   ${pct(count("never-found"), n)}`);
  console.log(
    `\n   Whichever of those two is larger is the lever. They are different bugs:\n` +
      `   the first lives in review-adjudicate.md and review-poster.ts, the second\n` +
      `   in the seeder and the surveys.`,
  );

  if (has("reasons")) {
    console.log(`\n── WHY, for everything not posted inline ──`);
    const honest = rows.filter((r) => r.state === "withheld" || r.state === "demoted");
    const withReason = honest.filter((r) => r.reason !== null);
    const voided = honest.length - withReason.length;
    if (voided)
      console.log(
        `   ${voided} row(s) have no usable reason — pre-47ee595c artifacts, whose\n` +
          `   internal reason was a hard-coded constant. Excluded, not guessed.`,
      );
    const tally = new Map<string, number>();
    for (const r of withReason) {
      const k = `${r.state}/${r.reason}`;
      tally.set(k, (tally.get(k) ?? 0) + 1);
    }
    if (!tally.size) console.log(`   nothing left to break down.`);
    for (const [k, c] of [...tally].sort((a, b) => b[1] - a[1]))
      console.log(`   ${k.padEnd(34)} ${String(c).padStart(4)}  ${pct(c, withReason.length)}`);
  }

  if (has("by-case")) {
    console.log(`\n── BY CASE ──`);
    const byCase = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.instanceId}`;
      (byCase.get(k) ?? byCase.set(k, []).get(k)!).push(r);
    }
    for (const [caseId, rs] of [...byCase].sort()) {
      const runs = new Set(rs.map((r) => r.run)).size;
      console.log(`\n   ${caseId}  (${runs} run${runs === 1 ? "" : "s"})`);
      for (const s of STATE_ORDER) {
        const c = rs.filter((r) => r.state === s).length;
        if (c) console.log(`     ${s.padEnd(16)} ${String(c).padStart(4)}  ${pct(c, rs.length)}`);
      }
    }
  }

  if (has("gold")) {
    console.log(`\n── PER GOLD, every run ──`);
    const byGold = new Map<string, Row[]>();
    for (const r of rows) {
      const k = `${r.instanceId}#${r.goldIndex}`;
      (byGold.get(k) ?? byGold.set(k, []).get(k)!).push(r);
    }
    for (const [k, rs] of [...byGold].sort()) {
      const states = rs.map((r) => r.state);
      const everSaid = states.some((s) => s === "posted-inline" || s === "demoted");
      const everFound = everSaid || states.some((s) => s === "withheld" || s === "untiered");
      const tag = everSaid ? "SAID   " : everFound ? "BURIED " : "UNFOUND";
      console.log(`   ${tag} ${k.padEnd(26)} ${states.join(", ").slice(0, 90)}`);
      console.log(`           ${rs[0].gold.replace(/\s+/g, " ").slice(0, 96)}`);
    }
    console.log(
      `\n   BURIED is the set this whole plan exists for: a defect the pipeline\n` +
        `   located in every run and never once said.`,
    );
  }

  console.log();
}

main();
