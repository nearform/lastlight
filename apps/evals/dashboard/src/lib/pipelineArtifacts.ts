/**
 * Read the evidence pipeline's own artifacts — the documents behind the
 * per-family funnel — and join them into one per-case drill-down.
 *
 * Until `persistPipelineArtifacts()` shipped, these files lived in a `$TMPDIR`
 * workspace the OS reaped: on 2026-09-21, 216 of 237 recorded workspace paths
 * still resolved and **not one** still held a file. They are now copied into the
 * run's own directory at `results[].pipelineArtifactRel`, and `/data/*` serves
 * the run directory verbatim — so this module is the first consumer that can
 * read them in a browser.
 *
 * **It is a deliberate second implementation of the harness's reader**
 * (`../../src/review-pipeline-stats.ts`), not an import: that module opens with
 * `node:fs` and cannot be pulled into a browser bundle. The three rules where a
 * silent disagreement would be invisible are therefore mirrored *exactly*, and
 * `pipelineArtifacts.test.ts` pins each of them:
 *
 * 1. **Identity is POSITIONAL** — `<family>-NNN` from the FILENAME plus append
 *    order, never the model-declared `id` (which is an alias at best and a
 *    collision at worst). `say-gap.ts`, `finding-calibration.ts` and
 *    `deletion-risk.ts` all derive it this way; a reader that used the declared
 *    id would join findings to the wrong claims and report it as fact.
 * 2. **A line that does not parse consumes no ordinal**; a line that parses to a
 *    scalar or array does. Getting that backwards shifts every later row's id.
 * 3. **The findings ↔ disposition join is `path + title`, never `line`** — the
 *    boundary re-anchors a finding to a line GitHub can hang a comment on, so
 *    keying on the line lost 10 of 32 findings on a measured case, and a failed
 *    join looks exactly like a finding that was never tiered.
 *
 * Everything here is pure: parsed JSON and raw text in, a plain object out. The
 * fetching lives in `./api.ts` and the rendering in
 * `../components/FamilyDrilldown.tsx`.
 */

// ── The documents, as they are on disk ─────────────────────────────────────

/** `obligations.json` — the seeded question set. */
export interface ObligationsDoc {
  coverage?: "full" | "degraded" | "none";
  contract?: string;
  degraded?: { extractor?: string; reason?: string }[];
  families?: {
    family: string;
    obligations?: number;
    minted?: number;
    cap?: number | null;
    measured?: boolean;
    notMeasuredReason?: string | null;
  }[];
  obligations?: {
    id?: string;
    family?: string;
    question?: string;
    mechanism?: string;
    rank?: number;
    discharge?: string;
    introducedAt?: { path?: string; line?: number; quote?: string };
    enforcedAt?: { candidates?: string[]; found?: boolean };
  }[];
  /**
   * What the seeder refused, as `{reason, count}` — **run-wide, and NOT
   * per-obligation**. There is no dropped obligation TEXT anywhere on disk and
   * no `family` field on the entry; see {@link splitDropped}.
   */
  dropped?: { reason?: string; count?: number }[];
}

/** One finding as `findings.json` / `disposition.json` carry it. */
export interface RawFinding {
  title?: string;
  body?: string;
  path?: string;
  line?: number;
  family?: string;
  severity?: string;
  confidence?: number;
  hypotheses?: string[];
  obligation?: string;
}

export interface FindingsDoc {
  findings?: RawFinding[];
  /** The `falsify` phase's deletions — a hypothesis refuted by a probe. */
  dropped?: { hypothesis?: string; reason?: string; refutedBy?: string }[];
}

export interface DispositionDoc {
  findings?: { tier?: string; reason?: string | null; finding?: RawFinding }[];
}

// ── Hypothesis rows ────────────────────────────────────────────────────────

export const DISCHARGE_CODES = ["QUOTE", "ABSENT", "PARTIAL", "PROBE", "bad-code", "none"] as const;
export type DischargeCode = (typeof DISCHARGE_CODES)[number];

const VALID_CODES = new Set(["QUOTE", "ABSENT", "PARTIAL", "PROBE"]);

/**
 * A row's discharge code — `discharge` **or** `status`, case-insensitively,
 * mirroring `codeOf` in code-facts' `discharge.ts`.
 *
 * Deliberately does NOT read `verdict`: the `spec` pass invented a row shape
 * carrying `verdict`/`rationale`, and the harness's reader does not count those
 * as discharged either. Reading it here would make the dashboard disagree with
 * every number already published.
 *
 * A string that is not one of the four is `bad-code`, never `none` — a row that
 * wrote nothing and a row that wrote a code nobody defined are different
 * failures. That includes `notMeasured`, which is a status, not a discharge.
 */
export function dischargeOf(row: Record<string, unknown>): DischargeCode {
  const raw = row.discharge ?? row.status;
  if (typeof raw !== "string" || !raw.trim()) return "none";
  const upper = raw.trim().toUpperCase();
  return VALID_CODES.has(upper) ? (upper as DischargeCode) : "bad-code";
}

/** The single line a DEAD family writes into its jsonl — a tombstone, not a
 * hypothesis. It still consumes an ordinal (identity must not shift). */
export function isNotMeasuredMarker(row: Record<string, unknown>): boolean {
  return typeof row.status === "string" && row.status.trim().toLowerCase() === "notmeasured";
}

/**
 * `failureScenario` is a THREE-state field and collapsing it to a boolean is
 * how 37 preserved rows came to be scored as anti-findings:
 *
 * - `null` — the pass looked and found the line *fine*. With `QUOTE` that is a
 *   clean discharge, i.e. an anti-finding: it cannot match gold by construction.
 * - `present` — it carries a scenario, so it is a live claim.
 * - `absent` — the key does not exist. Carries **no information**: under the
 *   pre-2026-08-23 contract the field did not exist at all.
 */
export type FailureScenarioState = "present" | "null" | "absent";

export function failureScenarioState(row: Record<string, unknown>): FailureScenarioState {
  if (!("failureScenario" in row)) return "absent";
  return row.failureScenario === null ? "null" : "present";
}

/** `QUOTE` **and** `failureScenario` present and explicitly `null`. The
 * strictness is the point — the attention boundary keys on exactly this. */
export function isCleanDischarge(row: Record<string, unknown>): boolean {
  return dischargeOf(row) === "QUOTE" && failureScenarioState(row) === "null";
}

/** `<family>-NNN` — the identity code-facts assigns at ingest. */
export function hypothesisId(family: string, ordinal: number): string {
  return `${family}-${String(ordinal).padStart(3, "0")}`;
}

/**
 * Split a `.jsonl` into rows — a copy of code-facts' `parseJsonl`
 * (`packages/code-facts/src/jsonl.ts`), which this package cannot import.
 * Ordinals are identity, so it must accept exactly the rows that does: a line
 * that parses on its own (object or not), or a pretty-printed / run-together
 * value recovered by a brace-balanced scan. An unreadable line consumes no
 * ordinal. Keep the two in step.
 */
export function parseJsonlRows(text: string): unknown[] {
  const rows: unknown[] = [];
  let pos = 0;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 ? text.length : newline;
    const raw = text.slice(pos, lineEnd);
    const line = raw.trim();
    if (!line) {
      pos = lineEnd + 1;
      continue;
    }
    try {
      rows.push(JSON.parse(line) as unknown);
      pos = lineEnd + 1;
      continue;
    } catch {
      /* not a row on its own — try it as the start of a span */
    }
    const start = pos + raw.length - raw.trimStart().length;
    const end = text[start] === "{" || text[start] === "[" ? closingIndex(text, start) : -1;
    if (end !== -1) {
      try {
        rows.push(JSON.parse(text.slice(start, end)) as unknown);
        pos = end;
        continue;
      } catch {
        /* balanced but not JSON */
      }
    }
    pos = lineEnd + 1; // unreadable: consumes no ordinal, and never the next line
  }
  return rows;
}

/** Where the value opening at `start` closes, or -1 if the text ends first. */
function closingIndex(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const asRecord = (row: unknown): Record<string, unknown> =>
  row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};

/** One hypothesis, as the drill-down shows it. */
export interface HypothesisRow {
  /** Canonical, POSITIONAL id — filename family + 1-based append order. */
  id: string;
  ordinal: number;
  /** The row's own `claim`, or the `spec` shape's `rationale`. Empty when the
   * row carries neither (still a row — it holds its ordinal). */
  claim: string;
  /** Where the row says it looked: `bothEnds`, then `quotes`, then `path:line`. */
  anchors: string[];
  /** Verbatim quoted lines, when the row carried any. */
  quotes: { path?: string; line?: number; text?: string }[];
  discharge: DischargeCode;
  failureScenario: FailureScenarioState;
  /** The text of the scenario, when present. */
  failureScenarioText?: string;
  cleanDischarge: boolean;
  confidence?: number;
  severity?: string;
  /** The obligation the row says it answers (`O-001`, or `S-1` for `spec`). */
  obligation?: string;
  /** The model's own `id` field, kept only to be shown as an alias. Never the
   * identity: a row declaring `contract-001` from third position must not
   * capture citations meant for the real first row. */
  declaredId?: string;
  /** This is the dead-family tombstone, not a hypothesis. */
  notMeasuredMarker: boolean;
}

function textOf(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = row[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return undefined;
}

function anchorsOf(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  const ends = asRecord(row.bothEnds);
  for (const k of ["introducedAt", "enforcedAt"]) {
    const v = ends[k];
    if (typeof v === "string" && v.trim()) out.push(`${k}: ${v}`);
  }
  const quotes = Array.isArray(row.quotes) ? row.quotes : [];
  for (const q of quotes) {
    const r = asRecord(q);
    if (typeof r.path === "string") out.push(`${r.path}${typeof r.line === "number" ? `:${r.line}` : ""}`);
  }
  // The `spec` shape carries a bare path/line instead.
  if (!out.length && typeof row.path === "string")
    out.push(`${row.path}${typeof row.line === "number" ? `:${row.line}` : ""}`);
  return [...new Set(out)];
}

/** Parse one `hypotheses/<family>.jsonl`. `family` comes from the FILENAME,
 * never from the row — a pass that mislabels its own rows must not be able to
 * move another family's funnel. */
export function parseHypotheses(family: string, text: string): HypothesisRow[] {
  return parseJsonlRows(text).map((raw, index) => {
    const row = asRecord(raw);
    const declared = typeof row.id === "string" ? row.id : undefined;
    const id = hypothesisId(family, index + 1);
    const fs = failureScenarioState(row);
    return {
      id,
      ordinal: index + 1,
      claim: textOf(row, "claim", "rationale", "reason") ?? "",
      anchors: anchorsOf(row),
      quotes: (Array.isArray(row.quotes) ? row.quotes : []).map((q) => {
        const r = asRecord(q);
        return {
          path: typeof r.path === "string" ? r.path : undefined,
          line: typeof r.line === "number" ? r.line : undefined,
          text: typeof r.text === "string" ? r.text : undefined,
        };
      }),
      discharge: dischargeOf(row),
      failureScenario: fs,
      ...(fs === "present" && typeof row.failureScenario === "string"
        ? { failureScenarioText: row.failureScenario }
        : {}),
      cleanDischarge: isCleanDischarge(row),
      ...(typeof row.confidence === "number" ? { confidence: row.confidence } : {}),
      ...(typeof row.severity === "string" ? { severity: row.severity } : {}),
      ...(typeof row.obligation === "string" ? { obligation: row.obligation } : {}),
      ...(declared && declared !== id ? { declaredId: declared } : {}),
      notMeasuredMarker: isNotMeasuredMarker(row),
    };
  });
}

/**
 * Resolve a citation the way the ledger the adjudicator read resolved it: a
 * canonical id wins outright; a model-declared id is honoured as an alias only
 * when it shadows no canonical id and exactly one row declared it.
 *
 * Scoped to the rows handed in — the drill-down fetches one family at a time,
 * so a finding citing another family's row resolves to `undefined` here and is
 * rendered as a cross-family citation rather than as a broken one.
 */
export function citationResolver(rows: HypothesisRow[]): (cited: string) => string | undefined {
  const canonical = new Set(rows.map((r) => r.id));
  const claims = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.declaredId) continue;
    claims.set(r.declaredId, [...(claims.get(r.declaredId) ?? []), r.id]);
  }
  const aliases = new Map<string, string>();
  for (const [declared, by] of claims) {
    if (canonical.has(declared) || by.length !== 1) continue;
    aliases.set(declared, by[0]);
  }
  return (cited: string) => (canonical.has(cited) ? cited : aliases.get(cited));
}

/**
 * Identity of a finding across `findings.json` and `disposition.json`.
 * **`line` is deliberately excluded** — see the module header.
 */
export function findingKey(f: { path?: string; title?: string }): string {
  return `${f.path ?? ""} ${f.title ?? ""}`;
}

// ── The joined drill-down ──────────────────────────────────────────────────

export interface DrilldownFinding {
  title: string;
  body?: string;
  path?: string;
  line?: number;
  severity?: string;
  confidence?: number;
  /** `inline` / `body` / `internal` — absent when the `path + title` join found
   * no disposition row for it. */
  tier?: string;
  /** The boundary's machine token, `null` on an inline row never demoted.
   * Present only where the join landed: an absent reason and a finding the
   * boundary never saw must not read the same. */
  reason?: string | null;
  /** Did the join land? `false` with a disposition document present means the
   * boundary never saw this finding — a real fact, not a rendering gap. */
  joined: boolean;
  /** The citations as written. */
  cited: string[];
  /** Canonical ids of this family's rows it resolved to. */
  resolved: string[];
  /** Citations that resolved to nothing in this family's file. */
  unresolved: string[];
}

export interface DrilldownHypothesis extends HypothesisRow {
  /** Indexes into {@link FamilyDrilldown.findings} that cite this row. */
  findings: number[];
}

/** `{reason, count}` as the seeder wrote it, plus whether its prose names this
 * family. See {@link splitDropped}. */
export interface DroppedReason {
  reason: string;
  count: number;
}

export interface FamilyDrilldown {
  family: string;
  /** `families[].measured === false` — the seeding surface was absent, or (for
   * `spec`) could not be COUNTED. Two different claims in one field. */
  declaredMeasured?: boolean;
  /**
   * The family is dead: it declared `measured: false` **and** its survey
   * produced no live row. Deferred exactly as the harness defers it — `spec`
   * declares `measured: false` and still runs, so marking it here on the
   * declaration alone reported a working instrument as a dead one.
   */
  notMeasured: boolean;
  notMeasuredReason?: string | null;
  /** `families[].obligations`. **Absent means unknown, never 0** — code-facts
   * writes `measured: false` for `spec` to mean "I cannot see the PR body". */
  obligationCount?: number;
  minted?: number;
  cap?: number | null;
  /** `minted − obligations`: how many of this family's own questions its own
   * ceiling refused. The first-class truncation number — `dropped[]` reasons
   * are prose. Absent when either input is. */
  cappedOut?: number;
  /** The seeded questions that SURVIVED, for this family. */
  obligations: NonNullable<ObligationsDoc["obligations"]>;
  /** `dropped[]` entries whose prose names this family. */
  droppedNamingFamily: DroppedReason[];
  /** `dropped[]` entries that name no family — run-wide, unattributable. */
  droppedRunWide: DroppedReason[];
  /** Was there a `hypotheses/<family>.jsonl` at all? `false` ⇒ the survey never
   * ran; an empty array with `true` ⇒ it ran and produced nothing. */
  hypothesesFilePresent: boolean;
  hypotheses: DrilldownHypothesis[];
  /** Findings attributed to this family, or citing one of its rows. */
  findings: DrilldownFinding[];
  /**
   * Was there a `findings.json` at all? `false` ⇒ the adjudicator never ran or
   * never wrote, so **nothing is known** about what became of the hypotheses —
   * every row then looks orphaned, and reporting that as the conservation
   * alarm would turn a run that died after `survey` into a false finding.
   */
  findingsPresent: boolean;
  /** Was there a `disposition.json`? `false` ⇒ nothing knows where anything
   * went, and every `tier` is unknown rather than internal. */
  dispositionPresent: boolean;
  /** Canonical ids no finding cites. The conservation floor is supposed to make
   * this empty; a non-empty one is itself the finding. */
  orphanHypotheses: string[];
  /** Family findings citing no hypothesis at all. */
  unprovenanced: number;
}

/**
 * Split the run-wide `dropped[]` into "names this family" and "does not".
 *
 * **This is a prose join and it is admitted as one in the UI.** `DroppedReason`
 * is `{reason, count}`: there is no `family` field and no dropped-obligation
 * text anywhere on disk, so "show the question nobody asked" is not answerable
 * from the artifacts — only "how many, and why". code-facts added
 * `families[].minted` precisely so the per-family count would not have to be
 * recovered by parsing a reason string; {@link FamilyDrilldown.cappedOut} is
 * that number, and this split is only a convenience on top of it.
 */
export function splitDropped(
  dropped: ObligationsDoc["dropped"],
  family: string,
  knownFamilies: string[],
): { naming: DroppedReason[]; runWide: DroppedReason[] } {
  const naming: DroppedReason[] = [];
  const runWide: DroppedReason[] = [];
  for (const d of dropped ?? []) {
    const entry = { reason: d.reason ?? "unknown", count: d.count ?? 0 };
    const names = (f: string) => new RegExp(`\\b${f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(entry.reason);
    if (names(family)) naming.push(entry);
    else if (!knownFamilies.some(names)) runWide.push(entry);
    // else: it names a DIFFERENT family — not ours, and not run-wide either.
  }
  return { naming, runWide };
}

export interface DrilldownInput {
  family: string;
  obligations?: ObligationsDoc;
  findings?: FindingsDoc;
  disposition?: DispositionDoc;
  /** Raw text of `hypotheses/<family>.jsonl`, or `undefined` when the file is
   * not there — which is a different fact from an empty file. */
  hypothesesText?: string;
}

/**
 * Join one family's four documents into the drill-down the UI renders.
 *
 * Absent inputs stay absent: this never fills a count in from a sibling
 * document. A missing `disposition.json` leaves every `tier` unknown rather
 * than defaulting findings to `internal` (one measured case, `1587-r3`, wrote no
 * disposition at all while posting nine findings).
 */
export function buildFamilyDrilldown(input: DrilldownInput): FamilyDrilldown {
  const { family } = input;
  const famStat = input.obligations?.families?.find((f) => f.family === family);
  const knownFamilies = (input.obligations?.families ?? []).map((f) => f.family);

  const hypothesesFilePresent = input.hypothesesText !== undefined;
  const parsed = hypothesesFilePresent ? parseHypotheses(family, input.hypothesesText as string) : [];
  const liveRows = parsed.filter((h) => !h.notMeasuredMarker).length;
  const resolve = citationResolver(parsed);

  // Where the boundary put each finding. Keyed on `path + title`, never `line`.
  const dispositionRows = input.disposition?.findings ?? [];
  const tierOf = new Map<string, string>();
  const reasonOf = new Map<string, string | null>();
  for (const d of dispositionRows) {
    const f = d.finding;
    if (!f?.title || !d.tier) continue;
    tierOf.set(findingKey(f), d.tier);
    reasonOf.set(findingKey(f), d.reason ?? null);
  }

  const canonical = new Set(parsed.map((h) => h.id));
  const cites = new Map<string, number[]>();
  const findings: DrilldownFinding[] = [];
  let unprovenanced = 0;

  for (const f of input.findings?.findings ?? []) {
    const cited = f.hypotheses ?? [];
    const resolved = [...new Set(cited.map(resolve).filter((id): id is string => !!id))];
    // A finding belongs in this family's drill-down if it says so, or if it was
    // built from one of this family's rows. The second case matters: the
    // adjudicator can merge rows across families, and a finding filed under
    // another family while citing ours is still what became of our hypothesis.
    if (f.family !== family && !resolved.length) continue;
    if (!cited.length) {
      if (f.family === family) unprovenanced++;
    }
    const key = findingKey(f);
    const tier = tierOf.get(key);
    const index = findings.length;
    findings.push({
      title: f.title ?? "",
      ...(f.body !== undefined ? { body: f.body } : {}),
      ...(f.path !== undefined ? { path: f.path } : {}),
      ...(f.line !== undefined ? { line: f.line } : {}),
      ...(f.severity !== undefined ? { severity: f.severity } : {}),
      ...(f.confidence !== undefined ? { confidence: f.confidence } : {}),
      ...(tier !== undefined ? { tier, reason: reasonOf.get(key) ?? null } : {}),
      joined: tier !== undefined,
      cited,
      resolved,
      unresolved: cited.filter((c) => !canonical.has(c) && !resolve(c)),
    });
    for (const id of resolved) cites.set(id, [...(cites.get(id) ?? []), index]);
  }

  const hypotheses: DrilldownHypothesis[] = parsed.map((h) => ({ ...h, findings: cites.get(h.id) ?? [] }));
  const { naming, runWide } = splitDropped(input.obligations?.dropped, family, knownFamilies);

  return {
    family,
    ...(famStat?.measured !== undefined ? { declaredMeasured: famStat.measured } : {}),
    // The deferred rule, mirrored: declared unmeasured AND no live row.
    notMeasured: famStat?.measured === false && liveRows === 0,
    ...(famStat?.notMeasuredReason !== undefined ? { notMeasuredReason: famStat.notMeasuredReason } : {}),
    ...(famStat?.obligations !== undefined ? { obligationCount: famStat.obligations } : {}),
    ...(famStat?.minted !== undefined ? { minted: famStat.minted } : {}),
    ...(famStat?.cap !== undefined ? { cap: famStat.cap } : {}),
    ...(famStat?.minted !== undefined && famStat.obligations !== undefined
      ? { cappedOut: famStat.minted - famStat.obligations }
      : {}),
    obligations: (input.obligations?.obligations ?? []).filter((o) => o.family === family),
    droppedNamingFamily: naming,
    droppedRunWide: runWide,
    hypothesesFilePresent,
    hypotheses,
    findings,
    findingsPresent: input.findings !== undefined,
    dispositionPresent: dispositionRows.length > 0,
    orphanHypotheses: hypotheses.filter((h) => !h.notMeasuredMarker && !h.findings.length).map((h) => h.id),
    unprovenanced,
  };
}
