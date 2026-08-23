/**
 * Read the evidence pipeline's own telemetry off the artifacts it wrote.
 *
 * `ReviewPipelineStats` (`./schema.ts`) is the set of **mechanism metrics** that
 * `docs/plans/review-evidence-pipeline/08-evals.md` says WP3's and WP4's gates
 * are read on — obligations generated, discharge rate, the per-family funnel,
 * where findings landed. The reason it exists at all is that micro-recall over a
 * 25-finding gold set cannot resolve an improvement below ≈0.24
 * ({@link DETECTION_FLOOR_MICRO_RECALL}), while these have an n in the hundreds.
 *
 * **It was declared and consumed but never produced.** `boundaryMetrics()` and
 * `familyFunnels()` (`./review-metrics.ts`) both begin by filtering for
 * `review.pipeline`, and no run has ever carried one — so both returned
 * `undefined` on every measurement in the plan's history, and every decision
 * fell back to the one number the plan says never to steer on. This module is
 * the missing producer.
 *
 * Everything here is a deterministic read of files the run already wrote. No
 * model, no network, no spend — which is also what lets it be back-filled onto
 * preserved workspaces (`~/lastlight-run-artifacts/`).
 *
 * **Absent is not zero.** A baseline arm runs no pipeline and writes no
 * `.lastlight/pr-review/`; this returns `undefined` for it, and every consumer
 * degrades to posted-only rather than reporting a row of zeros.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { flattenToolchain } from "./paths.js";
import type { ReviewFamilyStats, ReviewPipelineStats } from "./schema.js";

/** Where the pipeline writes, relative to the seeded repo checkout. */
const ARTIFACT_DIR = join(".lastlight", "pr-review");

/**
 * The four discharge codes, plus the bucket for a row that carries none.
 *
 * `none` is its own column on purpose: on both preserved 2026-08-22 runs **every
 * obligation carried no code at all** (0/31, 0/34, 0/40) because the prescribed
 * row shape had no field to record one in. That was invisible for a week — it
 * read as a pipeline that simply was not discharging, rather than as a contract
 * that was not expressible.
 */
export const DISCHARGE_CODES = ["QUOTE", "ABSENT", "PARTIAL", "PROBE", "bad-code", "none"] as const;
export type DischargeCode = (typeof DISCHARGE_CODES)[number];

/**
 * `bad-code` and `none` are separate buckets, for the same reason
 * `checkDischarge` reports them as separate statuses: a row that wrote nothing
 * and a row that wrote a code nobody defined are different failures with
 * different fixes.
 *
 * Measured across the 447 preserved minimal-contract rows, **74 carried a
 * `discharge`/`status` string and only 43 were one of the four codes**. The rest
 * invented a fifth: `N/A` ×11, `enforced` ×6, `needs_investigation` ×4,
 * `hypothesis` ×3, and four more. Folding those into `none` would report the
 * minimal block as "the models did not answer" when what it actually shows is
 * "the models answered off-vocabulary" — and `N/A` being the most common is
 * precisely why the spec renderer carries a *"THERE IS NO FIFTH CODE"*
 * paragraph.
 */

/**
 * One finding the pipeline generated, whether it was posted or not.
 *
 * Carried out of here alongside the counts because internal recall — "did we
 * find it at all?", as opposed to "did we say it?" — has to judge gold against
 * findings that never reached the review text, and `findings.json` is already a
 * structured list, so no extraction step is needed to get them.
 */
export interface PipelineFinding {
  title: string;
  body?: string;
  path?: string;
  line?: number;
  family?: string;
  /** `inline` / `body` / `internal`, from `disposition.json`. */
  tier?: string;
  confidence?: number;
  /** Ids of the survey hypotheses this finding was built from. May be empty —
   * see {@link ReviewPipelineStats.unprovenanced}. */
  hypotheses: string[];
  /**
   * Every supporting hypothesis discharged `QUOTE` with no `failureScenario`,
   * i.e. the pass looked, found the line, and found it *fine*.
   *
   * An anti-finding. It cannot match gold by construction, so it is pure
   * attention cost wherever it is posted. `false` for a finding with no
   * hypotheses at all — absence of provenance is not evidence of innocence.
   */
  cleanDischarge: boolean;
}

export interface PipelineReadout {
  stats: ReviewPipelineStats;
  findings: PipelineFinding[];
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * A hypothesis row's discharge code.
 *
 * Reads `discharge` **or** `status`, case-insensitively, mirroring `codeOf` in
 * `code-facts`' `discharge.ts` so the harness and the gate can never disagree
 * about whether an obligation was discharged.
 *
 * A string that is not one of the four is `bad-code`, never `none` — the same
 * split `checkDischarge` reports. A row with no field at all (the `verdict`-
 * shaped rows the `spec` pass invented) is `none`. Note `notMeasured`, which a
 * dead family writes into `status`, therefore lands in `bad-code`: it is a
 * status and not a discharge, and the family's own NOT MEASURED flag on
 * `obligations.json` is where that fact is properly recorded.
 */
function dischargeOf(row: Record<string, unknown>): DischargeCode {
  const raw = row.discharge ?? row.status;
  if (typeof raw !== "string" || !raw.trim()) return "none";
  const upper = raw.trim().toUpperCase();
  return VALID_CODES.has(upper) ? (upper as DischargeCode) : "bad-code";
}

const VALID_CODES = new Set(["QUOTE", "ABSENT", "PARTIAL", "PROBE"]);

/**
 * Parse a `hypotheses/<family>.jsonl`.
 *
 * **Mirrors `code-facts`' own `readJsonlRows` exactly**, because the ordinal a
 * row lands on IS its canonical identity: blank lines are skipped, unparseable
 * lines are skipped *without consuming an ordinal*, and anything that parses is
 * kept even if it is not an object — a scalar or array line still consumes its
 * ordinal there, and a reader that dropped it would shift every later row's id
 * and silently mis-resolve every citation after it rather than miss one.
 */
function readJsonlRows(path: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t) as unknown);
    } catch {
      /* a torn final line is normal on a killed run — it consumes no ordinal */
    }
  }
  return rows;
}

const asRecord = (row: unknown): Record<string, unknown> =>
  row && typeof row === "object" && !Array.isArray(row) ? (row as Record<string, unknown>) : {};

/** `<family>-NNN` — the identity `code-facts` assigns at ingest. */
const hypothesisId = (family: string, ordinal: number): string => `${family}-${String(ordinal).padStart(3, "0")}`;

/**
 * **A clean discharge: `QUOTE` with `failureScenario` PRESENT and explicitly
 * `null`.**
 *
 * The strictness is the whole point, and it is what the attention boundary
 * (`apps/server/src/engine/github/review-poster.ts`) keys on — the two must
 * agree or the instrument reports a demotion that did not happen. A merely
 * *absent* key carries no information: under the pre-2026-08-23 contract the
 * field did not exist, and the `spec` pass's invented row shape has nowhere to
 * record one, so 37 rows across the preserved minimal-era runs are `QUOTE` with
 * no key. Reading absence as "clean" would mark those as anti-findings on the
 * strength of a field nobody asked for.
 */
function isCleanDischarge(row: Record<string, unknown>): boolean {
  return dischargeOf(row) === "QUOTE" && "failureScenario" in row && row.failureScenario === null;
}

interface ObligationsDoc {
  coverage?: "full" | "degraded" | "none";
  degraded?: { extractor?: string; reason?: string }[];
  families?: { family: string; obligations?: number; measured?: boolean; notMeasuredReason?: string | null }[];
  obligations?: { family?: string }[];
  dropped?: { reason?: string; count?: number }[];
}

interface FindingsDoc {
  findings?: {
    title?: string;
    body?: string;
    path?: string;
    line?: number;
    family?: string;
    confidence?: number;
    hypotheses?: string[];
  }[];
}

interface DispositionDoc {
  findings?: { tier?: string; reason?: string | null; finding?: FindingsDoc["findings"] extends (infer F)[] ? F : never }[];
}

/**
 * Read the pipeline's artifacts out of a seeded repo checkout.
 *
 * `repoDir` is the checkout the agent worked in — the artifacts are at
 * `<repoDir>/.lastlight/pr-review/`, two levels down and *not* at the workspace
 * root (the distinction that cost 27 of 120 survey branches their seed).
 *
 * **Call this before the workspace is deleted**, not from a `--keep-workspace`
 * branch: making the mechanism metrics conditional on a debugging flag is how
 * they came to be absent from every arm ever run.
 */
export function readPipelineStats(repoDir: string): PipelineReadout | undefined {
  return readPipelineArtifacts(join(repoDir, ARTIFACT_DIR));
}

/**
 * The same read, given the artifact directory directly.
 *
 * Split out because the preserved copies under `~/lastlight-run-artifacts/`
 * are archived as `<run>/<instance>/pr-review/` — the `.lastlight` level is not
 * in the archive — so a back-fill over stored runs cannot go through the
 * checkout-relative path. Same reader either way: a back-filled number and a
 * live one must not be able to disagree.
 */
export function readPipelineArtifacts(dir: string): PipelineReadout | undefined {
  if (!existsSync(dir)) return undefined;

  const obligationsDoc = readJson<ObligationsDoc>(join(dir, "obligations.json"));
  const factsDoc = readJson<{ toolchain?: Parameters<typeof flattenToolchain>[0] }>(join(dir, "facts.json"));
  const findingsDoc = readJson<FindingsDoc>(join(dir, "findings.json"));
  const dispositionDoc = readJson<DispositionDoc>(join(dir, "disposition.json"));

  let hypothesisFiles: string[] = [];
  try {
    hypothesisFiles = readdirSync(join(dir, "hypotheses")).filter((f) => f.endsWith(".jsonl"));
  } catch {
    /* no hypotheses dir — the surveys never ran */
  }

  // Nothing readable at all ⇒ no phase got far enough to write. `undefined`,
  // not zeros. Note the hypotheses dir counts: a run that died after `survey`
  // still produced the telemetry you most want to read, and an earlier version
  // of this guard threw exactly that case away.
  if (!obligationsDoc && !findingsDoc && !dispositionDoc && !hypothesisFiles.length) return undefined;

  const byFamily: Record<string, ReviewFamilyStats> = {};
  const family = (name: string): ReviewFamilyStats => (byFamily[name] ??= {});

  // ── Obligations, per family ───────────────────────────────────────────────
  // Taken from the document's OWN `families[]` roll-up rather than recounted
  // from `obligations[]`: that is where `measured` / `notMeasuredReason` live,
  // and a family with zero obligations because its extractor was unavailable is
  // a different row from one that genuinely had nothing to say.
  for (const f of obligationsDoc?.families ?? []) {
    const stats = family(f.family);
    stats.obligations = f.obligations ?? 0;
    if (f.measured === false) stats.notMeasured = true;
  }
  const obligations = obligationsDoc?.obligations?.length;

  // ── Hypotheses, per family, plus the discharge histogram ──────────────────
  // The family comes from the FILENAME, never from the row: a row may carry no
  // `family` field at all (the `spec` pass's invented shape carries none), and a
  // pass that mislabels its own rows must not be able to move another family's
  // funnel.
  const dischargeCodes: Record<string, number> = {};
  /** Canonical id → is it a clean discharge. */
  const cleanById = new Map<string, boolean>();
  /** An unambiguous model-declared id → the canonical id it names. */
  const declaredClaims = new Map<string, string[]>();
  let hypotheses = 0;
  let cleanDischarges = 0;
  for (const file of hypothesisFiles) {
    const name = file.replace(/\.jsonl$/, "");
    const rows = readJsonlRows(join(dir, "hypotheses", file));
    family(name).hypotheses = rows.length;
    hypotheses += rows.length;
    rows.forEach((raw, index) => {
      const row = asRecord(raw);
      const id = hypothesisId(name, index + 1);
      const code = dischargeOf(row);
      dischargeCodes[code] = (dischargeCodes[code] ?? 0) + 1;
      const clean = isCleanDischarge(row);
      if (clean) cleanDischarges++;
      cleanById.set(id, clean);
      // A model-minted id is honoured as an ALIAS only, and only when it does
      // not shadow a canonical one — the same rule `code-facts` applies, so a
      // row declaring `contract-001` from third position cannot capture
      // citations meant for the real first row.
      const declared = typeof row.id === "string" ? row.id : undefined;
      if (declared && declared !== id) declaredClaims.set(declared, [...(declaredClaims.get(declared) ?? []), id]);
    });
  }
  const aliases = new Map<string, string>();
  for (const [declared, claimedBy] of declaredClaims) {
    if (cleanById.has(declared) || claimedBy.length !== 1) continue;
    aliases.set(declared, claimedBy[0]);
  }
  /** Resolve a citation the way the ledger the adjudicator read resolved it. */
  const resolve = (cited: string): string | undefined =>
    cleanById.has(cited) ? cited : aliases.get(cited);

  // ── Findings, their provenance, and where they landed ─────────────────────
  const rawFindings = findingsDoc?.findings ?? [];

  // Tier counts come from `disposition.json` DIRECTLY, not from the join below.
  // The boundary's own output is authoritative about where it put things, and a
  // join that silently failed would under-report the tiers rather than error —
  // which is how an inert attention boundary stays invisible.
  const tiers: Partial<Record<"inline" | "body" | "internal", number>> = {};
  const tierOf = new Map<string, string>();
  for (const d of dispositionDoc?.findings ?? []) {
    if (d.tier === "inline" || d.tier === "body" || d.tier === "internal") tiers[d.tier] = (tiers[d.tier] ?? 0) + 1;
    const f = d.finding as { title?: string; path?: string } | undefined;
    if (f?.title && d.tier) tierOf.set(findingKey(f), d.tier);
  }

  const findings: PipelineFinding[] = [];
  let unprovenanced = 0;
  // Without a disposition document nothing knows where anything went. `posted`
  // then stays ABSENT for every family rather than being filled from the
  // finding count — "the boundary did not report" and "the family posted all of
  // them" are different facts, and one measured case (`1587-r3`, keeper run 1)
  // wrote no `disposition.json` at all while posting nine findings.
  const tiersKnown = (dispositionDoc?.findings?.length ?? 0) > 0;
  for (const f of rawFindings) {
    const ids = f.hypotheses ?? [];
    if (!ids.length) unprovenanced++;
    const tier = tierOf.get(findingKey(f));
    // `posted` means POSTED — inline or body. An `internal` finding was
    // generated and deliberately withheld, and counting it here would make a
    // family that produced nothing but anti-findings read as its most
    // productive.
    if (f.family && tiersKnown && (tier === "inline" || tier === "body")) {
      family(f.family).posted = (family(f.family).posted ?? 0) + 1;
    }
    findings.push({
      title: f.title ?? "",
      body: f.body,
      path: f.path,
      line: f.line,
      family: f.family,
      tier,
      confidence: f.confidence,
      hypotheses: ids,
      // Every supporting hypothesis must RESOLVE and be clean. An id that names
      // no row is not evidence of innocence any more than citing none is.
      cleanDischarge: ids.length > 0 && ids.every((id) => cleanById.get(resolve(id) ?? "") === true),
    });
  }

  // Conservation: how many distinct hypotheses reached a finding. The gate
  // requires every one to appear exactly once, so `hypotheses - discharged`
  // should be 0 — and when it is not, that is a measurement, not a crash.
  const discharged = new Set(rawFindings.flatMap((f) => f.hypotheses ?? [])).size;

  const stats: ReviewPipelineStats = {
    ...(obligations !== undefined ? { obligations } : {}),
    ...(obligationsDoc?.dropped?.length
      ? { obligationsDropped: obligationsDoc.dropped.map((d) => ({ reason: d.reason ?? "unknown", count: d.count ?? 0 })) }
      : {}),
    ...(hypothesisFiles.length ? { hypotheses, discharged, dischargeCodes, cleanDischarges } : {}),
    ...(rawFindings.length ? { unprovenanced } : {}),
    ...(Object.keys(tiers).length ? { tiers, inlinePosted: tiers.inline ?? 0 } : {}),
    ...(Object.keys(byFamily).length ? { byFamily } : {}),
    ...(obligationsDoc?.coverage ? { coverage: obligationsDoc.coverage } : {}),
    ...(obligationsDoc?.degraded?.length
      ? { degraded: obligationsDoc.degraded.map((d) => `${d.extractor ?? "?"}: ${(d.reason ?? "").slice(0, 200)}`) }
      : {}),
    ...(factsDoc?.toolchain ? { toolchain: flattenToolchain(factsDoc.toolchain) } : {}),
  };

  return { stats, findings };
}

/**
 * Identity of a finding across `findings.json` and `disposition.json`.
 *
 * The two documents carry the same findings but no shared id, so the join is on
 * content. **`line` is deliberately NOT part of the key**: the boundary
 * re-anchors a finding to a line GitHub can actually hang a comment on, so the
 * same finding is `APIContext.tsx:1042` in `findings.json` and `:1063` in
 * `disposition.json`. Keying on the line silently failed to join 10 of 32
 * findings on the measured case — and a failed join looks exactly like a
 * finding that was never tiered.
 */
function findingKey(f: { title?: string; path?: string }): string {
  return `${f.path ?? ""} ${f.title ?? ""}`;
}

/**
 * Project the generated findings into the judge's finding shape.
 *
 * Title *and* body, because the title alone is often a location plus a verdict
 * ("Constant MAX_USER_PAGES properly enforced at multiple boundaries") and the
 * mechanism the gold is about lives in the body. Order is preserved: the
 * judge's indices come back as offsets into this array.
 */
export function internalJudgeInputs(findings: PipelineFinding[]): { description: string; file: string | null }[] {
  return findings.map((f) => ({
    description: f.body ? `${f.title} — ${f.body}` : f.title,
    file: f.path ?? null,
  }));
}

/**
 * Fold the internal-recall pass into the stats, attributing each match back to
 * the finding that made it.
 *
 * That attribution is the point: it fills the per-family `matched` column of the
 * funnel, and `inlineMatched` for the attention boundary. Without it
 * `familyFunnels()` can say which family generated the most and never which one
 * was RIGHT — the difference between a volume metric and a quality one.
 */
export function withInternalRecall(
  readout: PipelineReadout,
  internal: { goldToFinding: (number | null)[]; matched: number; error?: string } | undefined,
): ReviewPipelineStats {
  const stats = readout.stats;
  // No pass at all (no gold, or no findings to match) — nothing to record, and
  // nothing to claim.
  if (!internal) return stats;
  // Ungraded: say so, and leave `internalMatched` absent. A judge failure that
  // wrote 0 would be indistinguishable from a pipeline that found nothing.
  if (internal.error) return { ...stats, internalUngraded: internal.error };

  const byFamily: Record<string, ReviewFamilyStats> = {};
  for (const [name, f] of Object.entries(stats.byFamily ?? {})) byFamily[name] = { ...f };
  let inlineMatched = 0;
  for (const idx of internal.goldToFinding) {
    if (idx === null) continue;
    const f = readout.findings[idx];
    if (!f) continue;
    if (f.tier === "inline") inlineMatched++;
    if (!f.family) continue;
    const fam = (byFamily[f.family] ??= {});
    // Discovery, always. Contribution to the review, only if it was posted —
    // so `matched` never exceeds `posted` and the funnel reads as one story.
    fam.internalMatched = (fam.internalMatched ?? 0) + 1;
    if (f.tier === "inline" || f.tier === "body") fam.matched = (fam.matched ?? 0) + 1;
  }

  return {
    ...stats,
    internalMatched: internal.matched,
    inlineMatched,
    ...(Object.keys(byFamily).length ? { byFamily } : {}),
  };
}
