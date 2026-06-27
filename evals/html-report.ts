/**
 * Self-contained HTML scorecard, styled to match the Last Light site
 * (~/work/lastlight-www): dark navy theme, gold/orange/teal accents,
 * Inter + JetBrains Mono. No build step, no external assets beyond Google
 * Fonts — written straight to `evals/results/<tiers>/index.html`.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { Scorecard } from "./report.js";
import type { InstanceResult } from "./schema.js";

export interface HtmlMeta {
  generatedAt: string;
  models: string[];
  tiers: string[];
  labels?: Record<string, string>;
}

const esc = (s: unknown): string =>
  String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

function pill(kind: "pass" | "fail" | "na", label: string): string {
  return `<span class="pill ${kind}">${esc(label)}</span>`;
}

function fmtMs(ms: number): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}`;
}

function checksHtml(r: InstanceResult): string {
  const checks = r.behavioral?.checks ?? [];
  if (!checks.length && r.resolved === undefined) return '<span class="muted">—</span>';
  const chips = checks
    .map((c) => `<span class="chip ${c.ok ? "ok" : "no"}" title="${esc(c.detail ?? "")}">${esc(c.name)}</span>`)
    .join("");
  return chips || '<span class="muted">—</span>';
}

function summaryCards(card: Scorecard, labels: Record<string, string>): string {
  return card.models
    .map((m) => {
      const codeFix = m.codeFixTotal ? `${m.codeFixResolved}/${m.codeFixTotal}` : "—";
      const beh = m.behavioralTotal ? `${m.behavioralOk}/${m.behavioralTotal}` : "—";
      return `
      <div class="card">
        <div class="card-model">${esc(labels[m.model] ?? m.model)}</div>
        <div class="stats">
          <div class="stat"><div class="stat-num gold">${beh}</div><div class="stat-label">behavioral</div></div>
          <div class="stat"><div class="stat-num orange">${codeFix}</div><div class="stat-label">code-fix resolved</div></div>
          <div class="stat"><div class="stat-num teal">$${m.totalCostUsd.toFixed(3)}</div><div class="stat-label">total cost</div></div>
          <div class="stat"><div class="stat-num">${fmtMs(m.p50DurationMs)}</div><div class="stat-label">p50 latency</div></div>
          <div class="stat"><div class="stat-num">${Math.round(m.avgInputTokens)}/${Math.round(m.avgOutputTokens)}</div><div class="stat-label">avg in/out tok</div></div>
          <div class="stat"><div class="stat-num ${m.errors ? "fail-fg" : ""}">${m.errors}</div><div class="stat-label">harness errors</div></div>
        </div>
      </div>`;
    })
    .join("\n");
}

function detailRows(results: InstanceResult[], labels: Record<string, string>): string {
  return results
    .map((r) => {
      const resolved =
        r.resolved === undefined ? pill("na", "—") : r.resolved ? pill("pass", "resolved") : pill("fail", "unresolved");
      const beh = r.error
        ? pill("fail", "error")
        : r.behavioral
          ? r.behavioral.ok
            ? pill("pass", "ok")
            : pill("fail", "miss")
          : pill("na", "—");
      return `
      <tr>
        <td class="mono">${esc(r.instance_id)}</td>
        <td class="mono muted">${esc(labels[r.model] ?? r.model)}</td>
        <td>${resolved}</td>
        <td>${beh}</td>
        <td class="checks">${checksHtml(r)}</td>
        <td class="mono num">$${r.costUsd.toFixed(4)}</td>
        <td class="mono num">${fmtMs(r.durationMs)}</td>
      </tr>${r.error ? `<tr class="errrow"><td colspan="7" class="mono err">${esc(r.error)}</td></tr>` : ""}`;
    })
    .join("\n");
}

export function renderHtml(card: Scorecard, meta: HtmlMeta): string {
  const labels = meta.labels ?? {};
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Last Light — Eval Scorecard</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  :root {
    --gold:#F0B429; --orange:#E8752A; --teal:#1A7A8A; --teal-dark:#135E6B;
    --navy:#1B2735; --bg:#0C1117; --bg-card:#141B24; --bg-card-hover:#1A2332;
    --border:#1E2A38; --text:#C9D1D9; --text-muted:#7D8694; --text-bright:#ECEFF4;
    --pass:#3FB950; --fail:#E5534B;
    --mono:'JetBrains Mono',monospace; --sans:'Inter',-apple-system,sans-serif;
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family:var(--sans); line-height:1.55; }
  .wrap { max-width:1100px; margin:0 auto; padding:48px 24px 80px; }
  header { border-bottom:1px solid var(--border); padding-bottom:24px; margin-bottom:32px; }
  h1 { color:var(--text-bright); font-size:30px; margin:0 0 6px; letter-spacing:-0.02em; }
  h1 .accent { color:var(--gold); }
  h2 { color:var(--text-bright); font-size:18px; margin:36px 0 14px; }
  .meta { color:var(--text-muted); font-size:13px; font-family:var(--mono); }
  .meta b { color:var(--text); font-weight:600; }
  .cards { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:16px; }
  .card { background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:18px 20px; }
  .card-model { font-family:var(--mono); color:var(--gold); font-weight:600; margin-bottom:14px; font-size:14px; }
  .stats { display:grid; grid-template-columns:repeat(3,1fr); gap:14px 10px; }
  .stat-num { font-family:var(--mono); font-size:20px; color:var(--text-bright); font-weight:600; }
  .stat-num.gold{color:var(--gold);} .stat-num.orange{color:var(--orange);} .stat-num.teal{color:var(--teal);}
  .stat-num.fail-fg{color:var(--fail);}
  .stat-label { color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.04em; margin-top:2px; }
  table { width:100%; border-collapse:collapse; background:var(--bg-card); border:1px solid var(--border); border-radius:12px; overflow:hidden; }
  th { text-align:left; color:var(--text-muted); font-size:11px; text-transform:uppercase; letter-spacing:0.05em; font-weight:600; padding:12px 14px; border-bottom:1px solid var(--border); background:var(--navy); }
  td { padding:12px 14px; border-bottom:1px solid var(--border); font-size:13px; vertical-align:top; }
  tr:last-child td { border-bottom:none; }
  .mono { font-family:var(--mono); }
  .num { text-align:right; white-space:nowrap; }
  .muted { color:var(--text-muted); }
  .pill { display:inline-block; font-family:var(--mono); font-size:11px; font-weight:600; padding:3px 9px; border-radius:999px; }
  .pill.pass { background:rgba(63,185,80,0.14); color:var(--pass); }
  .pill.fail { background:rgba(229,83,75,0.14); color:var(--fail); }
  .pill.na { background:var(--navy); color:var(--text-muted); }
  .checks { line-height:2; }
  .chip { display:inline-block; font-family:var(--mono); font-size:10.5px; padding:2px 7px; border-radius:5px; margin:0 4px 4px 0; border:1px solid var(--border); }
  .chip.ok { color:var(--pass); border-color:rgba(63,185,80,0.4); }
  .chip.no { color:var(--fail); border-color:rgba(229,83,75,0.4); }
  .errrow td { color:var(--fail); background:rgba(229,83,75,0.06); }
  .err { white-space:pre-wrap; }
  footer { margin-top:40px; color:var(--text-muted); font-size:12px; font-family:var(--mono); }
  a { color:var(--gold); }
</style>
</head>
<body>
  <div class="wrap">
    <header>
      <h1>Last Light <span class="accent">·</span> Eval Scorecard</h1>
      <div class="meta">
        <b>${esc(meta.tiers.join(" + "))}</b> &nbsp;·&nbsp;
        models: <b>${esc(meta.models.join(", "))}</b> &nbsp;·&nbsp;
        ${esc(card.results.length)} runs &nbsp;·&nbsp;
        ${esc(meta.generatedAt)}
      </div>
    </header>

    <h2>Models</h2>
    <div class="cards">
      ${summaryCards(card, labels)}
    </div>

    <h2>Per-instance results</h2>
    <table>
      <thead>
        <tr><th>instance</th><th>model</th><th>code-fix</th><th>behavioral</th><th>checks</th><th>cost</th><th>latency</th></tr>
      </thead>
      <tbody>
        ${detailRows(card.results, labels)}
      </tbody>
    </table>

    <footer>
      Real production workflows · mocked GitHub · deterministic grading.
      Generated by <span class="mono">npm run eval</span>. Also: scorecard.json · predictions.jsonl.
    </footer>
  </div>
</body>
</html>
`;
}

export function writeHtml(dir: string, card: Scorecard, meta: HtmlMeta): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "index.html");
  writeFileSync(file, renderHtml(card, meta));
  return file;
}
