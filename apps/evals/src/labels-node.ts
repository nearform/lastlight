/**
 * The Node half of human grading (`labels.ts` holds the contract, the key rule
 * and the metrics): scan the phase-replay reports for findings, read each
 * finding's full text from the `findings.jsonl` the replay saved beside the
 * site's session log, read a code excerpt from the fixture checkout, attach the
 * case gold, and append labels.
 *
 * Only `site-review` reports feed it today. Their report carries a finding's
 * title (cut to 200 chars) but not its mechanism/consequence, so the text is
 * joined from `sessions/<report>/<case>/<site>/findings.jsonl` — matched on
 * path + line + title. A finding whose text cannot be read is counted in
 * `unreadable` and NOT listed, because its label key (which hashes the
 * mechanism) would change once the text appeared. Falsify / adjudicate /
 * posted-review findings slot in as further `collect…` functions producing
 * `RawFinding`s with their own `source`.
 *
 * Tolerant of reports still being written (two paid replays may be running):
 * a torn or partial report is skipped or read as far as it goes.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";

import {
  agreementMetrics,
  dedupFindings,
  foldLabels,
  foldProposals,
  graderOfFile,
  LABELS_DIR,
  LABELS_FILE,
  parseLabelLines,
  parseProposalLines,
  prIdentity,
  type CodeExcerpt,
  type FindingLabel,
  type FindingsResponse,
  type GradeFinding,
  type GradeGold,
  type LabelInput,
  type ProposalMap,
  type RawFinding,
} from "./labels.js";
import { PHASE_REPLAY_DIR, PHASE_REPLAY_VERSION, type PhaseReplayCase, type PhaseReplayReport } from "./phase-replay.js";

export const EXCERPT_CONTEXT = 8;

export function labelsFilePath(resultsRoot: string): string {
  return join(resultsRoot, LABELS_DIR, LABELS_FILE);
}

export function readLabels(file: string): Map<string, FindingLabel> {
  if (!existsSync(file)) return new Map();
  return foldLabels(parseLabelLines(readFileSync(file, "utf8")));
}

/**
 * Every `proposals-<grader>.jsonl` in `dir` (the labels dir), folded: last
 * write per (grader, key) wins. A file being written right now may end in a
 * torn line — it is skipped. Never touches `findings.jsonl`.
 */
export function readProposals(dir: string): ProposalMap {
  const m: ProposalMap = new Map();
  let names: string[];
  try {
    names = readdirSync(dir).sort();
  } catch {
    return m;
  }
  for (const name of names) {
    const grader = graderOfFile(name);
    if (!grader) continue;
    try {
      foldProposals(parseProposalLines(readFileSync(join(dir, name), "utf8"), grader), m);
    } catch {
      /* unreadable — skip */
    }
  }
  return m;
}

/** Append one label line (the finding text snapshotted onto it) and return it. */
export function appendLabel(file: string, input: LabelInput, finding: GradeFinding, now = new Date()): FindingLabel {
  const label: FindingLabel = {
    ...input,
    gradedAt: now.toISOString(),
    finding: {
      pr: finding.pr,
      path: finding.path,
      line: finding.line,
      title: finding.title,
      mechanism: finding.mechanism,
      consequence: finding.consequence,
    },
  };
  mkdirSync(dirname(file), { recursive: true });
  // One write per line: a single appendFileSync of < PIPE_BUF-ish size is not
  // interleaved with another process's, and a torn tail is skipped by the parser.
  appendFileSync(file, `${JSON.stringify(label)}\n`);
  return label;
}

// ── instances (optional, for full gold text) ────────────────────────────────

interface InstanceGold {
  review_gold?: { description?: string }[];
}

/**
 * `<workspace>/evals/datasets/pr-review/instances.json`, where the workspace is
 * the results root's parent (then cwd). Absent is fine: the report's own gold
 * summaries are shown.
 */
export function readInstanceGold(resultsRoot: string): Map<string, string[]> {
  const candidates = [
    join(dirname(resolve(resultsRoot)), "evals", "datasets", "pr-review", "instances.json"),
    resolve(process.cwd(), "evals", "datasets", "pr-review", "instances.json"),
  ];
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue;
      const list = JSON.parse(readFileSync(file, "utf8")) as (InstanceGold & { instance_id: string })[];
      return new Map(list.map((i) => [i.instance_id, (i.review_gold ?? []).map((g) => g.description ?? "")]));
    } catch {
      /* unreadable — fall through */
    }
  }
  return new Map();
}

// ── fixture excerpts ────────────────────────────────────────────────────────

/** `<fixture>/sandboxes/<task>/<repo>` — the dir holding `.git`; `null` when absent. */
function fixtureCheckout(fixture: string, cache: Map<string, string | null>): string | null {
  if (cache.has(fixture)) return cache.get(fixture)!;
  let out: string | null = null;
  try {
    const sandboxes = join(fixture, "sandboxes");
    for (const task of readdirSync(sandboxes)) {
      const taskDir = join(sandboxes, task);
      if (!statSync(taskDir).isDirectory()) continue;
      const repo = readdirSync(taskDir).find((e) => existsSync(join(taskDir, e, ".git")));
      if (repo) {
        out = join(taskDir, repo);
        break;
      }
    }
  } catch {
    out = null;
  }
  cache.set(fixture, out);
  return out;
}

export function readExcerpt(checkout: string, path: string, line: number, context = EXCERPT_CONTEXT): CodeExcerpt | null {
  const file = resolve(checkout, path);
  if (file !== resolve(checkout) && !file.startsWith(resolve(checkout) + sep)) return null;
  try {
    const all = readFileSync(file, "utf8").split("\n");
    const start = Math.max(1, line - context);
    const end = Math.min(all.length, line + context);
    if (start > all.length) return null;
    return { startLine: start, lines: all.slice(start - 1, end) };
  } catch {
    return null;
  }
}

// ── site-review findings ────────────────────────────────────────────────────

interface FullFindingLine {
  site?: unknown;
  path?: unknown;
  line?: unknown;
  title?: unknown;
  mechanism?: unknown;
  consequence?: unknown;
}

function readFindingsJsonl(file: string): FullFindingLine[] {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          const v = JSON.parse(l) as unknown;
          return v && typeof v === "object" && !Array.isArray(v) ? [v as FullFindingLine] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** `/data/<rel>` → `<resultsRoot>/<rel>`, refusing anything outside the root. */
function dataUrlToFile(resultsRoot: string, url: string): string | null {
  if (!url.startsWith("/data/")) return null;
  const abs = resolve(resultsRoot, url.slice("/data/".length));
  const base = resolve(resultsRoot);
  return abs.startsWith(base + sep) ? abs : null;
}

function caseGold(c: PhaseReplayCase, full: Map<string, string[]>): GradeGold[] {
  const desc = full.get(c.instanceId);
  return (c.gold ?? []).map((g, i) => ({ index: i, ...g, ...(desc?.[i] ? { description: desc[i] } : {}) }));
}

/** Every site-review finding in `<resultsRoot>/phase-replay/*.json`, one per appearance. */
export function collectSiteReviewFindings(resultsRoot: string): { raw: RawFinding[]; unreadable: number } {
  const dir = join(resultsRoot, PHASE_REPLAY_DIR);
  const raw: RawFinding[] = [];
  let unreadable = 0;
  if (!existsSync(dir)) return { raw, unreadable };
  const instanceGold = readInstanceGold(resultsRoot);
  const checkouts = new Map<string, string | null>();
  const excerpts = new Map<string, CodeExcerpt | null>();
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith(".json")) continue;
    let report: PhaseReplayReport;
    try {
      report = JSON.parse(readFileSync(join(dir, name), "utf8")) as PhaseReplayReport;
    } catch {
      continue; // torn or not JSON
    }
    if (!report || report.version !== PHASE_REPLAY_VERSION || report.kind !== "site-review" || !Array.isArray(report.cases)) continue;
    const reportId = name.replace(/\.json$/, "");
    for (const c of report.cases) {
      const sr = c.siteReview;
      if (!sr || !Array.isArray(sr.findings) || !sr.findings.length) continue;
      const gold = caseGold(c, instanceGold);
      const fileCache = new Map<string, FullFindingLine[]>();
      for (const f of sr.findings) {
        const site = sr.sites?.find((s) => s.id === f.site);
        const sessionFile = site?.session ? dataUrlToFile(resultsRoot, site.session) : null;
        const jsonl = sessionFile ? join(dirname(sessionFile), "findings.jsonl") : null;
        if (jsonl && !fileCache.has(jsonl)) fileCache.set(jsonl, readFindingsJsonl(jsonl));
        const lines = jsonl ? (fileCache.get(jsonl) ?? []) : [];
        const full = lines.find(
          (l) => l.path === f.path && l.line === f.line && typeof l.title === "string" && l.title.slice(0, 200) === f.title,
        );
        if (!full || typeof full.mechanism !== "string") {
          unreadable++;
          continue;
        }
        const checkout = c.fixture ? fixtureCheckout(c.fixture, checkouts) : null;
        const exKey = `${checkout}\n${f.path}\n${f.line}`;
        if (!excerpts.has(exKey)) excerpts.set(exKey, checkout ? readExcerpt(checkout, f.path, f.line) : null);
        raw.push({
          pr: prIdentity(c.instanceId),
          path: f.path,
          line: f.line,
          title: full.title as string,
          mechanism: full.mechanism,
          consequence: typeof full.consequence === "string" ? full.consequence : "",
          strength: f.strength,
          excerpt: excerpts.get(exKey) ?? null,
          gold,
          appearance: {
            source: "site-review",
            reportId,
            reportLabel: typeof report.label === "string" ? report.label : reportId,
            instanceId: c.instanceId,
            arm: c.arm,
            repeat: c.repeat,
            site: f.site,
            session: site?.session ?? null,
            ...(f.gold !== undefined ? { judgeGold: f.gold } : {}),
          },
        });
      }
    }
  }
  return { raw, unreadable };
}

/**
 * `GET /api/findings`: every finding, deduplicated by label key, with its
 * current human label and any machine proposals (read from the labels file's
 * directory), plus per-grader agreement with the human labels.
 */
export function buildFindings(resultsRoot: string, generatedAt: string, labelsFile = labelsFilePath(resultsRoot)): FindingsResponse {
  const { raw, unreadable } = collectSiteReviewFindings(resultsRoot);
  const findings = dedupFindings(raw, readLabels(labelsFile), readProposals(dirname(labelsFile)));
  findings.sort((a, b) => a.pr.localeCompare(b.pr) || a.path.localeCompare(b.path) || a.line - b.line);
  return { generatedAt, findings, unreadable, agreement: agreementMetrics(findings) };
}

