#!/usr/bin/env -S npx tsx
/**
 * Score a `facts-corpus` run against the frozen gold **anchor labels** —
 * "does the deterministic envelope even NAME the thing the human talked about?"
 *
 * This is a **measurement script**, not a test: it never asserts, never tunes,
 * and reads only `datasets/pr-review/anchors.json` plus a run's `case/*.json`.
 * Nothing is written unless `--out` is passed.
 *
 * Usage:
 *   npx tsx scripts/facts-evidence.ts [--run <runId>] [--baseline <runId>]
 *       [--anchors <anchors.json>] [--results <dir>] [--out <file.json>]
 *
 *   --run       the facts-corpus runId to score (default: the newest on disk)
 *   --baseline  a second runId to score identically, printed as a before/after
 *   --out       also write the full per-finding scoring as JSON
 *
 * ── What this measures, and what it does not ─────────────────────────────────
 *
 * It is an **upper bound on the recall attributable to code-facts as a seeder**.
 * If the envelope never names the identifier a gold finding is about, no
 * downstream seeder can produce an obligation about that identifier *from
 * facts* — so the naming rate caps what facts-seeding could ever contribute.
 *
 * It is **not recall, not precision, and naming is necessary but not
 * sufficient**. An envelope that names `parseTimeout` has not noticed that
 * `parseTimeout` returns milliseconds where the caller wants seconds; it has
 * only put the word on the table. Every number here is a ceiling.
 *
 * ── THE BINDING CONSTRAINT: score at the ENTITY level, never the line ────────
 *
 * `anchors.json` carries `anchoredLines`, and it is tempting to treat them as
 * per-line ground truth. **They are not sound as such.** From the hand audit
 * baked into the artifact:
 *
 *   - only 32 of the 99 anchored findings match a single file;
 *   - 34 span more than three files (median 7 matched lines);
 *   - 2 of the 20 audited findings are `localized: "diffuse"` — the right entity
 *     is named, but the matched line is never the site the human meant. E.g.
 *     `grafana-103633#1` matches `checkPermission`'s production call site while
 *     the comment is about a value in a *test's* cached-permission map.
 *
 * A line-level score would therefore hand out credit for facts about the wrong
 * code. So the unit of credit here is the **entity or file name**, never a line,
 * and `anchoredLines` is used for nothing but the `anchored` flag it produced.
 *
 * ── The two bars ─────────────────────────────────────────────────────────────
 *
 * For an anchored gold finding, with `anchors` the code-shaped tokens pulled
 * from its prose:
 *
 *   **EC-strict** — some anchor equals a `facts.symbols[].name` (or that name's
 *   last dotted segment), a `contracts[].symbol`, a `constants[].constant`, a
 *   `constants[].value`, or a `deps.changes[].name`. These are the *entities*
 *   the envelope has something to say about.
 *
 *   **EC-loose** — EC-strict, plus a match on the basename of a
 *   `facts.files[].path`, a `patterns.findings[].file`, or a `coverage.files[]`
 *   entry with a non-empty `uncoveredChangedLines`. This is file-level pointing:
 *   the envelope names the *place* but not the thing.
 *
 * Basenames are matched with AND without their extension, because the tokenizer
 * emits `messages_lt` for a prose mention of `messages_lt.properties`. Matching
 * is exact and case-sensitive — these are code identifiers.
 *
 * ── Three denominators. Never quote one alone. ───────────────────────────────
 *
 *   anchor rate              anchored / ALL gold      a property of the gold TEXT,
 *                                                     not of code-facts
 *   discovery ceiling        EC-loose / ALL gold      the share of ALL gold findings
 *                                                     any identifier-level layer
 *                                                     could point at
 *   evidence coverage (strict)  EC-strict / anchored  conditional on the finding
 *                                                     being anchorable at all
 *
 * ── Two things that would make the number a lie ──────────────────────────────
 *
 * 1. **Pooling languages.** A pooled score measures the corpus's language mix,
 *    not the extractors — half this corpus is a language the TS extractors
 *    structurally cannot see. Every table here splits TS/JS from non-TS and the
 *    script never prints a pooled coverage figure without both halves beside it.
 * 2. **Coverage without the candidate pool.** An envelope that names *everything*
 *    scores 1.0 trivially — exactly the way an F1 is gamed by over-posting. So
 *    `|symbols| + |contracts| + |constants|` is printed next to every coverage
 *    cell, and a coverage delta with a pool delta of the same sign is not a win
 *    until someone has looked at both.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

import { resultsRoot } from "../src/paths.js";

// ── CLI plumbing (shared shape with scripts/facts-corpus.ts) ─────────────────
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
  console.error(`facts-evidence: ${msg}`);
  process.exit(1);
}

// ── The frozen label artifact ────────────────────────────────────────────────

interface GoldAnchor {
  goldIndex: number;
  severity: string;
  bugType?: string;
  anchors: string[];
  anchoredLines: string[];
  anchored: boolean;
  matchedAnchors?: string[];
  matchCount?: number;
  matchFiles?: number;
  pathOnly?: boolean;
  acronymOnly?: boolean;
}

interface AnchorCase {
  instanceId: string;
  repo: string;
  /** Martian's `derived.language` — **PR-level, not file-level**. See the caveat
   * printed with the per-language table. */
  language: string;
  changedFiles: number;
  changedLines: number;
  gold: GoldAnchor[];
}

interface AnchorArtifact {
  version: number;
  tokenizer: string;
  generatedAt: string;
  summary: { anchored: number; total: number; anchorRate: number };
  audit: { sampleSize: number; good: number; spurious: number; diffuse: number; seed: number };
  cases: AnchorCase[];
}

/** TS/JS is the only half the ts-morph extractors can structurally reach. */
function isTsJs(language: string): boolean {
  return language === "TypeScript" || language === "JavaScript";
}

// ── The envelope's name sets ─────────────────────────────────────────────────

interface NameSets {
  /** Entity names: symbols, contract symbols, constants (name + value), deps. */
  strict: Set<string>;
  /** `strict` ∪ file basenames (changed files, pattern hits, uncovered files). */
  loose: Set<string>;
  /** `|symbols| + |contracts| + |constants|` — the anti-gaming denominator. */
  pool: number;
  counts: { symbols: number; contracts: number; constants: number; deps: number; files: number; patterns: number; uncoveredFiles: number };
  present: boolean;
  tier: number | null;
}

const EMPTY: NameSets = {
  strict: new Set(),
  loose: new Set(),
  pool: 0,
  counts: { symbols: 0, contracts: 0, constants: 0, deps: 0, files: 0, patterns: 0, uncoveredFiles: 0 },
  present: false,
  tier: null,
};

/** `Foo.bar.baz` → `baz`. Nothing else is derived from a symbol name. */
function lastSegment(name: string): string | null {
  const i = name.lastIndexOf(".");
  return i > 0 && i < name.length - 1 ? name.slice(i + 1) : null;
}

/** A path contributes its basename AND its extensionless stem — the tokenizer
 * emits `messages_lt` for prose that said `messages_lt.properties`. */
function fileNames(path: string): string[] {
  const b = basename(path);
  const stem = b.slice(0, b.length - extname(b).length);
  return stem && stem !== b ? [b, stem] : [b];
}

/** `"POST"` → also `POST`. Constant values are emitted raw, but a value read out
 * of prose may carry the quotes the source had. */
function unquoted(v: string): string | null {
  const m = /^(["'`])(.*)\1$/.exec(v);
  return m && m[2] ? m[2] : null;
}

function nameSetsOf(caseFile: string): NameSets {
  if (!existsSync(caseFile)) return EMPTY;
  let doc: Record<string, any>;
  try {
    doc = JSON.parse(readFileSync(caseFile, "utf8")) as Record<string, any>;
  } catch {
    return EMPTY;
  }
  const x = (doc.extractors ?? {}) as Record<string, any>;
  const strict = new Set<string>();
  const loose = new Set<string>();

  const symbols: any[] = x.facts?.symbols ?? [];
  for (const s of symbols) {
    if (typeof s?.name !== "string") continue;
    strict.add(s.name);
    const seg = lastSegment(s.name);
    if (seg) strict.add(seg);
  }

  const contracts: any[] = x.contracts?.contracts ?? [];
  for (const c of contracts) if (typeof c?.symbol === "string") strict.add(c.symbol);

  const constants: any[] = x.constants?.constants ?? [];
  for (const c of constants) {
    if (typeof c?.constant === "string") strict.add(c.constant);
    if (typeof c?.value === "string") {
      strict.add(c.value);
      const u = unquoted(c.value);
      if (u) strict.add(u);
    }
  }

  const deps: any[] = x.deps?.changes ?? [];
  for (const d of deps) if (typeof d?.name === "string") strict.add(d.name);

  for (const n of strict) loose.add(n);

  const files: any[] = x.facts?.files ?? [];
  for (const f of files) if (typeof f?.path === "string") for (const n of fileNames(f.path)) loose.add(n);

  const findings: any[] = x.patterns?.findings ?? [];
  for (const f of findings) if (typeof f?.file === "string") for (const n of fileNames(f.file)) loose.add(n);

  const covFiles: any[] = x.coverage?.files ?? [];
  let uncoveredFiles = 0;
  for (const f of covFiles) {
    if (typeof f?.path !== "string") continue;
    if (!Array.isArray(f.uncoveredChangedLines) || f.uncoveredChangedLines.length === 0) continue;
    uncoveredFiles += 1;
    for (const n of fileNames(f.path)) loose.add(n);
  }

  return {
    strict,
    loose,
    pool: symbols.length + contracts.length + constants.length,
    counts: {
      symbols: symbols.length,
      contracts: contracts.length,
      constants: constants.length,
      deps: deps.length,
      files: files.length,
      patterns: findings.length,
      uncoveredFiles,
    },
    present: true,
    tier: typeof doc.tier === "number" ? doc.tier : null,
  };
}

// ── Scoring ──────────────────────────────────────────────────────────────────

interface FindingScore {
  instanceId: string;
  language: string;
  goldIndex: number;
  severity: string;
  bugType: string | null;
  anchored: boolean;
  anchors: string[];
  matchedAnchors: string[];
  /** EC-strict on the finding's full anchor set (the headline definition). */
  strict: boolean;
  /** EC-loose on the finding's full anchor set. */
  loose: boolean;
  /** EC-strict restricted to anchors that a changed line actually carried — a
   * sensitivity check on the headline, never the headline itself. */
  strictMatchedOnly: boolean;
  hitAnchors: string[];
}

interface Bucket {
  label: string;
  cases: number;
  gold: number;
  anchored: number;
  strict: number;
  loose: number;
  strictMatchedOnly: number;
  pool: number;
  poolValues: number[];
  tiers: Record<string, number>;
}

function emptyBucket(label: string): Bucket {
  return { label, cases: 0, gold: 0, anchored: 0, strict: 0, loose: 0, strictMatchedOnly: 0, pool: 0, poolValues: [], tiers: {} };
}

interface Scored {
  runId: string;
  runDir: string;
  findings: FindingScore[];
  overall: Bucket;
  splits: Bucket[];
  byLanguage: Bucket[];
  perCase: { instanceId: string; language: string; tier: number | null; pool: number; anchored: number; strict: number; loose: number; present: boolean }[];
  missingEnvelopes: string[];
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function score(art: AnchorArtifact, runDir: string, runId: string): Scored {
  const caseDir = join(runDir, "case");
  const findings: FindingScore[] = [];
  const overall = emptyBucket("ALL");
  const tsjs = emptyBucket("TS/JS");
  const nonTs = emptyBucket("non-TS");
  const byLang = new Map<string, Bucket>();
  const perCase: Scored["perCase"] = [];
  const missing: string[] = [];

  for (const c of art.cases) {
    const ns = nameSetsOf(join(caseDir, `${c.instanceId}.json`));
    if (!ns.present) missing.push(c.instanceId);
    const lang = byLang.get(c.language) ?? emptyBucket(c.language);
    byLang.set(c.language, lang);
    const split = isTsJs(c.language) ? tsjs : nonTs;
    for (const b of [overall, split, lang]) {
      b.cases += 1;
      b.pool += ns.pool;
      b.poolValues.push(ns.pool);
      const t = String(ns.tier ?? "–");
      b.tiers[t] = (b.tiers[t] ?? 0) + 1;
    }

    let cs = 0;
    let cl = 0;
    let ca = 0;
    for (const g of c.gold) {
      const matched = g.matchedAnchors ?? [];
      const hitStrict = g.anchored ? g.anchors.filter((a) => ns.strict.has(a)) : [];
      const hitLoose = g.anchored ? g.anchors.filter((a) => ns.loose.has(a)) : [];
      const strict = hitStrict.length > 0;
      const loose = hitLoose.length > 0;
      const strictMatchedOnly = g.anchored && matched.some((a) => ns.strict.has(a));
      findings.push({
        instanceId: c.instanceId,
        language: c.language,
        goldIndex: g.goldIndex,
        severity: g.severity,
        bugType: g.bugType ?? null,
        anchored: g.anchored,
        anchors: g.anchors,
        matchedAnchors: matched,
        strict,
        loose,
        strictMatchedOnly,
        hitAnchors: hitStrict.length ? hitStrict : hitLoose,
      });
      for (const b of [overall, split, lang]) {
        b.gold += 1;
        if (g.anchored) b.anchored += 1;
        if (strict) b.strict += 1;
        if (loose) b.loose += 1;
        if (strictMatchedOnly) b.strictMatchedOnly += 1;
      }
      if (g.anchored) ca += 1;
      if (strict) cs += 1;
      if (loose) cl += 1;
    }
    perCase.push({ instanceId: c.instanceId, language: c.language, tier: ns.tier, pool: ns.pool, anchored: ca, strict: cs, loose: cl, present: ns.present });
  }

  return {
    runId,
    runDir,
    findings,
    overall,
    splits: [tsjs, nonTs],
    byLanguage: [...byLang.values()].sort((a, b) => a.label.localeCompare(b.label)),
    perCase,
    missingEnvelopes: missing,
  };
}

// ── Rendering ────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  return d === 0 ? "   n/a" : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}
function frac(n: number, d: number): string {
  return `${String(n).padStart(3)}/${String(d).padEnd(3)}`;
}

function bucketRow(b: Bucket): string {
  return (
    `  ${b.label.padEnd(12)} ${String(b.cases).padStart(3)}  ` +
    `${frac(b.anchored, b.gold)} ${pct(b.anchored, b.gold)}   ` +
    `${frac(b.loose, b.gold)} ${pct(b.loose, b.gold)}   ` +
    `${frac(b.strict, b.anchored)} ${pct(b.strict, b.anchored)}   ` +
    `${String(b.pool).padStart(6)} ${String(median(b.poolValues)).padStart(6)}`
  );
}

const HEADER =
  `  ${"bucket".padEnd(12)} ${"case".padStart(3)}  ` +
  `${"anchor rate".padEnd(14)}   ${"ceiling (loose)".padEnd(14)}   ${"EC-strict".padEnd(14)}   ${"pool".padStart(6)} ${"med".padStart(6)}`;

function printScored(s: Scored, art: AnchorArtifact): void {
  console.log(`\n── EVIDENCE COVERAGE  run ${s.runId} ────────────────────────────────────`);
  console.log(`   labels ${basename(s.runDir)} ← anchors.json tokenizer ${art.tokenizer}, frozen ${art.generatedAt}`);
  if (s.missingEnvelopes.length) {
    console.log(`   ⚠ ${s.missingEnvelopes.length} case(s) with NO envelope on disk (scored as zero): ${s.missingEnvelopes.join(", ")}`);
  }
  console.log("");
  console.log(`   anchor rate      = anchored / ALL gold   — a property of the gold TEXT, not of code-facts`);
  console.log(`   ceiling (loose)  = EC-loose  / ALL gold   — what any identifier-level layer could point at`);
  console.log(`   EC-strict        = EC-strict / anchored   — conditional on the finding being anchorable`);
  console.log(`   pool             = Σ |symbols|+|contracts|+|constants| (and the per-case median)`);
  console.log("");
  console.log(HEADER);
  console.log(`  ${"".padEnd(12)} ${"".padStart(3)}  ${"-".repeat(70)}`);
  console.log(bucketRow(s.overall));
  console.log("");
  for (const b of s.splits) console.log(bucketRow(b));
  console.log("");
  console.log(`  BY LANGUAGE (Martian's derived.language is PR-LEVEL, not file-level — see the caveat below):`);
  for (const b of s.byLanguage) console.log(bucketRow(b));
  console.log("");
  console.log(
    `  sensitivity: EC-strict counted on MATCHED anchors only (the subset a changed line carried) — ` +
      `${frac(s.overall.strictMatchedOnly, s.overall.anchored)} ${pct(s.overall.strictMatchedOnly, s.overall.anchored)}`,
  );
}

function printDelta(before: Scored, after: Scored): void {
  console.log(`\n── BEFORE / AFTER  ${before.runId} → ${after.runId} ──────────────────────`);
  console.log(HEADER);
  const rows: [Bucket, Bucket][] = [
    [before.overall, after.overall],
    ...before.splits.map((b, i) => [b, after.splits[i]] as [Bucket, Bucket]),
    ...before.byLanguage.map((b) => [b, after.byLanguage.find((x) => x.label === b.label) ?? emptyBucket(b.label)] as [Bucket, Bucket]),
  ];
  for (const [a, b] of rows) {
    console.log(bucketRow(a));
    console.log(bucketRow(b).replace(/^ {2}/, "  ") + "   ← new");
    const dLoose = b.loose - a.loose;
    const dStrict = b.strict - a.strict;
    const dPool = b.pool - a.pool;
    const sign = (n: number): string => (n === 0 ? "=" : n > 0 ? `+${n}` : String(n));
    console.log(`  ${"".padEnd(12)}      Δ loose ${sign(dLoose)}   Δ strict ${sign(dStrict)}   Δ pool ${sign(dPool)}`);
    console.log("");
  }
  console.log(`  PER-FINDING MOVES (strict):`);
  const key = (f: FindingScore): string => `${f.instanceId}#${f.goldIndex}`;
  const bMap = new Map(before.findings.map((f) => [key(f), f]));
  let moved = 0;
  for (const f of after.findings) {
    const o = bMap.get(key(f));
    if (!o || o.strict === f.strict) continue;
    moved += 1;
    console.log(`    ${f.strict ? "GAINED" : "LOST  "} ${key(f).padEnd(38)} ${f.language.padEnd(11)} ${(f.hitAnchors[0] ?? o.hitAnchors[0] ?? "").slice(0, 40)}`);
  }
  if (!moved) console.log(`    (nothing moved)`);
  console.log("");
}

// ── main ─────────────────────────────────────────────────────────────────────

function newestRun(root: string): string {
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, "report.json")))
    .map((d) => d.name)
    .sort();
  if (!dirs.length) die(`no facts-corpus runs under ${root}`);
  return dirs[dirs.length - 1];
}

function resolveRun(root: string, id: string): string {
  const direct = resolve(id);
  if (existsSync(join(direct, "case"))) return direct;
  const under = join(root, id);
  if (existsSync(join(under, "case"))) return under;
  die(`run ${id} has no case/ dir (looked at ${direct} and ${under})`);
}

function main(): void {
  if (has("help") || has("h")) {
    console.log(readFileSync(import.meta.filename, "utf8").split("*/")[0]);
    return;
  }
  const root = join(flag("results") ? resolve(flag("results")!) : resultsRoot(), "facts-corpus");
  const anchorsPath = flag("anchors") ?? resolve(import.meta.dirname, "..", "datasets", "pr-review", "anchors.json");
  if (!existsSync(anchorsPath)) die(`no anchors artifact at ${anchorsPath}`);
  const art = JSON.parse(readFileSync(anchorsPath, "utf8")) as AnchorArtifact;

  const runId = flag("run") ?? newestRun(root);
  const runDir = resolveRun(root, runId);
  const after = score(art, runDir, basename(runDir));

  const baselineId = flag("baseline");
  const before = baselineId ? score(art, resolveRun(root, baselineId), basename(resolveRun(root, baselineId))) : null;

  printScored(after, art);
  if (before) {
    printScored(before, art);
    printDelta(before, after);
  }

  console.log(`── CAVEATS (carry these with the numbers) ───────────────────────────────`);
  console.log(
    `  · Label soundness: the hand audit read ${art.audit.sampleSize} anchored findings and found ` +
      `${art.audit.spurious} spurious. With 0/${art.audit.sampleSize} the honest statement is a ` +
      `**≤~14% false-match rate (95% upper bound on 0/${art.audit.sampleSize})**, never "0%".`,
  );
  console.log(
    `  · ${art.audit.diffuse}/${art.audit.sampleSize} audited are "diffuse": the right entity is named but the matched line is ` +
      `never the site the human meant. Hence entity-level scoring only — a line-level score would credit facts about the wrong code.`,
  );
  console.log(
    `  · Martian's derived.language is PR-LEVEL, not file-level (grafana-106778 is labelled Go, its finding is in a .tsx file), ` +
      `so per-language cells are approximate; the TS/JS vs non-TS split inherits the same slack.`,
  );
  console.log(
    `  · This is an UPPER BOUND on the recall attributable to code-facts as a seeder. It is not recall, not precision, ` +
      `and naming is necessary but not sufficient.`,
  );
  console.log("");

  const out = flag("out");
  if (out) {
    const p = resolve(out);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          anchors: { path: anchorsPath, tokenizer: art.tokenizer, generatedAt: art.generatedAt, audit: art.audit },
          runs: before ? { before: before.runId, after: after.runId } : { after: after.runId },
          after,
          before,
        },
        (_k, v) => (v instanceof Set ? [...v] : v),
        2,
      ) + "\n",
    );
    console.log(`  wrote ${p}\n`);
  }
}

main();
