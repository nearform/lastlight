/**
 * `probes` — the `falsify` loop's exit gate.
 *
 * WP4 (`docs/plans/deterministic-pr-levers.md` §WP4). It answers one
 * question: **has every hypothesis that needed a probe been given a verdict, and
 * does every verdict that claims execution have a transcript to show for it?**
 *
 * ── Why it is five lines of logic and not a validator ────────────────────────
 *
 * Because the sizing was measured. Candidate v3's gate was an existence check
 * and earned the investigation's only gold match; v2's full quote validator was
 * overkill and cost 2.4× for a worse result. This does not read a transcript, it
 * does not judge a verdict, and it does not check that the command was sensible.
 * It checks that the work was *done and recorded*.
 *
 * ── Why it must be SATISFIABLE, and by the model alone ──────────────────────
 *
 * `until_bash` gates are how this codebase has already been burned. WP3's
 * original design gated six survey passes on `hypotheses/$LL_FAMILY.jsonl` with
 * a variable that was never set, so the gate tested `hypotheses/.jsonl`, always
 * failed, and the loop ran to `max_iterations` against a condition that meant
 * nothing — the dependency-cruiser shape, green while seeing nothing, inverted.
 *
 * So the gate here is satisfiable in one pass **without lying**: a hypothesis
 * that genuinely cannot be executed against — no runner, no dependencies, a
 * language with no toolchain in this image — is recorded `unprobed` and that
 * closes the gate for it. `unprobed` is not a refutation and nothing downstream
 * may treat it as one; it is the honest answer, and the honest answer has to be
 * available or the model will be pushed towards a dishonest one.
 *
 * ── The one thing it DOES enforce ───────────────────────────────────────────
 *
 * A `reproduced` or `refuted` verdict must name a transcript that exists. That
 * is the rule with money on it, mechanised: *"you may add evidence and lower
 * confidence; you may not drop a hypothesis without a counter-transcript."*
 * A refutation by argument is exactly the intervention that raised precision
 * 54.5 → 67.1 and cut recall 45.5 → 39.8 in the measurement this whole pipeline
 * is a reaction to.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { readHypothesisSet, resolveHypothesis } from "./hypotheses.js";

/** A hypothesis line, as far as this gate cares. Everything else is ignored. */
interface HypothesisLine {
  id?: unknown;
  needsProbe?: unknown;
  severity?: unknown;
}

interface VerdictLine {
  hypothesis?: unknown;
  verdict?: unknown;
  transcript?: unknown;
}

export interface ProbeGapKind {
  /** `no-verdict` — asked for, never answered. `no-transcript` — answered with
   * a claim of execution and nothing to show. */
  kind: "no-verdict" | "no-transcript";
  hypothesis: string;
  detail: string;
}

export interface CheckProbesResult {
  /** Hypotheses that had to be probed: `needsProbe`, or `Critical` regardless. */
  required: string[];
  /** Of those, the ones with a verdict of any kind. */
  answered: string[];
  byVerdict: Record<string, number>;
  gaps: ProbeGapKind[];
  /** Lines that were not JSON at all, counted rather than silently skipped. */
  malformed: number;
  /** True ⇒ the loop may stop. */
  satisfied: boolean;
  /** One line per interesting fact, for the phase log. */
  notes: string[];
}

/**
 * One JSON object per line, malformed lines COUNTED rather than skipped.
 * Exported because `findings.ts` reads the same `hypotheses/*.jsonl` for the
 * `adjudicate` gate, and two readers of one append-only artifact is two places
 * for "how many lines did we drop?" to disagree.
 */
export function readJsonl<T>(path: string): { rows: T[]; malformed: number } {
  if (!existsSync(path)) return { rows: [], malformed: 0 };
  const rows: T[] = [];
  let malformed = 0;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const text = line.trim();
    if (!text) continue;
    try {
      rows.push(JSON.parse(text) as T);
    } catch {
      malformed += 1;
    }
  }
  return { rows, malformed };
}

/**
 * Which hypotheses a `falsify` pass owes a verdict on.
 *
 * `needsProbe` is the survey's own request, and `severity: "Critical"` overrides
 * it: the case this pipeline exists for was a Critical the reviewer talked
 * itself out of while standing at the defect site. A Critical that nobody tried
 * to run is the exact shape that must not survive silently.
 */
export function requiresProbe(row: HypothesisLine): boolean {
  if (row.needsProbe === true) return true;
  return typeof row.severity === "string" && row.severity.toLowerCase() === "critical";
}

export interface CheckProbesOptions {
  /** The `.lastlight/pr-review` directory. */
  dir: string;
  /**
   * What a `transcript` path is relative to. Defaults to the cwd, which is the
   * repo root in every phase this runs in — the prompt asks for a repo-relative
   * path (`.lastlight/pr-review/probes/contract-001.txt`) and a model that writes a
   * `dir`-relative one (`probes/contract-001.txt`) is being helpful rather than wrong,
   * so both resolve.
   */
  repo?: string;
}

export function checkProbes(options: CheckProbesOptions): CheckProbesResult {
  const probesDir = join(options.dir, "probes");
  const notes: string[] = [];
  let malformed = 0;

  // Identity comes from `hypotheses.ts`, the same reader `findings` uses, so the
  // two gates can never disagree about which claims exist. This used to gate on
  // `typeof row.id === "string"`, which silently excused every free-form row
  // from ever needing a probe — 22 of 30 on the first real run, including a
  // Critical. A hypothesis with no id of its own is still a hypothesis.
  const set = readHypothesisSet(options.dir);
  malformed += set.malformed;
  const families = set.families;
  const required = new Set<string>();
  for (const record of set.records) {
    if (requiresProbe(record.row as HypothesisLine)) required.add(record.id);
  }

  const { rows: verdicts, malformed: badVerdicts } = readJsonl<VerdictLine>(
    join(probesDir, "verdicts.jsonl"),
  );
  malformed += badVerdicts;

  const byVerdict: Record<string, number> = {};
  const answered = new Map<string, VerdictLine>();
  for (const row of verdicts) {
    if (typeof row.hypothesis !== "string") continue;
    // Resolved to the CANONICAL id, so a verdict written against a model-minted
    // `H-001` still answers `contract-001`. An ambiguous citation resolves to
    // nothing and the hypothesis stays unanswered — which is the honest reading:
    // a verdict naming an id two families minted does not say which it probed.
    const resolution = resolveHypothesis(set, row.hypothesis);
    if (resolution.kind !== "resolved") continue;
    // LAST write wins: the file is append-only, so a second round revising a
    // verdict appends rather than edits, and the newest line is the answer.
    answered.set(resolution.id, row);
  }
  for (const row of answered.values()) {
    const verdict = typeof row.verdict === "string" ? row.verdict : "(missing)";
    byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1;
  }

  const gaps: ProbeGapKind[] = [];
  for (const id of required) {
    const row = answered.get(id);
    if (!row) {
      gaps.push({ kind: "no-verdict", hypothesis: id, detail: "no line in probes/verdicts.jsonl" });
      continue;
    }
    const verdict = typeof row.verdict === "string" ? row.verdict : "";
    if (verdict !== "reproduced" && verdict !== "refuted") continue;
    // THE rule, mechanised. A refutation with nothing to show for it is an
    // argument wearing a verdict's clothes, and it is the one move that costs
    // recall outright.
    const transcript = typeof row.transcript === "string" ? row.transcript : null;
    const found =
      transcript !== null &&
      (existsSync(resolve(options.repo ?? process.cwd(), transcript)) ||
        existsSync(resolve(options.dir, transcript)));
    if (!found) {
      gaps.push({
        kind: "no-transcript",
        hypothesis: id,
        detail: `verdict "${verdict}" names ${transcript ?? "no transcript"}, which does not exist — only a transcript may refute`,
      });
    }
  }

  if (families.length === 0) {
    notes.push(
      "no hypotheses/*.jsonl at all — the surveys did not run, so there is nothing to falsify. That is NOT a clean probe result",
    );
  } else if (required.size === 0) {
    notes.push(
      `${families.length} family file(s), and no hypothesis asked for a probe or carried Critical severity — nothing to run`,
    );
  }
  if (malformed > 0) notes.push(`${malformed} unparseable JSONL line(s) were ignored`);

  return {
    required: [...required].sort(),
    answered: [...required].filter((id) => answered.has(id)).sort(),
    byVerdict,
    gaps,
    malformed,
    satisfied: gaps.length === 0,
    notes,
  };
}

/** A one-screen summary for the phase log — the gate's whole stdout. */
export function renderProbeCheck(result: CheckProbesResult): string {
  const lines = [
    `probes: ${result.answered.length}/${result.required.length} required hypotheses answered` +
      (Object.keys(result.byVerdict).length
        ? ` (${Object.entries(result.byVerdict)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => `${k}=${v}`)
            .join(" ")})`
        : ""),
  ];
  for (const note of result.notes) lines.push(`  note: ${note}`);
  for (const gap of result.gaps.slice(0, 20)) lines.push(`  ✗ ${gap.hypothesis}: ${gap.detail}`);
  if (result.gaps.length > 20) lines.push(`  … and ${result.gaps.length - 20} more`);
  return lines.join("\n");
}
