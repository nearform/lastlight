import type { ModelSummary } from "../types";

/** Compact token count: <1000 verbatim, else "k" (one decimal under 10k). */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

/** Exact milliseconds, grouped — `242,013ms`.
 *
 * Distinct from {@link fmtMs}, which rounds to whole seconds above 1s. Used for
 * a session's own duration, where the point is to compare concurrent branches
 * against each other and a rounded `4m02` hides the difference between two
 * lanes that finished seconds apart. */
export function fmtMsExact(ms: number): string {
  return `${Math.max(0, Math.round(ms)).toLocaleString("en-US")}ms`;
}

export function fmtMs(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

/** `2026-06-28 14:30 UTC` from an ISO string (best-effort). */
export function fmtDate(iso: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

/** The primary success metric for a tier (higher = better), matching the
 * harness scorecard semantics: code-fix → resolved%, everything else → behavioral%. */
export interface TierMetric {
  label: string;
  rate: (m: ModelSummary) => number;
  frac: (m: ModelSummary) => string;
}

export function tierMetric(tier: string, beta = 1): TierMetric {
  if (tier === "code-fix") {
    return {
      label: "resolved",
      rate: (m) => (m.codeFixTotal ? m.codeFixResolved / m.codeFixTotal : 0),
      frac: (m) => (m.codeFixTotal ? `${m.codeFixResolved}/${m.codeFixTotal}` : "—"),
    };
  }
  if (tier === "pr-review") {
    // F-beta is the headline (F1 by default — Martian's leaderboard metric),
    // shown as a percentage with the underlying precision/recall in the fraction
    // slot. The label reflects the β the run used (F1, F0.5, …).
    return {
      label: `F${beta}`,
      rate: (m) => (m.reviewTotal ? m.avgFbeta : 0),
      frac: (m) =>
        m.reviewTotal ? `${(m.avgFbeta * 100).toFixed(0)}% · P${m.avgPrecision.toFixed(2)}/R${m.avgRecall.toFixed(2)}` : "—",
    };
  }
  return {
    label: "behavioral",
    rate: (m) => (m.behavioralTotal ? m.behavioralOk / m.behavioralTotal : 0),
    frac: (m) => (m.behavioralTotal ? `${m.behavioralOk}/${m.behavioralTotal}` : "—"),
  };
}

/** Rank models by the tier metric (desc), tie-broken by cheaper total cost. */
export function rankModels(models: ModelSummary[], metric: TierMetric): ModelSummary[] {
  return [...models].sort((a, b) => metric.rate(b) - metric.rate(a) || a.totalCostUsd - b.totalCostUsd);
}

export function modelLabel(labels: Record<string, string>, id: string): string {
  return labels[id] ?? id;
}
