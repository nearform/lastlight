/**
 * The syntactic engine — ONE PASS, three maps, no types.
 *
 * ```
 * declarations : name  → every site in the repo that BINDS that name
 * references   : name  → every site in the repo that MENTIONS it
 * literals     : value → every site that spells that value out
 * ```
 *
 * **Everything here is a name match, and the whole file is written around
 * saying so.** `run` in one file and `run` in another are the same string; a
 * parser without a type-checker cannot tell you they are the same symbol, and
 * nothing in this module pretends otherwise. Every `SymbolFact` it produces
 * carries `resolution: "name-match"` beside `nameAmbiguity` — how many distinct
 * declaration sites in the repo bind that same name — so the layer above can
 * RANK on the ambiguity instead of inheriting the guess.
 *
 * `nameAmbiguity` is data, never a filter. This layer generates hypotheses; a
 * filter here would silently delete the evidence the seeder is supposed to
 * weigh, and the corpus measurement that motivated the whole exercise
 * ("coverage x2.00 while the candidate pool went x2.09") is precisely a warning
 * about a pool that grows without the hits growing with it. The counter to that
 * is a rankable pool, not a smaller one.
 *
 * ## Why one pass
 *
 * `constants` already walks the whole repository to build set B (every
 * occurrence of a literal value). Folding the declaration and reference indexes
 * into that same walk makes them close to free: the same `git ls-tree` listing,
 * the same `git cat-file --batch` blob reads, the same parse. The alternative —
 * a second enumeration — would have doubled the one part of this package that
 * has ever dominated its wall clock.
 *
 * The file set comes from `git.listFiles`, so `.gitignore` is honoured by
 * construction and the scan resolves against a COMMIT rather than the working
 * directory (CLAUDE.md, "THE FILE SET COMES FROM GIT"). Every `path:line` this
 * module emits is therefore a claim about `headSha`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "@ast-grep/napi";
import { listFiles, readListedFiles, showFile, type ListingSource } from "./git.js";
import type { ChangedPath, FileHunks } from "./git.js";
import { isIgnoredPath, looksMinified, MAX_SCANNED_FILE_BYTES } from "./project.js";

/**
 * The ceiling on how many FILES a repository-wide scan will read — set B's
 * literal sweep (`constants`) and this module's name index.
 *
 * It used to be `project.ts`'s `DEFAULT_MAX_FILES`, where it doubled as the
 * ts-morph program budget. It is here now under a name that says which
 * population it bounds, because the two were never the same number: the program
 * budget bounded a compiler's heap and died with it
 * (`docs/plans/fact-engine/02-migration.md`), while this one bounds blob reads
 * and ast-grep parses, which the new engine does not touch at all.
 *
 * It is still exposed as `--max-files` and it is still the thing that makes an
 * absence claim UNSOUND when it bites, which is why hitting it is a
 * `degraded[]` entry naming the ceiling, the eligible count and the read count
 * rather than a silent prefix.
 */
export const DEFAULT_MAX_SCANNED_FILES = 6000;
import {
  asSyntaxNode,
  interestingKinds,
  literalKindOf,
  supportedKinds,
} from "./langs/descriptor.js";
import type { LanguageDescriptor, SyntaxNode } from "./langs/descriptor.js";
import { descriptorForPath } from "./langs/register.js";
import type { DegradedEntry, FactsPayload, SymbolFact } from "./schema.js";
import { indexHunks, type ChangedFileIndex } from "./facts.js";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";

export type ValueKind = "string" | "number" | "boolean";

/** A site that BINDS a name. */
export interface DeclSite {
  /**
   * The name a document shows — qualified where the descriptor asks for it, so
   * a changed method reads `Service.run` rather than a bare `run` nobody can
   * look up.
   */
  name: string;
  /** The bare declared name. **This is the key everything matches on.** */
  localName: string;
  path: string;
  /** 1-based line of the NAME node — the `declaredAt` convention. */
  line: number;
  /** The declaration's whole range, 1-based inclusive. Hunk overlap uses it. */
  startLine: number;
  endLine: number;
  /** `function`, `class`, `method`, … — the same vocabulary tier 1 emits. */
  kind: string;
  exported: boolean;
  /** Present when this declaration binds a LITERAL — what `constants` wants. */
  literal: { value: string; kind: ValueKind } | null;
  /**
   * The initialiser's raw text, when this declaration matched a `ConstantRule`
   * at all — capped, because an initialiser can be a whole object literal and
   * this is only ever read by a regex.
   *
   * It ships beside `literal` because the two answer slightly different
   * questions: `literal` is "the grammar says this node IS a literal", and
   * `valueText` lets `constants` keep applying `literalOf`, which additionally
   * accepts the shapes the grammar spells as something else — `-5` is a
   * `unary_expression`, not a `number`. Dropping to the grammar's answer alone
   * would have quietly narrowed a shipped extractor's output.
   */
  valueText: string | null;
  /** Callee texts inside the declaration. Empty unless `callees` was asked for. */
  callees: string[];
}

/** A site that MENTIONS a name. */
export interface RefSite {
  path: string;
  line: number;
  /** The nearest enclosing named declaration — "who mentions it". */
  inSymbol: string | null;
  isTest: boolean;
}

export interface LitSite {
  path: string;
  line: number;
}

/**
 * The nearest-enclosing-declaration kinds `inSymbol` reports, chosen to match
 * tier 1's `enclosingSymbol` exactly (`FunctionDeclaration`,
 * `MethodDeclaration`, `ClassDeclaration`, `InterfaceDeclaration`,
 * `VariableDeclaration`). A field that means something slightly different
 * depending on the tier is a field a consumer has to special-case.
 */
const ENCLOSING_KINDS = new Set(["function", "method", "class", "interface", "variable"]);

// ── the per-file scan ────────────────────────────────────────────────────────

export interface ScanSink {
  declaration?(site: DeclSite): void;
  reference?(name: string, site: RefSite): void;
  literal?(value: string, kind: ValueKind, site: LitSite): void;
  /** True when this name's sites are wanted. Absent = every name is wanted. */
  wantsName?(name: string): boolean;
  /** True when this value's sites are wanted. Absent = no literals are wanted. */
  wantsValue?(value: string): boolean;
  /** Collect `callees` on kept declarations. Off by default — it is not free. */
  callees?: boolean;
}

interface OpenDeclaration {
  rule: { kind: string; symbolKind: string; qualifyBy?: string[] };
  site: DeclSite;
  /** Byte offset the declaration ends at — how the stack is popped. */
  endIndex: number;
  keep: boolean;
}

/**
 * Parse one file and hand every interesting node to `sink`, in ONE traversal.
 *
 * `findAll` with a single `any:` rule returns the matching nodes in document
 * (pre-order) order, which is what makes the enclosing-declaration STACK
 * possible: a declaration is always seen before anything inside it, so the
 * scope a reference sits in is known without ever walking back up the tree. A
 * `parent()` walk per identifier would be the obvious alternative and it is
 * quadratic in nesting depth.
 *
 * Returns false when the parser refused the file — the caller's cue to count it
 * rather than to be silent about it.
 */
export function scanSource(
  descriptor: LanguageDescriptor,
  path: string,
  source: string,
  sink: ScanSink,
): boolean {
  const declarationRules = new Map(descriptor.declarations.map((rule) => [rule.kind, rule]));
  const constantRules = new Map(descriptor.constantDeclarations.map((rule) => [rule.kind, rule]));
  const referenceKinds = new Set(descriptor.referenceKinds);
  const isTest = descriptor.isTestPath(path);

  let root;
  try {
    root = asSyntaxNode(parse(descriptor.astGrepLang, source).root());
  } catch {
    return false;
  }

  // Exactly the kinds THIS sink can use. `constants`' literal-only sweep must
  // ask for the same four node kinds it always did — see `interestingKinds`.
  const asked = interestingKinds(descriptor, {
    declarations: sink.declaration !== undefined,
    references: sink.reference !== undefined,
    literals: sink.literal !== undefined,
    calls: sink.callees === true,
  });
  // Only the kinds this grammar HAS. ast-grep refuses a whole rule that names
  // an unknown kind rather than ignoring it, so a rule table shared between the
  // TS and JS grammars threw on every `.js` file and the scan quietly recorded
  // nothing — see `supportedKinds`.
  const kinds = supportedKinds(descriptor, asked).kinds;
  if (kinds.length === 0) return false;
  let matches: SyntaxNode[];
  try {
    matches = (
      root as unknown as { findAll(rule: unknown): unknown[] }
    )
      .findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })
      .map((node) => node as SyntaxNode);
  } catch {
    return false;
  }

  const stack: OpenDeclaration[] = [];
  /** Byte offsets of declaration NAME nodes — never counted as references. */
  const nameNodeOffsets = new Set<number>();

  for (const node of matches) {
    const range = node.range();
    const start = range.start.index;
    while (stack.length > 0 && stack[stack.length - 1].endIndex <= start) stack.pop();

    const kind = node.kind();
    const declarationRule = declarationRules.get(kind);
    if (declarationRule) {
      const nameNode = node.field(declarationRule.nameField);
      if (!nameNode) continue;
      // A destructuring pattern binds no single name (`{ a, b }`), and a local
      // inside another declaration is not a symbol anybody reviews. Both are
      // skipped BEFORE the name node is excluded from the reference stream, so
      // `const { a } = obj` still contributes `a`… as a reference, which is
      // what it is.
      if (declarationRule.nameKinds && !declarationRule.nameKinds.includes(nameNode.kind())) {
        continue;
      }
      if (declarationRule.topLevelOnly && stack.length > 0) continue;
      const localName = nameNode.text();
      nameNodeOffsets.add(nameNode.range().start.index);

      // Qualification comes off the stack, not off a parent walk: the enclosing
      // class was pushed before this method was reached.
      let qualified = localName;
      if (declarationRule.qualifyBy) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (declarationRule.qualifyBy.includes(stack[i].rule.kind)) {
            qualified = `${stack[i].site.localName}.${localName}`;
            break;
          }
        }
      }

      const constantRule = constantRules.get(kind);
      let literal: { value: string; kind: ValueKind } | null = null;
      let valueText: string | null = null;
      if (constantRule && isImmutableBinding(node, constantRule)) {
        const valueNode = node.field(constantRule.valueField);
        if (valueNode) {
          const text = valueNode.text();
          if (text.length <= MAX_VALUE_TEXT) valueText = text;
          const valueKind = literalKindOf(descriptor, valueNode.kind());
          if (valueKind) literal = { value: unquote(text), kind: valueKind };
        }
      }

      const keep = sink.wantsName?.(localName) ?? true;
      const site: DeclSite = {
        name: qualified,
        localName,
        path,
        line: nameNode.range().start.line + 1,
        startLine: range.start.line + 1,
        endLine: range.end.line + 1,
        kind: declarationRule.symbolKind,
        exported: descriptor.isExported(localName, node),
        literal,
        valueText,
        callees: [],
      };
      stack.push({ rule: declarationRule, site, endIndex: range.end.index, keep });
      if (keep) sink.declaration?.(site);
      continue;
    }

    if (sink.callees && kind === descriptor.callKind) {
      const callee = node.field("function")?.text();
      // `a.b.c(...)` → `a.b.c`; anything with a newline or a paren is a computed
      // callee and naming it would be noise. Identical to tier 1's filter.
      if (callee && callee.length <= 80 && !/[\n()]/.test(callee)) {
        for (const open of stack) {
          if (open.keep && !open.site.callees.includes(callee)) open.site.callees.push(callee);
        }
      }
      continue;
    }

    if (referenceKinds.has(kind)) {
      // A declaration's own name node is not a reference to it. This is the
      // only exclusion the INDEX applies; the "inside its own declaration"
      // exclusion is applied at assembly, where it can match tier 1's exactly.
      if (nameNodeOffsets.delete(start)) continue;
      if (!sink.reference) continue;
      const name = node.text();
      if (sink.wantsName && !sink.wantsName(name)) continue;
      let inSymbol: string | null = null;
      for (let i = stack.length - 1; i >= 0; i--) {
        if (ENCLOSING_KINDS.has(stack[i].site.kind)) {
          inSymbol = stack[i].site.localName;
          break;
        }
      }
      sink.reference(name, { path, line: range.start.line + 1, inSymbol, isTest: isTest });
      continue;
    }

    if (!sink.literal || !sink.wantsValue) continue;
    if (literalKindOf(descriptor, kind) === null) continue;
    const value = unquote(node.text());
    if (!sink.wantsValue(value)) continue;
    sink.literal(value, literalKindOf(descriptor, kind) as ValueKind, {
      path,
      line: range.start.line + 1,
    });
  }
  return true;
}

/** An initialiser longer than this is not a literal — see `DeclSite.valueText`. */
const MAX_VALUE_TEXT = 256;

/**
 * Does the syntax around this binding make it immutable?
 *
 * `const` in TS/JS lives on the PARENT `lexical_declaration` — under `let` the
 * declarator node is byte-identical — so the keyword is the only signal and it
 * is not on the node that carries the name.
 */
function isImmutableBinding(
  node: SyntaxNode,
  rule: { enclosingKind: string | null; enclosingTextRe: RegExp | null },
): boolean {
  if (rule.enclosingKind === null) return true;
  const parent = node.parent();
  if (parent === null || parent.kind() !== rule.enclosingKind) return false;
  return rule.enclosingTextRe === null || rule.enclosingTextRe.test(parent.text());
}

/** `"hello"` / `'hello'` / `` `hello` `` → `hello`. Numbers pass through. */
export function unquote(text: string): string {
  const first = text[0];
  if ((first === '"' || first === "'" || first === "`") && text.at(-1) === first) {
    return text.slice(1, -1);
  }
  return text;
}

// ── module specifiers, without a program ─────────────────────────────────────

/**
 * The node kinds that can carry a module specifier.
 *
 * `import_require_clause` (`import x = require("y")`) is TypeScript-only and
 * `supportedKinds` drops it for the JavaScript grammar — the same mechanism
 * that stops `type_identifier` throwing the whole rule out on a `.js` file.
 *
 * **A CONSTANT rather than a `LanguageDescriptor` row, deliberately.** Every
 * other kind table in this engine lives on the descriptor because a second
 * language would need a different one; this list does not, because the thing it
 * feeds is TS-ONLY BY CONSTRUCTION. Its consumer is `resolution.ts`, which
 * bounds the closure a `ts.Program` follows — and a tier-2 or tier-3 language
 * never builds one (`deps`/`patterns`/`coverage` load no project at all, which
 * is the 160 MB floor in CLAUDE.md's table). There is no Go or Java memory to
 * bound here, so a `importKinds` / `importSourceField` pair on the descriptor
 * would be a surface with no second implementor — exactly what `register.ts`
 * argues against. Promote it to a descriptor row on the day a non-TS engine
 * that resolves types actually exists; it is a three-line table addition then,
 * and dead weight until.
 */
const SPECIFIER_KINDS = [
  "import_statement",
  "export_statement",
  "call_expression",
  "import_require_clause",
];

/**
 * Every MODULE SPECIFIER this source names, from the syntax alone.
 *
 * The point of doing it here rather than off a `ts.SourceFile` is ORDERING: an
 * allow-list that decides what the checker may resolve has to exist **before**
 * the program does, and building a program to find out what the program should
 * be allowed to load is the same circularity `globCandidates` exists to avoid
 * on the file-count axis (CLAUDE.md, "every group's size is known BEFORE
 * anything is parsed").
 *
 * Returns `null` when no registered language claims the path or the parser
 * refused it — the caller's cue to widen rather than to be silent, because an
 * under-read import list is an allow-list that is missing an entry, and a
 * missing entry is a type that silently becomes `any`.
 *
 * What it sees: `import … from "x"`, a bare `import "x"`, `export … from "x"`,
 * `import("x")`, `require("x")` and `import x = require("x")`. What it does not:
 * a computed specifier (`import(`./${name}`)`), which no static resolver can
 * follow either.
 */
export function scanImportSpecifiers(path: string, source: string): string[] | null {
  const descriptor = descriptorForPath(path);
  if (descriptor === null) return null;

  let root: SyntaxNode;
  try {
    root = asSyntaxNode(parse(descriptor.astGrepLang, source).root());
  } catch {
    return null;
  }

  const kinds = supportedKinds(descriptor, SPECIFIER_KINDS).kinds;
  if (kinds.length === 0) return null;
  let matches: SyntaxNode[];
  try {
    matches = (root as unknown as { findAll(rule: unknown): unknown[] })
      .findAll({ rule: { any: kinds.map((kind) => ({ kind })) } })
      .map((node) => node as SyntaxNode);
  } catch {
    return null;
  }

  const stringKinds = new Set(descriptor.literalKinds.string);
  const out: string[] = [];
  const take = (node: SyntaxNode | null): void => {
    if (node === null || !stringKinds.has(node.kind())) return;
    const value = unquote(node.text());
    if (value.length > 0) out.push(value);
  };

  for (const node of matches) {
    const kind = node.kind();
    if (kind === "call_expression") {
      // `require("x")` and `import("x")`. The callee text is `import` for a
      // dynamic import even though the node is a call.
      const callee = node.field("function")?.text();
      if (callee !== "require" && callee !== "import") continue;
      const args = node.field("arguments");
      if (args) for (const child of args.children()) take(child);
      continue;
    }
    // `import`/`export`/`import_require_clause` all name it `source`.
    take(node.field("source"));
  }
  return out;
}

// ── the repo-wide index ──────────────────────────────────────────────────────

/**
 * The path filter for the syntactic engine: a path some registered language
 * claims, that the residual denylist does not reject.
 *
 * Deliberately expressed through `descriptorForPath` rather than through the
 * hard-coded TS/JS extension list — it is the same nine extensions today, and
 * it is the seam a new grammar arrives at.
 */
export function isIndexablePath(path: string): boolean {
  if (path.endsWith("/")) return !isIgnoredPath(path);
  return descriptorForPath(path) !== null && !isIgnoredPath(path);
}

export interface SyntacticIndex {
  /** name → every declaration site. `size` of a bucket IS `nameAmbiguity`. */
  declarations: Map<string, DeclSite[]>;
  /** name → mention sites, capped per name (see `maxSitesPerName`). */
  references: Map<string, RefSite[]>;
  /** name → the EXACT mention count, uncapped. */
  referenceCounts: Map<string, number>;
  /** value → literal occurrence sites. Set B, when values were asked for. */
  literals: Map<string, LitSite[]>;
  /** Names whose site list hit `maxSitesPerName`. Counts stay exact. */
  truncatedNames: Set<string>;
  /** True when the file LISTING hit `maxFiles` — the index covers a prefix. */
  truncated: boolean;
  filesEligible: number;
  filesScanned: number;
  filesSkipped: number;
  filesUnread: number;
  /** Files a parser refused. A hole, and never silent. */
  filesUnparsed: number;
  source: ListingSource;
  sourceReason: string | null;
  /** Files scanned per language id — the per-language census. */
  byLanguage: Map<string, number>;
  /**
   * Every path the scan actually parsed, or `null` when nobody asked.
   *
   * Off by default because it is a set of every source path in the repository
   * and nothing in the pipeline reads it. `scripts/name-match-gate.ts` does:
   * comparing a name-matched reference set against a type-resolved one is only
   * a like-for-like comparison over the files BOTH engines could see, and this
   * is one half of that intersection.
   */
  scannedPaths: Set<string> | null;
}

export interface BuildIndexOptions {
  repo: string;
  /**
   * The commit the index resolves against — the same `headSha` the envelope
   * stamps. `null` lists the working tree instead, and says so through
   * `source`.
   */
  ref: string | null;
  /**
   * Which names to index declarations and references for.
   *
   * **Absent means DO NOT INDEX NAMES AT ALL** — that is the `constants` case,
   * which wants only the literal sweep and must keep costing what it always
   * cost. `"all"` is every identifier in the repository: usable in a test,
   * never in a phase. The pipeline passes the names the diff declares.
   *
   * Spelled as a three-way rather than as "absent = all" because that is the
   * shape a caller gets wrong silently: `constants` passing only `values` would
   * have quietly indexed every identifier in the repository.
   */
  names?: Set<string> | "all";
  /** Only index these literal values. Absent = no literal sweep at all. */
  values?: Map<string, ValueKind>;
  maxFiles?: number;
  /** Per-name site ceiling. `0` = unbounded. Counts stay exact either way. */
  maxSitesPerName?: number;
  /** Populate `scannedPaths`. Measurement only — see the field. */
  recordScannedPaths?: boolean;
  log?: LoggerPort;
}

/**
 * How many sites one name may keep.
 *
 * A common short name (`id`, `run`, `get`) has tens of thousands of occurrences
 * on a repository the size of sentry, and a `SymbolFact` records at most
 * `maxReferences` of them anyway. The COUNT is what `referencesInDiff` vs
 * `referenceCount` is read from and it stays exact; this bounds the array.
 */
export const DEFAULT_MAX_SITES_PER_NAME = 2000;

/**
 * ONE pass over the enumerated file set.
 *
 * Everything expensive happens exactly once: one `git ls-tree`, one
 * `git cat-file --batch` stream, one parse per file, one traversal per parse.
 * `constants` used to do the listing and the parse for set B alone; the
 * declaration and reference indexes now ride along on it.
 */
export function buildSyntacticIndex(options: BuildIndexOptions): SyntacticIndex {
  const log = options.log ?? noopLogger;
  const maxSites = options.maxSitesPerName ?? DEFAULT_MAX_SITES_PER_NAME;
  const declarations = new Map<string, DeclSite[]>();
  const references = new Map<string, RefSite[]>();
  const referenceCounts = new Map<string, number>();
  const literals = new Map<string, LitSite[]>();
  const truncatedNames = new Set<string>();
  const byLanguage = new Map<string, number>();
  const scannedPaths = options.recordScannedPaths === true ? new Set<string>() : null;
  // Pre-seeded, so "the scan ran and this value occurs nowhere" is an empty
  // array rather than a missing key — the founding distinction of this package.
  for (const value of options.values?.keys() ?? []) literals.set(value, []);

  const names = options.names;
  const indexNames = names !== undefined;
  const wantsName =
    names instanceof Set ? (name: string) => names.has(name) : undefined;
  const wantsValue = options.values ? (value: string) => options.values!.has(value) : undefined;

  const empty: SyntacticIndex = {
    declarations,
    references,
    referenceCounts,
    literals,
    truncatedNames,
    truncated: false,
    filesEligible: 0,
    filesScanned: 0,
    filesSkipped: 0,
    filesUnread: 0,
    filesUnparsed: 0,
    source: "tree",
    sourceReason: null,
    byLanguage,
    scannedPaths,
  };
  // Nothing to look for: no listing, no subprocess, no parse. `constants` on a
  // diff with no changed constants is the common case and it must cost nothing.
  const wantsAnyName = names === "all" || (names instanceof Set && names.size > 0);
  const wantsAnyValue = (options.values?.size ?? 0) > 0;
  if (!wantsAnyName && !wantsAnyValue) return empty;

  const listing = listFiles({
    dir: options.repo,
    ref: options.ref,
    accept: isIndexablePath,
    // `git ls-tree -l` hands us the size, so a 4 MB bundle is rejected without
    // being read at all — let alone charged against a slot real source needs.
    maxBytes: MAX_SCANNED_FILE_BYTES,
    limit: options.maxFiles ?? DEFAULT_MAX_SCANNED_FILES,
  });

  const wantedValues = [...(options.values?.keys() ?? [])];
  let scanned = 0;
  let skipped = listing.rejected;
  let unparsed = 0;

  // The handlers a caller did NOT ask for are ABSENT, not empty: `scanSource`
  // reads the sink to decide which node kinds to ask the parser for, so an
  // empty function here would cost `constants` an object per identifier in the
  // repository for a callback that drops all of them.
  const sink: ScanSink = { wantsName, wantsValue };
  if (indexNames) {
    sink.declaration = (site) => {
      const bucket = declarations.get(site.localName);
      if (bucket) bucket.push(site);
      else declarations.set(site.localName, [site]);
    };
    sink.reference = (name, site) => {
      referenceCounts.set(name, (referenceCounts.get(name) ?? 0) + 1);
      const bucket = references.get(name);
      if (!bucket) {
        references.set(name, [site]);
        return;
      }
      if (maxSites > 0 && bucket.length >= maxSites) {
        truncatedNames.add(name);
        return;
      }
      bucket.push(site);
    };
  }
  if (wantsAnyValue) {
    sink.literal = (value, _kind, site) => {
      const bucket = literals.get(value);
      if (bucket) bucket.push(site);
    };
  }

  const unread = readListedFiles(options.repo, listing.files, (file, source) => {
    const descriptor = descriptorForPath(file.path);
    if (!descriptor) return;
    // The other half of the bundle filter: a transpiled file under a path the
    // denylist does not name still contributes every literal in a whole
    // application, at line numbers a reviewer cannot use.
    if (looksMinified(source)) {
      skipped++;
      return;
    }
    scanned++;
    byLanguage.set(descriptor.id, (byLanguage.get(descriptor.id) ?? 0) + 1);
    scannedPaths?.add(file.path);
    // The substring pre-filter, and it only applies when literals are the ONLY
    // thing being looked for: a name index has to parse the file either way, so
    // there is nothing to skip.
    if (!indexNames && wantedValues.length > 0 && !wantedValues.some((v) => source.includes(v))) {
      return;
    }
    if (!scanSource(descriptor, file.path, source, sink)) unparsed++;
  });

  log.debug("code-facts syntactic index built", {
    ref: options.ref,
    filesScanned: scanned,
    filesEligible: listing.total,
    names: names instanceof Set ? names.size : (names ?? null),
    values: options.values?.size ?? 0,
    declarations: declarations.size,
    references: references.size,
  });

  return {
    declarations,
    references,
    referenceCounts,
    literals,
    truncatedNames,
    truncated: listing.truncated,
    filesEligible: listing.total,
    filesScanned: scanned,
    filesSkipped: skipped,
    filesUnread: unread,
    filesUnparsed: unparsed,
    source: listing.source,
    sourceReason: listing.reason,
    byLanguage,
    scannedPaths,
  };
}

/** `nameAmbiguity` — distinct declaration sites in the repo binding this name. */
export function nameAmbiguityOf(index: SyntacticIndex, name: string): number {
  return index.declarations.get(name)?.length ?? 0;
}

// ── the changed files ────────────────────────────────────────────────────────

export interface ScanChangedOptions {
  repo: string;
  /** Read the changed files at this commit. `null` reads the working tree. */
  headSha: string | null;
  paths: string[];
  callees?: boolean;
}

export interface ChangedScan {
  declarations: DeclSite[];
  /** Paths a parser produced a tree for — `languages[].parsedFiles`, tier 2. */
  parsed: string[];
}

/**
 * Parse the changed files only.
 *
 * Read at `headSha` through `git show` rather than off disk, so a declaration's
 * `path:line` is a claim about the analysed commit — the same guarantee the
 * repo-wide index gets from `ls-tree` (CLAUDE.md records that `facts` and
 * `contracts` still read HEAD off the filesystem; this path does not).
 * Falls back to the filesystem when the blob is not there, which is what a
 * caller outside a git repository gets.
 */
export function scanChangedFiles(options: ScanChangedOptions): ChangedScan {
  const declarations: DeclSite[] = [];
  const parsed: string[] = [];
  for (const path of options.paths) {
    const descriptor = descriptorForPath(path);
    if (!descriptor) continue;
    let source: string | null = options.headSha
      ? showFile(options.repo, options.headSha, path)
      : null;
    if (source === null) {
      try {
        source = readFileSync(join(options.repo, path), "utf8");
      } catch {
        continue;
      }
    }
    if (looksMinified(source)) continue;
    const ok = scanSource(descriptor, path, source, {
      callees: options.callees ?? false,
      declaration: (site) => declarations.push(site),
    });
    if (ok) parsed.push(path);
  }
  return { declarations, parsed };
}

// ── `facts`, by name ─────────────────────────────────────────────────────────

export interface ExtractFactsByNameOptions {
  repo: string;
  /** The commit the whole index resolves against. */
  headSha: string | null;
  hunks: FileHunks[];
  changed: ChangedPath[];
  maxFiles?: number;
  /** Cap on reference sites recorded per symbol. `0` = unbounded. */
  maxReferences?: number;
  /** Per-name ceiling inside the index. `0` = unbounded. */
  maxSitesPerName?: number;
  log?: LoggerPort;
}

export interface ExtractFactsByNameResult {
  payload: FactsPayload;
  degraded: DegradedEntry[];
  index: SyntacticIndex;
}

export const DEFAULT_MAX_REFERENCES = 200;

/**
 * The tier-2 impact cone: the same document shape tier 1 emits, built without a
 * compiler, and LABELLED.
 *
 * Two passes, and only the second one is expensive:
 *
 *   1. the changed files, to learn which names the diff declares;
 *   2. the repository, for every mention of those names and every other
 *      declaration site that binds them (`nameAmbiguity`).
 *
 * Every symbol carries `resolution: "name-match"`. A consumer that treats these
 * references as tier 1's is over-trusting them by exactly the amount
 * `nameAmbiguity` measures.
 */
export function extractFactsByName(
  options: ExtractFactsByNameOptions,
): ExtractFactsByNameResult {
  const maxReferences = options.maxReferences ?? DEFAULT_MAX_REFERENCES;
  const hunkIndex = indexHunks(options.hunks);
  const degraded: DegradedEntry[] = [];

  const live = options.changed.filter((change) => change.status !== "deleted");
  const changedScan = scanChangedFiles({
    repo: options.repo,
    headSha: options.headSha,
    paths: live.map((change) => change.path),
    callees: true,
  });

  // Only the declarations the diff actually TOUCHED get an obligation — the
  // same rule tier 1 applies through `hunksTouching`.
  const touched = changedScan.declarations.filter((site) => {
    const entry = hunkIndex.get(site.path);
    return entry !== undefined && hunksTouching(entry, site.startLine, site.endLine).length > 0;
  });

  const names = new Set(touched.map((site) => site.localName));
  const index = buildSyntacticIndex({
    repo: options.repo,
    ref: options.headSha,
    names,
    maxFiles: options.maxFiles,
    maxSitesPerName: options.maxSitesPerName,
    log: options.log,
  });

  if (index.source === "walk") {
    degraded.push({
      extractor: "facts",
      reason: `${index.sourceReason ?? "the file set came from a directory walk"} — the name-matched reference set from this run is walk-tier evidence`,
    });
  }
  if (index.truncated) {
    degraded.push({
      extractor: "facts",
      reason: `the name index stopped at the ${options.maxFiles ?? DEFAULT_MAX_SCANNED_FILES}-file ceiling (--max-files): ${index.filesEligible} file(s) were eligible and ${index.filesScanned} were read, so every referenceCount below is a LOWER BOUND over a prefix of the repository`,
    });
  }
  if (index.filesUnread + index.filesUnparsed > 0) {
    degraded.push({
      extractor: "facts",
      reason: `${index.filesUnread} listed file(s) could not be read and ${index.filesUnparsed} could not be parsed, so the reference index has holes in it — a name mentioned only in one of them is reported as mentioned nowhere`,
    });
  }

  const changedLineLookup = (path: string, line: number): boolean =>
    hunkIndex.get(path)?.changedLines.has(line) ?? false;

  const files: FactsPayload["files"] = [];
  const parsed = new Set(changedScan.parsed);
  for (const change of options.changed) {
    const entry = hunkIndex.get(change.path);
    files.push({
      path: change.path,
      status: change.status,
      hunks: entry?.hunks ?? [],
      changedLines: [...(entry?.changedLines ?? [])].sort((a, b) => a - b),
      analysed: parsed.has(change.path),
    });
  }

  const symbols: SymbolFact[] = [];
  for (const site of touched) {
    const entry = hunkIndex.get(site.path);
    if (!entry) continue;
    const sites = index.references.get(site.localName) ?? [];
    const references: SymbolFact["references"] = [];
    let referencesInDiff = 0;
    const testFiles = new Set<string>();
    let referenceCount = 0;

    for (const reference of sites) {
      // The same exclusion tier 1 applies: a mention INSIDE the declaration's
      // own range in its own file is not a reference to it.
      if (
        reference.path === site.path &&
        reference.line >= site.startLine &&
        reference.line <= site.endLine
      ) {
        continue;
      }
      referenceCount++;
      const inDiff = changedLineLookup(reference.path, reference.line);
      if (inDiff) referencesInDiff++;
      if (reference.isTest) testFiles.add(reference.path);
      if (maxReferences === 0 || references.length < maxReferences) {
        references.push({
          at: `${reference.path}:${reference.line}`,
          inDiff,
          inSymbol: reference.inSymbol,
          isTest: reference.isTest,
        });
      }
    }

    symbols.push({
      name: site.name,
      kind: site.kind,
      exported: site.exported,
      declaredAt: `${site.path}:${site.line}`,
      changedHunks: hunksTouching(entry, site.startLine, site.endLine),
      references,
      // `null` = nobody looked, and nobody did: an implementation query is a
      // TYPE query. Reporting `[]` here would say "this interface has no
      // implementers", which is the exact absence claim this tier cannot make.
      implementations: null,
      callees: [...site.callees].sort(),
      // `null` = NOBODY LOOKED AT TIER 2. The registration walk (D2b) needs a
      // callee + argument view this name-match engine does not reliably have,
      // and `[]` would claim "walked the body, found no registration" — an
      // absence claim this tier cannot make.
      registrations: null,
      tests: [...testFiles].sort(),
      referenceCount,
      referencesInDiff,
      resolution: "name-match",
      nameAmbiguity: nameAmbiguityOf(index, site.localName),
    });
  }

  symbols.sort((a, b) => a.declaredAt.localeCompare(b.declaredAt) || a.name.localeCompare(b.name));
  return { payload: { files, symbols }, degraded, index };
}

/** `path:start-end` → does it overlap [from, to]? Tier 1's rule, verbatim. */
function hunksTouching(entry: ChangedFileIndex, from: number, to: number): string[] {
  return entry.hunks.filter((hunk) => {
    const match = /:(\d+)-(\d+)$/.exec(hunk);
    if (!match) return false;
    return Number(match[1]) <= to && Number(match[2]) >= from;
  });
}
