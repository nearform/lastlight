/**
 * `findings` — the `adjudicate` loop's exit gate, and the conservation check.
 *
 * WP6c (`docs/plans/deterministic-pr-levers.md` §"Adjudication and the
 * attention boundary (WP6)").
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
import { severityOf } from "./survey-verdict.js";

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
   * the drop is removed and nothing is appended. `expanded` — an `internal[]`
   * id-list entry materialized as a full internal row. `filed` — a row
   * `admit` kept away from the adjudicator, filed at internal with its rule. */
  kind: "recorded" | "promoted" | "withdrawn" | "expanded" | "filed";
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
  const severity = (row ? severityOf(row) : null) ?? "Important";
  // Still read, never asked for: the row contract no longer requests
  // `confidence` (it measured AUROC 0.228, inverted, and `rankOf` ignores it),
  // but a row that carries one is audit data and this record exists to carry
  // the row. New rows simply have none.
  const confidence = row && typeof row.confidence === "number" ? row.confidence : null;
  // The FILENAME's family, not the row's self-report — the survey branch owns
  // its file, and a free-form row carries no `family` field at all.
  const family = record?.family ?? (row ? asString(row.family) : null);
  const obligation = row ? asString(row.obligation) : null;

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
  /** The `internal[]` id-list entries, each with its resolved canonical id
   * (`null` when fabricated/ambiguous — rule 5 reports those). The repair pass
   * expands the resolvable ones into full rows. */
  internalShorthand: { cited: string; id: string | null }[];
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
      internalShorthand: [],
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

  // ── The `internal[]` id-list shorthand. Each entry credits exactly one
  // disposition through the same `creditTo` path as a finding's `hypotheses[]`
  // citation, so a duplicate (listed AND carried by a finding), an ambiguous
  // model-minted id and a fabricated one all fail the gate exactly as before.
  // NOT credited as `byFinding`: `claimedByFinding` answers "does a full row
  // already carry this?", which is what decides both drop-withdrawal and
  // whether expansion would manufacture a duplicate row. The repair pass adds
  // each id it expands to that set itself.
  const internalShorthand: { cited: string; id: string | null }[] = [];
  const internalList = Array.isArray(document.internal) ? (document.internal as unknown[]) : [];
  internalList.forEach((entry, index) => {
    const text = asString(entry);
    if (!text) return;
    internalShorthand.push({ cited: text, id: creditTo(text, `internal[${index}]`, false) });
  });
  if (internalShorthand.length > 0) {
    byTier["internal"] = (byTier["internal"] ?? 0) + internalShorthand.length;
    notes.push(
      `${internalShorthand.length} hypothesis id(s) filed internal via the \`internal[]\` shorthand — reconcile materializes them as full rows`,
    );
  }

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
    internalShorthand,
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

  // A MISSING `findings.json` over a non-empty hypothesis set: the floor
  // WRITES one. It used to refuse ("a fabricated summary is a review nobody
  // wrote"), and that was right while `review` always ran — but with the
  // evidence pipeline on, `review` is skipped and `site-finalize` is the ONLY
  // writer. A finalize that fails, times out or never writes the file would
  // leave post-review with nothing to read: the phase fails, the run
  // goes red with nothing posted, per-head dedup records nothing, and the
  // thirty-minute sweep re-buys the whole pipeline on the same SHA forever.
  // What is written is not a review anyone wrote, and it says so: every
  // hypothesis at `internal` (recorded, never posted — the same row the floor
  // writes for an uncovered one), `event: COMMENT`, a summary stating that
  // the review did not complete, and an `incomplete` marker a reader can
  // key on. Safe in every workflow shape: when `review` RAN, a missing file
  // means review failed, and post-review (`none_failed` on `review`) does not
  // run at all. No hypotheses ⇒ nothing to conserve and nothing is invented.
  const findingsPath = join(options.dir, "findings.json");
  if (options.repair && first.document === null && !existsSync(findingsPath) && first.hypotheses.length > 0) {
    const count = first.hypotheses.length;
    const created: Record<string, unknown> = {
      summary:
        `The review did not complete, so the ${count} candidate issue${count === 1 ? "" : "s"} this review's analysis ` +
        "recorded were not weighed and nothing is posted inline. They are kept, unposted, for the record. " +
        "This is not a clean review: the change was not assessed.",
      event: "COMMENT",
      incomplete: {
        phase: "site-finalize",
        reason: "findings.json did not exist when the conservation floor ran — site-finalize failed, timed out, or never wrote it",
      },
      findings: first.hypotheses.map((id) =>
        internalFinding(
          id,
          first.rows.get(id),
          "Never weighed — findings.json was never written. Conserved at internal tier by the §D12 floor.",
        ),
      ),
    };
    FindingsDocumentSchema.parse(created);
    writeFileSync(findingsPath, `${JSON.stringify(created, null, 2)}\n`, "utf8");
    log.warn("findings.json was missing; the conservation floor wrote an unadjudicated one", {
      dir: options.dir,
      hypotheses: count,
    });
    const second = inspect({ ...options, repair: false });
    return {
      ...strip(second),
      repaired: first.hypotheses.map((id) => ({
        kind: "recorded" as const,
        hypothesis: id,
        detail: 'findings.json was missing — written with every hypothesis at tier "internal"',
      })),
      notes: [...second.notes, `findings.json was MISSING: written unadjudicated, ${count} hypothes${count === 1 ? "is" : "es"} at internal tier, event COMMENT`],
      satisfied: true,
    };
  }

  // No `--repair`, or nothing to repair, or nothing readable to repair. An
  // UNREADABLE document is left alone — it is somebody's review, and
  // overwriting it would destroy what was written; a missing one with no
  // hypotheses is not invented (there is nothing to conserve, and post-review
  // then fails loudly on the missing file, as it always has). A SATISFIED
  // document still gets the repair pass when it carries the `internal[]`
  // shorthand: expansion is the reader-compat half of that contract —
  // post-review's disposition record, the pipeline stats and the
  // internal-recall judge all read full rows.
  if (
    !options.repair ||
    first.document === null ||
    (first.satisfied && first.internalShorthand.length === 0)
  ) {
    return strip(first);
  }

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

  // ── Expand the `internal[]` id-list shorthand into full rows, first: the
  // deterministic materializer reproduces from the hypothesis record the same
  // row the model's own internal prose degenerates to, at zero model cost.
  // Entries that resolved to nothing stay IN the list — rule 5 already
  // reported them as fabricated/ambiguous, and silently removing a citation
  // would erase the evidence that the adjudicator cited provenance that does
  // not exist. Duplicates (an id both listed and carried by a finding) are
  // left to the gate's duplicate report, exactly like duplicate citations.
  const expandable = first.internalShorthand.filter(
    (s): s is { cited: string; id: string } => s.id !== null,
  );
  if (first.internalShorthand.length > 0) {
    for (const { id } of expandable) {
      // Listed AND carried by a full row: the gate reports the duplicate;
      // materializing a second row here would turn the report into the defect.
      if (claimed.has(id)) continue;
      findings.push(
        internalFinding(
          id,
          first.rows.get(id),
          "Filed at internal tier by the adjudicator via the id-list shorthand; materialized as a full row by reconcile.",
        ),
      );
      claimed.add(id);
      repaired.push({
        kind: "expanded",
        hypothesis: id,
        detail: "internal[] shorthand — materialized as a full internal-tier row",
      });
    }
    const unresolved = first.internalShorthand.filter((s) => s.id === null).map((s) => s.cited);
    if (unresolved.length > 0) document.internal = unresolved;
    else delete document.internal;
  }
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
