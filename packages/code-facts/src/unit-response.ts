/**
 * The unit survey's RESPONSE — what one bounded, non-agentic model call per
 * unit must hand back, and how `units-ingest` reads it.
 *
 * ── Why the schema lives here ──────────────────────────────────────────────
 *
 * The request (`units.ts`) states this shape and the ingest validates against
 * it, so both halves are one module's constants. Core only does the model I/O:
 * its one check is {@link findUnitObject} + {@link isUsableUnitReply} — the
 * same two rules ingest applies, mirrored there case for case — enough to
 * decide its single retry and whether to cache; everything past that is
 * decided here, deterministically and testably without a model.
 *
 * ── What is deliberately NOT in it ─────────────────────────────────────────
 *
 * No `severity`, no `needsProbe`, no discharge code. All three are DERIVED from
 * the evidence record by `survey-verdict.ts`, exactly as they are for an agent
 * survey's rows — asking for a judgement made the answer depend on the
 * adjectives a prompt used, and identical evidence must rank identically
 * whichever engine wrote the row.
 *
 * The evidence record is the `survey-pass` skill's, field for field, typed
 * STRICTLY: a unit reply is a single JSON object a machine reads, so a value
 * outside the type is a defect in that entry rather than a spelling to guess
 * at. What ingest does with a defective entry is its business (it keeps the
 * claim and routes the row to a probe) — never a silent drop.
 */
import { z } from "zod";

/** The families a unit request can ask, and a unit reply can file under. */
export const UNIT_FAMILIES = ["contract", "enforcement", "security", "state", "spec", "tests"] as const;
export type UnitFamily = (typeof UNIT_FAMILIES)[number];

const TriState = z.union([z.boolean(), z.literal("unknown")]);

/** `SurveyEvidence` (survey-verdict.ts), with the types the skill documents. */
export const UnitEvidenceSchema = z.object({
  subject: z.string(),
  control_site: z.string(),
  control_text: z.string(),
  authority: z.enum(["binding", "advisory", "unknown"]),
  order_ok: TriState,
  cannot_distinguish: z.string(),
  bypass: z.string(),
  in_changed_hunk: z.boolean(),
  consequence: z.string().nullable(),
  trigger: z.enum(["input", "state", "code_change", "unknown"]),
  crosses_boundary: z.boolean(),
  capability_gained: z.string().nullable(),
});
export type UnitEvidence = z.infer<typeof UnitEvidenceSchema>;

const entryShape = {
  family: z.enum(UNIT_FAMILIES),
  /** One sentence: the residual risk, or what closes it. */
  claim: z.string().min(1),
  /**
   * The file the `line` tag belongs to. Needed only where a request shows more
   * than one file (the `pr` unit); a symbol or module unit's tags are all in
   * its own file, so an absent `file` means that one.
   */
  file: z.string().optional(),
  /** One of the request's line tags — `42` for `L0042`. */
  line: z.number().int().positive(),
  evidence: UnitEvidenceSchema,
};

/** The answer to one obligation the request listed. */
export const UnitAnswerSchema = z.object({ obligation: z.string().min(1), ...entryShape });
export type UnitAnswer = z.infer<typeof UnitAnswerSchema>;

/** A defect nobody asked about — the over-production the survey exists for. */
export const UnitDefectSchema = z.object(entryShape);
export type UnitDefect = z.infer<typeof UnitDefectSchema>;

/** ONE unit's reply body. `answers` holds every listed obligation exactly once. */
export const UnitResponseBodySchema = z.object({
  unitId: z.string().min(1),
  answers: z.array(UnitAnswerSchema),
  defects: z.array(UnitDefectSchema),
});
export type UnitResponseBody = z.infer<typeof UnitResponseBodySchema>;

/** The JSON Schema of {@link UnitResponseBodySchema}, for `units.json`'s `responseSchema`. */
export function unitResponseJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(UnitResponseBodySchema) as Record<string, unknown>;
}

/** `units/responses/<unitId>.json` — written by the core handler, read by ingest. */
export const UnitResponseFileSchema = z.looseObject({
  unitId: z.string(),
  model: z.string().nullish(),
  systemPromptSha256: z.string().nullish(),
  requestSha256: z.string().nullish(),
  ok: z.boolean(),
  cached: z.boolean().nullish(),
  attempts: z.number().nullish(),
  raw: z.string().nullish(),
  error: z.string().nullish(),
  usage: z.unknown().optional(),
  durationMs: z.number().nullish(),
});
export type UnitResponseFile = z.infer<typeof UnitResponseFileSchema>;

// ── Finding the reply object: THE canonical rule ────────────────────────────
//
// Two sides read a unit reply and they must agree on what counts as one: the
// core handler (`apps/server/src/workflows/handlers/survey-units.ts`) decides
// its single retry, and whether to cache, off it; `units-ingest` decides
// `ok` / `invalid` off it. When they disagreed — the handler tried every `{`,
// ingest stopped at the first unclosed one — a reply the handler accepted and
// cached could read `invalid` at ingest forever (a cached reading is never
// re-asked). So the rule lives HERE, specified by the two doc comments below
// and pinned by `tests/unit-reply.test.ts`, whose case table the handler's
// test copies verbatim. Change one side and the tables diverge.

/** Where the object opening at `start` closes (the index after it), or -1. String-aware; braces only. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * `JSON.parse`, plus ONE repair: a `"line"` number written with leading zeros.
 * The request tags lines `L0142`, and models copy the tag's padding into the
 * answer (`"line": 0142`) — invalid JSON, which lost a whole unit's reply in the
 * first replay smoke (1680-r1, Haiku 4.5). Only the `line` key is repaired, and
 * only on a span that failed to parse as written. The core handler mirrors this.
 */
export function parseReplyJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const repaired = text.replace(/("line"\s*:\s*)0+(\d)/g, "$1$2");
    if (repaired === text) throw err;
    return JSON.parse(repaired) as unknown;
  }
}

/**
 * Every balanced top-level `{…}` span of `text` that parses as a JSON object,
 * in order of appearance. An unclosed `{` is skipped and scanning CONTINUES one
 * character later (it never ends the scan); a balanced span that is not JSON
 * (prose in braces) is not a container either — scanning resumes one character
 * after its `{`, so an object inside it is still found. A span that parses is
 * consumed whole: objects nested inside it are not top-level.
 */
function balancedObjects(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("{", pos);
    if (start === -1) break;
    const end = closingBrace(text, start);
    if (end !== -1) {
      try {
        const value = parseReplyJson(text.slice(start, end));
        if (isPlainObject(value)) {
          out.push(value);
          pos = end;
          continue;
        }
      } catch {
        // Balanced, not JSON — fall through to the next brace.
      }
    }
    pos = start + 1;
  }
  return out;
}

/** The bodies of the ``` fences in `text`, in order. An unterminated fence has no body. */
function fenceBodies(text: string): string[] {
  return [...text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

/** Where {@link locateUnitObject} found the object — for the ingest report. */
export type UnitObjectVia = "whole" | "span" | "nested";

/**
 * {@link findUnitObject}, plus HOW it was found and every object's `unitId`
 * seen on the way (for an error that says what the reply named instead).
 */
export function locateUnitObject(
  raw: string,
  unitId: string,
): { value: Record<string, unknown> | null; via: UnitObjectVia | null; seenUnitIds: unknown[] } {
  const top = [raw, ...fenceBodies(raw)].flatMap(balancedObjects);
  const seenUnitIds = top.map((o) => o.unitId);
  const direct = top.find((o) => o.unitId === unitId);
  if (direct) {
    let whole = false;
    try {
      const parsed = parseReplyJson(raw.trim());
      whole = isPlainObject(parsed) && parsed.unitId === unitId;
    } catch {
      whole = false;
    }
    return { value: direct, via: whole ? "whole" : "span", seenUnitIds };
  }
  for (const o of top) {
    for (const v of Object.values(o)) {
      const inner = Array.isArray(v) ? v : [v];
      const hit = inner.find((e) => isPlainObject(e) && e.unitId === unitId);
      if (hit) return { value: hit as Record<string, unknown>, via: "nested", seenUnitIds };
    }
  }
  return { value: null, via: null, seenUnitIds };
}

/**
 * THE rule for finding a unit's reply object in a model's raw text. Pure.
 *
 *   1. Candidates are every balanced top-level `{…}` span that parses as a JSON
 *      object — first across the whole of `raw`, then inside each ``` fence
 *      body — in that order. Brace matching is string-aware (a `}` inside a
 *      JSON string does not close anything) and counts braces only. An
 *      unclosed `{` (a truncated reply, a stray brace in prose) is skipped and
 *      the scan continues from the next character; so is a balanced span that
 *      is not JSON.
 *   2. The FIRST candidate whose `unitId` is exactly `unitId` (string
 *      equality, no normalisation) is the reply.
 *   3. Otherwise, one level of nesting: for each candidate in order, each
 *      property value that is an object whose `unitId` is `unitId`, or an
 *      object element with that `unitId` of a property value that is an array.
 *      The first found is the reply (`{"result":{"unitId":"u-001",…}}`).
 *   4. Otherwise `null` — including when objects exist but none names this
 *      unit. An object naming ANOTHER unit is never this unit's reply.
 *
 * It does not validate the body; {@link isUsableUnitReply} is the structural
 * check applied to what this returns, and the schema is ingest's.
 */
export function findUnitObject(raw: string, unitId: string): Record<string, unknown> | null {
  return locateUnitObject(raw, unitId).value;
}

/**
 * THE structural rule for a usable reply — what the handler checks before it
 * calls a unit `ok` and caches it, and what ingest requires before reading a
 * single entry: `obj` is an object, its `unitId` is exactly `unitId`, and both
 * `answers` and `defects` are arrays (possibly empty). Nothing about the
 * entries — a malformed entry is ingest's to record, never a reason to re-ask.
 */
export function isUsableUnitReply(obj: unknown, unitId: string): obj is Record<string, unknown> & { answers: unknown[]; defects: unknown[] } {
  return isPlainObject(obj) && obj.unitId === unitId && Array.isArray(obj.answers) && Array.isArray(obj.defects);
}
