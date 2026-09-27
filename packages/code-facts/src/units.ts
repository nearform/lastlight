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
 *   - one `module` unit per cluster of changed lines that no symbol unit holds
 *     (imports, constants, types, top-level statements, non-code files);
 *   - one `pr` unit for the obligations no unit in the diff could hold.
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
 * Units are ordered by file, then line; ids are `u-NNN` in that order;
 * `requestSha256` is the sha256 of the exact request. Each request is held to a
 * character budget by a shrink cascade — trim neighbours, drop neighbours,
 * split a long unit into overlapping passes — and every step that fires marks
 * the unit `truncated` and names itself in `degraded[]`.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parse } from "@ast-grep/napi";
import { z } from "zod";

import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE, FactsError, reasonOf, type ExitCode } from "./errors.js";
import { changedPaths, isGitRepo, showFile, tryGit, unifiedDiff, type ChangedPath } from "./git.js";
import { asSyntaxNode, type SyntaxNode } from "./langs/descriptor.js";
import { noopLogger, type LoggerPort } from "./log.js";
import { astGrepLangFor, languageIdOf, looksMinified, MAX_SCANNED_FILE_BYTES } from "./project.js";
import { AllDocumentSchema, DegradedEntrySchema, type AllDocument, type DegradedEntry, type SymbolFact } from "./schema.js";
import type { Obligation, ObligationsDocument } from "./seed.js";
import { splitPatches } from "./stage-diff.js";
import { unitResponseJsonSchema } from "./unit-response.js";
import {
  ALWAYS_ASKED,
  renderUnitRequest,
  UNITS_PROMPT_VERSION,
  type RequestModel,
  type ShownBlock,
  type ShownCallee,
  type ShownCaller,
  type ShownLine,
  type ShownObligation,
} from "./units-render.js";

export { UNITS_PROMPT_VERSION } from "./units-render.js";

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
});
export type Unit = z.infer<typeof UnitSchema>;

export const UnitsDocumentSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  promptVersion: z.string(),
  coverage: z.enum(["full", "degraded", "none"]),
  degraded: z.array(DegradedEntrySchema),
  responseSchema: z.record(z.string(), z.unknown()),
  /** Changed files no unit covers, and why — deliberate skips, not failures. */
  skipped: z.array(z.object({ file: z.string(), reason: z.string() })),
  units: z.array(UnitSchema),
});
export type UnitsDocument = z.infer<typeof UnitsDocumentSchema>;

export interface BuildUnitsOptions {
  /** The `.lastlight/pr-review` directory. */
  dir: string;
  /** The checkout (only its git objects are read). */
  repo: string;
  /** Defaults to `<dir>/facts.json`. */
  factsPath?: string;
  /** Defaults to `<dir>/obligations.json`. Absent ⇒ units carry no obligations, loudly. */
  obligationsPath?: string;
  maxRequestChars?: number;
  maxUnits?: number;
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
 * Every OUTERMOST function-like declaration in a TS/JS source: functions,
 * methods, and `const f = () => …`. `null` when the file has no parser or the
 * parser refused it — the caller surveys its lines as module regions instead,
 * and says so.
 */
export function functionLikes(path: string, source: string): FunctionLike[] | null {
  const lang = astGrepLangFor(path);
  if (!lang) return null;
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
  found.sort((a, b) => a.start - b.start || b.end - a.end || a.name.localeCompare(b.name));
  const outermost: FunctionLike[] = [];
  for (const f of found) {
    const container = outermost.find((o) => o.start <= f.start && o.end >= f.end);
    if (!container) outermost.push(f);
  }
  return outermost;
}

const IMPORT_LINE = /^\s*(import\b|export\s+(\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|use\s+[\w:]|require\b|#include\b|using\s+[\w.]+;|package\s+[\w.]+)/;

/**
 * The file's import lines, as 1-based line numbers. TS/JS through the parser
 * (a multi-line `import { … } from` is several lines); anything else by a
 * per-line pattern over the head of the file.
 */
function importLines(path: string, source: string, lines: string[]): number[] {
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

interface Draft {
  kind: UnitKind;
  ctx: FileCtx | null;
  symbol: string | null;
  symbolKind: string | null;
  /** The unit's own extent (a pass's extent, once split). */
  lines: [number, number] | null;
  /** Shown source window: the extent plus leading comment or context. */
  window: [number, number] | null;
  part: { index: number; of: number } | null;
  obligations: Obligation[];
  truncated: boolean;
  reasons: string[];
  /** How many touched lines this unit holds — the priority when over `maxUnits`. */
  weight: number;
}

function contains(range: [number, number] | null, line: number): boolean {
  return range !== null && line >= range[0] && line <= range[1];
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
      window: [leadingCommentStart(ctx.lines, f.start), f.end],
      part: null,
      obligations: [],
      truncated: false,
      reasons: [],
      weight: inside.length,
    });
  }
  const loose = ctx.touched.filter((l) => !held.has(l));
  for (const [from, to] of clusters(loose, MODULE_GAP)) {
    drafts.push({
      kind: "module",
      ctx,
      symbol: null,
      symbolKind: null,
      lines: [from, to],
      window: [Math.max(1, from - MODULE_CONTEXT), Math.min(ctx.lines.length, to + MODULE_CONTEXT)],
      part: null,
      obligations: [],
      truncated: false,
      reasons: [],
      weight: loose.filter((l) => l >= from && l <= to).length,
    });
  }
  return drafts;
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

/** Hunk strings (`path:a-b`) → does any overlap the draft's extent? */
function overlapsHunks(draft: Draft, hunks: string[]): boolean {
  if (!draft.lines || !draft.ctx) return false;
  return hunks.some((h) => {
    const m = /^(.*):(\d+)-(\d+)$/.exec(h);
    return !!m && m[1] === draft.ctx!.path && Number(m[2]) <= draft.lines![1] && Number(m[3]) >= draft.lines![0];
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
    const inFile = drafts.filter((d) => d.ctx?.path === anchor.path && contains(d.lines, anchor.line));
    const hit = inFile.find((d) => d.kind === "symbol") ?? inFile[0];
    if (hit) return hit;
  }
  if (symbol) {
    const hit = drafts.find((d) => overlapsHunks(d, symbol!.changedHunks));
    if (hit) return hit;
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
  callers: { at: string; inSymbol: string | null; inDiff: boolean; isTest: boolean }[];
  callees: ShownCallee[];
}

/** Callers and callees of every facts symbol DECLARED inside the draft's extent. */
function neighboursOf(draft: Draft, symbols: SymbolFact[], allFunctions: Map<string, FunctionLike[]>): Neighbours {
  if (!draft.ctx || !draft.lines) return { callers: [], callees: [] };
  const path = draft.ctx.path;
  const window = draft.window ?? draft.lines;
  const mine = symbols.filter((s) => {
    const site = splitSite(s.declaredAt);
    return site !== null && site.path === path && contains(draft.lines, site.line);
  });
  const seen = new Set<string>();
  const callers: Neighbours["callers"] = [];
  for (const s of mine) {
    for (const r of s.references) {
      if (seen.has(r.at)) continue;
      const site = splitSite(r.at);
      if (site && site.path === path && contains(window, site.line)) continue;
      seen.add(r.at);
      callers.push(r);
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
  if (ctx && draft.window) {
    source = [shownLines(ctx, draft.window[0], draft.window[1])];
    const outside = ctx.imports.filter((l) => !contains(draft.window, l));
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

  const callers: ShownCaller[] = neighbours.callers
    .slice(0, neighbourCap)
    .map((c) => ({ ...c, text: head.lineAt(c.at) }));
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
    source,
    imports,
    importsOmitted,
    callers,
    callersOmitted: neighbours.callers.length - callers.length,
    callees,
    calleesOmitted: neighbours.callees.length - callees.length,
    obligations: draft.obligations.map((o) => obligationView(o, head, level)),
    overview: input.overview,
    asked: askedFor(draft.obligations),
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
 * Split a draft whose source alone overruns the budget into overlapping
 * passes. Only passes holding a touched line survive; each obligation goes to
 * the pass holding its anchor (else the first), so every id is still asked
 * exactly once.
 */
function splitDraft(draft: Draft, input: Omit<RenderInput, "level" | "draft">, budget: number): Draft[] {
  const ctx = draft.ctx!;
  const [from, to] = draft.window!;
  const shell = render({ ...input, draft: { ...draft, window: [from, from] }, level: 2 }).length;
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
  const passes: Draft[] = kept.map(([a, b]) => ({
    ...draft,
    lines: [Math.max(a, draft.lines![0]), Math.min(b, draft.lines![1])] as [number, number],
    window: [a, b] as [number, number],
    obligations: [],
    reasons: [...draft.reasons],
    truncated: true,
    weight: [...touched].filter((l) => l >= a && l <= b).length,
  }));
  if (passes.length === 0) return [draft];
  for (const o of draft.obligations) {
    const home = passes.find((p) => contains(p.window, anchorLine(o))) ?? passes[0]!;
    home.obligations.push(o);
  }
  passes.forEach((p, i) => {
    p.part = { index: i + 1, of: passes.length };
  });
  return passes;
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

const SPEC_GAP =
  "spec obligations are built harness-side (apps/server review-spec.ts) from the PR body and linked issues and are never written to the workspace, so no unit carries one — the spec family is asked only its falsifiable-documentation half";

/** A document that says nothing was surveyed and why. Validates like any other. */
export function emptyUnitsDocument(reason: string, shas: { baseSha?: string; headSha?: string } = {}): UnitsDocument {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    baseSha: shas.baseSha ?? "unknown",
    headSha: shas.headSha ?? "unknown",
    promptVersion: UNITS_PROMPT_VERSION,
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
  note(SPEC_GAP);

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
    if (fns === null && astGrepLangFor(path)) {
      note(`${path} did not parse — its changed lines are surveyed as module regions, with no symbol unit`);
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
  for (const d of drafts) neighboursByDraft.set(d, neighboursOf(d, symbols, allFunctions));

  // Placeholder id of the final width, so a size decision made now holds later.
  const PLACEHOLDER = "u-000";
  const finalDrafts: Draft[] = [];
  for (const d of drafts) {
    const base = { unitId: PLACEHOLDER, neighbours: neighboursByDraft.get(d)!, head, overview: [] as string[] };
    const fit = fitLevel({ ...base, draft: d }, budget);
    if (fit.fits) {
      finalDrafts.push(d);
      continue;
    }
    const passes = splitDraft(d, base, budget);
    for (const p of passes) {
      neighboursByDraft.set(p, base.neighbours);
      finalDrafts.push(p);
    }
    if (passes.length > 1) {
      note(
        `${d.ctx!.path}:${d.lines![0]}-${d.lines![1]} (${d.symbol ?? "module region"}) is too long for one request of ${budget} chars — split into ${passes.length} overlapping passes`,
      );
    }
  }

  finalDrafts.sort(
    (a, b) => a.ctx!.path.localeCompare(b.ctx!.path) || a.lines![0] - b.lines![0] || a.lines![1] - b.lines![1],
  );

  const prDraft: Draft | null =
    unattributed.length > 0
      ? {
          kind: "pr",
          ctx: null,
          symbol: null,
          symbolKind: null,
          lines: null,
          window: null,
          part: null,
          obligations: [...unattributed].sort((a, b) => a.id.localeCompare(b.id)),
          truncated: false,
          reasons: [],
          weight: 0,
        }
      : null;
  const all = prDraft ? [...finalDrafts, prDraft] : finalDrafts;
  const width = Math.max(3, String(all.length).length);
  const ids = all.map((_, i) => `u-${String(i + 1).padStart(width, "0")}`);

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
    lines.push(`spec obligations: none reach this unit — ${SPEC_GAP}`);
    return lines;
  };

  const units: Unit[] = all.map((d, i) => {
    const id = ids[i]!;
    const neighbours = neighboursByDraft.get(d) ?? { callers: [], callees: [] };
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
    const families = [...new Set(d.obligations.map((o) => o.family))].sort();
    return {
      id,
      kind: d.kind,
      file: d.ctx?.path ?? null,
      symbol: d.symbol,
      lines: d.lines,
      language: d.ctx?.language ?? null,
      families,
      obligationIds: d.obligations.map((o) => o.id),
      request,
      requestSha256: sha256(request),
      truncated,
    };
  });

  if (units.length === 0) {
    note(
      changed.length === 0
        ? "nothing to survey: the range changed no file"
        : `nothing to survey: ${changed.length} changed file(s), none with a head line to show (${deleted.length} deleted, ${skipped.length} skipped)`,
    );
  }

  const document: UnitsDocument = UnitsDocumentSchema.parse({
    version: 1,
    generatedAt: new Date().toISOString(),
    baseSha,
    headSha,
    promptVersion: UNITS_PROMPT_VERSION,
    coverage: units.length === 0 ? "none" : degraded.length > 0 ? "degraded" : "full",
    degraded,
    responseSchema: unitResponseJsonSchema(),
    skipped,
    units,
  });

  log.info("assembled units", {
    units: units.length,
    obligations: obligations.length,
    unattributed: unattributed.length,
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
