/**
 * `lastlight-facts units-ingest` — the unit survey's replies, turned into the
 * EXISTING `hypotheses/<family>.jsonl` rows.
 *
 * `hypotheses/<family>.jsonl` is the interface every later phase reads —
 * `discharge`, `requiresProbe`, `site-plan`, the `findings` conservation floor,
 * `stampDerivedSeverity` — so a unit-survey row is shaped exactly like the
 * (since removed) agent survey's rows, plus two fields: `source: "units"` and
 * `unitId`.
 *
 * ── Conservation, again ────────────────────────────────────────────────────
 *
 * Every obligation a unit owned gets a row, whatever happened to the unit. A
 * reply that is missing, failed (`ok: false`), stale (answers a different
 * request), unparseable or silent about an obligation still produces a row for
 * it: the claim says the unit survey could not answer it, the evidence is
 * honestly `unknown`, and `deriveVerdict` routes that to a probe. *We could not
 * look* and *we looked and it is clean* stay different facts; a model's
 * silence is never read as the second.
 *
 * A malformed ENTRY keeps its claim — the row says the answer failed
 * validation and why, with unknown evidence — rather than being dropped. A
 * `line` that is not one of the request's tags keeps the row and loses only
 * its location, because the text of a quote is filled from the request itself
 * and cannot be filled from a line the model was never shown.
 *
 * ── What is derived here, not asked ────────────────────────────────────────
 *
 * The row's `discharge` code is `deriveVerdict(evidence).discharge` — QUOTE /
 * PARTIAL / ABSENT — or `PROBE` for a row nobody answered. `severity` is never
 * written: every reader derives it from `evidence`, exactly as for an agent
 * survey's rows. `needsProbe` is written on exactly one kind of row — see
 * {@link unansweredRow} for why that one row declares it.
 *
 * ── Spec obligations ───────────────────────────────────────────────────────
 *
 * `units.json` records the spec obligations its requests carried
 * (`specObligations`, from core's `spec-obligations.json`), and an `S-n`
 * answer becomes a `hypotheses/spec.jsonl` row in the shape the agent `spec`
 * survey is told to write (`review-spec.ts`'s `rowShape`): `obligation: "S-n"`,
 * `bothEnds.introducedAt` the criterion's SOURCE (`issue #12` / `the PR body`
 * — this family's first end is a document), and a `path` naming the changed
 * file the row is about.
 *
 * ── Demotion: one typed field, never prose ─────────────────────────────────
 *
 * An UNPROMPTED defect whose `evidence.trigger` is `code_change` is not written
 * to `hypotheses/` — it is recorded in `ingest.json` (see {@link demotionOf}).
 * An obligation's answer is never demoted, whatever its trigger.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import { checkDischarge } from "./discharge.js";
import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE, reasonOf, type ExitCode } from "./errors.js";
import { hypothesisId } from "./hypotheses.js";
import { noopLogger, type LoggerPort } from "./log.js";
import type { Obligation, ObligationsDocument } from "./seed.js";
import { deriveVerdict, type SurveyEvidence } from "./survey-verdict.js";
import {
  isUsableUnitReply,
  locateUnitObject,
  UNIT_FAMILIES,
  UnitAnswerSchema,
  UnitDefectSchema,
  UnitResponseFileSchema,
  type UnitEvidence,
  type UnitObjectVia,
} from "./unit-response.js";
import { NOTHING_TO_SURVEY, parseUnitsDocument, SpecObligationSetSchema, type AnyUnitsDocument, type Unit } from "./units.js";
import { requestLineTags, type SpecUnitObligation, type TaggedLine } from "./units-render.js";

/**
 * `ok` every obligation answered by a valid entry · `partial` the reply parsed but
 * something in it did not (an unanswered obligation, an unreadable entry) ·
 * `missing` / `failed` / `stale` / `invalid` no usable reply at all.
 */
export type UnitIngestStatus = "ok" | "partial" | "missing" | "failed" | "stale" | "invalid";

export interface UnitIngestReport {
  unitId: string;
  kind: Unit["kind"];
  file: string | null;
  symbol: string | null;
  status: UnitIngestStatus;
  /** How `findUnitObject` found the reply in `raw` — `null` when it did not. */
  via: UnitObjectVia | null;
  /** Rows this unit contributed, by canonical id. */
  rows: string[];
  /** Obligations the reply answered with a valid entry. */
  answered: string[];
  /** Obligations it did not — each still got a row, with unknown evidence. */
  unanswered: string[];
  /** Problems that cost an answer. */
  errors: string[];
  /** Problems that cost only a location or a label. */
  warnings: string[];
  /**
   * Entries (an obligation id, or `defect #n`) whose evidence names no holding
   * control — `control_site` none/unknown, or an `advisory` authority — yet
   * whose `consequence` is null. The request forbids that pairing; the row is
   * still written as the model wrote it (see {@link consequenceGap}).
   */
  consequenceGaps: string[];
  /**
   * Unprompted defects NOT written to `hypotheses/` — each entry in full, with
   * why. Only ever an unprompted defect; see {@link demotionOf}.
   */
  demoted: DemotedEntry[];
}

/** Why an unprompted defect was demoted. One typed-field rule today. */
export type DemotionReason = "code_change";

/** An unprompted defect kept out of `hypotheses/`, recorded as the model wrote it. */
export interface DemotedEntry {
  /** `defect #n`, the same label warnings and `consequenceGaps` use. */
  label: string;
  family: string;
  claim: string;
  /** The FILE the entry named, else the unit's. */
  file: string | null;
  /** The `line` as the reply wrote it — not checked against the request's tags. */
  line: unknown;
  evidence: UnitEvidence;
  reason: DemotionReason;
}

export interface IngestDocument {
  version: 1;
  generatedAt: string;
  promptVersion: string | null;
  /** False ⇒ units.json could not be read; rows were built from obligations.json alone. */
  unitsRead: boolean;
  /**
   * What `units.json` said, in one word: `surveyed` (it holds units) ·
   * `nothing-to-survey` (empty, and that is a clean answer) · `not-surveyed`
   * (empty because a phase failed — a dead process, a missing input — so
   * NOBODY looked) · `unreadable`.
   */
  unitsState: "surveyed" | "nothing-to-survey" | "not-surveyed" | "unreadable";
  /** Why, in `units.json`'s own words (its last `degraded[]` reason), or the read error. */
  unitsReason: string | null;
  units: UnitIngestReport[];
  rowsByFamily: Record<string, number>;
  /** How many unprompted defects were demoted across every unit (each is in its unit's `demoted`). */
  demotedCount: number;
  discharge: { family: string; satisfied: boolean; notes: string[] }[];
  /** Every unit answered AND every family's discharge gate passed. */
  satisfied: boolean;
  notes: string[];
}

export interface IngestUnitsOptions {
  /** The `.lastlight/pr-review` directory. */
  dir: string;
  log?: LoggerPort;
}

export interface IngestUnitsResult {
  document: IngestDocument;
  exitCode: ExitCode;
}

/** The families a zero-obligation placeholder is owed to when nothing says otherwise. */
const DEFAULT_SURVEYED = ["contract", "enforcement", "security", "state"];

type Row = Record<string, unknown> & { family: string };

/**
 * The record for a question nobody answered. `control_site: "unknown"` is not
 * a spelling the survey skill offers a model, and that is the point: it is not
 * a model's answer. It derives to PARTIAL with `needsProbe` (authority and
 * `cannot_distinguish` unknown), severity Minor — a probe is asked for, and
 * nothing is ranked on a guess.
 */
function unknownEvidence(subject: string): Record<string, unknown> {
  return {
    subject,
    control_site: "unknown",
    control_text: "",
    authority: "unknown",
    order_ok: "unknown",
    cannot_distinguish: "unknown — the unit survey did not answer this",
    bypass: "unknown — not searched",
    in_changed_hunk: "unknown",
    consequence: null,
    trigger: "unknown",
    crosses_boundary: "unknown",
    capability_gained: null,
  };
}

/**
 * The row for an obligation the model did not answer — its unit's reply was
 * missing, failed, stale or invalid, or the reply skipped (or garbled) this
 * obligation — or that no unit carried at all.
 *
 * **`needsProbe: true` is stamped here, and this is the ONE row that declares
 * it.** `requiresProbe` (probes.ts) — the `falsify` gate's reading of which
 * rows it owes a verdict on — reads the RAW `row.needsProbe`, or a Critical
 * severity; it never derives. So a row whose evidence derives to "probe it"
 * but declares nothing is never required to be probed, and an unanswered
 * obligation derives to Minor, so the Critical override never fires either:
 * the rows that most need a second look were the ones `falsify` could skip.
 * Changing `requiresProbe` to derive would move the agent-survey baseline
 * mid-experiment, so the declaration is made where the fact is known. It
 * agrees with the derivation (`unknownEvidence` derives `needsProbe` true), so
 * the declared-vs-derived hygiene report stays clean. An ANSWERED row never
 * carries it — its probe need is the evidence's, as for an agent row.
 */
function unansweredRow(o: Owed, unitId: string | null, why: string): Row {
  return {
    family: o.family,
    obligation: o.id,
    ...(o.spec ? { path: o.path } : {}),
    discharge: "PROBE",
    claim: `the unit survey could not answer ${o.id} (${why}) — unanswered, not clean: ${o.question}`,
    bothEnds: { introducedAt: o.introducedAt, enforcedAt: null },
    quotes: [],
    existingCode: null,
    failureScenario: null,
    evidence: unknownEvidence(o.subject),
    needsProbe: true,
    source: "units",
    unitId,
  };
}

/**
 * Does this evidence say "no control holds" while claiming nothing goes wrong?
 *
 * The checkable half of the v6 answer rule: a null `consequence` belongs only
 * to an answer that quotes a control that holds. The v5 replay audit found 198
 * of 482 answers with `control_site: "none"` and a null consequence (89% of all
 * answers had it null) — the verdict "no comparison found" living only in
 * evidence fields the judge never reads. Ingest RECORDS the gap (a warning and
 * `consequenceGaps` in `ingest.json`); it never rewrites the model's text or
 * drops the row, so conservation and the derived verdict are untouched.
 * (`bypass` is free text, so "bypassable" is left to the prompt.)
 */
function consequenceGap(evidence: UnitEvidence): boolean {
  if (evidence.consequence !== null) return false;
  return siteOrNull(evidence.control_site) === null || evidence.authority === "advisory";
}

/**
 * Is this parsed UNPROMPTED defect kept out of `hypotheses/`? Only on a typed
 * field — `evidence.trigger === "code_change"`, the model's own label for "only
 * if someone later edits the code" — and never on the claim's wording: no
 * prose or regex test of any kind lives here.
 *
 * Measured: the v1 replay (8 skillspro cases × 2 arms, 50 gold) wrote 764
 * unprompted defects, 320 of them `code_change` — and the judge credited 0 of
 * those 320 with a gold, while the ~419 input/state/unknown defects carried 8
 * credits. Asking the model to hold such defects back (v4–v6's DEFECT BAR)
 * cost breadth and credited gold with them; removing them here, by the field,
 * costs nothing the replay ever credited. The entry is still recorded in full in
 * `ingest.json`, so a later audit can re-admit it.
 *
 * An OBLIGATION's answer never reaches this: conservation owes every
 * obligation exactly one row, whatever its trigger.
 */
function demotionOf(evidence: UnitEvidence): DemotionReason | null {
  return evidence.trigger === "code_change" ? "code_change" : null;
}

function siteOrNull(site: string): string | null {
  const s = site.trim().toLowerCase();
  return s === "" || s === "none" || s === "unknown" ? null : site;
}

/** `L0042` (a tag, copied) → `path:42`. Anything else is left as written. */
function normaliseControlSite(site: string, file: string | null): string {
  const match = /^L(\d+)$/.exec(site.trim());
  return match && file ? `${file}:${Number(match[1])}` : site;
}

const LenientAnswer = UnitAnswerSchema.extend({ line: z.unknown().optional(), file: z.unknown().optional() });
const LenientDefect = UnitDefectSchema.extend({ line: z.unknown().optional(), file: z.unknown().optional() });

function issuesOf(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join(".") || "(entry)"}: ${i.message}`)
    .join("; ");
}

interface Located {
  path: string;
  line: number;
  text: string;
}

function locate(
  entry: { line?: unknown; file?: unknown },
  unit: Unit,
  tags: Map<string, Map<number, TaggedLine>>,
  warn: (w: string) => void,
): Located | null {
  const file = typeof entry.file === "string" && entry.file.length > 0 ? entry.file : unit.file;
  const line = entry.line;
  if (typeof line !== "number" || !Number.isInteger(line)) {
    warn(`an entry has no integer \`line\` (${JSON.stringify(line) ?? "absent"}) — kept without a location`);
    return null;
  }
  if (file === null) {
    warn(`an entry at line ${line} names no \`file\` and the unit has none — kept without a location`);
    return null;
  }
  const shown = tags.get(file)?.get(line);
  if (!shown) {
    warn(`${file}:${line} is not a line tag this request showed — kept without a location`);
    return null;
  }
  return { path: file, line, text: shown.text };
}

/**
 * Read `units/responses/<id>.json` into a verdict on the unit plus its parsed
 * body. The body is found by `findUnitObject` and accepted by
 * `isUsableUnitReply` — the SAME two rules the core handler applies before it
 * calls a unit `ok` and caches it, so a reading the handler kept is a reading
 * ingest can read.
 */
function readResponse(
  dir: string,
  unit: Unit,
): { status: UnitIngestStatus; body: Record<string, unknown> | null; via: UnitIngestReport["via"]; error: string | null } {
  const path = join(dir, "units", "responses", `${unit.id}.json`);
  if (!existsSync(path)) return { status: "missing", body: null, via: null, error: `no response at ${path}` };
  let parsed: z.infer<typeof UnitResponseFileSchema>;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    const result = UnitResponseFileSchema.safeParse(raw);
    if (!result.success) {
      return { status: "invalid", body: null, via: null, error: `response file does not validate: ${issuesOf(result.error)}` };
    }
    parsed = result.data;
  } catch (err) {
    return { status: "invalid", body: null, via: null, error: `response file is not readable JSON: ${reasonOf(err)}` };
  }
  if (parsed.unitId !== unit.id) {
    return { status: "invalid", body: null, via: null, error: `response file names unit ${parsed.unitId}, not ${unit.id}` };
  }
  if (parsed.requestSha256 && parsed.requestSha256 !== unit.requestSha256) {
    return {
      status: "stale",
      body: null,
      via: null,
      error: `response answers request ${parsed.requestSha256.slice(0, 12)}, but units.json now holds ${unit.requestSha256.slice(0, 12)} — a reading of a different request is not an answer to this one`,
    };
  }
  if (!parsed.ok) {
    return { status: "failed", body: null, via: null, error: `the call failed: ${parsed.error ?? "no error recorded"}` };
  }
  const found = locateUnitObject(parsed.raw ?? "", unit.id);
  if (!found.value) {
    return {
      status: "invalid",
      body: null,
      via: null,
      error:
        found.seenUnitIds.length === 0
          ? "`raw` holds no JSON object"
          : `\`raw\` holds ${found.seenUnitIds.length} JSON object(s), none whose unitId is "${unit.id}" (saw ${found.seenUnitIds.slice(0, 5).map((v) => JSON.stringify(v) ?? "none").join(", ")})`,
    };
  }
  if (!isUsableUnitReply(found.value, unit.id)) {
    const missing = ["answers", "defects"].filter((k) => !Array.isArray(found.value![k]));
    return {
      status: "invalid",
      body: null,
      via: found.via,
      error: `the reply object is not usable: ${missing.map((k) => `\`${k}\``).join(" and ")} ${missing.length > 1 ? "are" : "is"} not an array`,
    };
  }
  return { status: "ok", body: found.value, via: found.via, error: null };
}

/**
 * An obligation a unit owed an answer to, whichever document it came from —
 * the seeder's `obligations.json` or core's spec obligations — reduced to what
 * a row needs.
 */
interface Owed {
  id: string;
  family: string;
  question: string;
  /** The evidence record's `subject` when nobody answered. */
  subject: string;
  /** `bothEnds.introducedAt`: `path:line` for a seeded obligation, the criterion's source for a spec one. */
  introducedAt: string;
  /** Spec only: the changed file the row is about (its best candidate) — the spec row shape's `path`. */
  path: string | null;
  spec: boolean;
}

function owedFromSeed(o: Obligation): Owed {
  const at = `${o.introducedAt.path}:${o.introducedAt.line}`;
  return { id: o.id, family: o.family, question: o.question, subject: o.mechanism || at, introducedAt: at, path: null, spec: false };
}

function owedFromSpec(o: SpecUnitObligation): Owed {
  return {
    id: o.id,
    family: "spec",
    question: o.question,
    subject: `acceptance criterion (${o.source}): ${o.criterion}`,
    introducedAt: o.source,
    path: o.candidates[0] ?? null,
    spec: true,
  };
}

/** Spec obligations when units.json cannot say which were asked: core's file, read directly. */
function loadSpecFile(dir: string): SpecUnitObligation[] {
  try {
    const parsed = SpecObligationSetSchema.safeParse(JSON.parse(readFileSync(join(dir, "spec-obligations.json"), "utf8")));
    return parsed.success ? parsed.data.obligations : [];
  } catch {
    return [];
  }
}

function loadObligations(dir: string): { doc: ObligationsDocument | null; byId: Map<string, Obligation> } {
  const path = join(dir, "obligations.json");
  try {
    const doc = JSON.parse(readFileSync(path, "utf8")) as ObligationsDocument;
    const list = Array.isArray(doc.obligations) ? doc.obligations : [];
    return { doc, byId: new Map(list.map((o) => [o.id, o])) };
  } catch {
    return { doc: null, byId: new Map() };
  }
}

function writeJsonl(path: string, rows: Record<string, unknown>[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""), "utf8");
  renameSync(tmp, path);
}

/**
 * Ingest every unit reply. Writes `hypotheses/<family>.jsonl` and
 * `units/ingest.json`; never throws on a bad reply.
 */
export function ingestUnits(options: IngestUnitsOptions): IngestUnitsResult {
  const log = options.log ?? noopLogger;
  const { dir } = options;
  const notes: string[] = [];

  let unitsDoc: AnyUnitsDocument | null = null;
  let unitsReason: string | null = null;
  const unitsPath = join(dir, "units.json");
  try {
    const result = parseUnitsDocument(JSON.parse(readFileSync(unitsPath, "utf8")));
    if (result.success) unitsDoc = result.data;
    else unitsReason = `${unitsPath} does not validate (${issuesOf(result.error)})`;
  } catch (err) {
    unitsReason = `${unitsPath} is not readable (${reasonOf(err)})`;
  }
  if (unitsReason) notes.push(unitsReason);
  // An EMPTY document is a clean answer only when the assembler said there was
  // nothing to survey. A missing input or a process the shell caught dying
  // (the fallback document) also has no units — and means nobody looked.
  const lastReason = unitsDoc?.degraded.map((d) => d.reason).at(-1) ?? null;
  const unitsState: IngestDocument["unitsState"] = !unitsDoc
    ? "unreadable"
    : unitsDoc.units.length > 0
      ? "surveyed"
      : unitsDoc.degraded.some((d) => d.reason.startsWith(NOTHING_TO_SURVEY))
        ? "nothing-to-survey"
        : "not-surveyed";
  if (unitsDoc) unitsReason = lastReason;
  if (unitsState === "not-surveyed") {
    notes.push(`units.json holds no unit because the units phase did not survey: ${lastReason ?? "no reason recorded"} — every obligation below is unanswered, NOT clean`);
  }

  const { doc: obligationsDoc, byId: seedById } = loadObligations(dir);
  if (!obligationsDoc) notes.push("obligations.json is not readable — answers are filed under the family the reply names");
  // The spec obligations the requests were rendered with; core's file only when
  // units.json cannot say (so an unreadable document still conserves them).
  const specList = unitsDoc?.specObligations ?? (unitsDoc && unitsDoc.units.length > 0 ? [] : loadSpecFile(dir));
  const obligationById = new Map<string, Owed>([
    ...[...seedById.values()].map((o): [string, Owed] => [o.id, owedFromSeed(o)]),
    ...specList.map((o): [string, Owed] => [o.id, owedFromSpec(o)]),
  ]);

  const rows: Row[] = [];
  const reports: UnitIngestReport[] = [];

  const unanswered = (o: Owed, unitId: string | null, why: string): Row => unansweredRow(o, unitId, why);

  const units = unitsDoc?.units ?? [];
  const owned = new Set<string>();
  /** Each report's rows, as a [start, end) span of `rows` — ids are assigned once every row exists. */
  const spans = new Map<UnitIngestReport, [number, number]>();
  for (const unit of units) {
    const report: UnitIngestReport = {
      unitId: unit.id,
      kind: unit.kind,
      file: unit.file,
      symbol: unit.symbol,
      status: "ok",
      via: null,
      rows: [],
      answered: [],
      unanswered: [],
      errors: [],
      warnings: [],
      consequenceGaps: [],
      demoted: [],
    };
    reports.push(report);
    const startRow = rows.length;
    for (const id of unit.obligationIds) owned.add(id);

    const response = readResponse(dir, unit);
    report.status = response.status;
    report.via = response.via;
    if (response.error) report.errors.push(response.error);
    const tags = requestLineTags(unit.request);
    const warn = (w: string): void => {
      report.warnings.push(w);
    };

    const answeredIds = new Set<string>();
    let defectIndex = 0;
    if (response.body) {
      const body = response.body;
      // `readResponse` only returns a body `isUsableUnitReply` accepted.
      const answers = body.answers as unknown[];
      const defects = body.defects as unknown[];

      const fromEntry = (
        raw: unknown,
        asAnswer: boolean,
      ): void => {
        const schema = asAnswer ? LenientAnswer : LenientDefect;
        const parsed = schema.safeParse(raw);
        const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const obligationId = asAnswer && typeof entry.obligation === "string" ? entry.obligation : null;
        const obligation = obligationId ? (obligationById.get(obligationId) ?? null) : null;

        if (asAnswer && obligationId !== null) {
          if (!unit.obligationIds.includes(obligationId)) {
            warn(`answers ${obligationId}, which this unit was not asked — kept as an unprompted defect`);
            fromEntry({ ...entry, obligation: undefined }, false);
            return;
          }
          if (answeredIds.has(obligationId)) {
            warn(`answers ${obligationId} more than once — the repeat is kept as an unprompted defect`);
            fromEntry({ ...entry, obligation: undefined }, false);
            return;
          }
        }

        if (!parsed.success) {
          const claim = typeof entry.claim === "string" && entry.claim.trim() ? entry.claim.trim() : null;
          const family =
            obligation?.family ??
            (typeof entry.family === "string" && (UNIT_FAMILIES as readonly string[]).includes(entry.family) ? entry.family : null);
          const problem = issuesOf(parsed.error);
          if (obligation) {
            // Not answered: the obligation's fallback row below carries it,
            // with the claim the model did write, so nothing it said is lost.
            report.errors.push(`the answer to ${obligation.id} failed validation (${problem})`);
            rows.push({
              ...unanswered(obligation, unit.id, `its answer failed validation: ${problem}`),
              ...(claim ? { claim: `the unit survey's answer to ${obligation.id} failed validation (${problem}); it said: ${claim}` } : {}),
            });
            answeredIds.add(obligation.id);
            report.unanswered.push(obligation.id);
            return;
          }
          if (!claim || !family) {
            report.errors.push(`an entry with no usable claim or family was unreadable (${problem})`);
            return;
          }
          report.errors.push(`a ${family} entry failed validation (${problem}) — kept, with unknown evidence`);
          rows.push({
            family,
            discharge: "PROBE",
            claim: `the unit survey's entry failed validation (${problem}); it said: ${claim}`,
            bothEnds: { introducedAt: unit.file && unit.lines ? `${unit.file}:${unit.lines[0]}` : null, enforcedAt: null },
            quotes: [],
            existingCode: null,
            failureScenario: null,
            evidence: unknownEvidence(unit.symbol ?? unit.file ?? unit.id),
            source: "units",
            unitId: unit.id,
          });
          return;
        }

        const value = parsed.data as z.infer<typeof LenientDefect> & { obligation?: string };
        if (!obligation) {
          const reason = demotionOf(value.evidence);
          if (reason) {
            report.demoted.push({
              label: `defect #${++defectIndex}`,
              family: value.family,
              claim: value.claim,
              file: typeof entry.file === "string" && entry.file.length > 0 ? entry.file : unit.file,
              line: entry.line ?? null,
              evidence: value.evidence,
              reason,
            });
            return;
          }
        }
        const located = locate(entry, unit, tags, warn);
        const evidence: UnitEvidence = {
          ...value.evidence,
          control_site: normaliseControlSite(value.evidence.control_site, located?.path ?? unit.file),
        };
        const family = obligation?.family ?? value.family;
        if (obligation && value.family !== obligation.family) {
          warn(`${obligation.id} is a ${obligation.family} obligation; the reply filed it under ${value.family} — filed under ${obligation.family}`);
        }
        const label = obligation ? obligation.id : `defect #${++defectIndex}`;
        if (!obligation && unit.family && value.family !== unit.family) {
          warn(`${label} is filed under ${value.family}, but this unit asked only ${unit.family} — kept under ${value.family}`);
        }
        if (consequenceGap(evidence)) {
          report.consequenceGaps.push(label);
          warn(
            `${label}: no holding control (control_site ${JSON.stringify(evidence.control_site)}, authority ${evidence.authority}) but consequence is null — recorded as written`,
          );
        }
        const introducedAt = obligation
          ? obligation.introducedAt
          : located
            ? `${located.path}:${located.line}`
            : unit.file && unit.lines
              ? `${unit.file}:${unit.lines[0]}`
              : null;
        rows.push({
          family,
          ...(obligation ? { obligation: obligation.id } : {}),
          ...(family === "spec" ? { path: located?.path ?? unit.file ?? obligation?.path ?? null } : {}),
          discharge: deriveVerdict(evidence as SurveyEvidence).discharge,
          claim: value.claim,
          bothEnds: { introducedAt, enforcedAt: siteOrNull(evidence.control_site) },
          quotes: located ? [{ path: located.path, line: located.line, text: located.text }] : [],
          existingCode: located ? located.text : null,
          failureScenario: evidence.consequence,
          evidence,
          source: "units",
          unitId: unit.id,
        });
        if (obligation) {
          answeredIds.add(obligation.id);
          report.answered.push(obligation.id);
        }
      };

      for (const raw of answers) fromEntry(raw, true);
      for (const raw of defects) fromEntry(raw, false);
    }

    // Every obligation this unit owned and no valid entry answered.
    for (const id of unit.obligationIds) {
      if (answeredIds.has(id)) continue;
      const o = obligationById.get(id);
      if (!o) {
        report.errors.push(`${id} is not in obligations.json — no row can be filed for it`);
        continue;
      }
      const why = response.status === "ok" ? "the reply did not answer it" : `${response.status}: ${response.error ?? "no reply"}`;
      if (response.status === "ok") report.errors.push(`the reply did not answer ${id}`);
      rows.push(unanswered(o, unit.id, why));
      report.unanswered.push(id);
    }
    if (report.status === "ok" && report.errors.length > 0) report.status = "partial";
    spans.set(report, [startRow, rows.length]);
  }

  // An obligation no unit owned — units.json unreadable, empty because the
  // phase died, or written before the obligations were — is still conserved.
  const orphans = [...obligationById.values()].filter((o) => !owned.has(o.id)).sort((a, b) => a.id.localeCompare(b.id));
  const orphanWhy =
    unitsState === "unreadable"
      ? "units.json was not readable"
      : unitsState === "not-surveyed"
        ? `the units phase did not survey: ${lastReason ?? "no reason recorded"}`
        : "no unit carried it";
  for (const o of orphans) rows.push(unanswered(o, null, orphanWhy));
  if (orphans.length > 0) notes.push(`${orphans.length} obligation(s) no unit carried got an unanswered row: ${orphans.map((o) => o.id).join(", ")}`);

  // A measured family with no obligation needs a row of its own, or its gate
  // reads "surveyed nothing". The row says what actually happened.
  const answeredUnits = reports.filter((r) => r.status === "ok" || r.status === "partial").length;
  const demotedIn = (family: string): string => {
    const n = reports.reduce((sum, r) => sum + r.demoted.filter((d) => d.family === family).length, 0);
    return n > 0 ? ` (${n} ${family} defect(s) were demoted as code_change — see units/ingest.json)` : "";
  };
  const placeholderFamilies = obligationsDoc
    ? obligationsDoc.families.filter((f) => f.measured && f.family !== "spec" && f.obligations === 0).map((f) => f.family as string)
    : DEFAULT_SURVEYED;
  for (const family of placeholderFamilies) {
    if (rows.some((r) => r.family === family)) continue;
    const claim = !unitsDoc
      ? `the unit survey could not look: units.json was not readable, so the ${family} question went unanswered — this is NOT a clean result`
      : unitsState === "not-surveyed"
        ? `the unit survey could not look: the units phase did not survey (${lastReason ?? "no reason recorded"}), so the ${family} question went unanswered — this is NOT a clean result`
        : units.length === 0
        ? `no ${family} hypothesis — units.json holds no unit (${lastReason ?? NOTHING_TO_SURVEY}), so the ${family} question was asked of nothing`
        : answeredUnits === 0
          ? `the unit survey could not look: none of ${units.length} unit(s) returned a usable reply, so the ${family} question went unanswered — this is NOT a clean result`
          : `no ${family} hypothesis — ${answeredUnits} of ${units.length} unit(s) answered, and none recorded one${demotedIn(family)}`;
    rows.push({
      family,
      claim,
      bothEnds: { introducedAt: null, enforcedAt: null },
      quotes: [],
      existingCode: null,
      failureScenario: null,
      evidence: {
        subject: `the ${family} question over this PR's units`,
        control_site: "none",
        control_text: "",
        authority: "unknown",
        order_ok: "unknown",
        cannot_distinguish: "nothing",
        bypass: "none found",
        in_changed_hunk: false,
        consequence: null,
        trigger: "unknown",
        crosses_boundary: false,
        capability_gained: null,
      },
      source: "units",
      unitId: null,
    });
  }

  // Canonical ids, positional per family — the scheme `hypotheses.ts` reads.
  const byFamily = new Map<string, Record<string, unknown>[]>();
  const idOf = new Map<Row, string>();
  for (const row of rows) {
    const list = byFamily.get(row.family) ?? [];
    const id = hypothesisId(row.family, list.length + 1);
    idOf.set(row, id);
    const { family, ...rest } = row;
    list.push({ id, family, ...rest });
    byFamily.set(row.family, list);
  }
  for (const report of reports) {
    const [start, end] = spans.get(report)!;
    report.rows = rows.slice(start, end).map((row) => idOf.get(row)!);
  }
  const families = [...byFamily.keys()].sort();
  for (const family of families) writeJsonl(join(dir, "hypotheses", `${family}.jsonl`), byFamily.get(family)!);

  // The per-family gate the agent survey's branches ran, over the ingested set.
  const gated = obligationsDoc
    ? obligationsDoc.families.map((f) => f.family as string).filter((f) => f !== "spec")
    : families;
  const discharge = gated.map((family) => {
    const result = checkDischarge({ dir, family, log });
    return { family, satisfied: result.satisfied, notes: result.notes };
  });

  const gaps = reports.reduce((n, r) => n + r.consequenceGaps.length, 0);
  if (gaps > 0) {
    notes.push(`${gaps} entr${gaps === 1 ? "y names" : "ies name"} no holding control yet leave consequence null — see each unit's consequenceGaps`);
  }

  const demotedCount = reports.reduce((n, r) => n + r.demoted.length, 0);
  if (demotedCount > 0) {
    notes.push(`${demotedCount} unprompted defect(s) with trigger code_change were demoted — not in hypotheses/, recorded in each unit's demoted`);
  }

  const rowsByFamily = Object.fromEntries(families.map((f) => [f, byFamily.get(f)!.length]));
  const allAnswered = reports.every((r) => r.status === "ok");
  const satisfied =
    unitsDoc !== null && unitsState !== "not-surveyed" && allAnswered && discharge.every((d) => d.satisfied);

  const document: IngestDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    promptVersion: unitsDoc?.promptVersion ?? null,
    unitsRead: unitsDoc !== null,
    unitsState,
    unitsReason,
    units: reports,
    rowsByFamily,
    demotedCount,
    discharge,
    satisfied,
    notes,
  };
  const out = join(dir, "units", "ingest.json");
  mkdirSync(join(dir, "units"), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");

  log.info("ingested unit replies", {
    units: reports.length,
    ok: answeredUnits,
    rows: rows.length,
    demoted: demotedCount,
    satisfied,
  });

  const exitCode: ExitCode = unitsDoc === null ? EXIT_UNAVAILABLE : satisfied ? EXIT_OK : EXIT_DEGRADED;
  return { document, exitCode };
}

/** One screen for the phase log. */
export function renderIngest(doc: IngestDocument): string {
  const count = (s: UnitIngestStatus): number => doc.units.filter((u) => u.status === s).length;
  const lines = [
    `units-ingest: ${doc.units.length} unit(s) — ${count("ok")} ok, ${count("partial")} partial, ${count("missing")} missing, ${count("failed")} failed, ${count("stale")} stale, ${count("invalid")} invalid`,
    `  rows: ${Object.entries(doc.rowsByFamily).map(([f, n]) => `${f} ${n}`).join(", ") || "none"}`,
  ];
  if (doc.demotedCount > 0) lines.push(`  demoted: ${doc.demotedCount} unprompted code_change defect(s), kept out of hypotheses/`);
  if (doc.unitsState !== "surveyed") lines.push(`  units.json: ${doc.unitsState}${doc.unitsReason ? ` — ${doc.unitsReason}` : ""}`);
  for (const d of doc.discharge) lines.push(`  discharge[${d.family}]: ${d.satisfied ? "ok" : "NOT satisfied"}`);
  for (const u of doc.units) {
    if (u.status === "ok" && u.warnings.length === 0) continue;
    lines.push(`  ${u.unitId} ${u.status}${u.unanswered.length ? ` — unanswered ${u.unanswered.join(", ")}` : ""}`);
    for (const e of u.errors.slice(0, 3)) lines.push(`    ✗ ${e}`);
    for (const w of u.warnings.slice(0, 3)) lines.push(`    ! ${w}`);
  }
  for (const n of doc.notes) lines.push(`  note: ${n}`);
  return lines.join("\n");
}
