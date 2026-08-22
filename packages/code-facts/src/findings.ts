/**
 * `findings` — the `adjudicate` loop's exit gate, and the conservation check.
 *
 * WP6c (`docs/plans/review-evidence-pipeline/06-adjudicate.md` §"The phase").
 * It answers one question: **did every hypothesis the surveys produced reach
 * `findings.json` with exactly one recorded disposition, and is every deletion
 * backed by a probe transcript that exists?**
 *
 * ── Why existence-plus-schema was not enough ─────────────────────────────────
 *
 * §D11 is blunt about it: *"An adjudicator reading 30 hypotheses and writing 6
 * findings would have passed every gate in this plan — which is exactly v2,
 * which worked mechanically and cost recall anyway."* v2's ruthless judge moved
 * micro-recall 1/25 → 2/25 while the precision canary regressed and cost went
 * 2.4×; BitsAI-CR's ReviewFilter reproduced the same trade independently
 * (precision 54.5 → 67.1, recall 45.5 → 39.8). A unit test can check the
 * plumbing. It cannot check a model's compliance. This can, because silent
 * omission stops being possible by construction rather than by instruction.
 *
 * ── The asymmetry, mechanised ────────────────────────────────────────────────
 *
 * The adjudicator *"may re-rank, re-tier, and demote a finding into the review
 * body. It may delete a finding only when a probe transcript refutes it."*
 * Demotion is not suppression — `post-review` still renders a `body`-tier
 * finding under *"Additional findings"*, so it is posted and visible. Deletion
 * is the one move that costs recall outright, so it is the one move that has to
 * show its working: a `dropped` entry names `refutedBy`, and that file has to be
 * on disk. A refutation by argument is exactly the intervention this whole
 * pipeline is a reaction to.
 *
 * ── `--repair`: the §D12 FLOOR, and what makes this a mechanism ─────────────
 *
 * A gate that can only fail is a gate that eventually takes a run down —
 * `cron-review.yaml` re-dispatches every thirty minutes and a phase that never
 * closes burns the budget forever. So the last iteration runs with `--repair`:
 * every uncovered hypothesis is APPENDED at `tier: "internal"` (recorded, never
 * posted), and every unbacked deletion is **un-deleted** — removed from
 * `dropped` and promoted back to an internal finding. An unjustified deletion
 * becomes a recorded non-deletion. That is the asymmetry of this work package
 * expressed as code, and it is why the floor can never be reached by simply
 * dropping everything.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It reads no transcript, judges no verdict, and validates no quote. Candidate
 * v3's gate was an existence check and earned the investigation's only gold
 * match; v2's full quote validator was overkill and is what made it expensive.
 * Quote *resolution* stays checked upstream; quote *semantics* stays unchecked.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { noopLogger, type LoggerPort } from "./log.js";
import { readJsonl } from "./probes.js";
import { FindingsDocumentSchema } from "./schema.js";

/**
 * A hypothesis line, as far as THIS gate cares — the fields it has to carry
 * forward when the floor records one. Everything else is ignored.
 */
interface HypothesisRow {
  id?: unknown;
  family?: unknown;
  obligation?: unknown;
  claim?: unknown;
  existingCode?: unknown;
  severity?: unknown;
  confidence?: unknown;
  path?: unknown;
  bothEnds?: unknown;
}

export type FindingsGapKind =
  /** In no `findings[].hypotheses` and no `dropped[]`. Silent omission. */
  | "uncovered"
  /** Two dispositions — two findings, or a finding AND a drop. */
  | "duplicate"
  /** Deleted with no transcript, or naming one that is not on disk. */
  | "unbacked-drop"
  /** An id no `hypotheses/*.jsonl` ever declared. */
  | "fabricated";

export interface FindingsGap {
  kind: FindingsGapKind;
  hypothesis: string;
  detail: string;
}

/** What the §D12 floor did, one entry per hypothesis it had to rescue. */
export interface RepairAction {
  /** `recorded` — uncovered → internal. `promoted` — unbacked drop → internal.
   * `withdrawn` — unbacked drop whose hypothesis a finding already carries, so
   * the drop is removed and nothing is appended. */
  kind: "recorded" | "promoted" | "withdrawn";
  hypothesis: string;
  detail: string;
}

export interface CheckFindingsResult {
  /** Every id across `hypotheses/*.jsonl`, sorted. */
  hypotheses: string[];
  /** Of those, the ones with exactly one disposition. */
  covered: string[];
  /** Findings by tier, `(untiered)` for one that names none. */
  byTier: Record<string, number>;
  /** How many `dropped[]` entries survive (post-repair, when repairing). */
  dropped: number;
  gaps: FindingsGap[];
  /** Lines that were not JSON at all, counted rather than silently skipped. */
  malformed: number;
  /**
   * Why `findings.json` could not be read. `null` = it read fine. This is NOT a
   * per-hypothesis gap, and it fails the gate on its own: the loop should get
   * another iteration to write one.
   */
  documentError: string | null;
  /** True ⇒ the loop may stop. */
  satisfied: boolean;
  /** Non-empty only under `--repair`. */
  repaired: RepairAction[];
  /** One line per interesting fact, for the phase log. */
  notes: string[];
}

export interface CheckFindingsOptions {
  /** The `.lastlight/pr-review` directory. */
  dir: string;
  /**
   * What a `refutedBy` path is relative to when it is not `dir`-relative.
   * Defaults to the cwd, which is the repo root in the phase this runs in — the
   * `falsify` prompt asks for a repo-relative transcript path
   * (`.lastlight/pr-review/probes/H-001.txt`) and an adjudicator that copies a
   * `dir`-relative one (`probes/H-001.txt`) is being helpful rather than wrong,
   * so both resolve. Same forgiveness as the `probes` gate, for the same reason.
   */
  repo?: string;
  /**
   * The §D12 floor. Rewrites `findings.json` so that conservation HOLDS, and
   * reports what it had to do. Idempotent: a second run finds nothing to fix.
   */
  repair?: boolean;
  log?: LoggerPort;
}

/** How many offending ids the summary names before it starts counting. */
const MAX_LISTED = 20;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * `path:line` → `path`. The hypothesis contract carries the defect site in
 * `bothEnds.introducedAt`, and an internal-tier finding with no `path` is a
 * record nobody can navigate back to.
 */
function pathOf(row: HypothesisRow): string | null {
  const direct = asString(row.path);
  if (direct) return direct;
  const ends = row.bothEnds;
  if (typeof ends !== "object" || ends === null) return null;
  const site = asString((ends as { introducedAt?: unknown }).introducedAt);
  if (!site) return null;
  const colon = site.lastIndexOf(":");
  if (colon <= 0) return site;
  return /^\d+$/.test(site.slice(colon + 1)) ? site.slice(0, colon) : site;
}

/** A claim is a sentence; a title is a label. Take the first, bound the length. */
export function titleFrom(claim: string): string {
  const flat = claim.replace(/\s+/g, " ").trim();
  const stop = flat.search(/[.;](\s|$)/);
  const first = stop > 0 ? flat.slice(0, stop) : flat;
  return first.length > 100 ? `${first.slice(0, 99)}…` : first;
}

/**
 * The record the floor writes. `tier: "internal"` is the whole point: it is
 * kept and auditable, and it is never posted — the difference between an
 * attention boundary and v2's suppressor.
 */
function internalFinding(
  id: string,
  row: HypothesisRow | undefined,
  fallbackBody: string,
): Record<string, unknown> {
  const claim = row ? asString(row.claim) : null;
  const path = row ? pathOf(row) : null;
  const existingCode = row ? asString(row.existingCode) : null;
  const severity = (row ? asString(row.severity) : null) ?? "Important";
  const family = row ? asString(row.family) : null;
  const obligation = row ? asString(row.obligation) : null;
  const confidence = row && typeof row.confidence === "number" ? row.confidence : null;

  const finding: Record<string, unknown> = {};
  if (path) finding.path = path;
  if (existingCode) finding.existingCode = existingCode;
  finding.severity = severity;
  finding.title = claim ? titleFrom(claim) : `Unadjudicated hypothesis ${id}`;
  finding.body = claim ?? fallbackBody;
  if (family) finding.family = family;
  if (obligation) finding.obligation = obligation;
  if (confidence !== null) finding.confidence = confidence;
  finding.tier = "internal";
  finding.hypotheses = [id];
  return finding;
}

/** Every hypothesis id the surveys wrote, in the order the files declare them. */
function readHypotheses(dir: string): {
  rows: Map<string, HypothesisRow>;
  families: string[];
  malformed: number;
} {
  const hypothesesDir = join(dir, "hypotheses");
  const families = existsSync(hypothesesDir)
    ? readdirSync(hypothesesDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
    : [];
  const rows = new Map<string, HypothesisRow>();
  let malformed = 0;
  for (const file of families) {
    const parsed = readJsonl<HypothesisRow>(join(hypothesesDir, file));
    malformed += parsed.malformed;
    for (const row of parsed.rows) {
      const id = asString(row.id);
      // FIRST write wins. The file is append-only and six passes write six
      // different files, so a repeated id is a re-statement rather than a
      // revision — and either way the id has to be conserved exactly once.
      if (id && !rows.has(id)) rows.set(id, row);
    }
  }
  return { rows, families, malformed };
}

/** Does `refutedBy` name a file that is actually there? THE rule, mechanised. */
function transcriptExists(ref: string | null, dir: string, repo: string): boolean {
  if (!ref) return false;
  return existsSync(resolve(dir, ref)) || existsSync(resolve(repo, ref));
}

/** The pure half: read, grade, change nothing. `--repair` runs it twice. */
function inspect(options: CheckFindingsOptions): CheckFindingsResult & {
  /** The parsed document, for the repair pass to mutate. `null` on failure. */
  document: Record<string, unknown> | null;
  /** Findings that carry no transcript, with their index in `dropped[]`. */
  unbacked: { index: number; id: string; ref: string | null }[];
  /** Every id any finding cites, valid or not. */
  claimedByFinding: Set<string>;
  rows: Map<string, HypothesisRow>;
} {
  const repo = options.repo ?? process.cwd();
  const findingsPath = join(options.dir, "findings.json");
  const notes: string[] = [];
  const gaps: FindingsGap[] = [];
  const repaired: RepairAction[] = [];

  const { rows: hypotheses, families, malformed } = readHypotheses(options.dir);

  // ── `findings.json` — read before anything, because its absence is its own
  // failure and not a conservation one. A loop that has not written one yet
  // needs another iteration, not a verdict about hypotheses.
  let raw: unknown;
  let documentError: string | null = null;
  try {
    raw = JSON.parse(readFileSync(findingsPath, "utf8"));
    FindingsDocumentSchema.parse(raw);
  } catch (err) {
    documentError = `${findingsPath}: ${err instanceof Error ? err.message : String(err)}`;
  }

  if (documentError !== null) {
    return {
      hypotheses: [...hypotheses.keys()].sort(),
      covered: [],
      byTier: {},
      dropped: 0,
      gaps,
      malformed,
      documentError,
      satisfied: false,
      repaired,
      notes: ["findings.json could not be read — write one and the gate will grade it"],
      document: null,
      unbacked: [],
      claimedByFinding: new Set(),
      rows: hypotheses,
    };
  }

  const document = raw as Record<string, unknown>;
  const findings = Array.isArray(document.findings)
    ? (document.findings as Record<string, unknown>[])
    : [];
  const dropped = Array.isArray(document.dropped)
    ? (document.dropped as Record<string, unknown>[])
    : [];

  // ── Rule 7. No hypothesis files at all ⇒ the pipeline is off, or the surveys
  // produced nothing. There is nothing to conserve, so the gate passes — it must
  // never fail a run for the ABSENCE of the thing it audits. The note exists so
  // that pass is never read as "the adjudication was complete".
  if (families.length === 0) {
    notes.push(
      "no hypotheses/*.jsonl at all — the surveys did not run, so there is nothing to conserve. That is NOT evidence the adjudication was complete",
    );
  }

  const byTier: Record<string, number> = {};
  const coveredBy = new Map<string, string[]>();
  const claimedByFinding = new Set<string>();
  let ownFindings = 0;

  findings.forEach((finding, index) => {
    const tier = asString(finding.tier) ?? "(untiered)";
    byTier[tier] = (byTier[tier] ?? 0) + 1;
    const ids = finding.hypotheses;
    // Rule 6. A finding with NO `hypotheses` is fine and fails nothing: it is
    // the shipped reviewer's own finding, which was never hypothesis-derived.
    // Requiring the field would delete the reviewer we already have.
    if (!Array.isArray(ids)) {
      ownFindings += 1;
      return;
    }
    for (const id of ids) {
      const text = asString(id);
      if (!text) continue;
      claimedByFinding.add(text);
      coveredBy.set(text, [...(coveredBy.get(text) ?? []), `findings[${index}]`]);
    }
  });

  // ── Rule 4. Deletion is the one move that has to show its working.
  const unbacked: { index: number; id: string; ref: string | null }[] = [];
  dropped.forEach((entry, index) => {
    const id = asString(entry.hypothesis);
    if (!id) {
      gaps.push({
        kind: "unbacked-drop",
        hypothesis: `dropped[${index}]`,
        detail: "a dropped entry with no `hypothesis` id — nothing can be conserved against it",
      });
      return;
    }
    coveredBy.set(id, [...(coveredBy.get(id) ?? []), `dropped[${index}]`]);
    const ref = asString(entry.refutedBy);
    if (transcriptExists(ref, options.dir, repo)) return;
    unbacked.push({ index, id, ref });
    gaps.push({
      kind: "unbacked-drop",
      hypothesis: id,
      detail: `dropped naming ${ref ?? "no refutedBy"}, which does not exist on disk — only a probe transcript may delete`,
    });
  });

  // ── Rule 3. Exactly one disposition, each way it can be broken.
  const covered: string[] = [];
  for (const id of [...hypotheses.keys()].sort()) {
    const where = coveredBy.get(id) ?? [];
    if (where.length === 0) {
      gaps.push({
        kind: "uncovered",
        hypothesis: id,
        detail:
          "no disposition — it is in no `findings[].hypotheses` and no `dropped[]`. Record it (any tier, `internal` is fine) or drop it with a transcript",
      });
      continue;
    }
    if (where.length > 1) {
      gaps.push({
        kind: "duplicate",
        hypothesis: id,
        detail: `claimed ${where.length} times (${where.join(", ")}) — exactly one disposition each`,
      });
      continue;
    }
    covered.push(id);
  }

  // ── Rule 5. An id nothing declared. Distinct from `uncovered`, and it reads
  // the opposite way: the adjudicator invented provenance rather than dropped
  // it, so no amount of recording fixes it.
  for (const id of [...claimedByFinding].sort()) {
    if (hypotheses.has(id)) continue;
    gaps.push({
      kind: "fabricated",
      hypothesis: id,
      detail: "no hypotheses/*.jsonl declares this id — a finding cites provenance that does not exist",
    });
  }
  for (const entry of dropped) {
    const id = asString(entry.hypothesis);
    if (!id || hypotheses.has(id) || claimedByFinding.has(id)) continue;
    gaps.push({
      kind: "fabricated",
      hypothesis: id,
      detail: "no hypotheses/*.jsonl declares this id — a drop cites provenance that does not exist",
    });
  }

  if (ownFindings > 0) {
    notes.push(
      `${ownFindings} finding(s) carry no \`hypotheses\` — the reviewer's own, not hypothesis-derived, and this gate does not audit them`,
    );
  }
  if (malformed > 0) notes.push(`${malformed} unparseable JSONL line(s) were ignored`);

  return {
    hypotheses: [...hypotheses.keys()].sort(),
    covered,
    byTier,
    dropped: dropped.length,
    gaps,
    malformed,
    documentError: null,
    satisfied: gaps.length === 0,
    repaired,
    notes,
    document,
    unbacked,
    claimedByFinding,
    rows: hypotheses,
  };
}

export function checkFindings(options: CheckFindingsOptions): CheckFindingsResult {
  const log = options.log ?? noopLogger;
  const first = inspect(options);
  const strip = (r: typeof first): CheckFindingsResult => ({
    hypotheses: r.hypotheses,
    covered: r.covered,
    byTier: r.byTier,
    dropped: r.dropped,
    gaps: r.gaps,
    malformed: r.malformed,
    documentError: r.documentError,
    satisfied: r.satisfied,
    repaired: r.repaired,
    notes: r.notes,
  });

  // No `--repair`, or nothing to repair, or nothing readable to repair. The
  // floor deliberately does NOT invent a `findings.json`: a fabricated
  // `summary` and `event` is a review nobody wrote, and a phase whose loop
  // simply runs out of iterations does not fail the run anyway.
  if (!options.repair || first.document === null || first.satisfied) return strip(first);

  const document = first.document;
  const findings = Array.isArray(document.findings)
    ? (document.findings as Record<string, unknown>[])
    : [];
  const dropped = Array.isArray(document.dropped)
    ? (document.dropped as Record<string, unknown>[])
    : [];
  const repaired: RepairAction[] = [];

  // ── The floor. Two moves, and NEITHER of them deletes a hypothesis.
  //
  // An unbacked drop is UN-DELETED first: the entry goes, and unless a finding
  // already carries the hypothesis the record comes back at `internal`. Then
  // every still-uncovered hypothesis is appended the same way. A duplicate is
  // left exactly as it is — the gate cannot know which disposition the
  // adjudicator meant, and guessing would be the deletion it exists to prevent.
  const removeAt = new Set(first.unbacked.map((u) => u.index));
  const claimed = new Set(first.claimedByFinding);
  for (const { id, ref } of first.unbacked) {
    if (claimed.has(id)) {
      repaired.push({
        kind: "withdrawn",
        hypothesis: id,
        detail: `drop naming ${ref ?? "no refutedBy"} removed — a finding already carries it`,
      });
      continue;
    }
    findings.push(
      internalFinding(
        id,
        first.rows.get(id),
        `Dropped by the adjudicator naming ${ref ?? "no refutedBy"}, which does not exist on disk. Restored at internal tier: only a probe transcript may delete.`,
      ),
    );
    claimed.add(id);
    repaired.push({
      kind: "promoted",
      hypothesis: id,
      detail: `drop naming ${ref ?? "no refutedBy"} had no transcript — restored at tier "internal"`,
    });
  }

  for (const gap of first.gaps) {
    if (gap.kind !== "uncovered") continue;
    findings.push(
      internalFinding(
        gap.hypothesis,
        first.rows.get(gap.hypothesis),
        "No disposition was recorded by the adjudicator. Conserved at internal tier by the §D12 floor.",
      ),
    );
    repaired.push({
      kind: "recorded",
      hypothesis: gap.hypothesis,
      detail: 'no disposition — recorded at tier "internal"',
    });
  }

  if (repaired.length > 0) {
    document.findings = findings;
    // Only rewrite `dropped` when it was there: materialising an empty array
    // into a document that never had one is a claim ("looked, found none") the
    // floor is in no position to make.
    if (Array.isArray(document.dropped)) {
      document.dropped = dropped.filter((_, index) => !removeAt.has(index));
    }
    // House rule: every document validates against its schema BEFORE it is
    // written. A malformed `findings.json` in front of `post-review` is worse
    // than a gate that failed.
    FindingsDocumentSchema.parse(document);
    writeFileSync(
      join(options.dir, "findings.json"),
      `${JSON.stringify(document, null, 2)}\n`,
      "utf8",
    );
    log.info("the conservation floor rewrote findings.json", {
      dir: options.dir,
      repaired: repaired.length,
    });
  }

  // Re-grade the document that is now on disk, so the counts, the tiers and the
  // surviving gaps describe what a reader would find rather than what we
  // intended. §D12: the floor never takes the run down, so what it could not
  // repair — a duplicate, a fabricated id — is REPORTED and the gate closes.
  const second = inspect({ ...options, repair: false });
  return { ...strip(second), repaired, satisfied: true };
}

/** A one-screen summary for the phase log — the gate's whole stdout. */
export function renderFindingsCheck(result: CheckFindingsResult): string {
  if (result.documentError !== null) {
    return [
      "findings: no readable findings.json — the gate has nothing to grade",
      `  ✗ ${result.documentError}`,
    ].join("\n");
  }

  const tiers = Object.entries(result.byTier)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const lines = [
    `findings: ${result.covered.length}/${result.hypotheses.length} hypotheses accounted for` +
      (tiers ? ` (${tiers}` : " (") +
      `${tiers ? ", " : ""}dropped=${result.dropped})`,
  ];
  for (const note of result.notes) lines.push(`  note: ${note}`);
  for (const action of result.repaired.slice(0, MAX_LISTED)) {
    lines.push(`  + ${action.hypothesis}: ${action.detail}`);
  }
  if (result.repaired.length > MAX_LISTED) {
    lines.push(`  … and ${result.repaired.length - MAX_LISTED} more repaired`);
  }
  for (const gap of result.gaps.slice(0, MAX_LISTED)) {
    lines.push(`  ✗ ${gap.hypothesis} [${gap.kind}]: ${gap.detail}`);
  }
  if (result.gaps.length > MAX_LISTED) {
    lines.push(`  … and ${result.gaps.length - MAX_LISTED} more`);
  }
  return lines.join("\n");
}
