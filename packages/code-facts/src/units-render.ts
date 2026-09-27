/**
 * The unit survey's REQUEST text — the complete user message one model call
 * receives for one unit, rendered deterministically from what `units.ts`
 * assembled.
 *
 * It replaces a five-branch agent survey, so it carries every family's
 * question at once, compactly: an agent branch spent minutes re-deriving with
 * bash the context `facts`/`seed` had already computed, and here that context
 * is simply printed. What the prompts' long prose was FOR survives as one line
 * per family — the question, and what "closes" the mechanism for it, because
 * `control_site` is the one field of the evidence record whose meaning each
 * family fixes.
 *
 * ── The line tags are the contract, not decoration ─────────────────────────
 *
 * Every shown source line is `L<number>` + a change marker + `|`, under a
 * `FILE <path>` header. The reply's `line` must be one of those tags, and
 * {@link requestLineTags} reads them back out of the request text, so the
 * ingest checks the reply against exactly what the model was shown rather
 * than against a second copy of the rendering rules. Removed lines are shown
 * (`-|`) but carry no tag: they do not exist at head, so nothing can be
 * anchored to them.
 *
 * Nothing time- or run-dependent is printed — no sha, no timestamp — so an
 * unchanged unit renders byte-identically across re-pushes and its
 * `requestSha256` is a usable cache key.
 *
 * ── Shared prefix first, then the unit ─────────────────────────────────────
 *
 * A request is {@link UNITS_SHARED_PREFIX} (task, line-tag legend, the
 * always-asked families, the evidence record, the generic response rules —
 * unit-independent, byte-identical for every unit) followed by the
 * unit-specific part after {@link UNIT_SEPARATOR}. Providers cache the longest
 * shared prompt prefix, so anything that varies by unit — its id, its counts, a
 * conditional family such as `tests` — belongs after the separator.
 */
import type { Obligation } from "./seed.js";

/** Bump whenever the rendering below changes, so cached readings are not reused across it. */
export const UNITS_PROMPT_VERSION = "units-v7";

/** One family's question, compact. `closes` is what `control_site` means for it. */
export const FAMILY_QUESTIONS: Record<string, { question: string; closes: string }> = {
  contract: {
    question:
      "A producer's shape moved — return shape, field name, enum value, event payload, status code, units, nullability, ordering. Does every consumer, above all one this PR did not touch, still satisfy it? State both sides: producer now emits X; consumer at path:line still reads Y.",
    closes: "the consumer line whose type, schema or guard makes the shape it expects the shape it gets",
  },
  enforcement: {
    question:
      "A value — a limit, expiry, quota, token claim, set of supported inputs — is defined on one side of a boundary. Who COMPARES it on the other? An unsupported input silently defaulted or dropped instead of refused is a correctness bug.",
    closes:
      "a comparison on the binding side. A line that mentions the value, passes it on, or sets it as an option closes nothing",
  },
  security: {
    question:
      "Does any path into this code carry attacker-controlled input to a sink — injection, authn/authz, secret handling, untrusted input, a guard fed a shape it was not written for? A hazard nobody can reach is still recorded, at its real tier.",
    closes: "a sanitiser, escape or authorisation check between source and sink, at a point the attacker does not control",
  },
  state: {
    question:
      "Ordering, lifecycle, cache invalidation, concurrency, re-entrancy, retries, partial failure, empty/null/boundary inputs — what does this code do on the SECOND call, not the first? An untouched caller whose behaviour ripples is yours.",
    closes: "the invalidation, guard or ordering constraint that makes the second call behave like the first",
  },
  spec: {
    question:
      "Does a comment, doc line or example this unit shows make a checkable claim about behaviour that is FALSE at head? What the PR was asked to do reaches a unit only as a spec obligation under OBLIGATIONS (an acceptance criterion, quoted): answer each one listed — quote the line that implements it, or say that none shown does.",
    closes: "the line that actually implements what the text claims",
  },
  tests: {
    question: "Is a changed line executed by no test that asserts on it?",
    closes: "an assertion that exercises the changed line",
  },
};

/** The families every unit is asked about. `tests` only rides along with a `tests` obligation. */
export const ALWAYS_ASKED = ["contract", "enforcement", "security", "state", "spec"] as const;

/** A line of source, as shown to the model. */
export interface ShownLine {
  line: number;
  text: string;
  changed: boolean;
  /** Lines this PR removed immediately BEFORE this one. Shown, never tagged. */
  removedBefore: string[];
}

/** One `FILE <path>` block of tagged lines. */
export interface ShownBlock {
  file: string;
  lines: ShownLine[];
  /** Lines removed after the block's last line (end of file). */
  removedAfter: string[];
}

export interface ShownCaller {
  at: string;
  /** The symbol this is a reference TO — set only when the unit declares more than one symbol with callers. */
  of: string | null;
  inSymbol: string | null;
  inDiff: boolean;
  isTest: boolean;
  text: string | null;
}

export interface ShownCallee {
  name: string;
  declaredAt: string | null;
}

/**
 * One SPEC obligation as a unit carries it — an acceptance criterion from the
 * PR body or a linked issue, built harness-side (`review-spec.ts`) and read
 * from `spec-obligations.json`. Structurally `SpecObligation` minus the fields
 * a request does not print.
 */
export interface SpecUnitObligation {
  /** `S-1`, `S-2`, … */
  id: string;
  /** End one: what was asked, quoted verbatim. */
  criterion: string;
  /** Where it was asked: `issue #12` or `the PR body`. */
  source: string;
  /** End two: changed files that could implement it, best match first. */
  candidates: string[];
  question: string;
}

export interface ShownObligation {
  obligation: Obligation;
  /** The other end's candidate sites, with their head text where it was read. */
  candidates: { at: string; text: string | null }[];
  /** Candidates omitted to fit the budget. */
  candidatesOmitted: number;
}

/** Everything a request is rendered from. Built by `units.ts`. */
export interface RequestModel {
  unitId: string;
  kind: "symbol" | "module" | "pr";
  file: string | null;
  symbol: string | null;
  symbolKind: string | null;
  lines: [number, number] | null;
  language: string | null;
  /**
   * Set when a unit was split to fit the budget: `lines` = overlapping passes
   * over one long extent; `regions` = a file's module-scope regions spread
   * across several units.
   */
  part: { index: number; of: number; how: "lines" | "regions" } | null;
  /** Small changed functions folded into a module unit, each shown whole. */
  folded: { name: string; kind: string; lines: [number, number] }[];
  source: ShownBlock[];
  imports: ShownBlock | null;
  importsOmitted: number;
  callers: ShownCaller[];
  callersOmitted: number;
  callees: ShownCallee[];
  calleesOmitted: number;
  obligations: ShownObligation[];
  /** Spec obligations attached to this unit, listed after the seeded ones. */
  specObligations: SpecUnitObligation[];
  /** Plain lines for the `pr` unit's overview (changed/deleted/skipped files). */
  overview: string[];
  /** Families whose questions are asked, in order. One, for a unit split by family. */
  asked: string[];
  /**
   * Set when a large unit is surveyed once PER FAMILY (`units.ts`,
   * `FAMILY_SPLIT_CHANGED_LINES`): this unit asks only `family`, and its
   * siblings — same source, same neighbours — ask the rest of `families`.
   */
  familySplit: { family: string; families: string[]; threshold: number } | null;
  /** A one-line note printed under UNIT when the shrink cascade removed context. */
  shrinkNote: string | null;
}

/** `L0042` — at least four digits, so tags align and sort. */
export function lineTag(line: number): string {
  return `L${String(line).padStart(4, "0")}`;
}

function renderBlock(block: ShownBlock): string[] {
  const out = [`FILE ${block.file}`];
  const width = block.lines.reduce((w, l) => Math.max(w, lineTag(l.line).length), 5);
  const removed = (text: string): string => `${" ".repeat(width)}-|${text}`;
  for (const shown of block.lines) {
    for (const text of shown.removedBefore) out.push(removed(text));
    out.push(`${lineTag(shown.line).padEnd(width)}${shown.changed ? "+" : " "}|${shown.text}`);
  }
  for (const text of block.removedAfter) out.push(removed(text));
  return out;
}

const clip = (text: string, max = 200): string => (text.length > max ? `${text.slice(0, max)}…` : text);

function renderObligation(shown: ShownObligation): string[] {
  const o = shown.obligation;
  const out = [
    `${o.id} · family ${o.family} · expects ${o.discharge}`,
    `  mechanism: ${o.mechanism}`,
    `  introduced at: ${o.introducedAt.path}:${o.introducedAt.line} — ${clip(o.introducedAt.quote)}`,
  ];
  if (shown.candidates.length > 0 || shown.candidatesOmitted > 0) {
    out.push("  other end — candidate sites, NOT yet checked (found: false):");
    for (const c of shown.candidates) {
      out.push(c.text === null ? `    - ${c.at}` : `    - ${c.at} · ${clip(c.text.trim())}`);
    }
    if (shown.candidatesOmitted > 0) out.push(`    (${shown.candidatesOmitted} more not shown, to fit the request budget)`);
  }
  out.push(`  question: ${o.question}`);
  return out;
}

function renderSpecObligation(o: SpecUnitObligation): string[] {
  const shown = o.candidates.slice(0, MAX_SPEC_CANDIDATES);
  const more = o.candidates.length - shown.length;
  return [
    `${o.id} · family spec · asked in ${o.source}`,
    `  criterion: "${clip(o.criterion, 400)}"`,
    `  candidate files, best match first — NOT yet checked (found: false): ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`,
    `  question: ${o.question}`,
  ];
}

/** Candidate files printed per spec obligation. */
const MAX_SPEC_CANDIDATES = 8;

/**
 * `consequence` is the field the v5 audit caught empty: of 482 obligation
 * answers 89% had it null — 198 of them with `control_site: "none"`, i.e. no
 * closing control found and still "nothing goes wrong" — and 48% of answers'
 * claims only restated the obligation's question. So v6 makes the claim a
 * verdict and ties a null consequence to a quoted control that holds;
 * `units-ingest` flags the checkable half (no control or an advisory one, and
 * a null consequence) in `ingest.json` without rewriting the answer.
 */
const EVIDENCE_FIELDS = [
  '  subject            string — the symbol, path, behaviour or criterion the entry is about',
  '  control_site       "path:line" of the line that CLOSES the mechanism (see QUESTIONS for what closes it per family), or "none"',
  '  control_text       that line, verbatim — unquotable means control_site is "none"',
  '  authority          "binding" (holds if the other side is hostile, buggy or older) | "advisory" | "unknown"',
  '  order_ok           true | false | "unknown" — does the control run BEFORE what it governs?',
  '  cannot_distinguish two different situations the control treats alike, or exactly "nothing"',
  '  bypass             one concrete path reaching the governed operation without the control, or exactly "none found"',
  "  in_changed_hunk    true | false — does this PR touch the subject, the control, or a site using either?",
  "  consequence        what goes wrong as a result, and for whom. REQUIRED when control_site is \"none\" or the control is",
  "                     advisory or bypassable; null ONLY when the claim quotes a control that holds",
  '  trigger            "input" | "state" (reachable at head) | "code_change" (only after someone edits the source) | "unknown"',
  "  crosses_boundary   true | false — crosses a trust boundary, loses or drops data, or breaks an existing caller?",
  "  capability_gained  something the supplier does NOT already hold without this defect, or null",
];

/**
 * What stays out of `defects` — CATEGORIES, never a confidence bar. Since
 * units-v7 this is the only thing that keeps an unprompted defect out; see
 * {@link DEFECTS_BREADTH} for why there is no bar any more.
 */
const NOT_FINDINGS = [
  "NOT FINDINGS (category rules, never a confidence bar): a pre-existing issue the change does not make wrong;",
  "anything a compiler or linter catches (unless the code silences it); a restatement of the intended change; a point",
  "deliberately silenced; generated files; \"X is never validated\" with no consumer that then misbehaves; a test's own",
  "assertions or wording; inventing what unseen code does — a link that depends on code not shown is recorded with",
  "that field unknown, not left out. Doubt is not on this list, for a defect or an obligation: write it down, and let",
  "the evidence say unknown.",
];

/**
 * units-v7: breadth, and the known noise removed IN CODE rather than by a bar.
 *
 * Measured over 8 skillspro cases × 2 arms (50 gold, judge-credited): v1 —
 * "over-produce", no bar — credited 11/50 from 1,246 rows (482 obligation
 * answers carrying 3 credits, 764 unprompted defects). Of those defects 320
 * had trigger `code_change` (0 credited) and 157 were spec-family nitpicks
 * about tests and comments (0 credited); the ~419 input/state/unknown defects
 * carried 8 credits. v4 and v5 added a DEFECT BAR and a count prior:
 * unprompted defects fell to 154 and credited gold to 6, then 3. v6 kept the
 * bar but dropped the count prior and split large units by family: Haiku 5,
 * GPT-6 Luna (low) 6. Breadth of unprompted defects is what drives recall, and
 * the largest known noise class is identifiable from a TYPED field — so the
 * model is asked to write everything down and label a hypothetical future
 * edit honestly as `code_change`, and `units-ingest` demotes exactly those
 * (out of `hypotheses/`, recorded in `ingest.json`). Test-assertion nitpicks
 * stay a NOT FINDINGS category. No count prior and no cap.
 */
const DEFECTS_BREADTH = [
  "DEFECTS — record every defect you can see in this unit that a changed (+) or removed (-|) line causes or makes",
  "reachable. Later stages probe and adjudicate every entry: they can remove a risk, but they can never recover one that",
  "was not written down. Only the NOT FINDINGS categories above stay out. A defect that exists only if someone later",
  "edits the code is recorded with trigger \"code_change\" — label it honestly, never as input or state. A defect always",
  "has a consequence; a check that holds belongs in an obligation's answer, never in defects.",
];

/**
 * The line that ends the shared prefix. Everything above it is identical for
 * every unit of every run; everything below it is this unit's.
 */
export const UNIT_SEPARATOR = "=== THIS UNIT ===";

function familyLines(families: readonly string[]): string[] {
  const out: string[] = [];
  for (const family of families) {
    const q = FAMILY_QUESTIONS[family];
    if (!q) continue;
    out.push(`  ${family}: ${q.question}`);
    out.push(`    closes it: ${q.closes}.`);
  }
  return out;
}

/**
 * The unit-independent head of every request: the task, how source is shown,
 * the always-asked families, the evidence record, the response shape and the
 * generic rules — ending with {@link UNIT_SEPARATOR}.
 *
 * ── Why it is a PREFIX, byte for byte ──────────────────────────────────────
 *
 * Providers cache the longest shared PREFIX of a prompt. About 6k characters
 * of every request are the same for every unit, so they come first and carry
 * nothing unit-specific — no unit id, no count, no per-unit family subset (a
 * conditional family is asked after the separator). A run's N calls then pay
 * for this text once. It depends on nothing but the prompt version, so it is
 * identical across runs too.
 */
function renderSharedPrefix(): string {
  const L: string[] = [];
  L.push(`UNIT SURVEY · ${UNITS_PROMPT_VERSION}`);
  L.push("");
  L.push(
    "You are reviewing ONE unit of a pull request: the code shown after the line \"" + UNIT_SEPARATOR + "\" and the",
    "neighbours a deterministic analysis found for it. You cannot open files or run anything — answer from what is",
    "shown, and write `unknown` where only something not shown could settle a field. Two jobs:",
    "  1. Answer every obligation the unit lists under OBLIGATIONS, each exactly once, with YOUR VERDICT on the code.",
    "  2. Record every defect this change causes or makes reachable in the unit — see DEFECTS below. [] only when you",
    "     see none.",
    "Reply with ONE JSON object and nothing else.",
  );
  L.push("");
  L.push(
    "HOW SOURCE IS SHOWN",
    "  Each block of source sits under a `FILE <path>` header. Every shown line is tagged `L<number>`; `+` after the",
    "  tag marks a line this PR added or changed; `-|` rows were REMOVED by this PR at that point and carry no tag.",
    "  A `⋮` row between two runs of lines of the same file marks lines that are not shown.",
  );
  L.push("");
  L.push(
    "QUESTIONS — a unit is surveyed for all of these families, unless its own section says it asks only ONE (a large",
    "unit is surveyed once per family); a unit may also add a family after its own section",
  );
  L.push(...familyLines(ALWAYS_ASKED));
  L.push("");
  L.push(...NOT_FINDINGS);
  L.push("");
  L.push(...DEFECTS_BREADTH);
  L.push("");
  L.push("EVIDENCE RECORD — every entry carries all twelve fields, facts not verdicts:");
  L.push(...EVIDENCE_FIELDS);
  L.push(
    '  "unknown" is a real answer; never round it to a clean value. A clean answer (the control holds) is recorded',
    "  with consequence: null — it is still an entry. No holding control shown means the consequence is not null.",
  );
  L.push("");
  L.push("RESPONSE — exactly this shape, one JSON object:");
  L.push(
    '  {"unitId":"<the unit\'s id>","answers":[{"obligation":"<id>","family":"<its family>","claim":"…","file":"…","line":<tag>,"evidence":{…}}],"defects":[{"family":"…","claim":"…","file":"…","line":<tag>,"evidence":{…}}]}',
  );
  L.push("");
  L.push("RULES");
  L.push('  - "unitId" is the id the unit states below.');
  L.push('  - "answers" holds one entry per obligation the unit lists, each id EXACTLY ONCE, under the family it is listed');
  L.push("    with; [] when it lists none.");
  L.push('  - "claim" is YOUR VERDICT on the code, one sentence — e.g. "`limit` is compared at src/a.ts:42 before the write"');
  L.push('    or "nothing shown compares `limit` against the upload size, so an oversized upload is stored". Never the');
  L.push("    obligation's question or mechanism restated.");
  L.push('  - control_site "none", or a control that is advisory or bypassable ⇒ "consequence" says what goes wrong as a');
  L.push("    result. consequence: null only when the claim quotes a control that holds.");
  L.push('  - "defects" holds every defect you can see (DEFECTS above); [] only when there is none. Its family is one the');
  L.push("    unit asks.");
  L.push('  - "line" is the integer of a tag shown in this request (42 for L0042): the line the claim is about.');
  L.push('  - "file" is the FILE header that tag sits under: required when the unit shows more than one file, else optional.');
  L.push("  - control_site may name any site shown here, a caller included, as path:line.");
  L.push("  - No severity, no needsProbe, no discharge code: they are computed from the evidence record.");
  L.push("  - No prose outside the JSON object.");
  L.push("");
  L.push(UNIT_SEPARATOR);
  return `${L.join("\n")}\n`;
}

/** The shared prefix — see {@link renderSharedPrefix}. Every request starts with exactly these bytes. */
export const UNITS_SHARED_PREFIX: string = renderSharedPrefix();

/**
 * Render the unit-specific part: everything after the shared prefix. Pure:
 * same model in, same bytes out.
 */
export function renderUnitSpecific(m: RequestModel): string {
  const L: string[] = [];
  const multiFile = m.kind === "pr";
  const ids = [...m.obligations.map((s) => s.obligation.id), ...m.specObligations.map((o) => o.id)];
  const firstFamily = m.obligations[0]?.obligation.family ?? (m.specObligations.length > 0 ? "spec" : null);

  L.push(`UNIT ${m.unitId}`);
  if (m.kind === "pr") {
    L.push("  kind: pr — the obligations no single symbol or region of the diff could hold, plus the PR's overview");
  } else {
    const what =
      m.kind === "symbol"
        ? `symbol ${m.symbol ?? "(anonymous)"}${m.symbolKind ? ` (${m.symbolKind})` : ""}`
        : `module-scope changes (changed lines outside any function unit), in ${m.source.length} region(s)`;
    const range =
      m.kind === "module"
        ? ` · shown at head: ${m.source.map((b) => `${b.lines[0]?.line ?? 0}-${b.lines[b.lines.length - 1]?.line ?? 0}`).join(", ")}`
        : m.lines
          ? ` · lines ${m.lines[0]}-${m.lines[1]} at head`
          : "";
    L.push(`  kind: ${m.kind} · ${what} · file: ${m.file ?? "(none)"}${range} · language: ${m.language ?? "unknown"}`);
  }
  if (m.folded.length > 0) {
    L.push("  it also holds these small changed functions, each shown whole:");
    for (const f of m.folded) L.push(`    - ${f.name} (${f.kind}) · lines ${f.lines[0]}-${f.lines[1]}`);
  }
  if (m.part) {
    L.push(
      m.part.how === "lines"
        ? `  pass ${m.part.index} of ${m.part.of}: this unit was too long for one request, so it is split into overlapping passes; the others cover the rest of it`
        : `  part ${m.part.index} of ${m.part.of}: this file's module-scope changes were too long for one request, so its regions are split across units; the others cover the rest`,
    );
  }
  if (m.shrinkNote) L.push(`  ${m.shrinkNote}`);
  L.push("");

  if (m.overview.length > 0) {
    L.push("PR OVERVIEW");
    for (const line of m.overview) L.push(`  ${line}`);
    L.push("");
  }

  if (m.source.length > 0) {
    L.push(multiFile ? "EXCERPTS — the site each obligation below was introduced at" : "SOURCE");
    let previous: ShownBlock | null = null;
    for (const block of m.source) {
      if (previous && previous.file === block.file) {
        const last = previous.lines[previous.lines.length - 1]?.line ?? 0;
        const next = block.lines[0]?.line ?? 0;
        L.push(`${" ".repeat(5)}⋮ ${next - last - 1} line(s) not shown`);
        L.push(...renderBlock(block).slice(1));
      } else {
        L.push(...renderBlock(block));
      }
      previous = block;
    }
    L.push("");
  }

  if (m.imports && m.imports.lines.length > 0) {
    L.push(`IMPORTS of ${m.imports.file}`);
    L.push(...renderBlock(m.imports));
    if (m.importsOmitted > 0) L.push(`(${m.importsOmitted} more import line(s) not shown, to fit the request budget)`);
    L.push("");
  } else if (m.importsOmitted > 0) {
    L.push(`IMPORTS — ${m.importsOmitted} line(s) not shown, to fit the request budget`, "");
  }

  if (m.kind !== "pr") {
    L.push("CALLERS — reference sites of the symbols this unit declares (outside the unit)");
    if (m.callers.length === 0 && m.callersOmitted === 0) L.push("  none recorded by the analysis");
    for (const c of m.callers) {
      const where = [
        c.of ? `of ${c.of}` : null,
        c.inSymbol ? `in ${c.inSymbol}` : null,
        c.inDiff ? "changed in this PR" : "NOT touched by this PR",
        c.isTest ? "test" : null,
      ]
        .filter(Boolean)
        .join("; ");
      L.push(`  - ${c.at} (${where})${c.text === null ? "" : ` · ${clip(c.text.trim())}`}`);
    }
    if (m.callersOmitted > 0) L.push(`  (${m.callersOmitted} more not shown, to fit the request budget)`);
    L.push("");

    L.push("CALLEES — calls made from inside this unit");
    if (m.callees.length === 0 && m.calleesOmitted === 0) L.push("  none recorded by the analysis");
    for (const c of m.callees) L.push(`  - ${c.name}${c.declaredAt ? ` (declared at ${c.declaredAt})` : ""}`);
    if (m.calleesOmitted > 0) L.push(`  (${m.calleesOmitted} more not shown, to fit the request budget)`);
    L.push("");
  }

  L.push(`OBLIGATIONS (${ids.length})`);
  if (ids.length === 0) {
    L.push("  none were attached to this unit — job 2 is the whole task");
  } else {
    L.push(
      "  Each names BOTH ends of a possible defect: where something is introduced and where it would have to be",
      "  enforced. Nothing has been verified. Answer the question with the evidence record above.",
    );
    for (const s of m.obligations) L.push(...renderObligation(s));
    for (const o of m.specObligations) L.push(...renderSpecObligation(o));
  }
  L.push("");

  if (m.familySplit) {
    const { family, families, threshold } = m.familySplit;
    const others = families.filter((f) => f !== family);
    L.push(`ASKED OF THIS UNIT — ONLY ${family}`);
    L.push(
      `  This unit changes more than ${threshold} lines, so it is surveyed once per family. This request asks ONLY the`,
      `  ${family} question${others.length ? ` (sibling units ask ${others.join(", ")} of the same code)` : ""}: ignore the other questions`,
      `  above, and record every ${family} defect you can see — only ${family} defects.`,
    );
    L.push(...familyLines([family]));
    L.push("");
  }

  const extra = m.familySplit ? [] : m.asked.filter((f) => !(ALWAYS_ASKED as readonly string[]).includes(f));
  if (extra.length > 0) {
    L.push("ALSO ASKED of this unit");
    L.push(...familyLines(extra));
    L.push("");
  }

  const exampleAnswer =
    ids.length > 0
      ? `{"obligation":"${ids[0]}","family":"${firstFamily}","claim":"…",${multiFile ? '"file":"…",' : ""}"line":<tag>,"evidence":{…}}`
      : "";
  L.push("RESPONSE FOR THIS UNIT");
  L.push(
    `  {"unitId":"${m.unitId}","answers":[${exampleAnswer}],"defects":[{"family":"${m.familySplit?.family ?? "…"}","claim":"…",${multiFile ? '"file":"…",' : ""}"line":<tag>,"evidence":{…}}]}`,
  );
  L.push(`  - "unitId" is "${m.unitId}".`);
  if (ids.length > 0) {
    L.push(`  - "answers" holds one entry per obligation, each id EXACTLY ONCE: ${ids.join(", ")}.`);
  } else {
    L.push('  - "answers" is [] — no obligation was attached.');
  }
  if (ids.length > 0) {
    L.push('  - each "claim" is your verdict on the code, not the question restated; no holding control ⇒ a non-null consequence.');
  }
  L.push(
    m.familySplit
      ? `  - every defect's family is ${m.familySplit.family}.`
      : `  - a defect's family is one of: ${m.asked.join(", ")}.`,
  );
  if (multiFile) L.push('  - this unit shows several files: every entry carries "file".');
  return `${L.join("\n")}\n`;
}

/**
 * Render the whole request: {@link UNITS_SHARED_PREFIX} followed by the
 * unit-specific part. Pure: same model in, same bytes out.
 */
export function renderUnitRequest(m: RequestModel): string {
  return UNITS_SHARED_PREFIX + renderUnitSpecific(m);
}

/** A tagged line as the request showed it. */
export interface TaggedLine {
  text: string;
  changed: boolean;
}

/**
 * Every `(file, line)` tag a rendered request shows, with the text it showed,
 * read back out of the request itself.
 *
 * The ingest uses this rather than a second copy of the rendering rules, so a
 * reply is judged — and its quote filled in — against exactly what the model
 * saw.
 */
export function requestLineTags(request: string): Map<string, Map<number, TaggedLine>> {
  const tags = new Map<string, Map<number, TaggedLine>>();
  let file: string | null = null;
  for (const line of request.split("\n")) {
    if (line.startsWith("FILE ")) {
      file = line.slice(5);
      if (!tags.has(file)) tags.set(file, new Map());
      continue;
    }
    const match = /^L(\d{4,})\s*?([+ ])\|(.*)$/.exec(line);
    if (match && file !== null) {
      tags.get(file)!.set(Number(match[1]), { text: match[3] ?? "", changed: match[2] === "+" });
    }
  }
  return tags;
}
