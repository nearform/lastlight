#!/usr/bin/env -S npx tsx
/**
 * #399 idea 2, run for real: one TypeSafe System-One (`jev`) call PER
 * HYPOTHESIS in a preserved run's adjudication dossier, asking only the axis
 * `pr-review-is-not-a-probability` measured at AUC 0.897 — category, never
 * correctness — and comparing it against what the real (Sonnet) adjudicator
 * decided for the same hypothesis, where one exists.
 *
 * Usage:
 *   npx tsx scripts/jev-hypothesis-probe.ts <pr-review-dir> [<pr-review-dir> …]
 *       [--model jev-latest] [--concurrency 8] [--dry-run] [--yes]
 *       [--out <path>] [--print-prompt]
 *
 *   <pr-review-dir>  one or more `.lastlight/pr-review` directories from a
 *                    preserved (`--keep-workspace`) eval run. The repo root
 *                    is derived as two levels up (`<dir>/../..`), which is
 *                    where every case's checkout sits — same convention
 *                    `adjudicate-render.ts`'s own `DossierOptions.repo` uses.
 *   --model          the TypeSafe model id (default: TYPESAFE_MODEL env, else
 *                    `jev-latest`)
 *   --concurrency    parallel `systemOne` calls                  (default 8)
 *   --dry-run        zero model calls; prints the state/questions it WOULD
 *                    send for the first hypothesis and stops
 *   --yes            the spend acknowledgement. Trivially cheap (jev input is
 *                    ~$0.042/M tokens, output free) but the convention this
 *                    codebase's other spending scripts follow is: estimate,
 *                    then require opt-in, regardless of how small the number is
 *   --out <path>     write the full per-hypothesis result set as JSON
 *   --print-prompt   dump the first request before sending it
 *
 * ── Why per HYPOTHESIS, not per finding ──────────────────────────────────────
 *
 * #399 idea 2 phrased the target as "for each finding" because that was the
 * unit visible before idea 1 (the dossier) existed. The dossier's actual unit
 * is the hypothesis — 299 of them across the 8-case arm measured 2026-09-22,
 * against a few dozen posted findings — and that is the volume a System-1
 * primitive is for and a frontier model inside a 30-turn session is not: most
 * hypotheses never reach a finding at all, so a per-finding probe would never
 * see them, and the whole point of `jev-with-evidence` is finding out whether
 * a cheap classifier can pre-tier the hypotheses adjudicate currently has to
 * read one at a time to discover are boring.
 *
 * ── What state jev sees, and what it deliberately does not ─────────────────
 *
 * Same evidence the dossier gives Sonnet — claim, both mechanism ends, probe
 * verdict/command/transcript (capped) — with the SAME two exclusions the
 * dossier's own module comment states (the falsify pass's reasoning about its
 * own verdict; `confidence`, measured AUROC 0.228 inverted) plus one more,
 * new here: a MISMATCHED anchor/quote (`excerpt.kind !== "resolved"`) is
 * reported as a short status line, never the full wrong excerpt. That excerpt
 * is already known unusable — `locateExcerpt` said so — and carrying the full
 * (wrong) text anyway is exactly the "context bloat" `aacr-adjudicate.ts`
 * already found degrades jev's accuracy. It is also most of the byte weight:
 * measured on the same 8-case arm, `NOT FOUND` blocks average 3x the size of
 * `VERIFIED` ones and are a fifth of every dossier's bytes.
 *
 * ── What this measures, and what it does not ────────────────────────────────
 *
 * Agreement between jev's category call and Sonnet's, on the SAME dossier
 * evidence, for every hypothesis Sonnet's own findings.json actually decided
 * (cited by a finding's `hypotheses[]`, which carries `category` under
 * `review.analysis.adjudicate: dossier`). That is a same-day, same-input,
 * same-question comparison — not a gold-label accuracy number. High agreement
 * says jev could plausibly PRE-TIER what Sonnet currently reads one row at a
 * time; it says nothing about whether Sonnet's own category was right. The
 * latter needs the gold set and is a follow-on, not this script's job.
 *
 * Placeholder rows — `"claim": "no <family> hypothesis"`, the survey's own
 * empty-family marker (`survey-contract.md` etc.) — are excluded before
 * spending anything. They are not hypotheses; classifying one wastes a call
 * and would silently pollute every distribution below.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { choice, TypeSafeClient, type ChoiceResponse } from "@typesafe-ai/sdk";

import { loadDotEnv } from "../src/env.js";
import { mapPool } from "../src/pool.js";
import { resolveFactsBin } from "../src/paths.js";

loadDotEnv();

// ── CLI plumbing (shared shape with scripts/aacr-adjudicate.ts) ─────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
}
function die(msg: string): never {
  console.error(`jev-hypothesis-probe: ${msg}`);
  process.exit(1);
}

/** ~4 chars per token — sizes a spend decision, never bills anyone. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ── The dossier's structured rows, mirrored — evals never imports code-facts
// as a library (it is a CLI dependency of `lastlight`, not of this package;
// see root CLAUDE.md's dependency graph), so this shape is read off
// `lastlight-facts dossier --json`'s stdout rather than typed against the
// source. Keep it in sync with `packages/code-facts/src/adjudicate-render.ts`
// (`DossierEntry`) by hand — the same trade `deletion-risk.ts` already makes
// for `readJsonlRows`.
interface ExcerptLocationJson {
  kind: "resolved" | "not-found" | "no-file" | "no-path" | "no-excerpt";
  line?: number;
}
interface DossierQuoteJson {
  path: string | null;
  claimedLine: number | null;
  text: string;
  located: ExcerptLocationJson;
}
interface DossierEntryJson {
  record: {
    id: string;
    family: string;
    obligation: string | null;
    declaredObligation: string | null;
    row: Record<string, unknown>;
  };
  probe: { verdict: string; command: string | null; transcript: string | null; transcriptPath: string | null } | null;
  transcript: string | null;
  transcriptTruncated: boolean;
  path: string | null;
  excerpt: ExcerptLocationJson;
  quotes: DossierQuoteJson[];
}

function readDossierEntries(dir: string, repo: string, factsBin: string): DossierEntryJson[] {
  const out = execFileSync(factsBin, ["dossier", "--dir", dir, "--repo", repo, "--json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return (JSON.parse(out) as { entries: DossierEntryJson[] }).entries;
}

/** Sonnet's own category call for a hypothesis, read off `findings.json` —
 * the finding whose `hypotheses[]` cites this id, if any. `null` when the id
 * never reached a finding (internal by the conservation floor, or dropped). */
function readSonnetCategories(dir: string): Map<string, { category: string; claim: string; title: string }> {
  const map = new Map<string, { category: string; claim: string; title: string }>();
  const path = resolve(dir, "findings.json");
  if (!existsSync(path)) return map;
  let doc: { findings?: unknown[] };
  try {
    doc = JSON.parse(readFileSync(path, "utf8")) as { findings?: unknown[] };
  } catch {
    return map;
  }
  for (const raw of doc.findings ?? []) {
    const f = raw as Record<string, unknown>;
    const category = typeof f.category === "string" ? f.category : null;
    if (!category) continue; // legacy (non-dossier) output has no category to compare
    const hyps = Array.isArray(f.hypotheses) ? f.hypotheses.filter((h) => typeof h === "string") : [];
    for (const id of hyps) {
      map.set(id, {
        category,
        claim: typeof f.claim === "string" ? f.claim : "",
        title: typeof f.title === "string" ? f.title : "",
      });
    }
  }
  return map;
}

const PLACEHOLDER_CLAIM = /^no \w+ hypothesis$/i;

// ── The jev call — one categorical choice per hypothesis ────────────────────
//
// Wording matches `review-adjudicate.md`'s five categories verbatim, so a
// disagreement is a disagreement about the SAME question the real
// adjudicator was asked, not an artefact of rephrasing it.
const CATEGORY_QUESTION = choice(
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
      what: "You looked and there is no defect. Every \"correctly enforced\", \"already handled\", \"the values agree\", \"intentional and documented\" belongs here, however certain the claim sounds. A confident report of nothing is not a finding.",
    },
  },
);

/** Cap on any inlined text — jev's accuracy falls as unrelated text grows
 * around the decision (`aacr-adjudicate.ts`'s own "context bloat" note). */
const STATE_TEXT_CAP = 1500;
function cap(s: string): string {
  return s.length > STATE_TEXT_CAP ? `${s.slice(0, STATE_TEXT_CAP)}\n[…truncated]` : s;
}

/** A mismatched excerpt/quote is reported as a status line, never the full
 * wrong text — see the module comment. A resolved one is the evidence. */
function renderLocation(loc: ExcerptLocationJson, path: string | null, text?: string): Record<string, unknown> {
  if (loc.kind === "resolved" && text) return { status: "verified", file: path, line: loc.line, text: cap(text) };
  return { status: loc.kind, file: path };
}

function buildJevState(entry: DossierEntryJson): Record<string, unknown> {
  const row = entry.record.row;
  const ends = row.bothEnds as { introducedAt?: unknown; enforcedAt?: unknown } | undefined;
  return {
    family: entry.record.family,
    severity: typeof row.severity === "string" ? row.severity : null,
    claim: typeof row.claim === "string" ? row.claim : null,
    mechanism: {
      introducedAt: typeof ends?.introducedAt === "string" ? ends.introducedAt : null,
      enforcedAt: typeof ends?.enforcedAt === "string" ? ends.enforcedAt : null,
    },
    anchor: renderLocation(entry.excerpt, entry.path, typeof row.existingCode === "string" ? row.existingCode : undefined),
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

// ── Main ──────────────────────────────────────────────────────────────────────

interface Row {
  caseLabel: string;
  id: string;
  entry: DossierEntryJson;
  sonnet: { category: string; claim: string; title: string } | null;
}

async function main() {
  const dirs = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!dirs.length) die('need at least one ".lastlight/pr-review" directory — see --help in the header comment');

  const factsBin = resolveFactsBin();
  if (!factsBin) {
    die(
      "no lastlight-facts on LASTLIGHT_FACTS_BIN, PATH, or the baked path. Build it first:\n" +
        "  pnpm --filter lastlight-code-facts build\n" +
        "  export LASTLIGHT_FACTS_BIN=$PWD/packages/code-facts/dist/cli.js",
    );
  }

  const model = flag("model") ?? process.env.TYPESAFE_MODEL?.trim() ?? "jev-latest";
  const concurrency = Number(flag("concurrency") ?? 8);
  const printPrompt = has("print-prompt");
  const dryRun = has("dry-run");

  const rows: Row[] = [];
  for (const dir of dirs) {
    const absDir = resolve(dir);
    const repo = resolve(absDir, "../..");
    // `.../sandboxes/<taskId>/<repoName>/.lastlight/pr-review` — the taskId,
    // three levels up from this dir, is the readable case label; `repo`'s own
    // basename is just the checkout's repo name and is the same on every case.
    const caseLabel = dirname(dirname(dirname(absDir))).split("/").pop() ?? absDir;
    const entries = readDossierEntries(absDir, repo, factsBin);
    const sonnet = readSonnetCategories(absDir);
    for (const entry of entries) {
      const claim = typeof entry.record.row.claim === "string" ? entry.record.row.claim : "";
      if (PLACEHOLDER_CLAIM.test(claim.trim())) continue; // the survey's own "nothing here" marker
      rows.push({ caseLabel, id: entry.record.id, entry, sonnet: sonnet.get(entry.record.id) ?? null });
    }
  }
  if (!rows.length) die("no hypotheses found across the given directories (after dropping empty-family placeholders)");

  const withSonnet = rows.filter((r) => r.sonnet).length;
  const estTokens = rows.reduce(
    (n, r) => n + approxTokens(JSON.stringify(buildJevState(r.entry))) + approxTokens(JSON.stringify(CATEGORY_QUESTION)),
    0,
  );
  const estCost = (estTokens / 1_000_000) * 0.042; // jev input pricing; output is free
  console.log(
    `${rows.length} hypotheses across ${dirs.length} case(s), ${withSonnet} with a Sonnet category to compare against.\n` +
      `Estimated ~${estTokens} input tokens on ${model} — ~$${estCost.toFixed(4)}.`,
  );

  if (printPrompt) {
    console.log(`\n── REQUEST (row 0) ──────────────────────────────────────────\n`);
    console.log(`[state]\n${JSON.stringify(buildJevState(rows[0].entry), null, 2)}\n`);
    console.log(`[questions]\n${JSON.stringify({ category: CATEGORY_QUESTION }, null, 2)}\n`);
  }

  if (dryRun) {
    console.log("\n--dry-run: stopping before any model call.");
    return;
  }
  if (!has("yes")) {
    console.log("\nRe-run with --yes to spend the estimate above (or --dry-run to send nothing).");
    return;
  }

  const apiKey = process.env.TYPESAFE_KEY?.trim() || process.env.TYPESAFE_API_KEY?.trim();
  if (!apiKey) die("needs TYPESAFE_KEY (or TYPESAFE_API_KEY) in the environment or a cwd .env");
  const client = new TypeSafeClient({ apiKey, defaultModel: model, timeout: 30_000, retry: { maxRetries: 4 } });

  type Decision = { category: string | null; confidence: number | null; probs: Record<string, number> | null; error: string | null };
  const decisions = await mapPool<Row, Decision>(rows, concurrency, async (row) => {
    try {
      const { answers } = await client.systemOne({
        state: buildJevState(row.entry),
        questions: { category: CATEGORY_QUESTION },
      });
      const a = answers.category as ChoiceResponse<typeof CATEGORY_QUESTION.criteria>;
      return { category: a.choice, confidence: a.confidence, probs: { ...a.probabilities }, error: null };
    } catch (err) {
      return { category: null, confidence: null, probs: null, error: (err as Error).message.slice(0, 200) };
    }
  });

  // ── Report ──────────────────────────────────────────────────────────────
  const dist: Record<string, number> = {};
  const confusion: Record<string, Record<string, number>> = {};
  let agree = 0;
  let compared = 0;
  let errors = 0;
  const disagreements: { row: Row; jev: string }[] = [];

  rows.forEach((row, i) => {
    const d = decisions[i];
    if (d.error) {
      errors++;
      return;
    }
    const jevCat = d.category!;
    dist[jevCat] = (dist[jevCat] ?? 0) + 1;
    if (row.sonnet) {
      compared++;
      const sonnetCat = row.sonnet.category;
      (confusion[sonnetCat] ??= {})[jevCat] = (confusion[sonnetCat]?.[jevCat] ?? 0) + 1;
      if (jevCat === sonnetCat) agree++;
      else disagreements.push({ row, jev: jevCat });
    }
  });

  console.log(`\n${rows.length} hypotheses probed, ${errors} errored.\n`);
  console.log("jev's category distribution (all hypotheses, not just the ones Sonnet also decided):");
  for (const [cat, n] of Object.entries(dist).sort((a, b) => b[1] - a[1])) console.log(`  ${cat.padEnd(18)} ${n}`);

  if (compared) {
    console.log(`\nAgreement with Sonnet's own category, on the ${compared} hypotheses Sonnet's findings.json actually decided:`);
    console.log(`  ${agree}/${compared} = ${((100 * agree) / compared).toFixed(1)}%\n`);
    console.log("confusion (rows = Sonnet, cols = jev):");
    const cats = Object.keys(CATEGORY_QUESTION.criteria);
    console.log(`  ${"".padEnd(18)} ${cats.map((c) => c.slice(0, 8).padStart(9)).join(" ")}`);
    for (const sonnetCat of cats) {
      const rowCounts = confusion[sonnetCat] ?? {};
      console.log(`  ${sonnetCat.padEnd(18)} ${cats.map((c) => String(rowCounts[c] ?? 0).padStart(9)).join(" ")}`);
    }
    if (disagreements.length) {
      console.log(`\n${disagreements.length} disagreement(s), first 5:`);
      for (const { row, jev } of disagreements.slice(0, 5)) {
        console.log(`  [${row.caseLabel}] ${row.id}: Sonnet=${row.sonnet!.category} jev=${jev}`);
        console.log(`    claim: ${(row.entry.record.row.claim as string | undefined)?.slice(0, 140) ?? "(none)"}`);
      }
    }
  } else {
    console.log("\nNo hypothesis in this set had a Sonnet category to compare against — nothing to score agreement on.");
  }

  const outPath = flag("out");
  if (outPath) {
    const full = rows.map((row, i) => ({ case: row.caseLabel, id: row.id, sonnet: row.sonnet, jev: decisions[i] }));
    writeFileSync(outPath, JSON.stringify(full, null, 2));
    console.log(`\nWrote ${outPath}`);
  }
}

main().catch((err) => die((err as Error).stack ?? String(err)));
