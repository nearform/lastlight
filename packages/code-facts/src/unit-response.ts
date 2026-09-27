/**
 * The unit survey's RESPONSE — what one bounded, non-agentic model call per
 * unit must hand back, and how `units-ingest` reads it.
 *
 * ── Why the schema lives here ──────────────────────────────────────────────
 *
 * The request (`units.ts`) states this shape and the ingest validates against
 * it, so both halves are one module's constants. Core only does the model I/O:
 * its one check is "the raw text holds a JSON object whose `unitId` is this
 * unit's" — enough to decide its single retry — and everything past that is
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

/** Where the value opening at `start` closes (the index after it), or -1. String-aware. */
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

/** Every top-level `{…}` span in `text` that parses as a JSON object, in order. */
function objectsIn(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("{", pos);
    if (start === -1) break;
    const end = closingBrace(text, start);
    if (end === -1) break;
    try {
      const value = JSON.parse(text.slice(start, end)) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        out.push(value as Record<string, unknown>);
        pos = end;
        continue;
      }
    } catch {
      // Not JSON from this brace — try the next one.
    }
    pos = start + 1;
  }
  return out;
}

export interface ExtractedObject {
  /** The object, or `null` when the text held none. */
  value: Record<string, unknown> | null;
  /** How it was found — for the ingest report, so a sloppy reply stays visible. */
  via: "whole" | "fence" | "scan" | null;
}

/**
 * The JSON object in a model's reply, tolerating the two things models do
 * anyway: a code fence around it, and prose before or after it.
 *
 * Preference order: the whole text; then each fenced block; then every
 * brace-balanced span. Within each tier an object whose `unitId` equals
 * `unitId` wins over one that does not — a reply that quotes a snippet of JSON
 * from the source before its answer must not have the snippet read as the
 * answer.
 */
export function extractResponseObject(raw: string, unitId: string): ExtractedObject {
  const pick = (candidates: Record<string, unknown>[]): Record<string, unknown> | null =>
    candidates.find((c) => c.unitId === unitId) ?? null;

  const trimmed = raw.trim();
  try {
    const whole = JSON.parse(trimmed) as unknown;
    if (whole && typeof whole === "object" && !Array.isArray(whole)) {
      return { value: whole as Record<string, unknown>, via: "whole" };
    }
  } catch {
    // fall through
  }

  const fenced: Record<string, unknown>[] = [];
  for (const match of raw.matchAll(/```[a-zA-Z0-9_-]*[ \t]*\n([\s\S]*?)```/g)) {
    fenced.push(...objectsIn(match[1] ?? ""));
  }
  const fromFence = pick(fenced);
  if (fromFence) return { value: fromFence, via: "fence" };

  const scanned = objectsIn(raw);
  const fromScan = pick(scanned);
  if (fromScan) return { value: fromScan, via: "scan" };

  const any = fenced[0] ?? scanned[0] ?? null;
  return { value: any, via: any ? (fenced[0] ? "fence" : "scan") : null };
}
