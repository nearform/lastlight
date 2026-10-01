/**
 * The re-review delta — which units of this head the LAST review already had,
 * byte for byte (issue #429).
 *
 * A re-review used to start from scratch: every unit surveyed, every site
 * re-ranked, so each round's five investigator slots landed on a different
 * slice of code that had not changed since round one, and found something
 * new there. Measured over nearform PRs: 46% of later-round comments sat on
 * unchanged code.
 *
 * The grain is the UNIT, not the line. A unit already has a stable identity
 * across heads — the file and the symbol it covers — so resyncing after a
 * push needs no line-translation engine and survives a force-push (where the
 * prior head is not an ancestor and no line diff between them exists):
 *
 * - `key` — `path::symbol` (`path::(module)` for a file's loose changed lines,
 *   `(pr)` for the PR-level unit), with `#n` only where two distinct units of
 *   one file would collide. A unit split into passes or by family shares its
 *   parent's key: it is one piece of code, surveyed in several requests.
 * - `contentSha` — sha256 of the unit's OWN lines (its cores, trailing
 *   whitespace dropped), never their line numbers, so an edit above a function
 *   does not make the function new. `null` for the `pr` unit, whose content
 *   is a set of obligations with run-minted ids: it is always in scope.
 *
 * Against the prior review's units (`prior-review.json`, written by the
 * workflow from core's ledger), each unit is:
 *
 * - `new` — its key was not in the last review;
 * - `changed` — same key, different content (or no content hash);
 * - `affected` — unchanged itself, but a caller or callee of it sits inside a
 *   new or changed unit, so a fix may have changed what it does;
 * - `unchanged` — the last review had exactly this code, and nothing it calls
 *   or is called by changed. Its hypothesis rows form no site.
 *
 * The unit delta decides only WHERE a re-review looks. Whether a finding is
 * a late discovery is decided per LINE ({@link anchorDelta}): each review
 * records the hashes of the lines its units covered, and a finding whose
 * anchored lines were all already there is on code the last review had.
 *
 * No `prior-review.json` (a first review) ⇒ no unit carries a `delta`, and
 * nothing downstream scopes or gates anything.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const PRIOR_REVIEW_FILE = "prior-review.json";

export const UNIT_DELTAS = ["new", "changed", "affected", "unchanged"] as const;
export const UnitDeltaSchema = z.enum(UNIT_DELTAS);
export type UnitDelta = z.infer<typeof UnitDeltaSchema>;

/** Is a unit in the re-review's scope? Everything but `unchanged`. */
export function inScope(delta: UnitDelta | undefined): boolean {
  return delta !== "unchanged";
}

export const PriorReviewSchema = z.object({
  version: z.literal(1),
  /** The head the prior review ran at — reported, never compared. */
  head: z.string().nullable(),
  units: z.array(z.object({ key: z.string(), contentSha: z.string().nullable() })),
  /**
   * Per file, the {@link lineHash}es of every non-trivial line the prior
   * review's units covered, concatenated (8 hex chars each). The convergence
   * gate's evidence: a finding whose anchored lines all hash in here sits on
   * code the last review already had. Optional — a ledger written before it,
   * or a file the cap dropped, falls back to the unit's `delta`.
   */
  files: z.record(z.string(), z.string()).optional(),
});
export type PriorReview = z.infer<typeof PriorReviewSchema>;

/**
 * Read the prior review. Absent ⇒ `{ prior: null, reason: null }` — a first
 * review, said nowhere because there is nothing wrong. Present but
 * unreadable ⇒ `null` WITH a reason, and the caller scopes nothing: a bad
 * ledger must cost the scoping, never the review.
 */
export function readPriorReview(dir: string, file?: string): { prior: PriorReview | null; reason: string | null } {
  const path = file ?? join(dir, PRIOR_REVIEW_FILE);
  if (!existsSync(path)) {
    return file ? { prior: null, reason: `prior review not found at ${path} — every unit is in scope` } : { prior: null, reason: null };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { prior: null, reason: `prior review at ${path} is unreadable (${err instanceof Error ? err.message : String(err)}) — every unit is in scope` };
  }
  const parsed = PriorReviewSchema.safeParse(raw);
  if (!parsed.success) {
    return { prior: null, reason: `prior review at ${path} is malformed (${parsed.error.issues[0]?.message ?? "invalid"}) — every unit is in scope` };
  }
  return { prior: parsed.data, reason: null };
}

/** sha256 of the lines inside `cores` (1-based, inclusive), trailing whitespace dropped, cores in order. */
export function contentShaOf(lines: readonly string[], cores: readonly (readonly [number, number])[]): string {
  const hash = createHash("sha256");
  const sorted = [...cores].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  sorted.forEach((core, i) => {
    if (i > 0) hash.update("\n\u0000\n");
    for (let l = core[0]; l <= core[1]; l++) hash.update(`${(lines[l - 1] ?? "").replace(/\s+$/, "")}\n`);
  });
  return hash.digest("hex");
}

/**
 * A line too generic to identify code — `}`, `return;`, `*\/` — has fewer
 * than {@link MIN_LINE_SIGNAL} word characters. Such lines appear everywhere,
 * so their presence says nothing about whether a finding's code is old.
 */
export const MIN_LINE_SIGNAL = 4;
export const LINE_HASH_CHARS = 8;

export function isTrivialLine(text: string): boolean {
  return text.replace(/\W/g, "").length < MIN_LINE_SIGNAL;
}

/** A line's identity, position-free: sha1 of its trimmed text, first {@link LINE_HASH_CHARS} hex chars. */
export function lineHash(text: string): string {
  return createHash("sha1").update(text.trim()).digest("hex").slice(0, LINE_HASH_CHARS);
}

/** The {@link lineHash}es of the non-trivial lines inside `cores`, concatenated. */
export function lineHashesOf(lines: readonly string[], cores: readonly (readonly [number, number])[]): string {
  const out: string[] = [];
  for (const core of cores) {
    for (let l = core[0]; l <= core[1]; l++) {
      const text = lines[l - 1] ?? "";
      if (!isTrivialLine(text)) out.push(lineHash(text));
    }
  }
  return out.join("");
}

/** A concatenated hash string as a set. */
export function hashSet(concatenated: string): Set<string> {
  const set = new Set<string>();
  for (let i = 0; i + LINE_HASH_CHARS <= concatenated.length; i += LINE_HASH_CHARS) set.add(concatenated.slice(i, i + LINE_HASH_CHARS));
  return set;
}

export type AnchorDelta = "new" | "unchanged";

/**
 * Is a finding's anchored code NEW since the prior review? The gate's
 * question, answered per LINE (issue #429): the unit grain decides where a
 * re-review looks, but a unit is too coarse to judge a finding. Measured on
 * lastlight#424's five re-review rounds (the $0 replay, real heads): 12 of the
 * 16 later comments sat in units a fix had touched or called into, while all
 * 16 sat on lines that were already there the round before — so the unit
 * gate posted 12 and this one withholds all 16 (every one Minor). The other
 * direction holds too: the lines it calls new per push (6 / 22 / 44 / 33 / 11)
 * track git's added lines (6 / 27 / 63 / 50 / 11) less trivial lines and
 * files no unit covers.
 *
 * `null` = no prior review (a first review: nothing is gated). Otherwise
 * `unchanged` when every non-trivial anchored line hashes into the prior
 * review's lines for that file; `new` when any does not, or when the prior
 * review recorded no lines for the file at all (it never covered it). With no
 * non-trivial line to test, `fallback` decides — the containing unit's delta.
 */
export function anchorDelta(
  prior: PriorReview | null,
  path: string,
  anchorTexts: readonly string[],
  fallback: UnitDelta | undefined,
): AnchorDelta | null {
  if (!prior) return null;
  const signal = anchorTexts.filter((t) => !isTrivialLine(t));
  const recorded = prior.files?.[path];
  if (signal.length === 0 || recorded === undefined) {
    if (signal.length === 0 && fallback !== undefined) return fallback === "unchanged" ? "unchanged" : "new";
    return "new";
  }
  const before = hashSet(recorded);
  return signal.every((t) => before.has(lineHash(t))) ? "unchanged" : "new";
}

/** A unit's base key, before collisions are numbered. */
export function baseUnitKey(kind: "symbol" | "module" | "pr", file: string | null, symbol: string | null): string {
  if (kind === "pr" || file === null) return "(pr)";
  return kind === "module" ? `${file}::(module)` : `${file}::${symbol ?? "(anonymous)"}`;
}

/**
 * Number colliding keys in the order given (callers pass units in file and
 * line order): the first keeps its base key, the next is `<key>#2`, and so on.
 * Ordered by line, so an overload's identity survives an edit to its sibling.
 */
export function numberKeys(bases: readonly string[]): string[] {
  const seen = new Map<string, number>();
  return bases.map((b) => {
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    return n === 1 ? b : `${b}#${n}`;
  });
}

export interface DeltaInput {
  key: string;
  contentSha: string | null;
  file: string | null;
  /** The unit's own lines at head. */
  cores: readonly (readonly [number, number])[];
  /** `path:line` sites of its callers and of its callees' declarations. */
  neighbourSites: readonly string[];
}

function siteOf(at: string): { path: string; line: number } | null {
  const m = /^(.*):(\d+)$/.exec(at);
  return m ? { path: m[1]!, line: Number(m[2]) } : null;
}

/** Pure: one delta per input, in input order. */
export function classifyDelta(units: readonly DeltaInput[], prior: PriorReview): UnitDelta[] {
  const before = new Map(prior.units.map((u) => [u.key, u.contentSha]));
  const first: UnitDelta[] = units.map((u) => {
    if (!before.has(u.key)) return "new";
    const was = before.get(u.key);
    return u.contentSha !== null && was === u.contentSha ? "unchanged" : "changed";
  });
  // Where the new and changed code is, by file.
  const moved = new Map<string, (readonly [number, number])[]>();
  units.forEach((u, i) => {
    if (first[i] === "unchanged" || u.file === null) return;
    moved.set(u.file, [...(moved.get(u.file) ?? []), ...u.cores]);
  });
  return units.map((u, i) => {
    if (first[i] !== "unchanged") return first[i]!;
    const touchesMoved = u.neighbourSites.some((at) => {
      const site = siteOf(at);
      return site !== null && (moved.get(site.path) ?? []).some((c) => site.line >= c[0] && site.line <= c[1]);
    });
    return touchesMoved ? "affected" : "unchanged";
  });
}
