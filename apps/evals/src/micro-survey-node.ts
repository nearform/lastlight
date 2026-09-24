/**
 * The Node half of the micro-survey report: everything that needs the file
 * system or `lastlight-code-facts`, shared by `scripts/micro-survey.ts` (which
 * writes a report) and `scripts/micro-survey-backfill.ts` (which fills new
 * fields into reports written before them), so the two can never compute a
 * field two ways. The browser-safe shapes and arithmetic stay in
 * `micro-survey.ts`.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type SurveyEvidence, checkDischarge, parseJsonl, hasEvidence, isReassurance, probeReasonOf, severityOf } from "lastlight-code-facts";

import type { MicroRowView, MicroSeedStats } from "./micro-survey.js";

export interface SurveyRow {
  id?: string;
  obligation?: string;
  claim?: string;
  severity?: string;
  needsProbe?: boolean;
  evidence?: SurveyEvidence;
  quotes?: { path?: string; line?: number }[];
  bothEnds?: Record<string, unknown>;
}

/** The survey's rows, read exactly as the pipeline's own reader takes them —
 * a pretty-printed row is recovered there, so it is here. */
export function parseRows(text: string): SurveyRow[] {
  return parseJsonl(text).rows as SurveyRow[];
}

/**
 * Does the row CLAIM a defect? Derived severity Important or Critical — the
 * derivation sets those only when a consequence is recorded — AND not a clean
 * discharge. A reassurance with a consequence attached ("if the constant ever
 * changed…") is the pass saying the control holds; counting it as a claim put
 * it in the precision denominator (measured: GLM 5.3 Flash wrote a
 * consequence on 10 of 10 clean discharges).
 */
export function claimOf(r: SurveyRow): boolean {
  const important = ["important", "critical"].includes((severityOf(r) ?? "").toLowerCase());
  return important && !(hasEvidence(r.evidence) && isReassurance(r.evidence as SurveyEvidence));
}

/** The family's seeded checks, from an `obligations.json`. */
export function checksOf(obligationsPath: string, family: string): { id: string; question: string }[] {
  if (!existsSync(obligationsPath)) return [];
  const doc = JSON.parse(readFileSync(obligationsPath, "utf8")) as {
    obligations?: { id?: string; family?: string; question?: string }[];
  };
  return (doc.obligations ?? [])
    .filter((o) => o?.family === family && typeof o.id === "string")
    .map((o) => ({ id: o.id as string, question: o.question ?? "" }));
}

export function rowsViewOf(rows: SurveyRow[], checkIds: Set<string>): MicroRowView[] {
  return rows.map((r, i) => {
    const ev = hasEvidence(r.evidence) ? (r.evidence as SurveyEvidence) : null;
    const obl = typeof r.obligation === "string" && checkIds.has(r.obligation.trim()) ? r.obligation.trim() : null;
    return {
      id: r.id ?? `row-${i}`,
      obligation: obl,
      severity: severityOf(r) ?? null,
      probe: ev ? probeReasonOf(ev) : r.needsProbe === true ? "unknown" : null,
      reassurance: ev ? isReassurance(ev) : false,
      claim: (r.claim ?? "").slice(0, 400),
    };
  });
}

/**
 * The discharge gate's ledger for one family, over a `.lastlight/pr-review`
 * directory. `undefined` when there is no obligations document to grade against.
 */
export function seedStatsIn(prDir: string, family: string): MicroSeedStats | undefined {
  let r: ReturnType<typeof checkDischarge>;
  try {
    r = checkDischarge({ dir: prDir, family: family as never });
  } catch {
    return undefined;
  }
  if (r.documentError || r.familyError) return undefined;
  const citing = new Set(r.entries.flatMap((e) => e.citedBy));
  let droppedByCap = 0;
  try {
    const doc = JSON.parse(readFileSync(join(prDir, "obligations.json"), "utf8")) as {
      dropped?: { reason?: string; count?: number }[];
    };
    for (const d of doc.dropped ?? []) {
      if (typeof d?.reason === "string" && d.reason.includes(`for ${family}`)) droppedByCap += d.count ?? 0;
    }
  } catch {
    /* no document: nothing was dropped that this can name */
  }
  // A check is ANSWERED when a row points at it. Under `contract: minimal` (the
  // shipped default) rows carry the back-pointer but no discharge code, so
  // counting coded discharges would read every such run as "answered 0".
  const answered = r.entries.filter((e) => e.citedBy.length > 0).length;
  return {
    seeded: r.entries.length,
    answered,
    skipped: r.entries.length - answered,
    byCode: r.contract === "full" ? r.byCode : {},
    ownRows: Math.max(0, r.rows - citing.size),
    droppedByCap,
    malformed: r.malformed,
    recovered: r.recovered,
    gateSatisfied: r.satisfied,
  };
}

/** The same ledger over a stored rows FILE, graded against a fixture's
 * `obligations.json` — for reports whose scratch workspace is long gone. */
export function seedStatsOfRowsFile(obligationsPath: string, family: string, rowsFile: string | null): MicroSeedStats | undefined {
  if (!existsSync(obligationsPath)) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "micro-seed-"));
  try {
    mkdirSync(join(dir, "hypotheses"), { recursive: true });
    copyFileSync(obligationsPath, join(dir, "obligations.json"));
    if (rowsFile && existsSync(rowsFile)) writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), readFileSync(rowsFile));
    return seedStatsIn(dir, family);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
