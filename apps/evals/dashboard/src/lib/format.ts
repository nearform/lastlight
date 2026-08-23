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

/** A metric that is legitimately UNDEFINED (no gold, nothing posted, no noise)
 * renders as an em dash — never as `0`, which reads as a measured failure.
 * Mirrors the harness `fmtRatio` (`src/report.ts`). */
export function fmtRatio(x: number | null | undefined, digits = 3): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "—" : x.toFixed(digits);
}

/** A 0..1 ratio as a whole percent, or an em dash when undefined. */
export function fmtPct(x: number | null | undefined): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "—" : `${(x * 100).toFixed(0)}%`;
}

/** The primary success metric for a tier (higher = better), matching the
 * harness scorecard semantics: code-fix → resolved%, pr-review → micro-recall,
 * everything else → behavioral%. */
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
    // **Micro-recall is the headline** — matched ÷ gold summed over cases. The
    // per-case F-beta mean this used to show is a different number: it weights a
    // 1-gold case like a 6-gold one and hands a free 1.00 to a case with no gold
    // at all, so the UI was reporting one quantity while every plan reasoned in
    // the other. F-beta stays visible as a secondary column (see
    // {@link fbetaLabel}), which is what the Martian leaderboard comparison needs.
    return {
      label: "micro-recall",
      rate: (m) => m.micro?.microRecall ?? 0,
      frac: (m) =>
        m.micro && m.micro.gold > 0
          ? `${fmtPct(m.micro.microRecall)} · ${m.micro.matched}/${m.micro.gold}`
          : "—",
    };
  }
  return {
    label: "behavioral",
    rate: (m) => (m.behavioralTotal ? m.behavioralOk / m.behavioralTotal : 0),
    frac: (m) => (m.behavioralTotal ? `${m.behavioralOk}/${m.behavioralTotal}` : "—"),
  };
}

/** The label for the secondary per-case F-beta column, reflecting the β the run
 * graded with (F1 by default; `EVAL_F_BETA` reweights). */
export function fbetaLabel(beta = 1): string {
  return `F${beta}`;
}

/** Rank models by the tier metric (desc), tie-broken by cheaper total cost. */
export function rankModels(models: ModelSummary[], metric: TierMetric): ModelSummary[] {
  return [...models].sort((a, b) => metric.rate(b) - metric.rate(a) || a.totalCostUsd - b.totalCostUsd);
}

export function modelLabel(labels: Record<string, string>, id: string): string {
  return labels[id] ?? id;
}
