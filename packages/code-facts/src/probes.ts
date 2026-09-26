/**
 * `probes` — the `falsify` loop's exit gate.
 *
 * WP4 (`docs/plans/deterministic-pr-levers.md` §WP4). It answers one
 * question: **has every hypothesis that needed a probe been given a verdict, and
 * does every verdict that claims execution have a transcript — opening with the
 * command that produced it — to show for it?**
 *
 * ── Why it is five lines of logic and not a validator ────────────────────────
 *
 * Because the sizing was measured. Candidate v3's gate was an existence check
 * and earned the investigation's only gold match; v2's full quote validator was
 * overkill and cost 2.4× for a worse result. It still does not judge a verdict
 * and it does not check that the command was sensible. It checks that the work
 * was *done and recorded* — and, since 2026-09-21, that the record is the record
 * of an EXECUTION rather than of a reading.
 *
 * ── Why it now reads the transcript's FIRST LINE ────────────────────────────
 *
 * On the oracle's first-ever real run (eval `2026-09-21_113136-7d490df`,
 * `prreview__skillspro-1587-r2`) it returned **nine verdicts, nine of them
 * `reproduced`, every one with `"command": "code inspection"` and a transcript
 * of prose** — *"Reading source at … lines 78-80 … VERDICT: The claim is
 * ACCURATE"*. Not one recorded an executed command. `review-falsify.md` had
 * asked for *"the command line itself as the first line"* since the day it was
 * written; nothing checked it, so the strongest evidence in the pipeline was
 * being minted by reading code. That is the fourth
 * instruction-without-a-mechanism failure in this pipeline after
 * `hypotheses[].id`, `hypotheses[].obligation` and the adjudicator's `tier`.
 *
 * It matters beyond this phase: `refuted` plus a transcript is the ONLY thing
 * that authorises the adjudicator to DELETE a finding, so a prose transcript is
 * a licence to delete a real defect on the basis of reasoning.
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
 * A `reproduced` or `refuted` verdict must name a transcript that exists **and
 * a `command`, echoed on that transcript's first non-blank line**. That is the
 * rule with money on it, mechanised: *"you may add evidence and lower
 * confidence; you may not drop a hypothesis without a counter-transcript."*
 * A refutation by argument is exactly the intervention that raised precision
 * 54.5 → 67.1 and cut recall 45.5 → 39.8 in the measurement this whole pipeline
 * is a reaction to.
 *
 * **`unprobed` stays completely free**, and that is not an oversight — see the
 * satisfiability section above. The bar rises only on the two verdicts that
 * CLAIM evidence; the verdict that admits there is none must stay costless, or
 * the gate starts manufacturing the dishonesty it exists to catch.
 *
 * ── Why a differential probe's SECOND command is not held to "line one" ─────
 *
 * `review-falsify.md` asks a differential probe (base vs. head — tier 1 of the
 * ladder) to document both runs in one `command` string, `"BASE: <cmd1> HEAD:
 * <cmd2>"`. But base and head are two separate tool invocations, so their
 * echoes land on two different transcript lines, and the first-line check
 * above can never see the second half — it hadn't run yet when line one was
 * written. Measured 2026-09-22 (`prreview__skillspro-1587-r1`/`spec-004`): a
 * verdict was genuinely differential, both commands genuinely ran, and the
 * gate failed it anyway, forcing a needless second `falsify` iteration on
 * (as of that run) most cases with a differential probe in them. `command` is
 * still split and BOTH halves are still required to appear in the transcript
 * — this loosens *where* the second half may appear, not *whether* it must.
 *
 * ── `corroborated`, and the one judgement the gate CAN make (issue #405) ────
 *
 * Measured on a Martian cal.com case (run `2026-09-25_052603`, 13
 * `reproduced`): 5 were real execution, 1 a differential git probe — and 4 were
 * a grep ("grep confirms … is the only direct construction") and 3 cited a
 * script another hypothesis had written. Across nine probed cases falsify
 * returned 52 `reproduced` and never refuted a defect claim, so `reproduced`
 * had stopped separating anything: a search confirms the code READS the way a
 * claim says, which the surveys already established by reading it.
 *
 * So there is a fourth verdict. `corroborated` is a read — grep, a file view,
 * a facts query — that supports the claim without executing it. It is held to
 * the same bar as the two execution verdicts (a transcript that records the
 * command), because it too claims evidence; it is simply weaker evidence, and
 * everything downstream (the dossier, the adjudicator, the derived severity in
 * `finding-severity.ts`) reads it as such.
 *
 * And the gate refuses one shape outright: `reproduced` on a BEHAVIOURAL claim
 * ({@link isBehaviouralClaim} — a stated consequence, live at head) whose
 * every command is a read ({@link isReadOnlyCommand}). That is mechanical — it
 * reads the evidence record and the command string, never the transcript's
 * meaning — so it is satisfiable in one honest edit: relabel it `corroborated`,
 * or run something. A read against a STRUCTURAL claim ("nothing else calls
 * this") stays a legitimate `reproduced`: that is exactly what a search
 * settles.
 *
 * What it cannot check is a BORROWED transcript — a script written for another
 * hypothesis, cited as this one's reproduction. Whether that transcript shows
 * this hypothesis's scenario is a reading, not a string match, so it is
 * reported (`borrowedFrom`, a note here, a line in the dossier) and left to the
 * adjudicator rather than enforced.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { type HypothesisSet, readHypothesisSet, resolveHypothesis } from "./hypotheses.js";
import { parseJsonl } from "./jsonl.js";
import { isBehaviouralClaim, severityOf } from "./survey-verdict.js";

/**
 * The verdict vocabulary, strongest evidence first. `reproduced` and `refuted`
 * claim EXECUTION; `corroborated` claims a read that supports the claim;
 * `unprobed` claims nothing and is always free.
 */
export const PROBE_VERDICTS = ["reproduced", "corroborated", "refuted", "unprobed"] as const;
export type ProbeVerdict = (typeof PROBE_VERDICTS)[number];

/**
 * Commands that READ code rather than run it. Matched on a segment's program
 * name (its basename, so `/usr/bin/grep` counts), never on its arguments.
 *
 * `lastlight-facts` is here on purpose: a facts query is a fresh, independent
 * artefact and settles structural claims — the falsify ladder's tier 4 — but it
 * does not execute the behaviour a behavioural claim describes. `git show` /
 * `git diff` are deliberately NOT: a differential probe compares two versions,
 * which is the ladder's tier 1 and measured as honest evidence.
 */
const READ_ONLY_PROGRAMS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "cat", "bat", "head", "tail", "less", "more", "nl",
  "sed", "awk", "wc", "ls", "find", "sort", "uniq", "cut", "tr",
  "lastlight-facts",
]);
/** `git <sub>` spellings that only read the tree. */
const READ_ONLY_GIT = new Set(["grep", "ls-files"]);
/** Segment heads that neither read nor execute the code under review. */
const NEUTRAL_PROGRAMS = new Set(["cd", "echo", "printf", "true", ":", "set", "export"]);

type SegmentKind = "read" | "neutral" | "other";

function segmentKind(segment: string): SegmentKind {
  // Leading `VAR=value` assignments are environment, not the program.
  const words = segment.trim().split(/\s+/).filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!)) words.shift();
  if (!words.length) return "neutral";
  const program = basename(words[0]!.replace(/^[({]+/, ""));
  if (NEUTRAL_PROGRAMS.has(program)) return "neutral";
  if (program === "git") return READ_ONLY_GIT.has(words[1] ?? "") ? "read" : "other";
  if (program === "lastlight" && words[1] === "facts") return "read";
  if (program === "xargs") return segmentKind(words.slice(1).join(" ")) === "read" ? "read" : "other";
  return READ_ONLY_PROGRAMS.has(program) ? "read" : "other";
}

/**
 * Is every command in this string a READ — grep, a file view, a facts query —
 * with nothing that executes code?
 *
 * Splits a differential `BASE: … HEAD: …` pair and every pipeline / `&&` /
 * `||` / `;` segment, and answers `true` only when at least one segment reads
 * and none runs anything else. `grep -rn x src | wc -l` is a read;
 * `node probe.mjs | grep FAIL` is not, because `node` ran. Deliberately
 * forgiving in the other direction: anything it does not recognise counts as
 * execution, so the gate can only ever refuse the shapes named above.
 */
/**
 * Split a shell line on its UNQUOTED `|`, `||`, `&&`, `;` and newlines. Quote-
 * aware because a grep alternation is the common case: measured,
 * `grep -rn "CalendarCache.init\|new CalendarCacheRepository" …` split naively
 * yields a "program" called `new` and reads as execution.
 */
function shellSegments(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < line.length) {
        current += ch + line[++i];
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      continue;
    }
    if (ch === "\\" && i + 1 < line.length) {
      current += ch + line[++i];
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "|" || ch === ";" || ch === "\n" || (ch === "&" && line[i + 1] === "&")) {
      out.push(current);
      current = "";
      if ((ch === "|" && line[i + 1] === "|") || ch === "&") i++;
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out;
}

export function isReadOnlyCommand(command: string): boolean {
  const parts = differentialParts(command.replace(/^\s*[$>#]\s+/, ""));
  let reads = 0;
  for (const part of parts) {
    for (const segment of shellSegments(part)) {
      const kind = segmentKind(segment);
      if (kind === "other") return false;
      if (kind === "read") reads += 1;
    }
  }
  return reads > 0;
}

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
  command?: unknown;
}

export interface ProbeGapKind {
  /** `no-verdict` — asked for, never answered. `no-transcript` — answered with
   * a claim of evidence and nothing to show. `unexecuted` — answered with a
   * transcript that records no command having been run: no `command` field, or
   * one the transcript's first line does not echo. `read-not-reproduction` — a
   * `reproduced` verdict on a behavioural claim whose every command is a read
   * (grep, a file view, a facts query): that is `corroborated`, not a
   * reproduction (issue #405). */
  kind: "no-verdict" | "no-transcript" | "unexecuted" | "read-not-reproduction";
  hypothesis: string;
  detail: string;
}

export interface CheckProbesResult {
  /** Hypotheses that had to be probed: `needsProbe`, or `Critical` regardless. */
  required: string[];
  /** Of those, the ones with a verdict of any kind. */
  answered: string[];
  byVerdict: Record<string, number>;
  /**
   * Of the required hypotheses, how many were answered with a verdict that
   * CLAIMS execution (`reproduced` / `refuted`).
   */
  claimedExecution: number;
  /**
   * Of those, how many named a `command` echoed on their transcript's first
   * non-blank line — i.e. how many actually ran something. The honesty of this
   * phase as a NUMBER: the run that motivated the check reads `0/9`, and it took
   * reading nine files by hand to find that out.
   */
  executed: number;
  /**
   * Verdicts (on any hypothesis, required or not) whose transcript belongs to a
   * DIFFERENT hypothesis — see {@link ProbeAnswer.borrowedFrom}. Reported, not
   * gated: whether the borrowed run shows this hypothesis's scenario is a
   * reading of the transcript, which this gate does not make.
   */
  borrowed: number;
  gaps: ProbeGapKind[];
  /** Lines that were not JSON at all, counted rather than silently skipped. */
  malformed: number;
  /** True ⇒ the loop may stop. */
  satisfied: boolean;
  /** One line per interesting fact, for the phase log. */
  notes: string[];
}

/**
 * One JSON value per row, malformed lines COUNTED rather than skipped — see
 * `jsonl.ts`, which also recovers a pretty-printed row. Exported because
 * `findings.ts` reads the same `hypotheses/*.jsonl` for the `adjudicate` gate,
 * and two readers of one append-only artifact is two places for "how many
 * lines did we drop?" to disagree.
 */
export function readJsonl<T>(path: string): { rows: T[]; recovered: number; malformed: number } {
  if (!existsSync(path)) return { rows: [], recovered: 0, malformed: 0 };
  const { rows, recovered, malformed } = parseJsonl(readFileSync(path, "utf8"));
  return { rows: rows as T[], recovered, malformed };
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
  return (severityOf(row) ?? "").toLowerCase() === "critical";
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

/**
 * Where a named transcript actually landed, or `null` if nowhere. Both roots
 * are tried for the reason {@link CheckProbesOptions.repo} gives.
 */
function resolveTranscript(options: CheckProbesOptions, transcript: string): string | null {
  for (const root of [options.repo ?? process.cwd(), options.dir]) {
    const candidate = resolve(root, transcript);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Normalise a command line for comparison: shell prompts, backticks, quoting
 * noise and run-length whitespace are presentation, not evidence. Forgiving on
 * purpose — the gate is here to separate *ran something* from *read something*,
 * not to police transcript formatting, and every false failure costs a probe
 * round for nothing.
 */
function normaliseCommand(text: string): string {
  return text
    .replace(/[`'"]/g, "")
    .replace(/^\s*[$>#]\s+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * A transcript's leading bytes, or `null` if it could not be read. Bounded:
 * a transcript can be a whole test-suite log, and the evidence this gate
 * checks always lives at the top of it.
 */
function transcriptHead(path: string): string | null {
  try {
    return readFileSync(path, "utf8").slice(0, 8192);
  } catch {
    return null;
  }
}

/** The first non-blank line of an already-read transcript head, or `null`. */
function firstNonBlankLine(head: string): string | null {
  for (const line of head.split("\n")) {
    if (line.trim()) return line;
  }
  return null;
}

/**
 * Split a differential probe's `command` into its BASE and HEAD halves.
 *
 * `review-falsify.md` asks a differential probe to run "the same input
 * against base and head" and document both in one `command` string
 * (`"BASE: <cmd1> HEAD: <cmd2>"`). But base and head are two separate tool
 * invocations, not one, so they land on two different transcript lines — the
 * model was never going to make the second command appear on line 1, because
 * it hadn't run yet when line 1 was written. Splitting the two halves apart
 * lets each be checked against wherever it actually landed, instead of
 * demanding the whole compound string verbatim on the first line.
 *
 * Falls through to the whole string when the `BASE:`/`HEAD:` pair isn't
 * there, so a differential probe that genuinely is ONE command (e.g. a single
 * `git diff base...head`) is checked exactly as before.
 */
function differentialParts(command: string): string[] {
  const m = command.match(/^\s*base:\s*(.+?)\s*;?\s*head:\s*(.+)$/is);
  return m ? [m[1].trim(), m[2].trim()] : [command];
}

/** One hypothesis's answer, canonical id resolved and transcript located. */
export interface ProbeAnswer {
  /** The verdict as written; `"(missing)"` when the line carried none. */
  verdict: string;
  /** The command the verdict claims it ran, or `null`. */
  command: string | null;
  /** The transcript path as written, or `null`. */
  transcript: string | null;
  /** Where that transcript actually is on disk, or `null` if nowhere. */
  transcriptPath: string | null;
  /**
   * The canonical id of ANOTHER hypothesis this verdict's evidence was written
   * for, or `null`. Read off the transcript's file name and any
   * `probes/<name>.<ext>` script the command runs: `probes/spec-002.txt` cited
   * by `enforcement-004` is `spec-002`'s run. Measured on one case: 3 of 13
   * `reproduced` verdicts cited another hypothesis's script. It counts for this
   * hypothesis only if its transcript shows THIS hypothesis's scenario — a
   * reading the adjudicator makes, so it is surfaced rather than gated.
   */
  borrowedFrom: string | null;
}

/**
 * Which other hypothesis, if any, a verdict's transcript or probe script was
 * written for. Every candidate stem goes through {@link resolveHypothesis}, so
 * a file named after a model-minted alias still resolves, and a stem naming
 * nothing (`probe.txt`, `run-all.mjs`) is ignored.
 */
function borrowedFromOf(set: HypothesisSet, ownId: string, transcript: string | null, command: string | null): string | null {
  const stems: string[] = [];
  if (transcript) stems.push(basename(transcript).replace(/\.[^.]+$/, ""));
  for (const m of (command ?? "").matchAll(/probes\/([A-Za-z0-9_-]+)\.[A-Za-z0-9]+/g)) stems.push(m[1]!);
  for (const stem of stems) {
    const resolution = resolveHypothesis(set, stem);
    if (resolution.kind === "resolved" && resolution.id !== ownId) return resolution.id;
  }
  return null;
}

/**
 * Every hypothesis that has an answer, canonical id resolved, newest line
 * winning — the one reader of `probes/verdicts.jsonl`.
 *
 * Split out of {@link checkProbes} so the adjudication dossier
 * (`adjudicate-render.ts`) can inline a verdict and its transcript without a
 * second parser. Two readers of one append-only artifact is two places for
 * "which line wins" and "which id does this answer" to disagree, and both
 * questions have already cost this pipeline a measurement.
 *
 * Note what is deliberately NOT returned: the verdict's `reason` field. A
 * dossier carries evidence and records, never an earlier pass's prose — agents
 * shown the reasoning that produced a false report fail to reject it 96% of the
 * time, which is the whole point of `adjudicate` running `fresh_context: true`.
 */
export function readProbeAnswers(
  options: CheckProbesOptions,
  set: ReturnType<typeof readHypothesisSet>,
): { answers: Map<string, ProbeAnswer>; malformed: number } {
  const { rows, malformed } = readJsonl<VerdictLine>(join(options.dir, "probes", "verdicts.jsonl"));
  const latest = new Map<string, VerdictLine>();
  for (const row of rows) {
    if (typeof row.hypothesis !== "string") continue;
    // Resolved to the CANONICAL id, so a verdict written against a model-minted
    // `H-001` still answers `contract-001`. An ambiguous citation resolves to
    // nothing and the hypothesis stays unanswered — which is the honest reading:
    // a verdict naming an id two families minted does not say which it probed.
    const resolution = resolveHypothesis(set, row.hypothesis);
    if (resolution.kind !== "resolved") continue;
    // LAST write wins: the file is append-only, so a second round revising a
    // verdict appends rather than edits, and the newest line is the answer.
    latest.set(resolution.id, row);
  }
  const answers = new Map<string, ProbeAnswer>();
  for (const [id, row] of latest) {
    const transcript = typeof row.transcript === "string" ? row.transcript : null;
    const command = typeof row.command === "string" && row.command.trim() ? row.command.trim() : null;
    answers.set(id, {
      // Case-normalised: `Reproduced` is the same claim, and a gate that read
      // it as an unknown verdict would silently excuse it from every check.
      verdict: typeof row.verdict === "string" ? row.verdict.trim().toLowerCase() : "(missing)",
      command,
      transcript,
      transcriptPath: transcript === null ? null : resolveTranscript(options, transcript),
      borrowedFrom: borrowedFromOf(set, id, transcript, command),
    });
  }
  return { answers, malformed };
}

/**
 * Does the answer's transcript record the command it claims — first part on
 * the first non-blank line, every later differential part somewhere in the
 * head? The one check behind "a claim of evidence has a transcript to show".
 */
export function transcriptRecordsCommand(answer: ProbeAnswer): { ok: boolean; firstLine: string | null; readable: boolean } {
  if (!answer.transcriptPath || !answer.command) return { ok: false, firstLine: null, readable: answer.transcriptPath !== null };
  const head = transcriptHead(answer.transcriptPath);
  const firstLine = head === null ? null : firstNonBlankLine(head);
  // A differential `command` ("BASE: cmd1 HEAD: cmd2") is two invocations,
  // not one — only the first can be held to "on line one"; the second is
  // checked against the transcript as a whole, wherever its own echo landed.
  const [firstPart, ...restParts] = differentialParts(answer.command);
  const firstOk = firstLine !== null && normaliseCommand(firstLine).includes(normaliseCommand(firstPart!));
  const restOk = head !== null && restParts.every((part) => normaliseCommand(head).includes(normaliseCommand(part)));
  return { ok: firstOk && restOk, firstLine, readable: head !== null };
}

/**
 * How strong the evidence behind one hypothesis's verdict actually is, read
 * off the record rather than off the label.
 *
 *   `executed`     `reproduced`, with a transcript that records its command,
 *                  and not a read passed off as a reproduction.
 *   `corroborated` `corroborated` with its transcript — OR a `reproduced`
 *                  whose every command is a read against a behavioural claim,
 *                  which the gate refuses and this demotes if one survives the
 *                  loop's last iteration anyway.
 *   `refuted`      `refuted`, with a transcript that records its command.
 *   `none`         `unprobed`, no answer, or a claim of evidence with nothing
 *                  on disk to back it.
 *
 * The single reader both the dossier and the derived finding severity
 * (`finding-severity.ts`) use, so "what does this verdict count for?" is
 * decided once.
 */
export type ProbeStrength = "executed" | "corroborated" | "refuted" | "none";

export function probeStrength(answer: ProbeAnswer | null | undefined, row: { evidence?: unknown }): ProbeStrength {
  if (!answer) return "none";
  const recorded = transcriptRecordsCommand(answer).ok;
  switch (answer.verdict) {
    case "reproduced":
      if (!recorded) return "none";
      return isBehaviouralClaim(row) && isReadOnlyCommand(answer.command ?? "") ? "corroborated" : "executed";
    case "corroborated":
      return recorded ? "corroborated" : "none";
    case "refuted":
      return recorded ? "refuted" : "none";
    default:
      return "none";
  }
}

export function checkProbes(options: CheckProbesOptions): CheckProbesResult {
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

  const { answers, malformed: badVerdicts } = readProbeAnswers(options, set);
  malformed += badVerdicts;

  const byVerdict: Record<string, number> = {};
  const answered = answers;
  for (const row of answered.values()) byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
  const borrowed = [...answered.values()].filter((a) => a.borrowedFrom !== null && a.verdict !== "unprobed").length;
  const gaps: ProbeGapKind[] = [];
  let claimedExecution = 0;
  let executed = 0;
  for (const id of required) {
    const row = answered.get(id);
    if (!row) {
      gaps.push({ kind: "no-verdict", hypothesis: id, detail: "no line in probes/verdicts.jsonl" });
      continue;
    }
    const verdict = row.verdict === "(missing)" ? "" : row.verdict;
    // `unprobed` (and anything else) stops here, and deliberately: the honest
    // answer has to stay costless or the gate teaches dishonesty.
    if (verdict !== "reproduced" && verdict !== "refuted" && verdict !== "corroborated") continue;
    // `corroborated` claims evidence too — a read that supports the claim — so
    // it is held to the same transcript bar. It does not claim EXECUTION, so it
    // is not counted in the executed/claimed ratio below.
    const claimsExecution = verdict !== "corroborated";
    if (claimsExecution) claimedExecution += 1;
    // THE rule, mechanised. A refutation with nothing to show for it is an
    // argument wearing a verdict's clothes, and it is the one move that costs
    // recall outright.
    const transcript = row.transcript;
    const resolved = row.transcriptPath;
    if (resolved === null) {
      gaps.push({
        kind: "no-transcript",
        hypothesis: id,
        detail: `verdict "${verdict}" names ${transcript ?? "no transcript"}, which does not exist — only a transcript may refute`,
      });
      continue;
    }
    // …and the second half of the same rule: the transcript has to be the
    // record of an EXECUTION. `"command": "code inspection"` over a page of
    // prose was 9 of 9 verdicts on the first real run.
    const command = row.command ?? "";
    if (!command) {
      gaps.push({
        kind: "unexecuted",
        hypothesis: id,
        detail: `verdict "${verdict}" names no command — reading the code is not a probe; if you executed nothing the verdict is "unprobed"`,
      });
      continue;
    }
    const { ok, firstLine } = transcriptRecordsCommand(row);
    if (!ok) {
      gaps.push({
        kind: "unexecuted",
        hypothesis: id,
        detail:
          `verdict "${verdict}" claims \`${command}\` but ${transcript} does not record it ` +
          `(first line: ${firstLine === null ? "the file could not be read" : JSON.stringify(firstLine.trim().slice(0, 80))}) — ` +
          `the transcript must show every command you claim, in the order you ran it; if you executed nothing the verdict is "unprobed"`,
      });
      continue;
    }
    // Issue #405, the mechanical half. A grep that confirms the code reads the
    // way a behavioural claim says has not shown the consequence happen — that
    // is `corroborated`. Structural claims are untouched: a search is exactly
    // what settles "nothing else calls this".
    const record = set.byId.get(id);
    if (
      verdict === "reproduced" &&
      record &&
      isBehaviouralClaim(record.row as { evidence?: unknown }) &&
      isReadOnlyCommand(command)
    ) {
      gaps.push({
        kind: "read-not-reproduction",
        hypothesis: id,
        detail:
          `verdict "reproduced" rests on \`${command}\`, which only READS code, and this hypothesis claims a behaviour ` +
          `(its evidence records a consequence at head) — a search shows the code reads the way the claim says, not that ` +
          `the consequence happens. Record it "corroborated", or run something that exercises the scenario`,
      });
      continue;
    }
    if (claimsExecution) executed += 1;
  }
  // The same read-not-reproduction rule on hypotheses nobody REQUIRED a probe
  // for: a volunteered `reproduced` is still read downstream as an execution
  // (the dossier, the derived severity), so it is held to the same line. Only
  // this rule — the transcript bar stays scoped to required ids, as it always
  // was, so a volunteered verdict cannot make the gate harder to close than
  // relabelling it.
  for (const [id, row] of answered) {
    if (required.has(id) || row.verdict !== "reproduced" || !row.command) continue;
    const record = set.byId.get(id);
    if (!record || !isBehaviouralClaim(record.row as { evidence?: unknown }) || !isReadOnlyCommand(row.command)) continue;
    if (!transcriptRecordsCommand(row).ok) continue;
    gaps.push({
      kind: "read-not-reproduction",
      hypothesis: id,
      detail:
        `verdict "reproduced" rests on \`${row.command}\`, which only READS code, and this hypothesis claims a behaviour — ` +
        `record it "corroborated", or run something that exercises the scenario`,
    });
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
  // LD6: the interesting number is the one that can be ZERO while everything
  // else looks clean. Nine `reproduced` verdicts and no command between them is
  // exactly what a silent pass looked like, so it is said out loud every time.
  if (claimedExecution > 0) {
    notes.push(
      `${executed}/${claimedExecution} reproduced/refuted verdict(s) ran a command their transcript records` +
        (executed === 0
          ? " — NOT ONE of them executed anything; reading the code is not a probe"
          : ""),
    );
  }
  if (borrowed > 0) {
    notes.push(
      `${borrowed} verdict(s) cite a transcript or script written for ANOTHER hypothesis — each counts only if that run shows this hypothesis's own scenario`,
    );
  }

  return {
    required: [...required].sort(),
    answered: [...required].filter((id) => answered.has(id)).sort(),
    byVerdict,
    claimedExecution,
    executed,
    borrowed,
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
  // Printed unconditionally when anything claimed execution, including when it
  // is the whole of the answer: `executed=0` beside `reproduced=9` is the
  // single line that would have caught this by eye.
  if (result.claimedExecution > 0) {
    lines.push(
      `  executed: ${result.executed}/${result.claimedExecution} reproduced/refuted verdict(s) with a command their transcript records`,
    );
  }
  for (const note of result.notes) lines.push(`  note: ${note}`);
  for (const gap of result.gaps.slice(0, 20)) lines.push(`  ✗ ${gap.hypothesis}: ${gap.detail}`);
  if (result.gaps.length > 20) lines.push(`  … and ${result.gaps.length - 20} more`);
  return lines.join("\n");
}
