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
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

/** A hypothesis line, as far as the gates care. Everything else rides along. */
export interface HypothesisRow {
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
  row: HypothesisRow;
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
  /** How many rows carried a usable `id` of their own — the compliance rate. */
  declared: number;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** `<family>-<NNN>`. Padded so a family's ids sort in declaration order. */
export function hypothesisId(family: string, ordinal: number): string {
  return `${family}-${String(ordinal).padStart(3, "0")}`;
}

/** Split a JSONL file into rows, counting what would not parse. */
function readJsonlRows(path: string): { rows: HypothesisRow[]; malformed: number } {
  if (!existsSync(path)) return { rows: [], malformed: 0 };
  const rows: HypothesisRow[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      rows.push(JSON.parse(text) as HypothesisRow);
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
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
export function readHypothesisSet(dir: string): HypothesisSet {
  const hypothesesDir = join(dir, "hypotheses");
  const files = existsSync(hypothesesDir)
    ? readdirSync(hypothesesDir)
        .filter((f) => f.endsWith(".jsonl"))
        .sort()
    : [];

  const records: HypothesisRecord[] = [];
  const families: string[] = [];
  let malformed = 0;
  let declared = 0;

  for (const file of files) {
    const family = basename(file, ".jsonl");
    families.push(family);
    const parsed = readJsonlRows(join(hypothesesDir, file));
    malformed += parsed.malformed;
    parsed.rows.forEach((row, index) => {
      const ordinal = index + 1;
      const declaredId = asString(row.id);
      if (declaredId) declared += 1;
      records.push({ id: hypothesisId(family, ordinal), family, ordinal, declaredId, row });
    });
  }

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

  return { records, byId, aliases, ambiguous, families, malformed, declared };
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
