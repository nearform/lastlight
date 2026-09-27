/**
 * Replay the per-unit survey (`docs/plans/unit-survey.md` → "Evals") over
 * preserved pr-review workspaces, and score it against the AGENT survey those
 * workspaces already carry.
 *
 * Per fixture (`~/lastlight-micro-fixtures/<arm>/<instance_id>/`), on a COPY of
 * its task dir — a fixture is never written:
 *
 *   facts   the CURRENT workspace build of `lastlight-facts`
 *           (`packages/code-facts/dist/cli.js`, rebuilt first when stale) —
 *           `all --stage-diff`, exactly `pr-review.yaml`'s `facts` node flags,
 *           base = the fixture's `facts.json` `baseSha`.
 *   seed    with the contract / mint / max-obligations the fixture's own seed
 *           used (`obligations.json` + the seed transcript's command), so the
 *           obligations are the ones the agent survey was handed — the report
 *           prints fixture→replay counts so any drift is visible.
 *   spec    `spec-obligations.json` from core's own `buildSpecObligations` over
 *           the instance's PR body, the issues its body closes (the fake
 *           GitHub's `closingIssueNumbers` over `pr.linked_issues`) and the
 *           changed files (`prFilesFromGit`) — the eval harness's own inputs —
 *           checked against the agent spec branch's recorded prompt.
 *   units   `lastlight-facts units`.
 *
 * Stage 1 ($0, always): which gold lines some unit SHOWS the model, plus units,
 * request chars, shared-prefix chars and truncation.
 *
 * Stage 2 (unless `--no-model`): core's `runUnitSurvey` — the runner the
 * `survey-units` phase wraps — with NO cache, then `units-ingest` (+ the
 * `discharge` post-check the YAML runs), then the units' hypotheses AND the
 * fixture's agent hypotheses are scored on the same gold by the same
 * instrument (`scoreRows` → `gradeInternalRecall` + `microGoldRepeat`).
 *
 *   npx tsx apps/evals/scripts/unit-survey-replay.ts \
 *     --fixtures ~/lastlight-micro-fixtures/arm1 --fixtures ~/lastlight-micro-fixtures/arm2 \
 *     --instances ~/work/nearform-evals/evals/datasets/pr-review/instances.json --no-model
 *
 * Flags: --fixtures <dir> (repeatable; an arm dir of instance dirs, or one
 * instance dir) · --instances <file> · --instance <id> (filter) · --no-model ·
 * --model <provider/id> (default the arms' review-survey model) · --variant <lvl>
 * · --concurrency N (units in flight; default the shipped 16) · --deadline S
 * (default the shipped 600) · --judge-model m · --judge-votes N (default 3) ·
 * --no-judge · --label s · --out dir (default eval-results/unit-survey/) ·
 * --keep (leave the temp copies).
 *
 * The report is LIVE — written at start (`running` + the planned cases),
 * rewritten atomically after every case and on a 15 s heartbeat, finalised
 * `done` / `failed` — so the dashboard (`#/unit-survey`, and the home page)
 * shows a replay in progress.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import { parseJsonl } from "lastlight-code-facts";
import {
  buildSpecObligations,
  defaultReviewConfig,
  readUnitsDocument,
  runUnitSurvey,
} from "lastlight-core/evals";
import { renderTemplate } from "lastlight-workflow-engine";

import { closingIssueNumbers } from "../src/fake-github.js";
import { defaultJudgeModel } from "../src/judge.js";
import type { SurveyRow } from "../src/micro-survey-node.js";
import type { GoldComment } from "../src/schema.js";
import { prFilesFromGit } from "../src/seed.js";
import {
  type ReplayCase,
  type ReplayModelRun,
  type ReplayPlannedCase,
  type ReplayReport,
  type ReplayWriteStatus,
  agentSurveyPhase,
  buildReport,
  compareSides,
  formatReport,
  goldRefs,
  goldUnitCoverage,
  scoreRows,
  seedArgsOf,
  sessionEnds,
  specFidelity,
  tallyCoverage,
  unitsShape,
  writeReportAtomic,
} from "../src/unit-survey-replay.js";

// ── Args ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flags = (name: string): string[] => argv.flatMap((a, i) => (a === name && argv[i + 1] ? [argv[i + 1]] : []));
const has = (name: string) => argv.includes(name);

const fixtureRoots = flags("--fixtures").map((p) => resolve(p));
const instancesPath = flag("--instances");
const only = flags("--instance");
const noModel = has("--no-model");
/** The arms' `models.review-survey` — the fan-out's model, which `survey-units` shares. */
const model = flag("--model") ?? "anthropic/claude-haiku-4-5-20251001";
const variant = flag("--variant");
const review = defaultReviewConfig();
const concurrency = Number(flag("--concurrency") ?? review.analysis.surveyUnitConcurrency);
const deadlineSeconds = Number(flag("--deadline") ?? review.analysis.surveyUnitsTimeoutSeconds);
const judgeVotes = Math.max(1, Number(flag("--judge-votes") ?? "3"));
const noJudge = has("--no-judge");
const label = flag("--label") ?? (noModel ? "coverage" : "replay");
const outDir = resolve(flag("--out") ?? join(process.cwd(), "eval-results", "unit-survey"));
const keep = has("--keep");

if (!fixtureRoots.length || !instancesPath) {
  console.error(
    "usage: unit-survey-replay.ts --fixtures <dir> [--fixtures <dir>…] --instances <instances.json> [--instance id] [--no-model]\n" +
      "       [--model provider/id] [--variant lvl] [--concurrency N] [--deadline S] [--judge-model m] [--judge-votes N] [--no-judge]\n" +
      "       [--label s] [--out dir] [--keep]",
  );
  process.exit(2);
}

const repoRoot = resolve(import.meta.dirname, "../../..");
const codeFactsDir = join(repoRoot, "packages/code-facts");
const cli = join(codeFactsDir, "dist/cli.js");
const promptPath = join(repoRoot, "apps/server/workflows/prompts/survey-unit.md");

// ── The facts CLI: the CURRENT workspace build, rebuilt when stale ──────────

function newestMtime(dir: string): number {
  let newest = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    newest = Math.max(newest, s.isDirectory() ? newestMtime(p) : s.mtimeMs);
  }
  return newest;
}
if (!existsSync(cli) || newestMtime(join(codeFactsDir, "src")) > statSync(cli).mtimeMs) {
  console.log(`code-facts dist is stale or missing — building (${codeFactsDir})`);
  execFileSync("pnpm", ["--filter", "lastlight-code-facts", "build"], { cwd: repoRoot, stdio: "inherit" });
}

/** Run the facts CLI in `cwd`; never throws — the exit code and a tail of stderr are returned. */
function facts(cwd: string, args: string[]): { code: number; ms: number; stderr: string } {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status ?? -1, ms: Date.now() - t0, stderr: (r.stderr ?? "").slice(-600) };
}

// ── Instances ───────────────────────────────────────────────────────────────

interface Instance {
  instance_id: string;
  pr: {
    body?: string;
    base_commit: string;
    head_commit: string;
    linked_issues?: { number: number; title?: string; body?: string }[];
  };
  review_gold?: GoldComment[];
  review_gold_neutral?: GoldComment[];
}
const instances = new Map(
  (JSON.parse(readFileSync(resolve(instancesPath), "utf8")) as Instance[]).map((i) => [i.instance_id, i]),
);

// ── Fixtures ────────────────────────────────────────────────────────────────

/** An arm dir of instance dirs, or one instance dir. */
function fixtureDirs(root: string): string[] {
  if (existsSync(join(root, "sandboxes"))) return [root];
  return readdirSync(root)
    .map((e) => join(root, e))
    .filter((p) => existsSync(join(p, "sandboxes")))
    .sort();
}

/** `<fixture>/sandboxes/<task>/` and the git checkout inside it. */
function locate(fixture: string): { task: string; taskDir: string; repo: string } {
  const sandboxes = join(fixture, "sandboxes");
  const task = readdirSync(sandboxes)[0];
  const taskDir = join(sandboxes, task);
  const repo = readdirSync(taskDir).find((e) => existsSync(join(taskDir, e, ".git")));
  if (!repo) throw new Error(`no git checkout under ${taskDir}`);
  return { task, taskDir, repo };
}

/** The first user message of the first transcript whose result is stamped `phase`. */
function recordedPrompt(fixture: string, phase: string): string | null {
  const walk = (dir: string): string[] =>
    existsSync(dir)
      ? readdirSync(dir).flatMap((e) => {
          const p = join(dir, e);
          return statSync(p).isDirectory() ? walk(p) : e.endsWith(".jsonl") ? [p] : [];
        })
      : [];
  for (const file of walk(join(fixture, "agent-sessions"))) {
    const text = readFileSync(file, "utf8");
    if (sessionEnds(text).result?.phase !== phase) continue;
    const first = JSON.parse(text.split("\n")[0]) as { message?: { content?: unknown } };
    const c = first.message?.content;
    return typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string }).text ?? "").join("") : null;
  }
  return null;
}

function obligationCounts(path: string): Record<string, number> {
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as { families?: { family: string; obligations?: number }[] };
    return Object.fromEntries((doc.families ?? []).map((f) => [f.family, f.obligations ?? 0]));
  } catch {
    return {};
  }
}

function readRowsDir(dir: string): { rows: SurveyRow[]; byFamily: Record<string, number> } {
  const rows: SurveyRow[] = [];
  const byFamily: Record<string, number> = {};
  if (!existsSync(dir)) return { rows, byFamily };
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const r = parseJsonl(readFileSync(join(dir, f), "utf8")).rows as SurveyRow[];
    byFamily[f.replace(/\.jsonl$/, "")] = r.length;
    rows.push(...r);
  }
  return { rows, byFamily };
}

let judgeModel: string | null = null;
if (!noModel && !noJudge) {
  try {
    judgeModel = flag("--judge-model") ?? defaultJudgeModel();
  } catch (err) {
    console.warn(`! gold judge unavailable (${(err as Error).message}) — scoring is LOCATION-ONLY (asserted unknown)`);
  }
}

// ── One fixture ─────────────────────────────────────────────────────────────

async function replay(fixture: string, arm: string, inst: Instance): Promise<ReplayCase> {
  const { task, taskDir, repo } = locate(fixture);
  const fixturePr = join(taskDir, repo, ".lastlight/pr-review");
  const gold = inst.review_gold ?? [];
  const scratch = mkdtempSync(join(tmpdir(), "unit-survey-replay-"));
  const work = join(scratch, task);
  cpSync(taskDir, work, { recursive: true });
  const checkout = join(work, repo);
  const prDir = join(checkout, ".lastlight/pr-review");

  try {
    // Only what the pipeline writes from `facts` onward is regenerated; the
    // fixture's own documents are read from the ORIGINAL, never the copy.
    const fixtureFacts = JSON.parse(readFileSync(join(fixturePr, "facts.json"), "utf8")) as { baseSha?: string };
    const fixtureObligations = JSON.parse(readFileSync(join(fixturePr, "obligations.json"), "utf8")) as {
      contract?: string;
      minting?: Record<string, boolean>;
    };
    const base = fixtureFacts.baseSha;
    if (!base) throw new Error("the fixture's facts.json carries no baseSha");
    for (const e of ["facts.json", "obligations.json", "obligations", "diff", "units", "units.json", "spec-obligations.json", "hypotheses"]) {
      rmSync(join(prDir, e), { recursive: true, force: true });
    }

    const f = facts(checkout, ["all", "--repo", ".", "--base", base, "--head", "HEAD", "--out", ".lastlight/pr-review/facts.json", "--stage-diff", "--never-fail"]);
    if (!existsSync(join(prDir, "facts.json"))) throw new Error(`facts wrote nothing (exit ${f.code}): ${f.stderr}`);

    const seed = seedArgsOf(fixtureObligations, recordedPrompt(fixture, "seed"));
    mkdirSync(join(prDir, "hypotheses"), { recursive: true });
    const seedArgs = [
      "seed", "--facts", ".lastlight/pr-review/facts.json", "--out", ".lastlight/pr-review/obligations.json",
      "--contract", seed.contract, "--max-obligations", String(seed.maxObligations), "--blocks", ".lastlight/pr-review/obligations",
      ...(seed.mint ? ["--mint", seed.mint] : []),
    ];
    const s = facts(checkout, seedArgs);

    // Spec obligations, from the harness's own inputs (see the header).
    let spec: ReplayCase["spec"];
    try {
      const body = inst.pr.body ?? "";
      const linked = new Map((inst.pr.linked_issues ?? []).map((i) => [i.number, i]));
      const closes = closingIssueNumbers(body)
        .map((n) => linked.get(n))
        .filter((i): i is NonNullable<typeof i> => !!i)
        .slice(0, 5)
        .map((i) => ({ number: i.number, title: i.title ?? "", body: i.body ?? "" }));
      const changed = prFilesFromGit(checkout, inst.pr.base_commit, inst.pr.head_commit).map((p) => p.filename);
      const set = buildSpecObligations({
        prBody: body,
        closes,
        changedFiles: changed.length ? changed : null,
        max: review.analysis.maxSpecObligations,
      });
      const fidelity = specFidelity(set, recordedPrompt(fixture, "survey_branch_spec"));
      // `specContext` projects the set exactly when it renders: obligations, or
      // a degraded reason. Neither ⇒ no file, as in the pipeline.
      if (set.obligations.length || set.degraded.length) {
        writeFileSync(join(prDir, "spec-obligations.json"), JSON.stringify(set));
      }
      spec = {
        status: set.obligations.length ? "written" : set.degraded.length ? "degraded-only" : "no-spec",
        note:
          `closes ${closes.map((c) => `#${c.number}`).join(",") || "none"} (of ${linked.size} linked issue(s) in instances.json); ` +
          `${changed.length} changed file(s) from git; max ${review.analysis.maxSpecObligations} (default config)`,
        obligations: set.obligations.length,
        degraded: set.degraded,
        fidelity,
      };
    } catch (err) {
      spec = { status: "error", note: (err as Error).message, obligations: 0, degraded: [], fidelity: null };
    }

    const u = facts(checkout, ["units", "--dir", ".lastlight/pr-review", "--repo", ".", "--never-fail"]);
    if (!existsSync(join(prDir, "units.json"))) throw new Error(`units wrote nothing (exit ${u.code}): ${u.stderr}`);
    const doc = readUnitsDocument(join(prDir, "units.json"));

    const coverage = goldUnitCoverage(doc.units as never, gold);
    const neutral = inst.review_gold_neutral ?? [];
    const out: ReplayCase = {
      instanceId: inst.instance_id,
      arm,
      fixture,
      gold: goldRefs(gold),
      seed,
      obligations: { fixture: obligationCounts(join(fixturePr, "obligations.json")), replay: obligationCounts(join(prDir, "obligations.json")) },
      spec,
      shape: unitsShape(doc as never),
      coverage,
      coverageTally: tallyCoverage(coverage),
      neutralTally: neutral.length ? tallyCoverage(goldUnitCoverage(doc.units as never, neutral)) : null,
      deterministicMs: { facts: f.ms, seed: s.ms, units: u.ms },
    };
    if (noModel) return out;

    // ── Stage 2 ───────────────────────────────────────────────────────────
    let modelRun: ReplayModelRun;
    try {
      const responsesDir = join(prDir, "units/responses");
      rmSync(join(prDir, "units"), { recursive: true, force: true });
      rmSync(join(prDir, "hypotheses"), { recursive: true, force: true });
      mkdirSync(responsesDir, { recursive: true });
      mkdirSync(join(prDir, "hypotheses"), { recursive: true });
      const systemPrompt = renderTemplate(readFileSync(promptPath, "utf8"), {} as never);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort("phase deadline"), deadlineSeconds * 1000);
      const t0 = Date.now();
      let run;
      try {
        run = await runUnitSurvey({
          doc,
          systemPrompt,
          model,
          ...(variant ? { variant } : {}),
          concurrency,
          deadlineAt: t0 + deadlineSeconds * 1000,
          signal: controller.signal,
          responsesDir,
          // No cacheDir: every replay pays and measures.
        });
      } finally {
        clearTimeout(timer);
      }
      const wallMs = Date.now() - t0;

      facts(checkout, ["units-ingest", "--dir", ".lastlight/pr-review", "--never-fail"]);
      for (const fam of ["contract", "enforcement", "security", "state", "spec"]) {
        facts(checkout, ["discharge", "--dir", ".lastlight/pr-review", "--family", fam, ...(fam === "spec" ? ["--ungraded"] : [])]);
      }
      const ingest: Record<string, number> = {};
      try {
        const rep = JSON.parse(readFileSync(join(prDir, "units/ingest.json"), "utf8")) as { units?: { status?: string }[] };
        for (const x of rep.units ?? []) ingest[x.status ?? "?"] = (ingest[x.status ?? "?"] ?? 0) + 1;
      } catch {
        ingest.unreadable = 1;
      }

      const unitsRows = readRowsDir(join(prDir, "hypotheses"));
      const agentRows = readRowsDir(join(fixturePr, "hypotheses"));
      const [unitsScore, agentScore] = await Promise.all([
        scoreRows(unitsRows.rows, gold, { judgeModel, votes: judgeVotes }),
        scoreRows(agentRows.rows, gold, { judgeModel, votes: judgeVotes }),
      ]);
      modelRun = {
        model,
        variant: variant ?? null,
        concurrency,
        wallMs,
        costUsd: run.usage.costUsd,
        calls: run.calls,
        unitsOk: run.outcomes.filter((o) => o.record.ok).length,
        unitsFailed: run.outcomes.filter((o) => !o.record.ok).length,
        ingest,
        rowsByFamily: unitsRows.byFamily,
        unitsScore: unitsScore ?? null,
        agentScore: agentScore ?? null,
        agentRows: agentRows.rows.length,
        agentSurvey: agentSurveyPhase(join(fixture, "agent-sessions")),
        sides: compareSides(unitsScore, agentScore),
        judgeModel,
      };
      // Keep the raw replies beside the report — the text is the evidence.
      const keepDir = join(outDir, "responses", `${arm}-${inst.instance_id}`);
      mkdirSync(keepDir, { recursive: true });
      cpSync(responsesDir, join(keepDir, "responses"), { recursive: true });
      cpSync(join(prDir, "hypotheses"), join(keepDir, "hypotheses"), { recursive: true });
      cpSync(join(prDir, "units.json"), join(keepDir, "units.json"));
    } catch (err) {
      modelRun = {
        model, variant: variant ?? null, concurrency, wallMs: 0, costUsd: 0, calls: 0, unitsOk: 0, unitsFailed: 0,
        ingest: {}, rowsByFamily: {}, unitsScore: null, agentScore: null, agentRows: 0,
        agentSurvey: agentSurveyPhase(join(fixture, "agent-sessions")), sides: compareSides(undefined, undefined),
        judgeModel, error: (err as Error).message,
      };
    }
    return { ...out, model: modelRun };
  } finally {
    if (keep) console.log(`  kept ${work}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

// The plan is fixed up front so the report can say how far through it is.
const planned: ReplayPlannedCase[] = [];
for (const root of fixtureRoots) {
  for (const fixture of fixtureDirs(root)) {
    const id = basename(fixture);
    if (only.length && !only.includes(id)) continue;
    const arm = basename(resolve(fixture, ".."));
    if (!instances.has(id)) {
      console.log(`${arm}/${id} … SKIP — not in --instances`);
      continue;
    }
    planned.push({ arm, instanceId: id, fixture });
  }
}

// The report is written at START and after EVERY case, not once at the end, so
// the dashboard shows a replay while it runs (a stage-2 case is minutes). The
// micro-survey's contract (`docs/plans/micro-survey-evals.md` → "The heartbeat
// must tick independently of repeats"): `status` + `heartbeat`, and a `running`
// report whose heartbeat has gone stale was killed. Every write is atomic
// (`writeReportAtomic`) because the dashboard polls while we write.
const startedAt = new Date().toISOString();
const stage = noModel ? "coverage" : "replay";
const cases: ReplayCase[] = [];
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${startedAt.replace(/[:.]/g, "-")}-${label.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);
const write = (status: ReplayWriteStatus, error?: string): ReplayReport => {
  const report = buildReport({ label, startedAt, cli, cases, status, planned, stage, ...(error ? { error } : {}) });
  writeReportAtomic(file, report);
  return report;
};
write("running");
console.log(`report (live): ${file}`);

// A case writes only when it FINISHES, and one stage-2 case outlasts the
// dashboard's 90 s staleness bar — so the heartbeat ticks on its own timer, or
// a healthy run reads as killed mid-case. `unref` so it never holds the
// process open.
const heartbeat = setInterval(() => write("running"), 15_000);
heartbeat.unref?.();

let report: ReplayReport;
try {
  for (const { arm, instanceId: id, fixture } of planned) {
    const inst = instances.get(id) as Instance;
    process.stdout.write(`${arm}/${id} … `);
    try {
      const c = await replay(fixture, arm, inst);
      cases.push(c);
      console.log(
        `units ${c.shape.units}, covered ${c.coverageTally.covered}/${c.coverageTally.locatable}` +
          (c.model ? (c.model.error ? `, model ERROR ${c.model.error}` : `, $${c.model.costUsd.toFixed(3)} ${(c.model.wallMs / 1000).toFixed(0)}s`) : ""),
      );
    } catch (err) {
      console.log(`ERROR ${(err as Error).message}`);
      cases.push({ instanceId: id, arm, fixture, error: (err as Error).message } as ReplayCase);
    }
    write("running");
  }
  clearInterval(heartbeat);
  report = write("done");
} catch (err) {
  // A per-case error is recorded on the case above; this is the run itself
  // throwing. Say so in the file rather than leaving it to read as stale.
  clearInterval(heartbeat);
  write("failed", (err as Error)?.stack ?? String(err));
  throw err;
}
console.log("");
console.log(formatReport(report));
console.log(`\nreport: ${file}`);
