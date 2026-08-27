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
 *
 * ── …and then recall went to zero. `--contract minimal` is the control ──────
 *
 * Measured the same day on `prreview__skillspro-1587-r2` with `--repeats 3`:
 * discharge compliance 0/33 → **33/33**, and the union of matched gold **4-of-5
 * → 0-of-5**, three repeats running. Half to two thirds of every hypothesis
 * became a *clean quote* — `discharge: QUOTE`, `failureScenario: null`, "I found
 * the line and it is fine" — 23, 25 and 30 clean of 45, 48 and 46.
 *
 * Two causes and the run cannot separate them, because two things changed at
 * once: the obligations may ask the WRONG QUESTION and making a wrong question
 * mandatory turns hunting into checklist-clearing (C1); or reliable seeding
 * itself suppresses discovery (C2 — the same commit stopped ~24% of survey
 * branches losing their seed entirely).
 *
 * So BOTH blocks live in this file, selected by `ObligationsDocument.contract`.
 * `full` is what is above and is the default, byte-for-byte. `minimal` is this
 * file exactly as it stood at `5fa06da1^` — restored from the diff, not
 * reimagined — which holds the delivery fix constant and puts the question back.
 * Two exceptions, each deliberate and each named at its site: the never-empty
 * rule below is DELIVERY and is kept under both, and the obligation line goes
 * back to `discharge:` under `minimal` (see {@link renderOne}).
 */
import type { StagedDiff } from "./schema.js";
import type {
  Obligation,
  ObligationContract,
  ObligationsDocument,
  SeedFamily,
} from "./seed.js";

const FAMILY_TITLE: Record<SeedFamily, string> = {
  contract:
    "CONTRACT — a producer's shape moved; does every consumer outside the diff still satisfy it?",
  enforcement:
    "ENFORCEMENT — a value is defined on one side of a boundary; who checks it on the other?",
  security: "SECURITY — attacker-controlled input reaching a changed sink",
  state:
    "STATE — cache invalidation, lifecycle, ordering and concurrency on a changed symbol",
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
 * The SAME contract as it stood at `5fa06da1^` — three lines shorter, and those
 * three lines are the whole difference.
 *
 * Kept as a second literal rather than composed out of {@link DISCHARGE}'s parts,
 * so that `full` is not one refactor away from moving. A control arm whose
 * baseline drifts measures nothing.
 *
 * **Note what this is NOT.** It is not "no discharge contract": the four codes
 * were always named here, and *"Reading a file is not a discharge"* is older
 * than the bug. What `minimal` removes is the three lines that made the codes
 * RECORDABLE — the pointer to the row's `discharge` field and to the id
 * checklist at the end of the block — which is why compliance measured 0/31,
 * 0/34 and 0/40 under it. This block asks for a discharge and gives the survey
 * nowhere to write one, and reproducing that exactly is the point.
 */
const DISCHARGE_MINIMAL = [
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
 *
 * **Under `minimal` the label goes back to `discharge:`, and that is a decision
 * rather than an oversight.** The trap the rename closes needs a row-level
 * `discharge` field for `either` to be copied INTO, and `minimal`'s prescribed
 * row has none — so the collision is inert there, while the label is one of the
 * strings the arm is trying to hold constant against the runs that scored 4-of-5.
 * A control that silently improves the thing it is controlling for measures the
 * improvement, not the variable. `checkDischarge` degrading to the `test -s`
 * floor under `minimal` (`discharge.ts`) is what makes the inertness real rather
 * than argued: no code is graded, so no code can land `bad-code`.
 */
function renderOne(o: Obligation, contract: ObligationContract): string[] {
  return [
    contract === "minimal"
      ? `${o.id}  [${o.family}]  discharge: ${o.discharge}`
      : `${o.id}  [${o.family}]  expects: ${o.discharge}`,
    `  mechanism:    ${o.mechanism}`,
    `  introduced:   ${o.introducedAt.path}:${o.introducedAt.line}   ${o.introducedAt.quote}`,
    `  enforced at:  ${o.enforcedAt.candidates.join(", ")}`,
    `  found:        false   ← nothing has been checked; this is the claim, not a placeholder`,
    `  question:     ${o.question}`,
    "",
  ];
}

/** How many of a family's own files the section names before deferring to the index. */
const STAGED_FILES_SHOWN = 12;

/** `src/server/auth.ts:73` → `src/server/auth.ts`; a bare path is left alone. */
function pathOf(candidate: string): string {
  return candidate.replace(/:\d+(?:-\d+)?$/, "");
}

/**
 * The f1 lever's half of the brief: **the diff is already on disk; do not
 * re-derive the range.**
 *
 * Measured, and it is two costs in one. Across the five survey branches a case
 * spends ~93 bash calls, ~30 of which re-derive ONE fixed merge-base range that
 * `facts.json` already holds — and surveys are ~75% of a case's spend. That is
 * the money. The other cost is correctness: every re-derivation is a fresh
 * chance to write `git diff base..HEAD` instead of `base...HEAD`, and two-dot
 * reports every commit the base branch picked up since the fork as though the
 * author wrote it (50 real PRs, 9 diverge, one 6,125 files against 3).
 *
 * ── It is an AFFORDANCE, and the framing is measured ─────────────────────────
 *
 * The first cut said *"read the staged patch INSTEAD OF running `git diff`"* and
 * over-suppressed: total survey bash calls fell 848 → 399, but the eliminated
 * range re-derivation accounts for only ~276 of that — ~170 non-derivation calls
 * (greps, file reads, reference tracing) went with it, and internal recall fell
 * 21/25 → 12/25. Access was never reduced: the staged diff sits INSIDE the full
 * checkout. A prohibition plus patch-anchoring narrowed the *behaviour*.
 *
 * So exactly one thing is forbidden — re-deriving the range — and the section
 * says out loud that the patch is a starting point rather than a scope. That
 * half is not decoration; it is the half the measurement says was missing.
 *
 * ── It is NEVER silently omitted ─────────────────────────────────────────────
 *
 * Three states and three different paragraphs, because they are three different
 * facts and locked decision 6 is that they must never collapse:
 *
 *   - staged        — here is the index, here are your family's files, read them
 *   - staging FAILED — `files: null`; the affordance is missing and you must
 *                      derive the range yourself, three-dot
 *   - never staged   — no record in the envelope at all; same instruction, and
 *                      it says so rather than leaving the section out
 *
 * A missing section would read to a survey as *"this deployment has no staged
 * diff"*, which is precisely the *"we could not look"* / *"we looked and it is
 * clean"* conflation the rest of this pipeline is built to prevent.
 *
 * ── Every path here is CHECKOUT-RELATIVE, and that is measured too ───────────
 *
 * Across three stored runs, 98 of 98 relative first-turn reads from a survey
 * branch succeeded and 0 of 27 workspace-root-absolute ones did: the only
 * absolute path a branch has been handed by its first turn is its skill bundle,
 * which lives one directory ABOVE the checkout the deterministic phases write
 * in. So this section never prints an absolute path and says out loud not to
 * build one.
 */
function renderStagedDiff(
  staged: StagedDiff | null | undefined,
  mine: Obligation[],
): string[] {
  const missing = (why: string): string[] => [
    "STAGED DIFF: NOT AVAILABLE.",
    "",
    why,
    "",
    "That is a MISSING AFFORDANCE, not an empty diff, and nothing below may be read as though this PR",
    "changed nothing. Derive the range yourself and use THREE DOTS —",
    "`git diff origin/<baseBranch>...HEAD`. Two-dot additionally contains every commit that landed on",
    "the base branch after this PR forked, and the author wrote none of it (50 real PRs, 9 diverge,",
    "one of them 6,125 files against 3).",
    "",
    "You are in the FULL CHECKOUT either way, and once you have the range that patch is your STARTING",
    "POINT, not your scope: open the changed files whole, grep for the callers and references it does",
    "not show you, follow a changed symbol out into files this PR never touched.",
  ];

  if (!staged) {
    return missing(
      "The deterministic layer was not asked to stage this PR's diff, so there are no per-file patches.",
    );
  }
  if (staged.files === null) {
    return missing(
      `The deterministic layer TRIED to stage this PR's diff and could not — see \`${staged.index}\`, and the` +
        "\n`degraded[]` entry for `stage-diff` in the facts envelope, for what went wrong.",
    );
  }

  const byPath = new Map(staged.files.map((f) => [f.path, f]));
  const relevant = [
    ...new Set(
      mine.flatMap((o) => [
        o.introducedAt.path,
        ...o.enforcedAt.candidates.map(pathOf),
      ]),
    ),
  ]
    .filter((p) => byPath.has(p))
    .sort();

  const lines = [
    `STAGED DIFF: this PR's patch is already on disk, at \`${staged.dir}/\`.`,
    "",
    `  ${staged.index}`,
    "      the index — every changed file, its status (A/M/D/R), its changed line ranges at head, and",
    "      the patch file that holds its diff. Read this first.",
    `  ${staged.dir}/<file>.patch`,
    "      the unified diff for ONE file, over the same MERGE-BASE range this whole brief is about.",
    "      The deterministic layer resolved that range once, and this is it written down.",
    "",
    "DO NOT RE-DERIVE THE RANGE with `git diff` or `git show`. It is already settled; re-deriving it",
    "is where a two-dot diff creeps back in, and a two-dot diff attributes other people's commits to",
    "this author (50 real PRs, 9 diverge, one 6,125 files against 3).",
    "",
    "THE PATCH IS YOUR STARTING POINT, NOT YOUR SCOPE. You are in the FULL CHECKOUT, not in a patch",
    "file: open the changed files whole, read the code on either side of every hunk, grep for the",
    "callers and references the patch does not show you, follow a changed symbol out into files this",
    "PR never touched. The defects worth finding live in the code the diff touches but does not",
    "display.",
    "",
    "These paths are relative to your working directory — the repository checkout. Open them exactly",
    "as written. Do NOT prefix them with anything: the only absolute path you have been handed is your",
    "skill bundle, which sits one directory ABOVE the checkout, and joining onto it lands on a file",
    "that does not exist.",
  ];

  if (relevant.length > 0) {
    lines.push(
      "",
      "The files THIS family's obligations name, and their patches:",
    );
    for (const path of relevant.slice(0, STAGED_FILES_SHOWN)) {
      const file = byPath.get(path)!;
      lines.push(
        file.patch === null
          ? `  ${path}   → NOT STAGED (it is in the index with no patch; read it at head)`
          : `  ${path}   → ${staged.dir}/${file.patch}`,
      );
    }
    if (relevant.length > STAGED_FILES_SHOWN) {
      lines.push(
        `  …and ${relevant.length - STAGED_FILES_SHOWN} more — the index lists every one of them.`,
      );
    }
  }

  const unstaged = staged.files.filter((f) => f.patch === null).length;
  if (unstaged > 0) {
    lines.push(
      "",
      `${unstaged} of the ${staged.files.length} changed file(s) are listed in the index with NO patch (a bound was hit;`,
      "the envelope says which). They are still part of this PR — read them at head. A missing patch is",
      "not an unchanged file.",
    );
  }
  return lines;
}

/**
 * The tail of the block as it stood at `5fa06da1^`, restored from the diff.
 *
 * Four things are absent from it and they ARE the experiment: the row has no
 * `discharge` field and no `failureScenario`; there is no *"all N below, none
 * optional"* id checklist and no `discharge --ledger` pointer; there is no
 * worked exemplar; and the header line asks for one object *per hypothesis*
 * rather than *per obligation*. That last one is not cosmetic — it is the
 * difference between "write down what you found" and "clear this list" — and it
 * is also load-bearing on the test bench: `review-spec.test.ts` anchors its
 * cross-renderer field comparison on the literal string *"Append one JSON object
 * per obligation to"*, which appears in this file exactly once whatever the
 * contract, because `minimal` says *per hypothesis*.
 *
 * The last seven lines are common to both contracts and are repeated rather than
 * shared, for the reason {@link DISCHARGE_MINIMAL} is a second literal: the
 * baseline of a control arm must not be reachable by editing the arm under test.
 */
function minimalTail(family: SeedFamily): string[] {
  return [
    `Append one JSON object per hypothesis to .lastlight/pr-review/hypotheses/${family}.jsonl — one line each:`,
    "",
    `  { "id": "${family}-001", "obligation": "O-001", "family": "${family}", "claim": "…",`,
    '    "bothEnds": { "introducedAt": "path:line", "enforcedAt": "path:line" | null },',
    '    "quotes": [ { "path": "…", "line": 12, "text": "the line, verbatim" } ],',
    '    "existingCode": "the verbatim excerpt this is about",',
    '    "needsProbe": false, "severity": "Critical|Important|Minor", "confidence": 0.0-1.0 }',
    "",
    `\`id\` is \`${family}-001\`, \`${family}-002\`, … — numbered within THIS family. Six passes append to six files`,
    "and none of them can see another's, so a bare `H-001` collides with whatever another family minted and",
    "credits neither claim. The id is namespaced so that cannot happen.",
    "",
    "`quotes` must be REAL text at REAL lines — a later phase checks that they resolve, and a claim whose quote",
    "does not resolve is discarded whatever its reasoning. `existingCode` is how the finding gets anchored:",
    "quote the code, do not count the lines. Do NOT write findings.json, do NOT post a review, and do NOT",
    `reason about any family other than ${family} — another pass owns each of the others.`,
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
 *
 * **The never-empty rule holds under BOTH contracts, and that is the control's
 * boundary.** It is the delivery half of `5fa06da1` — the same half as
 * `FanoutBranch.context_file` — and `minimal` exists to hold delivery constant
 * while the QUESTION changes. Restoring `return ""` here would put a family's
 * missing block back on the table and re-confound C1 with C2, which is the one
 * thing this switch is for.
 *
 * Which block is rendered comes off `doc.contract` rather than an argument: the
 * seeder stamps it, this renders it, and `checkDischarge` grades against it, so
 * the three cannot disagree. A document written before the field existed reads
 * as `full`.
 *
 * `staged` is the ONE thing that does come as an argument, because it is not the
 * seeder's to stamp: it belongs to the `facts` envelope (`stagedDiff`), which
 * the seeder reads and does not own. The caller (`cli.ts`'s `seed`) passes it
 * straight through from the document it just parsed. Omitting it is not the
 * same as `null` and neither is silent — see {@link renderStagedDiff}.
 */
/**
 * Tell the family it was truncated — the notice that had stopped rendering.
 *
 * It used to look for the substring `"budget"` in a `dropped[]` reason. The
 * 2026-08-25 move from a pooled budget to per-family ceilings reworded every
 * reason to `"per-family ceiling"` / `"total backstop"`, so from that commit to
 * this one **the notice never rendered at all** — measured on the eight gate
 * cases, `1587-r3` dropped 59 obligations across four families and every one of
 * its briefs claimed, by omission, to be the complete set. That is exactly the
 * *"we could not look" vs "we looked and it is clean"* conflation this package
 * exists to prevent, arriving through a stale string match.
 *
 * So it reads the STRUCTURED row now (`minted` − `obligations`), not prose. A
 * document written before those fields existed falls back to the `dropped[]`
 * scan, keyed on the reason the seeder actually emits.
 *
 * Two distinct claims, deliberately two paragraphs:
 *
 * - **The family's own ceiling** — this family had more to say. Nothing was
 *   taken by another family, which is the whole property the ceilings bought.
 * - **The total backstop** — the lowest-ranked across every family, applied
 *   after the ceilings. On a shipped configuration it cannot bind, so if a
 *   survey ever reads this line an operator has raised a ceiling.
 */
function renderTruncation(
  doc: ObligationsDocument,
  family: SeedFamily,
  row: ObligationsDocument["families"][number] | undefined,
): string[] {
  const cappedOff =
    row?.minted != null
      ? row.minted - row.obligations
      : (doc.dropped.find(
          (d) =>
            d.reason.startsWith(`over the per-family ceiling of `) &&
            d.reason.includes(` for ${family} —`),
        )?.count ?? 0);

  const lines: string[] = [];
  if (cappedOff > 0) {
    const ceiling = row?.cap != null ? ` of ${row.cap}` : "";
    lines.push(
      "",
      `${cappedOff} further ${family} obligation(s) were built and dropped at this family's own ceiling${ceiling}.`,
      `They are NOT "checked". No other family took these slots — the ceiling is this family's own. What`,
      "follows is its highest-ranked questions, not all of them, so the absence of an obligation about some",
      "mechanism is not evidence that the mechanism is sound.",
    );
  }

  const backstop = doc.dropped.find((d) =>
    d.reason.startsWith("over the total backstop of "),
  );
  if (backstop) {
    lines.push(
      "",
      `${backstop.count} obligation(s) were dropped after that, at the document-wide backstop — the lowest-ranked`,
      'across every family. They are NOT "checked" either.',
    );
  }
  return lines;
}

export function renderFamilyBlock(
  doc: ObligationsDocument,
  family: SeedFamily,
  staged?: StagedDiff | null,
): string {
  const contract: ObligationContract =
    doc.contract === "minimal" ? "minimal" : "full";
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
    // "Minted nothing" and "minted N and a ceiling of 0 took them all" are
    // different facts, and only the first one licenses the sentence below.
    // Unreachable at the shipped caps; reachable the moment one is varied.
    if (row?.minted) {
      lines.push(
        `${row.minted} ${family} obligation(s) were built and ALL of them dropped at a ceiling of ${row.cap ?? 0}.`,
        "",
        'None of them is "checked", and this is NOT the seeder finding nothing — it found these and was refused',
        "the slots. Work the diff for this family's question directly, and say so in your output.",
      );
      lines.push("", ...renderStagedDiff(staged, []));
      return lines.join("\n");
    }
    lines.push(
      `No ${family} obligations could be built from the deterministic layer for this diff.`,
      "",
      "That is not a licence to skip the family — it means the seeder found no mechanism of this shape, not",
      "that none exists. Work the diff for this family's question directly, and say so in your output.",
    );
    if (doc.degraded.length > 0) {
      lines.push(
        "",
        `The analysis ran ${doc.coverage}. What was not analysed:`,
      );
      for (const d of doc.degraded.slice(0, 10))
        lines.push(`  - [${d.extractor}] ${d.reason}`);
    }
    // The branch this section is worth MOST to: "work the diff directly" is
    // exactly the instruction that sends an unseeded pass off to re-derive the
    // range by hand.
    lines.push("", ...renderStagedDiff(staged, []));
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
    for (const d of doc.degraded.slice(0, 10))
      lines.push(`  - [${d.extractor}] ${d.reason}`);
  }

  lines.push(...renderTruncation(doc, family, row));

  // Per-run context, and it goes ABOVE the discharge contract deliberately: it
  // is about how to READ the diff, which every obligation below then asks a
  // question about. It is rendered under BOTH contracts — it is delivery, like
  // the never-empty rule, not the question `minimal` exists to hold constant.
  lines.push("", ...renderStagedDiff(staged, mine));

  lines.push(
    "",
    ...(contract === "minimal" ? DISCHARGE_MINIMAL : DISCHARGE),
    "",
  );
  for (const o of mine) lines.push(...renderOne(o, contract));

  if (contract === "minimal") {
    lines.push(...minimalTail(family));
    return lines.join("\n");
  }

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
    'are proposing — write it at `severity: "Minor"` and let a later phase decide what is worth posting.',
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
