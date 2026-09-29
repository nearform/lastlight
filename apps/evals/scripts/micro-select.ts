/**
 * Replay pr-review's `select` phase over preserved sites-engine runs, so the
 * selection model can be compared on identical input.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * `select` (docs/plans/pr-review-units-sites.md) is one agent call over the
 * ~5–20 findings the site investigators pooled: it merges duplicates, sets each
 * item's importance and writes the comments. It cannot drop a finding (the
 * gate enforces conservation), so recall barely moves with the model — what a
 * model changes is WHICH findings are posted (must-fix / worth-mentioning) and
 * which are recorded only (nit), how aggressively it merges, and whether its
 * file passes the gate at all (a failed `select` falls back to posting one item
 * per pooled finding). Sonnet 4.6 ran it in every measured arm; nothing had
 * compared another model on it until this.
 *
 * ── How ────────────────────────────────────────────────────────────────────
 *
 * Input is an eval RUN dir whose pr-review cases kept their artifacts
 * (`scorecard.json` → `results[].pipelineArtifactRel` → `…/pr-review/` with
 * `sites/`), plus `--checkouts`, a root of seeded head checkouts
 * (`<root>/<instance_id>/sandboxes/<task>/<repo>/`, e.g. the Martian
 * `seed-fixtures.ts` output). Per case, on a scratch copy:
 *
 *   1. the checkout, with the run's `pr-review/` artifacts laid in at
 *      `.lastlight/pr-review/` (the run's `selected.json` and `findings.json`
 *      removed — unless `--recorded`);
 *   2. `sites --merge` in-process (`writeSiteMerge` + `renderSiteMerge`, the
 *      `merge` phase's exact output) → `{{phaseOutputs.siteMerge}}`;
 *   3. core's `workflows/prompts/review-select.md`, rendered, run as ONE agent
 *      session under the phase's own command policy, gated by `checkSelection`
 *      (`sites --check-select`) — core's `generic_loop`: same prompt each
 *      round, `--rounds` (2) max, no feedback injected;
 *   4. `finalizeSiteFindings` (`sites --finalize`) → findings.json, exactly
 *      what `post-review` would read.
 *
 * `--recorded` skips 3 and finalizes the run's OWN `selected.json` — the arm
 * that actually ran, scored by the same instrument, for the price of the judge.
 *
 * ── What it measures ───────────────────────────────────────────────────────
 *
 *  - shape: pooled findings, items, merges (pooled − items), importance mix,
 *    posted vs recorded, fallback (the gate failed), gate rounds;
 *  - cost: wall / turns / output tokens / $ per case;
 *  - grading (unless `--no-judge`): the POSTED items, and separately ALL items,
 *    judged against the case gold by the internal-recall judge
 *    (`gradeInternalRecall` × `--gold-votes`, `microGoldVote`) → gold posted,
 *    gold anywhere, and posted precision (posted items that matched a gold ÷
 *    posted). `select` cannot lose gold from ALL items; if gold-anywhere moves
 *    between arms it is judge noise, which makes it the arm's own error bar.
 *
 * Usage (from the evals workspace):
 *   npx tsx <monorepo>/apps/evals/scripts/micro-select.ts <run-dir>... \
 *     --checkouts ~/lastlight-micro-fixtures/martian-seed \
 *     --instances evals/datasets/pr-review-martian/instances.json [options]
 *
 *   --model <m>             default anthropic/claude-sonnet-4-6
 *   --thinking <t>          default none
 *   --recorded              finalize each run's own selected.json; no model
 *   --prompt <p>            default core's workflows/prompts/review-select.md
 *   --rounds <n>            gate-loop rounds (default 2, the phase's max_iterations)
 *   --repeats <n> · --concurrency <n> · --only <ids> · --label <s>
 *   --deadline-minutes <n>  per case (default 15) · --judge-model <m> · --gold-votes <n>
 *   --no-judge · --keep
 *
 * Writes a phase-replay report (kind `select`) to `eval-results/phase-replay/`
 * under cwd — live, atomic, heartbeat — so `run.ts serve` shows it at
 * `#/phase-replay`, with each case's session log and selected.json under
 * `phase-replay/sessions/`.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { checkSelection, finalizeSiteFindings, renderSiteMerge, writeSiteMerge } from "lastlight-code-facts";

import { gradeInternalRecall } from "../src/grade.js";
import { loadDotEnv } from "../src/env.js";
import { defaultJudgeModel } from "../src/judge.js";
import { microGoldVote } from "../src/micro-survey.js";
import { mapPool } from "../src/pool.js";
import {
  PHASE_REPLAY_DIR,
  PHASE_REPLAY_VERSION,
  phaseReplayTotals,
  type PhaseReplayCase,
  type PhaseReplayReport,
  type SelectOutcome,
} from "../src/phase-replay.js";
import {
  followSession,
  goldRefs,
  loadInstances,
  PhaseReportWriter,
  promptContext,
  removeScratch,
  renderPhasePrompt,
  runGateLoop,
  serverRoot,
  sha256,
} from "../src/phase-replay-node.js";
import type { GoldComment } from "../src/schema.js";

// The workspace's `.env` (provider keys), as `lastlight-evals run` loads it.
loadDotEnv();

const argv = process.argv.slice(2);
const VALUED = new Set(["--model", "--thinking", "--prompt", "--rounds", "--repeats", "--concurrency", "--only", "--label", "--deadline-minutes", "--judge-model", "--gold-votes", "--instances", "--checkouts"]);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1] ?? ""));

const recorded = has("--recorded");
const model = flag("--model") ?? "anthropic/claude-sonnet-4-6";
const thinking = flag("--thinking") ?? null;
const promptPath = resolve(flag("--prompt") ?? join(serverRoot, "workflows/prompts/review-select.md"));
const rounds = Math.max(1, Number(flag("--rounds") ?? "2"));
const repeats = recorded ? 1 : Math.max(1, Number(flag("--repeats") ?? "1"));
const concurrency = Math.max(1, Number(flag("--concurrency") ?? "3"));
const only = flag("--only") ? new Set(flag("--only")!.split(",")) : undefined;
const deadlineMs = Math.max(1, Number(flag("--deadline-minutes") ?? "15")) * 60_000;
const goldVotes = Math.max(1, Number(flag("--gold-votes") ?? "3"));
const noJudge = has("--no-judge");
const keep = has("--keep");
const checkoutsRoot = flag("--checkouts") ? resolve(flag("--checkouts")!) : null;
const label = (flag("--label") ?? (recorded ? "recorded" : `${model.split("/").pop()}${thinking ? `-${thinking}` : ""}`)).replace(/[^A-Za-z0-9._@:-]+/g, "_");
const GATE_TIMEOUT_SECONDS = 900;

if (!positional.length || !checkoutsRoot) {
  console.error("usage: micro-select.ts <run-dir>... --checkouts <root> --instances <instances.json> [--model m] [--thinking t] [--recorded] …");
  process.exit(2);
}
if (!existsSync(promptPath)) throw new Error(`no prompt at ${promptPath}`);

/** `pr-review.yaml`'s `select` node's own policy. */
const COMMAND_POLICY = {
  install: "block",
  test: "block",
  host: "block",
  reason:
    "This phase selects; it does not verify. The investigators already ran their probes — read their findings above, and the code only to decide whether two findings are the same defect.",
};

// ── cases ───────────────────────────────────────────────────────────────────

interface Case {
  instanceId: string;
  /** `<run-id>` — the source run, so two repeats of one instance stay apart. */
  run: string;
  /** The run's preserved `…/pr-review/` (has `sites/`). */
  artifacts: string;
  taskDir: string;
  repoDirName: string;
}

/** `<root>/<id>/sandboxes/<task>/<repo>/` — the one task dir and the one repo dir in it. */
function checkoutFor(instanceId: string): { taskDir: string; repoDirName: string } | null {
  const sandboxes = join(checkoutsRoot!, instanceId, "sandboxes");
  if (!existsSync(sandboxes)) return null;
  const tasks = readdirSync(sandboxes).filter((e) => statSync(join(sandboxes, e)).isDirectory());
  if (tasks.length !== 1) return null;
  const taskDir = join(sandboxes, tasks[0]);
  const repos = readdirSync(taskDir).filter((e) => statSync(join(taskDir, e)).isDirectory() && existsSync(join(taskDir, e, ".git")));
  return repos.length === 1 ? { taskDir, repoDirName: repos[0] } : null;
}

function discoverCases(): Case[] {
  const out: Case[] = [];
  for (const dir of positional.map((p) => resolve(p))) {
    const card = join(dir, "scorecard.json");
    if (!existsSync(card)) throw new Error(`${dir} is not an eval run dir (no scorecard.json)`);
    const results = (JSON.parse(readFileSync(card, "utf8")) as { results?: { instance_id: string; pipelineArtifactRel?: string }[] }).results ?? [];
    for (const r of results) {
      if (only && !only.has(r.instance_id)) continue;
      if (!r.pipelineArtifactRel) continue;
      const artifacts = join(dir, r.pipelineArtifactRel);
      if (!existsSync(join(artifacts, "sites"))) {
        console.warn(`  ! ${basename(dir)}/${r.instance_id}: no sites/ in the preserved artifacts — skipped`);
        continue;
      }
      if (recorded && !existsSync(join(artifacts, "sites", "selected.json"))) {
        console.warn(`  ! ${basename(dir)}/${r.instance_id}: no recorded selected.json — skipped`);
        continue;
      }
      const co = checkoutFor(r.instance_id);
      if (!co) {
        console.warn(`  ! ${r.instance_id}: no checkout under ${checkoutsRoot} — skipped`);
        continue;
      }
      out.push({ instanceId: r.instance_id, run: basename(dir), artifacts, ...co });
    }
  }
  return out;
}

// ── report ──────────────────────────────────────────────────────────────────

const instances = loadInstances(flag("--instances"));
let judgeModel: string | null = null;
if (!noJudge) {
  try {
    judgeModel = flag("--judge-model") ?? defaultJudgeModel();
  } catch (err) {
    console.warn(`! no judge (${(err as Error).message}) — no grading`);
  }
}

const cases = discoverCases();
const planned = cases.flatMap((c) => Array.from({ length: repeats }, (_, r) => ({ c, repeat: r + 1 })));
const outDir = join(process.cwd(), "eval-results", PHASE_REPLAY_DIR);
const report: PhaseReplayReport = {
  version: PHASE_REPLAY_VERSION,
  kind: "select",
  label,
  // `--recorded` ran no model: no cost, wall or turns — which is not a free run.
  audit: recorded,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  heartbeat: null,
  error: null,
  config: {
    model: recorded ? "recorded" : model,
    thinking,
    prompt: promptPath,
    promptSha256: sha256(readFileSync(promptPath, "utf8")),
    promptOverride: has("--prompt"),
    skill: null,
    skillOverride: false,
    rounds,
    judgeModel,
    recorded,
    runs: positional.map((p) => resolve(p)),
  },
  planned: planned.map(({ c, repeat }) => ({ instanceId: c.instanceId, arm: c.run, fixture: c.artifacts, repeat })),
  cases: [],
  inFlight: [],
};
const writer = new PhaseReportWriter(report, outDir);
const stem = basename(writer.file, ".json");
console.log(`micro-select · ${label} · ${planned.length} case-run(s) · ${recorded ? "RECORDED (no model)" : `${model}${thinking ? ` · ${thinking}` : ""}`}`);
console.log(`report → ${writer.file}`);

// ── grading ─────────────────────────────────────────────────────────────────

interface FinalFinding {
  path: string;
  line: number;
  title: string;
  body: string;
  importance: string;
  tier?: string;
  siteFindings: string[];
}

/** Judge `findings` against the gold: `--gold-votes` passes, majority per gold. */
async function judge(gold: GoldComment[], findings: FinalFinding[]): Promise<{ goldForFinding: (number | null)[]; goldHit: number[]; error: string | null }> {
  if (!gold.length || !findings.length) return { goldForFinding: findings.map(() => null), goldHit: [], error: null };
  const judgeFs = findings.map((f) => ({ description: `${f.title} (${f.path}:${f.line}). ${f.body}`, file: f.path }));
  const passes = await Promise.all(Array.from({ length: goldVotes }, () => gradeInternalRecall({ gold, findings: judgeFs, judgeModel: judgeModel! })));
  const ok = passes.filter((g) => g && !g.error);
  if (!ok.length) return { goldForFinding: findings.map(() => null), goldHit: [], error: passes.find((g) => g?.error)?.error ?? "judge failed" };
  const { rowForGold } = microGoldVote(
    ok.map((g) => g!.goldToFinding),
    gold.length,
  );
  const goldForFinding: (number | null)[] = findings.map(() => null);
  const goldHit: number[] = [];
  rowForGold.forEach((fi, gi) => {
    if (fi === null) return;
    goldHit.push(gi);
    goldForFinding[fi] = gi;
  });
  return { goldForFinding, goldHit, error: null };
}

// ── one case ────────────────────────────────────────────────────────────────

async function runCase(c: Case, repeat: number): Promise<PhaseReplayCase> {
  const inst = instances.get(c.instanceId);
  if (!inst) console.warn(`  ! ${c.instanceId}: not in --instances — no gold, no grade`);
  const gold = inst?.review_gold ?? [];
  const caseKey = `${c.run}__${c.instanceId}__r${repeat}`;
  const outcome: SelectOutcome = {
    pooled: 0,
    items: null,
    merges: null,
    importance: {},
    posted: null,
    recordedOnly: null,
    fallback: null,
    gateSatisfied: null,
    goldPosted: null,
    goldAnywhere: null,
    postedMatched: null,
    itemsOut: [],
  };
  const result: PhaseReplayCase = {
    instanceId: c.instanceId,
    arm: c.run,
    fixture: c.artifacts,
    repeat,
    ok: true,
    error: null,
    wallMs: null,
    costUsd: null,
    turns: null,
    outputTokens: null,
    iterations: null,
    // The pooled findings are select's input — its "rows".
    rows: 0,
    gold: goldRefs(gold),
    goldRows: null,
    select: outcome,
    session: null,
  };
  const scratch = mkdtempSync(join(tmpdir(), `micro-select-${c.instanceId}-`));
  const sessionDir = join(outDir, "sessions", stem, caseKey);
  const sessionUrl = `/data/${PHASE_REPLAY_DIR}/sessions/${stem}/${caseKey}/full.jsonl`;
  try {
    const ws = join(scratch, "ws");
    cpSync(c.taskDir, ws, { recursive: true });
    const checkout = join(ws, c.repoDirName);
    const prDir = join(checkout, ".lastlight", "pr-review");
    rmSync(prDir, { recursive: true, force: true });
    cpSync(c.artifacts, prDir, { recursive: true });
    rmSync(join(prDir, "findings.json"), { force: true });
    if (!recorded) rmSync(join(prDir, "sites", "selected.json"), { force: true });

    // The `merge` phase, exactly: pool, propose duplicate groups, render.
    const merge = writeSiteMerge(prDir, checkout);
    outcome.pooled = merge.findings.length;
    result.rows = merge.findings.length;

    if (!recorded && merge.findings.length > 0) {
      const { text, unrendered } = renderPhasePrompt(promptPath, { ...promptContext(inst), phaseOutputs: { siteMerge: renderSiteMerge(merge) } });
      if (unrendered) console.warn(`! ${caseKey}: unrendered {{marker}} left in the select prompt`);
      result.session = sessionUrl;
      report.inFlight!.push({ instanceId: c.instanceId, arm: c.run, repeat, startedAt: new Date().toISOString(), session: sessionUrl });
      writer.write();
      const stopFollow = followSession(join(scratch, "agent-sessions"), sessionDir);
      try {
        const loop = await runGateLoop({
          sessionsDir: join(scratch, "agent-sessions"),
          phase: "select",
          deadlineMs,
          model,
          thinking,
          prompt: text,
          cwd: checkout,
          skillDirs: [],
          commandPolicy: COMMAND_POLICY,
          gateTimeoutSeconds: GATE_TIMEOUT_SECONDS,
          rounds,
          gate: () => checkSelection({ dir: prDir, merge }).satisfied,
        });
        Object.assign(result, {
          ok: loop.ok,
          error: loop.error,
          iterations: loop.iterations,
          wallMs: loop.wallMs,
          costUsd: loop.costUsd,
          turns: loop.turns,
          outputTokens: loop.outputTokens,
        });
        outcome.gateSatisfied = loop.gateSatisfied;
      } finally {
        stopFollow();
        report.inFlight = (report.inFlight ?? []).filter((f) => !(f.instanceId === c.instanceId && f.arm === c.run && f.repeat === repeat));
      }
    } else {
      outcome.gateSatisfied = checkSelection({ dir: prDir, merge }).satisfied;
    }

    // `site-finalize`, exactly — the file `post-review` reads.
    const fin = finalizeSiteFindings({ dir: prDir, repo: checkout });
    const selectedSrc = join(prDir, "sites", "selected.json");
    if (existsSync(selectedSrc)) {
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "selected.json"), readFileSync(selectedSrc));
    }
    const items = (JSON.parse(readFileSync(join(prDir, "findings.json"), "utf8")) as { findings: FinalFinding[] }).findings;
    outcome.fallback = fin.source === "fallback" ? fin.fallbackReason : null;
    outcome.items = items.length;
    outcome.merges = merge.findings.length - items.length;
    outcome.posted = fin.posted;
    outcome.recordedOnly = fin.recorded;
    for (const f of items) outcome.importance[f.importance] = (outcome.importance[f.importance] ?? 0) + 1;
    outcome.itemsOut = items.map((f) => ({
      findings: f.siteFindings,
      importance: f.importance,
      posted: f.tier !== "internal",
      title: f.title.slice(0, 200),
      path: f.path,
      line: f.line,
    }));

    // No gold loaded (an id missing from `--instances`, or no `--instances` at
    // all) is NOT a measured zero: leave the gold fields null so the case and
    // the arm read n/a, the module's "absent is not zero" rule.
    if (judgeModel && gold.length) {
      const postedIdx = items.map((f, i) => (f.tier !== "internal" ? i : -1)).filter((i) => i >= 0);
      const [all, posted] = await Promise.all([judge(gold, items), judge(gold, postedIdx.map((i) => items[i]))]);
      const err = all.error ?? posted.error;
      if (err) outcome.judgeError = err;
      else {
        outcome.goldAnywhere = all.goldHit;
        outcome.goldPosted = posted.goldHit;
        outcome.postedMatched = posted.goldForFinding.filter((g) => g !== null).length;
        outcome.itemsOut.forEach((it, i) => (it.gold = all.goldForFinding[i]));
      }
    }
    return result;
  } catch (err) {
    return { ...result, ok: false, error: (err as Error).message.slice(0, 400) };
  } finally {
    if (keep) console.log(`  kept ${scratch}`);
    removeScratch(scratch, keep);
  }
}

// ── run ─────────────────────────────────────────────────────────────────────

const n = (x: number | null | undefined) => (x === null || x === undefined ? "?" : String(x));
try {
  await mapPool(planned, concurrency, async ({ c, repeat }) => {
    const r = await runCase(c, repeat);
    report.cases.push(r);
    writer.write();
    const s = r.select!;
    const imp = ["must-fix", "worth-mentioning", "nit"].map((k) => s.importance[k] ?? 0).join("/");
    console.log(
      `${r.arm}/${r.instanceId} r${repeat}  pooled ${s.pooled}  items ${n(s.items)} (merged ${n(s.merges)})  mf/wm/nit ${imp}  posted ${n(s.posted)}` +
        `${s.fallback ? `  FALLBACK(${s.fallback})` : ""}  gate ${s.gateSatisfied ? "ok" : "UNSAT"} r${n(r.iterations)}` +
        `  gold posted ${s.goldPosted ? s.goldPosted.length : "n/a"}/${r.gold.length} anywhere ${s.goldAnywhere ? s.goldAnywhere.length : "n/a"}` +
        (recorded ? "" : `  ${r.wallMs !== null ? `${Math.round(r.wallMs / 1000)}s` : ""} $${(r.costUsd ?? 0).toFixed(3)}`) +
        (r.ok ? "" : `  ERROR ${r.error}`),
    );
  });
  writer.finish();
} catch (err) {
  writer.finish((err as Error).message);
  throw err;
}

const t = phaseReplayTotals(report);
const sel = t.select!;
console.log(
  [
    `\n${label}: ${t.cases} case-run(s), ${t.errored} errored, ${sel.fallbacks} fallback`,
    `  pooled ${sel.pooled} → items ${sel.items} (merged ${sel.merges}) · posted ${sel.posted} · recorded ${sel.recordedOnly}`,
    `  importance must-fix ${sel.importance["must-fix"] ?? 0} · worth-mentioning ${sel.importance["worth-mentioning"] ?? 0} · nit ${sel.importance.nit ?? 0}`,
    sel.goldPosted === null
      ? "  not judged"
      : `  gold posted ${sel.goldPosted} / anywhere ${sel.goldAnywhere} / total ${t.gold} · posted precision ${sel.precision === null ? "n/a" : sel.precision.toFixed(2)} (${sel.postedMatched}/${sel.posted})`,
    recorded ? "" : `  $${(t.costUsd ?? 0).toFixed(2)} · wall p50 ${t.wallMedianMs === null ? "n/a" : `${Math.round(t.wallMedianMs / 1000)}s`}`,
  ]
    .filter(Boolean)
    .join("\n"),
);
console.log(`done → ${writer.file}  (dashboard: #/phase-replay)`);
// An abandoned session at its deadline keeps a provider call pending forever.
process.exit(0);
