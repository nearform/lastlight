#!/usr/bin/env -S npx tsx
/**
 * Build the deterministic **gold-finding anchor labels** for the code-facts
 * evidence-coverage metric → `datasets/pr-review/anchors.json`.
 *
 * ## Why this exists
 *
 * We want to know whether the deterministic `code-facts` layer even *names* the
 * thing a human reviewer talked about — an upper bound on what a facts-seeded
 * reviewer could rediscover. Martian's gold set carries only
 * `{severity, description}`: **no file, no line** (their own candidate extraction
 * drops `path`/`line` from all 7,892 records), so there is no free deterministic
 * join from a gold finding to a location in the diff.
 *
 * **Identifier anchoring is the bridge.** We pull code-shaped tokens out of the
 * gold prose and ask whether any of them appears, on a word boundary, on a line
 * the PR actually changed. A gold finding that anchors has a location we can
 * compare a facts bundle against; one that doesn't is purely semantic and is
 * outside what any identifier-level evidence layer could ever cover.
 *
 * No model is involved anywhere. The measuring instrument must stay
 * deterministic — an LLM in the denominator would make every downstream coverage
 * number unfalsifiable.
 *
 * ## Freeze the labels, not the tokenizer
 *
 * The metric's denominator IS this tokenizer's output. If the tokenizer improved
 * and the labels were recomputed, every past coverage number would silently
 * change meaning. So the artifact is **committed, frozen and versioned**: it
 * stamps `tokenizer: "v1"`, and a better tokenizer ships as `v2` in a new file
 * rather than rewriting history in place.
 *
 * ## What is deliberately NOT in the artifact
 *
 * Gold **descriptions**. `datasets/pr-review/instances.json` is gitignored on
 * purpose ("nothing from Martian's dataset is committed to this repo" — see the
 * tier README), and `anchors.json` IS committed. It therefore carries only
 * derived labels: the extracted anchors (code identifiers, which come from the
 * reviewed repositories, not from Martian's prose), the matched `path:line`s,
 * and metadata. Read a description by joining back to your local
 * `instances.json` on `instanceId` + `goldIndex`.
 *
 * ## Usage
 *
 *   npx tsx scripts/facts-anchors.ts                 # write anchors.json + print the report
 *   npx tsx scripts/facts-anchors.ts --dry-run       # report only, write nothing
 *   npx tsx scripts/facts-anchors.ts --audit         # print the hand-audit sheet (see below)
 *   npx tsx scripts/facts-anchors.ts --unanchored    # print every unanchored finding, with its text
 *
 * Flags: `--dataset <instances.json>`, `--cache <dir>` (the eval cache holding
 * `repos/` mirrors + the `code-review-benchmark` checkout; defaults to
 * `$LASTLIGHT_EVALS_CACHE`), `--out <file>`, `--seed <n>` (audit sample).
 *
 * READ-ONLY except for the single `--out` artifact.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GoldComment, SweBenchInstance } from "../src/schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Bump when a tokenizer rule changes. Old artifacts keep their old stamp — that
 * is the entire point of stamping it. */
const TOKENIZER_VERSION = "v1";
const ARTIFACT_VERSION = 1;

/** Seed for the hand-audit sample. Recorded in the artifact so the sample — and
 * therefore the verdicts below — are reproducible. */
const DEFAULT_AUDIT_SEED = 20260821;
const AUDIT_SAMPLE_SIZE = 20;

// ── CLI plumbing (shared shape with scripts/rescore.ts, mine-failures.ts) ─────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function die(msg: string): never {
  console.error(`facts-anchors: ${msg}`);
  process.exit(1);
}

// ═════════════════════════════════════════════════════════════════════════════
// Tokenizer v1 — implemented rule by rule, exactly as specified.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Standard English stopwords (rule 2, first half). Only words of ≥3 characters
 * matter, since the identifier regex in rule 1 already requires that.
 */
const ENGLISH_STOPWORDS = [
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "her", "was",
  "one", "our", "out", "has", "had", "his", "how", "its", "may", "new", "now", "see",
  "two", "way", "who", "did", "use", "she", "too", "get", "him", "let", "put", "say",
  "off", "own", "per", "via", "yet", "does", "done", "each", "else", "even", "ever",
  "from", "here", "into", "just", "less", "like", "made", "make", "many", "most",
  "much", "must", "only", "over", "same", "she", "sure", "take", "them", "they",
  "thus", "very", "want", "well", "were", "while", "with", "your", "after", "again",
  "against", "already", "always", "another", "because", "before", "being", "below",
  "between", "both", "cannot", "could", "doing", "down", "during", "further",
  "having", "however", "itself", "might", "never", "once", "other", "otherwise",
  "ought", "rather", "shall", "since", "still", "than", "that", "their", "theirs",
  "these", "this", "those", "through", "under", "until", "upon", "were", "what",
  "when", "where", "whether", "which", "while", "whose", "will", "within", "without",
  "would", "your",
];

/**
 * Review-vocabulary stoplist (rule 2, second half) — the words a code reviewer
 * uses to *talk about* code, which are not themselves references to code. Fixed
 * by the spec; do not extend it to make a number look better.
 */
const REVIEW_STOPWORDS = [
  "should", "would", "could", "method", "function", "value", "values", "error",
  "errors", "return", "returns", "null", "true", "false", "check", "checks",
  "handle", "issue", "instead", "missing", "wrong", "file", "files", "line",
  "lines", "code", "test", "tests", "case", "name", "call", "change", "comment",
  "type", "class", "using", "used", "need", "also", "where", "whether", "about",
  "there", "their", "which", "when", "what", "have", "been", "this", "that",
  "with", "from", "will", "into", "more", "than", "then", "some", "such",
];

const STOPWORDS = new Set([...ENGLISH_STOPWORDS, ...REVIEW_STOPWORDS]);

/**
 * Rule 1 — the chunk scanner. Grabs every maximal run of characters that could
 * belong to a code token (identifier chars plus the path/member separators), so
 * `src/foo/bar.ts`, `messages_lt.properties` and `handleError` each arrive as one
 * chunk. Prose words arrive as chunks too and are filtered by rules 2 and 3.
 */
const CHUNK_RE = /[A-Za-z0-9_$][A-Za-z0-9_$./\\-]*/g;
/** Rule 1 — path-shaped, second form: `<something>.<ext up to 5>`. The first
 * form (contains a `/`) is checked separately. Note this also admits dotted
 * member expressions (`resp.status`) on purpose: those are code-shaped too. */
const PATHY_DOT_RE = /^\S+\.\w{1,5}$/;
/** Rule 1 — identifier-shaped: an identifier start plus ≥2 more chars. */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]{2,}$/;

interface Token {
  /** The literal text matched against the diff. */
  text: string;
  /** Rule 3 provenance — it fell inside a backtick span in the description. */
  backticked: boolean;
  /** Rule 3 provenance — it contains a `/`, or is `<name>.<ext>`. */
  pathy: boolean;
}

/** Character ranges covered by backtick spans, so a token's provenance is a
 * simple offset lookup rather than a second, divergent parse. */
function backtickRanges(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const re = /`([^`]*)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push([m.index + 1, m.index + 1 + m[1].length]);
  return out;
}

function isPathy(t: string): boolean {
  return t.includes("/") || PATHY_DOT_RE.test(t);
}

/**
 * Rule 3 — "is this shaped like an identifier a human typed on purpose?".
 * Literally: an internal capital (any capital after the first character, which
 * also admits SCREAMING acronyms like `HTML`) or an underscore. A plain
 * lowercase word is NOT an identifier anchor — that rule is what keeps `sanitize`
 * out and `sanitizeHtml` in, and it is the single biggest driver of both the
 * anchor rate and the false-match rate.
 */
function looksLikeIdentifier(t: string): boolean {
  return /[A-Z]/.test(t.slice(1)) || t.includes("_");
}

/**
 * Tokenizer v1. Returns the surviving anchors for one gold description, in first
 * -appearance order, de-duplicated.
 */
export function tokenizeV1(description: string): string[] {
  const ranges = backtickRanges(description);
  const inBackticks = (i: number, len: number) =>
    ranges.some(([a, b]) => i >= a && i + len <= b);

  const candidates: Token[] = [];
  let m: RegExpExecArray | null;
  CHUNK_RE.lastIndex = 0;
  while ((m = CHUNK_RE.exec(description))) {
    const raw = m[0];
    const at = m.index;
    // Trim trailing separators: sentence punctuation glues onto the chunk
    // (`sanitize.` → `sanitize`, `foo/` → `foo`).
    const trimmed = raw.replace(/[./\\-]+$/, "");
    if (!trimmed) continue;
    const bt = inBackticks(at, trimmed.length);

    // Rule 1a/1b — the whole chunk, when it is path-shaped.
    if (isPathy(trimmed)) candidates.push({ text: trimmed, backticked: bt, pathy: true });

    // Rule 1c — identifier-shaped pieces. A path/member chunk also contributes
    // its segments, so `messages_lt.properties` yields `messages_lt` (which can
    // match a line) as well as the whole path (which usually cannot).
    for (const part of trimmed.split(/[./\\-]/)) {
      if (IDENT_RE.test(part)) candidates.push({ text: part, backticked: bt, pathy: false });
    }
  }

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    // Rule 2 — stopwords (English + review vocabulary), case-insensitively.
    if (STOPWORDS.has(c.text.toLowerCase())) continue;
    // Rule 3 — keep only if backticked, path-shaped, or identifier-shaped.
    if (!c.backticked && !c.pathy && !looksLikeIdentifier(c.text)) continue;
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    kept.push(c.text);
  }
  return kept;
}

/**
 * Rule 4 — word-boundary match. `\b` is wrong for tokens with non-word edges
 * (`.eslintrc`, `foo/bar`), so the boundary assertion is applied only on the
 * sides where the token actually ends in an identifier character. Matching is
 * **case-sensitive**: code identifiers are, and a looser match buys anchor rate
 * with false matches, which is the thing this measurement is trying to bound.
 */
/** An ALL-CAPS acronym (`URL`, `HTML`, `SQL`, `API`). Kept by rule 3's literal
 * "internal capital", but far weaker evidence than a real identifier. */
function isAcronym(token: string): boolean {
  return /^[A-Z][A-Z0-9]+$/.test(token);
}

function boundaryRegex(token: string): RegExp {
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const lead = /^[A-Za-z0-9_$]/.test(token) ? "(?<![A-Za-z0-9_$])" : "";
  const tail = /[A-Za-z0-9_$]$/.test(token) ? "(?![A-Za-z0-9_$])" : "";
  return new RegExp(`${lead}${esc}${tail}`);
}

// ═════════════════════════════════════════════════════════════════════════════
// The diff side — three-dot (merge-base) changed lines
// ═════════════════════════════════════════════════════════════════════════════

interface ChangedLine {
  /** `path:line` — new path/new line for an addition, old path/old line for a deletion. */
  loc: string;
  /** The line content, without its leading +/-. */
  text: string;
}

/**
 * `git diff -U0 <base>...<head>` — **three dots**. That is the merge base, which
 * is what GitHub's "Files changed" tab shows and what code-facts computes, so
 * the anchor labels and the facts bundle are measured over the same line set. A
 * two-dot diff would drag in everything base gained since the branch point.
 */
function threeDotDiff(mirror: string, base: string, head: string): string {
  return execFileSync("git", ["-C", mirror, "diff", "--no-color", "-U0", `${base}...${head}`], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

function parseChangedLines(diff: string): { lines: ChangedLine[]; paths: string[] } {
  const lines: ChangedLine[] = [];
  const paths: string[] = [];
  let oldPath = "";
  let newPath = "";
  let oldNo = 0;
  let newNo = 0;

  for (const raw of diff.split("\n")) {
    if (raw.startsWith("--- ")) {
      oldPath = raw.slice(4).replace(/^a\//, "");
      continue;
    }
    if (raw.startsWith("+++ ")) {
      newPath = raw.slice(4).replace(/^b\//, "");
      if (newPath !== "/dev/null") paths.push(newPath);
      else if (oldPath !== "/dev/null") paths.push(oldPath);
      continue;
    }
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      continue;
    }
    if (raw.startsWith("diff --git") || raw.startsWith("index ") || raw.startsWith("Binary ")) continue;
    if (raw.startsWith("+")) {
      lines.push({ loc: `${newPath}:${newNo}`, text: raw.slice(1) });
      newNo++;
    } else if (raw.startsWith("-")) {
      lines.push({ loc: `${oldPath}:${oldNo}`, text: raw.slice(1) });
      oldNo++;
    }
  }
  return { lines, paths: [...new Set(paths)] };
}

// ═════════════════════════════════════════════════════════════════════════════
// The Martian metadata join (language / bug type / requires-context)
// ═════════════════════════════════════════════════════════════════════════════

interface PrLabel {
  derived?: { language?: string; num_golden_comments?: number };
  llm_pr_labels?: { requires_context?: string };
  comment_bug_types?: Array<{ bug_type?: string }>;
}

/**
 * `pr_labels.json` and `benchmark_data.json` are keyed by the benchmark's own
 * fork URL, which is NOT the upstream repo the instance points at (the discourse
 * cases live under `ai-code-review-evaluation/discourse-graphite`, and three
 * `*-greptile` cases point at a real upstream PR). Rather than guess, this
 * replays `import-martian.ts`'s own id derivation over `benchmark_data.json`
 * — `prreview__<slug(source_repo)>-<pr number>` — so the mapping is exactly the
 * one that produced `instances.json`. Verified: all 50 ids resolve, and the gold
 * descriptions match index-for-index, which is what licenses aligning
 * `comment_bug_types[i]` with `review_gold[i]`.
 */
function buildLabelIndex(cacheDir: string): Map<string, PrLabel> {
  const resultsDir = join(cacheDir, "code-review-benchmark", "offline", "results");
  const benchPath = join(resultsDir, "benchmark_data.json");
  const labelPath = join(resultsDir, "pr_labels.json");
  const out = new Map<string, PrLabel>();
  if (!existsSync(benchPath) || !existsSync(labelPath)) return out;

  const bench = JSON.parse(readFileSync(benchPath, "utf8")) as Record<
    string,
    { original_url?: string | null; source_repo?: string }
  >;
  const labels = JSON.parse(readFileSync(labelPath, "utf8")) as Record<string, PrLabel>;
  const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

  for (const [key, entry] of Object.entries(bench)) {
    const upstream = entry.original_url && entry.original_url !== "None" ? entry.original_url : key;
    const num = upstream.match(/\/pull\/(\d+)/)?.[1] ?? key.match(/\/pull\/(\d+)/)?.[1];
    const src = entry.source_repo;
    if (!num || !src) continue;
    const label = labels[key];
    if (label) out.set(`prreview__${slug(src)}-${Number(num)}`, label);
  }
  return out;
}

// ═════════════════════════════════════════════════════════════════════════════
// The hand-audit
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Verdicts from the manual inspection of the seeded sample (`--audit` prints the
 * sheet: description, anchors, matched lines). Filled in BY HAND, every one read
 * against its diff. Keyed `instanceId#goldIndex`.
 *
 * Two bars, deliberately separated, because the metric only needs the first and
 * conflating them would flatter it:
 *
 * - `verdict` — the NAMING bar, which is what `anchored` claims: does the
 *   matching anchor refer to the same code entity the comment is about?
 *   `spurious` = a homonym (a different `handleError`), or a token that is not
 *   really a reference to code at all.
 * - `localized` — the stricter LOCATION bar: is at least one matched line the
 *   specific site the comment targets (`precise`), or do the matches name the
 *   right entity while never landing on the target site (`diffuse`)?
 *
 * This is the metric's **error bar**, not a scoreboard. Do not adjust the
 * tokenizer to improve it — a bad number here is itself the finding.
 */
type Verdict = { verdict: "good" | "spurious"; localized: "precise" | "diffuse"; note: string };
const AUDIT_VERDICTS: Record<string, Verdict> = {
  "prreview__keycloak-36882#0": {
    verdict: "good", localized: "precise",
    note: "`picocli.exit` matched the exact `picocli.exit(CompatibilityResult…)` calls the comment names.",
  },
  "prreview__keycloak-greptile-41249#0": {
    verdict: "good", localized: "precise",
    note: "`UserModel` matched `isConditionalPasskeysEnabled(UserModel currentUser)` — the signature under discussion.",
  },
  "prreview__grafana-103633#1": {
    verdict: "good", localized: "diffuse",
    note: "Weakest of the 20. `checkPermission` IS the function the comment names, but the one matched line is its production call site; the comment is about a misleading comment + `false` value in the test's cached-permission map, which the anchor never reaches.",
  },
  "prreview__grafana-106778#0": {
    verdict: "good", localized: "precise",
    note: "`GrafanaRuleListItem` matched both its definition and the `<GrafanaRuleListItem` render site missing the `key` prop.",
  },
  "prreview__grafana-107534#0": {
    verdict: "good", localized: "precise",
    note: "`applyTemplateVariables` matched the exact three-argument call (`…, request.scopedVars, request.filters`) the comment quotes.",
  },
  "prreview__grafana-79265#2": {
    verdict: "good", localized: "precise",
    note: "`dbSession.Exec` matched `result, err := dbSession.Exec(args...)` verbatim — the line that would not compile.",
  },
  "prreview__grafana-79265#3": {
    verdict: "good", localized: "precise",
    note: "`ErrDeviceLimitReached` matched its declaration and the `return ErrDeviceLimitReached` the comment calls misleading.",
  },
  "prreview__grafana-76186#1": {
    verdict: "good", localized: "precise",
    note: "All three anchors matched: the removed `traceID` logging lines in `LoggerMiddleware` and the new `ContextualLoggerMiddleware` that omits them.",
  },
  "prreview__discourse-graphite-10#0": {
    verdict: "good", localized: "precise",
    note: "`before_validation` matched the `before_validation do` block in embeddable_host.rb; the `EmbeddableHost` anchor added 11 further, unrelated call sites.",
  },
  "prreview__discourse-graphite-10#3": {
    verdict: "good", localized: "diffuse",
    note: "Right entity, wrong places: `embeddable_hosts`/`EmbeddableHost` matched 13 lines across 9 files (JS controllers, hbs templates, locale yml) and never the raw-SQL migration the comment is actually about.",
  },
  "prreview__discourse-graphite-6#0": {
    verdict: "good", localized: "precise",
    note: "`include_website_name` matched `def include_website_name` — literally the method whose missing `?` suffix is the finding.",
  },
  "prreview__discourse-graphite-4#2": {
    verdict: "good", localized: "precise",
    note: "`postMessage` matched the exact `parent.postMessage(…, '<%= request.referer %>')` line. The separate `URL` anchor matched a locale string and two spec titles — acronym noise inside an otherwise correct label.",
  },
  "prreview__discourse-graphite-4#4": {
    verdict: "good", localized: "precise",
    note: "`TopicEmbed` matched `TopicEmbed.import(user, url, …)`, the method the comment names; the `HTML` anchor separately matched an unrelated code comment.",
  },
  "prreview__discourse-graphite-2#0": {
    verdict: "good", localized: "precise",
    note: "`TopicUser` matched `tu = TopicUser.find_by(…)` — the nil-able assignment the comment warns about.",
  },
  "prreview__discourse-graphite-2#1": {
    verdict: "good", localized: "precise",
    note: "The misspelled `stopNotificiationsText` matched its definition and its template use; the correctly-spelled variant matched nothing, as it should.",
  },
  "prreview__cal-com-8330#1": {
    verdict: "good", localized: "precise",
    note: "Four anchors matched the exact `dayjs(date.start).add(utcOffset,…) === dayjs(date.end)…` comparison the comment says will always be false.",
  },
  "prreview__cal-com-7232#1": {
    verdict: "good", localized: "precise",
    note: "`immediateDelete` matched `if (immediateDelete) {` inside `deleteScheduledEmailReminder` — the exact branch the comment describes.",
  },
  "prreview__cal-com-10600#0": {
    verdict: "good", localized: "precise",
    note: "`TwoFactor` matched `export default function TwoFactor` inside BackupCode.tsx — the naming inconsistency itself.",
  },
  "prreview__cal-com-10600#3": {
    verdict: "good", localized: "precise",
    note: "`backupCodes` matched the decrypt-then-mutate lines in disable.ts that the race-condition comment is about.",
  },
  "prreview__cal-com-10967#4": {
    verdict: "good", localized: "precise",
    note: "`createEvent`/`credentialId` matched both `Calendar.d.ts` declarations the comment contrasts, plus the implementation that keeps the old arity.",
  },
};

/** mulberry32 — a tiny, fully specified PRNG so the sample is reproducible from
 * the recorded seed on any machine, without a dependency. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededSample<T>(items: T[], n: number, seed: number): T[] {
  const rnd = mulberry32(seed);
  const idx = items.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).sort((a, b) => a - b).map((i) => items[i]);
}

// ═════════════════════════════════════════════════════════════════════════════
// Artifact shape
// ═════════════════════════════════════════════════════════════════════════════

interface AnchorGold {
  goldIndex: number;
  severity: GoldComment["severity"];
  /** The surviving tokenizer output. NOT the gold description — see the header. */
  anchors: string[];
  /** `path:line` for every changed line an anchor matched (capped, see MAX_LINES). */
  anchoredLines: string[];
  anchored: boolean;
  /** Martian's `comment_bug_types[i].bug_type`, when the join is clean. */
  bugType?: string;
  /** Diagnostic only: the anchors that did the matching. */
  matchedAnchors?: string[];
  /** Diagnostic only: how many changed lines matched in total (UNCAPPED, unlike
   * `anchoredLines`) and across how many files. This is the **localization**
   * signal: `anchored` says the gold names something the PR touched, but a
   * finding whose anchors hit 40 lines in 9 files is named, not located. The two
   * are different qualities and the metric must not conflate them. */
  matchCount?: number;
  matchFiles?: number;
  /** Diagnostic only: every matching anchor is an ALL-CAPS acronym (`URL`,
   * `HTML`, `SQL`). Rule 3's literal "internal capital" admits these, and they
   * are the tokenizer's weakest anchors — flagged so the risk is countable
   * rather than argued about. */
  acronymOnly?: boolean;
  /** Diagnostic only: an anchor matched only a changed FILE PATH, not a changed
   * line. Not counted as anchored — recorded so the sensitivity is visible. */
  pathOnly?: boolean;
}

interface AnchorCase {
  instanceId: string;
  repo: string;
  /** Martian `derived.language`, joined — not guessed from extensions. */
  language?: string;
  /** Martian `llm_pr_labels.requires_context` (PR-level, e.g. `cross_file`). */
  requiresContext?: string;
  changedFiles: number;
  changedLines: number;
  gold: AnchorGold[];
}

/** A gold finding can legitimately name a token that appears on hundreds of
 * changed lines (a rename). Recording all of them bloats the artifact without
 * adding information, so the list is capped and `anchoredLinesTruncated` marks it. */
const MAX_LINES = 12;

async function main(): Promise<number> {
  const cacheDir = resolve(
    flag("cache") ?? process.env.LASTLIGHT_EVALS_CACHE ?? join(homedir(), "work", "lastlight-evals", ".eval-cache"),
  );
  const datasetPath = resolve(
    flag("dataset") ?? join(dirname(cacheDir), "datasets", "pr-review", "instances.json"),
  );
  const outPath = resolve(flag("out") ?? join(HERE, "..", "datasets", "pr-review", "anchors.json"));
  const seed = Number(flag("seed") ?? DEFAULT_AUDIT_SEED);
  const dryRun = has("dry-run");

  if (!existsSync(datasetPath)) {
    die(
      `no instances.json at ${datasetPath}\n` +
        `  (it is gitignored by design — populate it with scripts/import-martian.ts, or pass --dataset)`,
    );
  }
  const instances = JSON.parse(readFileSync(datasetPath, "utf8")) as SweBenchInstance[];
  const labels = buildLabelIndex(cacheDir);
  if (!labels.size) {
    console.error(
      `facts-anchors: WARNING — no code-review-benchmark checkout under ${cacheDir}; ` +
        `language / bugType / requiresContext will be absent.`,
    );
  }

  const cases: AnchorCase[] = [];
  for (const inst of instances) {
    const gold = inst.review_gold ?? [];
    if (!gold.length) continue;
    const [owner, name] = inst.repo.split("/");
    const mirror = join(cacheDir, "repos", `${owner}__${name}.git`);
    if (!existsSync(mirror)) die(`no bare mirror for ${inst.repo} at ${mirror}`);
    if (!inst.pr) die(`${inst.instance_id} has no pr block`);

    const { lines, paths } = parseChangedLines(
      threeDotDiff(mirror, inst.pr.base_commit, inst.pr.head_commit),
    );
    const label = labels.get(inst.instance_id);

    const goldOut: AnchorGold[] = gold.map((g, goldIndex) => {
      const anchors = tokenizeV1(g.description);
      const allLocs: string[] = [];
      const matchedAnchors: string[] = [];
      let pathOnly = false;

      for (const a of anchors) {
        const re = boundaryRegex(a);
        let hit = false;
        for (const l of lines) {
          if (re.test(l.text)) {
            hit = true;
            if (!allLocs.includes(l.loc)) allLocs.push(l.loc);
          }
        }
        if (hit) matchedAnchors.push(a);
        // Sensitivity probe only (rule 4 is line-level): does the anchor name a
        // file the PR touched, without appearing on any changed line?
        else if (paths.some((p) => re.test(p))) pathOnly = true;
      }

      const files = new Set(allLocs.map((l) => l.slice(0, l.lastIndexOf(":"))));
      const anchored = allLocs.length > 0;
      return {
        goldIndex,
        severity: g.severity,
        anchors,
        anchoredLines: allLocs.slice(0, MAX_LINES),
        anchored,
        ...(label?.comment_bug_types?.[goldIndex]?.bug_type
          ? { bugType: label.comment_bug_types[goldIndex].bug_type }
          : {}),
        ...(matchedAnchors.length ? { matchedAnchors } : {}),
        ...(anchored ? { matchCount: allLocs.length, matchFiles: files.size } : {}),
        ...(anchored && matchedAnchors.every(isAcronym) ? { acronymOnly: true } : {}),
        ...(pathOnly && !anchored ? { pathOnly: true } : {}),
      };
    });

    cases.push({
      instanceId: inst.instance_id,
      repo: inst.repo,
      ...(label?.derived?.language ? { language: label.derived.language } : {}),
      ...(label?.llm_pr_labels?.requires_context
        ? { requiresContext: label.llm_pr_labels.requires_context }
        : {}),
      changedFiles: paths.length,
      changedLines: lines.length,
      gold: goldOut,
    });
  }

  // ── Denominators ───────────────────────────────────────────────────────────
  const flat = cases.flatMap((c) => c.gold.map((g) => ({ c, g })));
  const total = flat.length;
  const anchored = flat.filter((x) => x.g.anchored).length;
  const noAnchors = flat.filter((x) => !x.g.anchors.length).length;
  const pathOnly = flat.filter((x) => x.g.pathOnly).length;

  const byLang = new Map<string, { total: number; anchored: number }>();
  for (const { c, g } of flat) {
    const k = c.language ?? "unknown";
    const e = byLang.get(k) ?? { total: 0, anchored: 0 };
    e.total++;
    if (g.anchored) e.anchored++;
    byLang.set(k, e);
  }
  const byBugType = new Map<string, { total: number; anchored: number }>();
  for (const { g } of flat) {
    const k = g.bugType ?? "unknown";
    const e = byBugType.get(k) ?? { total: 0, anchored: 0 };
    e.total++;
    if (g.anchored) e.anchored++;
    byBugType.set(k, e);
  }

  // ── The audit sample ───────────────────────────────────────────────────────
  const anchoredKeys = flat
    .filter((x) => x.g.anchored)
    .map((x) => `${x.c.instanceId}#${x.g.goldIndex}`);
  const sampled = seededSample(anchoredKeys, AUDIT_SAMPLE_SIZE, seed);
  const PENDING = { verdict: "pending", localized: "pending", note: "" } as const;
  const verdicts: Array<{ key: string; verdict: string; localized: string; note: string }> =
    sampled.map((key) => ({ key, ...((AUDIT_VERDICTS[key] as Verdict | undefined) ?? PENDING) }));
  const good = verdicts.filter((v) => v.verdict === "good").length;
  const spurious = verdicts.filter((v) => v.verdict === "spurious").length;
  const pending = verdicts.filter((v) => v.verdict === "pending").length;
  const diffuseAudited = verdicts.filter((v) => v.localized === "diffuse").length;
  // A recorded verdict whose key is no longer in the sample means the sample
  // moved (seed, dataset or tokenizer changed) and the verdicts no longer
  // describe what was measured. Loud, not silent.
  const stale = Object.keys(AUDIT_VERDICTS).filter((k) => !sampled.includes(k));
  if (stale.length) {
    console.error(
      `facts-anchors: WARNING — ${stale.length} recorded audit verdict(s) are not in the current ` +
        `sample (seed/dataset/tokenizer changed?). The audit block no longer describes this run: ${stale.join(", ")}`,
    );
  }

  // ── Reports ────────────────────────────────────────────────────────────────
  const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "—");

  console.log(`\nfacts-anchors — tokenizer ${TOKENIZER_VERSION}`);
  console.log(`  dataset  ${datasetPath}`);
  console.log(`  cache    ${cacheDir}`);
  console.log(`\nAnchor rate: ${anchored}/${total}  (${pct(anchored, total)})   over ${cases.length} cases`);
  console.log(`  unanchored              ${total - anchored}`);
  console.log(`    ├─ no surviving token ${noAnchors}   (tokenizer found nothing code-shaped in the prose)`);
  console.log(`    └─ tokens, no match   ${total - anchored - noAnchors}`);
  console.log(`  of the unanchored, matched only a changed FILE PATH: ${pathOnly}  (sensitivity probe, NOT counted)`);

  // Localization + weak-anchor diagnostics. `anchored` is a claim about NAMING;
  // these say how much the label also LOCATES the finding. Reported, never used
  // to filter — filtering here would be tuning the instrument to flatter itself.
  const acronymOnly = flat.filter((x) => x.g.acronymOnly).length;
  const anchoredOnes = flat.filter((x) => x.g.anchored);
  const oneFile = anchoredOnes.filter((x) => (x.g.matchFiles ?? 0) === 1).length;
  const diffuse = anchoredOnes.filter((x) => (x.g.matchFiles ?? 0) > 3).length;
  const medianLines = (() => {
    const v = anchoredOnes.map((x) => x.g.matchCount ?? 0).sort((a, b) => a - b);
    return v.length ? v[Math.floor(v.length / 2)] : 0;
  })();
  console.log(`\nLocalization of the anchored labels (diagnostic — NOT part of \`anchored\`):`);
  console.log(`  matched a single file      ${oneFile}/${anchored}  (${pct(oneFile, anchored)})`);
  console.log(`  matched >3 files (diffuse) ${diffuse}/${anchored}  (${pct(diffuse, anchored)})`);
  console.log(`  median matched lines       ${medianLines}`);
  console.log(`  anchored ONLY by an ALL-CAPS acronym: ${acronymOnly}/${anchored}  (${pct(acronymOnly, anchored)})`);

  console.log(`\nPer language:`);
  for (const [lang, e] of [...byLang].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${lang.padEnd(12)} ${String(e.anchored).padStart(3)}/${String(e.total).padEnd(4)} ${pct(e.anchored, e.total)}`);
  }
  console.log(`\nPer bug type (Martian comment_bug_types):`);
  for (const [bt, e] of [...byBugType].sort((a, b) => b[1].total - a[1].total)) {
    console.log(`  ${bt.padEnd(22)} ${String(e.anchored).padStart(3)}/${String(e.total).padEnd(4)} ${pct(e.anchored, e.total)}`);
  }

  console.log(
    `\nHand audit (seed ${seed}, n=${sampled.length}): ` +
      (pending
        ? `${pending} PENDING`
        : `${good} good / ${spurious} spurious → false-match rate ${pct(spurious, sampled.length)}` +
          `\n  at the stricter LOCATION bar: ${diffuseAudited}/${sampled.length} diffuse (${pct(diffuseAudited, sampled.length)}) — ` +
          `right entity named, target site never matched`),
  );

  const byId = new Map(instances.map((i) => [i.instance_id, i]));

  if (has("audit")) {
    console.log(`\n${"═".repeat(78)}\nAUDIT SHEET — seed ${seed}\n${"═".repeat(78)}`);
    for (const key of sampled) {
      const [id, gi] = key.split("#");
      const c = cases.find((x) => x.instanceId === id)!;
      const g = c.gold[Number(gi)];
      const desc = byId.get(id)?.review_gold?.[Number(gi)]?.description ?? "(description unavailable)";
      console.log(`\n── ${key}  [${c.language ?? "?"} · ${g.severity} · ${g.bugType ?? "?"}]`);
      console.log(`   GOLD: ${desc.replace(/\s+/g, " ")}`);
      console.log(`   ANCHORS:  ${g.anchors.join(", ")}`);
      console.log(`   MATCHED:  ${(g.matchedAnchors ?? []).join(", ")}  → ${g.matchCount} line(s) in ${g.matchFiles} file(s)`);
      const [owner, name] = c.repo.split("/");
      const inst = byId.get(id)!;
      const mirror = join(cacheDir, "repos", `${owner}__${name}.git`);
      const { lines } = parseChangedLines(threeDotDiff(mirror, inst.pr!.base_commit, inst.pr!.head_commit));
      const res = (g.matchedAnchors ?? []).map(boundaryRegex);
      for (const loc of g.anchoredLines) {
        // `path:line` is ambiguous (a removed and an added line can share one),
        // so show the line at that loc that actually matched.
        const at = lines.filter((x) => x.loc === loc);
        const l = at.find((x) => res.some((r) => r.test(x.text))) ?? at[0];
        console.log(`   ${loc}\n      ${(l?.text ?? "").trim().slice(0, 180)}`);
      }
    }
    console.log(`\n${"═".repeat(78)}\n`);
  }

  if (has("unanchored")) {
    console.log(`\n${"═".repeat(78)}\nUNANCHORED (${total - anchored})\n${"═".repeat(78)}`);
    for (const { c, g } of flat.filter((x) => !x.g.anchored)) {
      const desc = byId.get(c.instanceId)?.review_gold?.[g.goldIndex]?.description ?? "";
      console.log(
        `\n── ${c.instanceId}#${g.goldIndex} [${c.language ?? "?"} · ${g.bugType ?? "?"}]${g.pathOnly ? " (path-only)" : ""}` +
          `\n   ANCHORS: ${g.anchors.join(", ") || "(none)"}\n   GOLD: ${desc.replace(/\s+/g, " ")}`,
      );
    }
    console.log(`\n${"═".repeat(78)}\n`);
  }

  // ── Write ──────────────────────────────────────────────────────────────────
  const artifact = {
    version: ARTIFACT_VERSION,
    generatedAt: new Date().toISOString(),
    tokenizer: TOKENIZER_VERSION,
    source: {
      dataset: "martian code-review-benchmark (offline)",
      cases: cases.length,
      goldFindings: total,
      diff: "git diff -U0 <base>...<head> (three-dot / merge-base)",
    },
    summary: {
      anchored,
      total,
      anchorRate: total ? anchored / total : 0,
      unanchored: total - anchored,
      unanchoredNoTokens: noAnchors,
      unanchoredPathOnly: pathOnly,
      byLanguage: Object.fromEntries(
        [...byLang].map(([k, v]) => [k, { ...v, rate: v.total ? v.anchored / v.total : 0 }]),
      ),
      byBugType: Object.fromEntries(
        [...byBugType].map(([k, v]) => [k, { ...v, rate: v.total ? v.anchored / v.total : 0 }]),
      ),
    },
    audit: {
      seed,
      sampleSize: sampled.length,
      method:
        "Uniform sample (mulberry32, seeded Fisher-Yates) of the ANCHORED findings, each read " +
        "by hand against its matched diff lines. `verdict` is the NAMING bar (what `anchored` " +
        "claims): good = the matching anchor refers to the same code entity the comment is " +
        "about; spurious = a homonym, or not a code reference at all. `localized` is a stricter " +
        "LOCATION bar: precise = a matched line is the site the comment targets; diffuse = the " +
        "right entity is named but the target site is never matched.",
      sampled,
      good,
      spurious,
      falseMatchRate: sampled.length ? spurious / sampled.length : 0,
      diffuse: diffuseAudited,
      diffuseRate: sampled.length ? diffuseAudited / sampled.length : 0,
      verdicts,
    },
    cases,
  };

  if (dryRun) {
    console.log(`(--dry-run — not writing ${outPath})\n`);
    return 0;
  }
  mkdirSync(dirname(outPath), { recursive: true });
  const tmp = join(dirname(outPath), ".anchors.tmp");
  writeFileSync(tmp, `${JSON.stringify(artifact, null, 2)}\n`);
  renameSync(tmp, outPath);
  console.log(`\n✓ wrote ${outPath}\n`);
  return 0;
}

main().then((c) => process.exit(c));
