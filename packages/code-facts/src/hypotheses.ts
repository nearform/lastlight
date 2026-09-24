/**
 * Hypothesis IDENTITY — assigned here, deterministically, at ingest.
 *
 * Every gate that enumerates `hypotheses/*.jsonl` reads through this module, so
 * `findings`, `--ledger` and `probes` can never disagree about which claims
 * exist or what they are called.
 *
 * ── Why identity is not the model's to mint ─────────────────────────────────
 *
 * It was, and both halves failed on the first real run
 * (`prreview__skillspro-1587-r1`, 2026-08-22, 30 hypotheses across six
 * families):
 *
 *   - **Collision.** `contract.jsonl` emitted `H-001..H-005` and
 *     `security.jsonl` independently emitted `H-001..H-003`. The reader keyed a
 *     flat map on the string, first write won, and the three security claims
 *     were **discarded on read**. `findings.json` covered `H-001..H-005`, so the
 *     conservation gate reported `5/5 accounted for` and exited 0 — while three
 *     hypotheses had never been adjudicated at all. A gate that passes falsely
 *     is worse than no gate: it converts an omission into a green light.
 *   - **Absence.** Only **8 of 30** rows carried an `id` at all. The rest were
 *     free-form — `{claim, obligations}`, `{claim, producer_side,
 *     consumer_side}`, `{claim, symbol, introduced_at, enforced_at, mechanism}`.
 *     Conservation only ever saw the compliant subset, so **22 of 30 generated
 *     claims were structurally invisible**, including every hypothesis about a
 *     gold finding that run missed.
 *
 * Compliance was 27% on one run and reportedly 100% on the run before it, which
 * is the tell: **an instruction is not a mechanism.** The seed prompt already
 * says what to do about that — make it *"impossible by construction rather than
 * by instruction"* — and this module is that sentence applied to identity.
 *
 * ── The scheme ──────────────────────────────────────────────────────────────
 *
 * `<family>-<NNN>` — the family from the FILENAME (the survey branch owns its
 * file, so the name is authoritative in a way a self-reported field is not) and
 * a 1-based ordinal within it. The files are append-only, so position is stable
 * across re-reads, and the pair is unique by construction. It exists for every
 * parsed row, whatever shape the model wrote.
 *
 * ── What a model-supplied id is still worth ─────────────────────────────────
 *
 * It is kept as an **alias**, so an adjudicator citing `H-004` is still credited
 * — but only when the alias is unambiguous. A declared id claimed by two rows
 * resolves to NEITHER, and the citation is reported as `ambiguous` rather than
 * silently credited to whichever file sorted first. That is the whole bug,
 * inverted: the collision that used to pass the gate now fails it, by name.
 *
 * Canonical ids always beat aliases. A row declaring `contract-001` while
 * sitting third in `contract.jsonl` does not get to shadow the real
 * `contract-001`; the alias is dropped and both remain reachable.
 *
 * ── The same bug, one field along: `obligation` ─────────────────────────────
 *
 * `row.obligation` is the back-pointer from a claim to the question that
 * provoked it, and it is **also written by the model and was also never
 * checked**. Measured 2026-09-21 across 20 preserved runs: one case's repeats
 * cite **44 distinct obligation ids against a seeded question set of 33**, and
 * two repeats of `skillspro-1667` — handed a byte-identical 7-question seed —
 * cite *disjoint* sets. Nothing noticed, because nothing looked.
 *
 * The deterministic stage is genuinely deterministic (verified: every repeat of
 * every case produced an identical obligation list), so this is recoverable
 * rather than inherent: pass the seeded ids to {@link readHypothesisSet} and
 * every citation is resolved against them, with the misses reported by name in
 * {@link HypothesisSet.unknownObligations}.
 *
 * Resolution is EXACT, then whitespace/case-normalised, and then it gives up.
 * No fuzzy matching and no nearest-neighbour: inventing a plausible target is
 * the failure being fixed, not the fix. An unresolvable citation reads as
 * `null`, which is a different thing from "no citation" and is why
 * {@link HypothesisRecord.declaredObligation} is kept alongside it.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

import { type JsonlParse, parseJsonl } from "./jsonl.js";
import { type SurveyEvidence, type SurveyVerdict, deriveVerdict, hasEvidence } from "./survey-verdict.js";

/** A hypothesis line, as far as the gates care. Everything else rides along. */
export interface HypothesisRow {
  /** The typed record a pass fills in so the verdict can be DERIVED — see
   * `survey-verdict.ts`. Absent on rows written by a prompt that never asked
   * for one, which is not a fault and is not scored as one. */
  evidence?: unknown;
  id?: unknown;
  family?: unknown;
  obligation?: unknown;
  claim?: unknown;
  existingCode?: unknown;
  severity?: unknown;
  confidence?: unknown;
  path?: unknown;
  bothEnds?: unknown;
  needsProbe?: unknown;
}

export interface HypothesisRecord {
  /** `<family>-<NNN>`. Deterministic, collision-free, present for EVERY row. */
  id: string;
  /** From the filename, not from the row — the file the survey actually wrote. */
  family: string;
  /** 1-based position among parsed rows in its file. */
  ordinal: number;
  /** Whatever the model put in `id`, kept for the alias map and for reporting. */
  declaredId: string | null;
  /** Whatever the model put in `obligation`, unresolved and unjudged. */
  declaredObligation: string | null;
  /**
   * The seeded obligation this row cites, or `null`.
   *
   * `null` means one of three different things and the caller must not conflate
   * them: the row cited nothing (`declaredObligation === null`), the row cited
   * something that is not in the question set (it will be in
   * {@link HypothesisSet.unknownObligations}), or nobody supplied a question
   * set to check against ({@link HypothesisSet.obligationsChecked} is false).
   */
  obligation: string | null;
  row: HypothesisRow;
  /**
   * The verdict computed from {@link HypothesisRow.evidence}, and what the
   * pass itself wrote.
   *
   * `null` when the row carries no evidence — then the pass's own values stand,
   * exactly as before, so a prompt that predates this asks for nothing it
   * cannot deliver.
   *
   * **Both halves are kept on purpose.** The derived verdict is the one every
   * consumer should read; the declared one is how a disagreement stays
   * visible, and a disagreement is evidence about the prompt rather than noise
   * to be flattened. Overwriting in place would have destroyed the only signal
   * that says the pass is not doing what it was asked.
   */
  verdict: {
    derived: SurveyVerdict;
    declaredSeverity: string | null;
    declaredNeedsProbe: boolean | null;
    /** Did the pass's own answer match what its evidence implies? */
    agrees: { severity: boolean; needsProbe: boolean };
  } | null;
}

export interface HypothesisSet {
  /** Declaration order: family file order, then position within the file. */
  records: HypothesisRecord[];
  /** Canonical id → record. */
  byId: Map<string, HypothesisRecord>;
  /** An unambiguous declared id → the canonical id it names. */
  aliases: Map<string, string>;
  /** A declared id claimed by more than one row → every canonical id claiming it. */
  ambiguous: Map<string, string[]>;
  /** Family names, in file order. */
  families: string[];
  /** Lines that were not JSON at all, counted rather than silently skipped. */
  malformed: number;
  /**
   * Rows that were NOT one object per line (pretty-printed, or run together)
   * and were read anyway. Counted because it is the pass ignoring its format,
   * which is worth seeing even when nothing was lost.
   */
  recovered: number;
  /** How many rows carried a usable `id` of their own — the compliance rate. */
  declared: number;
  /**
   * A cited `obligation` that is not in the seeded question set → the canonical
   * hypothesis ids citing it. Empty when everything resolved.
   *
   * Always empty when {@link obligationsChecked} is false, which is why that
   * flag exists: an unchecked run and a clean run must not read alike.
   */
  unknownObligations: Map<string, string[]>;
  /** Whether a question set was supplied to resolve citations against. */
  obligationsChecked: boolean;
  /**
   * Canonical ids of rows carrying NO evidence record.
   *
   * **Reported, never silently tolerated.** `severity` and `needsProbe` are
   * derived from evidence; a row without it falls back to whatever the pass
   * wrote, which is exactly the ungoverned guess the derivation exists to
   * replace. Measured: a family whose prompt only POINTED at the record wrote
   * none, fell back, and graded ten of ten rows `Critical` on a pull request
   * with nothing wrong — while every surface reported success.
   *
   * So this is a first-class fact, like `malformed` and `unknownObligations`:
   * a pass that ignored its contract must be visible as that, not as a clean
   * run. Loud in the artifact, never fatal to the run.
   */
  missingEvidence: string[];
}

/** The verdict for a row, or `null` when it carried no evidence to derive from. */
function verdictFor(row: HypothesisRow): HypothesisRecord["verdict"] {
  const evidence = row.evidence as SurveyEvidence | undefined;
  if (!hasEvidence(evidence)) return null;
  const derived = deriveVerdict(evidence as SurveyEvidence);
  const declaredSeverity = typeof row.severity === "string" ? row.severity : null;
  const declaredNeedsProbe = typeof row.needsProbe === "boolean" ? row.needsProbe : null;
  return {
    derived,
    declaredSeverity,
    declaredNeedsProbe,
    agrees: {
      severity: (declaredSeverity ?? "").trim().toLowerCase() === derived.severity.toLowerCase(),
      needsProbe: declaredNeedsProbe === derived.needsProbe,
    },
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `<family>-<NNN>`. Padded so a family's ids sort in declaration order. */
export function hypothesisId(family: string, ordinal: number): string {
  return `${family}-${String(ordinal).padStart(3, "0")}`;
}

/** Read a JSONL file into rows — see `jsonl.ts` for what counts as a row. */
function readJsonlRows(path: string): JsonlParse {
  if (!existsSync(path)) return { rows: [], recovered: 0, malformed: 0 };
  return parseJsonl(readFileSync(path, "utf8"));
}

/**
 * Every hypothesis the surveys wrote, with identity assigned.
 *
 * **No row is ever dropped.** The previous reader keyed on the model's id and
 * skipped anything without one or with a repeat; both are how claims went
 * missing. A repeated declared id inside one file becomes two records here —
 * two lines are two claims, and conserving both is the direction that cannot
 * lose one. The restatement costs a duplicate disposition; the alternative cost
 * a hypothesis.
 */
export function readHypothesisSet(
  dir: string,
  /**
   * The seeded obligation ids, off `obligations.json`. Omit and citations are
   * carried through unresolved rather than being guessed at — see
   * {@link HypothesisSet.obligationsChecked}.
   */
  knownObligations?: Iterable<string>,
): HypothesisSet {
  const known = knownObligations ? new Set(knownObligations) : null;
  /** Normalised → canonical, for the one tolerance this resolver allows. */
  const loose = new Map<string, string>();
  if (known) for (const id of known) loose.set(normaliseObligation(id), id);
  const hypothesesDir = join(dir, "hypotheses");
  const files = existsSync(hypothesesDir)
    ? readdirSync(hypothesesDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
    : [];

  const records: HypothesisRecord[] = [];
  const families: string[] = [];
  let malformed = 0;
  let recovered = 0;
  let declared = 0;

  for (const file of files) {
    const family = basename(file, ".jsonl");
    families.push(family);
    const parsed = readJsonlRows(join(hypothesesDir, file));
    malformed += parsed.malformed;
    recovered += parsed.recovered;
    (parsed.rows as HypothesisRow[]).forEach((row, index) => {
      const ordinal = index + 1;
      const declaredId = asString(row.id);
      if (declaredId) declared += 1;
      const declaredObligation = asString(row.obligation);
      const obligation =
        known === null || declaredObligation === null
          ? null
          : known.has(declaredObligation)
            ? declaredObligation
            : (loose.get(normaliseObligation(declaredObligation)) ?? null);
      records.push({
        id: hypothesisId(family, ordinal),
        family,
        ordinal,
        declaredId,
        declaredObligation,
        obligation,
        row,
        verdict: verdictFor(row),
      });
    });
  }

  const missingEvidence = records.filter((r) => r.verdict === null).map((r) => r.id);

  const byId = new Map(records.map((r) => [r.id, r]));

  // Aliases, in two passes: collect every claim on a declared id, then keep only
  // the claims that are unambiguous AND do not shadow a canonical id. Canonical
  // always wins — a row declaring `contract-001` from third position must not
  // capture citations meant for the real first row.
  const claims = new Map<string, string[]>();
  for (const record of records) {
    if (!record.declaredId || record.declaredId === record.id) continue;
    claims.set(record.declaredId, [...(claims.get(record.declaredId) ?? []), record.id]);
  }

  const aliases = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const [declaredId, claimedBy] of claims) {
    if (byId.has(declaredId)) {
      // Shadowing a canonical id. Not ambiguous — just refused, because the
      // canonical reading is the correct one and needs no help.
      continue;
    }
    if (claimedBy.length === 1) aliases.set(declaredId, claimedBy[0]);
    else ambiguous.set(declaredId, claimedBy);
  }

  // Citations that name nothing in the question set, by name — the same
  // treatment `ambiguous` gives a colliding id, for the same reason: a
  // back-pointer that resolves to nothing has to fail loudly or it will be
  // trusted by whatever reads it next.
  const unknownObligations = new Map<string, string[]>();
  if (known !== null) {
    for (const record of records) {
      if (record.declaredObligation === null || record.obligation !== null) continue;
      unknownObligations.set(record.declaredObligation, [
        ...(unknownObligations.get(record.declaredObligation) ?? []),
        record.id,
      ]);
    }
  }

  return {
    records,
    byId,
    aliases,
    ambiguous,
    families,
    malformed,
    recovered,
    missingEvidence,
    declared,
    unknownObligations,
    obligationsChecked: known !== null,
  };
}

/** Case and whitespace only. Deliberately not a similarity measure. */
function normaliseObligation(id: string): string {
  return id.trim().toLowerCase().replace(/\s+/g, " ");
}

export type HypothesisResolution =
  /** The citation names exactly one hypothesis. */
  | { kind: "resolved"; id: string; viaAlias: boolean }
  /** The citation names an id two or more rows declared. Nothing is credited. */
  | { kind: "ambiguous"; claimedBy: string[] }
  /** No canonical id and no alias — provenance that does not exist. */
  | { kind: "unknown" };

/**
 * What a `findings[].hypotheses[]` or `dropped[].hypothesis` citation refers to.
 *
 * Canonical first, then an unambiguous alias. An ambiguous one resolves to
 * NOTHING on purpose: crediting it to the first family that sorted is exactly
 * the silent mis-attribution this module exists to end, and it would leave the
 * shadowed claim reading as adjudicated when nobody looked at it.
 */
export function resolveHypothesis(set: HypothesisSet, cited: string): HypothesisResolution {
  if (set.byId.has(cited)) return { kind: "resolved", id: cited, viaAlias: false };
  const alias = set.aliases.get(cited);
  if (alias) return { kind: "resolved", id: alias, viaAlias: true };
  const claimedBy = set.ambiguous.get(cited);
  if (claimedBy) return { kind: "ambiguous", claimedBy };
  return { kind: "unknown" };
}
