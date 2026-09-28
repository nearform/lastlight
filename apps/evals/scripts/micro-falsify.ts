/**
 * Replay the `falsify` phase over preserved pr-review fixtures — the
 * workflow's own `probe-plan` → `falsify` (the gate loop), on a scratch copy of
 * each fixture — and report what the oracle did with the rows it was given.
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * On the first unit-survey arm (2026-09-27) the gate owed 21 rows on one case
 * and the agent probed one: the prompt keyed on a `severity` field no row
 * carries. `probe-plan` now decides the owed set in code and caps it
 * (`review.analysis.maxProbes`); this measures what a cap, a model, a thinking
 * level or a prompt edit does to the oracle, in minutes.
 *
 * ── What it measures ───────────────────────────────────────────────────────
 *
 *  - the plan: owed / selected / deferred, and which GOLD-matched rows made it.
 *  - the oracle: a verdict per selected row (`none` = it wrote nothing), the
 *    gate's verdict, and above all **gold rows refuted** — the one outcome that
 *    costs recall, because a backed refutation is a permanent deletion.
 *  - the cost: wall clock, turns, output tokens, $.
 *
 * `--audit` stops after the plan: no model, no spend beyond the (cached) gold map.
 * The gold→row map is shared with micro-adjudicate (same cache, same judge).
 *
 * `--plan sites:<k>` (docs/plans/adjudicate-falsify-replay.md) swaps WHICH rows
 * are probed and HOW: code-facts' `planProbeSites` — the top k sites by
 * support (rows from independent survey passes pointing at the same lines),
 * plus every row probe-plan would have selected that none of them holds, as a
 * site of its own — and ONE falsify session per site, in parallel, each on its
 * own scratch copy with that site's `plan.md`/`plan.json`. The prompt and the
 * gate are core's, unmodified; the only new text is the site header in
 * `plan.md`, which asks the session to group its rows into claims (`claim`).
 * Each row sits in one site, so every row has exactly one verdict writer; the
 * sites' verdicts and probe files are merged into the case copy and the gate
 * is run once over the union, as the phase would.
 *
 * Usage:
 *   npx tsx <monorepo>/apps/evals/scripts/micro-falsify.ts <fixture|dir>... \
 *     --instances evals/datasets/pr-review/instances.json [options]
 *
 *   --max-probes <n>   probe-plan's cap (default 8, the shipped default; `none` = no cap)
 *   --plan rows|sites:<k>  `rows` (default) = probe-plan, one session; `sites:<k>` = see above
 *   --window <n>       sites: the line window (default code-facts' DEFAULT_SITE_WINDOW, 20)
 *   --site-concurrency <n>  sites: sessions in flight per case (default 4)
 *   --audit            plan + gold only; no model
 *   --model <m>        default anthropic/claude-haiku-4-5-20251001 (falls through
 *                      to review-survey when review-falsify is unset, as in core)
 *   --thinking <t>     default none
 *   --prompt <p>       a prompt template other than core's review-falsify.md
 *   --rounds <n>       gate-loop iterations (default 2, core's probeRounds)
 *   --install-policy full|static   `static` (default) blocks tests + scratch
 *                      installs, as `probes: static` does
 *   --repeats <n> · --concurrency <n> · --only <ids> · --label <s>
 *   --deadline-minutes <n> (default 20) · --judge-model <m> · --no-judge · --keep
 *
 * Writes `eval-results/phase-replay/` under cwd → the dashboard's `#/phase-replay`.
 */
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  checkProbes,
  DEFAULT_SITE_WINDOW,
  planProbeSites,
  readHypothesisSet,
  readProbeAnswers,
  writeProbePlan,
  writeProbePlanFiles,
  type ProbeSite,
} from "lastlight-code-facts";

import { defaultJudgeModel } from "../src/judge.js";
import { mapPool } from "../src/pool.js";
import {
  PHASE_REPLAY_DIR,
  PHASE_REPLAY_VERSION,
  type FalsifyOutcome,
  type FalsifySite,
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
  type Fixture,
} from "../src/phase-replay-node.js";

const argv = process.argv.slice(2);
const VALUED = new Set(["--deadline-minutes", "--max-probes", "--model", "--thinking", "--prompt", "--rounds", "--repeats", "--concurrency", "--only", "--label", "--judge-model", "--instances", "--gold-votes", "--install-policy", "--plan", "--window", "--site-concurrency"]);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1] ?? ""));

const audit = has("--audit");
const maxProbesRaw = flag("--max-probes") ?? "8";
const maxProbes = maxProbesRaw === "none" ? null : Number(maxProbesRaw);
if (maxProbes !== null && (!Number.isInteger(maxProbes) || maxProbes < 0)) throw new Error(`--max-probes must be a non-negative integer or "none"`);
const planRaw = flag("--plan") ?? "rows";
const sitesMatch = /^sites:(\d+)$/.exec(planRaw);
if (planRaw !== "rows" && !sitesMatch) throw new Error(`--plan must be "rows" or "sites:<k>", not ${planRaw}`);
const topSites = sitesMatch ? Number(sitesMatch[1]) : null;
const siteWindow = Number(flag("--window") ?? DEFAULT_SITE_WINDOW);
const siteConcurrency = Math.max(1, Number(flag("--site-concurrency") ?? "4"));
const model = flag("--model") ?? "anthropic/claude-haiku-4-5-20251001";
const thinking = flag("--thinking") ?? null;
const promptPath = resolve(flag("--prompt") ?? join(serverRoot, "workflows/prompts/review-falsify.md"));
const rounds = Number(flag("--rounds") ?? "2");
const full = (flag("--install-policy") ?? "static") === "full";
const repeats = Math.max(1, Number(flag("--repeats") ?? "1"));
const concurrency = Math.max(1, Number(flag("--concurrency") ?? "1"));
const only = flag("--only") ? new Set(flag("--only")!.split(",")) : undefined;
const label = (flag("--label") ?? `${audit ? "audit-" : ""}${topSites !== null ? `sites${topSites}-` : ""}max${maxProbesRaw}`).replace(/[^A-Za-z0-9._@:-]+/g, "_");
const noJudge = has("--no-judge");
const goldVotes = Math.max(1, Number(flag("--gold-votes") ?? "3"));
const keep = has("--keep");
/** Per-case deadline — see `runGateLoop`. Nothing else bounds an in-process agent. */
const deadlineMs = Math.max(1, Number(flag("--deadline-minutes") ?? "20")) * 60_000;
const GATE_TIMEOUT_SECONDS = 900;

if (!positional.length) {
  console.error("usage: micro-falsify.ts <fixture|dir>... --instances <instances.json> [--max-probes n|none] [--audit] [--model m] …");
  process.exit(2);
}
if (!existsSync(promptPath)) throw new Error(`no prompt at ${promptPath}`);

const fixtures = resolveFixtures(positional, only);
const instances = loadInstances(flag("--instances"));
let judgeModel: string | null = null;
if (!noJudge) {
  try {
    judgeModel = flag("--judge-model") ?? defaultJudgeModel();
  } catch (err) {
    console.warn(`! no judge (${(err as Error).message}) — no gold map`);
  }
}
const outDir = join(process.cwd(), "eval-results", PHASE_REPLAY_DIR);
const goldCache = join(outDir, ".gold-cache");

const plannedWork = fixtures.flatMap((fx) => Array.from({ length: repeats }, (_, r) => ({ fx, repeat: r + 1 })));
const report: PhaseReplayReport = {
  version: PHASE_REPLAY_VERSION,
  kind: "falsify",
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
    promptSha256: sha256(readFileSync(promptPath, "utf8")),
    promptOverride: has("--prompt"),
    skill: null,
    skillOverride: false,
    rounds,
    maxProbes,
    ...(topSites !== null ? { plan: planRaw, window: siteWindow } : {}),
    judgeModel,
  },
  planned: plannedWork.map(({ fx, repeat }) => ({ instanceId: fx.instanceId, arm: fx.arm, fixture: fx.dir, repeat })),
  cases: [],
  inFlight: [],
};
const writer = new PhaseReportWriter(report, outDir);
const reportStem = basename(writer.file, ".json");
console.log(`phase-replay falsify · ${label} · ${plannedWork.length} case-run(s) · ${audit ? "AUDIT (no model)" : `${model}${thinking ? ` · ${thinking}` : ""}`}`);
console.log(`report → ${writer.file}`);

/** Everything falsify writes under `probes/`, gone — `env.json` is `prepare`'s and stays. */
function clearProbes(prDir: string): void {
  const dir = join(prDir, "probes");
  if (!existsSync(dir)) return;
  for (const f of readdirSync(dir)) if (f !== "env.json") rmSync(join(dir, f), { recursive: true, force: true });
}

const COMMAND_POLICY = {
  install: "block",
  "install-scratch": full ? "log" : "block",
  test: full ? "log" : "block",
  host: "log",
  reason:
    "Installing the repository's dependencies is the prepare phase's job, and the whole suite is never a probe. Run the one targeted check this hypothesis needs, or record it unprobed.",
};

/**
 * One falsify gate loop — core's prompt and gate — over one scratch copy.
 * Records what the gate rejected after EACH round (`gapsByRound`): core's loop
 * re-renders the same prompt with no gap list, so a failed round 1 buys a
 * round 2 that cannot know what to fix, and this is the only record of why.
 */
async function falsifySession(opts: { scratch: string; checkout: string; prDir: string; prompt: string; sessionDir: string }) {
  const stopFollow = followSession(join(opts.scratch, "agent-sessions"), opts.sessionDir);
  const gapsByRound: Record<string, number>[] = [];
  let gateNotes: string[] = [];
  const gate = () => {
    const check = checkProbes({ dir: opts.prDir, repo: opts.checkout });
    const kinds: Record<string, number> = {};
    for (const g of check.gaps) kinds[g.kind] = (kinds[g.kind] ?? 0) + 1;
    gapsByRound.push(kinds);
    gateNotes = [...check.gaps.slice(0, 6).map((g) => `${g.kind} ${g.hypothesis}: ${g.detail}`.slice(0, 200)), ...check.notes.slice(0, 4)];
    return check.satisfied;
  };
  try {
    const loop = await runGateLoop({
      sessionsDir: join(opts.scratch, "agent-sessions"),
      phase: "falsify",
      deadlineMs,
      model,
      thinking,
      prompt: opts.prompt,
      cwd: opts.checkout,
      skillDirs: [],
      commandPolicy: COMMAND_POLICY,
      gateTimeoutSeconds: GATE_TIMEOUT_SECONDS,
      rounds,
      gate,
    });
    return { ...loop, gapsByRound, gateNotes };
  } finally {
    stopFollow();
  }
}

/** Verdict lines as written, `claim` included — `readProbeAnswers` keeps only what the gate reads. */
function rawVerdicts(prDir: string): Record<string, unknown>[] {
  const file = join(prDir, "probes", "verdicts.jsonl");
  if (!existsSync(file)) return [];
  const out: Record<string, unknown>[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* malformed — the gate reports it */
    }
  }
  return out;
}

/** Everything a site session left under `probes/` but the plan and verdicts, into the case copy. */
function mergeProbeFiles(fromPrDir: string, toPrDir: string): number {
  const from = join(fromPrDir, "probes");
  if (!existsSync(from)) return 0;
  let collisions = 0;
  for (const f of readdirSync(from)) {
    if (["env.json", "plan.json", "plan.md", "verdicts.jsonl"].includes(f)) continue;
    const to = join(toPrDir, "probes", f);
    if (existsSync(to)) collisions++;
    cpSync(join(from, f), to, { recursive: true, force: true });
  }
  return collisions;
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
  const caseKey = `${fx.arm}__${fx.instanceId}__r${repeat}`;
  try {
    clearProbes(prDir);
    const set = readHypothesisSet(prDir);
    const sitePlan = topSites !== null ? planProbeSites(set, { topSites, window: siteWindow, maxProbes }) : null;
    // The union is what the gate checks, exactly as `probe-plan` writes it in the rows mode.
    const plan = sitePlan ? writeProbePlanFiles(prDir, sitePlan.union, set).plan : writeProbePlan(prDir, { maxProbes }).plan;
    base.rows = plan.rows;
    const selected = plan.selected.map((p) => p.id);
    const goldIds = new Set((goldRows ?? []).filter((id): id is string => id !== null));
    const outcome: FalsifyOutcome = {
      owed: plan.owed,
      selected: selected.length,
      deferred: plan.deferred.length,
      verdicts: {},
      gateSatisfied: true,
      gaps: 0,
      goldSelected: selected.filter((id) => goldIds.has(id)),
      goldRefuted: [],
      goldReproduced: [],
    };
    const siteShell = (site: ProbeSite): FalsifySite => ({
      id: site.id,
      origin: site.origin,
      path: site.path,
      startLine: site.startLine,
      endLine: site.endLine,
      rows: site.rows.length,
      gold: site.rows.filter((id) => goldIds.has(id)),
      ok: true,
      error: null,
      wallMs: null,
      costUsd: null,
      turns: null,
      outputTokens: null,
      gateSatisfied: null,
      verdicts: {},
      claims: null,
      session: null,
    });
    if (sitePlan) outcome.sites = sitePlan.sites.map(siteShell);
    if (audit || selected.length === 0) return { ...base, falsify: outcome };

    const { text: prompt, unrendered } = renderPhasePrompt(promptPath, promptContext(inst));
    if (unrendered) console.warn(`! ${fx.instanceId}: unrendered {{marker}} left in the falsify prompt`);
    const sessionRoot = join(outDir, "sessions", reportStem, caseKey);
    const sessionUrlRoot = `/data/${PHASE_REPLAY_DIR}/sessions/${reportStem}/${caseKey}`;
    // Rows mode: one entry for the case. Sites mode: one per RUNNING site, added
    // and removed as each starts and ends, so the live view never points at a
    // finished site's log while others are still going.
    if (!sitePlan) {
      report.inFlight!.push({ instanceId: fx.instanceId, arm: fx.arm, repeat, startedAt: new Date().toISOString(), session: `${sessionUrlRoot}/full.jsonl` });
      writer.write();
    }

    const started = Date.now();
    let loopOk = true;
    let loopError: string | null = null;
    let cost = 0;
    let turns = 0;
    let outTokens = 0;
    let iterations = 0;
    if (!sitePlan) {
      base.session = `${sessionUrlRoot}/full.jsonl`;
      const loop = await falsifySession({ scratch, checkout, prDir, prompt, sessionDir: sessionRoot });
      ({ ok: loopOk, error: loopError } = loop);
      cost = loop.costUsd;
      turns = loop.turns;
      outTokens = loop.outputTokens;
      iterations = loop.iterations;
    } else {
      // One session per site, each on its own copy with the site's plan; merged
      // back in site order so the case copy holds one verdict per row.
      const merged: string[] = [];
      let collisions = 0;
      const results = await mapPool(sitePlan.sites, siteConcurrency, async (site, i) => {
        const copy = scratchCopy(fx);
        const shell = outcome.sites![i];
        try {
          clearProbes(copy.prDir);
          writeProbePlanFiles(copy.prDir, site.plan, set, site);
          shell.session = `${sessionUrlRoot}/${site.id}/full.jsonl`;
          report.inFlight!.push({ instanceId: fx.instanceId, arm: fx.arm, repeat, site: site.id, startedAt: new Date().toISOString(), session: shell.session });
          writer.write();
          const loop = await falsifySession({ ...copy, prompt, sessionDir: join(sessionRoot, site.id) });
          const lines = rawVerdicts(copy.prDir);
          const claims = new Set(lines.map((l) => l.claim).filter((c): c is string => typeof c === "string" && c.trim() !== ""));
          const { answers } = readProbeAnswers({ dir: copy.prDir, repo: copy.checkout }, set);
          for (const id of site.rows) {
            const v = answers.get(id)?.verdict ?? "none";
            shell.verdicts[v] = (shell.verdicts[v] ?? 0) + 1;
          }
          Object.assign(shell, {
            ok: loop.ok,
            error: loop.error,
            wallMs: loop.wallMs,
            costUsd: loop.costUsd,
            turns: loop.turns,
            outputTokens: loop.outputTokens,
            gateSatisfied: loop.gateSatisfied,
            claims: claims.size ? claims.size : null,
            gapsByRound: loop.gapsByRound,
            gateNotes: loop.gateNotes,
          });
          collisions += mergeProbeFiles(copy.prDir, prDir);
          return { lines, loop };
        } catch (err) {
          Object.assign(shell, { ok: false, error: (err as Error).message.slice(0, 400) });
          return { lines: [] as Record<string, unknown>[], loop: null };
        } finally {
          report.inFlight = (report.inFlight ?? []).filter((f) => !(f.instanceId === fx.instanceId && f.arm === fx.arm && f.repeat === repeat && f.site === site.id));
          removeScratch(copy.scratch, keep);
          writer.write();
        }
      });
      for (const { lines, loop } of results) {
        merged.push(...lines.map((l) => JSON.stringify(l)));
        if (!loop) continue;
        cost += loop.costUsd;
        turns += loop.turns;
        outTokens += loop.outputTokens;
        iterations = Math.max(iterations, loop.iterations);
      }
      const failed = outcome.sites!.filter((x) => !x.ok);
      loopOk = failed.length === 0;
      loopError = failed.length ? `${failed.length} site(s) failed: ${failed.map((x) => `${x.id} ${x.error}`).join("; ").slice(0, 380)}` : null;
      writeFileSync(join(prDir, "probes", "verdicts.jsonl"), merged.length ? `${merged.join("\n")}\n` : "");
      if (collisions) console.warn(`! ${fx.instanceId}: ${collisions} probe file name(s) collided across sites (last write kept)`);
    }

    const check = checkProbes({ dir: prDir, repo: checkout });
    const { answers } = readProbeAnswers({ dir: prDir, repo: checkout }, readHypothesisSet(prDir));
    for (const id of selected) {
      const v = answers.get(id)?.verdict ?? "none";
      outcome.verdicts[v] = (outcome.verdicts[v] ?? 0) + 1;
      if (goldIds.has(id) && v === "refuted") outcome.goldRefuted.push(id);
      if (goldIds.has(id) && v === "reproduced") outcome.goldReproduced.push(id);
    }
    outcome.gateSatisfied = check.satisfied;
    outcome.gaps = check.gaps.length;
    return {
      ...base,
      ok: loopOk,
      error: loopError,
      wallMs: Date.now() - started,
      costUsd: cost,
      turns,
      outputTokens: outTokens,
      iterations,
      falsify: outcome,
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
    const f = c.falsify;
    console.log(
      `${fx.arm}/${fx.instanceId} r${repeat}  rows ${c.rows}  selected ${f?.selected ?? "?"}/${f?.owed ?? "?"}  gold-selected ${f?.goldSelected.length ?? "?"}` +
        (f?.sites ? `  sites ${f.sites.length} (${f.sites.filter((x) => x.origin === "owed").length} owed)` : "") +
        (audit ? "" : `  verdicts ${JSON.stringify(f?.verdicts ?? {})}  gold-refuted ${f?.goldRefuted.length ?? "?"}  ${c.wallMs !== null ? `${Math.round(c.wallMs / 1000)}s` : ""}  $${(c.costUsd ?? 0).toFixed(2)}`) +
        (c.ok ? "" : `  ERROR ${c.error}`),
    );
  });
  writer.finish();
} catch (err) {
  writer.finish((err as Error).message);
  throw err;
}
console.log(`done → ${writer.file}`);
