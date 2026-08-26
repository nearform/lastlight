import type { ModelSummary } from "../types";

/** Compact token count: <1000 verbatim, else "k" (one decimal under 10k). */
export function fmtTokens(n: number): string {
  const v = Number.isFinite(n) ? n : 0;
  if (v < 1000) return String(Math.round(v));
  const k = v / 1000;
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`;
}

/**
 * **The** duration formatter — every millisecond figure the dashboard prints
 * goes through here, so a phase row, a session lane and a p50 latency cell all
 * read the same way.
 *
 *   842ms · 12.4s · 4m 44s · 1h 12m
 *
 * The unit shrinks as the magnitude grows, always keeping ~3 significant
 * figures. This replaced two formatters: a rounded `4m02` and a raw
 * `284,391ms`. The raw one existed because comparing concurrent branches needs
 * to distinguish lanes that finished seconds apart — the ladder below keeps
 * that (1s resolution above a minute, 0.1s below it) while staying legible at a
 * glance, which grouped milliseconds never were.
 *
 * A zero-valued smaller unit is dropped (`4m`, not `4m 0s`), same as the
 * trailing `.0` on `1s`. `0` renders as `0ms` — a measured zero, not an em
 * dash; a caller with no measurement at all should render the dash itself
 * rather than pass a stand-in number.
 */
export function fmtDuration(ms: number): string {
  const t = Number.isFinite(ms) ? Math.max(0, Math.round(ms)) : 0;
  if (t < 1000) return `${t}ms`;

  // Round to tenths BEFORE the 60s test, so 59,970ms promotes to `1m` instead
  // of rendering the nonexistent `60.0s`. Same reason for the carries below.
  const tenths = Math.round(t / 100);
  if (tenths < 600) return `${tenths % 10 === 0 ? tenths / 10 : (tenths / 10).toFixed(1)}s`;

  const secs = Math.round(t / 1000);
  if (secs < 3600) {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }
  const mins = Math.round(secs / 60);
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
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

/**
 * Every pr-review-shaped tier, not just the literal one. Tier KEYS grow
 * suffixes (`pr-review-config`, `pr-review-compare` — see run.ts `tierKeyFor`)
 * and datasets may ship sibling tiers (`pr-review-martian`), and all of them
 * grade with the review judge. The literal `===` this replaces silently
 * dropped the REVIEW column, the F1 panel and the Martian ranking from every
 * suffixed tier.
 */
export function isPrReviewTier(tier: string): boolean {
  return tier === "pr-review" || tier.startsWith("pr-review-");
}

export function tierMetric(tier: string, beta = 1): TierMetric {
  if (tier === "code-fix") {
    return {
      label: "resolved",
      rate: (m) => (m.codeFixTotal ? m.codeFixResolved / m.codeFixTotal : 0),
      frac: (m) => (m.codeFixTotal ? `${m.codeFixResolved}/${m.codeFixTotal}` : "—"),
    };
  }
  if (isPrReviewTier(tier)) {
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

/** A provider-pinned snapshot suffix (`-20251001`), the thing that makes one
 * model read as two. Six digits or more, so a version like `-4-5` survives. */
const SNAPSHOT_SUFFIX = /-\d{6,}$/;

/**
 * The comparison key for a model id OR a display label: provider path dropped,
 * snapshot date dropped, punctuation flattened.
 *
 *   anthropic/claude-haiku-4-5-20251001 → claude-haiku-4-5
 *   Claude Haiku 4.5                    → claude-haiku-4-5
 *
 * Those two are the SAME model, and the runs table used to give them a column
 * each because `models.json` labels `anthropic/claude-haiku-4-5` while the runs
 * were launched against the pinned snapshot id.
 */
export function modelKey(s: string): string {
  const tail = s.includes("/") ? s.slice(s.lastIndexOf("/") + 1) : s;
  return tail
    .toLowerCase()
    .replace(SNAPSHOT_SUFFIX, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * One model id → the name to show plus the full id to keep in a `title`.
 *
 * Three steps, widest-trust first: the registry's exact label, then the
 * registry matched on {@link modelKey} (which is what collapses a pinned
 * snapshot onto its family label), then the bare model name with the provider
 * path and snapshot date trimmed off. The raw id is never lost — it rides in
 * `title`, so the pin stays inspectable on hover.
 *
 * Deliberately NOT applied to `config`-run arms: those labels are overlay/config
 * names, not model ids, and have no registry entry to collapse onto.
 */
export function modelDisplay(labels: Record<string, string>, id: string): { label: string; title: string } {
  const exact = labels[id];
  if (exact) return { label: exact, title: id };
  const key = modelKey(id);
  for (const [k, v] of Object.entries(labels)) {
    if (modelKey(k) === key || modelKey(v) === key) return { label: v, title: id };
  }
  const tail = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return { label: tail.replace(SNAPSHOT_SUFFIX, ""), title: id };
}
