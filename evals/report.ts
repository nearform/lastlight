/**
 * Scorecard rendering + SWE-bench-compatible artifacts.
 *
 *  - A stdout table comparing models on resolved% / triage-correct% / tokens /
 *    cost / latency.
 *  - `scorecard.json`  — the structured roll-up.
 *  - `predictions.jsonl` — SWE-bench predictions shape
 *    (`{ instance_id, model_name_or_path, model_patch }`), so the same artifact
 *    is consumable by SWE-bench's own harness.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { InstanceResult } from "./schema.js";

export interface Scorecard {
  models: ModelSummary[];
  results: InstanceResult[];
}

export interface ModelSummary {
  model: string;
  total: number;
  codeFixResolved: number;
  codeFixTotal: number;
  behavioralOk: number;
  behavioralTotal: number;
  avgInputTokens: number;
  avgOutputTokens: number;
  totalCostUsd: number;
  p50DurationMs: number;
  errors: number;
}

export function summarize(results: InstanceResult[]): Scorecard {
  const byModel = new Map<string, InstanceResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const models: ModelSummary[] = [];
  for (const [model, list] of byModel) {
    const codeFix = list.filter((r) => r.resolved !== undefined);
    const behavioral = list.filter((r) => r.behavioral !== undefined);
    const durations = list.map((r) => r.durationMs).sort((a, b) => a - b);
    models.push({
      model,
      total: list.length,
      codeFixResolved: codeFix.filter((r) => r.resolved).length,
      codeFixTotal: codeFix.length,
      behavioralOk: behavioral.filter((r) => r.behavioral?.ok).length,
      behavioralTotal: behavioral.length,
      avgInputTokens: avg(list.map((r) => r.inputTokens)),
      avgOutputTokens: avg(list.map((r) => r.outputTokens)),
      totalCostUsd: list.reduce((s, r) => s + r.costUsd, 0),
      p50DurationMs: durations[Math.floor(durations.length / 2)] ?? 0,
      errors: list.filter((r) => r.error).length,
    });
  }

  return { models, results };
}

export function renderTable(card: Scorecard, labels: Record<string, string> = {}): string {
  const header = ["model", "code-fix", "behavioral", "in tok", "out tok", "cost $", "p50", "err"];
  const rows = card.models.map((m) => [
    labels[m.model] ?? m.model,
    m.codeFixTotal ? `${m.codeFixResolved}/${m.codeFixTotal}` : "—",
    m.behavioralTotal ? `${m.behavioralOk}/${m.behavioralTotal}` : "—",
    String(Math.round(m.avgInputTokens)),
    String(Math.round(m.avgOutputTokens)),
    m.totalCostUsd.toFixed(4),
    fmtMs(m.p50DurationMs),
    String(m.errors),
  ]);
  return table([header, ...rows]);
}

export function writeArtifacts(dir: string, card: Scorecard): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(card, null, 2));
  const preds = card.results
    .filter((r) => r.model_patch !== undefined)
    .map((r) => JSON.stringify({ instance_id: r.instance_id, model_name_or_path: r.model, model_patch: r.model_patch ?? "" }))
    .join("\n");
  writeFileSync(join(dir, "predictions.jsonl"), preds ? preds + "\n" : "");
}

// ── helpers ─────────────────────────────────────────────────────────────────

function avg(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}
function table(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows
    .map((r) => r.map((c, i) => (c ?? "").padEnd(widths[i])).join("  "))
    .join("\n");
}
