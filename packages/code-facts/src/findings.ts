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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  readHypothesisSet,
  resolveHypothesis,
  type HypothesisRecord,
  type HypothesisRow,
} from "./hypotheses.js";
import { noopLogger, type LoggerPort } from "./log.js";
import { FindingsDocumentSchema } from "./schema.js";

export type FindingsGapKind =
  /** In no `findings[].hypotheses` and no `dropped[]`. Silent omission. */
  | "uncovered"
  /** Two dispositions — two findings, or a finding AND a drop. */
  | "duplicate"
  /** Deleted with no transcript, or naming one that is not on disk. */
  | "unbacked-drop"
  /** An id no `hypotheses/*.jsonl` ever declared. */
  | "fabricated"
  /**
   * A citation naming an id that TWO OR MORE hypotheses declared, so it credits
   * none of them. This is the collision that used to pass the gate silently —
   * `contract.jsonl` and `security.jsonl` both minting `H-001` — surfaced by
   * name instead of resolved by sort order.
   */
  | "ambiguous";

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
   * (`.lastlight/pr-review/probes/contract-001.txt`) and an adjudicator that copies a
   * `dir`-relative one (`probes/contract-001.txt`) is being helpful rather than wrong,
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

/**
 * Line width for the ledger's outstanding list. Wrapping, never truncation.
 *
 * By WIDTH rather than a fixed id count, because ids are `<family>-NNN` and a
 * family name is as long as it is — `enforcement-001` is three times `H-001`,
 * and twelve per line silently ran to 157 characters.
 */
const IDS_LINE_WIDTH = 100;

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
  record: HypothesisRecord | undefined,
  fallbackBody: string,
): Record<string, unknown> {
  const row: HypothesisRow | undefined = record?.row;
  const claim = row ? asString(row.claim) : null;
  const path = row ? pathOf(row) : null;
  const existingCode = row ? asString(row.existingCode) : null;
  const severity = (row ? asString(row.severity) : null) ?? "Important";
  // The FILENAME's family, not the row's self-report — the survey branch owns
  // its file, and a free-form row carries no `family` field at all.
  const family = record?.family ?? (row ? asString(row.family) : null);
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
  /** Every CANONICAL id any finding cites, after resolution. */
  claimedByFinding: Set<string>;
  rows: Map<string, HypothesisRecord>;
} {
  const repo = options.repo ?? process.cwd();
  const findingsPath = join(options.dir, "findings.json");
  const notes: string[] = [];
  const gaps: FindingsGap[] = [];
  const repaired: RepairAction[] = [];

  const set = readHypothesisSet(options.dir);
  const { byId: hypotheses, families, malformed } = set;

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
  /** Citations that named nothing resolvable, and why. Rule 5 reports them. */
  const unresolved = new Map<string, { kind: "ambiguous" | "unknown"; claimedBy: string[] }>();
  let ownFindings = 0;
  let viaAlias = 0;

  /**
   * A citation → the canonical id it credits, or nothing.
   *
   * Every disposition goes through here, so a `findings[]` entry and a
   * `dropped[]` entry citing the same string always agree, and an ambiguous
   * citation credits neither claimant instead of whichever file sorted first.
   */
  const creditTo = (cited: string, where: string, byFinding: boolean): string | null => {
    const resolution = resolveHypothesis(set, cited);
    if (resolution.kind === "resolved") {
      if (resolution.viaAlias) viaAlias += 1;
      coveredBy.set(resolution.id, [...(coveredBy.get(resolution.id) ?? []), where]);
      // ONLY a finding claims a hypothesis. The floor asks "does a finding
      // already carry this?" to choose between withdrawing a bad drop and
      // promoting it back — counting the drop itself would answer yes to its
      // own question and silently withdraw every unbacked deletion instead of
      // restoring it. That is the one move this gate exists to prevent.
      if (byFinding) claimedByFinding.add(resolution.id);
      return resolution.id;
    }
    unresolved.set(cited, {
      kind: resolution.kind,
      claimedBy: resolution.kind === "ambiguous" ? resolution.claimedBy : [],
    });
    return null;
  };

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
      creditTo(text, `findings[${index}]`, true);
    }
  });

  // ── Rule 4. Deletion is the one move that has to show its working.
  const unbacked: { index: number; id: string; ref: string | null }[] = [];
  dropped.forEach((entry, index) => {
    const cited = asString(entry.hypothesis);
    if (!cited) {
      gaps.push({
        kind: "unbacked-drop",
        hypothesis: `dropped[${index}]`,
        detail: "a dropped entry with no `hypothesis` id — nothing can be conserved against it",
      });
      return;
    }
    const id = creditTo(cited, `dropped[${index}]`, false);
    const ref = asString(entry.refutedBy);
    if (transcriptExists(ref, options.dir, repo)) return;
    // Even an unresolvable citation is un-deleted. The floor's job is that a
    // deletion never silently costs a claim, and a drop naming an id nothing
    // declared is still a subject somebody meant to remove — recording it at
    // `internal` keeps it auditable, while rule 5 reports the id as fabricated.
    unbacked.push({ index, id: id ?? cited, ref });
    gaps.push({
      kind: "unbacked-drop",
      hypothesis: id ?? cited,
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

  // ── Rule 5. A citation that credits nothing, split by WHY — the two read in
  // opposite directions and want different fixes.
  //
  // `fabricated`: the adjudicator invented provenance, and no amount of
  // recording fixes it. `ambiguous`: the id is real but two hypotheses declared
  // it, so crediting either would mark the other adjudicated when nobody looked
  // at it. The second is the collision that used to pass this gate in silence.
  for (const cited of [...unresolved.keys()].sort()) {
    const { kind, claimedBy } = unresolved.get(cited)!;
    gaps.push(
      kind === "ambiguous"
        ? {
            kind: "ambiguous",
            hypothesis: cited,
            detail: `${claimedBy.length} hypotheses declared this id (${claimedBy.join(", ")}) — cite the canonical id instead, so exactly one is credited`,
          }
        : {
            kind: "fabricated",
            hypothesis: cited,
            detail:
              "no hypotheses/*.jsonl declares this id — a disposition cites provenance that does not exist",
          },
    );
  }

  if (set.ambiguous.size > 0) {
    notes.push(
      `${set.ambiguous.size} declared id(s) were minted by more than one family and credit nothing — every hypothesis is still reachable by its canonical \`<family>-NNN\` id`,
    );
  }
  if (set.records.length > set.declared) {
    notes.push(
      `${set.declared}/${set.records.length} hypotheses carried an id of their own; identity for the rest is the deterministic \`<family>-NNN\``,
    );
  }
  if (viaAlias > 0) {
    notes.push(`${viaAlias} disposition(s) cited a model-minted id that resolved unambiguously`);
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

/**
 * One hypothesis, as the adjudicator needs to see it while it works.
 *
 * Deliberately the fields that let a claim be DISPOSED of — where it is, how
 * severe it was thought to be, which obligation produced it — and not the
 * evidence, quotes or transcripts. Those stay in the `.jsonl`, because the
 * adjudicator has to read the record to judge it and a ledger that inlined
 * everything would be the six files again with extra steps.
 */
export interface LedgerEntry {
  id: string;
  /** The FILENAME's family — present for every hypothesis, never self-reported. */
  family: string;
  obligation: string | null;
  path: string | null;
  severity: string | null;
  confidence: number | null;
  /** The claim's first sentence, bounded — a label to recognise it by. */
  title: string;
  /** Does it already carry exactly one disposition in `findings.json`? */
  accounted: boolean;
}

export interface FindingsLedger {
  /** Every declared id, grouped-by-family order preserved in `families`. */
  entries: LedgerEntry[];
  /** The subset with no disposition yet — the todo list. */
  uncovered: LedgerEntry[];
  /** The other three ways the gate fails, so the ledger is not a partial view. */
  duplicates: FindingsGap[];
  fabricated: FindingsGap[];
  unbackedDrops: FindingsGap[];
  families: string[];
  documentError: string | null;
  /** True ⇒ writing nothing further would pass the gate. */
  satisfied: boolean;
}

/**
 * The CHECKLIST half of conservation — same reading, opposite audience.
 *
 * `checkFindings` answers the harness's question ("may the loop stop?") with an
 * exit code. This answers the adjudicator's ("what must I account for, and what
 * have I not?") with a list, and it is what makes the gate satisfiable on the
 * FIRST attempt: measured, attempt 1 spent 426 s and $0.52 reconstructing the id
 * set by reading six `.jsonl` files, missed some, and bought a second 274 s /
 * $0.43 attempt — 40% of the case's wall clock and 38% of its cost, for a set
 * that is mechanically derivable.
 *
 * It reads through the same `inspect` the gate does, so the checklist and the
 * verdict can never disagree about which ids exist. That is the whole reason it
 * lives here rather than in the prompt as an instruction to go and count.
 */
export function buildFindingsLedger(options: CheckFindingsOptions): FindingsLedger {
  const result = inspect({ ...options, repair: false });
  const covered = new Set(result.covered);
  // An unreadable `findings.json` makes `inspect` return early with NO gaps —
  // correct for the gate, which fails on the document error alone and wants the
  // next iteration to write one. For a checklist it would be a lie of omission:
  // nothing has a disposition when there is no document to hold one, so every
  // declared id is outstanding.
  const uncoveredIds =
    result.documentError !== null
      ? new Set(result.rows.keys())
      : new Set(result.gaps.filter((g) => g.kind === "uncovered").map((g) => g.hypothesis));

  const families: string[] = [];
  const entries: LedgerEntry[] = [];
  for (const [id, record] of result.rows) {
    const { row, family } = record;
    if (!families.includes(family)) families.push(family);
    const claim = asString(row.claim);
    entries.push({
      id,
      family,
      obligation: asString(row.obligation),
      path: pathOf(row),
      severity: asString(row.severity),
      confidence: typeof row.confidence === "number" ? row.confidence : null,
      title: claim ? titleFrom(claim) : `(no claim recorded on ${id})`,
      accounted: covered.has(id),
    });
  }
  // Declaration order — `<family>-NNN` sorts that way already, and the files are
  // read sorted, so the checklist reads in the order the surveys wrote it.
  entries.sort((a, b) => a.family.localeCompare(b.family) || a.id.localeCompare(b.id));

  return {
    entries,
    uncovered: entries.filter((e) => uncoveredIds.has(e.id)),
    duplicates: result.gaps.filter((g) => g.kind === "duplicate"),
    fabricated: result.gaps.filter((g) => g.kind === "fabricated"),
    unbackedDrops: result.gaps.filter((g) => g.kind === "unbacked-drop"),
    families: families.sort(),
    documentError: result.documentError,
    satisfied: result.satisfied,
  };
}

/**
 * Render the ledger for an agent's context.
 *
 * **Nothing here is capped, and that is deliberate** — `renderFindingsCheck`
 * stops naming ids at 20 because it is a log line, but a checklist that elided
 * entries would reproduce the exact omission it exists to prevent. The bound is
 * on each claim (one sentence, ~100 chars via `titleFrom`), never on the count.
 */
export function renderFindingsLedger(ledger: FindingsLedger): string {
  const lines: string[] = [];
  const total = ledger.entries.length;

  if (total === 0) {
    return [
      "conservation ledger: no hypotheses were declared.",
      "  The surveys wrote no hypotheses/*.jsonl, so there is nothing to account for",
      "  and the gate will pass on that basis. This is NOT evidence that the review",
      "  is complete — write your findings from the diff as usual.",
    ].join("\n");
  }

  const done = ledger.entries.filter((e) => e.accounted).length;
  lines.push(
    `conservation ledger: ${done}/${total} hypotheses accounted for, across ${ledger.families.length} famil${ledger.families.length === 1 ? "y" : "ies"}.`,
    "Every id below must appear EXACTLY ONCE in findings.json — in some finding's",
    '`hypotheses` array (any tier; `internal` is a valid answer) or in `dropped`',
    "with a `refutedBy` transcript that exists on disk.",
    "",
  );

  if (ledger.documentError !== null) {
    lines.push(
      "findings.json is not readable yet, so every id below is outstanding:",
      `  ${ledger.documentError}`,
      "",
    );
  }

  let family: string | undefined;
  for (const e of ledger.entries) {
    if (e.family !== family) {
      family = e.family;
      lines.push(`── ${family} ──`);
    }
    const mark = e.accounted ? "[x]" : "[ ]";
    const meta = [e.obligation, e.severity, e.path].filter(Boolean).join(" · ");
    lines.push(`  ${mark} ${e.id}${meta ? `  (${meta})` : ""}`);
    lines.push(`        ${e.title}`);
  }

  if (ledger.uncovered.length > 0) {
    lines.push(
      "",
      `OUTSTANDING — ${ledger.uncovered.length} of ${total} still have no disposition:`,
    );
    // Wrapped rather than one long line: this is the list the next attempt
    // works from, and every id has to stay legible however many there are.
    let row: string[] = [];
    let width = 0;
    for (const id of ledger.uncovered.map((e) => e.id)) {
      if (row.length > 0 && width + 1 + id.length > IDS_LINE_WIDTH) {
        lines.push(`  ${row.join(" ")}`);
        row = [];
        width = 0;
      }
      width += (row.length > 0 ? 1 : 0) + id.length;
      row.push(id);
    }
    if (row.length > 0) lines.push(`  ${row.join(" ")}`);
  }
  for (const gap of [...ledger.duplicates, ...ledger.unbackedDrops, ...ledger.fabricated]) {
    lines.push(`  ✗ ${gap.hypothesis} [${gap.kind}]: ${gap.detail}`);
  }
  if (ledger.satisfied) {
    lines.push("", "Conservation holds. Every id has exactly one disposition.");
  }
  return lines.join("\n");
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
