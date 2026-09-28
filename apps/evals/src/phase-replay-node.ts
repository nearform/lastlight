/**
 * The Node half of a phase replay (`scripts/micro-falsify.ts`,
 * `scripts/micro-adjudicate.ts`): fixtures, gold, the gold→hypothesis map, the
 * agent run, and the live report writer. The report SHAPE and every derived
 * number live in the node-free `phase-replay.ts`.
 *
 * Fidelity rules, inherited from `micro-survey.ts` (each learned by getting it
 * wrong there):
 *
 *  - Copy the TASK dir, not the checkout: the composed `AGENTS.md` is a sibling
 *    of the repo, and Pi loads the first one walking UP from cwd.
 *  - Stage skills FRESH from core (or an override), never the fixture's frozen
 *    bundle — iterating on them is the point.
 *  - `noSkills: true` — what core does on every backend.
 *  - Pass `gateTimeoutSeconds`: agentic-pi arms its bash reaper only when set.
 *
 * And one of its own: the loop. Core's `generic_loop` re-renders the SAME
 * prompt every iteration (neither phase's prompt reads `{{previousOutput}}`)
 * and stops as soon as the `until_bash` gate passes, so {@link runGateLoop}
 * does exactly that — same prompt, gate between rounds, no feedback injected.
 * (`promptForRound` is the one opt-out, used only by `micro-site-review`, an
 * experiment that is not a core phase.)
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { AgenticShim } from "lastlight-core/evals";
import { readHypothesisSet } from "lastlight-code-facts";
import { renderTemplate } from "lastlight-workflow-engine";

import { gradeInternalRecall } from "./grade.js";
import { readSessionLog } from "./metrics.js";
import { microGoldVote } from "./micro-survey.js";
import { rowsAsJudgeFindings, type SurveyRow } from "./micro-survey-node.js";
import type { PhaseReplayGold, PhaseReplayReport } from "./phase-replay.js";
import type { GoldComment } from "./schema.js";

// ── core paths ──────────────────────────────────────────────────────────────

export const coreRoot = resolve(process.env.LASTLIGHT_CORE_DIR ?? resolve(import.meta.dirname, "../../server"));
export const serverRoot = existsSync(join(coreRoot, "workflows")) ? coreRoot : join(coreRoot, "apps/server");

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

// ── fixtures ────────────────────────────────────────────────────────────────

export interface Fixture {
  /** The case dir (`…/<arm>/<instance_id>`). */
  dir: string;
  instanceId: string;
  arm: string;
  /** `<dir>/sandboxes/<task>` — copied whole, so `AGENTS.md` comes with it. */
  taskDir: string;
  repoDirName: string;
  checkout: string;
  /** `<checkout>/.lastlight/pr-review`. */
  prDir: string;
}

function asFixture(dir: string): Fixture | null {
  const sandboxes = join(dir, "sandboxes");
  if (!existsSync(sandboxes)) return null;
  const task = readdirSync(sandboxes).find((e) => statSync(join(sandboxes, e)).isDirectory());
  if (!task) return null;
  const taskDir = join(sandboxes, task);
  const repo = readdirSync(taskDir).find((e) => existsSync(join(taskDir, e, ".git")));
  if (!repo) return null;
  const checkout = join(taskDir, repo);
  const prDir = join(checkout, ".lastlight", "pr-review");
  if (!existsSync(prDir)) return null;
  return { dir, instanceId: basename(dir), arm: basename(dirname(dir)), taskDir, repoDirName: repo, checkout, prDir };
}

/**
 * Each argument is a fixture (a dir holding `sandboxes/`) or a directory of
 * them (`…/2026-09-27-units-v7-haiku/arm1`). An argument that is neither is an
 * error — a typo'd path must not quietly shrink the case set.
 */
export function resolveFixtures(paths: string[], only?: Set<string>): Fixture[] {
  const out: Fixture[] = [];
  for (const p of paths.map((x) => resolve(x))) {
    const direct = asFixture(p);
    if (direct) {
      out.push(direct);
      continue;
    }
    if (!existsSync(p)) throw new Error(`no such fixture path: ${p}`);
    const kids = readdirSync(p)
      .sort()
      .map((e) => asFixture(join(p, e)))
      .filter((f): f is Fixture => f !== null);
    if (!kids.length) throw new Error(`${p} is not a fixture and holds none (expected <case>/sandboxes/<task>/<repo>/.lastlight/pr-review)`);
    out.push(...kids);
  }
  return only ? out.filter((f) => only.has(f.instanceId)) : out;
}

/**
 * A scratch COPY of the task dir: the phase writes into `.lastlight/pr-review/`
 * and the fixture must stay pristine for the next repeat.
 */
export function scratchCopy(fx: Fixture): { scratch: string; checkout: string; prDir: string } {
  const scratch = mkdtempSync(join(tmpdir(), `phase-replay-${fx.instanceId}-`));
  const ws = join(scratch, "ws");
  cpSync(fx.taskDir, ws, { recursive: true });
  const checkout = join(ws, fx.repoDirName);
  return { scratch, checkout, prDir: join(checkout, ".lastlight", "pr-review") };
}

// ── instances + gold ────────────────────────────────────────────────────────

export interface Instance {
  instance_id: string;
  repo?: string;
  pr?: Record<string, unknown>;
  review_gold?: GoldComment[];
  review_gold_neutral?: GoldComment[];
}

export function loadInstances(path: string | undefined): Map<string, Instance> {
  if (!path) return new Map();
  const list = JSON.parse(readFileSync(path, "utf8")) as Instance[];
  return new Map(list.map((i) => [i.instance_id, i]));
}

export function goldRefs(gold: GoldComment[]): PhaseReplayGold[] {
  return gold.map((g) => ({
    ...(g.file ? { file: g.file } : {}),
    ...(typeof g.line === "number" ? { line: g.line } : {}),
    severity: g.severity,
    summary: g.description.replace(/\*\*[^*]*\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 160),
  }));
}

/** The PR fields both prompts render. */
export function promptContext(inst: Instance | undefined): Record<string, unknown> {
  const pr = (inst?.pr ?? {}) as Record<string, string | number>;
  const [owner, repo] = (inst?.repo ?? "owner/repo").split("/");
  return {
    owner,
    repo,
    prNumber: pr.number ?? 0,
    headSha: pr.head_commit ?? "HEAD",
    baseBranch: pr.base_ref ?? "main",
    prTitle: pr.title ?? "",
  };
}

export function renderPhasePrompt(path: string, ctx: Record<string, unknown>): { text: string; unrendered: boolean } {
  const text = renderTemplate(readFileSync(path, "utf8"), ctx as never);
  return { text, unrendered: /\{\{|\}\}/.test(text) };
}

/**
 * Which hypothesis each gold was matched to, by the internal-recall judge,
 * majority over `votes` passes. Judged ONCE per (hypotheses bytes, gold, judge,
 * votes) and cached on disk, so every arm replayed over a fixture reads the
 * same map and its noise never shows up as a difference between arms.
 * `null` when there is no gold, no judge, or the judge failed every pass.
 */
export async function goldRowMap(opts: {
  prDir: string;
  gold: GoldComment[];
  judgeModel: string | null;
  votes: number;
  cacheDir: string;
}): Promise<(string | null)[] | null> {
  const { prDir, gold, judgeModel, votes, cacheDir } = opts;
  if (!gold.length || !judgeModel) return null;
  const set = readHypothesisSet(prDir);
  if (!set.records.length) return gold.map(() => null);
  const hypDir = join(prDir, "hypotheses");
  const bytes = readdirSync(hypDir)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => `${f}\n${readFileSync(join(hypDir, f), "utf8")}`)
    .join("\n");
  const key = sha256(JSON.stringify({ v: 1, bytes, gold, judgeModel, votes })).slice(0, 24);
  const file = join(cacheDir, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as (string | null)[];

  const findings = rowsAsJudgeFindings(set.records.map((r) => r.row as SurveyRow));
  const passes = await Promise.all(
    Array.from({ length: votes }, () => gradeInternalRecall({ gold, findings, judgeModel })),
  );
  const ok = passes.filter((g) => g && !g.error);
  if (!ok.length) return null;
  const { rowForGold } = microGoldVote(
    ok.map((g) => g!.goldToFinding),
    gold.length,
  );
  const map = rowForGold.map((i) => (i === null ? null : (set.records[i]?.id ?? null)));
  mkdirSync(cacheDir, { recursive: true });
  try {
    writeFileSync(file, JSON.stringify(map), { flag: "wx" });
  } catch {
    // another run wrote first — its answer is the shared one
  }
  return JSON.parse(readFileSync(file, "utf8")) as (string | null)[];
}

// ── the agent ───────────────────────────────────────────────────────────────

export interface AgentOutcome {
  ok: boolean;
  error: string | null;
  wallMs: number;
  costUsd: number;
  turns: number;
  outputTokens: number;
}

type AgenticRun = (o: Record<string, unknown>) => Promise<{
  ok?: boolean;
  error?: string;
  stats?: { assistantMessages?: number; cost?: number; tokens?: { output?: number } };
}>;
let runFn: AgenticRun | null = null;

/** One agent session, exactly as core's in-process executor runs a phase. */
export async function runPhaseAgent(opts: {
  model: string;
  thinking: string | null;
  prompt: string;
  cwd: string;
  skillDirs: string[];
  commandPolicy?: Record<string, unknown>;
  gateTimeoutSeconds: number;
  /** Where core's event shim writes this session (`<scratch>/agent-sessions`). */
  sessionsDir: string;
  /** The phase label stamped on the session, as core stamps it. */
  phase: string;
}): Promise<AgentOutcome> {
  runFn ??= ((await import("agentic-pi")) as unknown as { run: AgenticRun }).run;
  // No phase deadline: agentic-pi's in-process `run()` takes no abort signal,
  // and core's in-process backends (`none`, which evals use) cannot stop an
  // agent phase either — `timeout_seconds` bounds commands there, not agents.
  // So the replay records the wall clock rather than pretending to enforce one.
  const started = Date.now();
  // Core's own shim, fed exactly as the orchestrator feeds it — so the session
  // on disk is the stream-json envelope a real run writes, and the dashboard's
  // live viewer follows it unchanged.
  const shim = new AgenticShim({
    homeDir: opts.sessionsDir,
    projectSlug: "-phase-replay",
    model: opts.model,
    initialPrompt: opts.prompt,
    phase: opts.phase,
  });
  try {
    const r = await runFn({
      onEvent: (record: unknown) => shim.feed(record as Parameters<AgenticShim["feed"]>[0]),
      model: opts.model,
      prompt: opts.prompt,
      cwd: opts.cwd,
      ...(opts.skillDirs.length ? { skillPaths: opts.skillDirs } : {}),
      noSkills: true,
      sandbox: "none",
      gateTimeoutSeconds: opts.gateTimeoutSeconds,
      ...(opts.thinking ? { thinking: opts.thinking } : {}),
      ...(opts.commandPolicy ? { commandPolicy: opts.commandPolicy } : {}),
    });
    return {
      ok: r.ok !== false,
      error: r.error ?? null,
      wallMs: Date.now() - started,
      costUsd: r.stats?.cost ?? 0,
      turns: r.stats?.assistantMessages ?? 0,
      outputTokens: r.stats?.tokens?.output ?? 0,
    };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 300), wallMs: Date.now() - started, costUsd: 0, turns: 0, outputTokens: 0 };
  } finally {
    await shim.flush().catch(() => {});
  }
}

/**
 * `generic_loop`, replayed: run, gate, and again only while the gate fails and
 * rounds remain. The prompt is identical every round, as in core. Costs, turns
 * and tokens are summed across rounds; wall clock is the whole loop's.
 */
export async function runGateLoop(
  opts: Parameters<typeof runPhaseAgent>[0] & {
    rounds: number;
    gate: () => boolean;
    deadlineMs: number;
    /**
     * The prompt for round `n` (1-based) — a DEPARTURE from core, used only by
     * `micro-site-review`, which appends the previous round's gate gaps. Unset
     * (falsify, adjudicate) = `prompt` every round, exactly as core.
     */
    promptForRound?: (round: number) => string;
  },
): Promise<AgentOutcome & { iterations: number; gateSatisfied: boolean }> {
  const started = Date.now();
  // A per-case DEADLINE, because nothing else bounds an in-process agent:
  // agentic-pi's `run()` takes no abort signal, and on 2026-09-27 six Sonnet
  // adjudications sat 40 minutes on stalled API calls with the report still
  // reading "running". Past it the case is recorded as timed out and the
  // replay moves on; the orphaned session ends when the process exits.
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<"deadline">((res) => {
    timer = setTimeout(() => res("deadline"), opts.deadlineMs);
    timer.unref?.();
  });
  const total: AgentOutcome = { ok: true, error: null, wallMs: 0, costUsd: 0, turns: 0, outputTokens: 0 };
  let iterations = 0;
  let satisfied = false;
  while (iterations < Math.max(1, opts.rounds)) {
    iterations++;
    const prompt = opts.promptForRound ? opts.promptForRound(iterations) : opts.prompt;
    const raced = await Promise.race([runPhaseAgent({ ...opts, prompt, phase: `${opts.phase}_${iterations}` }), deadline]);
    if (raced === "deadline") {
      total.ok = false;
      total.error = `deadline — no result after ${Math.round(opts.deadlineMs / 60000)} min (round ${iterations})`;
      satisfied = opts.gate();
      break;
    }
    const r = raced;
    total.costUsd += r.costUsd;
    total.turns += r.turns;
    total.outputTokens += r.outputTokens;
    if (!r.ok) {
      total.ok = false;
      total.error = r.error;
    }
    satisfied = opts.gate();
    if (satisfied || !r.ok) break;
  }
  clearTimeout(timer);
  return { ...total, wallMs: Date.now() - started, iterations, gateSatisfied: satisfied };
}

/**
 * Follow a case's session live, the way `run-instance.ts` does for a run: the
 * consolidated transcript (`readSessionLog`, the same reader) is flushed
 * ATOMICALLY to `<dir>/full.jsonl` every 1.5 s while the case runs and once at
 * the end. Returns a stop function that does the final flush.
 */
export function followSession(sessionsDir: string, dir: string): () => void {
  const file = join(dir, "full.jsonl");
  const flush = () => {
    try {
      const log = readSessionLog(sessionsDir);
      if (!log) return;
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${file}.tmp`, log);
      renameSync(`${file}.tmp`, file);
    } catch {
      /* best-effort — a flush failure must never affect the case */
    }
  };
  const t = setInterval(flush, 1500);
  t.unref?.();
  return () => {
    clearInterval(t);
    flush();
  };
}

// ── the live report ─────────────────────────────────────────────────────────

/**
 * Written at start, after every case, and by an unref'd 15 s heartbeat —
 * ATOMICALLY (temp + rename), so a polling dashboard never reads a torn file.
 */
export class PhaseReportWriter {
  readonly file: string;
  private timer: NodeJS.Timeout;
  constructor(
    readonly report: PhaseReplayReport,
    outDir: string,
  ) {
    mkdirSync(outDir, { recursive: true });
    this.file = join(outDir, `${report.startedAt.replace(/[:.]/g, "-")}-${report.kind}-${report.label}.json`);
    this.write();
    this.timer = setInterval(() => this.write(), 15_000);
    this.timer.unref?.();
  }
  write(): void {
    this.report.heartbeat = new Date().toISOString();
    const tmp = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(this.report, null, 2)}\n`);
    renameSync(tmp, this.file);
  }
  finish(error?: string): void {
    clearInterval(this.timer);
    this.report.status = error ? "failed" : "done";
    this.report.error = error ?? null;
    this.report.finishedAt = new Date().toISOString();
    this.write();
  }
}

export function removeScratch(scratch: string, keep: boolean): void {
  if (!keep) rmSync(scratch, { recursive: true, force: true });
}
