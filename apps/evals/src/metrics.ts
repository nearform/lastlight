/**
 * Pull per-run token/cost/turn metrics out of the session jsonl the event
 * shim writes (`src/engine/event-shim.ts`). Each phase emits one `result`
 * envelope carrying `total_cost_usd` / `total_input_tokens` /
 * `total_output_tokens` (plus `total_cache_read_input_tokens` /
 * `total_cache_creation_input_tokens`, which we sum into `cachedTokens` —
 * Anthropic bills most of its prompt as cached, so omitting it made input
 * collapse to ~zero). We sum them across every jsonl under the run's sessions
 * dir. Best-effort: missing files / lines just contribute zero.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { ModelRate } from "./env.js";

export interface RunMetrics {
  inputTokens: number;
  /** Cached prompt tokens (Anthropic cache read + creation). Reported as its
   * own total so providers that bill cached input separately (and far cheaper)
   * are comparable — folding it into `inputTokens` would hide the split and,
   * for OpenAI-style usage where cached is a subset of input, double-count. */
  cachedTokens: number;
  outputTokens: number;
  costUsd: number;
  /**
   * Summed `duration_ms` across the `result` envelopes — the agent + gate time
   * the transcript itself reports, as distinct from a phase's wall-clock window.
   *
   * It exists because it is the ONE latency number that is already on disk for
   * every historical run, so `scripts/rescore.ts` can back-fill a per-phase
   * breakdown with no re-run and no spend. A live run records both; the gap
   * between them is per-phase overhead (provisioning, skill staging).
   */
  agentMs: number;
}

/**
 * The in-process executor flushes its FINAL session envelope (the `result`
 * line that carries cost/tokens) fire-and-forget (`void shim.flush()`), so it
 * can land just after `runWorkflow` resolves. Wait for the jsonl tree to stop
 * growing before reading metrics, so we don't miss it (and don't delete the
 * workspace out from under the pending write).
 */
export async function drainSessions(sessionsDir: string, maxMs = 4000, quietMs = 250): Promise<void> {
  const sizeOf = (): number => {
    const files: string[] = [];
    walkJsonl(join(sessionsDir, "projects"), files);
    return files.reduce((sum, f) => {
      try {
        return sum + statSync(f).size;
      } catch {
        return sum;
      }
    }, 0);
  };
  const deadline = Date.now() + maxMs;
  let last = -1;
  let stableSince = Date.now();
  while (Date.now() < deadline) {
    const cur = sizeOf();
    if (cur > 0 && cur === last) {
      if (Date.now() - stableSince >= quietMs) return;
    } else {
      last = cur;
      stableSince = Date.now();
    }
    await new Promise((r) => setTimeout(r, 80));
  }
}

/** One session jsonl file the shim wrote (`projects/<slug>/<sessionId>.jsonl`),
 * with what we need to attribute it to a workflow phase. */
export interface SessionFileInfo {
  file: string;
  /** ms epoch of the first line's `timestamp` (0 if none parseable). */
  firstTs: number;
  /**
   * The owning phase label, read off the `phase` field the event shim stamps on
   * a session's opening and closing envelopes (`src/engine/event-shim.ts`).
   *
   * AUTHORITATIVE when present, and absent only on sessions written before that
   * stamp existed — which is every run archived before 2026-08-22. See
   * {@link bucketSessionsByPhase} for why the stamp had to be added.
   */
  phase?: string;
}

/** One workflow phase's start time, as recorded by `onPhaseStart`. Phase labels
 * include loop iterations (`adjudicate_iter_1`), so these are the same keys
 * `WorkflowResult.phases[].phase` uses. */
export interface PhaseWindow {
  phase: string;
  start: number;
}

/** Session jsonl files grouped by the workflow phase that produced them. */
export interface SessionBuckets {
  /** Phase labels in the order their first session file appeared. */
  order: string[];
  /** phase label → its session jsonl paths, chronological. */
  buckets: Map<string, string[]>;
}

/**
 * Attribute each session jsonl to the workflow phase that produced it.
 *
 * TWO RULES, and the order matters:
 *
 *  1. **The stamp.** If the session carries a `phase` (written by the event shim
 *     onto its opening and closing envelopes), that is the answer. Exact, and
 *     immune to concurrency.
 *  2. **The window**, for a session with no stamp: the last phase started
 *     at/before the file's first line (50 ms of slack for the write).
 *
 * The window rule came first and is kept ONLY as the fallback for sessions
 * archived before the stamp existed, because it is a point lookup and therefore
 * **cannot express concurrency at all**. A `fanout` phase opens six windows
 * within 35 ms; under rule 2 all six sessions resolve to whichever branch
 * happened to open last, so on a measured run $1.23 of a $2.01 case attributed
 * to a single branch — or, where the bucket key was the parent `survey` and the
 * `PhaseMetric` rows were the branches, to no row at all. Widening the slack
 * cannot fix that: the branches are genuinely simultaneous.
 *
 * It also mis-files sequential phases whose session is written late.
 * `writeCommandSession` writes a command's session AFTER the command finishes,
 * so `facts`' session landed at roughly `seed`'s start and was billed to `seed`
 * — a model-free bash phase reporting agent time.
 *
 * Pure over its two inputs, so the per-phase cost roll-up and the archive split
 * read one implementation instead of two that can disagree.
 */
export function bucketSessionsByPhase(files: SessionFileInfo[], phaseStarts: PhaseWindow[]): SessionBuckets {
  const starts = [...phaseStarts].sort((a, b) => a.start - b.start);
  const buckets = new Map<string, string[]>();
  const order: string[] = [];
  for (const sf of files) {
    // Empty is absent: this is the shared authority, so it must not depend on
    // its caller having normalised the stamp.
    let phase = sf.phase || undefined;
    if (phase === undefined) {
      phase = starts[0]?.phase ?? "session";
      for (const ev of starts) {
        if (ev.start <= sf.firstTs + 50) phase = ev.phase;
        else break;
      }
    }
    if (!buckets.has(phase)) {
      buckets.set(phase, []);
      order.push(phase);
    }
    buckets.get(phase)!.push(sf.file);
  }
  return { order, buckets };
}

/** Enumerate the run's session jsonl files (one per sessionId / phase / fan-out
 * branch), each with its first-line timestamp and its stamped owning phase,
 * sorted chronologically. {@link bucketSessionsByPhase} maps these to phases. */
export function listSessionFiles(sessionsDir: string): SessionFileInfo[] {
  const files: string[] = [];
  walkJsonl(join(sessionsDir, "projects"), files);
  walkJsonl(sessionsDir, files);
  const seen = new Set<string>();
  const out: SessionFileInfo[] = [];
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    let firstTs = 0;
    let phase: string | undefined;
    try {
      // Scan for BOTH, and stop as soon as we have them. The shim stamps `phase`
      // on the opening envelope, so that is line 1 in practice — but a session
      // bootstrapped from a stub `session` record carries its stamp only on the
      // closing `result` line, and reading the whole file to find it costs
      // nothing here (we already hold it in memory).
      for (const line of readFileSync(file, "utf8").split("\n")) {
        const t = line.trim();
        if (!t) continue;
        try {
          const o = JSON.parse(t) as { timestamp?: string | number; phase?: unknown };
          if (firstTs === 0 && o.timestamp != null) {
            firstTs = typeof o.timestamp === "number" ? o.timestamp * 1000 : Date.parse(o.timestamp);
          }
          if (phase === undefined && typeof o.phase === "string" && o.phase) phase = o.phase;
          if (firstTs !== 0 && phase !== undefined) break;
        } catch {
          /* keep scanning */
        }
      }
    } catch {
      /* unreadable — leave firstTs 0 and the phase unstamped */
    }
    out.push({ file, firstTs, ...(phase !== undefined ? { phase } : {}) });
  }
  return out.sort((a, b) => a.firstTs - b.firstTs);
}

/** Concatenate the given jsonl files (already in order) into one raw jsonl
 * string. Best-effort: an unreadable file contributes nothing. */
export function concatJsonl(files: string[]): string {
  const chunks: string[] = [];
  for (const f of files) {
    try {
      const text = readFileSync(f, "utf8").trim();
      if (text) chunks.push(text);
    } catch {
      /* skip */
    }
  }
  return chunks.length ? chunks.join("\n") + "\n" : "";
}

/**
 * Concatenate every session jsonl under a run's sessions dir into one raw jsonl
 * string (stable phase order by path, de-duplicated), for archiving alongside
 * the run + later rendering in the dashboard. Each run uses a fresh temp
 * `stateDir`, so all jsonl under it belong to that one instance — no slug
 * matching needed (the same set `collectMetrics` reads). Best-effort: an
 * unreadable file just contributes nothing.
 */
export function readSessionLog(sessionsDir: string): string {
  const files: string[] = [];
  walkJsonl(join(sessionsDir, "projects"), files);
  walkJsonl(sessionsDir, files);
  const seen = new Set<string>();
  const chunks: string[] = [];
  for (const file of [...files].sort()) {
    if (seen.has(file)) continue;
    seen.add(file);
    try {
      const text = readFileSync(file, "utf8").trim();
      if (text) chunks.push(text);
    } catch {
      /* best-effort */
    }
  }
  return chunks.length ? chunks.join("\n") + "\n" : "";
}

function walkJsonl(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walkJsonl(full, out);
    else if (name.name.endsWith(".jsonl")) out.push(full);
  }
}

/**
 * Impute a USD cost for one `result` envelope from a per-million-token rate,
 * matching pi-ai's `calculateCost`: `input`/`output`/`cacheRead`/`cacheWrite`
 * are each `rate / 1e6 * tokens`. `total_input_tokens` is the *uncached* input
 * (the shim splits cache read/creation out — see the module comment), so it maps
 * to pi-ai's `input`. Cache-creation tokens are billed at the write rate.
 */
function imputeCost(
  env: {
    total_input_tokens?: number;
    total_cache_read_input_tokens?: number;
    total_cache_creation_input_tokens?: number;
    total_output_tokens?: number;
  },
  rate: ModelRate,
): number {
  const input = (env.total_input_tokens ?? 0) * rate.input;
  const output = (env.total_output_tokens ?? 0) * rate.output;
  const cacheRead = (env.total_cache_read_input_tokens ?? 0) * (rate.cacheRead ?? 0);
  const cacheWrite = (env.total_cache_creation_input_tokens ?? 0) * (rate.cacheWrite ?? 0);
  return (input + output + cacheRead + cacheWrite) / 1_000_000;
}

/**
 * @param fallbackRate When set, a `result` envelope that reports no cost
 *   (`total_cost_usd` absent or `0`) has one imputed from this per-million-token
 *   rate (see {@link imputeCost}). This is how flat-rate/subscription models —
 *   whose provider registry has no pay-as-you-go price, so the transcript says
 *   `$0` — still get a comparable cost. A real reported cost is always kept as-is.
 *   The rate comes from the model's `models.json` `cost` entry (see `env.modelCost`).
 */
export function collectMetrics(sessionsDir: string, fallbackRate?: ModelRate): RunMetrics {
  const files: string[] = [];
  walkJsonl(join(sessionsDir, "projects"), files);
  // Fallback: some shim configs write directly under sessionsDir.
  walkJsonl(sessionsDir, files);
  return collectMetricsFromFiles(files, fallbackRate);
}

/**
 * The same roll-up over an explicit file list — what the per-phase attribution
 * uses once {@link bucketSessionsByPhase} has split the run's sessions. Summing
 * every phase's result here reproduces {@link collectMetrics} for the whole run,
 * because both dedupe by path and read the same `result` envelopes.
 */
export function collectMetricsFromFiles(files: string[], fallbackRate?: ModelRate): RunMetrics {
  const seen = new Set<string>();
  const metrics: RunMetrics = { inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, agentMs: 0 };
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // best-effort: an unreadable file contributes zero
    }
    for (const line of text.split("\n")) {
      if (!line.trim() || !line.includes('"result"')) continue;
      try {
        const env = JSON.parse(line) as {
          type?: string;
          total_input_tokens?: number;
          total_cache_read_input_tokens?: number;
          total_cache_creation_input_tokens?: number;
          total_output_tokens?: number;
          total_cost_usd?: number;
          duration_ms?: number;
        };
        if (env.type !== "result") continue;
        metrics.inputTokens += env.total_input_tokens ?? 0;
        metrics.cachedTokens +=
          (env.total_cache_read_input_tokens ?? 0) + (env.total_cache_creation_input_tokens ?? 0);
        metrics.outputTokens += env.total_output_tokens ?? 0;
        metrics.agentMs += env.duration_ms ?? 0;
        const reported = env.total_cost_usd ?? 0;
        metrics.costUsd += reported > 0 || !fallbackRate ? reported : imputeCost(env, fallbackRate);
      } catch {
        /* ignore malformed lines */
      }
    }
  }
  return metrics;
}
