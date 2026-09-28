/**
 * The dashboard server — a tiny, dependency-free local HTTP server that backs
 * the JSON-driven SPA. There is no per-run HTML any more: the harness only ever
 * writes `scorecard.json`, and this server turns the on-disk tree into the two
 * things the dashboard needs:
 *
 *   GET /api/index             → the live index (filesystem scan of eval-results,
 *                                recomputed per request, so accumulating runs +
 *                                live in-flight writes show up by polling).
 *   GET /api/micro             → the micro-survey index (the same scan, over the
 *                                loose reports in eval-results/micro-survey/).
 *   GET /api/unit-survey       → the unit-survey replay index (the same scan,
 *                                over eval-results/unit-survey/*.json).
 *   GET /api/phase-replay      → the phase-replay index (micro-falsify /
 *                                micro-adjudicate, eval-results/phase-replay/).
 *   GET /api/findings          → every finding the pipeline flagged (site-review
 *                                reports for now), deduplicated by label key,
 *                                with excerpt, gold and the current human label.
 *   POST /api/labels           → append one human grade to
 *                                eval-results/labels/findings.jsonl.
 *   GET /data/<tier>/<run>/…   → the raw run artifacts (scorecard.json, …),
 *                                served straight from `eval-results/`.
 *   GET /*                     → the built dashboard SPA (with an index.html
 *                                fallback so client-side routing works).
 *
 * Browsers block `fetch()` over `file://`, which is the whole reason this exists
 * — `run` starts it for the live report and `serve` starts it to browse history.
 */

import { createServer, type Server } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

import { appendLabel, buildFindings, labelsFilePath } from "./labels-node.js";
import { validateLabelInput } from "./labels.js";
import { buildIndex, buildMicroIndex, buildPhaseReplayIndex, buildUnitSurveyIndex } from "./report.js";

export interface ServeOptions {
  /** `eval-results/` root to index + serve raw artifacts from. */
  resultsRoot: string;
  /** Built dashboard SPA assets (`dashboard/dist`). */
  dashboardRoot: string;
  /** Preferred port; falls back to an ephemeral port if it's taken. */
  port?: number;
  host?: string;
  /** Human-grade store; default `<resultsRoot>/labels/findings.jsonl`. */
  labelsFile?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".jsonl": "application/x-ndjson; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/**
 * Resolve a URL path under `root`, returning null on any path-traversal attempt
 * (a request that escapes the root) so the server never serves outside its tree.
 */
function safeJoin(root: string, urlPath: string): string | null {
  const rel = normalize(decodeURIComponent(urlPath)).replace(/^([/\\])+/, "");
  const abs = resolve(root, rel);
  const base = resolve(root);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  return abs;
}

function sendFile(res: import("node:http").ServerResponse, file: string): boolean {
  if (!existsSync(file) || !statSync(file).isFile()) return false;
  res.writeHead(200, {
    "content-type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
    // Artifacts change between runs; never let a stale copy stick around.
    "cache-control": "no-cache",
  });
  createReadStream(file).pipe(res);
  return true;
}

const NO_DASHBOARD = (root: string) =>
  `<!doctype html><meta charset="utf-8"><title>Last Light Evals</title>` +
  `<body style="font-family:system-ui;background:#0d1117;color:#e6edf3;padding:48px;max-width:640px;margin:0 auto">` +
  `<h1>Dashboard not built</h1>` +
  `<p>No built SPA found at <code>${root}</code>.</p>` +
  `<p>Run <code>npm run build</code> in the <code>lastlight-evals</code> package ` +
  `(or set <code>LASTLIGHT_EVALS_DASHBOARD</code>) to build the dashboard, then reload.</p>` +
  `<p>The raw data is still available at <a href="/api/index" style="color:#7dd3fc">/api/index</a>.</p>`;

/**
 * Start the dashboard server. Tries `port` (default 4319) and, if that's in use,
 * falls back to an OS-assigned ephemeral port so two runs never collide.
 */
export function startServer(opts: ServeOptions): Promise<RunningServer> {
  const { resultsRoot, dashboardRoot } = opts;
  const labelsFile = opts.labelsFile ?? labelsFilePath(resultsRoot);
  const host = opts.host ?? "127.0.0.1";
  const preferred = opts.port ?? (Number(process.env.LASTLIGHT_EVALS_PORT) || 4319);

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // 1) Live index — recomputed from the filesystem on every request.
    if (path === "/api/index") {
      const body = JSON.stringify(buildIndex(resultsRoot, new Date().toISOString()));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
      return;
    }

    // 2) The micro-survey index — a SECOND filesystem scan, of the loose JSON
    //    files `scripts/micro-survey.ts` drops in `eval-results/micro-survey/`.
    //    Separate from `/api/index` because a micro-survey is not a run: it has
    //    no tier, no scorecard and no graded cases, and folding it into the tier
    //    index would have every existing consumer reason about an entry that
    //    answers none of the questions that index is for. Recomputed per request
    //    for the same reason as the index above.
    if (path === "/api/micro") {
      const body = JSON.stringify(buildMicroIndex(resultsRoot, new Date().toISOString()));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
      return;
    }

    // 2b) The unit-survey replay index — the same kind of loose-report scan,
    //     over `eval-results/unit-survey/` (`scripts/unit-survey-replay.ts`).
    //     Its own endpoint for the same reason as `/api/micro`: a replay is not
    //     a run. The report bodies are fetched from `/data/unit-survey/…`.
    if (path === "/api/unit-survey") {
      const body = JSON.stringify(buildUnitSurveyIndex(resultsRoot, new Date().toISOString()));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
      return;
    }

    // 2c) The phase-replay index — `scripts/micro-falsify.ts` and
    //     `scripts/micro-adjudicate.ts`, one pr-review phase replayed over
    //     preserved fixtures. Not a run either; bodies via `/data/phase-replay/…`.
    if (path === "/api/phase-replay") {
      const body = JSON.stringify(buildPhaseReplayIndex(resultsRoot, new Date().toISOString()));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
      return;
    }

    // 2d) Human grading. The findings list is a scan like the indexes above
    //     (recomputed per request, so a replay still writing shows up); the
    //     label POST appends one line and returns what was stored.
    if (path === "/api/findings") {
      const body = JSON.stringify(buildFindings(resultsRoot, new Date().toISOString(), labelsFile));
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
      res.end(body);
      return;
    }
    if (path === "/api/labels") {
      const json = (status: number, v: unknown) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache" });
        res.end(JSON.stringify(v));
      };
      if (req.method !== "POST") return json(405, { error: "POST only" });
      let body = "";
      let tooBig = false;
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
        if (body.length > 64 * 1024) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on("end", () => {
        if (tooBig) return json(413, { error: "body too large" });
        let parsed: unknown;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(400, { error: "body is not JSON" });
        }
        const v = validateLabelInput(parsed);
        if (!v.ok) return json(400, { error: v.error });
        // The finding must exist NOW: its text is snapshotted onto the label.
        const finding = buildFindings(resultsRoot, new Date().toISOString(), labelsFile).findings.find((f) => f.key === v.value.key);
        if (!finding) return json(404, { error: `no finding with key ${v.value.key}` });
        const g = v.value.gold;
        if (g && !finding.gold.some((x) => x.instanceId === g.instanceId && g.index < x.items.length))
          return json(400, { error: `gold: ${g.instanceId} has no gold ${g.index} for this finding` });
        try {
          json(200, appendLabel(labelsFile, v.value, finding));
        } catch (err) {
          json(500, { error: (err as Error).message });
        }
      });
      return;
    }

    // 3) Raw run artifacts straight out of eval-results/.
    if (path.startsWith("/data/")) {
      const file = safeJoin(resultsRoot, path.slice("/data/".length));
      if (file && sendFile(res, file)) return;
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
      return;
    }

    // 4) The dashboard SPA (static assets, else index.html fallback for routes).
    const indexHtml = join(dashboardRoot, "index.html");
    if (path !== "/") {
      const asset = safeJoin(dashboardRoot, path);
      if (asset && sendFile(res, asset)) return;
    }
    if (sendFile(res, indexHtml)) return;
    res.writeHead(existsSync(dashboardRoot) ? 200 : 503, { "content-type": "text/html; charset=utf-8" });
    res.end(NO_DASHBOARD(dashboardRoot));
  });

  return new Promise((resolvePromise, reject) => {
    let triedEphemeral = false;
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE" && !triedEphemeral) {
        triedEphemeral = true;
        server.listen(0, host); // let the OS pick a free port
        return;
      }
      reject(err);
    };
    server.on("error", onError);
    server.on("listening", () => {
      server.off("error", onError);
      server.on("error", () => {}); // swallow late errors (client resets, etc.)
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : preferred;
      resolvePromise({
        url: `http://localhost:${port}`,
        port,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
    server.listen(preferred, host);
  });
}
