/**
 * How many turns, and how many of them were shell, did each phase spend?
 *
 * `$0`, read-only, no model call — it counts `tool_use` blocks in the session
 * transcripts a run already wrote (`sessions/<case>__<arm>/trial-N/NN-<phase>.jsonl`).
 *
 * ── Why this exists ────────────────────────────────────────────────────────
 *
 * [#399](https://github.com/nearform/lastlight/issues/399) is the claim that
 * `adjudicate` spends its budget on clerical assembly rather than on
 * adjudicating: on `1587-r2` it ran 35 assistant turns, **30 of them `bash`**,
 * and exactly one `write` — `cat`-ing hypothesis files, probe transcripts and
 * the ledger that `readHypothesisSet`, `checkProbes` and `buildFindingsLedger`
 * have already parsed, then re-reading source lines with `sed -n '<N>p'` to
 * check quotes it was handed.
 *
 * The issue names bash calls and assistant turns as the success criterion and
 * says both are "already recorded per phase". **They are not.** The scorecard's
 * `phases[]` carries `durationMs`, tokens and `costUsd` and nothing about turn
 * shape; the counts exist only in the transcripts, and were first obtained by
 * hand. A before/after that is measured by hand once and re-derived by hand
 * later is not a measurement, so it lives here instead.
 *
 * Cost and duration deliberately come along for the ride, from the scorecard,
 * because reading turn counts without them invites the trade nobody wants: a
 * phase that makes one enormous call instead of thirty small ones looks like a
 * win on every column here and is not one. Latency is only comparable at
 * `--concurrency 1` — the same case/phase ran 613s at concurrency 1 and 2731s
 * at 3 — so the header says which concurrency produced the numbers, read off
 * the run's own `meta.argv` rather than assumed.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   npx tsx scripts/phase-turns.ts <run-dir> [<run-dir> …] [--phase adjudicate]
 *
 * Several run dirs print as one table per run plus a comparison of the totals,
 * which is the before/after read. `--phase` filters by substring, so
 * `--phase survey` covers all five branches and `--phase adjudicate` matches
 * `adjudicate_iter_1`, `adjudicate_iter_2`, … A phase that ran more than once
 * in a case is summed, and the iteration count is reported: iterating twice is
 * itself part of what the phase cost.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";

function die(msg: string): never {
  console.error(`phase-turns: ${msg}`);
  process.exit(1);
}

/** Set by `main()`; `readRun` filters on it. Module scope so this file can be
 * imported for its pure helpers without parsing argv or calling `process.exit`
 * — importing a script that runs on load is how a unit test "fails to collect". */
let phaseFilter: string | undefined;

/** One phase's turn shape in one case. */
interface PhaseTally {
  case: string;
  arm: string;
  phase: string;
  /** Sessions for this phase in this case — >1 means the phase iterated. */
  iterations: number;
  assistantTurns: number;
  /** `tool_use` blocks by tool name. Counted per BLOCK, not per turn: a turn
   * may carry several calls, and the thirty shell calls are the cost whether
   * they arrived in thirty turns or ten. */
  tools: Record<string, number>;
}

/**
 * `prreview__skillspro-1587-r2__wp3-minimal-d2ab` → id + arm.
 *
 * Exported because it was wrong first: the instance id ITSELF contains `__`, so
 * destructuring the first two segments reads every case as `prreview` and every
 * arm as the case. The totals stay correct while every row is mislabelled —
 * the kind of wrong that survives a glance at the table. The arm is the LAST
 * segment; everything before it is the id the scorecard joins on.
 */
export function splitSessionDir(dir: string): { instanceId: string; arm: string } {
  const parts = dir.split("__");
  if (parts.length < 2) return { instanceId: dir, arm: "?" };
  return { instanceId: parts.slice(0, -1).join("__"), arm: parts[parts.length - 1]! };
}

/** A session transcript is JSONL of `{type, message:{role, content:[…]}}`.
 * Unparseable lines are skipped rather than fatal — a transcript truncated by a
 * killed run still carries a usable count of what it did before it died, and
 * refusing the whole run over its tail would lose the other seven cases. */
export function tallyLines(lines: string[]): { turns: number; tools: Record<string, number> } {
  let turns = 0;
  const tools: Record<string, number> = {};
  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: { type?: string; message?: { content?: unknown } };
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "assistant") continue;
    turns++;
    const content = ev.message?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content) {
      const block = c as { type?: string; name?: string };
      if (block.type === "tool_use" && block.name) tools[block.name] = (tools[block.name] ?? 0) + 1;
    }
  }
  return { turns, tools };
}

interface RunReadout {
  dir: string;
  /** From the scorecard, so the concurrency caveat is stated rather than assumed. */
  argv: string[];
  tallies: PhaseTally[];
  /** `costUsd` / `durationMs` per case+phase, from the scorecard's `phases[]`. */
  cost: Record<string, { costUsd: number; durationMs: number }>;
}

function readRun(dir: string): RunReadout {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) die(`${dir} is not a directory`);
  const sessions = join(dir, "sessions");
  if (!existsSync(sessions)) die(`${dir} has no sessions/ — nothing to count`);

  const card = join(dir, "scorecard.json");
  let argvOut: string[] = [];
  const cost: RunReadout["cost"] = {};
  if (existsSync(card)) {
    const doc = JSON.parse(readFileSync(card, "utf8")) as {
      meta?: { argv?: string[] };
      results?: { instance_id?: string; phases?: { phase?: string; costUsd?: number; durationMs?: number }[] }[];
    };
    argvOut = doc.meta?.argv ?? [];
    for (const r of doc.results ?? [])
      for (const p of r.phases ?? []) {
        if (!r.instance_id || !p.phase) continue;
        const k = `${r.instance_id}\u0000${p.phase}`;
        cost[k] = { costUsd: p.costUsd ?? 0, durationMs: p.durationMs ?? 0 };
      }
  }

  const tallies: PhaseTally[] = [];
  for (const sessionDir of readdirSync(sessions)) {
    // `sessions/<instance_id>__<arm>/trial-N/NN-<phase>.jsonl`, where the
    // instance id ITSELF contains `__` (`prreview__skillspro-1587-r2`). Taking
    // the first two segments reads every case as "prreview" and every arm as
    // the case — a table of eight identical rows that still totals correctly,
    // which is the kind of wrong that survives a glance. The arm is the LAST
    // segment; everything before it is the id the scorecard uses.
    const { instanceId: caseId, arm } = splitSessionDir(sessionDir);
    const root = join(sessions, sessionDir);
    if (!statSync(root).isDirectory()) continue;
    for (const trial of readdirSync(root)) {
      const tdir = join(root, trial);
      if (!statSync(tdir).isDirectory()) continue;
      const byPhase = new Map<string, PhaseTally>();
      for (const f of readdirSync(tdir)) {
        // `full.jsonl` is the concatenation of the numbered per-phase files —
        // counting it too would double every number in the table.
        if (!f.endsWith(".jsonl") || f === "full.jsonl") continue;
        const phase = basename(f, ".jsonl").replace(/^\d+-/, "");
        if (phaseFilter && !phase.includes(phaseFilter)) continue;
        const { turns, tools } = tallyLines(readFileSync(join(tdir, f), "utf8").split("\n"));
        const t = byPhase.get(phase) ?? {
          case: caseId ?? sessionDir,
          arm: arm ?? "?",
          phase,
          iterations: 0,
          assistantTurns: 0,
          tools: {},
        };
        t.iterations++;
        t.assistantTurns += turns;
        for (const [name, n] of Object.entries(tools)) t.tools[name] = (t.tools[name] ?? 0) + n;
        byPhase.set(phase, t);
      }
      tallies.push(...byPhase.values());
    }
  }
  if (!tallies.length) die(`${dir}: no sessions matched${phaseFilter ? ` --phase ${phaseFilter}` : ""}`);
  return { dir, argv: argvOut, tallies, cost };
}

/** Display-only: `prreview__skillspro-1587-r2` → `skillspro-1587-r2`. The full
 * id is what joins to the scorecard and is never shortened for that. */
function shortCase(id: string): string {
  const i = id.indexOf("__");
  return i >= 0 ? id.slice(i + 2) : id;
}

/** Sum a run's tallies, and the scorecard money that goes with them. */
function totals(run: RunReadout): { turns: number; bash: number; write: number; other: number; usd: number; ms: number } {
  const out = { turns: 0, bash: 0, write: 0, other: 0, usd: 0, ms: 0 };
  for (const t of run.tallies) {
    out.turns += t.assistantTurns;
    for (const [name, n] of Object.entries(t.tools)) {
      if (name === "bash") out.bash += n;
      else if (name === "write") out.write += n;
      else out.other += n;
    }
    // The scorecard keys phases with their iteration suffix (`adjudicate_iter_1`),
    // which is what the transcript filenames carry too, so this joins exactly.
    const c = run.cost[`${t.case}\u0000${t.phase}`];
    if (c) {
      out.usd += c.costUsd;
      out.ms += c.durationMs;
    }
  }
  return out;
}

function main(): void {
  const argv = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    if (i >= 0 && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith("--")) return argv[i + 1];
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    return eq?.slice(name.length + 3);
  };
  phaseFilter = flag("phase");
  const runDirs = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--phase");
  if (!runDirs.length) die("usage: phase-turns.ts <run-dir> [<run-dir> …] [--phase <substring>]");

  const runs = runDirs.map(readRun);

  for (const run of runs) {
    const conc = run.argv.includes("--concurrency") ? run.argv[run.argv.indexOf("--concurrency") + 1] : "?";
    console.log(`\n── ${basename(run.dir)} ${phaseFilter ? `· phase ~ ${phaseFilter}` : ""}`);
    console.log(`   concurrency ${conc}${conc !== "1" ? "  — DURATION IS NOT COMPARABLE across runs at different concurrency" : ""}`);
    console.log(`\n   ${"case".padEnd(20)} ${"phase".padEnd(20)} ${"turns".padStart(6)} ${"bash".padStart(5)} ${"write".padStart(6)} ${"other".padStart(6)} ${"$".padStart(7)} ${"sec".padStart(6)}`);
    for (const t of [...run.tallies].sort((a, b) => a.case.localeCompare(b.case) || a.phase.localeCompare(b.phase))) {
      const bash = t.tools.bash ?? 0;
      const write = t.tools.write ?? 0;
      const other = Object.entries(t.tools).reduce((a, [k, v]) => (k === "bash" || k === "write" ? a : a + v), 0);
      const c = run.cost[`${t.case}\u0000${t.phase}`];
      const iter = t.iterations > 1 ? ` ×${t.iterations}` : "";
      console.log(
        `   ${shortCase(t.case).padEnd(20)} ${(t.phase + iter).padEnd(20)} ${String(t.assistantTurns).padStart(6)} ${String(bash).padStart(5)} ` +
          `${String(write).padStart(6)} ${String(other).padStart(6)} ${(c ? c.costUsd.toFixed(3) : "—").padStart(7)} ${(c ? Math.round(c.durationMs / 1000) : "—").toString().padStart(6)}`,
      );
    }
    const tot = totals(run);
    const n = run.tallies.length;
    console.log(
      `   ${"TOTAL".padEnd(20)} ${`${n} phase-run(s)`.padEnd(20)} ${String(tot.turns).padStart(6)} ${String(tot.bash).padStart(5)} ` +
        `${String(tot.write).padStart(6)} ${String(tot.other).padStart(6)} ${tot.usd.toFixed(3).padStart(7)} ${String(Math.round(tot.ms / 1000)).padStart(6)}`,
    );
    console.log(
      `   ${"MEAN".padEnd(20)} ${"per phase-run".padEnd(20)} ${(tot.turns / n).toFixed(1).padStart(6)} ${(tot.bash / n).toFixed(1).padStart(5)} ` +
        `${(tot.write / n).toFixed(1).padStart(6)} ${(tot.other / n).toFixed(1).padStart(6)} ${(tot.usd / n).toFixed(3).padStart(7)} ${(tot.ms / n / 1000).toFixed(0).padStart(6)}`,
    );
  }

  // ── Before/after ────────────────────────────────────────────────────────────
  if (runs.length > 1) {
    console.log(`\n── COMPARISON (mean per phase-run)`);
    console.log(`   ${"run".padEnd(30)} ${"turns".padStart(7)} ${"bash".padStart(7)} ${"$".padStart(8)} ${"sec".padStart(7)}`);
    for (const run of runs) {
      const t = totals(run);
      const n = run.tallies.length;
      console.log(
        `   ${basename(run.dir).slice(0, 30).padEnd(30)} ${(t.turns / n).toFixed(1).padStart(7)} ${(t.bash / n).toFixed(1).padStart(7)} ` +
          `${(t.usd / n).toFixed(3).padStart(8)} ${(t.ms / n / 1000).toFixed(0).padStart(7)}`,
      );
    }
    const concs = new Set(runs.map((r) => (r.argv.includes("--concurrency") ? r.argv[r.argv.indexOf("--concurrency") + 1] : "?")));
    if (concs.size > 1 || !concs.has("1"))
      console.log(`\n   NOTE: the runs do not all state --concurrency 1, so the sec column compares nothing. Turns and bash are unaffected.`);
    console.log(
      `\n   Read turns and bash FIRST, then the money. A phase that halves its turn\n` +
        `   count by making one enormous call has moved cost, not work — the\n` +
        `   guardrail for that is recall, which this script does not measure.`,
    );
  }
  console.log();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
