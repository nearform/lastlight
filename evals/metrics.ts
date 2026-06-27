/**
 * Pull per-run token/cost/turn metrics out of the session jsonl the event
 * shim writes (`src/engine/event-shim.ts`). Each phase emits one `result`
 * envelope carrying `total_cost_usd` / `total_input_tokens` /
 * `total_output_tokens`. We sum them across every jsonl under the run's
 * sessions dir. Best-effort: missing files / lines just contribute zero.
 */

import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface RunMetrics {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
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

function walkJsonl(dir: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, name.name);
    if (name.isDirectory()) walkJsonl(full, out);
    else if (name.name.endsWith(".jsonl")) out.push(full);
  }
}

export function collectMetrics(sessionsDir: string): RunMetrics {
  const files: string[] = [];
  walkJsonl(join(sessionsDir, "projects"), files);
  // Fallback: some shim configs write directly under sessionsDir.
  walkJsonl(sessionsDir, files);

  const seen = new Set<string>();
  const metrics: RunMetrics = { inputTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line.trim() || !line.includes('"result"')) continue;
      try {
        const env = JSON.parse(line) as {
          type?: string;
          total_input_tokens?: number;
          total_output_tokens?: number;
          total_cost_usd?: number;
        };
        if (env.type !== "result") continue;
        metrics.inputTokens += env.total_input_tokens ?? 0;
        metrics.outputTokens += env.total_output_tokens ?? 0;
        metrics.costUsd += env.total_cost_usd ?? 0;
      } catch {
        /* ignore malformed lines */
      }
    }
  }
  return metrics;
}
