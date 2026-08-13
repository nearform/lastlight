import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  api,
  type FeedbackDailyRow,
  type FeedbackSignal,
  type FeedbackSummaryRow,
} from "../api";
import { useTheme } from "../hooks/useTheme";
import { STATUS } from "../lib/status-colors";

/**
 * Feedback signals (issue #255) — 👍/👎 people left on what Last Light wrote,
 * scored against the workflow run that wrote it.
 *
 * The view exists to answer one question: is a change to a prompt or skill
 * making the output better or worse? So the score line is the headline, the
 * per-workflow table is where you look to see *which* workflow moved, and the
 * raw feed is there to check that a number means what you think it means.
 */

// Recharts parses fill strings internally and can't resolve `hsl(var(--p))`,
// so what remains here is literal hex per theme: `score` is a CATEGORICAL line
// colour and stays local.
//
// `positive` / `negative` are NOT themed and are NOT this page's to pick — a
// 👍 is the same `good` as a succeeded run, so both come from the shared
// STATUS palette (issue #329). They used to be per-theme literals here, which
// drifted from the Home page's and, worse, made the dark pair `#86efac` /
// `#fca5a5` — ΔE 5.8 for deuteranopes, below the floor, on the two bars in
// this view that most need telling apart.
const CHART_DARK = {
  score: "#7dd3fc",
  grid: "#21262d",
  axis: "rgba(230, 237, 243, 0.45)",
  tooltipBg: "#161b22",
  tooltipBorder: "#21262d",
};

const CHART_LIGHT = {
  score: "#0b3b63",
  grid: "#e2e6ea",
  axis: "rgba(27, 35, 48, 0.55)",
  tooltipBg: "#ffffff",
  tooltipBorder: "#e2e6ea",
};

type Range = 7 | 30 | 90;

/** The emoji a canonical reaction name renders as. */
const GLYPH: Record<string, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  rocket: "🚀",
  heart: "❤️",
  confused: "😕",
  eyes: "👀",
  smile: "😄",
  smiley: "😄",
  grinning: "😀",
  heart_eyes: "😍",
  disappointed: "😞",
  cry: "😢",
  sob: "😭",
};

const glyph = (emoji: string) => GLYPH[emoji] ?? `:${emoji}:`;

function scoreTone(score: number): string {
  if (score > 0) return "text-success";
  if (score < 0) return "text-error";
  return "text-base-content/50";
}

export function FeedbackPage() {
  const [range, setRange] = useState<Range>(30);
  const [workflow, setWorkflow] = useState<string | null>(null);
  const [daily, setDaily] = useState<FeedbackDailyRow[] | null>(null);
  const [summary, setSummary] = useState<FeedbackSummaryRow[] | null>(null);
  const [signals, setSignals] = useState<FeedbackSignal[] | null>(null);
  const { isDark } = useTheme();
  const CHART = isDark ? CHART_DARK : CHART_LIGHT;

  const load = useCallback(async () => {
    try {
      const [d, s, f] = await Promise.all([
        api.feedbackDaily(range, workflow ?? undefined),
        api.feedbackSummary(range),
        api.feedbackSignals({ limit: 50, workflow: workflow ?? undefined }),
      ]);
      setDaily(d.daily);
      setSummary(s.summary);
      setSignals(f.signals);
    } catch {
      // Leave the last good render in place — a transient admin-API blip
      // should not blank the page.
    }
  }, [range, workflow]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const chartData = useMemo(
    () =>
      (daily ?? []).map((d) => ({
        date: d.date.slice(5),
        positive: d.positive,
        // Plotted downward so the two directions read as opposing, not stacked.
        negative: -d.negative,
        score: d.averageScore,
      })),
    [daily],
  );

  /**
   * The count axis is pinned SYMMETRIC around zero, because the plot carries two
   * Y scales and the reader sees only one horizontal zero.
   *
   * Left to recharts, this axis auto-fits the data — one +1 and one -1 gives
   * `[-1, 3]`, whose zero sits near the bottom of the plot while the score
   * axis's zero (symmetric `[-2, 2]`) sits in the middle. The bars then rise
   * correctly from *their* zero and appear, to anyone reading the visible
   * gridline, to float below it. A symmetric domain makes the two zeros the
   * same pixel by construction rather than by luck.
   */
  const countMax = useMemo(
    () => Math.max(1, ...(daily ?? []).map((d) => Math.max(d.positive, d.negative))),
    [daily],
  );

  const totals = useMemo(() => {
    const rows = summary ?? [];
    const positive = rows.reduce((n, r) => n + r.positive, 0);
    const negative = rows.reduce((n, r) => n + r.negative, 0);
    const scored = rows.reduce((n, r) => n + r.positive + r.negative, 0);
    // Re-derive the mean from per-workflow means weighted by their scored
    // counts — averaging the averages would let a workflow with two signals
    // outweigh one with two hundred.
    const weighted = rows.reduce((n, r) => n + r.averageScore * (r.positive + r.negative), 0);
    return { positive, negative, average: scored ? weighted / scored : 0 };
  }, [summary]);

  const hasData = (summary?.length ?? 0) > 0;

  return (
    <div className="flex-1 overflow-auto p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Feedback</h1>
          <p className="text-xs text-base-content/50">
            👍 / 👎 on what Last Light wrote, scored against the run that wrote it.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {workflow && (
            <button className="btn btn-xs btn-ghost" onClick={() => setWorkflow(null)}>
              {workflow} ✕
            </button>
          )}
          <div className="join">
            {([7, 30, 90] as Range[]).map((r) => (
              <button
                key={r}
                className={`join-item btn btn-xs ${range === r ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRange(r)}
              >
                {r}d
              </button>
            ))}
          </div>
        </div>
      </div>

      {!hasData && (
        <div className="card bg-base-200 shadow-sm">
          <div className="card-body p-6 text-sm text-base-content/60">
            <p className="font-medium text-base-content/80">No feedback yet.</p>
            <p>
              React 👍 👎 🎉 🚀 😕 on a message Last Light posts — in Slack, or on
              GitHub once <code className="text-xs">feedback.github</code> is enabled —
              and it will be scored against the run that produced it.
            </p>
          </div>
        </div>
      )}

      {hasData && (
        <>
          <div className="flex gap-3">
            <div className="stat bg-base-200 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Average score</div>
              <div className={`stat-value text-xl ${scoreTone(totals.average)}`}>
                {totals.average > 0 ? "+" : ""}
                {totals.average.toFixed(2)}
              </div>
              <div className="stat-desc text-xs">scored signals only (👀 excluded)</div>
            </div>
            <div className="stat bg-base-200 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Positive</div>
              <div className="stat-value text-xl text-success">{totals.positive}</div>
            </div>
            <div className="stat bg-base-200 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Negative</div>
              <div className="stat-value text-xl text-error">{totals.negative}</div>
            </div>
          </div>

          <div className="card bg-base-200 shadow-sm">
            <div className="card-body p-4">
              <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide">
                Score over time{workflow ? ` — ${workflow}` : ""}
              </h2>
              <ResponsiveContainer width="100%" height={180}>
                <ComposedChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} />
                  <YAxis
                    yAxisId="count"
                    width={40}
                    domain={[-countMax, countMax]}
                    tick={{ fontSize: 10, fill: CHART.axis }}
                    stroke={CHART.axis}
                    allowDecimals={false}
                  />
                  <YAxis
                    yAxisId="score"
                    orientation="right"
                    width={40}
                    domain={[-2, 2]}
                    ticks={[-2, -1, 0, 1, 2]}
                    tick={{ fontSize: 10, fill: CHART.axis }}
                    stroke={CHART.axis}
                  />
                  <Tooltip
                    contentStyle={{
                      fontSize: 11,
                      background: CHART.tooltipBg,
                      border: `1px solid ${CHART.tooltipBorder}`,
                    }}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  {/* The one zero both scales share — drawn, not implied. */}
                  <ReferenceLine yAxisId="count" y={0} stroke={CHART.axis} />
                  <Bar yAxisId="count" dataKey="positive" fill={STATUS.good} name="positive" />
                  <Bar yAxisId="count" dataKey="negative" fill={STATUS.bad} name="negative" />
                  <Line
                    yAxisId="score"
                    type="monotone"
                    dataKey="score"
                    stroke={CHART.score}
                    strokeWidth={2}
                    dot={false}
                    name="avg score"
                  />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="card bg-base-200 shadow-sm">
            <div className="card-body p-4">
              <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide">
                By workflow
              </h2>
              <table className="table table-xs">
                <thead>
                  <tr>
                    <th>Workflow</th>
                    <th className="text-right">Avg</th>
                    <th className="text-right">👍</th>
                    <th className="text-right">👎</th>
                    <th className="text-right">👀</th>
                  </tr>
                </thead>
                <tbody>
                  {(summary ?? []).map((row) => (
                    <tr
                      key={row.workflowName ?? "unattributed"}
                      className="hover cursor-pointer"
                      onClick={() => setWorkflow(row.workflowName)}
                    >
                      <td className="font-medium">
                        {row.workflowName ?? (
                          <span className="text-base-content/50 italic">unattributed</span>
                        )}
                      </td>
                      <td className={`text-right font-mono ${scoreTone(row.averageScore)}`}>
                        {row.averageScore > 0 ? "+" : ""}
                        {row.averageScore.toFixed(2)}
                      </td>
                      <td className="text-right">{row.positive}</td>
                      <td className="text-right">{row.negative}</td>
                      <td className="text-right text-base-content/50">{row.neutral}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="card bg-base-200 shadow-sm">
            <div className="card-body p-4">
              <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide">
                Recent signals
              </h2>
              <table className="table table-xs">
                <thead>
                  <tr>
                    <th></th>
                    <th>Workflow</th>
                    <th>Where</th>
                    <th>Who</th>
                    <th className="text-right">When</th>
                  </tr>
                </thead>
                <tbody>
                  {(signals ?? []).map((s) => (
                    <tr key={s.id}>
                      <td className="text-base">{glyph(s.emoji)}</td>
                      <td>{s.workflowName ?? <span className="text-base-content/40">—</span>}</td>
                      <td className="text-base-content/60">
                        {s.repo
                          ? `${s.owner ? `${s.owner}/` : ""}${s.repo}${s.issueNumber ? `#${s.issueNumber}` : ""}`
                          : "slack"}
                      </td>
                      <td className="text-base-content/60">{s.reactor ?? "—"}</td>
                      <td className="text-right text-base-content/50">
                        {new Date(s.observedAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
