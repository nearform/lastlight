/**
 * `lastlight-facts units-ingest` — the unit survey's replies, turned into the
 * EXISTING `hypotheses/<family>.jsonl` rows.
 *
 * `hypotheses/<family>.jsonl` is the interface every later phase reads —
 * `discharge`, `requiresProbe`, the dossier, `jev-classify`, the `findings`
 * conservation gate, `stampDerivedSeverity` — so a unit-survey row is shaped
 * exactly like an agent-survey row (the shape `seed-render.ts` prescribes),
 * plus two fields: `source: "units"` and `unitId`. Nothing downstream changes.
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
 * PARTIAL / ABSENT — or `PROBE` for a row nobody answered. `severity` and
 * `needsProbe` are not written at all: every reader derives them from
 * `evidence`, exactly as for an agent survey's rows.
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
  extractResponseObject,
  UNIT_FAMILIES,
  UnitAnswerSchema,
  UnitDefectSchema,
  UnitResponseFileSchema,
  type UnitEvidence,
} from "./unit-response.js";
import { UnitsDocumentSchema, type Unit, type UnitsDocument } from "./units.js";
import { requestLineTags, type TaggedLine } from "./units-render.js";

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
  /** How the JSON object was found in `raw` — `null` when it was not. */
  via: "whole" | "fence" | "scan" | null;
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
}

export interface IngestDocument {
  version: 1;
  generatedAt: string;
  promptVersion: string | null;
  /** False ⇒ units.json could not be read; rows were built from obligations.json alone. */
  unitsRead: boolean;
  units: UnitIngestReport[];
  rowsByFamily: Record<string, number>;
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

/** Read `units/responses/<id>.json` into a verdict on the unit plus its parsed body. */
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
  const extracted = extractResponseObject(parsed.raw ?? "", unit.id);
  if (!extracted.value) {
    return { status: "invalid", body: null, via: null, error: "`raw` holds no JSON object" };
  }
  if (extracted.value.unitId !== unit.id) {
    return {
      status: "invalid",
      body: null,
      via: extracted.via,
      error: `the reply's unitId is ${JSON.stringify(extracted.value.unitId)}, not "${unit.id}"`,
    };
  }
  return { status: "ok", body: extracted.value, via: extracted.via, error: null };
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

  let unitsDoc: UnitsDocument | null = null;
  const unitsPath = join(dir, "units.json");
  try {
    const result = UnitsDocumentSchema.safeParse(JSON.parse(readFileSync(unitsPath, "utf8")));
    if (result.success) unitsDoc = result.data;
    else notes.push(`${unitsPath} does not validate (${issuesOf(result.error)})`);
  } catch (err) {
    notes.push(`${unitsPath} is not readable (${reasonOf(err)})`);
  }

  const { doc: obligationsDoc, byId: obligationById } = loadObligations(dir);
  if (!obligationsDoc) notes.push("obligations.json is not readable — answers are filed under the family the reply names");

  const rows: Row[] = [];
  const reports: UnitIngestReport[] = [];

  /** The row for an obligation nobody answered. */
  const unanswered = (o: Obligation, unitId: string | null, why: string): Row => {
    const at = `${o.introducedAt.path}:${o.introducedAt.line}`;
    return {
      family: o.family,
      obligation: o.id,
      discharge: "PROBE",
      claim: `the unit survey could not answer ${o.id} (${why}) — unanswered, not clean: ${o.question}`,
      bothEnds: { introducedAt: at, enforcedAt: null },
      quotes: [],
      existingCode: null,
      failureScenario: null,
      evidence: unknownEvidence(o.mechanism || at),
      source: "units",
      unitId,
    };
  };

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
    if (response.body) {
      const body = response.body;
      const answers = Array.isArray(body.answers) ? body.answers : [];
      const defects = Array.isArray(body.defects) ? body.defects : [];
      if (!Array.isArray(body.answers) && unit.obligationIds.length > 0) {
        report.errors.push("the reply has no `answers` array");
      }
      if (!Array.isArray(body.defects)) warn("the reply has no `defects` array — read as []");

      const fromEntry = (
        raw: unknown,
        asAnswer: boolean,
      ): void => {
        const schema = asAnswer ? LenientAnswer : LenientDefect;
        const parsed = schema.safeParse(raw);
        const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
        const obligationId = asAnswer && typeof entry.obligation === "string" ? entry.obligation : null;
        const obligation = obligationId ? obligationById.get(obligationId) ?? null : null;

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
        const located = locate(entry, unit, tags, warn);
        const evidence: UnitEvidence = {
          ...value.evidence,
          control_site: normaliseControlSite(value.evidence.control_site, located?.path ?? unit.file),
        };
        const family = obligation?.family ?? value.family;
        if (obligation && value.family !== obligation.family) {
          warn(`${obligation.id} is a ${obligation.family} obligation; the reply filed it under ${value.family} — filed under ${obligation.family}`);
        }
        const introducedAt = obligation
          ? `${obligation.introducedAt.path}:${obligation.introducedAt.line}`
          : located
            ? `${located.path}:${located.line}`
            : unit.file && unit.lines
              ? `${unit.file}:${unit.lines[0]}`
              : null;
        rows.push({
          family,
          ...(obligation ? { obligation: obligation.id } : {}),
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

  // An obligation no unit owned — units.json unreadable, or written before the
  // obligations were — is still conserved.
  const orphans = [...obligationById.values()].filter((o) => !owned.has(o.id)).sort((a, b) => a.id.localeCompare(b.id));
  for (const o of orphans) {
    rows.push(unanswered(o, null, unitsDoc ? "no unit carried it" : "units.json was not readable"));
  }
  if (orphans.length > 0) notes.push(`${orphans.length} obligation(s) no unit carried got an unanswered row: ${orphans.map((o) => o.id).join(", ")}`);

  // A measured family with no obligation needs a row of its own, or its gate
  // reads "surveyed nothing". The row says what actually happened.
  const answeredUnits = reports.filter((r) => r.status === "ok" || r.status === "partial").length;
  const placeholderFamilies = obligationsDoc
    ? obligationsDoc.families.filter((f) => f.measured && f.family !== "spec" && f.obligations === 0).map((f) => f.family as string)
    : DEFAULT_SURVEYED;
  for (const family of placeholderFamilies) {
    if (rows.some((r) => r.family === family)) continue;
    const claim = !unitsDoc
      ? `the unit survey could not look: units.json was not readable, so the ${family} question went unanswered — this is NOT a clean result`
      : units.length === 0
        ? `no ${family} hypothesis — units.json holds no unit (${unitsDoc.degraded.map((d) => d.reason).at(-1) ?? "nothing to survey"}), so the ${family} question was asked of nothing`
        : answeredUnits === 0
          ? `the unit survey could not look: none of ${units.length} unit(s) returned a usable reply, so the ${family} question went unanswered — this is NOT a clean result`
          : `no ${family} hypothesis — ${answeredUnits} of ${units.length} unit(s) answered, and none recorded one`;
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

  const rowsByFamily = Object.fromEntries(families.map((f) => [f, byFamily.get(f)!.length]));
  const allAnswered = reports.every((r) => r.status === "ok");
  const satisfied = unitsDoc !== null && allAnswered && discharge.every((d) => d.satisfied);

  const document: IngestDocument = {
    version: 1,
    generatedAt: new Date().toISOString(),
    promptVersion: unitsDoc?.promptVersion ?? null,
    unitsRead: unitsDoc !== null,
    units: reports,
    rowsByFamily,
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
