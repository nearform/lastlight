/**
 * The unit assembler — `lastlight-facts units`.
 *
 * Cuts a pull request into UNITS and renders, for each, the complete request a
 * single bounded, non-agentic model call receives (see
 * `docs/plans/unit-survey.md`). The five-branch agent survey spent minutes per
 * branch re-deriving with bash the context `facts`/`seed` had already computed;
 * this prints that context instead, once, per unit.
 *
 *   - one `symbol` unit per changed function or method (the OUTERMOST
 *     function-like declaration containing a changed line — a class is not a
 *     unit, its methods are);
 *   - at most one `module` unit per FILE, carrying every changed region no
 *     symbol unit holds (imports, constants, types, top-level statements,
 *     non-code files), in order, with an elision row between regions — split
 *     into several units only when the budget forces it;
 *   - small changed functions (≤ `SMALL_SYMBOL_LINES`, no obligation) folded
 *     into that module unit as whole regions, keeping their callers/callees;
 *   - one `pr` unit for the obligations no unit in the diff could hold;
 *   - a unit owning more than `FAMILY_SPLIT_CHANGED_LINES` changed lines is
 *     surveyed once PER FAMILY — one unit per asked family, each with only
 *     that family's question and obligations.
 *
 * Spec obligations (core's `spec-obligations.json` — acceptance criteria whose
 * second end is a list of candidate FILES) ride on the unit with the most
 * touched lines in their first candidate file that has one; see `attachSpec`.
 *
 * Every request is the run-constant `UNITS_SHARED_PREFIX` followed by the
 * unit-specific part, so a provider's prefix cache pays for the common ~6k
 * characters once per run rather than once per unit.
 *
 * ── The file set and the text come from GIT ────────────────────────────────
 *
 * The package rule (CLAUDE.md, "the file set comes from git"): every source
 * line shown is read from the HEAD COMMIT (`git show <headSha>:<path>`), never
 * the working tree, and the changed lines come from ONE `git diff` over the
 * same merge-base range every other extractor uses — so a tag in a request is
 * a claim about `headSha`, not about whatever the checkout holds. `facts.json`
 * is read for its shas and for ENRICHMENT only (reference sites, callees): a
 * tier-3 envelope with no symbols still yields a unit for every changed line.
 *
 * ── Deterministic, and loud about what it cut ──────────────────────────────
 *
 * Units are ordered by file, then line; ids are `u-NNN` in that order (a
 * family sibling `u-NNN-<family>`);
 * `requestSha256` is the sha256 of the exact request. Each request is held to a
 * character budget by a shrink cascade — trim neighbours, drop neighbours,
 * spread a module unit's regions over several units, split a long unit into
 * overlapping passes — and every step that fires marks
 * the unit `truncated` and names itself in `degraded[]`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "@ast-grep/napi";
import { z } from "zod";

import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE, FactsError, reasonOf, type ExitCode } from "./errors.js";
import { changedPaths, isGitRepo, showFile, tryGit, unifiedDiff, type ChangedPath } from "./git.js";
import { asSyntaxNode, grammarAvailable, type SyntaxNode } from "./langs/descriptor.js";
import { descriptorForPath, TSJS_FAMILY } from "./langs/register.js";
import { noopLogger, type LoggerPort } from "./log.js";
import { astGrepLangFor, languageIdOf, looksMinified, MAX_SCANNED_FILE_BYTES } from "./project.js";
import { AllDocumentSchema, DegradedEntrySchema, type AllDocument, type DegradedEntry, type SymbolFact } from "./schema.js";
import type { Obligation, ObligationsDocument } from "./seed.js";
import { splitPatches } from "./stage-diff.js";
import { scanDeclarations, scanImportLines } from "./syntactic.js";
import { unitResponseJsonSchema } from "./unit-response.js";
import {
  ALWAYS_ASKED,
  renderUnitRequest,
  UNITS_PROMPT_VERSION,
  UNITS_SHARED_PREFIX,
  type RequestModel,
  type ShownBlock,
  type ShownCallee,
  type ShownCaller,
  type ShownLine,
  type ShownObligation,
  type SpecUnitObligation,
} from "./units-render.js";

export { UNITS_PROMPT_VERSION, UNITS_SHARED_PREFIX } from "./units-render.js";

/**
 * The per-request budget, in characters (~4 per token). Sized so an ordinary
 * method plus its neighbours and a handful of obligations fits whole; the
 * cascade exists for the tail, not the median.
 */
export const DEFAULT_MAX_REQUEST_CHARS = 40_000;

/**
 * Units per document. Each unit is one model call, so this is a spend bound.
 * Past it the lowest-priority units (no obligations, fewest changed lines) are
 * dropped, their obligations move to the `pr` unit, and the drop is named in
 * `degraded[]` — never silent.
 */
export const DEFAULT_MAX_UNITS = 150;

/**
 * A unit OWNING more touched lines than this (changed head lines plus removal
 * points, inside its cores) is surveyed once PER FAMILY: one unit per asked
 * family — the same source, imports and neighbours, but a request that asks
 * only that family's question, carries only that family's obligations (and,
 * for `spec`, the spec obligations), and takes only that family's defects.
 * Smaller units stay multi-family.
 *
 * Measured, the v5 replay audit (Haiku 4.5, 8 skillspro cases × 2 arms, 3/50
 * gold credited): defects per unit were flat at 0.31–0.41 whatever the unit's
 * size, 81% of units with 100+ changed lines returned `defects: []`, and
 * several missed gold were fully visible inside large multi-family units — one
 * call asking five questions of a big change answered each shallowly. 40 is
 * where a unit stops being "one method's worth" of change; the split costs up
 * to one call per family for those units only (the shared prefix is cached).
 */
export const FAMILY_SPLIT_CHANGED_LINES = 40;

/** Callers / callees / obligation candidates shown at full size. */
export const MAX_NEIGHBOURS = 8;
/** …and after the first shrink step. */
const TRIMMED_NEIGHBOURS = 3;
const MAX_IMPORT_LINES = 40;
const TRIMMED_IMPORT_LINES = 10;
/** Leading-comment lines kept above a symbol. */
const MAX_LEADING_COMMENT = 30;
/** Context lines around a module region's changed lines. */
const MODULE_CONTEXT = 3;
/** Changed lines closer than this merge into one module region. */
const MODULE_GAP = 8;
/** Regions of one unit whose windows sit fewer lines apart than this are shown as one, not elided. */
const ELIDE_MIN_GAP = 3;
/**
 * A changed function this short (declaration to closing line) with no
 * obligation is folded into its file's module unit rather than being a unit —
 * on this repo's own commits, one- to ten-line test helpers were a third of
 * all units, each paying the full request overhead for a handful of lines.
 */
export const SMALL_SYMBOL_LINES = 15;
/** Overlap between passes of a split unit. */
const PASS_OVERLAP = 10;
/** A pass is never shorter than this, whatever the budget says. */
const MIN_PASS_LINES = 40;
/** Lines of excerpt either side of a `pr`-unit obligation's anchor. */
const PR_EXCERPT_CONTEXT = 2;

/**
 * Generated files a reviewer never reads line by line — "not findings" by the
 * survey skill's own table. Skipped by NAME, and listed in `skipped[]`.
 */
const GENERATED_FILES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "Pipfile.lock",
  "uv.lock",
]);

// ── the document ─────────────────────────────────────────────────────────────

export const UnitKindSchema = z.enum(["symbol", "module", "pr"]);
export type UnitKind = z.infer<typeof UnitKindSchema>;

export const UnitSchema = z.object({
  id: z.string(),
  kind: UnitKindSchema,
  file: z.string().nullable(),
  symbol: z.string().nullable(),
  lines: z.tuple([z.number().int(), z.number().int()]).nullable(),
  language: z.string().nullable(),
  /** Families of the obligations attached to this unit. Every unit is ASKED all of `ALWAYS_ASKED`. */
  families: z.array(z.string()),
  obligationIds: z.array(z.string()),
  request: z.string(),
  requestSha256: z.string(),
  truncated: z.boolean(),
  /**
   * Set only on a unit split by family (`FAMILY_SPLIT_CHANGED_LINES`): the ONE
   * family its request asks. Its id is `<splitOf>-<family>`.
   */
  family: z.string().optional(),
  /** Set only on a unit split by family: the id its unsplit form would have had, shared by its siblings. */
  splitOf: z.string().optional(),
});
export type Unit = z.infer<typeof UnitSchema>;

/**
 * One spec obligation as `spec-obligations.json` carries it — `SpecObligation`
 * from `apps/server/src/engine/review-spec.ts`, read LOOSELY (extra fields
 * pass through, `changedFileCount` / `found` optional) because core owns the
 * shape and a field it adds must not make the file "malformed" here.
 */
export const SpecObligationSchema = z.looseObject({
  id: z.string().min(1),
  criterion: z.string(),
  source: z.string(),
  candidates: z.array(z.string()),
  changedFileCount: z.number().optional(),
  found: z.literal(false).optional(),
  question: z.string(),
});

/** `spec-obligations.json` — core's `SpecObligationSet`, written before `units` runs. */
export const SpecObligationSetSchema = z.looseObject({
  obligations: z.array(SpecObligationSchema),
  dropped: z.number().optional(),
  changedFileCount: z.number().optional(),
  degraded: z.array(z.string()).optional(),
});

/** What `units.json` records of each spec obligation — exactly what the requests printed. */
const UnitSpecObligationSchema = z.object({
  id: z.string(),
  criterion: z.string(),
  source: z.string(),
  candidates: z.array(z.string()),
  question: z.string(),
});

/** A `units.json` the assembler wrote: every field present. */
export const FullUnitsDocumentSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  promptVersion: z.string(),
  /**
   * The unit-independent head every `request` starts with, byte for byte —
   * so a caller can mark it as a cache breakpoint. `request` =
   * `sharedPrefix` + the unit-specific part.
   */
  sharedPrefix: z.string(),
  sharedPrefixSha256: z.string(),
  coverage: z.enum(["full", "degraded", "none"]),
  degraded: z.array(DegradedEntrySchema),
  responseSchema: z.record(z.string(), z.unknown()),
  /** Changed files no unit covers, and why — deliberate skips, not failures. */
  skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
  /**
   * The spec obligations the requests carry, as printed — so ingest resolves an
   * `S-n` against exactly what the model was asked, as it reads line tags back
   * out of `request`. Absent on a document written before spec obligations
   * reached the workspace; `[]` when the file was read and held none.
   */
  specObligations: z.array(UnitSpecObligationSchema).optional(),
  units: z.array(UnitSchema),
});
export type UnitsDocument = z.infer<typeof FullUnitsDocumentSchema>;

/**
 * The document the `units` phase's SHELL writes when the process died without
 * writing one (`pr-review.yaml`'s `fallback()`): nothing was cut into units,
 * so every field that describes a rendering is `null` and `skipped` is absent.
 * Accepted HONESTLY rather than mirrored — the YAML should not have to track a
 * growing schema to say "the process died" — but ONLY with `coverage: "none"`
 * and an empty `units`: a document with units must carry everything above.
 */
export const FallbackUnitsDocumentSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  baseSha: z.string().nullable(),
  headSha: z.string().nullable(),
  promptVersion: z.string().nullable(),
  sharedPrefix: z.string().nullable().optional(),
  sharedPrefixSha256: z.string().nullable().optional(),
  coverage: z.literal("none"),
  degraded: z.array(DegradedEntrySchema),
  responseSchema: z.record(z.string(), z.unknown()).nullable(),
  skipped: z.array(z.object({ file: z.string(), reason: z.string() })).optional(),
  specObligations: z.array(UnitSpecObligationSchema).optional(),
  units: z.array(UnitSchema).max(0),
});
export type FallbackUnitsDocument = z.infer<typeof FallbackUnitsDocumentSchema>;

/** Either shape — what a READER of `units.json` must accept. */
export const UnitsDocumentSchema = z.union([FullUnitsDocumentSchema, FallbackUnitsDocumentSchema]);
export type AnyUnitsDocument = z.infer<typeof UnitsDocumentSchema>;

/**
 * Parse a `units.json` value as either shape, reporting the FULL schema's
 * issues on failure — a union's own error ("no member matched") says nothing a
 * reader can act on.
 */
export function parseUnitsDocument(
  value: unknown,
): { success: true; data: AnyUnitsDocument } | { success: false; error: z.ZodError } {
  const full = FullUnitsDocumentSchema.safeParse(value);
  if (full.success) return { success: true, data: full.data };
  const fallback = FallbackUnitsDocumentSchema.safeParse(value);
  if (fallback.success) return { success: true, data: fallback.data };
  return { success: false, error: full.error };
}

/**
 * The shell fallback's document, built here so its shape is pinned by a test
 * beside the schema that accepts it. `pr-review.yaml` prints this literally
 * (it cannot call a process that just died); keep the two in step.
 */
export function fallbackUnitsDocument(reason: string, headSha: string | null): FallbackUnitsDocument {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseSha: null,
    headSha,
    promptVersion: null,
    coverage: "none",
    degraded: [{ extractor: "units", reason }],
    responseSchema: null,
    units: [],
  };
}

/**
 * The prefix of the ONE degraded reason that means "there was genuinely
 * nothing to survey" — the only empty document that is a clean answer. Every
 * other empty document (a missing input, a dead process) means nobody looked,
 * and ingest reads it that way.
 */
export const NOTHING_TO_SURVEY = "nothing to survey";

export interface BuildUnitsOptions {
  /** The `.lastlight/pr-review` directory. */
  dir: string;
  /** The checkout (only its git objects are read). */
  repo: string;
  /** Defaults to `<dir>/facts.json`. */
  factsPath?: string;
  /** Defaults to `<dir>/obligations.json`. Absent ⇒ units carry no obligations, loudly. */
  obligationsPath?: string;
  /**
   * Core's `spec-obligations.json`. Defaults to `<dir>/spec-obligations.json`
   * when that exists; absent ⇒ no unit carries a spec obligation, named in
   * `degraded[]`. Named explicitly and missing ⇒ the same, naming the path.
   */
  specPath?: string;
  maxRequestChars?: number;
  maxUnits?: number;
  /** Defaults to {@link FAMILY_SPLIT_CHANGED_LINES}. */
  familySplitLines?: number;
  log?: LoggerPort;
}

export interface BuildUnitsResult {
  document: UnitsDocument;
  exitCode: ExitCode;
}

// ── per-file material ────────────────────────────────────────────────────────

interface FileDiff {
  /** Head lines this PR added or changed. */
  changed: Set<number>;
  /** Head line → text removed immediately before it (`lastLine + 1` = end of file). */
  removed: Map<number, string[]>;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/** Walk one file's unified patch into changed head lines and removal points. */
export function parsePatchLines(patch: string): FileDiff {
  const changed = new Set<number>();
  const removed = new Map<number, string[]>();
  let next: number | null = null;
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      const start = Number(header[1]);
      const count = header[2] === undefined ? 1 : Number(header[2]);
      // `+n,0` names the line BEFORE an empty new side.
      next = count === 0 ? start + 1 : start;
      continue;
    }
    if (next === null) continue;
    const mark = line[0];
    if (mark === "+") {
      changed.add(next);
      next += 1;
    } else if (mark === " ") {
      next += 1;
    } else if (mark === "-") {
      const list = removed.get(next) ?? [];
      list.push(line.slice(1));
      removed.set(next, list);
    }
  }
  return { changed, removed };
}

interface FunctionLike {
  name: string;
  kind: string;
  /** 1-based line of the name — the `declaredAt` convention. */
  nameLine: number;
  start: number;
  end: number;
}

const FUNCTION_VALUE_KINDS = new Set(["arrow_function", "function_expression", "function", "generator_function"]);
const QUALIFIER_KINDS = new Set(["class_declaration", "abstract_class_declaration", "class", "variable_declarator"]);

/** Nearest enclosing class (or object-literal variable) name, for `Service.run`. */
function qualifierOf(node: SyntaxNode): string | null {
  let current = node.parent();
  for (let depth = 0; current && depth < 8; depth++, current = current.parent()) {
    if (QUALIFIER_KINDS.has(current.kind())) {
      const name = current.field("name");
      if (name && name.kind() !== "object_pattern") return name.text();
    }
  }
  return null;
}

/**
 * The declaration kinds a non-TS/JS descriptor reports that are a UNIT: they
 * have a body a changed line can sit in. `interface-method` is Java's (a
 * `default` method has a body) and Go's `method_elem` — a one-line signature,
 * which the small-symbol fold absorbs. Classes, types and fields are not
 * units; their changed lines are module regions, as in TS/JS.
 */
const DESCRIPTOR_FUNCTION_KINDS = new Set(["function", "method", "constructor", "interface-method"]);

/** Keep only the declarations no other one contains — a class is not a unit, and a nested function is part of its parent. */
function outermostOf(found: FunctionLike[]): FunctionLike[] {
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.name.localeCompare(b.name));
  const outermost: FunctionLike[] = [];
  for (const f of found) {
    const container = outermost.find((o) => o.start <= f.start && o.end >= f.end);
    if (!container) outermost.push(f);
  }
  return outermost;
}

/**
 * Every OUTERMOST function-like declaration in a source: for TS/JS,
 * functions, methods, and `const f = () => …`; for any other language a
 * descriptor claims (Python, Go, Java), the functions / methods /
 * constructors `scanDeclarations` finds — a Python function nested in
 * another is part of its parent, as in TS/JS. `null` when the file has no
 * parser, its grammar did not load, or the parser refused it — the caller
 * surveys its lines as module regions instead, and says so.
 */
export function functionLikes(path: string, source: string): FunctionLike[] | null {
  const lang = astGrepLangFor(path);
  if (!lang) {
    const descriptor = descriptorForPath(path);
    if (!descriptor || descriptor.family === TSJS_FAMILY) return null;
    const sites = scanDeclarations(path, source);
    if (sites === null) return null;
    return outermostOf(
      sites
        .filter((site) => DESCRIPTOR_FUNCTION_KINDS.has(site.kind))
        .map((site) => ({ name: site.name, kind: site.kind, nameLine: site.line, start: site.startLine, end: site.endLine })),
    );
  }
  let root: SyntaxNode;
  try {
    root = asSyntaxNode(parse(lang, source).root());
  } catch {
    return null;
  }
  const found: FunctionLike[] = [];
  const add = (node: SyntaxNode, kind: string, nameNode: SyntaxNode | null): void => {
    const range = node.range();
    const local = nameNode?.text() ?? "(anonymous)";
    const qualifier = kind === "method" ? qualifierOf(node) : null;
    found.push({
      name: qualifier ? `${qualifier}.${local}` : local,
      kind,
      nameLine: (nameNode ?? node).range().start.line + 1,
      start: range.start.line + 1,
      end: range.end.line + 1,
    });
  };
  const findAll = (kind: string): SyntaxNode[] => {
    try {
      return (root as unknown as { findAll(rule: unknown): unknown[] })
        .findAll({ rule: { kind } })
        .map((n) => n as SyntaxNode);
    } catch {
      // A kind this grammar does not have — ast-grep refuses the rule rather
      // than matching nothing.
      return [];
    }
  };
  for (const kind of ["function_declaration", "generator_function_declaration"]) {
    for (const node of findAll(kind)) add(node, "function", node.field("name"));
  }
  for (const node of findAll("method_definition")) add(node, "method", node.field("name"));
  for (const node of findAll("variable_declarator")) {
    const value = node.field("value");
    const name = node.field("name");
    if (!value || !name || name.kind() !== "identifier" || !FUNCTION_VALUE_KINDS.has(value.kind())) continue;
    add(node, "function", name);
  }
  return outermostOf(found);
}

const IMPORT_LINE = /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|use\s+[\w:]|require\b|#include\b|using\s+[\w.]+;|package\s+[\w.]+)/;

/**
 * The file's import lines, as 1-based line numbers. Through a parser where
 * there is one — the descriptor's `importKinds` for Python / Go / Java (Go's
 * multi-line `import ( … )` block, Python's parenthesised `from x import (…)`),
 * ast-grep's `import_statement` for TS/JS (a multi-line `import { … } from` is
 * several lines); anything else, or a grammar that did not load, by a
 * per-line pattern over the head of the file.
 */
function importLines(path: string, source: string, lines: string[]): number[] {
  // `null` for TS/JS (their descriptors declare no importKinds), so that path is untouched.
  const scanned = scanImportLines(path, source);
  if (scanned !== null) return scanned;
  const lang = astGrepLangFor(path);
  if (lang) {
    try {
      const root = asSyntaxNode(parse(lang, source).root());
      const nodes = (root as unknown as { findAll(rule: unknown): unknown[] })
        .findAll({ rule: { kind: "import_statement" } })
        .map((n) => n as SyntaxNode);
      const out = new Set<number>();
      for (const node of nodes) {
        const range = node.range();
        for (let l = range.start.line + 1; l <= range.end.line + 1; l++) out.add(l);
      }
      return [...out].sort((a, b) => a - b);
    } catch {
      // fall through to the pattern
    }
  }
  const out: number[] = [];
  for (let i = 0; i < Math.min(lines.length, 300); i++) if (IMPORT_LINE.test(lines[i] ?? "")) out.push(i + 1);
  return out;
}

const COMMENTISH = /^\s*(\/\/|\/\*|\*|\*\/|#|@|"""|''')/;

/** First line of the comment / decorator block directly above `start`. */
function leadingCommentStart(lines: string[], start: number): number {
  let first = start;
  for (let l = start - 1; l >= 1 && start - l <= MAX_LEADING_COMMENT; l--) {
    if (!COMMENTISH.test(lines[l - 1] ?? "")) break;
    first = l;
  }
  return first;
}

interface FileCtx {
  path: string;
  status: ChangedPath["status"];
  lines: string[];
  diff: FileDiff;
  /** Changed lines plus removal points, clipped into [1, lines.length]. */
  touched: number[];
  functions: FunctionLike[];
  imports: number[];
  language: string;
}

// ── drafts ───────────────────────────────────────────────────────────────────

/**
 * One shown run of lines. `cores` are the extents the unit OWNS inside it —
 * a symbol's body, a cluster of changed lines, a folded small function — and
 * decide attachment and which declarations' callers are shown; `window` adds
 * the context (leading comment, surrounding lines) and decides what is shown.
 */
interface Region {
  window: [number, number];
  cores: [number, number][];
}

interface FoldedSymbol {
  name: string;
  kind: string;
  lines: [number, number];
}

interface Draft {
  kind: UnitKind;
  ctx: FileCtx | null;
  symbol: string | null;
  symbolKind: string | null;
  /** The unit's own extent: first core line to last (a pass's, once split). */
  lines: [number, number] | null;
  /** What is shown, in order. One for a symbol; one or more for a module unit; none for the pr unit. */
  regions: Region[];
  /** Small changed functions folded into a module unit. */
  folded: FoldedSymbol[];
  part: { index: number; of: number; how: "lines" | "regions" } | null;
  obligations: Obligation[];
  /** Spec obligations — attached AFTER the drafts are final (see `attachSpec`). */
  spec?: SpecUnitObligation[];
  truncated: boolean;
  reasons: string[];
  /** How many touched lines this unit holds — the priority when over `maxUnits`. */
  weight: number;
  /** Set on a unit split by family: the one family it asks, and the families its siblings ask. */
  split?: { family: string; families: string[]; threshold: number };
}

function contains(range: [number, number] | null, line: number): boolean {
  return range !== null && line >= range[0] && line <= range[1];
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/** Does the unit OWN this line — is it inside one of its cores? */
function holds(draft: Draft, line: number): boolean {
  return draft.regions.some((r) => r.cores.some((c) => contains(c, line)));
}

/** Does the unit SHOW this line? */
function shows(draft: Draft, line: number): boolean {
  return draft.regions.some((r) => contains(r.window, line));
}

function extentOf(regions: Region[]): [number, number] | null {
  const cores = regions.flatMap((r) => r.cores);
  if (cores.length === 0) return null;
  return [Math.min(...cores.map((c) => c[0])), Math.max(...cores.map((c) => c[1]))];
}

function touchedIn(ctx: FileCtx, regions: Region[]): number {
  return ctx.touched.filter((l) => regions.some((r) => r.cores.some((c) => contains(c, l)))).length;
}

/** Clusters of lines no further apart than `gap`. */
function clusters(lines: number[], gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (const line of [...lines].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && line - last[1] <= gap) last[1] = line;
    else out.push([line, line]);
  }
  return out;
}

/**
 * Order regions and merge any whose windows overlap or sit closer than
 * `ELIDE_MIN_GAP` lines — a two-line gap is cheaper shown than elided.
 */
function mergeRegions(regions: Region[]): Region[] {
  const sorted = [...regions].sort((a, b) => a.window[0] - b.window[0] || a.window[1] - b.window[1]);
  const out: Region[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.window[0] - last.window[1] - 1 < ELIDE_MIN_GAP) {
      last.window = [last.window[0], Math.max(last.window[1], r.window[1])];
      last.cores = [...last.cores, ...r.cores].sort((a, b) => a[0] - b[0]);
    } else {
      out.push({ window: [...r.window], cores: [...r.cores] });
    }
  }
  return out;
}

function moduleDraft(ctx: FileCtx, regions: Region[], folded: FoldedSymbol[]): Draft {
  const merged = mergeRegions(regions);
  return {
    kind: "module",
    ctx,
    symbol: null,
    symbolKind: null,
    lines: extentOf(merged),
    regions: merged,
    folded: [...folded].sort((a, b) => a.lines[0] - b.lines[0]),
    part: null,
    obligations: [],
    truncated: false,
    reasons: [],
    weight: touchedIn(ctx, merged),
  };
}

/**
 * A file's drafts: one symbol draft per changed function, and AT MOST ONE
 * module draft carrying every changed region no symbol holds, in order.
 */
function draftsFor(ctx: FileCtx): Draft[] {
  const drafts: Draft[] = [];
  const held = new Set<number>();
  for (const f of ctx.functions) {
    const inside = ctx.touched.filter((l) => l >= f.start && l <= f.end);
    if (inside.length === 0) continue;
    for (const l of inside) held.add(l);
    drafts.push({
      kind: "symbol",
      ctx,
      symbol: f.name,
      symbolKind: f.kind,
      lines: [f.start, f.end],
      regions: [{ window: [leadingCommentStart(ctx.lines, f.start), f.end], cores: [[f.start, f.end]] }],
      folded: [],
      part: null,
      obligations: [],
      truncated: false,
      reasons: [],
      weight: inside.length,
    });
  }
  const loose = ctx.touched.filter((l) => !held.has(l));
  if (loose.length > 0) {
    const regions = clusters(loose, MODULE_GAP).map(([from, to]): Region => ({
      window: [Math.max(1, from - MODULE_CONTEXT), Math.min(ctx.lines.length, to + MODULE_CONTEXT)],
      cores: [[from, to]],
    }));
    drafts.push(moduleDraft(ctx, regions, []));
  }
  return drafts;
}

/**
 * Fold each SMALL symbol unit with no obligation into its file's module unit,
 * as one more region shown whole. A two-line helper is not worth a model call
 * of its own, and its callers and callees survive the fold: they are computed
 * from the symbols declared inside a unit's cores, and a folded function is a
 * core. A symbol carrying an obligation stays a unit — attachment already
 * chose it. A lone small symbol in a file with no module unit stays too:
 * folding it would save nothing.
 */
function foldSmallSymbols(drafts: Draft[]): Draft[] {
  const byFile = new Map<FileCtx, Draft[]>();
  for (const d of drafts) {
    if (!d.ctx) continue;
    const list = byFile.get(d.ctx) ?? [];
    list.push(d);
    byFile.set(d.ctx, list);
  }
  const removed = new Set<Draft>();
  const added: Draft[] = [];
  for (const [ctx, mine] of byFile) {
    const module = mine.find((d) => d.kind === "module") ?? null;
    const small = mine.filter(
      (d) => d.kind === "symbol" && d.obligations.length === 0 && d.lines![1] - d.lines![0] + 1 <= SMALL_SYMBOL_LINES,
    );
    if (small.length === 0 || (!module && small.length < 2)) continue;
    const folded = small.map((d) => ({ name: d.symbol ?? "(anonymous)", kind: d.symbolKind ?? "function", lines: d.lines! }));
    const next = moduleDraft(ctx, [...(module?.regions ?? []), ...small.flatMap((d) => d.regions)], [...(module?.folded ?? []), ...folded]);
    next.obligations = module ? [...module.obligations] : [];
    for (const d of small) removed.add(d);
    if (module) removed.add(module);
    added.push(next);
  }
  return [...drafts.filter((d) => !removed.has(d)), ...added];
}

// ── obligation attachment ────────────────────────────────────────────────────

function splitSite(at: string): { path: string; line: number } | null {
  const match = /^(.*):(\d+)$/.exec(at);
  return match ? { path: match[1]!, line: Number(match[2]) } : null;
}

function refIndex(ref: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix.replace(/\./g, "\\.")}\\[(\\d+)\\]$`).exec(ref);
  return match ? Number(match[1]) : null;
}

/** Hunk strings (`path:a-b`) → does any overlap one of the draft's cores? */
function overlapsHunks(draft: Draft, hunks: string[]): boolean {
  if (!draft.ctx) return false;
  return hunks.some((h) => {
    const m = /^(.*):(\d+)-(\d+)$/.exec(h);
    if (!m || m[1] !== draft.ctx!.path) return false;
    const hunk: [number, number] = [Number(m[2]), Number(m[3])];
    return draft.regions.some((r) => r.cores.some((c) => overlaps(c, hunk)));
  });
}

/**
 * Which draft holds an obligation. In order: the draft whose extent holds its
 * anchor line (a symbol unit before a module one); then — for an obligation
 * about a SYMBOL — the first draft overlapping that symbol's changed hunks (a
 * class whose methods changed lands on the method); otherwise `null`, which
 * sends it to the `pr` unit.
 */
function attach(o: Obligation, drafts: Draft[], facts: AllDocument["extractors"]): Draft | null {
  const symbols = facts.facts?.symbols ?? [];
  const anchors: { path: string; line: number }[] = [];
  let symbol: SymbolFact | null = null;
  for (const e of o.evidence ?? []) {
    const s = refIndex(e.ref, "facts.symbols");
    if (s !== null && symbols[s]) {
      symbol = symbols[s]!;
      const site = splitSite(symbol.declaredAt);
      if (site) anchors.push(site);
    }
    const c = refIndex(e.ref, "contracts.contracts");
    const delta = c !== null ? facts.contracts?.contracts[c] : undefined;
    if (delta) {
      const match = symbols.find(
        (sym) => sym.declaredAt.startsWith(`${delta.file}:`) && (sym.name === delta.symbol || sym.name.endsWith(`.${delta.symbol}`)),
      );
      if (match) {
        symbol = match;
        const site = splitSite(match.declaredAt);
        if (site) anchors.push(site);
      }
    }
  }
  anchors.push({ path: o.introducedAt.path, line: o.introducedAt.line });

  for (const anchor of anchors) {
    const inFile = drafts.filter((d) => d.ctx?.path === anchor.path && holds(d, anchor.line));
    const hit = inFile.find((d) => d.kind === "symbol") ?? inFile[0];
    if (hit) return hit;
  }
  if (symbol) {
    const hit = drafts.find((d) => overlapsHunks(d, symbol!.changedHunks));
    if (hit) return hit;
  }
  return null;
}

/**
 * Which unit carries a SPEC obligation. A criterion's second end is a list of
 * changed FILES (best match first), never a line, so no extent can "hold" it.
 * The rule: the first candidate file that has any unit; within that file, the
 * unit holding the most touched lines (ties → the earliest). The biggest
 * change in the best-matching file is the likeliest implementation site, and
 * it shows the most of that file's change. ONE unit, never several: every
 * obligation is asked exactly once, which is what ingest's conservation and
 * the canonical row ids rely on — the request still prints every candidate,
 * so a model can say the criterion lives elsewhere. No candidate with a unit
 * ⇒ `null`, which sends it to the `pr` unit.
 */
function attachSpec(o: SpecUnitObligation, drafts: Draft[]): Draft | null {
  for (const file of o.candidates) {
    const inFile = drafts.filter((d) => d.ctx?.path === file);
    if (inFile.length === 0) continue;
    const touched = (d: Draft): number => d.ctx!.touched.filter((l) => holds(d, l)).length;
    return inFile.reduce((best, d) => (touched(d) > touched(best) ? d : best));
  }
  return null;
}

/** The line an obligation is anchored at, for picking the pass that holds it. */
function anchorLine(o: Obligation): number {
  return o.introducedAt.line;
}

// ── neighbours ───────────────────────────────────────────────────────────────

class HeadReader {
  private readonly cache = new Map<string, string[] | null>();
  constructor(
    private readonly repo: string,
    private readonly headSha: string,
  ) {}
  lines(path: string): string[] | null {
    if (!this.cache.has(path)) {
      const text = showFile(this.repo, this.headSha, path);
      this.cache.set(path, text === null || text.includes("\0") ? null : text.split("\n"));
    }
    return this.cache.get(path) ?? null;
  }
  lineAt(at: string): string | null {
    const site = splitSite(at);
    if (!site) return null;
    return this.lines(site.path)?.[site.line - 1] ?? null;
  }
}

interface Neighbours {
  callers: { at: string; of: string; inSymbol: string | null; inDiff: boolean; isTest: boolean }[];
  callees: ShownCallee[];
}

/** Callers and callees of every facts symbol DECLARED inside one of the draft's cores. */
function neighboursOf(draft: Draft, symbols: SymbolFact[], allFunctions: Map<string, FunctionLike[]>): Neighbours {
  if (!draft.ctx || draft.regions.length === 0) return { callers: [], callees: [] };
  const path = draft.ctx.path;
  const mine = symbols.filter((s) => {
    const site = splitSite(s.declaredAt);
    return site !== null && site.path === path && holds(draft, site.line);
  });
  const seen = new Set<string>();
  const callers: Neighbours["callers"] = [];
  for (const s of mine) {
    for (const r of s.references) {
      if (seen.has(r.at)) continue;
      const site = splitSite(r.at);
      if (site && site.path === path && shows(draft, site.line)) continue;
      seen.add(r.at);
      callers.push({ at: r.at, of: s.name, inSymbol: r.inSymbol, inDiff: r.inDiff, isTest: r.isTest });
    }
  }
  // Untouched, non-test callers first: they are the ones a file-by-file review
  // cannot see, which is the question most families are asking.
  callers.sort(
    (a, b) => Number(a.isTest) - Number(b.isTest) || Number(a.inDiff) - Number(b.inDiff) || a.at.localeCompare(b.at),
  );
  const names = [...new Set(mine.flatMap((s) => s.callees))].sort();
  const declared = new Map<string, string>();
  for (const s of symbols) {
    const local = s.name.split(".").pop()!;
    if (!declared.has(local)) declared.set(local, s.declaredAt);
  }
  for (const [file, fns] of allFunctions) {
    for (const f of fns) {
      const local = f.name.split(".").pop()!;
      if (!declared.has(local)) declared.set(local, `${file}:${f.nameLine}`);
    }
  }
  const callees = names.map((name) => ({ name, declaredAt: declared.get(name.split(".").pop()!) ?? null }));
  return { callers, callees };
}

// ── rendering with the shrink cascade ────────────────────────────────────────

interface RenderInput {
  draft: Draft;
  unitId: string;
  neighbours: Neighbours;
  head: HeadReader;
  /** 0 = full · 1 = trimmed neighbours · 2 = no neighbours. */
  level: 0 | 1 | 2;
  overview: string[];
}

function shownLines(ctx: FileCtx, from: number, to: number): ShownBlock {
  const lines: ShownLine[] = [];
  for (let l = from; l <= to; l++) {
    lines.push({
      line: l,
      text: ctx.lines[l - 1] ?? "",
      changed: ctx.diff.changed.has(l),
      removedBefore: ctx.diff.removed.get(l) ?? [],
    });
  }
  const removedAfter = to === ctx.lines.length ? (ctx.diff.removed.get(to + 1) ?? []) : [];
  return { file: ctx.path, lines, removedAfter };
}

function obligationView(o: Obligation, head: HeadReader, level: 0 | 1 | 2): ShownObligation {
  const all = o.enforcedAt?.candidates ?? [];
  const cap = level === 0 ? MAX_NEIGHBOURS : level === 1 ? TRIMMED_NEIGHBOURS : 0;
  const withText = all.slice(0, cap).map((at) => ({ at, text: head.lineAt(at) }));
  const bare = level === 2 ? all.slice(0, MAX_NEIGHBOURS).map((at) => ({ at, text: null })) : [];
  const shown = level === 2 ? bare : withText;
  return { obligation: o, candidates: shown, candidatesOmitted: all.length - shown.length };
}

function askedFor(obligations: Obligation[]): string[] {
  const asked: string[] = [...ALWAYS_ASKED];
  if (obligations.some((o) => o.family === "tests")) asked.push("tests");
  return asked;
}

function modelFor(input: RenderInput): RequestModel {
  const { draft, neighbours, head, level } = input;
  const ctx = draft.ctx;
  const neighbourCap = level === 0 ? MAX_NEIGHBOURS : level === 1 ? TRIMMED_NEIGHBOURS : 0;
  const importCap = level === 0 ? MAX_IMPORT_LINES : level === 1 ? TRIMMED_IMPORT_LINES : 0;

  let source: ShownBlock[] = [];
  let imports: ShownBlock | null = null;
  let importsOmitted = 0;
  if (ctx && draft.regions.length > 0) {
    source = draft.regions.map((r) => shownLines(ctx, r.window[0], r.window[1]));
    const outside = ctx.imports.filter((l) => !shows(draft, l));
    const kept = outside.slice(0, importCap);
    importsOmitted = outside.length - kept.length;
    if (kept.length > 0) {
      imports = {
        file: ctx.path,
        lines: kept.map((l) => ({ line: l, text: ctx.lines[l - 1] ?? "", changed: ctx.diff.changed.has(l), removedBefore: [] })),
        removedAfter: [],
      };
    }
  } else if (draft.kind === "pr") {
    // One excerpt per obligation anchor, merged per file where they overlap.
    const byFile = new Map<string, [number, number][]>();
    for (const o of draft.obligations) {
      const lines = head.lines(o.introducedAt.path);
      if (!lines) continue;
      const from = Math.max(1, o.introducedAt.line - PR_EXCERPT_CONTEXT);
      const to = Math.min(lines.length, o.introducedAt.line + PR_EXCERPT_CONTEXT);
      if (from > to) continue;
      const list = byFile.get(o.introducedAt.path) ?? [];
      list.push([from, to]);
      byFile.set(o.introducedAt.path, list);
    }
    for (const file of [...byFile.keys()].sort()) {
      const lines = head.lines(file)!;
      const ranges = byFile.get(file)!.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const r of ranges) {
        const last = merged[merged.length - 1];
        if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
        else merged.push([...r]);
      }
      for (const [from, to] of merged) {
        const shown: ShownLine[] = [];
        for (let l = from; l <= to; l++) shown.push({ line: l, text: lines[l - 1] ?? "", changed: false, removedBefore: [] });
        source.push({ file, lines: shown, removedAfter: [] });
      }
    }
  }

  // Name the target only when there is more than one to tell apart.
  const named = new Set(neighbours.callers.map((c) => c.of)).size > 1;
  const callers: ShownCaller[] = neighbours.callers
    .slice(0, neighbourCap)
    .map((c) => ({ ...c, of: named ? c.of : null, text: head.lineAt(c.at) }));
  const callees = neighbours.callees.slice(0, neighbourCap);

  const notes: string[] = [];
  if (level === 1) notes.push("callers, callees, imports and obligation candidates were TRIMMED to fit the request budget");
  if (level === 2) notes.push("callers, callees, imports and candidate excerpts were DROPPED to fit the request budget");

  return {
    unitId: input.unitId,
    kind: draft.kind,
    file: ctx?.path ?? null,
    symbol: draft.symbol,
    symbolKind: draft.symbolKind,
    lines: draft.lines,
    language: ctx?.language ?? null,
    part: draft.part,
    folded: draft.folded,
    source,
    imports,
    importsOmitted,
    callers,
    callersOmitted: neighbours.callers.length - callers.length,
    callees,
    calleesOmitted: neighbours.callees.length - callees.length,
    obligations: draft.obligations.map((o) => obligationView(o, head, level)),
    specObligations: draft.spec ?? [],
    overview: input.overview,
    asked: draft.split ? [draft.split.family] : askedFor(draft.obligations),
    familySplit: draft.split ?? null,
    shrinkNote: notes.length ? notes.join("; ") : null,
  };
}

function render(input: RenderInput): string {
  return renderUnitRequest(modelFor(input));
}

/**
 * The cascade, for one draft: full → trimmed → dropped. Returns the level that
 * fits, or 2 with `fits: false` when even that does not.
 */
function fitLevel(input: Omit<RenderInput, "level">, budget: number): { level: 0 | 1 | 2; fits: boolean; chars: number } {
  for (const level of [0, 1, 2] as const) {
    const chars = render({ ...input, level }).length;
    if (chars <= budget) return { level, fits: true, chars };
    if (level === 2) return { level, fits: false, chars };
  }
  return { level: 2, fits: false, chars: Infinity };
}

/**
 * Split a ONE-region draft whose source alone overruns the budget into
 * overlapping passes. Only passes holding a touched line survive; each
 * obligation goes to the pass showing its anchor (else the first), so every id
 * is still asked exactly once.
 */
function splitDraft(draft: Draft, input: Omit<RenderInput, "level" | "draft">, budget: number): Draft[] {
  if (draft.regions.length !== 1) return [draft];
  const ctx = draft.ctx!;
  const region = draft.regions[0]!;
  const [from, to] = region.window;
  const shell = render({ ...input, draft: { ...draft, regions: [{ ...region, window: [from, from] }] }, level: 2 }).length;
  const span = to - from + 1;
  const avg = Math.max(1, (render({ ...input, draft, level: 2 }).length - shell) / Math.max(1, span));
  const size = Math.max(MIN_PASS_LINES, Math.floor((budget - shell) / avg));
  if (size >= span) return [draft];

  const windows: [number, number][] = [];
  for (let start = from; start <= to; start += size - PASS_OVERLAP) {
    const end = Math.min(to, start + size - 1);
    windows.push([start, end]);
    if (end === to) break;
  }
  const touched = new Set(ctx.touched);
  const kept = windows.filter(([a, b]) => {
    for (let l = a; l <= b; l++) if (touched.has(l)) return true;
    return false;
  });
  const passes: Draft[] = kept.map(([a, b]) => {
    const clipped = region.cores
      .filter((c) => overlaps(c, [a, b]))
      .map((c): [number, number] => [Math.max(a, c[0]), Math.min(b, c[1])]);
    const regions: Region[] = [{ window: [a, b], cores: clipped.length > 0 ? clipped : [[a, b]] }];
    return {
      ...draft,
      lines: extentOf(regions),
      regions,
      folded: draft.folded.filter((f) => overlaps(f.lines, [a, b])),
      obligations: [],
      reasons: [...draft.reasons],
      truncated: true,
      weight: [...touched].filter((l) => l >= a && l <= b).length,
    };
  });
  if (passes.length === 0) return [draft];
  for (const o of draft.obligations) {
    const home = passes.find((p) => shows(p, anchorLine(o))) ?? passes[0]!;
    home.obligations.push(o);
  }
  passes.forEach((p, i) => {
    p.part = { index: i + 1, of: passes.length, how: "lines" };
  });
  return passes;
}

/**
 * Spread a module unit's regions, in order, over as few units as fit the
 * budget at FULL context (level 0) — greedy, so the split is deterministic.
 * Each obligation travels with the region that owns its anchor (else the one
 * that shows it, else the first). A single region that still does not fit is
 * left to the caller's pass split.
 */
function packRegions(draft: Draft, inputFor: (d: Draft) => Omit<RenderInput, "level">, budget: number): Draft[] {
  const ctx = draft.ctx!;
  const homeOf = new Map<Obligation, number>();
  for (const o of draft.obligations) {
    const line = anchorLine(o);
    const byCore = draft.regions.findIndex((r) => r.cores.some((c) => contains(c, line)));
    const byWindow = draft.regions.findIndex((r) => contains(r.window, line));
    homeOf.set(o, byCore >= 0 ? byCore : byWindow >= 0 ? byWindow : 0);
  }
  const make = (indices: number[]): Draft => {
    const regions = indices.map((i) => draft.regions[i]!);
    return {
      ...draft,
      lines: extentOf(regions),
      regions,
      folded: draft.folded.filter((f) => regions.some((r) => overlaps(f.lines, r.window))),
      obligations: draft.obligations.filter((o) => indices.includes(homeOf.get(o)!)),
      part: null,
      reasons: [...draft.reasons],
      truncated: true,
      weight: touchedIn(ctx, regions),
    };
  };
  const groups: number[][] = [];
  let current: number[] = [];
  for (let i = 0; i < draft.regions.length; i++) {
    if (current.length === 0) {
      current = [i];
      continue;
    }
    const trial = make([...current, i]);
    const fit = fitLevel(inputFor(trial), budget);
    if (fit.fits && fit.level === 0) current.push(i);
    else {
      groups.push(current);
      current = [i];
    }
  }
  if (current.length > 0) groups.push(current);
  return groups.map(make);
}

// ── the entry point ──────────────────────────────────────────────────────────

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new FactsError("units", `${what} not found at ${path} — nothing to assemble units from`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new FactsError("units", `${what} at ${path} is not readable JSON: ${reasonOf(err)}`);
  }
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

const SPEC_GAP_TAIL = "so no unit carries a spec obligation — the spec family is asked only its falsifiable-documentation half";

/**
 * Read core's `spec-obligations.json`. Never throws: a missing or malformed
 * file is a `degraded[]` reason and no spec obligation, because the spec axis
 * is one family of six and must not take the unit survey down with it.
 */
function loadSpecObligations(
  specPath: string | undefined,
  dir: string,
): { obligations: SpecUnitObligation[] | null; reason: string | null; set: z.infer<typeof SpecObligationSetSchema> | null } {
  const path = specPath ?? join(dir, "spec-obligations.json");
  if (!existsSync(path)) {
    return {
      obligations: null,
      set: null,
      reason: specPath
        ? `spec-obligations.json not found at ${path} (named by --spec), ${SPEC_GAP_TAIL}`
        : `spec-obligations.json not found at ${path} — core did not write the spec obligations, ${SPEC_GAP_TAIL}`,
    };
  }
  let parsed: z.infer<typeof SpecObligationSetSchema>;
  try {
    const result = SpecObligationSetSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    if (!result.success) {
      const issues = result.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
      return { obligations: null, set: null, reason: `spec-obligations.json at ${path} does not validate (${issues}), ${SPEC_GAP_TAIL}` };
    }
    parsed = result.data;
  } catch (err) {
    return { obligations: null, set: null, reason: `spec-obligations.json at ${path} is not readable JSON (${reasonOf(err)}), ${SPEC_GAP_TAIL}` };
  }
  const ids = parsed.obligations.map((o) => o.id);
  const repeated = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (repeated.length > 0) {
    return {
      obligations: null,
      set: null,
      reason: `spec-obligations.json at ${path} repeats obligation id(s) ${[...new Set(repeated)].join(", ")} — an answer could not be told apart, ${SPEC_GAP_TAIL}`,
    };
  }
  const obligations = parsed.obligations
    .map((o) => ({ id: o.id, criterion: o.criterion, source: o.source, candidates: o.candidates, question: o.question }))
    .sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { obligations, set: parsed, reason: null };
}

/** A document that says nothing was surveyed and why. Validates like any other. */
export function emptyUnitsDocument(reason: string, shas: { baseSha?: string; headSha?: string } = {}): UnitsDocument {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseSha: shas.baseSha ?? "unknown",
    headSha: shas.headSha ?? "unknown",
    promptVersion: UNITS_PROMPT_VERSION,
    sharedPrefix: UNITS_SHARED_PREFIX,
    sharedPrefixSha256: sha256(UNITS_SHARED_PREFIX),
    coverage: "none",
    degraded: [{ extractor: "units", reason }],
    responseSchema: unitResponseJsonSchema(),
    skipped: [],
    units: [],
  };
}

/**
 * Assemble `units.json`. Throws `FactsError` when an INPUT is missing (no
 * facts.json, no git history for its shas) — the CLI turns that into a
 * `coverage: "none"` document and exit 2.
 */
export function buildUnits(options: BuildUnitsOptions): BuildUnitsResult {
  const log = options.log ?? noopLogger;
  const budget = options.maxRequestChars ?? DEFAULT_MAX_REQUEST_CHARS;
  const maxUnits = options.maxUnits ?? DEFAULT_MAX_UNITS;
  const repo = isAbsolute(options.repo) ? options.repo : resolve(options.repo);
  const factsPath = options.factsPath ?? join(options.dir, "facts.json");
  const obligationsPath = options.obligationsPath ?? join(options.dir, "obligations.json");
  const degraded: DegradedEntry[] = [];
  const note = (reason: string): void => {
    degraded.push({ extractor: "units", reason });
  };

  const parsedFacts = AllDocumentSchema.safeParse(readJson(factsPath, "facts.json"));
  if (!parsedFacts.success) {
    throw new FactsError("units", `facts.json at ${factsPath} is not an \`all\` document: ${parsedFacts.error.message}`);
  }
  const facts = parsedFacts.data;
  const { baseSha, headSha } = facts;
  if (!isGitRepo(repo)) throw new FactsError("units", `${repo} is not a git repository — the unit source is read from git`);
  for (const sha of [baseSha, headSha]) {
    if (tryGit(repo, ["rev-parse", "--verify", `${sha}^{commit}`]).status !== 0) {
      throw new FactsError(
        "units",
        `facts.json names ${sha} but ${repo} does not have that commit — the range cannot be re-read, so no unit can be built`,
      );
    }
  }
  // Only the cases that cost a unit its NEIGHBOURS. facts.json is `degraded`
  // on almost every run for reasons that do not touch callers (no coverage
  // artifact, no implementations query), and an entry on every run is an entry
  // nobody reads.
  if (!facts.extractors.facts || facts.coverage === "none" || facts.tier === 3) {
    note(
      `facts.json has no impact cone (coverage "${facts.coverage}", tier ${facts.tier}) — every changed line still gets a unit (the diff is re-read from git), but no unit shows callers or callees`,
    );
  }

  let obligations: Obligation[] = [];
  let obligationsDoc: ObligationsDocument | null = null;
  if (existsSync(obligationsPath)) {
    try {
      obligationsDoc = JSON.parse(readFileSync(obligationsPath, "utf8")) as ObligationsDocument;
      obligations = Array.isArray(obligationsDoc.obligations) ? obligationsDoc.obligations : [];
    } catch (err) {
      note(`obligations.json at ${obligationsPath} is unreadable (${reasonOf(err)}) — no unit carries an obligation, so every family is surveyed unseeded`);
    }
  } else {
    note(`obligations.json not found at ${obligationsPath} — no unit carries an obligation, so every family is surveyed unseeded`);
  }
  const spec = loadSpecObligations(options.specPath, options.dir);
  if (spec.reason) note(spec.reason);

  // ONE diff, the same merge-base range every other extractor uses.
  const changed = changedPaths(repo, baseSha, headSha).sort((a, b) => a.path.localeCompare(b.path));
  const patches = new Map(splitPatches(unifiedDiff(repo, baseSha, headSha)).map((c) => [c.path, c.text]));
  const head = new HeadReader(repo, headSha);

  const skipped: UnitsDocument["skipped"] = [];
  const deleted: string[] = [];
  const contexts: FileCtx[] = [];
  const allFunctions = new Map<string, FunctionLike[]>();
  for (const change of changed) {
    const { path } = change;
    if (change.status === "deleted") {
      deleted.push(path);
      continue;
    }
    const base = path.split("/").pop() ?? path;
    if (GENERATED_FILES.has(base)) {
      skipped.push({ file: path, reason: "generated lockfile — not a review site" });
      continue;
    }
    const text = showFile(repo, headSha, path);
    if (text === null) {
      skipped.push({ file: path, reason: "not readable at head" });
      note(`${path} changed but could not be read at ${headSha.slice(0, 8)} — no unit covers it`);
      continue;
    }
    if (text.includes("\0")) {
      skipped.push({ file: path, reason: "binary" });
      continue;
    }
    if (Buffer.byteLength(text, "utf8") > MAX_SCANNED_FILE_BYTES) {
      skipped.push({ file: path, reason: `larger than ${MAX_SCANNED_FILE_BYTES} bytes` });
      note(`${path} is larger than ${MAX_SCANNED_FILE_BYTES} bytes and was not surveyed — its changed lines are in no unit`);
      continue;
    }
    if (looksMinified(text)) {
      skipped.push({ file: path, reason: "minified / bundled" });
      continue;
    }
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const diff = parsePatchLines(patches.get(path) ?? "");
    const touched = new Set<number>([...diff.changed].filter((l) => l >= 1 && l <= lines.length));
    for (const at of diff.removed.keys()) touched.add(Math.min(Math.max(1, at), Math.max(1, lines.length)));
    if (touched.size === 0) {
      skipped.push({ file: path, reason: change.status === "renamed" ? "renamed without a content change" : "no textual change" });
      continue;
    }
    const fns = functionLikes(path, text);
    const descriptor = fns === null ? descriptorForPath(path) : null;
    if (descriptor) {
      const grammar = grammarAvailable(descriptor);
      note(
        grammar === null
          ? `${path} did not parse — its changed lines are surveyed as module regions, with no symbol unit`
          : `${path} did not parse (${grammar}) — its changed lines are surveyed as module regions, with no symbol unit`,
      );
    }
    allFunctions.set(path, fns ?? []);
    contexts.push({
      path,
      status: change.status,
      lines,
      diff,
      touched: [...touched].sort((a, b) => a - b),
      functions: fns ?? [],
      imports: importLines(path, text, lines),
      language: languageIdOf(path),
    });
  }

  // Name symbol units the way `facts` does, where it knows the symbol.
  const symbols = facts.extractors.facts?.symbols ?? [];
  const factName = new Map(symbols.map((s) => [s.declaredAt, s.name]));
  let drafts = contexts.flatMap(draftsFor);
  for (const d of drafts) {
    if (d.kind !== "symbol" || !d.ctx) continue;
    const fn = d.ctx.functions.find((f) => f.start === d.lines![0] && f.end === d.lines![1]);
    const named = fn ? factName.get(`${d.ctx.path}:${fn.nameLine}`) : undefined;
    if (named) d.symbol = named;
  }

  const unattributed: Obligation[] = [];
  const ordered = [...obligations].sort((a, b) => a.id.localeCompare(b.id));
  for (const o of ordered) {
    const home = attach(o, drafts, facts.extractors);
    if (home) home.obligations.push(o);
    else unattributed.push(o);
  }
  // After attachment: only a small symbol no obligation chose is folded.
  drafts = foldSmallSymbols(drafts);

  // The spend bound. Lowest priority first out; their obligations are not lost.
  if (drafts.length > maxUnits) {
    const ranked = [...drafts].sort(
      (a, b) =>
        Number(b.obligations.length > 0) - Number(a.obligations.length > 0) ||
        b.weight - a.weight ||
        a.ctx!.path.localeCompare(b.ctx!.path) ||
        a.lines![0] - b.lines![0],
    );
    const keep = new Set(ranked.slice(0, maxUnits));
    const dropped = drafts.filter((d) => !keep.has(d));
    for (const d of dropped) unattributed.push(...d.obligations);
    note(
      `${dropped.length} unit(s) over the ceiling of ${maxUnits} were not surveyed — the lowest-priority ones (no obligation, fewest changed lines), in ${[...new Set(dropped.map((d) => d.ctx!.path))].slice(0, 10).join(", ")}${dropped.length > 10 ? ", …" : ""}. Their obligations moved to the pr unit`,
    );
    drafts = drafts.filter((d) => keep.has(d));
  }

  const neighboursByDraft = new Map<Draft, Neighbours>();
  const neighboursFor = (d: Draft): Neighbours => {
    let n = neighboursByDraft.get(d);
    if (!n) {
      n = neighboursOf(d, symbols, allFunctions);
      neighboursByDraft.set(d, n);
    }
    return n;
  };

  // Placeholder id of the final width, so a size decision made now holds later.
  const PLACEHOLDER = "u-000";
  const inputFor = (d: Draft) => ({ unitId: PLACEHOLDER, draft: d, neighbours: neighboursFor(d), head, overview: [] as string[] });
  const finalDrafts: Draft[] = [];
  for (const d of drafts) {
    if (fitLevel(inputFor(d), budget).fits) {
      finalDrafts.push(d);
      continue;
    }
    // A module unit first spreads its regions over several units; any one
    // region still too long — or a symbol — is split into overlapping passes.
    const groups = d.kind === "module" && d.regions.length > 1 ? packRegions(d, inputFor, budget) : [d];
    const pieces: Draft[] = [];
    for (const g of groups) {
      if (groups.length > 1 && fitLevel(inputFor(g), budget).fits) {
        pieces.push(g);
        continue;
      }
      const passes = splitDraft(g, inputFor(g), budget);
      // A pass shows a slice of its parent's code, so it keeps the parent's neighbours.
      for (const p of passes) if (p !== g) neighboursByDraft.set(p, neighboursFor(g));
      pieces.push(...passes);
    }
    if (pieces.length > 1) {
      pieces.forEach((p, i) => {
        p.part = { index: i + 1, of: pieces.length, how: p.part?.how ?? "regions" };
      });
      const how = [groups.length > 1 ? `${groups.length} units by region` : null, pieces.length > groups.length ? "overlapping passes" : null]
        .filter(Boolean)
        .join(", then ");
      note(
        `${d.ctx!.path}:${d.lines![0]}-${d.lines![1]} (${d.symbol ?? "module-scope changes"}) is too long for one request of ${budget} chars — split into ${pieces.length} units (${how})`,
      );
    }
    finalDrafts.push(...pieces);
  }

  finalDrafts.sort(
    (a, b) => a.ctx!.path.localeCompare(b.ctx!.path) || a.lines![0] - b.lines![0] || a.lines![1] - b.lines![1],
  );

  // Spec obligations attach to FINAL units: their anchor is a file, so no
  // split or fold needs to route them, and a request that grows past the
  // budget by one criterion still goes through the fit cascade below.
  const unattributedSpec: SpecUnitObligation[] = [];
  for (const o of spec.obligations ?? []) {
    const home = attachSpec(o, finalDrafts);
    if (home) (home.spec ??= []).push(o);
    else unattributedSpec.push(o);
  }

  // A large unit is surveyed once PER FAMILY (see FAMILY_SPLIT_CHANGED_LINES).
  // After spec attachment, so the spec obligations ride with the `spec`
  // sibling; after the shrink cascade, so a pass is judged on what it owns.
  // Every obligation goes to the ONE sibling asking its family.
  const splitAt = options.familySplitLines ?? FAMILY_SPLIT_CHANGED_LINES;
  const groups: Draft[][] = finalDrafts.map((d) => {
    if (!d.ctx || touchedIn(d.ctx, d.regions) <= splitAt) return [d];
    const families = askedFor(d.obligations);
    for (const o of d.obligations) if (!families.includes(o.family)) families.push(o.family);
    const neighbours = neighboursFor(d);
    return families.map((family): Draft => {
      const { spec: _spec, ...rest } = d;
      const child: Draft = {
        ...rest,
        obligations: d.obligations.filter((o) => o.family === family),
        ...(family === "spec" && d.spec ? { spec: d.spec } : {}),
        reasons: [...d.reasons],
        split: { family, families, threshold: splitAt },
      };
      neighboursByDraft.set(child, neighbours);
      return child;
    });
  });

  const prDraft: Draft | null =
    unattributed.length > 0 || unattributedSpec.length > 0
      ? {
          kind: "pr",
          ctx: null,
          symbol: null,
          symbolKind: null,
          lines: null,
          regions: [],
          folded: [],
          part: null,
          obligations: [...unattributed].sort((a, b) => a.id.localeCompare(b.id)),
          spec: unattributedSpec,
          truncated: false,
          reasons: [],
          weight: 0,
        }
      : null;
  // Ids number the UNSPLIT units in order (`u-NNN`); a family sibling is
  // `u-NNN-<family>` — within the core handler's `[A-Za-z0-9_-]` alphabet, and
  // sorting beside its parent's number. With no split the ids are unchanged.
  const width = Math.max(3, String(groups.length + (prDraft ? 1 : 0)).length);
  const numbered = (i: number): string => `u-${String(i + 1).padStart(width, "0")}`;
  const all: Draft[] = [];
  const ids: string[] = [];
  const splitOf: (string | null)[] = [];
  groups.forEach((group, i) => {
    for (const d of group) {
      all.push(d);
      ids.push(d.split ? `${numbered(i)}-${d.split.family}` : numbered(i));
      splitOf.push(d.split ? numbered(i) : null);
    }
  });
  if (prDraft) {
    all.push(prDraft);
    ids.push(numbered(groups.length));
    splitOf.push(null);
  }

  const overview = (): string[] => {
    const lines: string[] = [];
    for (const ctx of contexts) {
      const covering = all
        .map((d, i) => (d.ctx === ctx ? ids[i] : null))
        .filter((id): id is string => id !== null);
      lines.push(`changed ${ctx.path} (${ctx.status}) — surveyed by ${covering.length ? covering.join(", ") : "no unit"}`);
    }
    for (const path of deleted) lines.push(`deleted ${path} — no head lines, so no unit`);
    for (const s of skipped) lines.push(`not surveyed ${s.file} — ${s.reason}`);
    if (spec.obligations === null) lines.push(`spec obligations: none — ${spec.reason}`);
    else if (spec.obligations.length === 0) {
      lines.push(`spec obligations: none were built — ${spec.set?.degraded?.join("; ") || "the PR states no acceptance criteria"}`);
    } else {
      const where = (o: SpecUnitObligation): string => ids[all.findIndex((d) => d.spec?.includes(o) ?? false)] ?? "no unit";
      lines.push(`spec obligations: ${spec.obligations.length} — ${spec.obligations.map((o) => `${o.id} in ${where(o)}`).join(", ")}`);
    }
    return lines;
  };

  const units: Unit[] = all.map((d, i) => {
    const id = ids[i]!;
    const neighbours = d.kind === "pr" ? { callers: [], callees: [] } : neighboursFor(d);
    const input = { unitId: id, draft: d, neighbours, head, overview: d.kind === "pr" ? overview() : [] };
    const fit = fitLevel(input, budget);
    const request = render({ ...input, level: fit.level });
    let truncated = d.truncated || fit.level > 0;
    const where = d.ctx ? `${d.ctx.path}:${d.lines![0]}-${d.lines![1]}` : "the pr unit";
    if (fit.level === 1) note(`${id} (${where}): neighbours trimmed to fit ${budget} chars`);
    if (fit.level === 2) note(`${id} (${where}): neighbours dropped to fit ${budget} chars`);
    if (!fit.fits) {
      truncated = true;
      note(`${id} (${where}): still ${request.length} chars after every shrink step — over the ${budget}-char budget`);
    }
    const families = [...new Set([...d.obligations.map((o) => o.family as string), ...(d.spec?.length ? ["spec"] : [])])].sort();
    return {
      id,
      kind: d.kind,
      file: d.ctx?.path ?? null,
      symbol: d.symbol,
      lines: d.lines,
      language: d.ctx?.language ?? null,
      families,
      obligationIds: [...d.obligations.map((o) => o.id), ...(d.spec ?? []).map((o) => o.id)],
      request,
      requestSha256: sha256(request),
      truncated,
      ...(d.split ? { family: d.split.family, splitOf: splitOf[i]! } : {}),
    };
  });

  if (units.length === 0) {
    note(
      changed.length === 0
        ? `${NOTHING_TO_SURVEY}: the range changed no file`
        : `${NOTHING_TO_SURVEY}: ${changed.length} changed file(s), none with a head line to show (${deleted.length} deleted, ${skipped.length} skipped)`,
    );
  }

  const document: UnitsDocument = FullUnitsDocumentSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    baseSha,
    headSha,
    promptVersion: UNITS_PROMPT_VERSION,
    sharedPrefix: UNITS_SHARED_PREFIX,
    sharedPrefixSha256: sha256(UNITS_SHARED_PREFIX),
    coverage: units.length === 0 ? "none" : degraded.length > 0 ? "degraded" : "full",
    degraded,
    responseSchema: unitResponseJsonSchema(),
    skipped,
    ...(spec.obligations !== null ? { specObligations: spec.obligations } : {}),
    units,
  });

  log.info("assembled units", {
    units: units.length,
    obligations: obligations.length,
    unattributed: unattributed.length,
    splitByFamily: groups.filter((g) => g.some((d) => d.split)).length,
    truncated: units.filter((u) => u.truncated).length,
    coverage: document.coverage,
    seeded: obligationsDoc !== null,
  });

  // Nothing to survey is a trustworthy answer, not a failure.
  const exitCode: ExitCode = units.length === 0 ? EXIT_OK : degraded.length > 0 ? EXIT_DEGRADED : EXIT_OK;
  return { document, exitCode };
}

/** The CLI's wrapper: a missing input still writes a document, and says why. */
export function buildUnitsOrEmpty(options: BuildUnitsOptions): BuildUnitsResult {
  try {
    return buildUnits(options);
  } catch (err) {
    const exitCode: ExitCode = err instanceof FactsError ? err.exitCode : EXIT_UNAVAILABLE;
    (options.log ?? noopLogger).warn("units could not be assembled", { err });
    return { document: emptyUnitsDocument(reasonOf(err)), exitCode };
  }
}
