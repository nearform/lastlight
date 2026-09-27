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
 */
import type { Obligation } from "./seed.js";

/** Bump whenever the rendering below changes, so cached readings are not reused across it. */
export const UNITS_PROMPT_VERSION = "units-v1";

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
      "Does a comment, doc line or example this unit shows make a checkable claim about behaviour that is FALSE at head? (What the PR was asked to do is not available to this unit — only the falsifiable-documentation half is asked here.)",
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
  inSymbol: string | null;
  inDiff: boolean;
  isTest: boolean;
  text: string | null;
}

export interface ShownCallee {
  name: string;
  declaredAt: string | null;
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
  /** `{ index, of }` when a long unit was split into overlapping passes. */
  part: { index: number; of: number } | null;
  source: ShownBlock[];
  imports: ShownBlock | null;
  importsOmitted: number;
  callers: ShownCaller[];
  callersOmitted: number;
  callees: ShownCallee[];
  calleesOmitted: number;
  obligations: ShownObligation[];
  /** Plain lines for the `pr` unit's overview (changed/deleted/skipped files). */
  overview: string[];
  /** Families whose questions are asked, in order. */
  asked: string[];
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

const EVIDENCE_FIELDS = [
  '  subject            string — the symbol, path, behaviour or criterion the entry is about',
  '  control_site       "path:line" of the line that CLOSES the mechanism (see QUESTIONS for what closes it per family), or "none"',
  '  control_text       that line, verbatim — unquotable means control_site is "none"',
  '  authority          "binding" (holds if the other side is hostile, buggy or older) | "advisory" | "unknown"',
  '  order_ok           true | false | "unknown" — does the control run BEFORE what it governs?',
  '  cannot_distinguish two different situations the control treats alike, or exactly "nothing"',
  '  bypass             one concrete path reaching the governed operation without the control, or exactly "none found"',
  "  in_changed_hunk    true | false — does this PR touch the subject, the control, or a site using either?",
  "  consequence        what goes wrong, and what it does then — or null when nothing is wrong",
  '  trigger            "input" | "state" (reachable at head) | "code_change" (only after someone edits the source) | "unknown"',
  "  crosses_boundary   true | false — crosses a trust boundary, loses or drops data, or breaks an existing caller?",
  "  capability_gained  something the supplier does NOT already hold without this defect, or null",
];

const NOT_FINDINGS = [
  "NOT FINDINGS (category rules, never a confidence bar): a pre-existing issue this change merely sits next to",
  "(unless the change is what makes it wrong); anything a compiler or linter catches (unless the code silences it);",
  "a restatement of the intended change; a point deliberately silenced; generated files; \"X is never validated\"",
  "with no consumer that then misbehaves. Doubt is not on this list — record it, and let the evidence say unknown.",
];

/**
 * Render the request. Pure: same model in, same bytes out.
 */
export function renderUnitRequest(m: RequestModel): string {
  const L: string[] = [];
  const multiFile = m.kind === "pr";
  const ids = m.obligations.map((s) => s.obligation.id);

  L.push(`UNIT SURVEY ${m.unitId} · ${UNITS_PROMPT_VERSION}`);
  L.push("");
  L.push(
    "You are reviewing ONE unit of a pull request: the code below and the neighbours a deterministic analysis",
    "found for it. You cannot open files or run anything — answer from what is shown, and write `unknown` where",
    "only something not shown could settle a field. Two jobs:",
    "  1. Answer every obligation under OBLIGATIONS, each exactly once.",
    "  2. Record every other defect you can see in this unit, under the family whose question it answers.",
    "Over-produce: later phases can delete a risk you wrote down and can never recover one you did not.",
    "Reply with ONE JSON object and nothing else.",
  );
  L.push("");

  L.push("UNIT");
  if (m.kind === "pr") {
    L.push("  kind: pr — the obligations no single symbol or region of the diff could hold, plus the PR's overview");
  } else {
    const what =
      m.kind === "symbol"
        ? `symbol ${m.symbol ?? "(anonymous)"}${m.symbolKind ? ` (${m.symbolKind})` : ""}`
        : "module-scope region (changed lines outside any function)";
    const range = m.lines ? ` · lines ${m.lines[0]}-${m.lines[1]} at head` : "";
    L.push(`  kind: ${m.kind} · ${what} · file: ${m.file ?? "(none)"}${range} · language: ${m.language ?? "unknown"}`);
  }
  if (m.part) {
    L.push(
      `  pass ${m.part.index} of ${m.part.of}: this unit was too long for one request, so it is split into overlapping passes; the others cover the rest of it`,
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
    L.push(
      multiFile ? "EXCERPTS — the site each obligation below was introduced at" : "SOURCE",
      "Every shown line is tagged `L<number>`; `+` after the tag marks a line this PR added or changed; `-|` rows",
      "were REMOVED by this PR at that point and carry no tag.",
    );
    for (const block of m.source) L.push(...renderBlock(block));
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
      const where = [c.inSymbol ? `in ${c.inSymbol}` : null, c.inDiff ? "changed in this PR" : "NOT touched by this PR", c.isTest ? "test" : null]
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
      "  enforced. Nothing has been verified. Answer the question with the evidence record below.",
    );
    for (const s of m.obligations) L.push(...renderObligation(s));
  }
  L.push("");

  L.push("QUESTIONS — the families this unit is surveyed for");
  for (const family of m.asked) {
    const q = FAMILY_QUESTIONS[family];
    if (!q) continue;
    L.push(`  ${family}: ${q.question}`);
    L.push(`    closes it: ${q.closes}.`);
  }
  L.push("");
  L.push(...NOT_FINDINGS);
  L.push("");

  L.push("EVIDENCE RECORD — every entry carries all twelve fields, facts not verdicts:");
  L.push(...EVIDENCE_FIELDS);
  L.push(
    '  "unknown" is a real answer; never round it to a clean value. A clean answer (the control holds) is recorded',
    "  with consequence: null — it is still an entry.",
  );
  L.push("");

  const exampleAnswer = ids.length > 0
    ? `{"obligation":"${ids[0]}","family":"${m.obligations[0]!.obligation.family}","claim":"…",${multiFile ? '"file":"…",' : ""}"line":<tag>,"evidence":{…}}`
    : "";
  L.push("RESPONSE — exactly this shape, one JSON object:");
  L.push(
    `  {"unitId":"${m.unitId}","answers":[${exampleAnswer}],"defects":[{"family":"…","claim":"…",${multiFile ? '"file":"…",' : ""}"line":<tag>,"evidence":{…}}]}`,
  );
  L.push("");
  L.push("RULES");
  L.push(`  - "unitId" is "${m.unitId}".`);
  if (ids.length > 0) {
    L.push(`  - "answers" holds one entry per obligation, each id EXACTLY ONCE: ${ids.join(", ")}.`);
    L.push("    An answer's family is the one its obligation is listed with.");
  } else {
    L.push('  - "answers" is [] — no obligation was attached.');
  }
  L.push(`  - "defects" holds everything else you found; [] only if you found nothing. family is one of: ${m.asked.join(", ")}.`);
  L.push(
    '  - "line" is the integer of a tag shown in this request (42 for L0042): the line the claim is about.' +
      (multiFile ? ' "file" is the FILE header that tag sits under.' : ""),
  );
  L.push("  - control_site may name any site shown here, a caller included, as path:line.");
  L.push("  - No severity, no needsProbe, no discharge code: they are computed from the evidence record.");
  L.push("  - No prose outside the JSON object.");
  return `${L.join("\n")}\n`;
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
