/**
 * Assemble the static site that the Cloudflare Worker serves.
 *
 * Cloudflare Workers have NO filesystem at the edge, so the dashboard's two
 * dynamic endpoints — which `src/serve.ts` computes live from `eval-results/`
 * via `readdirSync` — have to be pre-baked into plain files here:
 *
 *   /api/index            ← buildIndex(eval-results)  (the filesystem scan)
 *   /data/<tier>/<run>/…  ← a verbatim copy of eval-results/
 *
 * plus the dashboard SPA shell at the root. The result (`dist-site/`) is served
 * as static assets — no Worker code needed (the SPA uses hash routing, so every
 * app route resolves to `/index.html`). Re-run after new eval runs, then deploy.
 *
 * RESULTS SOURCE — prefer the live `eval-results/` (gitignored, present on a
 * machine that has run evals); fall back to the vendored `sample-results/` (a
 * committed run per tier) when it's absent or empty. That's what makes CI —
 * which has no `eval-results/` — deploy a real, representative dashboard instead
 * of an empty shell, WITHOUT running an eval in the build. A local `npm run
 * deploy` with real results still wins; the sample is just the floor.
 */
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildIndex } from "../src/report.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dashboardDist = join(root, "dashboard", "dist");
const out = join(root, "dist-site");

// Prefer live eval-results/, fall back to the committed sample-results/.
const liveRoot = join(root, "eval-results");
const sampleRoot = join(root, "sample-results");
const liveHasRuns = buildIndex(liveRoot, new Date().toISOString()).tiers.length > 0;
const resultsRoot = liveHasRuns ? liveRoot : sampleRoot;

if (!existsSync(join(dashboardDist, "index.html"))) {
  console.error("dashboard/dist is missing — run `npm run build:dashboard` first.");
  process.exit(1);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

// 1) SPA shell (index.html + assets) at the site root.
cpSync(dashboardDist, out, { recursive: true });

// 2) Raw run artifacts under /data — the exact tree serve.ts exposes there.
if (existsSync(resultsRoot)) cpSync(resultsRoot, join(out, "data"), { recursive: true });

// 3) The /api/index the SPA fetches — baked once, matching serve.ts's route.
mkdirSync(join(out, "api"), { recursive: true });
const index = buildIndex(resultsRoot, new Date().toISOString());
writeFileSync(join(out, "api", "index"), JSON.stringify(index));

const tiers = index.tiers.length;
const runs = index.tiers.reduce((n, t) => n + t.runs.length, 0);
const src = liveHasRuns ? "eval-results/" : "sample-results/ (vendored)";
console.log(`Built static site → dist-site/  (${tiers} tier-combos, ${runs} runs from ${src})`);
