/**
 * `discharge` — the SURVEY loop's exit gate, and the third "an instruction is
 * not a mechanism" in this package.
 *
 * WP3 (`docs/plans/review-evidence-pipeline/03-seed-and-survey.md`). It answers
 * one question: **did every obligation this family owns get a recorded
 * discharge — QUOTE, ABSENT, PARTIAL or PROBE — in
 * `hypotheses/<family>.jsonl`?**
 *
 * ── What it replaces, and why one line was never enough ─────────────────────
 *
 * Each of the six survey branches in `pr-review.yaml` was gated by
 *
 *     until_bash: test -s .lastlight/pr-review/hypotheses/<family>.jsonl
 *
 * — which **one line of any content passes**. Meanwhile `seed-render.ts` emits a
 * DISCHARGE contract demanding exactly one of QUOTE / ABSENT / PARTIAL / PROBE
 * per obligation, and nothing checked it. Measured on
 * `prreview__skillspro-1587-r1` (2026-08-22), against 31 obligations:
 *
 *   - `state.jsonl` was ONE line — `{"claim": "no state hypothesis",
 *     "obligationIds": ["O-018", …]}` — for TEN obligations. It listed the ids
 *     and discharged none of them, and the gate passed.
 *   - `security.jsonl` was one free-form line that cited no obligation at all,
 *     against three.
 *   - `enforcement.jsonl` carried nine rows against thirteen obligations.
 *
 * Identical obligation sets then produced 18 hypotheses on one run and 43 on the
 * next (2.4×), and only 1 of 25 gold findings was found by all three runs. The
 * floor was one line; it should be N discharges. This is the same shape as the
 * conservation gate that passed falsely and the model-minted hypothesis ids that
 * collided — an instruction the prompt carried and no machine enforced.
 *
 * ── It reads through `hypotheses.ts`, and that is load-bearing ──────────────
 *
 * Exactly as `findings` and `probes` do. One reader of `hypotheses/*.jsonl`
 * means this gate, the conservation gate and the probe gate can never disagree
 * about which rows exist, how many lines were malformed, or which family a row
 * belongs to (the FILENAME's, never the row's self-report).
 *
 * ── `null` ≠ `[]`, three ways ───────────────────────────────────────────────
 *
 * The founding distinction of this package, and this gate is where it is most
 * expensive to collapse:
 *
 *   - **No `hypotheses/<family>.jsonl` at all** — nobody looked. `fileState:
 *     "missing"`, and the CLI exits `2` (could not run): there is no document to
 *     grade.
 *   - **An empty one** — looked, recorded nothing. `fileState: "empty"`, exit
 *     `3` when obligations are outstanding: a survey that ran and discharged
 *     nothing is a degraded result, not an absent one.
 *   - **A family marked NOT MEASURED in `obligations.json`** — the seeding
 *     surface was absent, so there was never anything to discharge. It PASSES,
 *     and the note says why, because failing a family for the absence of the
 *     thing it audits is how a gate takes a run down.
 *
 * A family with **zero obligations** passes too. Nothing mechanical was asked
 * of it; the survey still worked the diff, and this gate is in no position to
 * grade that.
 *
 * ── The one degradation, and why it is not a loophole ───────────────────────
 *
 * `pr-review.yaml` runs `seed … || true`, so `obligations.json` can be **absent**
 * — a `coverage: "none"` facts envelope makes `seed` exit before writing one. A
 * gate that demanded a file nothing guarantees would be **unsatisfiable by the
 * agent**, which is precisely WP3's original `$LL_FAMILY` bug (a gate testing
 * `hypotheses/.jsonl`, failing forever, burning every iteration). So with no
 * readable obligations document this command degrades to the `test -s` floor it
 * replaces — one parsed row passes — and says in its output that it graded
 * NOTHING. An **unknown family** is the opposite case and stays fatal: nothing
 * the agent writes can fix a misspelled `--family`, so it must break loudly at
 * the wiring rather than quietly pass.
 *
 * ── What it deliberately does NOT do ────────────────────────────────────────
 *
 * It does not read a quote, resolve a `path:line`, judge a claim, or check that
 * an ABSENT really is absent. Candidate v3's five-line existence gate earned the
 * investigation's only gold match and v2's full validator is what made it
 * expensive. This checks that the work was *recorded*, per obligation.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { titleFrom } from "./findings.js";
import { readHypothesisSet } from "./hypotheses.js";
import { noopLogger, type LoggerPort } from "./log.js";
import type { ObligationsDocument } from "./seed.js";

/**
 * The four codes `seed-render.ts`'s DISCHARGE contract demands, and the only
 * four this gate accepts. `PROBE` is a discharge: an obligation that can only be
 * settled by running something is honestly answered by saying so, and WP4's gate
 * picks it up from there. The honest answer has to be available, or the model is
 * pushed towards a dishonest one.
 */
export const DISCHARGE_CODES = ["QUOTE", "ABSENT", "PARTIAL", "PROBE"] as const;
export type DischargeCode = (typeof DISCHARGE_CODES)[number];

export type DischargeStatus =
  /** One of the four codes, against this obligation. */
  | "discharged"
  /**
   * A row NAMES the obligation and carries no code. The `state.jsonl` shape from
   * the real run: ten ids listed, none answered. Listing is not discharging.
   */
  | "no-code"
  /** A row names it with something that is not one of the four. */
  | "bad-code"
  /** No row in the family's file names it at all. */
  | "undischarged";

export interface DischargeEntry {
  /** `O-NNN`, as `obligations.json` assigned it. */
  obligation: string;
  /** Answerable by quoting ONE line, or by stating no such line exists. */
  question: string;
  mechanism: string | null;
  /** `path:line` — where the mechanism is introduced, for navigation. */
  introducedAt: string | null;
  status: DischargeStatus;
  /** The code, uppercased, when it was one of the four. */
  code: DischargeCode | null;
  /** What the row actually wrote, when it was NOT one of the four. */
  citedCode: string | null;
  /** Canonical `<family>-NNN` ids of the rows that named this obligation. */
  citedBy: string[];
}

export interface CheckDischargeResult {
  family: string;
  /** The `.lastlight/pr-review` directory it read, as the caller spelled it. */
  dir: string;
  /**
   * `missing` — nobody looked. `empty` — the file is there and holds no parsed
   * row. `present` — at least one row. Never collapse the first two.
   */
  fileState: "missing" | "empty" | "present";
  /** `false` ⇒ the seeding surface was absent for this family, not empty. */
  measured: boolean;
  notMeasuredReason: string | null;
  /** Every obligation this family owns, in document order. */
  entries: DischargeEntry[];
  /** Of those, the ones carrying one of the four codes. */
  discharged: string[];
  /** The todo list — everything not `discharged`, entry and all. */
  outstanding: DischargeEntry[];
  byCode: Record<string, number>;
  /** Parsed rows in `hypotheses/<family>.jsonl`. */
  rows: number;
  /** Lines that were not JSON at all, counted rather than silently skipped. */
  malformed: number;
  /** Cited ids that belong to ANOTHER family's obligations. Reported, not failed. */
  foreign: string[];
  /** Cited ids no obligation declares. Reported, not failed. */
  unknownCitations: string[];
  /**
   * Why `obligations.json` could not be read. `null` = it read fine. This does
   * NOT fail the gate on its own — see the module header: the gate falls back to
   * the `test -s` floor it replaces, loudly, rather than becoming unsatisfiable.
   */
  documentError: string | null;
  /**
   * The family is not one `obligations.json` knows. A wiring bug — a misspelled
   * or unset `--family` — and the one condition here that no agent can fix, so
   * it is fatal and never satisfied.
   */
  familyError: string | null;
  /** True ⇒ the loop may stop. */
  satisfied: boolean;
  /** One line per interesting fact, for the phase log. */
  notes: string[];
}

export interface CheckDischargeOptions {
  /** The `.lastlight/pr-review` directory. */
  dir: string;
  /** The survey branch's family — `contract`, `enforcement`, `spec`, … */
  family: string;
  log?: LoggerPort;
}

/** How many outstanding ids the gate's summary names before it starts counting. */
const MAX_LISTED = 20;

/** Line width for the ledger's outstanding list. Wrapping, never truncation. */
const IDS_LINE_WIDTH = 100;

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isCode(text: string): text is DischargeCode {
  return (DISCHARGE_CODES as readonly string[]).includes(text);
}

/**
 * The code a row claims, if any.
 *
 * `status` is accepted beside `discharge` because a real survey already wrote it
 * unprompted (`spec.jsonl`, run 1: `{"id": "S-1", "status": "QUOTE", …}`), and
 * refusing a spelling the model reached for on its own buys nothing but an extra
 * iteration.
 *
 * **Case-insensitive, deliberately.** It collides with the obligation's OWN
 * `discharge: "quote" | "probe" | "either"` field — a row that copies that
 * verbatim reads here as a QUOTE. That is accepted: the obligation's field is a
 * REQUIREMENT ("this one wants a quote") and the row's is an ANSWER ("I
 * quoted"), so the copy asserts the thing it appears to assert, and the row
 * still had to name the obligation to get there. `either` is not one of the four
 * and lands as `bad-code`. Failing an honest lowercase `"quote"` would be the
 * unsatisfiable-gate trap for nothing.
 */
function codeOf(row: Record<string, unknown>): string | null {
  return asString(row.discharge) ?? asString(row.status);
}

/** Every obligation id a value names, whether it is a string or a list of them. */
function idsIn(value: unknown): string[] {
  if (typeof value === "string") return asString(value) ? [value.trim()] : [];
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text) ids.push(text);
  }
  return ids;
}

/**
 * What one hypothesis row says about which obligations, and with what code.
 *
 * Two shapes, because the surveys wrote both: a row that IS one discharge
 * (`{"obligation": "O-014", "discharge": "ABSENT", …}`) and a row that carries
 * several (`{"obligations": [{"id": "O-014", "status": "QUOTE"}, …]}` — the
 * shape `spec.jsonl` chose on its own). A nested entry's code beats the row's,
 * because it is the more specific claim.
 *
 * What is NOT read: the prose. An `O-014` mentioned inside a `claim` string is
 * not a discharge — counting it would restore "one line of any content passes"
 * through the back door.
 */
export function dischargesIn(row: Record<string, unknown>): Map<string, string | null> {
  const found = new Map<string, string | null>();
  const rowCode = codeOf(row);

  const record = (id: string, code: string | null): void => {
    const existing = found.get(id);
    // Best claim wins: a valid code beats a bad one beats none. Two rows may
    // discharge the same obligation, and the later detail must not un-discharge
    // it — the files are append-only.
    const rank = (c: string | null): number =>
      c === null ? 0 : isCode(c.toUpperCase()) ? 2 : 1;
    if (existing !== undefined && rank(existing) >= rank(code)) return;
    found.set(id, code);
  };

  for (const key of ["discharges", "obligations", "findings"]) {
    const value = row[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item !== "object" || item === null) continue;
      const entry = item as Record<string, unknown>;
      const id =
        asString(entry.obligation) ?? asString(entry.obligationId) ?? asString(entry.id);
      if (!id) continue;
      record(id, codeOf(entry) ?? rowCode);
    }
  }

  for (const key of ["obligation", "obligations", "obligationIds", "obligation_ids"]) {
    for (const id of idsIn(row[key])) record(id, rowCode);
  }

  return found;
}

interface LoadedObligations {
  doc: ObligationsDocument | null;
  error: string | null;
}

/**
 * `obligations.json`, read loosely on purpose.
 *
 * No zod: `seed.ts` owns that document's shape and this gate reads four fields
 * of it. A stricter parse would turn a document the seeder happily wrote into a
 * gate failure, which is the wrong direction for a loop condition.
 */
function loadObligations(dir: string): LoadedObligations {
  const path = join(dir, "obligations.json");
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as ObligationsDocument;
    if (!Array.isArray(raw.obligations) || !Array.isArray(raw.families)) {
      return {
        doc: null,
        error: `${path}: no \`obligations\` / \`families\` arrays — this is not a seeder document`,
      };
    }
    return { doc: raw, error: null };
  } catch (err) {
    return { doc: null, error: `${path}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Did this family discharge its obligations?
 *
 * Pure: it reads two artifacts and writes nothing, ever. There is no `--repair`
 * analogue here and there must not be — the §D12 floor for a survey is the
 * loop's own `max_iterations`, and a machine that manufactured discharges would
 * be inventing the exact evidence the pipeline exists to demand.
 */
export function checkDischarge(options: CheckDischargeOptions): CheckDischargeResult {
  const log = options.log ?? noopLogger;
  const { family } = options;
  /** As the caller spelled it — the path a survey has to type back. */
  const jsonlPath = join(options.dir, "hypotheses", `${family}.jsonl`);
  const notes: string[] = [];
  const { doc, error: documentError } = loadObligations(options.dir);

  // Identity and enumeration come from the ONE reader `findings` and `probes`
  // use, so no two gates can disagree about which rows exist.
  const set = readHypothesisSet(options.dir);
  const records = set.records.filter((r) => r.family === family);
  // `readHypothesisSet` lists the directory, so a family it names has a FILE and
  // a family it does not name has none. That is the whole `null` vs `[]`
  // distinction, and it is derivable without a second reader.
  const fileState: CheckDischargeResult["fileState"] = !set.families.includes(family)
    ? "missing"
    : records.length === 0
      ? "empty"
      : "present";

  // Every citation this family's rows made, best-claim-wins per obligation.
  const cited = new Map<string, { code: string | null; by: string[] }>();
  for (const record of records) {
    for (const [id, code] of dischargesIn(record.row as Record<string, unknown>)) {
      const existing = cited.get(id);
      if (!existing) {
        cited.set(id, { code, by: [record.id] });
        continue;
      }
      existing.by.push(record.id);
      const rank = (c: string | null): number =>
        c === null ? 0 : isCode(c.toUpperCase()) ? 2 : 1;
      if (rank(code) > rank(existing.code)) existing.code = code;
    }
  }

  const familyRow = doc?.families.find((f) => f.family === family) ?? null;
  const familyError =
    doc !== null && familyRow === null
      ? `unknown family "${family}" — obligations.json names ${doc.families.map((f) => f.family).join(", ")}. This is a WIRING bug (an unset or misspelled --family), and no survey pass can discharge its way out of it`
      : null;

  // A missing `id` or `question` on an obligation is a seeder bug, and a gate
  // that threw on it would take the survey phase down over a field it only
  // PRINTS. Skip the unusable ones, default the rest. A gate that can crash is
  // not a gate.
  const mine = (doc?.obligations ?? []).filter(
    (o) => o?.family === family && asString(o.id) !== null,
  );
  const mineIds = new Set(mine.map((o) => o.id));
  const everyId = new Set((doc?.obligations ?? []).map((o) => o.id));

  const entries: DischargeEntry[] = mine.map((o) => {
    const hit = cited.get(o.id);
    const raw = hit?.code ?? null;
    const upper = raw === null ? null : raw.toUpperCase();
    const status: DischargeStatus = !hit
      ? "undischarged"
      : upper === null
        ? "no-code"
        : isCode(upper)
          ? "discharged"
          : "bad-code";
    return {
      obligation: o.id,
      question: asString(o.question) ?? `(no question recorded on ${o.id})`,
      mechanism: asString(o.mechanism),
      introducedAt: asString(o.introducedAt?.path)
        ? `${o.introducedAt.path}:${o.introducedAt.line}`
        : null,
      status,
      code: status === "discharged" ? (upper as DischargeCode) : null,
      citedCode: status === "bad-code" ? raw : null,
      citedBy: hit?.by ?? [],
    };
  });

  const byCode: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.code) byCode[entry.code] = (byCode[entry.code] ?? 0) + 1;
  }

  const foreign = [...cited.keys()].filter((id) => !mineIds.has(id) && everyId.has(id)).sort();
  const unknownCitations = [...cited.keys()]
    .filter((id) => !mineIds.has(id) && !everyId.has(id))
    .sort();

  const measured = familyRow?.measured ?? true;
  const notMeasuredReason = familyRow?.notMeasuredReason ?? null;
  const outstanding = entries.filter((e) => e.status !== "discharged");

  // ── The verdict, in the order the conditions actually bite.
  let satisfied: boolean;
  if (familyError !== null) {
    // Unsatisfiable by construction, so it must be loud rather than quiet.
    satisfied = false;
  } else if (documentError !== null) {
    // The degradation. See the module header: with nothing to grade against,
    // this falls back to the `test -s` floor it replaces rather than becoming a
    // gate no agent can pass.
    satisfied = fileState === "present";
    notes.push(
      `obligations.json could not be read, so NOTHING was graded — this run fell back to the \`test -s\` floor this gate exists to replace (${documentError})`,
    );
  } else if (!measured && mine.length === 0) {
    // NOT MEASURED is not a failure and is not a pass either — it is the third
    // answer, and the note is what keeps it from being read as the second.
    satisfied = true;
    notes.push(
      `family "${family}" is NOT MEASURED: ${notMeasuredReason ?? "no reason recorded"}. Nothing was analysed on this axis, so there was nothing to discharge — that is NOT a clean result`,
    );
  } else {
    satisfied = outstanding.length === 0;
  }

  // ── Notes. Everything a next iteration or a human needs that is not a gap.
  if (documentError === null && familyError === null) {
    if (mine.length === 0 && measured) {
      notes.push(
        `no ${family} obligations were built from the deterministic layer, so this gate graded nothing. That is not evidence the family is clean — the survey was told to work the diff directly`,
      );
    }
    if (!measured && mine.length > 0) {
      notes.push(
        `family "${family}" is marked NOT MEASURED yet carries ${mine.length} obligation(s) — grading them anyway, because an obligation that exists is checkable whatever the header says`,
      );
    }
  }
  if (fileState === "missing") {
    notes.push(
      `${jsonlPath} does not exist — NOBODY LOOKED. That is a different fact from an empty file, and neither of them is "surveyed and found nothing"`,
    );
  } else if (fileState === "empty") {
    notes.push(
      `${jsonlPath} exists and holds no parsed row — the pass ran and recorded nothing`,
    );
  }
  if (foreign.length > 0) {
    notes.push(
      `${foreign.length} citation(s) name another family's obligations (${foreign.slice(0, 10).join(", ")}) — each family's file is graded on its OWN obligations, so these discharge nothing here`,
    );
  }
  if (unknownCitations.length > 0) {
    notes.push(
      `${unknownCitations.length} citation(s) name ids no obligation declares (${unknownCitations.slice(0, 10).join(", ")})`,
    );
  }
  if (set.malformed > 0) notes.push(`${set.malformed} unparseable JSONL line(s) were ignored`);

  log.debug?.("graded a family's discharge", {
    dir: options.dir,
    family,
    obligations: mine.length,
    outstanding: outstanding.length,
    fileState,
  });

  return {
    family,
    dir: options.dir,
    fileState,
    measured,
    notMeasuredReason,
    entries,
    discharged: entries.filter((e) => e.status === "discharged").map((e) => e.obligation),
    outstanding,
    byCode,
    rows: records.length,
    malformed: set.malformed,
    foreign,
    unknownCitations,
    documentError,
    familyError,
    satisfied,
    notes,
  };
}

/**
 * The `until_bash` exit code, derived in ONE place so the CLI cannot drift from
 * the result object.
 *
 * `0` the loop may stop · `2` there was nothing to grade (no file, no document,
 * an unknown family) · `3` it ran and something is outstanding. **Any non-zero
 * means "iterate again"** — the split between 2 and 3 is the `null` vs `[]`
 * distinction made visible to a human reading the phase log, not two different
 * instructions to the loop.
 */
export function dischargeExitCode(result: CheckDischargeResult): 0 | 2 | 3 {
  if (result.satisfied) return 0;
  if (result.familyError !== null) return 2;
  if (result.documentError !== null) return 2;
  return result.fileState === "missing" ? 2 : 3;
}

/** A one-screen summary for the phase log — the gate's whole stdout. */
export function renderDischargeCheck(result: CheckDischargeResult): string {
  if (result.familyError !== null) {
    return [`discharge[${result.family}]: cannot grade`, `  ✗ ${result.familyError}`].join("\n");
  }

  const codes = Object.entries(result.byCode)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  const lines = [
    `discharge[${result.family}]: ${result.discharged.length}/${result.entries.length} obligations discharged` +
      ` (${codes ? `${codes}, ` : ""}${result.rows} hypothesis row(s), file ${result.fileState})`,
  ];
  for (const note of result.notes) lines.push(`  note: ${note}`);
  for (const entry of result.outstanding.slice(0, MAX_LISTED)) {
    lines.push(`  ✗ ${entry.obligation} [${entry.status}]: ${detailOf(entry)}`);
    lines.push(`        ${titleFrom(entry.question)}`);
  }
  if (result.outstanding.length > MAX_LISTED) {
    lines.push(`  … and ${result.outstanding.length - MAX_LISTED} more outstanding`);
  }
  return lines.join("\n");
}

/** Why this obligation is outstanding, in the words the next iteration needs. */
function detailOf(entry: DischargeEntry): string {
  switch (entry.status) {
    case "undischarged":
      return "no row names it — answer it with QUOTE, ABSENT, PARTIAL or PROBE";
    case "no-code":
      return `named by ${entry.citedBy.join(", ")} with no discharge code — listing an obligation is not discharging it`;
    case "bad-code":
      return `named by ${entry.citedBy.join(", ")} with discharge "${entry.citedCode}", which is not one of QUOTE / ABSENT / PARTIAL / PROBE`;
    default:
      return `discharged ${entry.code}`;
  }
}

/**
 * The CHECKLIST half — same reading, opposite audience.
 *
 * `renderDischargeCheck` answers the harness ("may the loop stop?") beside an
 * exit code. This answers the SURVEY ("what must I still answer?") with a list,
 * and it is what makes the gate satisfiable on the first attempt. Measured on
 * the `adjudicate` phase, whose ledger this copies: attempt 1 spent **426 s and
 * $0.52** reconstructing an id set by hand, missed ids anyway, and bought a
 * second **274 s / $0.43** attempt — 40% of the case's wall clock and 38% of its
 * cost, for a set that is mechanically derivable.
 *
 * **Nothing here is capped.** A truncated checklist reproduces the exact
 * omission it exists to prevent. The bound is on each question (one sentence,
 * ~100 chars via `titleFrom`) and the outstanding list WRAPS.
 */
export function renderDischargeLedger(result: CheckDischargeResult): string {
  if (result.familyError !== null) {
    return [
      `discharge ledger [${result.family}]: this family is not in obligations.json.`,
      `  ${result.familyError}`,
    ].join("\n");
  }

  const lines: string[] = [];
  const total = result.entries.length;

  if (total === 0) {
    lines.push(`discharge ledger [${result.family}]: no obligations to discharge.`);
    for (const note of result.notes) lines.push(`  ${note}`);
    lines.push(
      "  Nothing mechanical was asked of this pass, so the gate will pass on that basis.",
      "  This is NOT evidence that the family is clean — work the diff for its question",
      "  directly and record what you find.",
    );
    return lines.join("\n");
  }

  lines.push(
    `discharge ledger [${result.family}]: ${result.discharged.length}/${total} obligations discharged.`,
    "Every obligation below must be answered in a line of",
    `${join(result.dir, "hypotheses", `${result.family}.jsonl`)} carrying its id and EXACTLY ONE of:`,
    "  QUOTE — `path:line` and the line's text that answers it (the only clean discharge)",
    "  ABSENT — you read every candidate and no line answers it. THAT IS A FINDING",
    "  PARTIAL — answered on some paths and not others: quote the line AND name the gap",
    "  PROBE — it can only be settled by RUNNING something; say what you would run",
    "",
    'Listing an obligation id is not discharging it. Write `"discharge": "ABSENT"` on the line.',
    "",
  );
  for (const note of result.notes) lines.push(`  note: ${note}`, "");

  for (const entry of result.entries) {
    const mark = entry.status === "discharged" ? "[x]" : "[ ]";
    const meta = [entry.code ?? entry.status, entry.introducedAt].filter(Boolean).join(" · ");
    lines.push(`  ${mark} ${entry.obligation}${meta ? `  (${meta})` : ""}`);
    lines.push(`        ${titleFrom(entry.question)}`);
  }

  if (result.outstanding.length > 0) {
    lines.push("", `OUTSTANDING — ${result.outstanding.length} of ${total} not yet discharged:`);
    let row: string[] = [];
    let width = 0;
    for (const id of result.outstanding.map((e) => e.obligation)) {
      if (row.length > 0 && width + 1 + id.length > IDS_LINE_WIDTH) {
        lines.push(`  ${row.join(" ")}`);
        row = [];
        width = 0;
      }
      width += (row.length > 0 ? 1 : 0) + id.length;
      row.push(id);
    }
    if (row.length > 0) lines.push(`  ${row.join(" ")}`);
  } else {
    lines.push("", "Every obligation carries a discharge code.");
  }
  return lines.join("\n");
}
