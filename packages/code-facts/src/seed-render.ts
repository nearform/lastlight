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
 *
 * ── The rule had no field to be written in, for two whole runs ──────────────
 *
 * Measured 2026-08-23 across both preserved runs, all eight cases, every family:
 * **not one obligation carried a discharge code — 0/31, 0/34, 0/40, every
 * time.** The block demanded *"exactly one of QUOTE / ABSENT / PARTIAL /
 * PROBE"* and the prescribed row shape it printed twenty lines later had **no
 * field to put one in**. That is not model non-compliance; it is a contract that
 * was never expressible in the format the same block demanded. The third
 * instance of this package's recurring shape — after the conservation gate that
 * passed falsely and the model-minted ids that collided — and the header above
 * had already written the principle down: *the instruction and the mechanism it
 * governs must not be separable*. The mechanism half was missing.
 *
 * So the row now carries `discharge`, in the spelling `checkDischarge` reads
 * (`discharge.ts`), beside the obligation id; the block lists **every id that
 * needs one**, wrapped and never truncated, exactly as the discharge ledger
 * does; and `tests/seed-render.test.ts` feeds the rendered exemplar back through
 * `checkDischarge` so the emitted shape cannot drift out of the gate's reading.
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
  "The code goes in the row's `discharge` field — the shape, and every id that needs one, are at the end of this",
  "block. An obligation's own `expects:` (quote / probe / either) is what it is LIKELY answerable by: a hint, not",
  "one of the four, and `either` is not a discharge. Never copy it into `discharge`.",
  "",
  "OVER-PRODUCE. A plausible mechanism you cannot yet refute is a hypothesis, not noise — a later phase runs a",
  "probe and a stronger model adjudicates, and both can only remove. Nothing downstream can recover a mechanism",
  "you declined to write down, so the cost of a wrong hypothesis here is far below the cost of a missing one.",
];

/**
 * The one worked exemplar, and the only positive example anywhere in this
 * pipeline's prompts.
 *
 * **It is a real row, from a real run, about the one gold finding this whole
 * investigation has ever converted** — `prreview__skillspro-1587-r2`, obligation
 * `O-002`: `SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS` is set as a cookie `maxAge`
 * and the server never compares `issuedAt` against it, so a 5-minute lifetime is
 * enforced only by a browser choosing to honour it.
 *
 * **It is `PARTIAL` and that is the entire lesson.** The measured run discharged
 * this obligation `QUOTE`, citing `auth.ts:95` — a line that MENTIONS the
 * constant and compares nothing — and therefore produced no finding while
 * looking perfectly discharged. Every counter-example in these prompts teaches
 * what not to write; this one teaches the distinction that actually converted.
 *
 * Emitted as ONE line, via `JSON.stringify`, because that is the shape a JSONL
 * file wants and a pretty-printed exemplar in a block a cheap model reads is an
 * invitation to write pretty-printed JSONL. `tests/seed-render.test.ts` parses
 * this straight back out of the rendered block and feeds it to `checkDischarge`,
 * so the exemplar cannot drift into a shape the gate rejects.
 */
const EXAMPLE_ROW = {
  id: "enforcement-001",
  obligation: "O-002",
  discharge: "PARTIAL",
  family: "enforcement",
  claim:
    "the 5-minute nonce lifetime reaches the browser as a cookie maxAge and is never compared server-side",
  bothEnds: {
    introducedAt: "packages/backend/src/utils/constants.ts:33",
    enforcedAt: "packages/backend/src/routes/auth.ts:95",
  },
  quotes: [
    {
      path: "packages/backend/src/routes/auth.ts",
      line: 95,
      text: "      maxAge: SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS",
    },
  ],
  existingCode: "maxAge: SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS",
  failureScenario:
    "a scripted client, a browser with clock skew or a proxy replaying the header keeps the cookie past its stated expiry; nothing server-side compares issuedAt, so the same nonce stays valid indefinitely and the replay window is unbounded rather than 5 minutes",
  needsProbe: false,
  severity: "Critical",
  confidence: 0.6,
};

/** The outstanding-id list, wrapped rather than truncated. */
const IDS_LINE_WIDTH = 100;

/**
 * Every id on its own line-group, WRAPPED.
 *
 * Copied in spirit from `renderDischargeLedger`: a truncated checklist
 * reproduces the exact omission it exists to prevent, so this is never capped.
 */
function wrapIds(ids: string[]): string[] {
  const lines: string[] = [];
  let row: string[] = [];
  let width = 0;
  for (const id of ids) {
    if (row.length > 0 && width + 1 + id.length > IDS_LINE_WIDTH) {
      lines.push(`  ${row.join(" ")}`);
      row = [];
      width = 0;
    }
    width += (row.length > 0 ? 1 : 0) + id.length;
    row.push(id);
  }
  if (row.length > 0) lines.push(`  ${row.join(" ")}`);
  return lines;
}

/**
 * One obligation, in the shape the discharge contract expects back.
 *
 * The obligation's own `discharge` field is printed as **`expects:`**, never as
 * `discharge:`. It is a REQUIREMENT (`quote` / `probe` / `either` — what this
 * one is likely answerable by) and the row's `discharge` is an ANSWER (one of
 * the four codes), and while the gate tolerates the collision case-insensitively
 * (`discharge.ts`, `codeOf`), `either` is not one of the four: a model copying
 * the label it just read lands `bad-code` and the loop cannot satisfy the gate
 * however many iterations it spends. One word of separation removes that.
 */
function renderOne(o: Obligation): string[] {
  return [
    `${o.id}  [${o.family}]  expects: ${o.discharge}`,
    `  mechanism:    ${o.mechanism}`,
    `  introduced:   ${o.introducedAt.path}:${o.introducedAt.line}   ${o.introducedAt.quote}`,
    `  enforced at:  ${o.enforcedAt.candidates.join(", ")}`,
    `  found:        false   ← nothing has been checked; this is the claim, not a placeholder`,
    `  question:     ${o.question}`,
    "",
  ];
}

/**
 * Render the block for ONE family. **Never empty** — every seedable family
 * always gets a block, and that is what makes the file's ABSENCE mean something.
 *
 * It used to return `""` when a family had no obligations and nothing was
 * degraded, so the caller wrote no file at all. Three facts then collapsed onto
 * one missing path: *the seeder had nothing to say*, *the seeder never ran*, and
 * — the expensive one — *the consumer looked in the wrong place*. Measured over
 * three stored pr-review runs on 2026-08-22, the third accounted for 27 of 27
 * failed obligation reads across 120 survey branches, and the survey prompts'
 * "if that file does not exist, work the diff directly" escape hatch turned every
 * one of them into a silently unseeded pass.
 *
 * With a block always on disk, a missing file is unambiguous: something between
 * the seeder and the reader broke. `pr-review.yaml`'s `seed` phase prints a
 * per-family manifest off the same fact, and the survey branch is handed a loud
 * NOT AVAILABLE notice rather than an escape hatch (locked decision 6: "we could
 * not look" and "we looked and it is clean" are different facts, at every layer).
 */
export function renderFamilyBlock(doc: ObligationsDocument, family: SeedFamily): string {
  const mine = doc.obligations.filter((o) => o.family === family);
  const row = doc.families.find((f) => f.family === family);
  const notMeasured = row && !row.measured ? row.notMeasuredReason : null;

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
    `Append one JSON object per obligation to .lastlight/pr-review/hypotheses/${family}.jsonl — one line each:`,
    "",
    `  { "id": "${family}-001", "obligation": "${mine[0].id}", "discharge": "QUOTE|ABSENT|PARTIAL|PROBE",`,
    `    "family": "${family}", "claim": "…",`,
    '    "bothEnds": { "introducedAt": "path:line", "enforcedAt": "path:line" | null },',
    '    "quotes": [ { "path": "…", "line": 12, "text": "the line, verbatim" } ],',
    '    "existingCode": "the verbatim excerpt this is about",',
    '    "failureScenario": "what input or state makes this behave wrongly, and what it does then" | null,',
    '    "needsProbe": false, "severity": "Critical|Important|Minor", "confidence": 0.0-1.0 }',
    "",
    "`obligation` names WHICH one and `discharge` is its ANSWER — one of the four codes, uppercase. Listing",
    "an obligation without a `discharge` discharges nothing, and this is GRADED by a machine rather than taken",
    `on trust. Before you finish, run \`lastlight-facts discharge --ledger --family ${family}\` — it reads this`,
    `file back and ticks off every id, naming the ones still outstanding. All ${mine.length} below, none optional:`,
    ...wrapIds(mine.map((o) => o.id)),
    "",
    "A clean QUOTE gets a row too. That row is the RECORD that the question was answered, not a finding you",
    "are proposing — write it at `severity: \"Minor\"` and let a later phase decide what is worth posting.",
    "",
    "`failureScenario` is REQUIRED on every row that claims a defect — ABSENT, PARTIAL, PROBE, or a QUOTE you",
    "are raising: *what input or state makes this behave wrongly, and what does it do then?* A finding with no",
    "concrete failure scenario is an opinion. On a clean QUOTE write `null`. It is a SHAPE requirement and NOT",
    "a bar: nothing anywhere drops a hypothesis for a thin scenario, so write the weakest honest one rather",
    "than dropping the row — a row you decline to write is the one thing no later phase can recover.",
    "",
    "WORKED EXAMPLE — one real row, from a real `enforcement` pass on another PR. Copy the SHAPE, not the",
    `content: your rows carry ${family} ids and the obligations listed above. It answers "Quote the line that`,
    'compares or enforces SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS, or state that no such line exists.":',
    "",
    `  ${JSON.stringify(EXAMPLE_ROW)}`,
    "",
    "PARTIAL, not QUOTE: `auth.ts:95` MENTIONS the constant and compares nothing against it — the cookie is",
    "the only thing enforcing the lifetime, and a client is free not to honour it. A line that names a value",
    "is not a line that enforces it, and that gap IS the finding. A run that called this one QUOTE looked",
    "perfectly discharged and reported nothing.",
    "",
    `\`id\` is \`${family}-001\`, \`${family}-002\`, … — numbered within THIS family. Six passes append to six files`,
    "and none of them can see another's, so a bare `H-001` collides with whatever another family minted and",
    "credits neither claim. The id is namespaced so that cannot happen.",
    "",
    "`quotes` must be REAL text at REAL lines — a later phase checks that they resolve, and a claim whose quote",
    "does not resolve is discarded whatever its reasoning. `existingCode` is how the finding gets anchored:",
    "quote the code, do not count the lines. Do NOT write findings.json, do NOT post a review, and do NOT",
    `reason about any family other than ${family} — another pass owns each of the others.`,
  );

  return lines.join("\n");
}
