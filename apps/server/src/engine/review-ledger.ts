/**
 * The PR's review ledger — what our reviews of this PR found, what became of
 * each finding, and which code they had already covered (issue #429).
 *
 * Re-reviews kept raising new points on code that had not changed since the
 * first review (46% of later-round comments, nearform PRs, Sept 2026), because
 * nothing carried from one round to the next but the GitHub review itself: the
 * withheld findings were overwritten with the workspace, `select` was asked
 * to spot its own earlier points in the rendered discussion, and the sites
 * pipeline re-sampled the whole PR every round. This is the memory.
 *
 * **It is a field of the snapshot, never a store beside it** — the PR journal's
 * rule (`pr-notes.ts`). `post-review` folds the run's dispositions into the
 * ledger it was dispatched with and writes the result to the run's
 * `scratch.reviewLedger`; the next dispatch reads it back onto
 * `PrState.reviewLedger` (`deriveReviewLedger`). No table, no migration.
 *
 * Two halves:
 *
 * - `units` — `{key, contentSha}` of every unit the last review cut, so the
 *   next one can tell which code it already had (`prior-review.json`,
 *   code-facts' `review-delta.ts`). Replaced wholesale by each review that cut
 *   units; carried untouched by one that did not.
 * - `findings` — every finding a review produced, posted or not, keyed by a
 *   FINGERPRINT of its file and the code it quotes (`existingCode`, the anchor
 *   of record). Title and body are model prose and never part of identity.
 *
 * Status comes only from structured signals, never from reply text (the
 * notes' "hints, never instructions" rule — PR content can come from outside
 * contributors):
 *
 * - `open` — posted, and its quoted code is still there;
 * - `withheld` — recorded, never posted (a nit, the attention boundary, the
 *   convergence gate) — kept so a later round cannot "discover" it;
 * - `addressed` — its quoted code is gone from the file at this head;
 * - `resolved` — a maintainer resolved our thread on it.
 *
 * Closed entries (`addressed`, `resolved`) are kept for exactly the round that
 * closed them — the round whose summary says so — and dropped by the next
 * fold. Open and withheld entries are never evicted by age; a hard cap keeps
 * the run row bounded, dropping withheld before open, and says so.
 */
import { createHash } from "node:crypto";

export const REVIEW_LEDGER_VERSION = 1;
export const REVIEW_LEDGER_SCRATCH_KEY = "reviewLedger";

/** Findings kept at most — a bound on the run row, not a policy. */
export const MAX_LEDGER_FINDINGS = 80;
/** Units kept at most — `units.json`'s own ceiling, plus the `pr` unit. */
export const MAX_LEDGER_UNITS = 151;
/**
 * Width of one line hash — code-facts' `LINE_HASH_CHARS` (6 base64url chars),
 * restated because core does not depend on code-facts.
 */
export const LEDGER_LINE_HASH_CHARS = 6;
/**
 * Line-hash characters kept at most (5,000 lines). Measured on lastlight#424,
 * a 2,000-line PR: ~4.5 KB. Over it the LARGEST files go first — a file with
 * no recorded lines is judged by its unit's delta instead (a softer gate,
 * never a missing one).
 */
export const MAX_LEDGER_LINE_CHARS = 30_000;
const MAX_EXCERPT = 160;
const MAX_TITLE = 160;

export type LedgerStatus = "open" | "withheld" | "addressed" | "resolved";
export type LedgerTier = "inline" | "body" | "internal";

export interface LedgerFinding {
  /** sha1 of the path and the normalised quoted code — see {@link findingFingerprint}. */
  fp: string;
  path: string;
  line: number | null;
  /** The quoted code, trimmed and capped — what the fingerprint and the "addressed" test read. */
  excerpt: string;
  title: string;
  severity: string | null;
  importance: string | null;
  tier: LedgerTier;
  /** The poster's demotion / internal reason, as `disposition.json` records it. */
  reason: string | null;
  status: LedgerStatus;
  /** The head this finding was first produced at, and last re-produced or carried at. */
  foundAt: string | null;
  lastSeenAt: string | null;
  /** The head whose review closed it — set with `addressed` / `resolved`. */
  closedAt?: string | null;
}

export interface LedgerUnit {
  key: string;
  contentSha: string | null;
}

export interface ReviewLedger {
  version: typeof REVIEW_LEDGER_VERSION;
  /** The head the latest fold ran at. */
  head: string | null;
  at: string;
  /** Reviews folded in, ever. */
  rounds: number;
  units: LedgerUnit[];
  /**
   * Per file, the line hashes (code-facts' `lineHash`, 6 base64url chars each,
   * concatenated) of every non-trivial line the last review's units covered —
   * the convergence gate's evidence that a finding's code was already there.
   * Replaced with `units`. Absent on a ledger written before it.
   */
  lines?: Record<string, string>;
  findings: LedgerFinding[];
  /** Set when a cap dropped entries. */
  truncated?: boolean;
}

/** The poster's disposition of one finding — `disposition.json`'s row. */
export interface DispositionRow {
  tier: LedgerTier;
  reason: string | null;
  finding: {
    path?: string;
    line?: number;
    existingCode?: string;
    title?: string;
    severity?: string;
    importance?: string;
  };
}

/** One review thread, the fields `getPullRequestDiscussion` returns. */
export interface LedgerThread {
  path: string;
  isResolved: boolean;
  isOutdated: boolean;
  comments: { author: string; isBot: boolean; body: string }[];
}

function normaliseCode(code: string): string {
  return code
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n");
}

/**
 * A finding's identity across rounds: its file and the code it quotes,
 * whitespace-normalised. A finding with no quote falls back to its title —
 * the one case where prose decides, and the weakest identity there is.
 */
export function findingFingerprint(path: string, existingCode: string | undefined, title: string | undefined): string {
  const code = existingCode ? normaliseCode(existingCode) : "";
  const basis = code ? `code\0${code}` : `title\0${(title ?? "").trim().toLowerCase()}`;
  return createHash("sha1").update(`${path}\0${basis}`).digest("hex").slice(0, 16);
}

const POSTED: ReadonlySet<LedgerTier> = new Set(["inline", "body"]);
const isPosted = (f: LedgerFinding): boolean => POSTED.has(f.tier);

/**
 * Read a ledger back off JSON that outlives the build that wrote it: anything
 * that is not recognisably a ledger is `null`, and a malformed entry is dropped
 * rather than failing the read.
 */
export function coerceLedger(value: unknown): ReviewLedger | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== REVIEW_LEDGER_VERSION || !Array.isArray(v.findings) || !Array.isArray(v.units)) return null;
  const str = (x: unknown): string | null => (typeof x === "string" ? x : null);
  const findings: LedgerFinding[] = [];
  for (const raw of v.findings) {
    if (!raw || typeof raw !== "object") continue;
    const f = raw as Record<string, unknown>;
    if (typeof f.fp !== "string" || typeof f.path !== "string" || typeof f.status !== "string") continue;
    if (!["open", "withheld", "addressed", "resolved"].includes(f.status)) continue;
    findings.push({
      fp: f.fp,
      path: f.path,
      line: typeof f.line === "number" ? f.line : null,
      excerpt: str(f.excerpt) ?? "",
      title: str(f.title) ?? "",
      severity: str(f.severity),
      importance: str(f.importance),
      tier: f.tier === "inline" || f.tier === "body" ? f.tier : "internal",
      reason: str(f.reason),
      status: f.status as LedgerStatus,
      foundAt: str(f.foundAt),
      lastSeenAt: str(f.lastSeenAt),
      ...(f.closedAt !== undefined ? { closedAt: str(f.closedAt) } : {}),
    });
  }
  const units = v.units
    .filter((u): u is Record<string, unknown> => !!u && typeof u === "object" && typeof (u as Record<string, unknown>).key === "string")
    .map((u) => ({ key: u.key as string, contentSha: str(u.contentSha) }));
  const lines =
    v.lines && typeof v.lines === "object" && !Array.isArray(v.lines)
      ? Object.fromEntries(Object.entries(v.lines as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"))
      : null;
  return {
    version: REVIEW_LEDGER_VERSION,
    head: str(v.head),
    at: str(v.at) ?? new Date(0).toISOString(),
    rounds: typeof v.rounds === "number" ? v.rounds : 0,
    units,
    ...(lines ? { lines } : {}),
    findings,
    ...(v.truncated === true ? { truncated: true } : {}),
  };
}

/** Is a bot thread about this ledger finding? Same file, and our first comment carries its title. */
function threadFor(f: LedgerFinding, threads: readonly LedgerThread[], bot: string): LedgerThread | undefined {
  if (!f.title) return undefined;
  return threads.find((t) => {
    const first = t.comments[0];
    return t.path === f.path && !!first?.isBot && first.author === bot && first.body.includes(f.title);
  });
}

export interface FoldInput {
  prior: ReviewLedger | null;
  /** The head this review ran at. */
  head: string | null;
  /** This review's units (`units.json`); `null` when it cut none — the prior units carry. */
  units: LedgerUnit[] | null;
  /** This review's per-file line hashes, read with the units; `null` carries the prior ones. */
  lines?: Record<string, string> | null;
  /** This review's dispositions; `[]` when it produced no finding. */
  dispositions: readonly DispositionRow[];
  /**
   * Is this quoted code still in this file at this head? `null` = cannot tell
   * (no checkout) — the entry keeps its status.
   */
  excerptPresent: (path: string, excerpt: string) => boolean | null;
  /** The PR's review threads; `null` when the read failed — no entry is resolved from them. */
  threads: readonly LedgerThread[] | null;
  /**
   * The thread read hit its page cap. Unseen threads are unknown, not absent:
   * a resolved thread we DID see still closes its finding; one we did not
   * leaves the finding open. Same fail-safe as `threads: null`, on the
   * unmatched entries only — the pages we hold are still used.
   */
  threadsTruncated?: boolean;
  /** GraphQL's name for the bot (no `[bot]` suffix). */
  bot: string;
  now?: string;
}

/** Fold one review into the ledger. Pure. */
export function foldReviewLedger(input: FoldInput): ReviewLedger {
  const head = input.head;
  // Closed entries were reported by the round that closed them; they go now.
  const carried = (input.prior?.findings ?? []).filter((f) => f.status === "open" || f.status === "withheld").map((f) => ({ ...f }));

  for (const f of carried) {
    // A truncated page is still a page: honour a match we have. No match
    // (or `threads: null`) is not evidence the thread is unresolved — the
    // finding stays open, including when `threadsTruncated` is set.
    const thread = input.threads ? threadFor(f, input.threads, input.bot) : undefined;
    if (f.status === "open" && thread?.isResolved) {
      f.status = "resolved";
      f.closedAt = head;
      continue;
    }
    if (f.excerpt && input.excerptPresent(f.path, f.excerpt) === false) {
      f.status = "addressed";
      f.closedAt = head;
    }
  }

  const byFp = new Map(carried.map((f) => [f.fp, f]));
  const fresh: LedgerFinding[] = [];
  for (const row of input.dispositions) {
    const d = row.finding;
    if (!d.path) continue;
    const fp = findingFingerprint(d.path, d.existingCode, d.title);
    const known = byFp.get(fp);
    if (known && (known.status === "open" || known.status === "withheld")) {
      known.lastSeenAt = head;
      // Withheld last time, posted now: it is open from here on.
      if (known.status === "withheld" && POSTED.has(row.tier)) {
        known.status = "open";
        known.tier = row.tier;
        known.reason = row.reason;
      }
      continue;
    }
    const entry: LedgerFinding = {
      fp,
      path: d.path,
      line: typeof d.line === "number" ? d.line : null,
      excerpt: normaliseCode(d.existingCode ?? "").slice(0, MAX_EXCERPT),
      title: (d.title ?? "").slice(0, MAX_TITLE),
      severity: d.severity ?? null,
      importance: d.importance ?? null,
      tier: row.tier,
      reason: row.reason,
      status: POSTED.has(row.tier) ? "open" : "withheld",
      foundAt: head,
      lastSeenAt: head,
    };
    byFp.set(fp, entry);
    fresh.push(entry);
  }

  const { findings, truncated } = bound([...carried, ...fresh]);
  const units = (input.units ?? input.prior?.units ?? []).slice(0, MAX_LEDGER_UNITS);
  const lineSource = input.units ? (input.lines ?? null) : (input.prior?.lines ?? null);
  const lines = lineSource ? boundLines(lineSource) : null;
  return {
    version: REVIEW_LEDGER_VERSION,
    head,
    at: input.now ?? new Date().toISOString(),
    rounds: (input.prior?.rounds ?? 0) + 1,
    units,
    ...(lines ? { lines: lines.lines } : {}),
    findings,
    ...(truncated || lines?.truncated || (input.units?.length ?? 0) > MAX_LEDGER_UNITS ? { truncated: true } : {}),
  };
}

/** Keep the line hashes under {@link MAX_LEDGER_LINE_CHARS}, dropping the largest files first. */
function boundLines(lines: Record<string, string>): { lines: Record<string, string>; truncated: boolean } {
  const entries = Object.entries(lines);
  let total = entries.reduce((n, [, v]) => n + v.length, 0);
  if (total <= MAX_LEDGER_LINE_CHARS) return { lines, truncated: false };
  const kept = new Map(entries);
  for (const [path, v] of [...entries].sort((a, b) => b[1].length - a[1].length)) {
    if (total <= MAX_LEDGER_LINE_CHARS) break;
    kept.delete(path);
    total -= v.length;
  }
  return { lines: Object.fromEntries(kept), truncated: true };
}

const KEEP_ORDER: Record<LedgerStatus, number> = { open: 0, addressed: 1, resolved: 1, withheld: 2 };
const IMPORTANCE_ORDER: Record<string, number> = { "must-fix": 0, "worth-mentioning": 1, nit: 2 };

function bound(findings: LedgerFinding[]): { findings: LedgerFinding[]; truncated: boolean } {
  if (findings.length <= MAX_LEDGER_FINDINGS) return { findings, truncated: false };
  const ranked = findings
    .map((f, i) => ({ f, i }))
    .sort(
      (a, b) =>
        KEEP_ORDER[a.f.status] - KEEP_ORDER[b.f.status] ||
        (IMPORTANCE_ORDER[a.f.importance ?? ""] ?? 1) - (IMPORTANCE_ORDER[b.f.importance ?? ""] ?? 1) ||
        a.i - b.i,
    );
  const keep = new Set(ranked.slice(0, MAX_LEDGER_FINDINGS).map((r) => r.i));
  return { findings: findings.filter((_, i) => keep.has(i)), truncated: true };
}

/**
 * Open findings an EARLIER review posted — what a re-review must neither post
 * again nor call good to merge over.
 */
export function carriedOpen(ledger: ReviewLedger | null): LedgerFinding[] {
  return (ledger?.findings ?? []).filter((f) => f.status === "open" && isPosted(f));
}

/** The fingerprints of {@link carriedOpen} — `post-review`'s deterministic "already raised" test. */
export function openFingerprints(ledger: ReviewLedger | null): Set<string> {
  return new Set(carriedOpen(ledger).map((f) => f.fp));
}

/** `prior-review.json` for code-facts' `units --prior`, or `null` with nothing to compare. */
export function priorReviewOf(
  ledger: ReviewLedger | null,
): { version: 1; head: string | null; units: LedgerUnit[]; files?: Record<string, string> } | null {
  if (!ledger || ledger.units.length === 0) return null;
  return { version: 1, head: ledger.head, units: ledger.units, ...(ledger.lines ? { files: ledger.lines } : {}) };
}

function listTitles(fs: LedgerFinding[], max = 5): string {
  const shown = fs.slice(0, max).map((f) => `${f.title || "(untitled)"} (\`${f.path}\`)`);
  return `${shown.join("; ")}${fs.length > max ? `; and ${fs.length - max} more` : ""}`;
}

/**
 * The re-review status lines that open the posted summary, rendered in code:
 * what an earlier review posted that this head addressed or a maintainer
 * resolved, and what is still open. Only POSTED findings are named — a
 * withheld finding was never shown, so it is never "fixed" either. The line
 * prefixes are the ones `review-summary.ts`'s ledger grammar reads.
 */
export function renderLedgerStatus(ledger: ReviewLedger): string {
  const head = ledger.head;
  const closed = ledger.findings.filter((f) => isPosted(f) && (f.status === "addressed" || f.status === "resolved") && f.closedAt === head);
  const open = ledger.findings.filter((f) => isPosted(f) && f.status === "open" && f.foundAt !== head);
  const lines: string[] = [];
  if (closed.length) lines.push(`**Addressed since the last review:** ${listTitles(closed)}`);
  if (open.length) lines.push(`**Still open:** ${listTitles(open)}`);
  return lines.join("\n");
}

/**
 * The ledger as the `select` prompt sees it: what earlier reviews already
 * posted and is still open, so a site re-finding one of them marks it
 * `alreadyRaised` instead of posting it again. Withheld entries are listed
 * apart: they were never shown to the author, so re-raising one is a choice,
 * not a duplicate. Empty string when there is nothing to say.
 */
export function renderLedgerForSelect(ledger: ReviewLedger | null): string {
  if (!ledger) return "";
  const open = carriedOpen(ledger);
  const withheld = ledger.findings.filter((f) => f.status === "withheld");
  if (!open.length && !withheld.length) return "";
  const row = (f: LedgerFinding) =>
    `- \`${f.path}${f.line ? `:${f.line}` : ""}\` [${f.importance ?? f.severity ?? "?"}] ${f.title}${f.excerpt ? ` — quotes \`${f.excerpt.split("\n")[0]!.slice(0, 80)}\`` : ""}`;
  const parts = [];
  if (open.length) parts.push("Posted by an earlier review and still open:", ...open.slice(0, 30).map(row));
  if (withheld.length) parts.push("", "Found by an earlier review but never posted:", ...withheld.slice(0, 20).map(row));
  return parts.join("\n");
}
