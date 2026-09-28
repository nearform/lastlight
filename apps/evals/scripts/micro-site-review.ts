/**
 * Replay a per-SITE investigator over preserved pr-review fixtures — the
 * "site review" experiment in docs/plans/adjudicate-falsify-replay.md ("Site
 * review: rows as volume, leads not items").
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * The falsify-per-site pilot was safe but spent $6.38 and 769 turns on one
 * case writing a verdict per hypothesis row: per-row verdicts make the verifier
 * do bookkeeping and anchor it on each row's framing. Here the rows are only a
 * VOLUME signal. `clusterSites` (±`--window`, distinct-unit votes with split
 * siblings collapsed via the fixture's `units.json`, spans capped at
 * `--max-span`, test files skipped) picks the top `--top-sites` sites, and
 * each gets ONE agentic session — an investigator that reads a site brief
 * (`renderSiteBrief`) and writes FINDINGS, not verdicts. Rows are never
 * deleted or dispositioned.
 *
 * Three arms, `--leads`:
 *  - `none`      (arm A) — the brief alone: where, and how strong the vote is.
 *  - `subjects`  (arm B) — plus `siteLeads`: the rows' deduplicated
 *                `evidence.subject` fields, numbered.
 *  - `summary`   (arm C) — plus ≤ 5 numbered CONCERNS: one non-agentic call
 *                per site (`--summary-model`, Haiku by default; prompt
 *                core's `workflows/prompts/review-site-summary.md`) MERGES the
 *                site's rows by defect mechanism — never discards one — into
 *                at most min(8, max(2, ⌈rows/2⌉)) concerns. Arm B
 *                barely deduplicates (≈ one lead per row), so it is not a
 *                summary; this is. The reply is validated in code and cached
 *                on disk (`src/site-summary.ts`); a malformed reply retries
 *                once, then the site falls back to arm B's leads
 *                (`summary.fallback`). A finding's `leads` cite concern numbers.
 *                `--summaries-only` stops after the summary calls (cents):
 *                an audit-like report with each site's concerns.
 *
 * ── The gate loop DIFFERS from core on purpose ─────────────────────────────
 *
 * Core's `generic_loop` re-renders the same prompt after a failed gate, and
 * the falsify pilot showed what that costs: round 2 cannot know what the gate
 * rejected. This replay's round 2 prompt APPENDS the previous round's gaps
 * ("The gate rejected your previous output: …", `renderGateFeedback`), via
 * `runGateLoop`'s `promptForRound`. The gate itself is `checkSiteFindings`
 * (`src/site-review.ts`): the file parses, one `none` line or 1–3 findings,
 * real paths and lines, and a transcript echoing `command` behind every
 * `reproduced`/`corroborated`. A `none` must be EARNED: its `checked` list
 * holds `noneChecksRequired(site rows)` suspicions (1 on a ≤ 3-row site, else
 * 2), each with a transcript echoing its command, and at least one command an
 * execution by falsify's read classifier (`isExecutionCommand`) — the prompt
 * gets the number as `{{noneChecks}}`. `gapsByRound` records it per site.
 *
 * ── What it measures ───────────────────────────────────────────────────────
 *
 *  - selection ($0, `--audit`): sites, rows, voters, leads, skipped test rows,
 *    and which GOLD-mapped rows (the cached gold→row map shared with
 *    micro-falsify / micro-adjudicate) fall inside the selected sites.
 *  - the investigators: findings per site, `none` sites, gate rounds, and
 *    wall / turns / output tokens / $ per site and per case.
 *  - grading: every finding judged against the case gold by the internal-recall
 *    judge the gold map uses (`gradeInternalRecall`, 3 votes, `microGoldVote`)
 *    → gold stated, and precision = matched findings ÷ findings. A few cents
 *    per case; skipped under `--no-judge`.
 *
 * Usage (from the evals workspace):
 *   npx tsx <monorepo>/apps/evals/scripts/micro-site-review.ts <fixture|dir>... \
 *     --instances evals/datasets/pr-review/instances.json [options]
 *
 *   --leads none|subjects|summary   arm A / arm B / arm C (default none — arm A won the
 *                           human grading, 71% real vs C's 41%)
 *   --summary-model <m>     arm C's summary call (default anthropic/claude-haiku-4-5-20251001)
 *   --summaries-only        arm C: selection + summary calls only, no investigator
 *   --top-sites <k>         sites per case (default 5)
 *   --sites <id:rank,...>   investigate only these ranked sites (1-based, within
 *                           --top-sites) — e.g. `prreview__cal-com-8330:1`; a case
 *                           with no entry runs none. Replays a chosen few sites.
 *   --window <n>            clusterSites' line window (default 20)
 *   --max-span <n|none>     clusterSites' span cap (default 60)
 *   --voters unit|row       the ranking vote (default unit)
 *   --no-skip-tests         rank test files too (default: `isTestPath` skipped)
 *   --site-concurrency <n>  investigator sessions in flight per case (default 4)
 *   --audit                 selection + gold only; no model
 *   --model <m>             default anthropic/claude-haiku-4-5-20251001
 *   --thinking <t>          default none
 *   --prompt <p>            default core's workflows/prompts/review-site.md
 *   --rounds <n>            gate-loop rounds (default 2)
 *   --repeats <n> · --concurrency <n> · --only <ids> · --label <s>
 *   --deadline-minutes <n>  per site (default 12) · --judge-model <m> · --no-judge · --keep
 *
 * Writes `eval-results/phase-replay/` under cwd → the dashboard's `#/phase-replay`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import {
  clusterSites,
  isTestPath,
  readHypothesisSet,
  renderSiteAssignment,
  type HypothesisSet,
  type Site,
  type VoterUnit,
} from "lastlight-code-facts";

import { gradeInternalRecall } from "../src/grade.js";
import { defaultJudgeModel } from "../src/judge.js";
import { microGoldVote } from "../src/micro-survey.js";
import { mapPool } from "../src/pool.js";
import {
  PHASE_REPLAY_DIR,
  PHASE_REPLAY_VERSION,
  type PhaseReplayCase,
  type PhaseReplayReport,
  type SiteReviewFinding,
  type SiteReviewOutcome,
  type SiteReviewSite,
  type SiteReviewSummary,
} from "../src/phase-replay.js";
import {
  followSession,
  goldRefs,
  goldRowMap,
  loadInstances,
  PhaseReportWriter,
  promptContext,
  removeScratch,
  renderPhasePrompt,
  resolveFixtures,
  runGateLoop,
  scratchCopy,
  serverRoot,
  sha256,
  type Fixture,
} from "../src/phase-replay-node.js";
import {
  checkSiteFindings,
  findingsAsJudgeFindings,
  noneChecksRequired,
  renderGateFeedback,
  siteBriefRel,
  siteFindingsRel,
  type SiteFinding,
  type SiteGap,
} from "../src/site-review.js";
import type { GoldComment } from "../src/schema.js";
import { DEFAULT_SUMMARY_MODEL, siteBriefFor, siteSummaryRows, summariseSite, type LeadsMode, type SiteSummaryResult } from "../src/site-summary.js";

const argv = process.argv.slice(2);
const VALUED = new Set(["--deadline-minutes", "--model", "--thinking", "--prompt", "--rounds", "--repeats", "--concurrency", "--only", "--label", "--judge-model", "--instances", "--gold-votes", "--leads", "--top-sites", "--window", "--max-span", "--voters", "--site-concurrency", "--summary-model", "--sites"]);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const positional = argv.filter((a, i) => !a.startsWith("--") && !VALUED.has(argv[i - 1] ?? ""));

const audit = has("--audit");
const leadsMode = (flag("--leads") ?? "none") as LeadsMode;
if (leadsMode !== "none" && leadsMode !== "subjects" && leadsMode !== "summary") throw new Error(`--leads must be "none", "subjects" or "summary", not ${leadsMode}`);
const summariesOnly = has("--summaries-only");
if (summariesOnly && leadsMode !== "summary") throw new Error("--summaries-only needs --leads summary");
if (summariesOnly && audit) throw new Error("--summaries-only and --audit are exclusive: --audit calls no model");
/** Arm C's summary calls run unless `--audit` promised $0. */
const withSummary = leadsMode === "summary" && !audit;
const summaryModel = flag("--summary-model") ?? DEFAULT_SUMMARY_MODEL;
const summaryPromptPath = join(serverRoot, "workflows/prompts/review-site-summary.md");
const topSites = Number(flag("--top-sites") ?? "5");
if (!Number.isInteger(topSites) || topSites < 1) throw new Error("--top-sites must be a positive integer");
/** `--sites`: instance id → the 1-based ranks to investigate. */
const siteFilter = (() => {
  const raw = flag("--sites");
  if (!raw) return null;
  const m = new Map<string, Set<number>>();
  for (const entry of raw.split(",")) {
    const at = entry.lastIndexOf(":");
    const rank = Number(entry.slice(at + 1));
    if (at <= 0 || !Number.isInteger(rank) || rank < 1 || rank > topSites) throw new Error(`--sites entry "${entry}" is not <instance-id>:<rank 1..${topSites}>`);
    const id = entry.slice(0, at);
    m.set(id, (m.get(id) ?? new Set()).add(rank));
  }
  return m;
})();
const siteWindow = Number(flag("--window") ?? "20");
const maxSpanRaw = flag("--max-span") ?? "60";
const maxSpan = maxSpanRaw === "none" ? null : Number(maxSpanRaw);
if (maxSpan !== null && (!Number.isInteger(maxSpan) || maxSpan < 0)) throw new Error(`--max-span must be a non-negative integer or "none"`);
const voters = flag("--voters") ?? "unit";
if (voters !== "unit" && voters !== "row") throw new Error(`--voters must be "unit" or "row", not ${voters}`);
const skipTests = !has("--no-skip-tests");
const siteConcurrency = Math.max(1, Number(flag("--site-concurrency") ?? "4"));
const model = flag("--model") ?? "anthropic/claude-haiku-4-5-20251001";
const thinking = flag("--thinking") ?? null;
const promptPath = resolve(flag("--prompt") ?? join(serverRoot, "workflows/prompts/review-site.md"));
const rounds = Math.max(1, Number(flag("--rounds") ?? "2"));
const repeats = Math.max(1, Number(flag("--repeats") ?? "1"));
const concurrency = Math.max(1, Number(flag("--concurrency") ?? "1"));
const only = flag("--only") ? new Set(flag("--only")!.split(",")) : undefined;
const label = (flag("--label") ?? `${audit ? "audit-" : summariesOnly ? "summaries-" : ""}sites${topSites}-leads-${leadsMode}`).replace(/[^A-Za-z0-9._@:-]+/g, "_");
const noJudge = has("--no-judge");
const goldVotes = Math.max(1, Number(flag("--gold-votes") ?? "3"));
const keep = has("--keep");
/** Per-SITE deadline (the whole gate loop) — nothing else bounds an in-process agent. */
const deadlineMs = Math.max(1, Number(flag("--deadline-minutes") ?? "12")) * 60_000;
const GATE_TIMEOUT_SECONDS = 900;

if (!positional.length) {
  console.error("usage: micro-site-review.ts <fixture|dir>... --instances <instances.json> [--leads none|subjects] [--top-sites 5] [--audit] …");
  process.exit(2);
}
if (!existsSync(promptPath)) throw new Error(`no prompt at ${promptPath}`);
if (leadsMode === "summary" && !existsSync(summaryPromptPath)) throw new Error(`no summary prompt at ${summaryPromptPath}`);
const summaryPrompt = leadsMode === "summary" ? readFileSync(summaryPromptPath, "utf8") : "";

const fixtures = resolveFixtures(positional, only).filter((fx) => !siteFilter || siteFilter.has(fx.instanceId));
const instances = loadInstances(flag("--instances"));
let judgeModel: string | null = null;
if (!noJudge) {
  try {
    judgeModel = flag("--judge-model") ?? defaultJudgeModel();
  } catch (err) {
    console.warn(`! no judge (${(err as Error).message}) — no gold map, no grading`);
  }
}
const outDir = join(process.cwd(), "eval-results", PHASE_REPLAY_DIR);
const goldCache = join(outDir, ".gold-cache");
const summaryCache = join(outDir, ".summary-cache");

const plannedWork = fixtures.flatMap((fx) => Array.from({ length: repeats }, (_, r) => ({ fx, repeat: r + 1 })));
const report: PhaseReplayReport = {
  version: PHASE_REPLAY_VERSION,
  kind: "site-review",
  label,
  // `--summaries-only` is audit-like: no investigator ran, so no findings or
  // investigator stats — the summary spend is on each site and in the totals.
  audit: audit || summariesOnly,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  status: "running",
  heartbeat: null,
  error: null,
  config: {
    model: audit || summariesOnly ? "none" : model,
    thinking,
    prompt: promptPath,
    promptSha256: sha256(readFileSync(promptPath, "utf8")),
    promptOverride: has("--prompt"),
    skill: null,
    skillOverride: false,
    rounds,
    leads: leadsMode,
    ...(leadsMode === "summary" ? { summaryModel, summaryPromptSha256: sha256(summaryPrompt), summariesOnly } : {}),
    topSites,
    window: siteWindow,
    maxSpan,
    voters,
    skipTests,
    judgeModel,
  },
  planned: plannedWork.map(({ fx, repeat }) => ({ instanceId: fx.instanceId, arm: fx.arm, fixture: fx.dir, repeat })),
  cases: [],
  inFlight: [],
};
const writer = new PhaseReportWriter(report, outDir);
const reportStem = basename(writer.file, ".json");
console.log(
  `phase-replay site-review · ${label} · ${plannedWork.length} case-run(s) · ${audit ? "AUDIT (no model)" : summariesOnly ? `SUMMARIES ONLY (${summaryModel})` : `${model}${thinking ? ` · ${thinking}` : ""}${withSummary ? ` · summaries ${summaryModel}` : ""}`}`,
);
console.log(`report → ${writer.file}`);

/** Same policy as micro-falsify's `static`: no installs, no test suite. */
const COMMAND_POLICY = {
  install: "block",
  "install-scratch": "block",
  test: "block",
  host: "log",
  reason:
    "Installing the repository's dependencies is not this pass's job, and the whole suite is never a probe. Run the one targeted check the site needs, or report what you read.",
};

/**
 * The fan-out's `context_file` section (core `handlers/fanout.ts`,
 * `BRANCH_CONTEXT_HEADING`), reproduced so the replay's prompt ends the way a
 * `site-review` branch's does.
 */
function attachBrief(relPath: string, body: string): string {
  return [
    "## Attached: the file this pass was seeded with",
    "",
    `The contents of \`${relPath}\` are reproduced below **verbatim**. It has`,
    "already been read for you — do not open it, and do not construct a path to it.",
    "",
    body.trimEnd(),
    "",
  ].join("\n");
}

function unitsOf(prDir: string): VoterUnit[] {
  const file = join(prDir, "units.json");
  if (!existsSync(file)) return [];
  return ((JSON.parse(readFileSync(file, "utf8")) as { units?: VoterUnit[] }).units ?? []).map((u) => ({ id: u.id, ...(u.splitOf ? { splitOf: u.splitOf } : {}) }));
}

function selectSites(instanceId: string, prDir: string, set: HypothesisSet) {
  const units = unitsOf(prDir);
  if (voters === "unit" && !units.length) console.warn(`  ! no units.json under ${prDir}: each unitId is its own voter`);
  const plan = clusterSites(set, {
    window: siteWindow,
    voters: voters as "unit" | "row",
    units,
    maxSpan,
    ...(skipTests ? { skipPath: isTestPath } : {}),
  });
  const top = plan.sites.slice(0, topSites);
  if (!siteFilter) return { plan, top };
  const ranks = siteFilter.get(instanceId) ?? new Set<number>();
  return { plan, top: top.filter((_, i) => ranks.has(i + 1)) };
}

/** A summary call's result as the report carries it (a fallback site keeps no concerns). */
function summaryReport(r: SiteSummaryResult): SiteReviewSummary {
  return {
    model: summaryModel,
    concerns: r.summary?.concerns ?? [],
    uncovered: r.summary?.uncovered ?? [],
    maxConcerns: r.maxConcerns,
    fallback: r.fallback,
    attempts: r.attempts,
    cached: r.cached,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: r.costUsd,
    errors: r.errors,
  };
}

/** Where each gold-mapped row of a site landed in its summary: `C<n>` (concern n, `*` = its specific row), `unmerged`, `fallback`. */
function goldPlacement(s: SiteReviewSite): string[] {
  const sum = s.summary;
  if (!sum) return [];
  return s.gold.map((id) => {
    const c = sum.concerns.findIndex((x) => x.rows.includes(id));
    if (c < 0) return `${id}→fallback`;
    const x = sum.concerns[c];
    return `${id}→${x.unmerged ? "unmerged" : `C${c + 1}${x.specific === id ? "*" : ""}`}`;
  });
}

/** Haiku 4.5 list price per million tokens — only for the deadline estimate below. */
const HAIKU_RATE = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };

/**
 * A session killed by the deadline never writes its `result` envelope, so
 * agentic-pi's stats (cost, turns, tokens) are lost and the loop reports 0 —
 * a free run that was not free. Re-derive them from the per-message `usage`
 * the transcript already holds. Cost is priced only for Haiku (`null` otherwise).
 */
function usageFromTranscript(file: string): { turns: number; outputTokens: number; costUsd: number | null } | null {
  if (!existsSync(file)) return null;
  let turns = 0;
  let out = 0;
  let cost = 0;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"assistant"')) continue;
    try {
      const m = JSON.parse(line) as { type?: string; message?: { usage?: Record<string, number> } };
      if (m.type !== "assistant") continue;
      turns++;
      const u = m.message?.usage ?? {};
      out += u.output_tokens ?? 0;
      cost += ((u.input_tokens ?? 0) * HAIKU_RATE.input + (u.output_tokens ?? 0) * HAIKU_RATE.output + (u.cache_read_input_tokens ?? 0) * HAIKU_RATE.cacheRead + (u.cache_creation_input_tokens ?? 0) * HAIKU_RATE.cacheWrite) / 1_000_000;
    } catch {
      /* torn line */
    }
  }
  return { turns, outputTokens: out, costUsd: /haiku/i.test(model) ? cost : null };
}

/** One investigator gate loop over one scratch copy. Round ≥ 2 carries the previous round's gaps. */
async function investigate(opts: { scratch: string; checkout: string; prDir: string; prompt: string; sessionDir: string; siteId: string; leadCount: number; siteRows: number }) {
  const stopFollow = followSession(join(opts.scratch, "agent-sessions"), opts.sessionDir);
  const gapsByRound: Record<string, number>[] = [];
  let lastGaps: SiteGap[] = [];
  let gateNotes: string[] = [];
  const gate = () => {
    const check = checkSiteFindings({ prDir: opts.prDir, repo: opts.checkout, siteId: opts.siteId, leadCount: opts.leadCount, siteRows: opts.siteRows, requireImportance: true });
    const kinds: Record<string, number> = {};
    for (const g of check.gaps) kinds[g.kind] = (kinds[g.kind] ?? 0) + 1;
    gapsByRound.push(kinds);
    lastGaps = check.gaps;
    gateNotes = check.gaps.slice(0, 6).map((g) => `${g.kind}: ${g.detail}`.slice(0, 200));
    return check.satisfied;
  };
  try {
    const loop = await runGateLoop({
      sessionsDir: join(opts.scratch, "agent-sessions"),
      phase: "site_review",
      deadlineMs,
      model,
      thinking,
      prompt: opts.prompt,
      promptForRound: (round) => (round === 1 ? opts.prompt : `${opts.prompt}\n${renderGateFeedback(lastGaps, siteFindingsRel(opts.siteId))}`),
      cwd: opts.checkout,
      skillDirs: [],
      commandPolicy: COMMAND_POLICY,
      gateTimeoutSeconds: GATE_TIMEOUT_SECONDS,
      rounds,
      gate,
    });
    const final = checkSiteFindings({ prDir: opts.prDir, repo: opts.checkout, siteId: opts.siteId, leadCount: opts.leadCount, siteRows: opts.siteRows, requireImportance: true });
    return { ...loop, gapsByRound, gateNotes, final };
  } finally {
    stopFollow();
  }
}

/** The loop's stats, or — after a deadline, which loses them — the transcript's estimate. */
function siteStats(loop: { ok: boolean; error: string | null; costUsd: number; turns: number; outputTokens: number }, sessionDir: string) {
  if (loop.ok || !loop.error?.startsWith("deadline")) return { costUsd: loop.costUsd, turns: loop.turns, outputTokens: loop.outputTokens, estimated: false };
  const est = usageFromTranscript(join(sessionDir, "full.jsonl"));
  if (!est) return { costUsd: loop.costUsd, turns: loop.turns, outputTokens: loop.outputTokens, estimated: false };
  return { costUsd: loop.costUsd + (est.costUsd ?? 0), turns: Math.max(loop.turns, est.turns), outputTokens: Math.max(loop.outputTokens, est.outputTokens), estimated: true };
}

/** Judge every finding against the case gold: 3 votes, majority per gold. */
async function judgeFindings(gold: GoldComment[], findings: SiteFinding[]): Promise<{ goldForFinding: (number | null)[]; goldStated: number[]; error: string | null }> {
  if (!gold.length || !findings.length) return { goldForFinding: findings.map(() => null), goldStated: [], error: null };
  const judgeFs = findingsAsJudgeFindings(findings);
  const passes = await Promise.all(Array.from({ length: goldVotes }, () => gradeInternalRecall({ gold, findings: judgeFs, judgeModel: judgeModel! })));
  const ok = passes.filter((g) => g && !g.error);
  if (!ok.length) return { goldForFinding: findings.map(() => null), goldStated: [], error: passes.find((g) => g?.error)?.error ?? "judge failed" };
  const { rowForGold } = microGoldVote(
    ok.map((g) => g!.goldToFinding),
    gold.length,
  );
  const goldForFinding: (number | null)[] = findings.map(() => null);
  const goldStated: number[] = [];
  rowForGold.forEach((fi, gi) => {
    if (fi === null) return;
    goldStated.push(gi);
    goldForFinding[fi] = gi;
  });
  return { goldForFinding, goldStated, error: null };
}

async function runCase(fx: Fixture, repeat: number): Promise<PhaseReplayCase> {
  const inst = instances.get(fx.instanceId);
  const gold = inst?.review_gold ?? [];
  const goldRows = await goldRowMap({ prDir: fx.prDir, gold, judgeModel, votes: goldVotes, cacheDir: goldCache });
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
    const set = readHypothesisSet(fx.prDir);
    base.rows = set.records.length;
    const { plan, top } = selectSites(fx.instanceId, fx.prDir, set);
    const goldIds = new Set((goldRows ?? []).filter((id): id is string => id !== null));
    // Arm C: one summary call per site before anything else — the concern
    // count is the brief's lead count and the gate's lead-number bound.
    const summaries = withSummary
      ? await mapPool(top, siteConcurrency, (s) => summariseSite({ model: summaryModel, prompt: summaryPrompt, site: s, rows: siteSummaryRows(s, set), cacheDir: summaryCache }))
      : top.map(() => null);
    const briefs = top.map((s, i) => siteBriefFor(leadsMode === "summary" && !withSummary ? "subjects" : leadsMode, s, set, summaries[i]?.summary ?? null));
    const leadCounts = briefs.map((b) => b.leadCount);
    const shells: SiteReviewSite[] = top.map((s: Site, i) => ({
      id: s.id,
      path: s.path,
      startLine: s.startLine,
      endLine: s.endLine,
      rows: s.rows.length,
      voters: s.voters,
      leads: leadCounts[i],
      gold: s.rows.filter((id) => goldIds.has(id)),
      ...(summaries[i] ? { summary: summaryReport(summaries[i]!) } : {}),
      ok: true,
      error: null,
      wallMs: null,
      costUsd: null,
      turns: null,
      outputTokens: null,
      gateSatisfied: null,
      findings: null,
      none: null,
      session: null,
    }));
    const outcome: SiteReviewOutcome = {
      sitesFormed: plan.sites.length,
      skippedRows: plan.skipped.length,
      sites: shells,
      goldInSites: shells.flatMap((s) => s.gold),
      findings: [],
      goldStated: null,
      matchedFindings: null,
    };
    const summaryCost = summaries.reduce((a, x) => a + (x?.costUsd ?? 0), 0);
    if (summariesOnly) {
      for (const shell of shells) if (shell.summary) shell.costUsd = shell.summary.costUsd;
      return { ...base, costUsd: summaryCost, outputTokens: summaries.reduce((a, x) => a + (x?.outputTokens ?? 0), 0), siteReview: outcome };
    }
    if (audit || top.length === 0) return { ...base, siteReview: outcome };

    const sessionRoot = join(outDir, "sessions", reportStem, caseKey);
    const sessionUrlRoot = `/data/${PHASE_REPLAY_DIR}/sessions/${reportStem}/${caseKey}`;
    const started = Date.now();
    const perSite = await mapPool(top, siteConcurrency, async (site, i) => {
      const shell = shells[i];
      const copy = scratchCopy(fx);
      try {
        mkdirSync(join(copy.prDir, "sites", site.id), { recursive: true });
        // The pipeline's brief shape: the site, then the assignment (site id,
        // output file, `none` bar) — the prompt is slot-generic, so the brief
        // carries what differs per site. Attached to the prompt the way the
        // `site-review` fan-out's `context_file` attaches it, and kept on disk.
        const brief = `${briefs[i].brief}\n${renderSiteAssignment(site.id, noneChecksRequired(site.rows.length))}`;
        writeFileSync(join(copy.checkout, siteBriefRel(site.id)), brief);
        const { text: rendered, unrendered } = renderPhasePrompt(promptPath, promptContext(inst));
        if (unrendered) console.warn(`! ${fx.instanceId} ${site.id}: unrendered {{marker}} left in the site prompt`);
        const prompt = `${rendered.trimEnd()}\n\n${attachBrief(siteBriefRel(site.id), brief)}`;
        shell.session = `${sessionUrlRoot}/${site.id}/full.jsonl`;
        report.inFlight!.push({ instanceId: fx.instanceId, arm: fx.arm, repeat, site: site.id, startedAt: new Date().toISOString(), session: shell.session });
        writer.write();
        const loop = await investigate({ ...copy, prompt, sessionDir: join(sessionRoot, site.id), siteId: site.id, leadCount: leadCounts[i], siteRows: site.rows.length });
        const stats = siteStats(loop, join(sessionRoot, site.id));
        Object.assign(loop, { costUsd: stats.costUsd, turns: stats.turns, outputTokens: stats.outputTokens });
        Object.assign(shell, {
          ok: loop.ok,
          error: stats.estimated ? `${loop.error} (cost/turns estimated from the transcript)` : loop.error,
          wallMs: loop.wallMs,
          // Arm C's summary call is part of what the site cost.
          costUsd: loop.costUsd + (shell.summary?.costUsd ?? 0),
          turns: loop.turns,
          outputTokens: loop.outputTokens,
          gateSatisfied: loop.gateSatisfied,
          gapsByRound: loop.gapsByRound,
          gateNotes: loop.gateNotes,
          findings: loop.final.findings.length,
          none: loop.final.none,
        });
        // Keep the investigator's own output beside the transcript.
        const src = join(copy.prDir, "sites", `${site.id}.findings.jsonl`);
        if (existsSync(src)) {
          mkdirSync(join(sessionRoot, site.id), { recursive: true });
          writeFileSync(join(sessionRoot, site.id, "findings.jsonl"), readFileSync(src));
        }
        return { findings: loop.final.findings, loop };
      } catch (err) {
        Object.assign(shell, { ok: false, error: (err as Error).message.slice(0, 400) });
        return { findings: [] as SiteFinding[], loop: null };
      } finally {
        report.inFlight = (report.inFlight ?? []).filter((f) => !(f.instanceId === fx.instanceId && f.arm === fx.arm && f.repeat === repeat && f.site === site.id));
        if (keep) console.log(`  kept ${copy.scratch}`);
        removeScratch(copy.scratch, keep);
        writer.write();
      }
    });

    let cost = summaryCost;
    let turns = 0;
    let outTokens = 0;
    let iterations = 0;
    const findings: SiteFinding[] = [];
    for (const { findings: f, loop } of perSite) {
      findings.push(...f);
      if (!loop) continue;
      cost += loop.costUsd;
      turns += loop.turns;
      outTokens += loop.outputTokens;
      iterations = Math.max(iterations, loop.iterations);
    }
    outcome.findings = findings.map<SiteReviewFinding>((f) => ({ site: f.site, path: f.path, line: f.line, title: f.title.slice(0, 200), strength: f.strength, leads: f.leads }));
    if (judgeModel && gold.length) {
      const judged = await judgeFindings(gold, findings);
      if (judged.error) outcome.judgeError = judged.error;
      else {
        outcome.goldStated = judged.goldStated;
        outcome.matchedFindings = judged.goldForFinding.filter((g) => g !== null).length;
        outcome.findings.forEach((f, i) => (f.gold = judged.goldForFinding[i]));
      }
    } else if (judgeModel && !gold.length) {
      outcome.goldStated = [];
      outcome.matchedFindings = 0;
    }
    const failed = shells.filter((x) => !x.ok);
    return {
      ...base,
      ok: failed.length === 0,
      error: failed.length ? `${failed.length} site(s) failed: ${failed.map((x) => `${x.id} ${x.error}`).join("; ").slice(0, 380)}` : null,
      wallMs: Date.now() - started,
      costUsd: cost,
      turns,
      outputTokens: outTokens,
      iterations,
      siteReview: outcome,
    };
  } catch (err) {
    return { ...base, ok: false, error: (err as Error).message.slice(0, 400) };
  }
}

try {
  await mapPool(plannedWork, concurrency, async ({ fx, repeat }) => {
    const c = await runCase(fx, repeat);
    report.cases.push(c);
    writer.write();
    const r = c.siteReview;
    const mapped = c.goldRows ? new Set(c.goldRows.filter((x) => x !== null)).size : null;
    console.log(
      `${fx.arm}/${fx.instanceId} r${repeat}  rows ${c.rows}  sites ${r?.sites.length ?? "?"}/${r?.sitesFormed ?? "?"}` +
        `  rows-in-sites ${r ? r.sites.reduce((a, s) => a + s.rows, 0) : "?"}  skipped ${r?.skippedRows ?? "?"}` +
        `  leads ${r ? r.sites.reduce((a, s) => a + s.leads, 0) : "?"}` +
        `  gold-in-sites ${c.goldRows === null ? "n/a" : `${r?.goldInSites.length ?? "?"}/${mapped} mapped (${c.gold.length} gold)`}` +
        (audit || summariesOnly
          ? summariesOnly
            ? `  summaries $${(c.costUsd ?? 0).toFixed(3)}`
            : ""
          : `  findings ${r?.findings.length ?? "?"}  gold-stated ${r?.goldStated === null || !r ? "n/a" : r.goldStated.length}  ${c.wallMs !== null ? `${Math.round(c.wallMs / 1000)}s` : ""}  $${(c.costUsd ?? 0).toFixed(2)}`) +
        (c.ok ? "" : `  ERROR ${c.error}`),
    );
    if (r)
      for (const s of r.sites) {
        const sum = s.summary;
        console.log(
          `    ${s.id} ${s.path ?? "unanchored"}:${s.startLine}–${s.endLine}  rows ${s.rows}  voters ${s.voters}  leads ${s.leads}${s.gold.length ? `  GOLD ${sum ? goldPlacement(s).join(",") : s.gold.join(",")}` : ""}` +
            (sum ? `  concerns ${sum.concerns.length}/${sum.maxConcerns}${sum.uncovered.length ? ` (uncovered ${sum.uncovered.length})` : ""}${sum.fallback ? " FALLBACK" : ""}${sum.cached ? " cached" : ""}` : "") +
            (audit || summariesOnly ? "" : `  findings ${s.findings ?? "?"}${s.none ? " (none)" : ""}  gate ${s.gateSatisfied ? "ok" : "UNSAT"} r${s.gapsByRound?.length ?? 0}  $${(s.costUsd ?? 0).toFixed(2)}  ${s.turns ?? "?"}t`),
        );
        if (sum && summariesOnly) {
          sum.concerns.forEach((x, i) => console.log(`      C${i + 1}${x.line !== null ? ` L${x.line}` : ""} [${x.rows.map((id) => (id === x.specific ? `${id}*` : id)).join(", ")}] ${x.concern}`));
          if (sum.errors.length) console.log(`      rejected: ${sum.errors.join(" | ")}`);
        }
      }
  });
  writer.finish();
} catch (err) {
  writer.finish((err as Error).message);
  throw err;
}
const mappedTotal = report.cases.reduce((a, c) => a + (c.goldRows ? new Set(c.goldRows.filter((x) => x !== null)).size : 0), 0);
const inSites = report.cases.reduce((a, c) => a + (c.siteReview?.goldInSites.length ?? 0), 0);
const goldTotal = report.cases.reduce((a, c) => a + c.gold.length, 0);
console.log(`pooled: ${inSites} of ${mappedTotal} gold-mapped rows inside the selected sites (${goldTotal} gold)`);
if (withSummary) {
  const sites = report.cases.flatMap((c) => c.siteReview?.sites ?? []);
  const sums = sites.map((x) => x.summary).filter((x): x is SiteReviewSummary => !!x);
  const placed = sites.flatMap(goldPlacement);
  const cost = sums.every((x) => x.costUsd !== null) ? `$${sums.reduce((a, x) => a + x.costUsd!, 0).toFixed(3)}` : "unpriced";
  console.log(
    `summaries: ${sums.length} sites · ${sums.reduce((a, x) => a + x.concerns.length, 0)} concerns` +
      ` (${sums.reduce((a, x) => a + x.uncovered.length, 0)} rows uncovered) · ${sums.filter((x) => x.fallback).length} fallback · ${sums.filter((x) => x.cached).length} cached · ${cost}` +
      ` · gold rows: ${placed.filter((p) => /→C\d/.test(p)).length} in a concern (${placed.filter((p) => /→C\d+\*/.test(p)).length} as its specific row), ${placed.filter((p) => !/→C\d/.test(p)).length} not`,
  );
}
console.log(`done → ${writer.file}`);
// A session abandoned at its deadline still holds a pending provider call
// (agentic-pi's run() takes no abort signal), which keeps the process alive
// forever after the report is final. Nothing is left to write.
process.exit(0);
