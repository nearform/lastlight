/**
 * Render one family's obligations as the block a survey phase reads.
 *
 * **Emitted from code, not from a prompt template.** This is WP0's most
 * expensive lesson, reused verbatim: `renderSpecObligations` emits its own fence
 * and its own discharge contract for the same reason, because *the instruction
 * and the mechanism it governs must not be separable*. A fork that kept the
 * obligations and dropped the "quote a line or say it is absent" rule would
 * reproduce exactly what candidate v3 measured — a 17-row ledger, honestly
 * discharged, **zero findings** — and the arm would read as "facts-seeding does
 * not work" when what failed was the discharge contract.
 *
 * The prompt template points at this block. The block carries the rule.
 */
import type { Obligation, ObligationsDocument, SeedFamily } from "./seed.js";

const FAMILY_TITLE: Record<SeedFamily, string> = {
  contract: "CONTRACT — a producer's shape moved; does every consumer outside the diff still satisfy it?",
  enforcement: "ENFORCEMENT — a value is defined on one side of a boundary; who checks it on the other?",
  security: "SECURITY — attacker-controlled input reaching a changed sink",
  state: "STATE — cache invalidation, lifecycle, ordering and concurrency on a changed symbol",
  tests: "TESTS — changed lines executed by zero tests",
};

/**
 * The discharge contract. Identical across families on purpose: the *questions*
 * differ, the *rule for answering one* must not, or a family becomes cheaper to
 * discharge than its neighbour and the funnel stops being comparable.
 */
const DISCHARGE = [
  "DISCHARGE EVERY OBLIGATION BELOW. Exactly one of:",
  "",
  "  QUOTE   — `path:line` and the line's text that answers the question. This is the only clean discharge.",
  "  ABSENT  — you read every candidate and no line answers it. THAT IS A FINDING: raise it, anchored to the",
  "            closest changed line, and say what the mechanism was.",
  "  PARTIAL — answered on some paths and not others. Quote the line AND name the gap.",
  "  PROBE   — it cannot be settled by reading, only by RUNNING something. Record it and say what you would run.",
  "",
  "Reading a file is not a discharge. Summarising the code is not a discharge. Quote a line, or say it is absent.",
  "",
  "OVER-PRODUCE. A plausible mechanism you cannot yet refute is a hypothesis, not noise — a later phase runs a",
  "probe and a stronger model adjudicates, and both can only remove. Nothing downstream can recover a mechanism",
  "you declined to write down, so the cost of a wrong hypothesis here is far below the cost of a missing one.",
];

/** One obligation, in the shape the discharge contract expects back. */
function renderOne(o: Obligation): string[] {
  return [
    `${o.id}  [${o.family}]  discharge: ${o.discharge}`,
    `  mechanism:    ${o.mechanism}`,
    `  introduced:   ${o.introducedAt.path}:${o.introducedAt.line}   ${o.introducedAt.quote}`,
    `  enforced at:  ${o.enforcedAt.candidates.join(", ")}`,
    `  found:        false   ← nothing has been checked; this is the claim, not a placeholder`,
    `  question:     ${o.question}`,
    "",
  ];
}

/**
 * Render the block for ONE family.
 *
 * Returns `""` only when the family has no obligations AND nothing degraded —
 * so a caller may omit the key entirely. A degraded family still renders,
 * because "we could not look" and "we looked and it is clean" are different
 * facts and an empty block cannot tell them apart (locked decision 6).
 */
export function renderFamilyBlock(doc: ObligationsDocument, family: SeedFamily): string {
  const mine = doc.obligations.filter((o) => o.family === family);
  const row = doc.families.find((f) => f.family === family);
  const notMeasured = row && !row.measured ? row.notMeasuredReason : null;

  if (mine.length === 0 && !notMeasured && doc.degraded.length === 0) return "";

  const lines: string[] = [];
  lines.push(`=== ${FAMILY_TITLE[family]} ===`);
  lines.push("");

  if (notMeasured) {
    lines.push(`NOT MEASURED: ${notMeasured}.`);
    lines.push("");
    lines.push(
      "That is NOT a pass and NOT a clean result. Nothing on this axis was analysed, so record it as",
      "`notMeasured` in your output and do not report an absence you were never in a position to observe.",
    );
    return lines.join("\n");
  }

  if (mine.length === 0) {
    lines.push(
      `No ${family} obligations could be built from the deterministic layer for this diff.`,
      "",
      "That is not a licence to skip the family — it means the seeder found no mechanism of this shape, not",
      "that none exists. Work the diff for this family's question directly, and say so in your output.",
    );
    if (doc.degraded.length > 0) {
      lines.push("", `The analysis ran ${doc.coverage}. What was not analysed:`);
      for (const d of doc.degraded.slice(0, 10)) lines.push(`  - [${d.extractor}] ${d.reason}`);
    }
    return lines.join("\n");
  }

  lines.push(
    `${mine.length} obligation(s), each naming BOTH ENDS of a mechanism: where a thing is introduced, and where`,
    "it would have to be enforced. A seed naming one end measures WORSE than no seed at all (IRIS ablation:",
    "-3 against a baseline of 0), which is why every entry below carries two sites and why none carries a verdict.",
    "",
    `Analysis coverage for this PR: ${doc.coverage}.`,
  );

  if (doc.coverage !== "full") {
    lines.push(
      "",
      "COVERAGE IS NOT FULL. Parts of this diff were not analysed, so the absence of an obligation about some",
      "file is not evidence that the file is clean. What was missed:",
    );
    for (const d of doc.degraded.slice(0, 10)) lines.push(`  - [${d.extractor}] ${d.reason}`);
  }

  const truncation = doc.dropped.find((d) => d.reason.includes("budget"));
  if (truncation) {
    lines.push(
      "",
      `${truncation.count} further obligation(s) were built and dropped to stay inside the per-PR budget. They are NOT "checked".`,
    );
  }

  lines.push("", ...DISCHARGE, "");
  for (const o of mine) lines.push(...renderOne(o));

  lines.push(
    `Append one JSON object per hypothesis to .lastlight/pr-review/hypotheses/${family}.jsonl — one line each:`,
    "",
    '  { "id": "H-001", "obligation": "O-001", "family": "' + family + '", "claim": "…",',
    '    "bothEnds": { "introducedAt": "path:line", "enforcedAt": "path:line" | null },',
    '    "quotes": [ { "path": "…", "line": 12, "text": "the line, verbatim" } ],',
    '    "existingCode": "the verbatim excerpt this is about",',
    '    "needsProbe": false, "severity": "Critical|Important|Minor", "confidence": 0.0-1.0 }',
    "",
    "`quotes` must be REAL text at REAL lines — a later phase checks that they resolve, and a claim whose quote",
    "does not resolve is discarded whatever its reasoning. `existingCode` is how the finding gets anchored:",
    "quote the code, do not count the lines. Do NOT write findings.json, do NOT post a review, and do NOT",
    `reason about any family other than ${family} — another pass owns each of the others.`,
  );

  return lines.join("\n");
}
