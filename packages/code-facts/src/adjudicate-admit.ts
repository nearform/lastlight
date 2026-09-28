/**
 * `admit` — the deterministic decision of WHICH hypotheses `adjudicate` weighs.
 *
 * Adjudicate is generative: it writes a disposition row for every hypothesis it
 * is shown, and that is where its wall clock goes. Measured on the first
 * unit-survey arm (2026-09-27): 52 rows → ~29k output tokens and 8.7 minutes on
 * Sonnet 4.6; a 173-row case was still inside one turn after 12 minutes. The
 * agent survey had written 19–51 rows per case, so the cost never showed.
 *
 * Two kinds of rule, and nothing else:
 *
 * - **Typed-field rules** read the survey's evidence record as DATA — which
 *   enum a field holds, whether it is set — and the probe verdict. Never a
 *   claim's prose, never a pattern over text: a decision about what a sentence
 *   MEANS is a classifier's job, not a regex's.
 * - **The classifier rule** reads `jev.json`, the per-hypothesis System-1
 *   category `jev-classify` already writes, and files a row only above a stated
 *   confidence. Caveat on the record: jev-as-gate measured NEGATIVE once
 *   (2026-09-22, keep/drop is generative); the micro-adjudicate eval is what
 *   decides whether admission is a different enough question to reverse that.
 *
 * Every rule leaves a row with no evidence record alone (a legacy row is
 * admitted — nobody can classify it), and nothing is deleted: a row that is not
 * admitted is filed at `internal` tier by `findings --repair`, naming the rule
 * that filed it. The gate owes a disposition only for admitted rows, so an
 * adjudicator is never failed for a row it was never shown.
 *
 * Rules (a comma list; `all` = none of them):
 *
 *   `no-clean-quote`   the row QUOTED a control (`control_site` set) that is
 *                      `binding`, runs in time (`order_ok: true`), has no bypass
 *                      (`bypass: "none found"`), and states no consequence.
 *   `no-consequence`   the row states no consequence at all. A superset of the
 *                      above: every survey is told a defect owes one.
 *   `no-code-change`   the survey LABELLED the trigger `code_change` (the typed
 *                      field, as the units-v7 ingest demotion reads it).
 *   `jev:<category>@<p>`  jev classified the row `<category>` with confidence
 *                      ≥ p — e.g. `jev:verification@0.9`. A row jev did not
 *                      classify (no file, an error) is admitted.
 *   `top:<n>`          after the rules above, admit at most n, ranked by probe
 *                      strength, then a stated consequence, then
 *                      `crosses_boundary`, then declaration order.
 *
 * A probe that EXECUTED the scenario (`reproduced`, strength `executed`)
 * overrides every rule but `top:<n>`: an execution is evidence, and filing it
 * unread would be the one move here that could hide a demonstrated defect.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readHypothesisSet, type HypothesisSet } from "./hypotheses.js";
import { readJevClassifyDocument, type JevResult } from "./jev-classify-io.js";
import { probeStrength, readProbeAnswers, type ProbeStrength } from "./probes.js";
import { hasEvidence, stated as isSet, type SurveyEvidence } from "./survey-verdict.js";

export const ADMISSION_VERSION = 1;

const FIELD_RULES = ["no-clean-quote", "no-consequence", "no-code-change"] as const;
export type FieldRuleName = (typeof FIELD_RULES)[number];

export interface JevRule {
  category: string;
  minConfidence: number;
}

export interface AdmitSpec {
  rules: FieldRuleName[];
  jev: JevRule[];
  /** `top:<n>`; `null` = no cap. */
  top: number | null;
}

/**
 * Parse `--rules`. An unknown token THROWS — never defaulted — for the reason
 * `seed --mint` refuses one: a typo'd arm that fell back to `all` would run,
 * produce a number, and report it for an experiment that never happened.
 */
export function parseAdmitSpec(spec: string | null | undefined): AdmitSpec {
  const out: AdmitSpec = { rules: [], jev: [], top: null };
  for (const token of (spec ?? "all").split(",").map((t) => t.trim()).filter(Boolean)) {
    if (token === "all") continue;
    if (token.startsWith("top:")) {
      const n = Number(token.slice(4));
      if (!Number.isInteger(n) || n < 0) throw new Error(`admission rule "${token}": top:<n> needs a non-negative integer`);
      out.top = n;
      continue;
    }
    if (token.startsWith("jev:")) {
      const [category, p] = token.slice(4).split("@");
      const minConfidence = Number(p);
      if (!category || p === undefined || !Number.isFinite(minConfidence) || minConfidence < 0 || minConfidence > 1) {
        throw new Error(`admission rule "${token}": write jev:<category>@<confidence 0..1>, e.g. jev:verification@0.9`);
      }
      out.jev.push({ category, minConfidence });
      continue;
    }
    if ((FIELD_RULES as readonly string[]).includes(token)) {
      if (!out.rules.includes(token as FieldRuleName)) out.rules.push(token as FieldRuleName);
      continue;
    }
    throw new Error(`unknown admission rule "${token}" — one of: all, ${FIELD_RULES.join(", ")}, jev:<category>@<p>, top:<n>`);
  }
  return out;
}

export function formatAdmitSpec(spec: AdmitSpec): string {
  const parts: string[] = [
    ...spec.rules,
    ...spec.jev.map((j) => `jev:${j.category}@${j.minConfidence}`),
    ...(spec.top !== null ? [`top:${spec.top}`] : []),
  ];
  return parts.length ? parts.join(",") : "all";
}

export interface FiledRow {
  id: string;
  /** The rule that filed it, as written in the spec. */
  rule: string;
}

export interface Admission {
  version: typeof ADMISSION_VERSION;
  /** The spec as applied, normalised. */
  spec: string;
  rows: number;
  /** Shown to `adjudicate`, in declaration order. */
  admitted: string[];
  /** Filed at `internal` without adjudication, each with the rule that filed it. */
  filed: FiledRow[];
}

function fieldRuleFiles(rule: FieldRuleName, e: SurveyEvidence): boolean {
  switch (rule) {
    case "no-clean-quote":
      return (
        isSet(e.control_site) &&
        e.authority === "binding" &&
        e.order_ok === true &&
        e.bypass === "none found" &&
        !isSet(e.consequence)
      );
    case "no-consequence":
      return !isSet(e.consequence);
    case "no-code-change":
      return e.trigger === "code_change";
  }
}

const STRENGTH_RANK: Record<ProbeStrength, number> = { executed: 0, corroborated: 1, none: 2, refuted: 3 };

/** Pure: the same set, verdicts, classifications and spec always admit the same rows. */
export function admitHypotheses(
  set: HypothesisSet,
  strengthOf: (id: string) => ProbeStrength,
  jevOf: (id: string) => JevResult | null,
  spec: AdmitSpec,
): Admission {
  const filed: FiledRow[] = [];
  const kept: { id: string; position: number; rank: number[] }[] = [];

  set.records.forEach((record, position) => {
    const strength = strengthOf(record.id);
    const e = (record.row as { evidence?: unknown }).evidence as SurveyEvidence | undefined;
    let rule: string | null = null;
    if (hasEvidence(e) && strength !== "executed") {
      const ev = e as SurveyEvidence;
      rule = spec.rules.find((r) => fieldRuleFiles(r, ev)) ?? null;
      if (!rule) {
        const jev = jevOf(record.id);
        const hit =
          jev && !jev.error && jev.category !== null && jev.confidence !== null
            ? spec.jev.find((j) => j.category === jev.category && (jev.confidence as number) >= j.minConfidence)
            : undefined;
        if (hit) rule = `jev:${hit.category}@${hit.minConfidence}`;
      }
    }
    if (rule) {
      filed.push({ id: record.id, rule });
      return;
    }
    const ev = (hasEvidence(e) ? e : {}) as SurveyEvidence;
    kept.push({
      id: record.id,
      position,
      rank: [STRENGTH_RANK[strength], isSet(ev.consequence) ? 0 : 1, ev.crosses_boundary === true ? 0 : 1, position],
    });
  });

  let admitted = kept;
  if (spec.top !== null && kept.length > spec.top) {
    const ranked = [...kept].sort((a, b) => {
      for (let i = 0; i < a.rank.length; i++) if (a.rank[i] !== b.rank[i]) return a.rank[i] - b.rank[i];
      return 0;
    });
    const keep = new Set(ranked.slice(0, spec.top).map((k) => k.id));
    admitted = kept.filter((k) => keep.has(k.id));
    for (const k of kept) if (!keep.has(k.id)) filed.push({ id: k.id, rule: `top:${spec.top}` });
  }

  const order = new Map(set.records.map((r, i) => [r.id, i]));
  filed.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  return {
    version: ADMISSION_VERSION,
    spec: formatAdmitSpec(spec),
    rows: set.records.length,
    admitted: admitted.map((k) => k.id),
    filed,
  };
}

export function admissionPath(dir: string): string {
  return join(dir, "admission.json");
}

/**
 * The admission a previous `admit` wrote, or `null` — no file (the shipped
 * pipeline, a replay of an older workspace) or an unreadable one. `null` means
 * every row is admitted, which is exactly the behaviour before this existed.
 */
export function readAdmission(dir: string): Admission | null {
  const path = admissionPath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Admission;
    if (parsed?.version !== ADMISSION_VERSION || !Array.isArray(parsed.admitted) || !Array.isArray(parsed.filed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Read the set, the probe verdicts and `jev.json`, admit, write
 * `admission.json`. A `jev:` rule with no `jev.json` on disk THROWS: the arm
 * asked for a classifier that never ran, and admitting everything silently
 * would report a classifier result for an experiment that never happened.
 */
export function writeAdmission(dir: string, spec: AdmitSpec, options: { repo?: string } = {}): Admission {
  const set = readHypothesisSet(dir);
  const { answers } = readProbeAnswers({ dir, repo: options.repo }, set);
  const jevDoc = spec.jev.length ? readJevClassifyDocument(dir) : null;
  if (spec.jev.length && (!jevDoc || jevDoc.error)) {
    throw new Error(
      `a jev: admission rule needs ${join(dir, "jev.json")} from \`jev-classify\`` +
        (jevDoc?.error ? ` — it ran and classified nothing: ${jevDoc.error}` : " — it is not there"),
    );
  }
  const jevById = new Map((jevDoc?.results ?? []).map((r) => [r.id, r]));
  const admission = admitHypotheses(
    set,
    (id) => probeStrength(answers.get(id) ?? null, (set.byId.get(id)?.row ?? {}) as { evidence?: unknown }),
    (id) => jevById.get(id) ?? null,
    spec,
  );
  writeFileSync(admissionPath(dir), `${JSON.stringify(admission, null, 2)}\n`, "utf8");
  return admission;
}

/** One line for the phase log. */
export function renderAdmissionSummary(a: Admission): string {
  const byRule = new Map<string, number>();
  for (const f of a.filed) byRule.set(f.rule, (byRule.get(f.rule) ?? 0) + 1);
  const detail = [...byRule].map(([rule, n]) => `${rule} ${n}`).join(", ");
  return (
    `admit: ${a.admitted.length} of ${a.rows} row(s) admitted under "${a.spec}"` +
    (a.filed.length ? `; ${a.filed.length} filed internal (${detail})` : "")
  );
}
