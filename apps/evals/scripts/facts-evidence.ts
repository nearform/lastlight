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
 * ── Per family (added 2026-08-22, WP3 AC6) ──────────────────────────────────
 *
 * The headline pools every payload, so it can say *"the envelope names it"* and
 * not *"the `enforcement` family could have asked about it"*. The family table
 * partitions the same two bars by the payload each family is seeded FROM, on
 * TS/JS only — the split WP3's gates are read on.
 *
 * It is a **precondition, not a gate** (`03-seed-and-survey.md`): an arm that
 * reports a family converting at zero must be able to say whether that family's
 * evidence coverage was ever above zero, so "did not convert" and "was never
 * nameable" stay distinguishable. `tests` and `spec` print **notMeasured** by
 * construction — see `FAMILY_SURFACES`.
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

/** TS/JS is the only half the type-aware extractors can structurally reach. */
function isTsJs(language: string): boolean {
  return language === "TypeScript" || language === "JavaScript";
}

/**
 * The TS/JS test for the FAMILY table, derived from the envelope's own
 * `languages[]` rather than the dataset's label.
 *
 * The headline split keys on Martian's `derived.language`, which is **PR-level,
 * not file-level** — the caveat printed under every table. That is tolerable for
 * a language breakdown and wrong for the family table, for two reasons found by
 * running it:
 *
 * 1. A dataset that carries no language at all (skillspro — the set WP3's gates
 *    are actually read on) lands every case in `non-TS`, which empties the
 *    family table exactly where it is needed.
 * 2. `grafana-106778` is labelled Go and its finding is in a `.tsx` file.
 *
 * `languages[]` is computed by code-facts from the changed files themselves, so
 * it answers the question the family table asks: *could the type-aware
 * extractors have reached this diff at all?*
 */
function envelopeIsTsJs(langs: { id: string; changedFiles: number }[]): boolean {
  // DOMINANT, not "any". `some(...)` was tried first and is wrong in the other
  // direction: a Go PR touching one `.ts` file swept its Go gold findings into
  // the TS/JS denominator and took Martian's family denominator from 26 to 52,
  // diluting every rate with findings the TS extractors were never going to
  // reach. Dominant reproduces what the dataset label MEANT (Martian's
  // `derived.language` is the modal language) without inheriting its two known
  // failures — a missing label, and a label that disagrees with the file.
  let tsjs = 0;
  let other = 0;
  for (const l of langs) {
    if (l.id === "typescript" || l.id === "javascript") tsjs += l.changedFiles;
    else other += l.changedFiles;
  }
  return tsjs > 0 && tsjs >= other;
}

// ── The envelope's name sets ─────────────────────────────────────────────────

/**
 * WHICH payload named a thing. Added 2026-08-22 for WP3 AC6.
 *
 * The pooled `strict`/`loose` sets below answer *"does the envelope name it"*
 * and cannot answer *"could the `enforcement` family have asked about it"* —
 * which is the question that decides whether an arm is worth running. A family
 * whose surfaces never name a single gold finding cannot convert, whatever its
 * prompt says, and that is free to find out here where finding it out on an arm
 * costs $6–19.
 *
 * The four `strict` surfaces are entity names; the three `loose` ones are file
 * basenames. Same two bars as the headline, partitioned by origin.
 */
const SURFACES = [
  "facts.symbols",
  "contracts",
  "constants",
  "deps",
  "facts.files",
  "patterns.files",
  "coverage.files",
] as const;
type Surface = (typeof SURFACES)[number];

const STRICT_SURFACES: readonly Surface[] = ["facts.symbols", "contracts", "constants", "deps"];

/**
 * WP3's six obligation families, mapped to the payloads each is seeded FROM
 * (`03-seed-and-survey.md` §"The families", as corrected on 2026-08-21).
 *
 * **Three of them read the same surface, and this instrument cannot separate
 * them.** `contract`, `security` and `state` all seed off `facts`, so a gold
 * finding whose entity appears in `facts.symbols` counts for all three. That is
 * a real limit of naming as a measure, not a modelling shortcut: naming says the
 * envelope has the word on the table, and *which mechanism you would ask about*
 * is a property of the seeder, not of the name. The `only` column below is the
 * honest read — findings no other family's surfaces reach.
 *
 * Two families are structurally unmeasurable here and must print notMeasured:
 *
 * - **`tests`** seeds from `coverage`, which READS a report nothing in the
 *   pipeline produces until WP4's `prepare`. Measured: 0 artifacts across all 50
 *   corpus cases. A zero here would be "did not convert" written over "was never
 *   measured", which is the exact confusion locked decision 6 exists to prevent.
 * - **`spec`** seeds from the PR body and linked issue. There is no facts
 *   surface at all, so this instrument has nothing to say about it — and cannot
 *   bound it either way.
 */
const FAMILY_SURFACES: Record<string, readonly Surface[]> = {
  contract: ["facts.symbols", "contracts", "facts.files"],
  enforcement: ["constants"],
  security: ["facts.symbols", "patterns.files"],
  state: ["facts.symbols", "facts.files"],
  tests: ["coverage.files"],
  spec: [],
};
const FAMILIES = Object.keys(FAMILY_SURFACES);

interface NameSets {
  /** Entity names: symbols, contract symbols, constants (name + value), deps. */
  strict: Set<string>;
  /** `strict` ∪ file basenames (changed files, pattern hits, uncovered files). */
  loose: Set<string>;
  /** The same names, partitioned by the payload that contributed them. */
  bySurface: Record<Surface, Set<string>>;
  /** `|symbols| + |contracts| + |constants|` — the anti-gaming denominator. */
  pool: number;
  counts: { symbols: number; contracts: number; constants: number; deps: number; files: number; patterns: number; uncoveredFiles: number };
  present: boolean;
  tier: number | null;
  /** The envelope's own `languages[]` — see {@link envelopeIsTsJs}. */
  languages: { id: string; changedFiles: number }[];
  /**
   * Did the `coverage` extractor READ an artifact on this case? The `tests`
   * family is seeded from `coverage` and nothing in the pipeline produces a
   * report until WP4's `prepare`, so this is expected to be false everywhere —
   * and when it is, `tests` must print **notMeasured**, never 0. A missing
   * analyser is not a null result (locked decision 6, and 08-evals §"a missing
   * analyser is not a null result").
   */
  coverageReport: boolean;
}

function emptySurfaces(): Record<Surface, Set<string>> {
  return Object.fromEntries(SURFACES.map((s) => [s, new Set<string>()])) as Record<Surface, Set<string>>;
}

const EMPTY: NameSets = {
  strict: new Set(),
  loose: new Set(),
  bySurface: emptySurfaces(),
  pool: 0,
  counts: { symbols: 0, contracts: 0, constants: 0, deps: 0, files: 0, patterns: 0, uncoveredFiles: 0 },
  present: false,
  tier: null,
  languages: [],
  coverageReport: false,
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
  const bySurface = emptySurfaces();
  const add = (surface: Surface, name: string): void => {
    bySurface[surface].add(name);
  };

  const symbols: any[] = x.facts?.symbols ?? [];
  for (const s of symbols) {
    if (typeof s?.name !== "string") continue;
    add("facts.symbols", s.name);
    const seg = lastSegment(s.name);
    if (seg) add("facts.symbols", seg);
  }

  const contracts: any[] = x.contracts?.contracts ?? [];
  for (const c of contracts) if (typeof c?.symbol === "string") add("contracts", c.symbol);

  const constants: any[] = x.constants?.constants ?? [];
  for (const c of constants) {
    if (typeof c?.constant === "string") add("constants", c.constant);
    if (typeof c?.value === "string") {
      add("constants", c.value);
      const u = unquoted(c.value);
      if (u) add("constants", u);
    }
  }

  const deps: any[] = x.deps?.changes ?? [];
  for (const d of deps) if (typeof d?.name === "string") add("deps", d.name);

  const files: any[] = x.facts?.files ?? [];
  for (const f of files) if (typeof f?.path === "string") for (const n of fileNames(f.path)) add("facts.files", n);

  const findings: any[] = x.patterns?.findings ?? [];
  for (const f of findings) if (typeof f?.file === "string") for (const n of fileNames(f.file)) add("patterns.files", n);

  const covFiles: any[] = x.coverage?.files ?? [];
  let uncoveredFiles = 0;
  for (const f of covFiles) {
    if (typeof f?.path !== "string") continue;
    if (!Array.isArray(f.uncoveredChangedLines) || f.uncoveredChangedLines.length === 0) continue;
    uncoveredFiles += 1;
    for (const n of fileNames(f.path)) add("coverage.files", n);
  }

  // The headline bars are unions OF the surfaces, so the partition can never
  // disagree with the number it decomposes.
  const strict = new Set<string>();
  for (const s of STRICT_SURFACES) for (const n of bySurface[s]) strict.add(n);
  const loose = new Set<string>(strict);
  for (const s of SURFACES) for (const n of bySurface[s]) loose.add(n);

  return {
    strict,
    loose,
    bySurface,
    coverageReport: typeof x.coverage?.report === "string" && x.coverage.report.length > 0,
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
    languages: Array.isArray(doc.languages) ? (doc.languages as NameSets["languages"]) : [],
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
  /** Which payloads named one of this finding's anchors. Drives the family table. */
  hitSurfaces: Surface[];
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

/**
 * One row of the WP3 family table. `covered` is the family's own bar; `only` is
 * how much of it no other family reaches, which is the column that survives the
 * fact that three families read `facts`.
 */
interface FamilyRow {
  family: string;
  surfaces: readonly Surface[];
  /**
   * Anchored gold findings this family names AT THE ENTITY LEVEL. This is the
   * bar that matters for seeding: an obligation needs `introducedAt` with a
   * quotable line, and a file basename does not supply one.
   */
  strict: number;
  /** …plus file-level pointing. The envelope names the PLACE but not the thing. */
  loose: number;
  /** Findings no OTHER family's surfaces name, at the loose bar. */
  only: number;
  /** `null` when the family has no measurable surface at all — never 0. */
  measurable: boolean;
  /** Why not, when `measurable` is false. Printed instead of a rate. */
  notMeasuredReason: string | null;
}

interface Scored {
  runId: string;
  runDir: string;
  findings: FindingScore[];
  overall: Bucket;
  splits: Bucket[];
  byLanguage: Bucket[];
  /** WP3 AC6: per-family, TS/JS only — the split the gates are read on. */
  families: FamilyRow[];
  /** Anchored TS/JS gold findings — the denominator every `FamilyRow` uses. */
  familyDenominator: number;
  /** Cases the ENVELOPE says are TS/JS — see {@link envelopeIsTsJs}. */
  tsjsCaseCount: number;
  /** How many cases the `coverage` extractor actually read a report on. */
  coverageReports: number;
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
  const tsjsCases = new Set<string>();
  let coverageReports = 0;

  for (const c of art.cases) {
    const ns = nameSetsOf(join(caseDir, `${c.instanceId}.json`));
    if (!ns.present) missing.push(c.instanceId);
    if (ns.coverageReport) coverageReports += 1;
    // A dataset need not carry a language (skillspro does not). Bucket it under
    // a NAMED "unlabelled" rather than `undefined`, which used to crash the
    // renderer — and which would silently have read as a language called
    // "undefined" if it had not.
    const label = c.language && c.language.trim() ? c.language : "unlabelled";
    if (envelopeIsTsJs(ns.languages)) tsjsCases.add(c.instanceId);
    const lang = byLang.get(label) ?? emptyBucket(label);
    byLang.set(label, lang);
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
      const hitSurfaces = g.anchored
        ? SURFACES.filter((s) => g.anchors.some((a) => ns.bySurface[s].has(a)))
        : [];
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
        hitSurfaces,
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

  // WP3 AC6 — per family, on TS/JS only. The gates are read on `skillspro`,
  // which is TypeScript; a pooled family table would measure the corpus's
  // language mix rather than the families (the same trap the headline splits
  // for). Non-TS evidence coverage is 2.7% and would drag every row toward zero
  // for a reason that has nothing to do with the family.
  const tsFindings = findings.filter((f) => tsjsCases.has(f.instanceId) && f.anchored);
  const families: FamilyRow[] = FAMILIES.map((family) => {
    const mine = FAMILY_SURFACES[family];
    const others = new Set(FAMILIES.filter((f) => f !== family).flatMap((f) => FAMILY_SURFACES[f]));
    const mineStrict = mine.filter((s) => STRICT_SURFACES.includes(s));
    const covered = tsFindings.filter((f) => f.hitSurfaces.some((s) => mine.includes(s)));
    return {
      family,
      surfaces: mine,
      strict: tsFindings.filter((f) => f.hitSurfaces.some((s) => mineStrict.includes(s))).length,
      loose: covered.length,
      only: covered.filter((f) => !f.hitSurfaces.some((s) => others.has(s))).length,
      measurable: family === "tests" ? coverageReports > 0 : mine.length > 0,
      notMeasuredReason:
        mine.length === 0
          ? "seeded from the PR body and linked issue — no facts surface exists to name anything"
          : family === "tests" && coverageReports === 0
            ? `the coverage extractor read 0 reports across ${art.cases.length} cases — nothing produces one until WP4's prepare`
            : null,
    };
  });

  return {
    runId,
    runDir,
    findings,
    overall,
    splits: [tsjs, nonTs],
    byLanguage: [...byLang.values()].sort((a, b) => a.label.localeCompare(b.label)),
    families,
    familyDenominator: tsFindings.length,
    tsjsCaseCount: tsjsCases.size,
    coverageReports,
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
  printFamilies(s);
}

/**
 * WP3 AC6 — read BEFORE spending on an arm. A family converting at zero and a
 * family that was never nameable are different findings, and only one of them
 * is about the seeder.
 */
function printFamilies(s: Scored): void {
  console.log("");
  // The headline TS/JS row keys on the DATASET's label and is a published
  // number (46.2% on Martian), so it is left exactly as it was. This line is the
  // envelope-derived split the family table actually uses — printed beside it
  // rather than replacing it, because silently moving a published number is the
  // `01b` house rule's cardinal sin. They differ when a dataset carries no
  // language (skillspro: 0 vs 7 cases) or labels a PR by its modal language
  // while the finding sits in a `.tsx` file (grafana-106778).
  console.log(
    `  envelope-derived TS/JS: ${s.tsjsCaseCount} case(s) — the family table's split (dataset label: ` +
      `${s.splits[0].cases}). Read the two together when they disagree.`,
  );
  console.log("");
  console.log(`  BY WP3 FAMILY — anchored TS/JS gold only (n=${s.familyDenominator}); the split the gates are read on`);
  console.log(`  ${"family".padEnd(12)} ${"entity (strict)".padEnd(14)}  ${"+ file (loose)".padEnd(14)}  ${"only".padEnd(14)}  surfaces`);
  console.log(`  ${"-".repeat(92)}`);
  for (const r of s.families) {
    if (!r.measurable) {
      console.log(`  ${r.family.padEnd(12)} ${"notMeasured".padEnd(46)}  ${r.notMeasuredReason}`);
      continue;
    }
    const cell = (n: number): string => `${frac(n, s.familyDenominator)} ${pct(n, s.familyDenominator)}`;
    console.log(
      `  ${r.family.padEnd(12)} ${cell(r.strict)}  ${cell(r.loose)}  ${cell(r.only)}  ${r.surfaces.join(", ")}`,
    );
  }
  console.log("");
  console.log(
    `  · strict is the SEEDING bar: an obligation needs a quotable \`introducedAt\`, and a file basename is not one.`,
  );
  console.log(
    `  · \`contract\`, \`security\` and \`state\` all seed off \`facts\`, so a finding named in facts.symbols counts for`,
  );
  console.log(
    `    all three. Naming cannot say WHICH mechanism you would have asked about — read the \`only\` column for that.`,
  );
  console.log(`  · notMeasured is never 0. A missing analyser is not a null result (08-evals.md §"a missing analyser…").`);
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
