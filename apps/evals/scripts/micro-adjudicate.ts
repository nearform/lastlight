/**
 * Replay the `adjudicate` phase over preserved pr-review fixtures — the
 * workflow's own tail, `dossier --admit` → `adjudicate` (the gate loop) →
 * `reconcile`, on a scratch copy of each fixture — and grade what it promotes.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * Measured on the first unit-survey arm (2026-09-27): Sonnet 4.6 spent 8.7 min
 * writing ~29k output tokens to adjudicate 52 rows, and was still inside one
 * turn after 12 minutes on 173. Adjudicate writes a disposition per row it is
 * shown, so its cost scales with the INPUT — and what it is shown is now a
 * deterministic, testable decision (`lastlight-facts dossier --admit`). This replays the
 * phase with every knob exposed: the admission rules, the model and thinking
 * level, the prompt, the skill.
 *
 * ── What it measures ───────────────────────────────────────────────────────
 *
 *  - the admission: rows admitted / filed, by rule, and the GOLD it filed — a
 *    row the judge matched to a gold that never reached the model. `--audit`
 *    stops there and spends nothing but the (cached) gold map.
 *  - the adjudication: promoted findings (every tier but `internal`), judged
 *    against the case gold by the posted-review grader (`gradeReview`, sibling
 *    gold neutral) → P/R/F1; plus `goldPromoted`, deterministic — gold whose
 *    matched row a promoted finding cites.
 *  - the cost: wall clock, turns, OUTPUT tokens (the lever), $.
 *
 * The gold→row map is judged once per fixture (3 votes, cached under
 * `eval-results/phase-replay/.gold-cache/`), so two arms over one fixture read
 * the same map and its noise never shows up as a difference between them.
 *
 * Usage:
 *   npx tsx <monorepo>/apps/evals/scripts/micro-adjudicate.ts <fixture|dir>... \
 *     --instances evals/datasets/pr-review/instances.json [options]
 *
 *   --rules <spec>     admission (default all): no-clean-quote, no-consequence,
 *                      no-code-change, jev:<category>@<p>, top:<n>
 *   --audit            admission + gold only; no model, no spend beyond the gold map
 *   --model <m>        default anthropic/claude-sonnet-4-6 (the pipeline's)
 *   --thinking <t>     default none (the pipeline passes `variants.review`, unset)
 *   --prompt <p>       a prompt template other than core's review-adjudicate.md
 *   --skill <dir>      a skill dir other than core's skills/adjudicate-pass
 *   --rounds <n>       gate-loop iterations (default 2, the workflow's)
 *   --repeats <n>      default 1
 *   --concurrency <n>  cases in flight (default 1)
 *   --only <ids>       comma list of instance ids
 *   --label <s>        names the report (default: the rules)
 *   --deadline-minutes <n>  per-case deadline (default 20); past it the case is
 *                      recorded as timed out and the replay moves on
 *   --judge-model <m>  default EVAL_JUDGE_MODEL, else by key
 *   --no-judge         location-free: no gold map, no grade
 *   --keep             keep each scratch workspace (path printed)
 *
 * Writes `eval-results/phase-replay/` under cwd → the dashboard's
 * `#/phase-replay`. Run it from the evals workspace.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  checkFindings,
  parseAdmitSpec,
  readAdmission,
  renderAdjudicationDossier,
  stampDerivedSeverity,
  writeAdmission,
} from "lastlight-code-facts";

import { gradeReview } from "../src/grade.js";
import { defaultJudgeModel } from "../src/judge.js";
import { mapPool } from "../src/pool.js";
import {
  PHASE_REPLAY_DIR,
  PHASE_REPLAY_VERSION,
  type AdjudicateOutcome,
  type PhaseReplayCase,
  type PhaseReplayReport,
} from "../src/phase-replay.js";
import {
  goldRefs,
  goldRowMap,
  loadInstances,
  PhaseReportWriter,
  promptContext,
  followSession,
  removeScratch,
  renderPhasePrompt,
  resolveFixtures,
  runGateLoop,
  scratchCopy,
  serverRoot,
  sha256,
  stageSkill,
  type Fixture,
} from "../src/phase-replay-node.js";

const argv = process.argv.slice(2);
const VALUED = new Set(["--deadline-minutes", "--rules", "--model", "--thinking", "--prompt", "--skill", "--rounds", "--repeats", "--concurrency", "--only", "--label", "--judge-model", "--instances", "--gold-votes"]);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1] ?? ""));

const audit = has("--audit");
const spec = parseAdmitSpec(flag("--rules"));
const rulesText = flag("--rules") ?? "all";
const model = flag("--model") ?? "anthropic/claude-sonnet-4-6";
const thinking = flag("--thinking") ?? null;
const promptPath = resolve(flag("--prompt") ?? join(serverRoot, "workflows/prompts/review-adjudicate.md"));
const skillDir = resolve(flag("--skill") ?? join(serverRoot, "skills/adjudicate-pass"));
const rounds = Number(flag("--rounds") ?? "2");
const repeats = Math.max(1, Number(flag("--repeats") ?? "1"));
const concurrency = Math.max(1, Number(flag("--concurrency") ?? "1"));
const only = flag("--only") ? new Set(flag("--only")!.split(",")) : undefined;
const label = (flag("--label") ?? `${audit ? "audit-" : ""}${rulesText}`).replace(/[^A-Za-z0-9._@:-]+/g, "_");
const noJudge = has("--no-judge");
const goldVotes = Math.max(1, Number(flag("--gold-votes") ?? "3"));
const keep = has("--keep");
/** Per-case deadline — see `runGateLoop`. Nothing else bounds an in-process agent. */
const deadlineMs = Math.max(1, Number(flag("--deadline-minutes") ?? "20")) * 60_000;
/** Mirrors `gate.timeoutSeconds` (config/default.yaml). */
const GATE_TIMEOUT_SECONDS = 900;

if (!positional.length) {
  console.error("usage: micro-adjudicate.ts <fixture|dir>... --instances <instances.json> [--rules spec] [--audit] [--model m] …");
  process.exit(2);
}
if (!existsSync(promptPath)) throw new Error(`no prompt at ${promptPath}`);
if (!existsSync(join(skillDir, "SKILL.md"))) throw new Error(`no SKILL.md under ${skillDir}`);

const fixtures = resolveFixtures(positional, only);
const instances = loadInstances(flag("--instances"));
let judgeModel: string | null = null;
if (!noJudge) {
  try {
    judgeModel = flag("--judge-model") ?? defaultJudgeModel();
  } catch (err) {
    console.warn(`! no judge (${(err as Error).message}) — no gold map, no grade`);
  }
}
const outDir = join(process.cwd(), "eval-results", PHASE_REPLAY_DIR);
const goldCache = join(outDir, ".gold-cache");
const promptText = readFileSync(promptPath, "utf8");

const plannedWork = fixtures.flatMap((fx) => Array.from({ length: repeats }, (_, r) => ({ fx, repeat: r + 1 })));
const report: PhaseReplayReport = {
  version: PHASE_REPLAY_VERSION,
  kind: "adjudicate",
  label,
  audit,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  heartbeat: null,
  error: null,
  config: {
    model: audit ? "none" : model,
    thinking,
    prompt: promptPath,
    promptSha256: sha256(promptText),
    promptOverride: has("--prompt"),
    skill: skillDir,
    skillOverride: has("--skill"),
    rounds,
    rules: rulesText,
    judgeModel,
  },
  planned: plannedWork.map(({ fx, repeat }) => ({ instanceId: fx.instanceId, arm: fx.arm, fixture: fx.dir, repeat })),
  cases: [],
  inFlight: [],
};
const writer = new PhaseReportWriter(report, outDir);
const reportStem = basename(writer.file, ".json");
console.log(`phase-replay adjudicate · ${label} · ${plannedWork.length} case-run(s) · ${audit ? "AUDIT (no model)" : `${model}${thinking ? ` · ${thinking}` : ""}`}`);
console.log(`report → ${writer.file}`);

interface Finding {
  tier?: string;
  path?: string;
  line?: number;
  title?: string;
  body?: string;
  hypotheses?: string[];
}

async function runCase(fx: Fixture, repeat: number): Promise<PhaseReplayCase> {
  const inst = instances.get(fx.instanceId);
  const gold = inst?.review_gold ?? [];
  const goldRows = await goldRowMap({ prDir: fx.prDir, gold, judgeModel, votes: goldVotes, cacheDir: goldCache });
  const { scratch, checkout, prDir } = scratchCopy(fx);
  const base: PhaseReplayCase = {
    instanceId: fx.instanceId,
    arm: fx.arm,
    fixture: fx.dir,
    repeat,
    ok: true,
    error: null,
    wallMs: null,
    costUsd: null,
    turns: null,
    outputTokens: null,
    iterations: null,
    rows: 0,
    gold: goldRefs(gold),
    goldRows,
  };
  try {
    // What adjudicate writes, and what a previous admission decided — gone, so
    // the phase starts from exactly what `admit` sees in the pipeline.
    for (const f of ["findings.json", "dossier.md", "admission.json"]) rmSync(join(prDir, f), { force: true });

    // The `dossier --admit` step, through the one entry point the pipeline uses:
    // admission written, then the document rendered from it. An audit needs no
    // document, so it takes the pure half alone.
    const dossier = audit ? null : renderAdjudicationDossier({ dir: prDir, repo: checkout, admit: spec });
    const admission = audit ? writeAdmission(prDir, spec, { repo: checkout }) : readAdmission(prDir);
    if (!admission) throw new Error("admission.json was not written");
    base.rows = admission.rows;
    const filedIds = new Set(admission.filed.map((f) => f.id));
    const filedByRule: Record<string, number> = {};
    for (const f of admission.filed) filedByRule[f.rule] = (filedByRule[f.rule] ?? 0) + 1;
    const goldFiled = (goldRows ?? []).filter((id): id is string => id !== null && filedIds.has(id));
    const outcome: AdjudicateOutcome = {
      admitted: admission.admitted.length,
      filed: admission.filed.length,
      filedByRule,
      goldFiled: [...new Set(goldFiled)],
      promotedInline: 0,
      promotedBody: 0,
      internal: 0,
      dropped: 0,
      gateSatisfied: true,
      goldPromoted: null,
      grade: null,
    };
    if (audit) return { ...base, adjudicate: outcome };

    writeFileSync(join(prDir, "dossier.md"), dossier!);
    const { text: prompt, unrendered } = renderPhasePrompt(promptPath, {
      ...promptContext(inst),
      dossierEnabled: true,
      phaseOutputs: { dossier },
      scratch: { reviewTriage: { skipReview: true } },
    });
    if (unrendered) console.warn(`! ${fx.instanceId}: unrendered {{marker}} left in the adjudicate prompt`);

    const skill = stageSkill(scratch, skillDir);
    const caseKey = `${fx.arm}__${fx.instanceId}__r${repeat}`;
    const sessionDir = join(outDir, "sessions", reportStem, caseKey);
    const sessionUrl = `/data/${PHASE_REPLAY_DIR}/sessions/${reportStem}/${caseKey}/full.jsonl`;
    base.session = sessionUrl;
    const stopFollow = followSession(join(scratch, "agent-sessions"), sessionDir);
    report.inFlight!.push({ instanceId: fx.instanceId, arm: fx.arm, repeat, startedAt: new Date().toISOString(), session: sessionUrl });
    writer.write();
    const loop = await runGateLoop({
      sessionsDir: join(scratch, "agent-sessions"),
      phase: "adjudicate",
      deadlineMs,
      model,
      thinking,
      prompt,
      cwd: checkout,
      skillDirs: [skill],
      commandPolicy: {
        install: "block",
        test: "block",
        host: "block",
        reason:
          "This phase does not execute code. Weigh the probe transcripts falsify already wrote; an unsettled claim is demoted, not re-run.",
      },
      gateTimeoutSeconds: GATE_TIMEOUT_SECONDS,
      rounds,
      gate: () => checkFindings({ dir: prDir, repo: checkout }).satisfied,
    });
    stopFollow();
    report.inFlight = report.inFlight!.filter((f) => !(f.instanceId === fx.instanceId && f.arm === fx.arm && f.repeat === repeat));

    // `reconcile`, as the workflow runs it: the conservation floor, then the
    // derived severity stamp. Both deterministic.
    checkFindings({ dir: prDir, repo: checkout, repair: true });
    stampDerivedSeverity({ dir: prDir, repo: checkout });

    const doc = existsSync(join(prDir, "findings.json"))
      ? (JSON.parse(readFileSync(join(prDir, "findings.json"), "utf8")) as { summary?: string; findings?: Finding[]; dropped?: unknown[] })
      : { findings: [] };
    const findings = doc.findings ?? [];
    const promoted = findings.filter((f) => f.tier && f.tier !== "internal");
    outcome.promotedInline = promoted.filter((f) => f.tier === "inline").length;
    outcome.promotedBody = promoted.length - outcome.promotedInline;
    outcome.internal = findings.length - promoted.length;
    outcome.dropped = Array.isArray(doc.dropped) ? doc.dropped.length : 0;
    outcome.gateSatisfied = loop.gateSatisfied;
    if (goldRows) {
      const cited = new Set(promoted.flatMap((f) => f.hypotheses ?? []));
      outcome.goldPromoted = goldRows.filter((id) => id !== null && cited.has(id)).length;
    }

    if (judgeModel && gold.length) {
      const inline = promoted.filter((f) => f.tier === "inline" && f.path);
      const bodyTier = promoted.filter((f) => !(f.tier === "inline" && f.path));
      const g = await gradeReview({
        gold,
        neutralGold: inst?.review_gold_neutral ?? [],
        judgeModel,
        reviews: [
          {
            event: "COMMENT",
            body: [doc.summary ?? "", ...bodyTier.map((f) => `- **${f.title ?? ""}** ${f.path ? `(${f.path}${f.line ? `:${f.line}` : ""})` : ""} ${f.body ?? ""}`)].join("\n"),
            comments: inline.map((f) => ({ path: f.path!, ...(f.line ? { line: f.line } : {}), body: `**${f.title ?? ""}**\n\n${f.body ?? ""}` })),
          },
        ],
      });
      outcome.grade = {
        precision: g.precision,
        recall: g.recall,
        f1: g.fbeta,
        matched: g.matched,
        posted: g.posted,
        gold: g.gold,
        error: g.error ?? null,
      };
    }
    return {
      ...base,
      ok: loop.ok,
      error: loop.error,
      wallMs: loop.wallMs,
      costUsd: loop.costUsd,
      turns: loop.turns,
      outputTokens: loop.outputTokens,
      iterations: loop.iterations,
      adjudicate: outcome,
    };
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message.slice(0, 400) };
  } finally {
    report.inFlight = (report.inFlight ?? []).filter((f) => !(f.instanceId === fx.instanceId && f.arm === fx.arm && f.repeat === repeat));
    if (keep) console.log(`  kept ${scratch}`);
    removeScratch(scratch, keep);
  }
}

try {
  await mapPool(plannedWork, concurrency, async ({ fx, repeat }) => {
    const c = await runCase(fx, repeat);
    report.cases.push(c);
    writer.write();
    const a = c.adjudicate;
    const g = a?.grade;
    console.log(
      `${fx.arm}/${fx.instanceId} r${repeat}  rows ${c.rows}  admitted ${a?.admitted ?? "?"}  filed ${a?.filed ?? "?"} (gold ${a?.goldFiled.length ?? "?"})` +
        (audit ? "" : `  promoted ${a ? a.promotedInline + a.promotedBody : "?"}  ${g ? `P ${g.precision.toFixed(2)} R ${g.recall.toFixed(2)} F1 ${g.f1.toFixed(2)}` : "ungraded"}  ${c.wallMs !== null ? `${Math.round(c.wallMs / 1000)}s` : ""}  out ${c.outputTokens ?? "?"}  $${(c.costUsd ?? 0).toFixed(2)}`) +
        (c.ok ? "" : `  ERROR ${c.error}`),
    );
  });
  writer.finish();
} catch (err) {
  writer.finish((err as Error).message);
  throw err;
}
console.log(`done → ${writer.file}`);
