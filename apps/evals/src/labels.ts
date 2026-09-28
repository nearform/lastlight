/**
 * Human grades for review findings — the label contract, the key rule, and
 * every number derived from labels. **Node-free** (like `phase-replay.ts`), so
 * the server that stores labels and the dashboard that shows the metrics
 * cannot disagree about a key or a figure. The fs half (scanning reports,
 * reading `findings.jsonl` and fixture excerpts, appending labels) is
 * `labels-node.ts`.
 *
 * Why this exists: gold is incomplete and the judge mis-matches (a credited
 * row was found, by hand, to assert something false). So the user grades every
 * finding the pipeline flags on two axes — REAL? (yes / no / unsure) ×
 * IMPORTANCE (must-fix / worth-mentioning / nit, meaningful only when real is
 * yes) — plus an optional "same as gold N" link and a short note. Arms are then
 * read on human precision and real-important findings, gold recall secondary.
 *
 * ## Storage
 *
 * `eval-results/labels/findings.jsonl`, append-only, one {@link FindingLabel}
 * per line; the LAST line for a key wins ({@link foldLabels}). A line with
 * `real: null` clears the grade. Every line carries the finding text it graded
 * and the time, so a label is auditable after the reports it came from are
 * gone, and a re-grade is history rather than an overwrite.
 *
 * ## The key rule
 *
 * `labelKey` = hash of:
 *   - the **PR**: the instance id with a trailing `-r<N>` stripped
 *     ({@link prIdentity}) — `prreview__skillspro-1587-r1/-r2/-r3` are re-runs
 *     of ONE PR at different heads, so one grade covers the same finding on all
 *     three. Deliberately NOT `repo#number` from `instances.json`: the key must
 *     not change with whether that file happens to be readable;
 *   - the **path**, verbatim;
 *   - a **line bucket**, `round(line / 7)` ({@link lineBucket}) — seven-line
 *     buckets centred on multiples of 7, i.e. ±3 of the centre. Fixed buckets
 *     have edges (lines 3 and 4 fall in different buckets), which is accepted:
 *     it only ever costs a re-grade, never a wrong label;
 *   - the **title + mechanism**, lowercased with whitespace collapsed
 *     ({@link normaliseText}).
 *
 * Trade-off: too TIGHT and a near-duplicate (the same defect reworded on the
 * next repeat, or shifted a few lines on the next PR revision) needs grading
 * again; too LOOSE and one label silently covers two different findings — a
 * false grade, which is the thing this whole exercise is meant to remove. The
 * rule errs tight on purpose: model text rarely repeats verbatim, so most
 * findings will be distinct keys, and {@link similarLabelled} surfaces graded
 * neighbours (same PR + path, lines within {@link SIMILAR_LINES}) so a
 * near-duplicate is a one-click copy, decided by the grader, never by the key.
 */

export const LABELS_DIR = "labels";
export const LABELS_FILE = "findings.jsonl";
export const LABEL_KEY_VERSION = 1;

export const REAL_VALUES = ["yes", "no", "unsure"] as const;
export const IMPORTANCE_VALUES = ["must-fix", "worth-mentioning", "nit"] as const;
export type RealGrade = (typeof REAL_VALUES)[number];
export type Importance = (typeof IMPORTANCE_VALUES)[number];

/** Lines either side within which a graded finding on the same PR + path is offered as "similar". */
export const SIMILAR_LINES = 10;
export const NOTE_MAX = 500;

/** "Same as gold N" — the gold is per INSTANCE (each re-run has its own gold set), so the link names it. */
export interface GoldLink {
  instanceId: string;
  /** 0-based index into that instance's gold. */
  index: number;
}

/** The finding text a label graded — stored on every line so it stays auditable. */
export interface LabelledFindingText {
  pr: string;
  path: string;
  line: number;
  title: string;
  mechanism: string;
  consequence: string;
}

/** One stored label line. */
export interface FindingLabel {
  key: string;
  /** `null` = cleared (a tombstone: the fold drops the key). */
  real: RealGrade | null;
  /** Only when `real === "yes"`; `null` otherwise or not yet chosen. */
  importance: Importance | null;
  gold: GoldLink | null;
  note: string | null;
  gradedAt: string;
  finding: LabelledFindingText;
}

/** What `POST /api/labels` accepts. */
export interface LabelInput {
  key: string;
  real: RealGrade | null;
  importance: Importance | null;
  gold: GoldLink | null;
  note: string | null;
}

// ── the key ─────────────────────────────────────────────────────────────────

/** `prreview__skillspro-1587-r2` → `prreview__skillspro-1587`. */
export function prIdentity(instanceId: string): string {
  return instanceId.replace(/-r\d+$/, "");
}

export function normaliseText(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function lineBucket(line: number): number {
  return Math.round(line / 7);
}

/** The exact string the key hashes — exposed so a test can pin the rule. */
export function labelKeyInput(f: { pr: string; path: string; line: number; title: string; mechanism: string }): string {
  return JSON.stringify([LABEL_KEY_VERSION, f.pr, f.path, lineBucket(f.line), normaliseText(f.title), normaliseText(f.mechanism)]);
}

/** cyrb53 — a small, stable, pure-JS 53-bit string hash (no `node:crypto`, so the browser shares it). */
function cyrb53(s: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/** `f1-` + 28 hex chars (two seeds of cyrb53). */
export function labelKey(f: { pr: string; path: string; line: number; title: string; mechanism: string }): string {
  const s = labelKeyInput(f);
  return `f${LABEL_KEY_VERSION}-${cyrb53(s, 1)}${cyrb53(s, 2)}`;
}

const KEY_RE = /^f\d+-[0-9a-f]{28}$/;

// ── validation + fold ───────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Validate a `POST /api/labels` body. `importance` is forced to `null` unless
 * `real === "yes"` (it means nothing otherwise); `real: null` clears the grade
 * and carries nothing else.
 */
export function validateLabelInput(raw: unknown): Validated<LabelInput> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "body must be a JSON object" };
  const r = raw as Record<string, unknown>;
  if (typeof r.key !== "string" || !KEY_RE.test(r.key)) return { ok: false, error: "key: expected a label key (f1-<28 hex>)" };
  const real = r.real ?? null;
  if (real !== null && !REAL_VALUES.includes(real as RealGrade)) return { ok: false, error: `real: expected one of ${REAL_VALUES.join(" / ")} or null` };
  if (real === null) return { ok: true, value: { key: r.key, real: null, importance: null, gold: null, note: null } };
  const importance = r.importance ?? null;
  if (importance !== null && !IMPORTANCE_VALUES.includes(importance as Importance))
    return { ok: false, error: `importance: expected one of ${IMPORTANCE_VALUES.join(" / ")} or null` };
  let gold: GoldLink | null = null;
  if (r.gold !== undefined && r.gold !== null) {
    const g = r.gold as Record<string, unknown>;
    if (typeof g !== "object" || typeof g.instanceId !== "string" || !g.instanceId || !Number.isInteger(g.index) || (g.index as number) < 0)
      return { ok: false, error: "gold: expected null or { instanceId: string, index: integer ≥ 0 }" };
    gold = { instanceId: g.instanceId, index: g.index as number };
  }
  let note: string | null = null;
  if (r.note !== undefined && r.note !== null) {
    if (typeof r.note !== "string") return { ok: false, error: "note: expected a string or null" };
    if (r.note.length > NOTE_MAX) return { ok: false, error: `note: at most ${NOTE_MAX} characters` };
    note = r.note.trim() || null;
  }
  return { ok: true, value: { key: r.key, real: real as RealGrade, importance: real === "yes" ? (importance as Importance | null) : null, gold, note } };
}

/** Parse `findings.jsonl` text into lines, skipping torn/malformed ones. */
export function parseLabelLines(text: string): FindingLabel[] {
  const out: FindingLabel[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const v = JSON.parse(raw) as FindingLabel;
      if (v && typeof v === "object" && typeof v.key === "string") out.push(v);
    } catch {
      /* a torn last line from a crashed append — skip it */
    }
  }
  return out;
}

/** Last write per key wins; a `real: null` line removes the key. */
export function foldLabels(lines: FindingLabel[]): Map<string, FindingLabel> {
  const m = new Map<string, FindingLabel>();
  for (const l of lines) {
    if (l.real === null) m.delete(l.key);
    else m.set(l.key, l);
  }
  return m;
}

// ── the findings the grade page lists ───────────────────────────────────────

export type FindingSource = "site-review";

/** One place a finding appeared (a report × case × site). */
export interface GradeAppearance {
  source: FindingSource;
  reportId: string;
  reportLabel: string;
  instanceId: string;
  /** The fixture's arm dir (`arm1`, `arm2`). */
  arm: string;
  repeat: number;
  site: string;
  /** `/data/…/full.jsonl`, or `null` when the report recorded none. */
  session: string | null;
  /** The judge's match for THIS appearance: gold index, `null` = none, absent = not judged. */
  judgeGold?: number | null;
}

export interface GradeGold {
  index: number;
  file?: string;
  line?: number;
  severity: string;
  summary: string;
  /** The full gold text, when `instances.json` was readable. */
  description?: string;
}

export interface CodeExcerpt {
  startLine: number;
  lines: string[];
}

/** A finding before dedup — one appearance plus its text. */
export interface RawFinding extends LabelledFindingText {
  strength: string;
  appearance: GradeAppearance;
  excerpt: CodeExcerpt | null;
  gold: GradeGold[];
}

export interface SimilarLabelled {
  key: string;
  line: number;
  title: string;
  label: FindingLabel;
}

/** One distinct finding (by label key), with every appearance. */
export interface GradeFinding extends LabelledFindingText {
  key: string;
  strength: string;
  appearances: GradeAppearance[];
  excerpt: CodeExcerpt | null;
  /** Gold per instance the finding appeared in (re-runs of a PR carry different gold). */
  gold: { instanceId: string; items: GradeGold[] }[];
  label: FindingLabel | null;
  similar: SimilarLabelled[];
  /** Machine proposals, one per grader (sorted by grader). NEVER a label: no metric reads them. */
  proposals: Proposal[];
}

export interface FindingsResponse {
  generatedAt: string;
  findings: GradeFinding[];
  /** Per grader: how its proposals compare with the human labels ({@link agreementMetrics}). */
  agreement: GraderAgreement[];
  /** Report findings whose full text (`findings.jsonl` beside the session) could not be read — not listed. */
  unreadable: number;
}

/**
 * Collapse raw findings to one per label key. The first appearance supplies the
 * text and the excerpt; appearances accumulate; gold is kept per instance.
 */
export function dedupFindings(
  raw: RawFinding[],
  labels: Map<string, FindingLabel> = new Map(),
  proposals: ProposalMap = new Map(),
): GradeFinding[] {
  const byKey = new Map<string, GradeFinding>();
  for (const r of raw) {
    const key = labelKey(r);
    let f = byKey.get(key);
    if (!f) {
      f = {
        key,
        pr: r.pr,
        path: r.path,
        line: r.line,
        title: r.title,
        mechanism: r.mechanism,
        consequence: r.consequence,
        strength: r.strength,
        appearances: [],
        excerpt: r.excerpt,
        gold: [],
        label: labels.get(key) ?? null,
        similar: [],
        proposals: proposalsFor(proposals, key),
      };
      byKey.set(key, f);
    }
    f.excerpt ??= r.excerpt;
    f.appearances.push(r.appearance);
    if (!f.gold.some((g) => g.instanceId === r.appearance.instanceId)) f.gold.push({ instanceId: r.appearance.instanceId, items: r.gold });
  }
  const out = [...byKey.values()];
  for (const f of out) f.similar = similarLabelled(f, out);
  return out;
}

/** Graded findings on the same PR + path within {@link SIMILAR_LINES} — offered, never applied. */
export function similarLabelled(f: Pick<GradeFinding, "key" | "pr" | "path" | "line">, all: GradeFinding[]): SimilarLabelled[] {
  return all
    .filter((o) => o.key !== f.key && o.label && o.pr === f.pr && o.path === f.path && Math.abs(o.line - f.line) <= SIMILAR_LINES)
    .sort((a, b) => Math.abs(a.line - f.line) - Math.abs(b.line - f.line))
    .slice(0, 3)
    .map((o) => ({ key: o.key, line: o.line, title: o.title, label: o.label! }));
}

// ── metrics ─────────────────────────────────────────────────────────────────

export interface GradedMetrics {
  /** The group — a report label (arm) by default. */
  group: string;
  /** Distinct findings (label keys) in the group. */
  findings: number;
  /** …with a grade (any `real`, `unsure` included). */
  graded: number;
  real: number;
  notReal: number;
  unsure: number;
  /** real AND must-fix or worth-mentioning. */
  realImportant: number;
  /** real ÷ graded (`unsure` counts in the denominator); `null` with nothing graded. */
  precision: number | null;
  /** Graded findings linked to a gold comment. */
  goldLinked: number;
}

/**
 * Per group (report label by default): how many distinct findings, how many
 * graded, and what the grades say. A finding counts once per group however
 * many repeats/sites it appeared in within that group.
 */
export function gradedMetrics(
  findings: Pick<GradeFinding, "key" | "appearances">[],
  labels: Map<string, Pick<FindingLabel, "real" | "importance" | "gold">>,
  groupOf: (a: GradeAppearance) => string = (a) => a.reportLabel,
): GradedMetrics[] {
  const keys = new Map<string, Set<string>>();
  for (const f of findings)
    for (const a of f.appearances) {
      const g = groupOf(a);
      if (!keys.has(g)) keys.set(g, new Set());
      keys.get(g)!.add(f.key);
    }
  return [...keys.entries()]
    .map(([group, ks]) => {
      const ls = [...ks].map((k) => labels.get(k)).filter((l): l is NonNullable<typeof l> => !!l && l.real !== null);
      const real = ls.filter((l) => l.real === "yes");
      return {
        group,
        findings: ks.size,
        graded: ls.length,
        real: real.length,
        notReal: ls.filter((l) => l.real === "no").length,
        unsure: ls.filter((l) => l.real === "unsure").length,
        realImportant: real.filter((l) => l.importance === "must-fix" || l.importance === "worth-mentioning").length,
        precision: ls.length ? real.length / ls.length : null,
        goldLinked: ls.filter((l) => l.gold !== null).length,
      };
    })
    .sort((a, b) => a.group.localeCompare(b.group));
}

/** The label map a findings response already carries. */
export function labelsOf(findings: Pick<GradeFinding, "key" | "label">[]): Map<string, FindingLabel> {
  const m = new Map<string, FindingLabel>();
  for (const f of findings) if (f.label) m.set(f.key, f.label);
  return m;
}

// ── machine proposals ───────────────────────────────────────────────────────
//
// A grader model (e.g. `fable`) proposes a grade per finding, appended to
// `eval-results/labels/proposals-<grader>.jsonl` — same shape as a label minus
// the note/finding snapshot, plus a `reason`. Proposals are SHOWN beside the
// human controls and compared with the human labels ({@link agreementMetrics});
// they are never a label and no human metric ({@link gradedMetrics}) reads
// them. A human may accept one, which POSTs it as their own label.

export const PROPOSALS_PREFIX = "proposals-";
export const PROPOSALS_SUFFIX = ".jsonl";

/** One machine proposal for one finding. */
export interface Proposal {
  grader: string;
  real: RealGrade;
  importance: Importance | null;
  gold: GoldLink | null;
  reason: string | null;
  gradedAt: string | null;
}

/** key → grader → proposal. */
export type ProposalMap = Map<string, Map<string, Proposal>>;

/** `proposals-fable.jsonl` → `fable`; `null` for any other name. */
export function graderOfFile(name: string): string | null {
  if (!name.startsWith(PROPOSALS_PREFIX) || !name.endsWith(PROPOSALS_SUFFIX)) return null;
  const g = name.slice(PROPOSALS_PREFIX.length, -PROPOSALS_SUFFIX.length);
  return g || null;
}

/**
 * Parse one proposals file. Torn/partial lines (the file may be mid-write) and
 * lines with an invalid `real`/`importance`/`gold` are skipped. The line's own
 * `grader` wins over the file name's. `real: null` is kept as a tombstone
 * (`real` is `null` only in the returned line list, never in a folded map).
 */
export function parseProposalLines(text: string, fileGrader: string): (Omit<Proposal, "real"> & { key: string; real: RealGrade | null })[] {
  const out: (Omit<Proposal, "real"> & { key: string; real: RealGrade | null })[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    let v: Record<string, unknown>;
    try {
      v = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.key !== "string") continue;
    const real = v.real ?? null;
    if (real !== null && !REAL_VALUES.includes(real as RealGrade)) continue;
    const importance = v.importance ?? null;
    if (importance !== null && !IMPORTANCE_VALUES.includes(importance as Importance)) continue;
    let gold: GoldLink | null = null;
    if (v.gold !== undefined && v.gold !== null) {
      const g = v.gold as Record<string, unknown>;
      if (typeof g !== "object" || typeof g.instanceId !== "string" || !Number.isInteger(g.index) || (g.index as number) < 0) continue;
      gold = { instanceId: g.instanceId, index: g.index as number };
    }
    out.push({
      key: v.key,
      grader: typeof v.grader === "string" && v.grader ? v.grader : fileGrader,
      real: real as RealGrade | null,
      importance: real === "yes" ? (importance as Importance | null) : null,
      gold: real === null ? null : gold,
      reason: typeof v.reason === "string" ? v.reason : null,
      gradedAt: typeof v.gradedAt === "string" ? v.gradedAt : null,
    });
  }
  return out;
}

/** Last write per (grader, key) wins; a `real: null` line removes that grader's proposal. */
export function foldProposals(lines: ReturnType<typeof parseProposalLines>, into: ProposalMap = new Map()): ProposalMap {
  for (const { key, ...p } of lines) {
    if (p.real === null) {
      into.get(key)?.delete(p.grader);
      continue;
    }
    if (!into.has(key)) into.set(key, new Map());
    into.get(key)!.set(p.grader, p as Proposal);
  }
  return into;
}

export function proposalsFor(m: ProposalMap, key: string): Proposal[] {
  return [...(m.get(key)?.values() ?? [])].sort((a, b) => a.grader.localeCompare(b.grader));
}

const sameGold = (a: GoldLink | null, b: GoldLink | null) => (a === null || b === null ? a === b : a.instanceId === b.instanceId && a.index === b.index);

/**
 * Does the human label agree with a proposal? `real` must match and, when both
 * say yes, so must `importance`. The gold link is NOT part of it (reported
 * separately as `goldAgree`) — the grade page's "disagrees" filter reads this.
 */
export function proposalAgrees(label: Pick<FindingLabel, "real" | "importance">, p: Pick<Proposal, "real" | "importance">): boolean {
  return label.real === p.real && (label.real !== "yes" || label.importance === p.importance);
}

/** rows = human, cols = grader, both in {@link REAL_VALUES} order. */
export type RealConfusion = number[][];

/**
 * Cohen's kappa over a square confusion matrix: (po − pe) ÷ (1 − pe).
 * `null` with no pairs, or when chance agreement is total (pe = 1: both sides
 * used one and the same category, so kappa is undefined).
 */
export function cohenKappa(m: RealConfusion): number | null {
  const n = m.reduce((s, r) => s + r.reduce((a, b) => a + b, 0), 0);
  if (!n) return null;
  const po = m.reduce((s, r, i) => s + r[i], 0) / n;
  let pe = 0;
  for (let i = 0; i < m.length; i++) {
    const row = m[i].reduce((a, b) => a + b, 0);
    const col = m.reduce((a, r) => a + r[i], 0);
    pe += (row / n) * (col / n);
  }
  return pe >= 1 ? null : (po - pe) / (1 - pe);
}

export interface GraderAgreement {
  grader: string;
  /** Proposals this grader made (on listed findings). */
  proposals: number;
  /** Findings with BOTH a human label and this grader's proposal. */
  n: number;
  /** Exact `real` agreement over the n. */
  realAgree: number;
  realAgreeRate: number | null;
  /** Cohen's kappa on real (yes / no / unsure). */
  kappa: number | null;
  /** Of the n, both said real = yes … */
  bothReal: number;
  /** … and chose the same importance (null counts as a value). */
  importanceAgree: number;
  importanceAgreeRate: number | null;
  /** Of `bothReal`, the same gold link (both none, or the same instance + index). */
  goldAgree: number;
  goldAgreeRate: number | null;
  /** human (rows) × grader (cols) over {@link REAL_VALUES}. */
  confusion: RealConfusion;
}

/**
 * Per grader, over findings that carry both a human label and that grader's
 * proposal. Reads only the two; the human label is the reference.
 */
export function agreementMetrics(findings: Pick<GradeFinding, "label" | "proposals">[]): GraderAgreement[] {
  const by = new Map<string, { proposals: number; pairs: [FindingLabel, Proposal][] }>();
  for (const f of findings)
    for (const p of f.proposals) {
      if (!by.has(p.grader)) by.set(p.grader, { proposals: 0, pairs: [] });
      const g = by.get(p.grader)!;
      g.proposals++;
      if (f.label && f.label.real !== null) g.pairs.push([f.label, p]);
    }
  const rate = (a: number, b: number) => (b ? a / b : null);
  return [...by.entries()]
    .map(([grader, { proposals, pairs }]) => {
      const confusion = REAL_VALUES.map(() => REAL_VALUES.map(() => 0));
      for (const [l, p] of pairs) confusion[REAL_VALUES.indexOf(l.real!)][REAL_VALUES.indexOf(p.real)]++;
      const realAgree = pairs.filter(([l, p]) => l.real === p.real).length;
      const both = pairs.filter(([l, p]) => l.real === "yes" && p.real === "yes");
      const importanceAgree = both.filter(([l, p]) => l.importance === p.importance).length;
      const goldAgree = both.filter(([l, p]) => sameGold(l.gold, p.gold)).length;
      return {
        grader,
        proposals,
        n: pairs.length,
        realAgree,
        realAgreeRate: rate(realAgree, pairs.length),
        kappa: cohenKappa(confusion),
        bothReal: both.length,
        importanceAgree,
        importanceAgreeRate: rate(importanceAgree, both.length),
        goldAgree,
        goldAgreeRate: rate(goldAgree, both.length),
        confusion,
      };
    })
    .sort((a, b) => a.grader.localeCompare(b.grader));
}
