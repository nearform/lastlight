/**
 * `jev-classify` — one TypeSafe System-One call PER HYPOTHESIS, asking only
 * the category axis (#399 idea 2, `docs/plans/probe-oracle.md`).
 *
 * Measured 2026-09-22, before this module existed (a standalone script over
 * the same evidence, `apps/evals/scripts/jev-hypothesis-probe.ts`): 260
 * hypotheses across an 8-case arm, 83.6% agreement with Sonnet's own
 * `adjudicate` category call on the IDENTICAL dossier evidence, for $0.0053.
 * Per hypothesis, not per finding — hypotheses vastly outnumber findings (299
 * vs a few dozen posted, that same arm), which is the volume a System-1
 * primitive is for and a frontier model inside a long agent session is not.
 *
 * **ANNOTATES, never decides.** Its output rides into the dossier
 * (`adjudicate-render.ts`) as one advisory line per hypothesis; `adjudicate`
 * still writes every disposition itself, agreeing or not. Not a replacement:
 * the measured agreement is weakest exactly on the rarest, highest-stakes
 * categories (`defect` 33%, `correctness-risk` 40% recall against Sonnet's
 * own call) — nowhere near strong enough to skip or override the adjudicator.
 *
 * **Never fails the run.** No `TYPESAFE_KEY`, a network error, a malformed
 * answer — every one degrades to "no annotation" for the affected hypothesis
 * (recorded as an `error`, never silently dropped), not a failed phase. A
 * phase that could fail on a third party's API health would make PR review
 * availability depend on a service `legacy`/`dossier` deployments never
 * needed at all.
 */
import { choice, TypeSafeClient, type ChoiceResponse, type EntryType } from "@typesafe-ai/sdk";

import { buildEntries, type DossierEntry, type DossierOptions } from "./adjudicate-render.js";
import { jevClassifyPath, readJevClassifyDocument, writeJevClassifyDocument, type JevClassifyDocument, type JevResult } from "./jev-classify-io.js";
import { noopLogger, type LoggerPort } from "./log.js";
import { severityOf } from "./survey-verdict.js";

export { jevClassifyPath, readJevClassifyDocument, writeJevClassifyDocument };
export type { JevClassifyDocument, JevResult };

/** Wording matches `review-adjudicate.md`'s five categories verbatim, so a
 * disagreement is a disagreement about the SAME question the real
 * adjudicator answers, not an artefact of rephrasing it. */
export const JEV_CATEGORY_QUESTION = choice(
  "What kind of finding is this, if any? Judge the CLAIM against the evidence — the quotes, the probe verdict and transcript, the mechanism's two ends — not the wording.",
  {
    defect: {
      what: "It is wrong NOW. Some input, caller, or configuration that reaches this code today produces the wrong result, and the claim names it.",
    },
    "correctness-risk": {
      what: "The mechanism is incomplete in a way that produces a wrong result under a condition the claim names but has not shown holds.",
    },
    maintainability: {
      what: "Correct today, and a foreseeable edit breaks it — a duplicated constant, a contract enforced in one place of two.",
    },
    nit: {
      what: "Style, naming, or wording. True and small.",
    },
    verification: {
      what: 'You looked and there is no defect. Every "correctly enforced", "already handled", "the values agree", "intentional and documented" belongs here, however certain the claim sounds. A confident report of nothing is not a finding.',
    },
  },
);

/** The survey's own empty-family marker (`survey-contract.md` etc., one per
 * family: `"no contract hypothesis"`) — not a hypothesis to classify. */
const PLACEHOLDER_CLAIM = /^no \w+ hypothesis$/i;

/** ~4 chars per token — sizes a spend estimate, never bills anyone. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

/** Cap on any inlined text — jev's accuracy falls as unrelated text grows
 * around the decision (measured in the AACR-Bench arm). */
const STATE_TEXT_CAP = 1500;
function cap(s: string): string {
  return s.length > STATE_TEXT_CAP ? `${s.slice(0, STATE_TEXT_CAP)}\n[…truncated]` : s;
}

/** A mismatched excerpt/quote is a status line, never the full wrong text —
 * same reasoning as `adjudicate-render.ts`'s `renderExcerptBody`: it is
 * already known unusable, and the full guess is exactly the "context bloat"
 * that measurably degrades a System-1 call. */
function renderLocation(loc: DossierEntry["excerpt"], path: string | null, text?: string): Record<string, unknown> {
  if (loc.kind === "resolved" && text) return { status: "verified", file: path, line: loc.line, text: cap(text) };
  return { status: loc.kind, file: path };
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * The deterministic cross-check — see {@link JevResult.probeContradiction}'s
 * own doc for why this is a code check and not a second model call.
 *
 * Only the two directions that are genuinely contradictory: `verification`
 * (no defect) against a `reproduced` probe (an executed check found one), and
 * `defect`/`correctness-risk` (something is wrong) against a `refuted` probe
 * (an executed check found nothing). `maintainability`/`nit` are deliberately
 * excluded — both are compatible with "the mechanism is correct today", so
 * neither probe outcome contradicts them.
 */
function probeContradiction(category: string, probeVerdict: string | null): string | null {
  if (category === "verification" && probeVerdict === "reproduced")
    return "jev called this `verification` (no defect); the probe REPRODUCED the claim — trust the probe.";
  if ((category === "defect" || category === "correctness-risk") && probeVerdict === "refuted")
    return `jev called this \`${category}\`; the probe REFUTED the claim — trust the probe.`;
  return null;
}

/** The state one hypothesis hands to jev. Named JSON fields, not a serialized
 * prompt string: jev's own accuracy falls as unrelated text grows around the
 * decision, and structured state is the antidote. */
export function buildJevState(entry: DossierEntry): Record<string, unknown> {
  const row = entry.record.row as Record<string, unknown>;
  const ends = row.bothEnds as { introducedAt?: unknown; enforcedAt?: unknown } | undefined;
  return {
    family: entry.record.family,
    severity: severityOf(row),
    claim: asString(row.claim) ?? null,
    mechanism: {
      introducedAt: asString(ends?.introducedAt) ?? null,
      enforcedAt: asString(ends?.enforcedAt) ?? null,
    },
    anchor: renderLocation(entry.excerpt, entry.path, asString(row.existingCode)),
    quotes: entry.quotes.map((q) => renderLocation(q.located, q.path, q.text)),
    probe: entry.probe
      ? {
          verdict: entry.probe.verdict,
          command: entry.probe.command,
          differential: (row as { differential?: unknown }).differential === true,
          transcript: entry.transcript ? cap(entry.transcript) : null,
        }
      : null,
  };
}

export interface JevClassifyOptions extends DossierOptions {
  model?: string;
  apiKey?: string;
  concurrency?: number;
  log?: LoggerPort;
}

/** Bounded-concurrency map, order-preserving — the same shape
 * `apps/evals/src/pool.ts` uses, kept local so this leaf package gains no new
 * workspace edge for six lines of scheduling. */
async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Classify every hypothesis in `options.dir`'s dossier. Placeholder
 * (empty-family) rows are excluded before spending anything.
 *
 * Never throws. A missing key or a client construction failure produces a
 * document with `error` set and an empty `results[]` — the caller (the CLI)
 * writes it and exits 0 regardless, because "no annotation" must never be
 * "no review".
 */
export async function classifyHypotheses(options: JevClassifyOptions): Promise<JevClassifyDocument> {
  const log = options.log ?? noopLogger;
  const model = options.model ?? process.env.TYPESAFE_MODEL?.trim() ?? "jev-latest";
  const generatedAt = new Date().toISOString();

  const apiKey = options.apiKey ?? process.env.TYPESAFE_KEY?.trim() ?? process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) {
    log.warn("jev-classify: no TYPESAFE_KEY (or TYPESAFE_API_KEY) — annotating nothing", {});
    return { model, generatedAt, error: "no TYPESAFE_KEY (or TYPESAFE_API_KEY) in the environment", results: [] };
  }

  const { entries } = buildEntries(options);
  const candidates = entries.filter((e) => {
    const claim = asString((e.record.row as Record<string, unknown>).claim);
    return claim && !PLACEHOLDER_CLAIM.test(claim.trim());
  });
  if (!candidates.length) return { model, generatedAt, error: null, results: [] };

  let client: TypeSafeClient;
  try {
    client = new TypeSafeClient({ apiKey, defaultModel: model, timeout: 30_000, retry: { maxRetries: 4 } });
  } catch (err) {
    log.warn("jev-classify: could not construct the TypeSafe client — annotating nothing", {
      err: (err as Error).message,
    });
    return { model, generatedAt, error: (err as Error).message, results: [] };
  }

  const estTokens = candidates.reduce(
    (n, e) => n + approxTokens(JSON.stringify(buildJevState(e))) + approxTokens(JSON.stringify(JEV_CATEGORY_QUESTION)),
    0,
  );
  log.info("jev-classify: classifying", { hypotheses: candidates.length, model, estTokens });

  const results = await mapPool(candidates, options.concurrency ?? 8, async (entry): Promise<JevResult> => {
    try {
      // `buildJevState` is JSON-safe by construction (strings, numbers, nulls
      // and plain nested objects only); the SDK's `EntryType` just does not
      // spell that as `Record<string, unknown>`.
      const state = buildJevState(entry) as unknown as EntryType;
      const { answers } = await client.systemOne({ state, questions: { category: JEV_CATEGORY_QUESTION } });
      const a = answers.category as ChoiceResponse<typeof JEV_CATEGORY_QUESTION.criteria>;
      return {
        id: entry.record.id,
        category: a.choice,
        confidence: a.confidence,
        probabilities: { ...a.probabilities },
        error: null,
        probeContradiction: probeContradiction(a.choice, entry.probe?.verdict ?? null),
      };
    } catch (err) {
      return { id: entry.record.id, category: null, confidence: null, probabilities: null, error: (err as Error).message.slice(0, 200), probeContradiction: null };
    }
  });

  return { model, generatedAt, error: null, results };
}
