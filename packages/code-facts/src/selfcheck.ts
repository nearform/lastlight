/**
 * `selfcheck` — the SECOND oracle, and it does not ask the compiler anything.
 *
 * Every other test in this package asserts *what the extractor said*. The bug
 * this package actually shipped with was the extractor saying something
 * plausible and wrong: run against a real commit, `contracts` reported **227
 * deltas of which one was real** — 65 of them "removed export `foo`" for a
 * symbol still sitting at head — and every unit test passed throughout. An
 * oracle built out of the same machinery as the thing under test cannot see
 * that, because both halves are wrong in the same direction.
 *
 * So these checks are answerable from **git alone**: `git show <head>:<file>`,
 * `git diff --name-status`, `git diff -U0`. If the document claims a symbol was
 * removed, the head blob is the arbiter — not a second opinion from the
 * compiler that produced the claim. That is the whole design: a phantom removal
 * is not noise, it is a HARMFUL seed (IRIS measured a half-mechanism seed at
 * −3, worse than no seed at all), and the only thing that catches one cheaply
 * is a check that never loads a program.
 *
 * It is pure, synchronous, and **never throws** — a malformed document produces
 * a violation, because a self-check that dies on bad input is a self-check that
 * reports nothing exactly when something is wrong.
 */
import { realpathSync } from "node:fs";
import { changedPaths, diffHunks, showFile } from "./git.js";
import { reasonOf } from "./errors.js";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";

/** One broken invariant. `check` names the rule; `extractor` names the payload. */
export interface Violation {
  check: string;
  extractor: string;
  detail: string;
}

export interface CheckAllOptions {
  log?: LoggerPort;
  /**
   * Extra substrings that must not appear anywhere in the document. The
   * built-in set (below) is already applied; this is for a caller that knows
   * another host path could leak.
   */
  forbiddenSubstrings?: string[];
}

/**
 * Host paths that must never reach a document.
 *
 * `import("` is on the list because that is the *shape* a leak takes: an
 * unnamed type prints as `import("/abs/path/to/mod").Foo`, and the base tree
 * lives in a throwaway worktree, so the path names a directory that will not
 * exist tomorrow. `/var/folders/` is the one the four obvious needles miss —
 * `os.tmpdir()` on darwin returns `/var/folders/…`, NOT `/private/var/…`, so a
 * check that only looked for the realpath form would pass on exactly the
 * machine most of this is developed on.
 */
const FORBIDDEN_SUBSTRINGS = ["/tmp/", "/private/var/", "/Users/", "/var/folders/", 'import("'];

/**
 * The ONE field allowed to hold an absolute path: the toolchain stamp records
 * *which binary actually resolved*, and "/opt/lastlight/bin/opengrep" is the
 * answer to that question rather than a leak of it (§D3).
 */
const ABSOLUTE_PATH_ALLOWED = /^toolchain\.binaries\.[^.]+\.path$/;

/** `src/user.ts:14`, or `src/user.test.ts:14 (test)` — the location format. */
const LOCATION_RE = /^([^:]+):(\d+)(?: \(test\))?$/;

/** Keys whose value is a location (`path:line`), anywhere in the document. */
const LOCATION_KEYS = new Set([
  "declaredAt",
  "at",
  "references",
  "implementations",
  "consumersOutsideDiff",
  "importedAt",
  "hardCodedDuplicates",
]);

/**
 * Keys whose value is a bare repo-relative FILE PATH, not a location.
 *
 * `facts.symbols[].tests` is a list of test FILES ("which tests touch it"), not
 * of reference sites — the reference sites are already in `references[]` with
 * `isTest: true`. So it gets the path rule, not the `path:line` rule.
 */
const PATH_KEYS = new Set(["tests"]);

const KNOWN_EXTRACTORS = ["facts", "contracts", "constants", "deps", "patterns", "coverage"];

interface Context {
  repo: string;
  document: Record<string, unknown>;
  /** Extractor name → its payload, for either document shape. */
  payloads: Map<string, Record<string, unknown>>;
  baseSha: string | null;
  headSha: string | null;
  /** Extractors the document itself admits produced less than it should have. */
  degradedExtractors: Set<string>;
  blob(ref: string, path: string): string | null;
  violations: Violation[];
}

/**
 * Cross-check a document against git. Returns every broken invariant; an empty
 * array is the only clean answer.
 *
 * Accepts an `all` document (envelope + `extractors: {…}`) or a
 * single-extractor one, and anything else besides — a document it cannot read
 * is itself a violation.
 */
export function checkAll(
  repo: string,
  document: Record<string, unknown>,
  options: CheckAllOptions = {},
): Violation[] {
  const log = options.log ?? noopLogger;
  const violations: Violation[] = [];

  if (!isRecord(document)) {
    return [
      { check: "document-shape", extractor: "(document)", detail: "the document is not an object" },
    ];
  }

  const blobs = new Map<string, string | null>();
  const context: Context = {
    repo,
    document,
    payloads: payloadsOf(document),
    baseSha: stringAt(document, "baseSha"),
    headSha: stringAt(document, "headSha"),
    degradedExtractors: degradedExtractorsOf(document),
    blob(ref, path) {
      const key = `${ref}\u0000${path}`;
      if (!blobs.has(key)) blobs.set(key, showFile(repo, ref, path));
      return blobs.get(key) ?? null;
    },
    violations,
  };

  // Each check is isolated: one that throws on a shape nobody anticipated
  // becomes a violation of its own rather than taking the other eight with it.
  const checks: [string, (context: Context) => void][] = [
    ["contracts-removed-absent-at-head", checkRemovedAbsentAtHead],
    ["contracts-added-absent-at-base", checkAddedAbsentAtBase],
    ["no-absolute-paths", (c) => checkNoAbsolutePaths(c, options.forbiddenSubstrings ?? [])],
    ["location-shape", checkLocationShape],
    ["facts-files-match-git", checkFactsFilesMatchGit],
    ["reference-arithmetic", checkReferenceArithmetic],
    ["constants-duplicates-real", checkConstantsDuplicatesReal],
    ["scope-discipline", checkScopeDiscipline],
    ["envelope-contract", checkEnvelopeContract],
  ];

  for (const [name, check] of checks) {
    try {
      check(context);
    } catch (err) {
      violations.push({
        check: name,
        extractor: "(selfcheck)",
        detail: `the check itself threw, which is a bug in the check or a document shape it cannot read: ${reasonOf(err)}`,
      });
    }
  }

  log.debug("code-facts self-check complete", {
    extractor: stringAt(document, "extractor"),
    violations: violations.length,
  });
  return violations;
}

// ── document shape ───────────────────────────────────────────────────────────

function payloadsOf(document: Record<string, unknown>): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  const name = stringAt(document, "extractor");
  // A single-extractor document IS its own payload — `{...envelope, ...payload}`
  // — so the envelope's `extractor` is the only thing that says which payload it
  // is. That matters: `facts.files[]` and `coverage.files[]` are different
  // shapes under the same key.
  if (name && KNOWN_EXTRACTORS.includes(name)) out.set(name, document);
  const extractors = document.extractors;
  if (isRecord(extractors)) {
    for (const [key, value] of Object.entries(extractors)) {
      if (isRecord(value)) out.set(key, value);
    }
  }
  return out;
}

/**
 * Which extractors the document ADMITS were degraded.
 *
 * This is what keeps the git checks honest about tier 2 and 3: an empty payload
 * accompanied by a written reason is the documented "blind" state (locked
 * decision 6), and demanding that it match git would be demanding that a
 * degraded run lie. An empty payload with NO reason is the failure this whole
 * package exists to catch, and is still a violation.
 */
function degradedExtractorsOf(document: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const entry of arrayAt(document, "degraded")) {
    if (!isRecord(entry)) continue;
    const name = stringAt(entry, "extractor");
    if (name) out.add(name);
  }
  return out;
}

// ── 1 + 2: the phantom add/remove, arbitrated by the blob ────────────────────

/**
 * A `removed` contract claims the symbol is GONE. `git show <head>:<file>` is
 * the arbiter, and it does not care what the compiler thought it could see.
 *
 * This is the check that would have caught the 65 phantom removals: they came
 * from one tsconfig resolving differently on the two sides, so the head program
 * simply did not contain the file — while the head BLOB contained every one of
 * those symbols, plainly, in text.
 */
function checkRemovedAbsentAtHead(context: Context): void {
  checkContractPresence(context, "removed", context.headSha, "head");
}

/** The mirror image: an `added` symbol must not already be sitting at base. */
function checkAddedAbsentAtBase(context: Context): void {
  checkContractPresence(context, "added", context.baseSha, "base");
}

function checkContractPresence(
  context: Context,
  change: "added" | "removed",
  sha: string | null,
  side: "base" | "head",
): void {
  const contracts = arrayAt(context.payloads.get("contracts") ?? {}, "contracts");
  if (contracts.length === 0) return;
  const check =
    change === "removed" ? "contracts-removed-absent-at-head" : "contracts-added-absent-at-base";
  if (!sha) {
    context.violations.push({
      check,
      extractor: "contracts",
      detail: `the envelope has no ${side}Sha, so ${contracts.length} contract delta(s) cannot be arbitrated against git`,
    });
    return;
  }

  for (const entry of contracts) {
    if (!isRecord(entry) || stringAt(entry, "change") !== change) continue;
    const symbol = stringAt(entry, "symbol");
    const file = stringAt(entry, "file");
    if (!symbol || !file) {
      context.violations.push({
        check,
        extractor: "contracts",
        detail: `a ${change} delta has no symbol/file: ${JSON.stringify(entry).slice(0, 200)}`,
      });
      continue;
    }
    const source = context.blob(sha, file);
    if (source === null) continue; // the file does not exist on that side at all
    if (!exportedAt(source, symbol)) continue;
    context.violations.push({
      check,
      extractor: "contracts",
      detail: `${file}: the document says \`${symbol}\` was ${change}, but it is still an EXPORT of the ${side} blob (${sha.slice(0, 8)}) — a phantom ${change === "removed" ? "removal" : "addition"} is a harmful seed, not noise`,
    });
  }
}

/**
 * Is `symbol` part of this blob's EXPORT SURFACE?
 *
 * "Is the string present?" is the obvious question and it is the wrong one.
 * `contracts` compares `getExportedDeclarations()`, so a `const FOO` that
 * becomes an `export const FOO` really has been ADDED to the surface the
 * extractor describes — and the name is present on both sides. Measured: that
 * exact shape (`MAX_SECTION_CHARS` in `connectors/slack/mrkdwn.ts`) is the only
 * thing a presence-based check accused on this repo's own history, and the
 * extractor was right and the check was wrong.
 *
 * So the arbiter is the export position, matched textually — which is coarse,
 * and deliberately biased: anything it cannot parse reads as "not exported" and
 * produces no accusation. A missed phantom is a check that is merely quiet; a
 * false accusation is a check nobody leaves switched on.
 */
function exportedAt(source: string, symbol: string): boolean {
  const parts = symbol.split(".");
  if (!isExportedName(source, parts[0])) return false;
  if (parts.length === 1) return true;
  // `Class.method` — the container is exported, so the surviving question is
  // whether the member is still there. A blob has no notion of the qualified
  // name, so the leaf is all there is to look for.
  return mentions(source, parts[parts.length - 1]) === true;
}

const EXPORT_KEYWORDS =
  "const|let|var|function\\s*\\*?|class|interface|type|enum|namespace|module";

function isExportedName(source: string, name: string): boolean {
  if (name === "default") return /^\s*export\s+default\b/m.test(source);
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  const escaped = escapeRegExp(name);
  const declared = new RegExp(
    `^\\s*export\\s+(?:declare\\s+)?(?:default\\s+)?(?:async\\s+)?(?:abstract\\s+)?(?:${EXPORT_KEYWORDS})\\s+${escaped}(?![A-Za-z0-9_$])`,
    "m",
  );
  if (declared.test(source)) return true;
  // `export { a, b as NAME }` — the ALIAS is the exported name, so `b` in
  // `b as NAME` must not match and `NAME` must.
  for (const clause of source.matchAll(/export\s*(?:type\s*)?\{([^}]*)\}/g)) {
    for (const specifier of clause[1].split(",")) {
      const parts = specifier.split(/\s+as\s+/);
      if (parts[parts.length - 1].trim() === name) return true;
    }
  }
  return false;
}

/**
 * Does `name` occur as an identifier in `source`? `null` when the name is not
 * an identifier at all (a string-named export, say), because a check that
 * cannot decide must not accuse.
 */
function mentions(source: string, name: string): boolean | null {
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return null;
  return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(name)}(?![A-Za-z0-9_$])`).test(source);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── 3: no host path anywhere in the document ─────────────────────────────────

function checkNoAbsolutePaths(context: Context, extra: string[]): void {
  const needles = [...FORBIDDEN_SUBSTRINGS, ...extra, ...repoNeedles(context.repo)];
  walkStrings(context.document, [], (value, path) => {
    if (ABSOLUTE_PATH_ALLOWED.test(path.join("."))) return;
    for (const needle of needles) {
      if (!value.includes(needle)) continue;
      context.violations.push({
        check: "no-absolute-paths",
        extractor: extractorOfPath(path),
        detail: `${path.join(".")} contains the host path fragment \`${needle}\`: ${truncate(value)}`,
      });
      return;
    }
  });
}

/**
 * The repo's own absolute location, both as given and resolved. On darwin the
 * two differ (`/var/folders/…` vs `/private/var/folders/…`) and a document can
 * leak either, depending on which layer produced the string.
 */
function repoNeedles(repo: string): string[] {
  const out = new Set<string>();
  if (repo && repo !== "." && repo.startsWith("/")) out.add(repo);
  try {
    const real = realpathSync(repo);
    if (real.startsWith("/")) out.add(real);
  } catch {
    // A repo path we cannot resolve just means the second spelling is unknown.
  }
  return [...out];
}

// ── 4: every location is `path:line`, repo-relative ──────────────────────────

function checkLocationShape(context: Context): void {
  walkValues(context.document, [], (value, path) => {
    const key = lastKey(path);
    if (key === null) return;
    if (LOCATION_KEYS.has(key) && typeof value === "string") {
      const problem = locationProblem(value);
      if (problem) push(context, "location-shape", path, `${problem}: \`${truncate(value)}\``);
    }
    if (PATH_KEYS.has(key) && typeof value === "string") {
      const problem = pathProblem(value);
      if (problem) push(context, "location-shape", path, `${problem}: \`${truncate(value)}\``);
    }
  });
}

function locationProblem(value: string): string | null {
  const match = LOCATION_RE.exec(value);
  if (!match) return "not a `path:line` location";
  const problem = pathProblem(match[1]);
  if (problem) return problem;
  return Number(match[2]) >= 1 ? null : "line number below 1";
}

function pathProblem(value: string): string | null {
  if (value.length === 0) return "empty path";
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return "absolute path";
  // `repoRelative` produces `../…` for a file outside the repo — which means the
  // document is pointing at something the reviewer cannot open.
  if (value === ".." || value.startsWith("../")) return "path escapes the repo root";
  return null;
}

// ── 5: `facts.files[]` is exactly what git says changed ──────────────────────

function checkFactsFilesMatchGit(context: Context): void {
  const facts = context.payloads.get("facts");
  if (!facts) return;
  const files = arrayAt(facts, "files");
  if (!context.baseSha || !context.headSha) {
    if (files.length === 0) return;
    context.violations.push({
      check: "facts-files-match-git",
      extractor: "facts",
      detail: "the envelope has no base/head sha, so the changed-file set cannot be arbitrated",
    });
    return;
  }
  // A tier-2/3 run emits an empty payload AND a written reason. That is the
  // documented blind state, not a claim about git.
  if (files.length === 0 && (context.degradedExtractors.has("facts") || context.degradedExtractors.has("project"))) {
    return;
  }

  const fromGit = new Set(changedPaths(context.repo, context.baseSha, context.headSha).map((c) => c.path));
  const fromDocument = new Set<string>();
  for (const file of files) {
    const path = isRecord(file) ? stringAt(file, "path") : null;
    if (path) fromDocument.add(path);
  }

  for (const path of fromGit) {
    if (!fromDocument.has(path)) {
      context.violations.push({
        check: "facts-files-match-git",
        extractor: "facts",
        detail: `git says \`${path}\` changed and the document does not mention it — a changed file nobody analysed must be NAMED, never omitted`,
      });
    }
  }
  for (const path of fromDocument) {
    if (!fromGit.has(path)) {
      context.violations.push({
        check: "facts-files-match-git",
        extractor: "facts",
        detail: `the document reports \`${path}\` as changed and git does not`,
      });
    }
  }

  // The hunks are recomputed from `git diff -U0` rather than trusted: they are
  // what makes "did the diff touch this symbol?" mechanical, so a hunk the
  // document invented would poison every `changedHunks` downstream of it.
  const gitHunks = new Map(diffHunks(context.repo, context.baseSha, context.headSha).map((f) => [f.path, new Set(f.hunks)]));
  for (const file of files) {
    if (!isRecord(file)) continue;
    const path = stringAt(file, "path");
    if (!path) continue;
    const expected = gitHunks.get(path) ?? new Set<string>();
    for (const hunk of arrayAt(file, "hunks")) {
      if (typeof hunk === "string" && !expected.has(hunk)) {
        context.violations.push({
          check: "facts-files-match-git",
          extractor: "facts",
          detail: `\`${path}\` carries the hunk \`${hunk}\`, which \`git diff -U0\` does not report`,
        });
      }
    }
  }
}

// ── 6: the reference counts are arithmetically possible ──────────────────────

function checkReferenceArithmetic(context: Context): void {
  const facts = context.payloads.get("facts");
  if (!facts) return;
  for (const symbol of arrayAt(facts, "symbols")) {
    if (!isRecord(symbol)) continue;
    const name = stringAt(symbol, "name") ?? "(unnamed)";
    const count = numberAt(symbol, "referenceCount");
    const inDiff = numberAt(symbol, "referencesInDiff");
    // `null` is now a legal value for a reference/implementation list and it
    // means NOBODY LOOKED — distinct from `[]`, "looked and found none". Reading
    // it as an empty array here (which `arrayAt` would) is the same collapse the
    // schema change exists to undo, and it would make an unasked query look
    // arithmetically consistent with any count at all.
    const references = symbol.references;
    const listed = references === null ? null : arrayAt(symbol, "references").length;
    if (count === null || inDiff === null) {
      context.violations.push({
        check: "reference-arithmetic",
        extractor: "facts",
        detail: `\`${name}\` has a non-numeric referenceCount/referencesInDiff`,
      });
      continue;
    }
    // `referencesInDiff` beside `referenceCount` is the most productive field in
    // the document, so a ratio that cannot be true would mislead in exactly the
    // place the reviewer is told to look hardest.
    if (inDiff > count) {
      context.violations.push({
        check: "reference-arithmetic",
        extractor: "facts",
        detail: `\`${name}\`: referencesInDiff (${inDiff}) exceeds referenceCount (${count})`,
      });
    }
    if (listed !== null && listed > count) {
      context.violations.push({
        check: "reference-arithmetic",
        extractor: "facts",
        detail: `\`${name}\`: ${listed} reference site(s) listed but referenceCount is ${count}`,
      });
    }
  }
}

// ── 7: every hard-coded duplicate is really on that line ─────────────────────

/**
 * `constants` is the `1587-r2` shape — the one gold finding the investigation
 * ever converted — so a duplicate that is not actually on the line it names
 * would break the only mechanism with a proven conversion. The head blob
 * decides.
 */
function checkConstantsDuplicatesReal(context: Context): void {
  const constants = context.payloads.get("constants");
  if (!constants) return;
  const entries = arrayAt(constants, "constants");
  if (entries.length === 0) return;
  if (!context.headSha) {
    context.violations.push({
      check: "constants-duplicates-real",
      extractor: "constants",
      detail: "the envelope has no headSha, so the duplicates cannot be arbitrated against git",
    });
    return;
  }

  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const value = stringAt(entry, "value");
    const name = stringAt(entry, "constant") ?? "(unnamed)";
    if (value === null) continue;
    for (const duplicate of arrayAt(entry, "hardCodedDuplicates")) {
      if (typeof duplicate !== "string") continue;
      const match = LOCATION_RE.exec(duplicate);
      if (!match) continue; // shape is `location-shape`'s business, not this one
      const source = context.blob(context.headSha, match[1]);
      if (source === null) {
        context.violations.push({
          check: "constants-duplicates-real",
          extractor: "constants",
          detail: `\`${name}\`: the duplicate at ${duplicate} names a file that does not exist at head`,
        });
        continue;
      }
      const line = source.split("\n")[Number(match[2]) - 1];
      if (line === undefined) {
        context.violations.push({
          check: "constants-duplicates-real",
          extractor: "constants",
          detail: `\`${name}\`: the duplicate at ${duplicate} is past the end of the file at head`,
        });
        continue;
      }
      if (!line.includes(value)) {
        context.violations.push({
          check: "constants-duplicates-real",
          extractor: "constants",
          detail: `\`${name}\`: the value \`${value}\` is not on ${duplicate} at head — the line reads \`${truncate(line.trim())}\``,
        });
      }
    }
  }
}

// ── 8: nothing is reported outside the diff's own files ──────────────────────

function checkScopeDiscipline(context: Context): void {
  const patterns = context.payloads.get("patterns");
  const coverage = context.payloads.get("coverage");
  if (!patterns && !coverage) return;
  if (!context.baseSha || !context.headSha) return;

  const changed = new Set(changedPaths(context.repo, context.baseSha, context.headSha).map((c) => c.path));

  for (const finding of arrayAt(patterns ?? {}, "findings")) {
    if (!isRecord(finding)) continue;
    const file = stringAt(finding, "file");
    // The scanners run over the whole repo unless they are scoped to the diff;
    // a finding outside it is evidence about code this PR did not write.
    if (file && !changed.has(file)) {
      context.violations.push({
        check: "scope-discipline",
        extractor: "patterns",
        detail: `a finding names \`${file}\`, which this diff did not change`,
      });
    }
  }

  for (const file of arrayAt(coverage ?? {}, "files")) {
    if (!isRecord(file)) continue;
    const path = stringAt(file, "path");
    if (path && !changed.has(path)) {
      context.violations.push({
        check: "scope-discipline",
        extractor: "coverage",
        detail: `coverage reports \`${path}\`, which this diff did not change`,
      });
    }
  }
}

// ── 9: `coverage` and `degraded[]` say the same thing ────────────────────────

/**
 * Locked decision 6 in one assertion: an empty result and an unavailable
 * analyser must never be indistinguishable. `coverage: "full"` with a populated
 * `degraded[]` — or the reverse — is precisely that ambiguity.
 */
function checkEnvelopeContract(context: Context): void {
  const coverage = stringAt(context.document, "coverage");
  const degraded = arrayAt(context.document, "degraded");
  if (coverage === null) {
    context.violations.push({
      check: "envelope-contract",
      extractor: "(envelope)",
      detail: "the envelope has no `coverage` — every document carries one, including the failures",
    });
    return;
  }
  if (coverage === "full" && degraded.length > 0) {
    context.violations.push({
      check: "envelope-contract",
      extractor: "(envelope)",
      detail: `coverage is "full" but ${degraded.length} degraded entry/entries are recorded`,
    });
  }
  if (coverage !== "full" && degraded.length === 0) {
    context.violations.push({
      check: "envelope-contract",
      extractor: "(envelope)",
      detail: `coverage is "${coverage}" with an EMPTY degraded[] — a consumer cannot tell what was missing`,
    });
  }
}

// ── walking ──────────────────────────────────────────────────────────────────

/** Every string in the document, with the dotted path that reached it. */
function walkStrings(
  value: unknown,
  path: string[],
  visit: (value: string, path: string[]) => void,
): void {
  walkValues(value, path, (leaf, at) => {
    if (typeof leaf === "string") visit(leaf, at);
  });
}

/**
 * Every scalar in the document. Array indices are NOT pushed onto the path, so
 * `contracts[3].symbol` reads as `contracts.symbol` — which is what makes
 * key-based rules (`LOCATION_KEYS`) work on arrays of strings and arrays of
 * objects alike.
 */
function walkValues(
  value: unknown,
  path: string[],
  visit: (value: unknown, path: string[]) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) walkValues(item, path, visit);
    return;
  }
  if (isRecord(value)) {
    for (const [key, item] of Object.entries(value)) walkValues(item, [...path, key], visit);
    return;
  }
  visit(value, path);
}

function lastKey(path: string[]): string | null {
  return path.length > 0 ? path[path.length - 1] : null;
}

/** Attribute a violation to the extractor whose subtree it was found in. */
function extractorOfPath(path: string[]): string {
  if (path[0] === "extractors" && path[1]) return path[1];
  return path[0] ?? "(document)";
}

function push(context: Context, check: string, path: string[], detail: string): void {
  context.violations.push({
    check,
    extractor: extractorOfPath(path),
    detail: `${path.join(".")}: ${detail}`,
  });
}

// ── small readers ────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringAt(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" ? value : null;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arrayAt(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function truncate(text: string, limit = 160): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}
