#!/usr/bin/env -S npx tsx
/**
 * Generate the shipped Martian leaderboard sidecar for the `pr-review` tier.
 *
 * The dashboard's "Where would we rank?" panel scores Martian's own tools over
 * *exactly* the PRs a run covered (subset-fair) and slots our model in. That needs
 * Martian's per-tool, per-PR tp/fp/fn — which lives in the benchmark's
 * `offline/analysis/benchmark_dashboard.json` (keyed by PR URL, per judge model).
 *
 * This script joins that data onto OUR `instance_id`s so the runtime needs no
 * external checkout: it reads the benchmark from `.eval-cache/` (or
 * `LASTLIGHT_EVALS_CACHE`), maps each instance → its Martian PR URL via the gold
 * comment text (our `review_gold` was copied verbatim from Martian's
 * `golden_comments`, which carry the URL — a stable join that also covers the
 * synthetic `discourse-graphite` / `*-greptile` URLs that don't match `repo/pull/N`),
 * then emits `datasets/pr-review/martian-leaderboard.json`.
 *
 * We pin the judge to Martian's dashboard default (opus-4-5) — the panel labels
 * that baseline and notes that our reviews are judged by a different judge.
 *
 * Usage: npx tsx scripts/gen-martian-leaderboard.ts [--cache <dir>] [--out <file>]
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const JUDGE = "anthropic_claude-opus-4-5-20251101"; // Martian dashboard default_model

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}

interface ToolMetric { tp: number; fp: number; fn: number }
interface DashPr { url: string; tool_metrics: Record<string, ToolMetric> }
interface Dashboard {
  models: Record<string, { prs: DashPr[] }>;
  tool_display_names: Record<string, string>;
  default_model?: string;
}
interface GoldenEntry { url: string; comments: { comment: string; severity: string }[] }
interface Instance { instance_id: string; review_gold?: { description: string }[] }

function main(): void {
  const cache = resolve(flag("cache") ?? process.env.LASTLIGHT_EVALS_CACHE ?? ".eval-cache");
  const bench = join(cache, "code-review-benchmark");
  const dashPath = join(bench, "offline/analysis/benchmark_dashboard.json");
  const goldenDir = join(bench, "offline/golden_comments");
  const out = resolve(flag("out") ?? "datasets/pr-review/martian-leaderboard.json");
  const instancesPath = resolve("datasets/pr-review/instances.json");

  for (const [label, p] of [["benchmark_dashboard.json", dashPath], ["golden_comments/", goldenDir], ["instances.json", instancesPath]] as const) {
    if (!existsSync(p)) {
      console.error(`${label} not found at ${p} — clone withmartian/code-review-benchmark into ${cache} (see scripts/import-martian.ts) or pass --cache.`);
      process.exit(1);
    }
  }

  const dash = JSON.parse(readFileSync(dashPath, "utf8")) as Dashboard;
  const model = dash.models[JUDGE];
  if (!model) {
    console.error(`judge model "${JUDGE}" not in benchmark_dashboard.json (have: ${Object.keys(dash.models).join(", ")})`);
    process.exit(1);
  }
  const dashByUrl = new Map<string, DashPr>(model.prs.map((p) => [p.url, p]));

  // gold-comment text → Martian PR URL (stable join key; verbatim copy in our data).
  const urlByGold = new Map<string, string>();
  for (const f of readdirSync(goldenDir).filter((n) => n.endsWith(".json"))) {
    for (const e of JSON.parse(readFileSync(join(goldenDir, f), "utf8")) as GoldenEntry[]) {
      for (const c of e.comments) urlByGold.set(c.comment.trim(), e.url);
    }
  }

  const instances = JSON.parse(readFileSync(instancesPath, "utf8")) as Instance[];
  const sidecar: Record<string, { url: string; toolMetrics: Record<string, ToolMetric> }> = {};
  const missing: string[] = [];
  for (const inst of instances) {
    let url: string | undefined;
    for (const g of inst.review_gold ?? []) {
      const u = urlByGold.get((g.description ?? "").trim());
      if (u) { url = u; break; }
    }
    const pr = url ? dashByUrl.get(url) : undefined;
    if (!url || !pr) { missing.push(inst.instance_id); continue; }
    sidecar[inst.instance_id] = { url, toolMetrics: pr.tool_metrics };
  }

  if (missing.length) {
    console.warn(`⚠ ${missing.length}/${instances.length} instances unmatched (no leaderboard data): ${missing.join(", ")}`);
  }

  const payload = {
    source: "withmartian/code-review-benchmark",
    judgeModel: "anthropic/claude-opus-4-5-20251101",
    note: "Per-tool tp/fp/fn from Martian's offline benchmark_dashboard.json (opus-4-5 judge), keyed by our instance_id. Used to rank a run against Martian's tools over the exact PRs it covered.",
    toolDisplayNames: dash.tool_display_names,
    instances: sidecar,
  };
  writeFileSync(out, JSON.stringify(payload, null, 2) + "\n");
  console.log(`✓ wrote ${out}: ${Object.keys(sidecar).length}/${instances.length} instances, ${Object.keys(dash.tool_display_names).length} tools (judge ${JUDGE}).`);
}

main();
