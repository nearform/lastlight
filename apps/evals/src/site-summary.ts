/**
 * Arm C of the site-review replay (`micro-site-review --leads summary`):
 * SUMMARISED leads. docs/plans/pr-review-units-sites.md, "Site review".
 *
 * Arm B's subject leads barely deduplicate (about one lead per row, e.g. 18
 * leads for 18 rows), so they are the row list minus prose rather than a
 * summary. Here each selected site gets ONE non-agentic model call over its
 * rows (id, family, anchor line, claim, and the evidence record's `subject` /
 * `consequence` / `cannot_distinguish`) that MERGES them into at most
 * {@link maxConcernsFor}(rows) concerns. The investigator then reads the
 * concerns instead of the rows; rows stay a volume signal.
 *
 * **A summary merges, it never filters.** The first version had a `noise`
 * bucket, and at a 5-concern cap Haiku put 4 of 11 gold rows in it despite
 * the prompt forbidding exactly that. So there is no discard: every site row
 * lands in exactly one concern. The cap scales with the site
 * (min(8, max(2, ⌈rows / 2⌉))), and each concern names its `specific` row —
 * the one whose mechanism is most specific — whose `subject` the brief shows
 * verbatim beside the concern, so a broad merge cannot lose the exact
 * call or condition.
 *
 * The reply is checked in code ({@link validateSiteSummary}), never trusted:
 * it parses, stays within the cap, cites only the site's rows, each at most
 * once, and each `specific` is one of its concern's rows. Rows the reply
 * leaves out are the one thing repaired — collected into a synthetic final
 * concern ({@link UNMERGED_CONCERN}) and COUNTED as `uncovered`, never
 * dropped. Anything else malformed retries once with the rejection, then the
 * site falls back to arm B's subject leads (`fallback: true`).
 *
 * Replies are cached on disk by {@link summaryCacheKey} (model + prompt + the
 * rows' JSON), so a repeat, a later investigator arm or a `--summaries-only`
 * pass over the same fixture pays once. The cache holds the raw replies, not
 * the validated result, so a validator change re-reads them for free.
 *
 * Evals-only, like `site-review.ts`: nothing in core runs this.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { pathOfRow, renderSiteBrief, siteLeads, type HypothesisSet, type Site } from "lastlight-code-facts";

import { complete, parseJudgeJson, type Completion } from "./judge.js";

export const DEFAULT_SUMMARY_MODEL = "anthropic/claude-haiku-4-5-20251001";
/** The synthetic concern the rows a reply left out are collected into. */
export const UNMERGED_CONCERN = "Other suspicions (unmerged)";
const CACHE_VERSION = 2;
const MAX_ATTEMPTS = 2;

/** The concern cap for a site of `rows` rows: min(8, max(2, ⌈rows / 2⌉)). */
export function maxConcernsFor(rows: number): number {
  return Math.min(8, Math.max(2, Math.ceil(rows / 2)));
}

/** One row as the summary call reads it. */
export interface SummaryRow {
  id: string;
  family: string;
  line: number | null;
  claim: string | null;
  subject: string | null;
  consequence: string | null;
  cannot_distinguish: string | null;
}

export interface SiteConcern {
  concern: string;
  line: number | null;
  rows: string[];
  /** The row whose mechanism is most specific (one of `rows`); `null` on the synthetic unmerged concern. */
  specific: string | null;
  /** The synthetic {@link UNMERGED_CONCERN} — rows the reply left out. */
  unmerged?: boolean;
}

export interface SiteSummary {
  /** Every site row appears in exactly one concern. */
  concerns: SiteConcern[];
  /** Rows the reply cited nowhere — repaired into the synthetic unmerged concern, counted here. */
  uncovered: string[];
  /** The cap this site's reply was held to. */
  maxConcerns: number;
}

export type SummaryValidation = { ok: true; summary: SiteSummary } | { ok: false; error: string };

export interface SiteSummaryResult {
  /** `null` when every attempt was malformed — the site falls back to subject leads. */
  summary: SiteSummary | null;
  fallback: boolean;
  /** Replies read (cached or fresh), 1–2. */
  attempts: number;
  /** No fresh call was made: every reply read came from the cache. */
  cached: boolean;
  inputTokens: number;
  outputTokens: number;
  /** What the replies read cost to produce, cached or not; `null` for an unpriced model. */
  costUsd: number | null;
  /** Why each rejected attempt was rejected. */
  errors: string[];
  maxConcerns: number;
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().replace(/\s+/g, " ") : null);

/** The row's anchor line: its first quote on its own path, else `bothEnds.introducedAt` — `clusterSites`' rule. */
function anchorLine(row: Record<string, unknown>): number | null {
  const path = pathOfRow(row);
  for (const q of Array.isArray(row.quotes) ? row.quotes : []) {
    const { path: p, line } = (q ?? {}) as { path?: unknown; line?: unknown };
    if ((path === null || p === path) && typeof line === "number" && Number.isFinite(line)) return line;
  }
  const at = (row.bothEnds as { introducedAt?: unknown } | undefined)?.introducedAt;
  const m = typeof at === "string" ? /:(\d+)$/.exec(at.trim()) : null;
  return m ? Number(m[1]) : null;
}

/** The site's rows, in the site's order, projected to what the summary call reads. */
export function siteSummaryRows(site: Pick<Site, "rows">, set: HypothesisSet): SummaryRow[] {
  return site.rows.map((id) => {
    const record = set.byId.get(id);
    const row = (record?.row ?? {}) as Record<string, unknown>;
    const ev = (row.evidence && typeof row.evidence === "object" ? row.evidence : {}) as Record<string, unknown>;
    return {
      id,
      family: record?.family ?? "",
      line: anchorLine(row),
      claim: str(row.claim),
      subject: str(ev.subject),
      consequence: str(ev.consequence),
      cannot_distinguish: str(ev.cannot_distinguish),
    };
  });
}

/** The user message: where the site is, the site's cap, then one compact JSON object per row. */
export function renderSummaryInput(site: Pick<Site, "id" | "path" | "startLine" | "endLine">, rows: SummaryRow[]): string {
  const where = site.path === null ? "no anchored location" : `${site.path}${site.startLine !== null ? ` lines ${site.startLine}–${site.endLine}` : ""}`;
  return [
    `Site ${site.id}: ${where}. ${rows.length} rows. At most ${maxConcernsFor(rows.length)} concerns for this site.`,
    "",
    ...rows.map((r) => JSON.stringify(r)),
  ].join("\n");
}

/** sha256 over model, prompt and the rows' JSON — any change to one is a new entry. */
export function summaryCacheKey(model: string, prompt: string, rows: SummaryRow[]): string {
  return createHash("sha256").update(`${model}\0${prompt}\0${JSON.stringify(rows)}`).digest("hex");
}

/**
 * Check a reply against the site's rows. Deterministic; reads no prose.
 * Rejects: unparseable JSON, `concerns` not an array, more than
 * `maxConcerns` concerns, a concern with no text or no rows, an id that is
 * not one of `rowIds`, an id cited twice, a `specific` that is not one of its
 * concern's rows. A missing `specific` defaults to the concern's first row.
 * Repairs only rows cited nowhere: a synthetic {@link UNMERGED_CONCERN}
 * holds them (beyond the cap — it is the repair, not the model's), and
 * `uncovered` lists them. Any `noise` key is ignored, so rows put there are
 * uncovered too.
 */
export function validateSiteSummary(reply: string, rowIds: readonly string[], maxConcerns: number = maxConcernsFor(rowIds.length)): SummaryValidation {
  const parsed = parseJudgeJson<{ concerns?: unknown }>(reply);
  if (!parsed || typeof parsed !== "object") return { ok: false, error: "the reply is not a JSON object" };
  if (!Array.isArray(parsed.concerns)) return { ok: false, error: "`concerns` is not an array" };
  if (parsed.concerns.length > maxConcerns) return { ok: false, error: `${parsed.concerns.length} concerns — at most ${maxConcerns} for this site; merge the closest` };

  const known = new Set(rowIds);
  const seen = new Set<string>();
  const concerns: SiteConcern[] = [];
  for (const [i, raw] of parsed.concerns.entries()) {
    const c = (raw ?? {}) as { concern?: unknown; line?: unknown; rows?: unknown; specific?: unknown };
    const text = str(c.concern);
    if (!text) return { ok: false, error: `concern ${i + 1} has no text` };
    if (!Array.isArray(c.rows) || c.rows.length === 0) return { ok: false, error: `concern ${i + 1} cites no rows` };
    const rows: string[] = [];
    for (const id of c.rows) {
      if (typeof id !== "string" || !known.has(id)) return { ok: false, error: `concern ${i + 1} cites ${JSON.stringify(id)}, not a row of this site` };
      if (seen.has(id)) return { ok: false, error: `concern ${i + 1} cites ${id}, already cited — each row belongs to exactly one concern` };
      seen.add(id);
      rows.push(id);
    }
    if (c.specific !== undefined && c.specific !== null && !(typeof c.specific === "string" && rows.includes(c.specific)))
      return { ok: false, error: `concern ${i + 1}'s \`specific\` ${JSON.stringify(c.specific)} is not one of its rows` };
    const line = typeof c.line === "number" && Number.isFinite(c.line) ? Math.round(c.line) : null;
    concerns.push({ concern: text, line, rows, specific: typeof c.specific === "string" ? c.specific : rows[0] });
  }
  const uncovered = rowIds.filter((id) => !seen.has(id));
  if (uncovered.length) concerns.push({ concern: UNMERGED_CONCERN, line: null, rows: uncovered, specific: null, unmerged: true });
  return { ok: true, summary: { concerns, uncovered, maxConcerns } };
}

// ── pricing (list, per million tokens) — only for the report's $ ────────────

const PRICES: [RegExp, { input: number; output: number }][] = [
  [/haiku-4/i, { input: 1, output: 5 }],
  [/sonnet-4/i, { input: 3, output: 15 }],
  [/opus-4-[5-9]/i, { input: 5, output: 25 }],
];

export function summaryCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const price = PRICES.find(([re]) => re.test(model))?.[1];
  return price ? (inputTokens * price.input + outputTokens * price.output) / 1_000_000 : null;
}

// ── the call, cached ─────────────────────────────────────────────────────────

/** A cached reply, with the rejection it was asked to fix (`null` on the first attempt). */
type CachedReply = Completion & { feedback?: string | null };

interface CacheEntry {
  version: number;
  model: string;
  replies: (CachedReply | null)[];
}

function readCache(file: string): (CachedReply | null)[] {
  if (!existsSync(file)) return [];
  try {
    const e = JSON.parse(readFileSync(file, "utf8")) as CacheEntry;
    return e.version === CACHE_VERSION && Array.isArray(e.replies) ? e.replies : [];
  } catch {
    return [];
  }
}

function writeCache(file: string, model: string, replies: (CachedReply | null)[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, model, replies } satisfies CacheEntry, null, 2));
  renameSync(tmp, file);
}

/** The retry's user message: the rows again, then what the checker rejected. */
export function retryInput(user: string, rejection: string): string {
  return `${user}\n\nYour previous reply was rejected by the checker: ${rejection}. Reply again with the corrected JSON only.`;
}

export type SummaryCall = (model: string, system: string, user: string) => Promise<Completion>;

/**
 * Summarise one site: up to two replies (cached first, then fresh), the first
 * that validates wins; none does → `fallback`. A provider error counts as a
 * rejected attempt and is never cached.
 *
 * The retry carries the first reply's rejection ({@link retryInput}): at
 * temperature 0 the same input returns the same malformed reply, so a bare
 * retry buys nothing. A cached retry is reused only when it answered the same
 * rejection.
 */
export async function summariseSite(opts: {
  model: string;
  prompt: string;
  site: Pick<Site, "id" | "path" | "startLine" | "endLine">;
  rows: SummaryRow[];
  cacheDir: string;
  call?: SummaryCall;
}): Promise<SiteSummaryResult> {
  const call = opts.call ?? ((m, s, u) => complete(m, s, u, { maxTokens: 4096 }));
  mkdirSync(opts.cacheDir, { recursive: true });
  const file = join(opts.cacheDir, `${summaryCacheKey(opts.model, opts.prompt, opts.rows)}.json`);
  const replies = readCache(file);
  const ids = opts.rows.map((r) => r.id);
  const user = renderSummaryInput(opts.site, opts.rows);
  const maxConcerns = maxConcernsFor(opts.rows.length);
  const out: SiteSummaryResult = { summary: null, fallback: false, attempts: 0, cached: true, inputTokens: 0, outputTokens: 0, costUsd: 0, errors: [], maxConcerns };
  let unpriced = false;
  let cost = 0;
  let rejection: string | null = null;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    // Only a malformed REPLY is fed back; a provider error retries the plain input.
    const feedback = i > 0 ? rejection : null;
    let reply = replies[i] && (replies[i]!.feedback ?? null) === feedback ? replies[i]! : undefined;
    if (!reply) {
      out.cached = false;
      try {
        reply = { ...(await call(opts.model, opts.prompt, feedback === null ? user : retryInput(user, feedback))), feedback };
      } catch (err) {
        out.attempts++;
        out.errors.push(`call failed: ${(err as Error).message.slice(0, 200)}`);
        continue;
      }
      replies[i] = reply;
      writeCache(file, opts.model, Array.from({ length: i + 1 }, (_, k) => replies[k] ?? null));
    }
    out.attempts++;
    out.inputTokens += reply.inputTokens ?? 0;
    out.outputTokens += reply.outputTokens ?? 0;
    const priced = summaryCostUsd(opts.model, reply.inputTokens ?? 0, reply.outputTokens ?? 0);
    if (priced === null) unpriced = true;
    else cost += priced;
    const v = validateSiteSummary(reply.text, ids, maxConcerns);
    if (v.ok) {
      out.summary = v.summary;
      break;
    }
    out.errors.push(v.error);
    rejection = v.error;
  }
  out.costUsd = unpriced ? null : cost;
  out.fallback = out.summary === null;
  return out;
}

// ── the brief ────────────────────────────────────────────────────────────────

export type LeadsMode = "none" | "subjects" | "summary";

/**
 * The site brief an arm's investigator reads, and the lead-number bound its
 * gate applies. `summary` (arm C) is `renderSiteBrief` without leads plus a
 * numbered Concerns section — the finding's `leads` then cite concern
 * numbers, so the bound is the concern count. A `summary` site whose summary
 * fell back reads arm B's subject leads, bounded by their count.
 */
export function siteBriefFor(
  mode: LeadsMode,
  site: Pick<Site, "id" | "path" | "startLine" | "endLine" | "support" | "voters" | "rows">,
  set: HypothesisSet,
  summary: SiteSummary | null,
): { brief: string; leadCount: number } {
  if (mode === "none") return { brief: renderSiteBrief(site, set, { leads: false }), leadCount: 0 };
  if (mode === "subjects" || summary === null) return { brief: renderSiteBrief(site, set, { leads: true }), leadCount: siteLeads(site, set).leads.length };
  const base = renderSiteBrief(site, set, { leads: false })
    .split("\n")
    .filter((l) => !/^No leads are given/.test(l))
    .join("\n")
    .replace(/\n+$/, "\n");
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const out = [base, "### Concerns", ""];
  if (summary.concerns.length === 0) {
    out.push("The hypotheses at this site named no specific concern, so there are no leads.");
  } else {
    out.push("These are this site's leads, summarised from its hypotheses. Cite them by number in a finding's `leads`.", "");
    const subjectOf = (id: string): string | null => {
      const ev = (set.byId.get(id)?.row as Record<string, unknown> | undefined)?.evidence;
      return ev && typeof ev === "object" ? str((ev as Record<string, unknown>).subject) : null;
    };
    summary.concerns.forEach((c, i) => {
      const bits = [...(c.line !== null ? [`L${c.line}`] : []), plural(c.rows.length, "row")];
      out.push(`${i + 1}. ${c.concern} (${bits.join(", ")})`);
      // The specific row's own subject, verbatim: a broad merge keeps the exact mechanism.
      const specific = c.specific !== null ? subjectOf(c.specific) : null;
      if (specific) out.push(`   - Most specific: ${specific}`);
      if (c.unmerged) for (const subject of [...new Set(c.rows.map(subjectOf).filter((x): x is string => !!x))]) out.push(`   - ${subject}`);
    });
  }
  return { brief: `${out.join("\n")}\n`, leadCount: summary.concerns.length };
}
