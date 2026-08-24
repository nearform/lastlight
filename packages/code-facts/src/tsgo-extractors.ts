/**
 * `facts` and `contracts` on the TS 7 compiler — the type-aware extractors.
 *
 * ## Why one file rather than two
 *
 * `facts.ts` and `contracts.ts` hold the halves that are NOT about a compiler
 * (the diff index; the `Shape` canonicaliser). Everything that touches the
 * checker is here, in one place, and that is deliberate: **an extractor is a
 * TYPE PRINTER before it is anything else**, and a signature that prints
 * differently on one side is the asymmetry that produced WP1's 227 contract
 * deltas of which exactly one was real. One printer, one set of format flags,
 * one line-number conversion, one reference query — shared by `facts`,
 * `contracts` and `constants`' set A — is what makes that class of bug a thing
 * somebody has to introduce on purpose.
 *
 * This file was `--engine tsgo` scaffolding while the two engines were being
 * A/B'd. The A/B is over: measured on this repo's `HEAD~1..HEAD`, entity sets
 * compared as SETS, `facts` 44 = 44 symbols and 138 = 138 reference sites,
 * contract keys 13 = 13, `consumersOutsideDiff` 32 = 32 — identical, at 3.2x
 * (facts) and 2.6x (contracts) the speed. ts-morph is gone.
 *
 * ## What was MEASURED here, not assumed
 *
 * Three mappings look like renames and are not. Each is pinned in
 * `tests/tsgo-port.test.ts`, which was written while the old answer was still
 * available to compare against.
 *
 * 1. **`getExportedDeclarations` → `getExportsOfModule` is not a rename.**
 *    ts-morph returned DECLARATIONS and followed re-exports for you; the TS 7
 *    checker returns SYMBOLS, and a re-export (or a same-file `export { x }`)
 *    arrives as an ALIAS symbol that has to be resolved with
 *    `getAliasedSymbol`. Measured on a barrel: without the alias step
 *    `export { rateLimit } from "./core/limits.js"` contributes a symbol whose
 *    `declarations` is the export specifier rather than the function, and
 *    `contracts` is KEYED on the export set — so the key set moves, which is
 *    the definition of a phantom delta.
 * 2. **JSDoc `@throws`.** `Checker.getJsDocTagsOfSymbol` returns
 *    `JSDocTagInfo = {name, text?}` — a flat RENDERED string with no separate
 *    type expression, which is precisely the shape that made
 *    `@throws {ValidationError} when the id is empty` record `"when"` (WP1b bug
 *    5). It is not used here. **VERIFIED in this checkout: the wire protocol
 *    DOES populate `Node.jsDoc` on a resolved node** — a `MethodDeclaration`
 *    fetched through `Program.getSourceFile` carries `jsDoc[0].tags[0]` as a
 *    real `JSDocThrowsTag` whose `typeExpression.type.getText()` is
 *    `"ValidationError"`. So the braced type comes off the AST, and no regex
 *    over rendered text is needed.
 * 3. **Line numbers are 0-BASED here** (`getLineAndCharacterOfPosition`) and
 *    were 1-based before (`getStartLineNumber`). An off-by-one throws nothing
 *    and fails no existing test — it emits a document that validates cleanly
 *    and cites the wrong line, which `selfcheck` cross-checks against
 *    `git diff -U0`. There is exactly ONE conversion in this file (`lineOf`)
 *    and every `path:line` citation in the package goes through it.
 *
 * A fourth, found the same way and not in anyone's list: **ts-morph's
 * `Parameter.isOptional()` was `questionToken || initializer || restParameter`**,
 * not `questionToken`. `(a: string, b?: number, c = 3, ...rest: string[])`
 * reported `false, true, true, true` there, and a naive `!!questionToken` port
 * reports `false, true, false, false` — a silent three-field difference in
 * every contract shape with a defaulted parameter. `isOptionalParameter`
 * reproduces the three-way rule.
 *
 * ## What this engine CANNOT do, said out loud
 *
 * - **There is no implementations query.** The TS 7 `Checker` has no
 *   `getImplementations`, so `SymbolFact.implementations` is `null` PLUS a
 *   `degraded[]` entry — never `[]`, which would be an absence claim nobody
 *   verified (`schema.ts`, the founding distinction). This is a real capability
 *   LOSS against ts-morph and it is recorded as one, not papered over.
 * - **A file the diff DELETED cannot re-enter its own configured program.**
 *   Measured: with the base overlay serving the blob and `fileExists` saying
 *   yes, the file still does not appear in the tsconfig's own file list (that
 *   list is computed from the real directory listing), so `openFiles` routes it
 *   to tsgo's INFERRED project — default compiler options. It is opened anyway,
 *   because a `removed` delta's KEY (the export name) is what `selfcheck`
 *   cross-checks against git and is right either way, and the alternative is
 *   losing every `removed` delta. The inferred-project caveat lands in
 *   `degraded[]` from `openSnapshot` itself.
 */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import type {
  CallExpression,
  ClassLikeBase,
  InterfaceDeclaration,
  JSDoc,
  MethodDeclaration,
  MethodSignatureDeclaration,
  Node,
  ParameterDeclaration,
  PropertyDeclaration,
  SourceFile,
  VariableStatement,
} from "typescript/unstable/ast";
import {
  ModifierFlags,
  SyntaxKind,
  getTextOfJSDocComment,
  isArrowFunction,
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isJSDoc,
  isJSDocTypeExpression,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNewExpression,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isVariableStatement,
} from "typescript/unstable/ast";
import { SignatureKind, SymbolFlags, type Project, type Symbol } from "typescript/unstable/sync";
import { finaliseShape, sameShape, type Shape } from "./contracts.js";
import type { ChangedFileIndex } from "./facts.js";
import { hunksTouching, indexHunks, DEFAULT_MAX_REFERENCES } from "./facts.js";
import type { ChangedPath, FileHunks } from "./git.js";
import { showFile } from "./git.js";
import { noopLogger, type LoggerPort } from "./log.js";
import { hasAnalysableExtension, isCompilerParsable, isTestPath } from "./project.js";
import type {
  ContractDelta,
  ContractsPayload,
  DegradedEntry,
  FactsPayload,
  Registration,
  SymbolFact,
} from "./schema.js";
import { openSnapshot, type EngineFile, type EngineSnapshot, type Overlay } from "./tsgo.js";

// ── type printing ────────────────────────────────────────────────────────────

/**
 * The type-printer flags, pinned explicitly rather than defaulted.
 *
 * They reproduce ts-morph's DEFAULT `TypeFormatFlags` exactly:
 * `NoTruncation | WriteTypeArgumentsOfSignature | UseFullyQualifiedType |
 * UseTypeOfFunction` (`ts-morph.js#getDefaultTypeFormatFlags`), plus
 * `InTypeAlias` when the enclosing node is a type alias — which is the other
 * half of that function.
 *
 * Passed explicitly rather than left to the compiler's default because the
 * flags DO reach the Go side (verified: `1 << 28` flips `"one"` to `'one'`),
 * and `contracts` compares type TEXT. A difference in the printer's default
 * flag set would show up as a delta about the flags rather than about the PR.
 * Measured on an inline ten-member object type and on an aliased one, the two
 * engines print byte-identically under these flags.
 */
const TYPE_FORMAT_FLAGS = 1 | 32 | 64 | 4096;
const IN_TYPE_ALIAS = 1 << 23;

function typeTextOf(project: Project, node: Node): string {
  const type = project.checker.getTypeAtLocation(node);
  if (!type) return "unknown";
  return project.checker.typeToString(type, node, flagsFor(node));
}

function flagsFor(node: Node): number {
  return node.kind === SyntaxKind.TypeAliasDeclaration
    ? TYPE_FORMAT_FLAGS | IN_TYPE_ALIAS
    : TYPE_FORMAT_FLAGS;
}

// ── the ONE line-number conversion ───────────────────────────────────────────

/**
 * A 0-based `LineAndCharacter` line → the 1-based line every document in this
 * package cites.
 *
 * `SourceFile.getLineAndCharacterOfPosition` is 0-based and says so in its own
 * doc comment; every citation this package emits is 1-based. EXPORTED so that
 * `constants`' set A goes through the same conversion — the whole value of
 * there being one is that there is one. An off-by-one here shifts every
 * `path:line` in every document by a line and throws nothing;
 * `pnpm selfcheck` cross-checks the result against `git diff -U0`.
 */
export function lineOf(file: SourceFile, pos: number): number {
  return file.getLineAndCharacterOfPosition(pos).line + 1;
}

function locationOf(path: string, file: SourceFile, pos: number): string {
  return `${path}:${lineOf(file, pos)}`;
}

// ── AST walking ──────────────────────────────────────────────────────────────

/** Every descendant of `node`, excluding `node` — `getDescendantsOfKind`'s scope. */
function forEachDescendant(node: Node, visit: (child: Node) => void): void {
  node.forEachChild((child) => {
    visit(child);
    forEachDescendant(child, visit);
    return undefined;
  });
}

function descendantsOfKind(node: Node, kind: SyntaxKind): Node[] {
  const out: Node[] = [];
  forEachDescendant(node, (child) => {
    if (child.kind === kind) out.push(child);
  });
  return out;
}

function modifierFlagsOf(node: Node): ModifierFlags {
  return (node as { modifierFlags?: ModifierFlags }).modifierFlags ?? 0;
}

function nameNodeOf(node: Node): Node {
  const named = node as { name?: Node };
  return named.name ?? node;
}

function nameTextOf(node: Node): string | null {
  const named = (node as { name?: Node }).name;
  if (!named) return null;
  const text = named.getText();
  return text.length > 0 ? text : null;
}

/**
 * `ExportableNode.isExported()`, reproduced: the `export` keyword, OR the
 * file's own export table containing this symbol directly or through an alias.
 *
 * The second half is not decoration — `const x = 1; export { x };` has no
 * export modifier at all, and calling that unexported would drop it out of
 * `facts`' `exported` field for a symbol every consumer imports.
 */
function isExportedIn(file: SourceFile, project: Project, node: Node): boolean {
  if ((modifierFlagsOf(node) & ModifierFlags.Export) !== 0) return true;
  const symbol = project.checker.getSymbolAtLocation(node);
  if (!symbol) return false;
  return exportedSymbolIds(file, project).has(symbol.id);
}

const EXPORT_ID_CACHE = new WeakMap<SourceFile, Map<Project, Set<number>>>();

function exportedSymbolIds(file: SourceFile, project: Project): Set<number> {
  let byProject = EXPORT_ID_CACHE.get(file);
  if (!byProject) {
    byProject = new Map();
    EXPORT_ID_CACHE.set(file, byProject);
  }
  const cached = byProject.get(project);
  if (cached) return cached;
  const ids = new Set<number>();
  for (const symbol of exportsOfModule(file, project)) {
    ids.add(symbol.id);
    const target = aliasTargetOf(symbol, project);
    if (target) ids.add(target.id);
  }
  byProject.set(project, ids);
  return ids;
}

function exportsOfModule(file: SourceFile, project: Project): readonly Symbol[] {
  const moduleSymbol = project.checker.getSymbolAtLocation(file);
  // A script rather than a module — no export table at all, which is
  // `getExportedDeclarations()` returning an empty map on the other engine.
  if (!moduleSymbol) return [];
  try {
    return project.checker.getExportsOfModule(moduleSymbol);
  } catch {
    return [];
  }
}

/**
 * The declaration a re-export or a local `export { x }` actually names.
 *
 * **This is the step that has no counterpart in the ts-morph spelling**, and
 * skipping it is the highest-risk single mistake in the port: `getExportsOfModule`
 * hands back the ALIAS, whose own `declarations` are the export specifier, so
 * `contracts` would key on a node in the wrong file (or in the right file but of
 * the wrong kind) and the key set — which IS the delta set — would move.
 *
 * `getAliasedSymbol` yields the checker's UNKNOWN symbol for an alias that does
 * not resolve, which is a looked-and-could-not-see answer: `null` here, and the
 * caller falls back to the alias's own declarations rather than inventing one.
 */
function aliasTargetOf(symbol: Symbol, project: Project): Symbol | null {
  if ((symbol.flags & SymbolFlags.Alias) === 0) return null;
  try {
    const target = project.checker.getAliasedSymbol(symbol);
    return project.checker.isUnknownSymbol(target) ? null : target;
  } catch {
    return null;
  }
}

/**
 * The reference set for a declaration's name node, inside its OWN program.
 *
 * `getReferencedSymbolsForNode` returns one entry per DEFINITION the query
 * reached (the declaration, the barrel's export specifier, each importer's
 * import specifier), each carrying its own reference handles — so the flattened
 * list is what `ts-morph`'s `findReferencesAsNodes()` returns. It throws on a
 * node the service cannot key, and one odd declaration must not take the whole
 * document down.
 */
export function referenceNodes(project: Project, nameNode: Node): Node[] {
  try {
    const entries = project.checker.getReferencedSymbolsForNode(nameNode, nameNode.getStart());
    const out: Node[] = [];
    for (const entry of entries) {
      for (const handle of entry.references) {
        const node = handle.resolve(project);
        if (node) out.push(node);
      }
    }
    return out;
  } catch {
    return [];
  }
}

// ── which tsconfigs, and which orphans ───────────────────────────────────────

/**
 * A `references`-only root tsconfig adds zero source files, so opening it looks
 * like success and produces nothing — the exact silence this package is
 * engineered against. Skipping it here sends its files to `openFiles` instead,
 * where they get a working checker.
 */
function isUsableTsConfig(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  try {
    const raw = readFileSync(candidate, "utf8");
    return !(/"references"\s*:/.test(raw) && !/"include"\s*:|"files"\s*:/.test(raw));
  } catch {
    return false;
  }
}

function nearestTsConfig(repo: string, path: string, cache: Map<string, string | null>): string | null {
  const chain: string[] = [];
  let dir = dirname(join(repo, path));
  while (dir.startsWith(repo) && dir.length >= repo.length) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      for (const seen of chain) cache.set(seen, cached);
      return cached;
    }
    chain.push(dir);
    const candidate = join(dir, "tsconfig.json");
    if (isUsableTsConfig(candidate)) {
      for (const seen of chain) cache.set(seen, candidate);
      return candidate;
    }
    if (dir === repo) break;
    dir = dirname(dir);
  }
  for (const seen of chain) cache.set(seen, null);
  return null;
}

export interface TsgoTargets {
  /** Absolute, in PRECEDENCE order — largest share of the diff first. */
  tsConfigPaths: string[];
  /**
   * EVERY analysable changed file, absolute — not just the ones no tsconfig
   * covers.
   *
   * MEASURED on this repo at `HEAD~1..HEAD`, and it is the difference between
   * 23 symbols and 44: "the nearest tsconfig exists" and "the nearest tsconfig
   * COMPILES this file" are different questions.
   * `packages/code-facts/tests/tsgo.test.ts` sits under a tsconfig whose
   * `include` is `["src"]`, so nearest-tsconfig finds one, the file is not in
   * its program, and nothing else was going to pick it up — the ts-morph path
   * catches these in its glob fallback and this one silently dropped four of
   * them.
   *
   * `openFiles` is `didOpen`, not "give me an inferred project": a file its own
   * tsconfig genuinely contains is routed to that CONFIGURED project and costs
   * nothing (`tests/tsgo.test.ts` pins exactly that), and only the remainder
   * falls through to the inferred project — where `openSnapshot` names it.
   * Opening them all is therefore the same answer for the covered files and a
   * strictly better one for the rest, with no policy needed here to tell them
   * apart.
   *
   * It also carries every file the diff DELETED, because only the base view can
   * hold one at all and an unopened deleted file yields no `removed` delta.
   */
  openFiles: string[];
  /** Analysable changed paths, repo-relative. */
  analysable: string[];
  /**
   * Analysable changed paths with no ancestor tsconfig at all, repo-relative.
   *
   * Reporting only. The authoritative "what fell through" answer comes from the
   * snapshot after it is opened, because it is the one that knows whether the
   * tsconfig it found actually compiles the file.
   */
  orphans: string[];
  /**
   * Repo-relative changed path → the tsconfig it was filed under, ABSOLUTE.
   *
   * The one thing the snapshot cannot reconstruct. A tsconfig that will not
   * PARSE is different from one that is absent — its files must be ABANDONED,
   * not routed to the inferred project, or a repository whose build config is
   * broken gets silently promoted to tier 1 with default compiler options
   * (`makeBrokenTsConfigFixture` is the fixture that pins it). `openSnapshot`
   * reports the unparsable tsconfigs in `failures[]`; this map is how a caller
   * turns that into the set of files to refuse.
   */
  nearestByPath: Map<string, string>;
  /**
   * Analysable changed paths the COMPILER cannot be handed, repo-relative.
   *
   * `.es6` panics the tsgo child and kills the whole snapshot
   * (`isCompilerParsable`). They are still analysable — ast-grep and the
   * name-match engine read them — so they are excluded here and NAMED by the
   * caller rather than dropped from the diff.
   */
  compilerHostile: string[];
}

/**
 * WHICH programs to open for this diff.
 *
 * The tsgo seam owns the compiler lifecycle and no policy; this is the policy,
 * and it is deliberately SHORT: nearest usable tsconfig per changed file, every
 * analysable changed file opened. There is no file budget, no project cap and
 * no neighbourhood selection — roughly 900 lines of cost management died with
 * ts-morph, because the numbers they bounded (2.4–3.0 GB peaks, a per-program
 * `node_modules` closure in the node heap) do not exist on this engine: all
 * eight workspace tsconfigs in ONE snapshot is 10,078 program files, 320 ms and
 * 98 MB. If a budget ever turns out to be needed again that is a finding to
 * measure, not a knob to restore.
 */
export function discoverTsgoTargets(options: {
  repo: string;
  changed: ChangedPath[];
  tsConfigPath?: string;
}): TsgoTargets {
  const repo = resolve(options.repo);
  const analysable = options.changed.filter((c) => hasAnalysableExtension(c.path));

  if (options.tsConfigPath) {
    // A FORCED tsconfig also disables the orphan fallback, exactly as
    // `loadProject` disables the glob fallback: a caller that named one program
    // did not ask for a second to be opened around it.
    return {
      tsConfigPaths: [
        isAbsolute(options.tsConfigPath)
          ? resolve(options.tsConfigPath)
          : resolve(repo, options.tsConfigPath),
      ],
      openFiles: [],
      analysable: analysable.map((c) => c.path),
      orphans: [],
      nearestByPath: new Map(),
      compilerHostile: analysable.filter((c) => !isCompilerParsable(c.path)).map((c) => c.path),
    };
  }

  const cache = new Map<string, string | null>();
  const share = new Map<string, number>();
  const orphans: string[] = [];
  const nearestByPath = new Map<string, string>();
  const compilerHostile = analysable.filter((c) => !isCompilerParsable(c.path)).map((c) => c.path);
  const openable = analysable.filter((c) => isCompilerParsable(c.path));
  for (const change of openable) {
    const found = nearestTsConfig(repo, change.path, cache);
    if (found) {
      share.set(found, (share.get(found) ?? 0) + 1);
      nearestByPath.set(change.path, found);
    } else orphans.push(change.path);
  }
  const openFiles = openable.map((change) => join(repo, change.path));

  return {
    // Largest share of the diff first: `EngineSnapshot.lookup` gives the earlier
    // project ownership of a file two programs both hold, and the program that
    // covers most of the diff is the one whose reference sets are worth most.
    tsConfigPaths: [...share.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([path]) => path),
    openFiles: [...new Set(openFiles)],
    analysable: analysable.map((c) => c.path),
    orphans,
    nearestByPath,
    compilerHostile,
  };
}

// ── the base overlay ─────────────────────────────────────────────────────────

/**
 * The base-side view of the tree, as an overlay rather than a second worktree.
 *
 * Every changed path is served from `git show <baseSha>:<path>`; a path git has
 * nothing for at base is `null`, which is how a file the PR ADDED must present.
 * `withWorktree` and `mirrorNodeModules` are not on this path — the base view is
 * the SAME tree with different bytes, so `node_modules` is already there and the
 * ranking/narrowing skew a temp worktree introduces cannot arise.
 */
export function buildBaseOverlay(repo: string, baseSha: string, changed: ChangedPath[]): Overlay {
  const overlay = new Map<string, string | null>();
  for (const change of changed) {
    if (!isCompilerParsable(change.path)) continue;
    overlay.set(change.path, showFile(repo, baseSha, change.path));
  }
  return overlay;
}

// ── candidates ───────────────────────────────────────────────────────────────

interface Candidate {
  name: string;
  kind: string;
  exported: boolean;
  nameNode: Node;
  body: Node;
}

function classMembers(
  file: SourceFile,
  project: Project,
  declaration: ClassLikeBase,
  out: Candidate[],
): void {
  const owner = nameTextOf(declaration) ?? "(anonymous)";
  const exported = isExportedIn(file, project, declaration as unknown as Node);
  for (const member of declaration.members) {
    const node = member as unknown as Node;
    if (isMethodDeclaration(node)) {
      const method = node as MethodDeclaration;
      const name = method.name.getText();
      out.push({
        name: `${owner}.${name}`,
        kind: (modifierFlagsOf(node) & ModifierFlags.Abstract) !== 0 ? "abstract-method" : "method",
        exported,
        nameNode: method.name,
        body: node,
      });
    } else if (isPropertyDeclaration(node)) {
      const property = node as PropertyDeclaration;
      out.push({
        name: `${owner}.${property.name.getText()}`,
        kind: "property",
        exported,
        nameNode: property.name,
        body: node,
      });
    }
  }
}

/**
 * Every named declaration worth an obligation — the SAME eight kinds
 * `facts.candidatesIn` produces, in the same order, so the two engines' symbol
 * lists are comparable as sets rather than as approximations.
 */
function candidatesIn(file: SourceFile, project: Project): Candidate[] {
  const out: Candidate[] = [];
  const statements = [...file.statements] as unknown as Node[];

  for (const statement of statements) {
    if (!isFunctionDeclaration(statement)) continue;
    const name = nameTextOf(statement);
    if (!name) continue;
    out.push({
      name,
      kind: "function",
      exported: isExportedIn(file, project, statement),
      nameNode: nameNodeOf(statement),
      body: statement,
    });
  }
  for (const statement of statements) {
    if (!isClassDeclaration(statement)) continue;
    const name = nameTextOf(statement);
    if (name) {
      out.push({
        name,
        kind: "class",
        exported: isExportedIn(file, project, statement),
        nameNode: nameNodeOf(statement),
        body: statement,
      });
    }
    classMembers(file, project, statement as unknown as ClassLikeBase, out);
  }
  for (const statement of statements) {
    if (!isInterfaceDeclaration(statement)) continue;
    const declaration = statement as InterfaceDeclaration;
    const name = declaration.name.getText();
    const exported = isExportedIn(file, project, statement);
    out.push({ name, kind: "interface", exported, nameNode: declaration.name, body: statement });
    for (const member of declaration.members) {
      const node = member as unknown as Node;
      if (!isMethodSignatureDeclaration(node)) continue;
      const method = node as MethodSignatureDeclaration;
      out.push({
        name: `${name}.${method.name.getText()}`,
        kind: "interface-method",
        exported,
        nameNode: method.name,
        body: node,
      });
    }
  }
  for (const statement of statements) {
    if (!isTypeAliasDeclaration(statement)) continue;
    out.push({
      name: nameTextOf(statement) ?? "(anonymous)",
      kind: "type",
      exported: isExportedIn(file, project, statement),
      nameNode: nameNodeOf(statement),
      body: statement,
    });
  }
  for (const statement of statements) {
    if (!isEnumDeclaration(statement)) continue;
    out.push({
      name: nameTextOf(statement) ?? "(anonymous)",
      kind: "enum",
      exported: isExportedIn(file, project, statement),
      nameNode: nameNodeOf(statement),
      body: statement,
    });
  }
  for (const statement of statements) {
    if (!isVariableStatement(statement)) continue;
    const variableStatement = statement as VariableStatement;
    const exported = isExportedIn(file, project, statement);
    for (const declaration of variableStatement.declarationList.declarations) {
      const node = declaration as unknown as Node;
      // Destructuring — no single symbol, exactly as on the other engine.
      if (!isIdentifier(declaration.name as unknown as Node)) continue;
      out.push({
        name: declaration.name.getText(),
        kind: "variable",
        exported,
        nameNode: declaration.name as unknown as Node,
        body: node,
      });
    }
  }
  return out;
}

/** The nearest enclosing named declaration — "who calls this". */
function enclosingSymbol(node: Node): string | null {
  let current: Node | undefined = node.parent;
  while (current) {
    if (
      current.kind === SyntaxKind.FunctionDeclaration ||
      current.kind === SyntaxKind.MethodDeclaration ||
      current.kind === SyntaxKind.ClassDeclaration ||
      current.kind === SyntaxKind.InterfaceDeclaration ||
      current.kind === SyntaxKind.VariableDeclaration
    ) {
      const name = nameTextOf(current);
      if (name) return name;
    }
    current = current.parent;
  }
  return null;
}

function calleesOf(body: Node): string[] {
  const names = new Set<string>();
  for (const call of descendantsOfKind(body, SyntaxKind.CallExpression)) {
    if (!isCallExpression(call)) continue;
    const text = call.expression.getText();
    if (text.length <= 80 && !/[\n()]/.test(text)) names.add(text);
  }
  return [...names].sort();
}

// ── registrations (D2b) ──────────────────────────────────────────────────────

/**
 * Method names that read as a HOOK registration. The first argument MUST be a
 * string literal (the hook/event name) — which is what kills
 * `emitter.on(handler)`: an `on` with no literal phase is any event emitter.
 */
const HOOK_METHODS = new Set(["addHook", "on", "once", "addEventListener"]);

/**
 * Method names that read as a ROUTE registration. The first argument MUST be a
 * string literal starting with `/` — which is what kills `map.get("x")`,
 * `headers.delete("id")` and `http.get(url)`.
 */
const ROUTE_METHODS = new Set([
  "get",
  "post",
  "put",
  "delete",
  "patch",
  "options",
  "head",
  "all",
  "route",
]);

/**
 * Method names that read as a MOUNT — no argument constraint, because
 * `app.use(auth)` is precisely the anonymous middleware whose ORDER the D2b
 * question is about. `phase` is the first argument's string literal when there
 * is one (`app.use("/admin", guard)`), else `null`.
 */
const MOUNT_METHODS = new Set(["use", "register"]);

/**
 * Every route/hook registration inside `body`, in SOURCE-POSITION order (D2b).
 *
 * The same CallExpression walk as {@link calleesOf}, with its hygiene rules on
 * the callee text (≤ 80 chars, no newline, no parens), narrowed to a
 * property-access callee `recv.m` with `m` in one of the three sets above.
 * Deterministic and conservative on purpose: a false registration would seed a
 * false ordering obligation, and a missed one merely leaves the survey where it
 * already was. `ordinal` is the 0-based index in source order within the
 * symbol — `forEachDescendant` visits pre-order, which IS source order.
 *
 * Tier-1 only. The tier-2 name-match engine sets `registrations: null` —
 * nobody looked — because it has no callee/argument view reliable enough for
 * an ordering claim.
 */
function registrationsOf(body: Node, file: SourceFile, path: string): Registration[] {
  const out: Registration[] = [];
  for (const node of descendantsOfKind(body, SyntaxKind.CallExpression)) {
    if (!isCallExpression(node)) continue;
    const call = node as CallExpression;
    const callee = call.expression;
    if (!isPropertyAccessExpression(callee)) continue;
    const text = callee.getText();
    if (text.length > 80 || /[\n()]/.test(text)) continue;
    const method = callee.name.getText();
    const arg0 = call.arguments.length > 0 ? call.arguments[0] : undefined;

    let phase: string | null;
    if (HOOK_METHODS.has(method)) {
      if (!arg0 || !isStringLiteral(arg0)) continue;
      phase = arg0.text;
    } else if (ROUTE_METHODS.has(method)) {
      if (!arg0 || !isStringLiteral(arg0) || !arg0.text.startsWith("/")) continue;
      phase = arg0.text;
    } else if (MOUNT_METHODS.has(method)) {
      phase = arg0 && isStringLiteral(arg0) ? arg0.text : null;
    } else {
      continue;
    }

    out.push({
      at: locationOf(path, file, call.getStart()),
      call: text,
      phase,
      ordinal: out.length,
    });
  }
  return out;
}

// ── `facts` ──────────────────────────────────────────────────────────────────

/**
 * The kinds the implementations question APPLIES to — and therefore the only
 * kinds whose `null` is a capability loss rather than a category error.
 *
 * The previous engine already returned `null` for everything else ("this is a
 * function, the question does not apply"), so a diff of plain functions is
 * answered exactly as well as it ever was and must NOT degrade. Scoping the
 * `degraded[]` entry to this set is what keeps it a signal: an entry populated
 * on every single run has stopped carrying one, which is the same failure as
 * silence approached from the polite end.
 */
const IMPLEMENTATIONS_APPLY_TO = new Set([
  "interface",
  "interface-method",
  "abstract-method",
  "class",
]);

export interface ExtractFactsTsgoOptions {
  repo: string;
  snapshot: EngineSnapshot;
  hunks: FileHunks[];
  changed: ChangedPath[];
  maxReferences?: number;
}

export interface ExtractFactsTsgoResult {
  payload: FactsPayload;
  degraded: DegradedEntry[];
}

export function extractFactsTsgo(options: ExtractFactsTsgoOptions): ExtractFactsTsgoResult {
  const index = indexHunks(options.hunks);
  const maxReferences = options.maxReferences ?? DEFAULT_MAX_REFERENCES;
  const changedLineLookup = (path: string, line: number): boolean =>
    index.get(path)?.changedLines.has(line) ?? false;

  const symbols: SymbolFact[] = [];
  const files: FactsPayload["files"] = [];

  for (const changed of options.changed) {
    const entry = index.get(changed.path);
    const hunks = entry?.hunks ?? [];
    const changedLines = [...(entry?.changedLines ?? [])].sort((a, b) => a - b);
    const found =
      changed.status === "deleted" || !hasAnalysableExtension(changed.path)
        ? null
        : options.snapshot.lookup(changed.path);

    files.push({
      path: changed.path,
      status: changed.status,
      hunks,
      changedLines,
      analysed: found !== null,
    });
    if (!found || !entry) continue;

    const source = found.sourceFile;
    const project = found.owner.project;

    for (const candidate of candidatesIn(source, project)) {
      const from = lineOf(source, candidate.body.getStart());
      const to = lineOf(source, candidate.body.getEnd());
      const touching = hunksTouching(entry, from, to);
      if (touching.length === 0) continue;

      const references: SymbolFact["references"] = [];
      let referencesInDiff = 0;
      const testFiles = new Set<string>();
      let referenceCount = 0;

      for (const node of referenceNodes(project, candidate.nameNode)) {
        const file = node.getSourceFile();
        const path = repoRelativeOf(options.snapshot.repo, file.fileName);
        const line = lineOf(file, node.getStart());
        // The declaration's own name node is not a reference to itself.
        if (path === changed.path && line >= from && line <= to) continue;
        referenceCount++;
        const inDiff = changedLineLookup(path, line);
        if (inDiff) referencesInDiff++;
        const isTest = isTestPath(path);
        if (isTest) testFiles.add(path);
        if (maxReferences === 0 || references.length < maxReferences) {
          references.push({
            at: `${path}:${line}`,
            inDiff,
            inSymbol: enclosingSymbol(node),
            isTest,
          });
        }
      }

      symbols.push({
        name: candidate.name,
        kind: candidate.kind,
        exported: candidate.exported,
        declaredAt: locationOf(changed.path, source, candidate.nameNode.getStart()),
        changedHunks: touching,
        references,
        // `null`, NEVER `[]`: this engine has no implementations query at all,
        // so nobody looked. `[]` would be "this exported interface has no
        // implementers anywhere", which is a claim this run cannot make.
        implementations: null,
        callees: calleesOf(candidate.body),
        // `[]` here is a CLAIM — this engine walked the body and found no
        // registration — as opposed to tier 2's `null` (nobody looked).
        registrations: registrationsOf(candidate.body, source, changed.path),
        tests: [...testFiles].sort(),
        referenceCount,
        referencesInDiff,
        resolution: "type-aware",
        nameAmbiguity: null,
      });
    }
  }

  symbols.sort((a, b) => a.declaredAt.localeCompare(b.declaredAt) || a.name.localeCompare(b.name));

  const degraded: DegradedEntry[] = [];
  const unanswered = symbols.filter((s) => IMPLEMENTATIONS_APPLY_TO.has(s.kind)).length;
  if (unanswered > 0) {
    degraded.push({
      extractor: "facts",
      reason: `the TS 7 compiler API exposes no implementations query, so \`implementations\` is \`null\` on all ${unanswered} interface / class / abstract-member symbol(s) in this document — nobody looked. It is not \`[]\`: an interface with no implementers and an interface nobody asked about must not be the same JSON. This is a real capability LOSS against the engine this replaced; closing it needs an LSP \`textDocument/implementation\` round trip per symbol, which has not been built`,
    });
  }
  return { payload: { files, symbols }, degraded };
}

// ── `contracts` ──────────────────────────────────────────────────────────────

export interface NamedDeclaration {
  name: string;
  node: Node;
  nameNode: Node;
}

export function exportedDeclarations(file: SourceFile, project: Project): NamedDeclaration[] {
  const out: NamedDeclaration[] = [];
  for (const symbol of exportsOfModule(file, project)) {
    const target = aliasTargetOf(symbol, project) ?? symbol;
    for (const handle of target.declarations) {
      let declaration: Node | undefined;
      try {
        declaration = handle.resolve(project);
      } catch {
        declaration = undefined;
      }
      if (!declaration) continue;
      // A barrel re-exports another file's symbol; following the alias above is
      // what makes this comparison possible at all, and this line is what keeps
      // the barrel from being credited with the declaration.
      if (declaration.getSourceFile().fileName !== file.fileName) continue;
      const name = symbol.name;
      out.push({ name, node: declaration, nameNode: nameNodeOf(declaration) });
      if (isClassDeclaration(declaration)) {
        for (const member of (declaration as unknown as ClassLikeBase).members) {
          const node = member as unknown as Node;
          if (!isMethodDeclaration(node)) continue;
          if ((modifierFlagsOf(node) & ModifierFlags.Private) !== 0) continue;
          const method = node as MethodDeclaration;
          out.push({ name: `${name}.${method.name.getText()}`, node, nameNode: method.name });
        }
      }
      if (isInterfaceDeclaration(declaration)) {
        for (const member of (declaration as InterfaceDeclaration).members) {
          const node = member as unknown as Node;
          if (!isMethodSignatureDeclaration(node)) continue;
          const method = node as MethodSignatureDeclaration;
          out.push({ name: `${name}.${method.name.getText()}`, node, nameNode: method.name });
        }
      }
    }
  }
  return out;
}

/**
 * `throw new NotFoundError(...)` in the body, plus any JSDoc `@throws`.
 *
 * The JSDoc half reads the node's OWN `jsDoc` array rather than
 * `getJSDocTags()` (which climbs to the parent statement) — because ts-morph's
 * `getJsDocs()` is own-node too, and inheriting a `@throws` from a
 * `VariableStatement` here would be a difference between the engines rather
 * than between the commits.
 */
function thrownTypes(node: Node, project: Project): string[] {
  const out = new Set<string>();
  for (const statement of descendantsOfKind(node, SyntaxKind.ThrowStatement)) {
    const expression = (statement as { expression?: Node }).expression;
    if (!expression) continue;
    if (isNewExpression(expression)) {
      out.add((expression as { expression: Node }).expression.getText());
    } else {
      out.add(typeTextOf(project, expression));
    }
  }
  for (const doc of node.jsDoc ?? []) {
    if (!isJSDoc(doc)) continue;
    for (const tag of (doc as JSDoc).tags ?? []) {
      const tagName = tag.tagName.getText();
      if (tagName !== "throws" && tagName !== "throw") continue;
      const thrown = jsDocThrownType(tag);
      if (thrown) out.add(thrown);
    }
  }
  return [...out].sort();
}

/**
 * The type named by one `@throws` tag — from the tag's TYPE EXPRESSION first,
 * and only then from its comment text.
 *
 * `Checker.getJsDocTagsOfSymbol` is deliberately NOT used: `JSDocTagInfo` is
 * `{name, text?}`, a flat rendered string with the braces already folded into
 * the prose, which is exactly the shape that made
 * `@throws {ValidationError} when the id is empty` record `"when"`. The braced
 * type is lifted into `JSDocThrowsTag.typeExpression` by the parser, and
 * **`Node.jsDoc` is populated over the wire** (verified in this checkout), so
 * it is read off the AST here the same way it is on ts-morph.
 *
 * The comment fallback keeps the un-braced spelling (`@throws Foo when …`)
 * working — the only case it was ever right for.
 */
function jsDocThrownType(tag: { typeExpression?: Node; comment?: unknown }): string | null {
  const expression = tag.typeExpression;
  if (expression && isJSDocTypeExpression(expression)) {
    const named = (expression as { type: Node }).type.getText().trim();
    if (named) return named;
  }
  const text = getTextOfJSDocComment(tag.comment as never)?.trim();
  if (!text) return null;
  return text.replace(/^\{(.+?)\}.*$/, "$1").split(/\s+/)[0] || null;
}

function functionLike(node: Node): Node | null {
  if (
    isFunctionDeclaration(node) ||
    isMethodDeclaration(node) ||
    isMethodSignatureDeclaration(node) ||
    isArrowFunction(node) ||
    isFunctionExpression(node)
  ) {
    return node;
  }
  if (node.kind === SyntaxKind.VariableDeclaration) {
    const initializer = (node as { initializer?: Node }).initializer;
    if (initializer && (isArrowFunction(initializer) || isFunctionExpression(initializer))) {
      return initializer;
    }
  }
  return null;
}

/**
 * `ParameterDeclaration.isOptional()`, reproduced.
 *
 * ts-morph answers `questionToken != null || isRestParameter() ||
 * hasInitializer()`. Measured on `(a: string, b?: number, c = 3, ...rest)`:
 * `false, true, true, true`. A `!!questionToken` port gives
 * `false, true, false, false`, which is a silent per-parameter difference in
 * every shape carrying a default — not a delta, but not a comparison either.
 */
function isOptionalParameter(parameter: ParameterDeclaration): boolean {
  return (
    parameter.questionToken !== undefined ||
    parameter.dotDotDotToken !== undefined ||
    parameter.initializer !== undefined
  );
}

function rawShapeOf(node: Node, project: Project): Shape {
  const fn = functionLike(node);
  if (fn) {
    const parameters = [...((fn as { parameters?: readonly ParameterDeclaration[] }).parameters ?? [])].map(
      (parameter) => ({
        name: (parameter.name as unknown as Node).getText(),
        type: typeTextOf(project, parameter as unknown as Node),
        optional: isOptionalParameter(parameter),
      }),
    );
    const type = project.checker.getTypeAtLocation(fn);
    const signature = type
      ? project.checker.getSignaturesOfType(type, SignatureKind.Call)[0]
      : undefined;
    const returns = signature ? project.checker.getReturnTypeOfSignature(signature) : undefined;
    const returnText = returns ? project.checker.typeToString(returns, fn, flagsFor(fn)) : null;
    return {
      kind: "function",
      signature: `(${parameters
        .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
        .join(", ")}) => ${returnText ?? "unknown"}`,
      parameters,
      returns: returnText,
      nullableReturn: returnText !== null && /\b(?:null|undefined)\b/.test(returnText),
      throws: thrownTypes(fn, project),
    };
  }

  const typeText = typeTextOf(project, node);
  return {
    kind: SyntaxKind[node.kind] ?? String(node.kind),
    signature: typeText,
    parameters: [],
    returns: typeText,
    nullableReturn: /\b(?:null|undefined)\b/.test(typeText),
    throws: [],
  };
}

/** The tsgo counterpart of `contracts.shapeOf`, through the SAME normaliser. */
export function shapeOfTsgo(node: Node, project: Project): Shape {
  return finaliseShape(rawShapeOf(node, project));
}

/**
 * THE BASE SIDE, REDUCED TO PLAIN DATA — the reason it is a separate function.
 *
 * MEASURED, and it is the headline memory number of the whole spike: a tsgo
 * snapshot's cost is not in the node process, it is in the Go CHILD, and on
 * this repo's own `HEAD~1..HEAD` that child peaks at ~600 MB per side. Holding
 * a base and a head snapshot open at once therefore costs ~1.2 GB of child
 * plus ~0.2 GB of node — WORSE than the ts-morph path's ~1.0 GB, which is the
 * opposite of the result the spike exists to demonstrate.
 *
 * Nothing forces them to coexist. A `Shape` is strings; once the base side has
 * produced one there is no live handle in it, so the base snapshot can be
 * opened, drained to this map, and DISPOSED before the head snapshot is opened
 * at all. Peak becomes one child instead of two.
 *
 * The `presentPaths` half is not optional bookkeeping: the one-sided guard is
 * "was this file in the base PROGRAM", which is a different question from "did
 * it have any exports", and collapsing the two would turn a coverage gap into a
 * pile of phantom `added` deltas — the 65-phantom-removals shape from the other
 * direction.
 */
export interface BaseContractView {
  /** Repo-relative path → export name → the base-side shape. */
  shapes: Map<string, Map<string, Shape>>;
  /** Repo-relative paths the base program actually held. */
  presentPaths: Set<string>;
}

export function collectBaseContracts(
  base: EngineSnapshot,
  changed: ChangedPath[],
): BaseContractView {
  const shapes = new Map<string, Map<string, Shape>>();
  const presentPaths = new Set<string>();
  for (const change of changed) {
    if (!hasAnalysableExtension(change.path)) continue;
    const file = base.lookup(change.path);
    if (!file) continue;
    presentPaths.add(change.path);
    const byName = new Map<string, Shape>();
    for (const declaration of exportedDeclarations(file.sourceFile, file.owner.project)) {
      // LAST declaration wins, because that is what
      // `new Map(baseDeclarations.map(d => [d.name, d]))` does on the ts-morph
      // path. It only matters for an overloaded export, and matching it is
      // cheaper than explaining a difference later.
      byName.set(declaration.name, shapeOfTsgo(declaration.node, file.owner.project));
    }
    shapes.set(change.path, byName);
  }
  return { shapes, presentPaths };
}

export interface ExtractContractsTsgoOptions {
  repo: string;
  head: EngineSnapshot;
  /** Already drained and disposed — see `collectBaseContracts`. */
  base: BaseContractView;
  changed: ChangedPath[];
  hunkIndex: Map<string, ChangedFileIndex>;
}

export interface ExtractContractsTsgoResult {
  payload: ContractsPayload;
  degraded: DegradedEntry[];
}

export function extractContractsTsgo(
  options: ExtractContractsTsgoOptions,
): ExtractContractsTsgoResult {
  const contracts: ContractDelta[] = [];
  const oneSided: string[] = [];

  for (const change of options.changed) {
    const path = change.path;
    if (!hasAnalysableExtension(path)) continue;
    const headFile = options.head.lookup(path);
    const baseShapes = options.base.shapes.get(path) ?? null;
    const baseHeld = options.base.presentPaths.has(path);
    if (!headFile && !baseHeld) continue;

    // The same one-sided guard the ts-morph path applies, for the same reason:
    // a file present on one side only reads as every export `added` or
    // `removed`, which is the 65-phantom-removals shape.
    const expectsBoth = change.status === "modified" || change.status === "renamed";
    if (expectsBoth && (!headFile || !baseHeld)) {
      oneSided.push(`${path} (${headFile ? "base" : "head"} side not analysed)`);
      continue;
    }

    const headDeclarations = headFile
      ? exportedDeclarations(headFile.sourceFile, headFile.owner.project)
      : [];
    const headByName = new Map(headDeclarations.map((d) => [d.name, d]));

    // Every DECLARATION, not every name: an overloaded export contributes one
    // entry per overload on the ts-morph path, and deduping here would drop
    // one side of an overload pair from the comparison.
    for (const head of headDeclarations) {
      const before = baseShapes?.get(head.name) ?? null;
      const after = shapeOfTsgo(head.node, (headFile as EngineFile).owner.project);
      if (before && sameShape(before, after)) continue;
      contracts.push({
        symbol: head.name,
        file: path,
        change: before ? "changed" : "added",
        before,
        after,
        consumersOutsideDiff: consumersOutsideDiff(
          options.head.repo,
          (headFile as EngineFile).owner.project,
          head.nameNode,
          options.hunkIndex,
        ),
      });
    }

    for (const [name, before] of baseShapes ?? []) {
      if (headByName.has(name)) continue;
      contracts.push({
        symbol: name,
        file: path,
        change: "removed",
        before,
        after: null,
        consumersOutsideDiff: [],
      });
    }
  }

  contracts.sort((a, b) => a.file.localeCompare(b.file) || a.symbol.localeCompare(b.symbol));
  return {
    payload: { contracts },
    degraded:
      oneSided.length > 0
        ? [
            {
              extractor: "contracts",
              reason: `${oneSided.length} changed file(s) are in only one of the two programs, so no contract delta was computed for them — an added/removed export here would be phantom: ${oneSided
                .slice(0, 10)
                .join(", ")}`,
            },
          ]
        : [],
  };
}

function consumersOutsideDiff(
  repo: string,
  project: Project,
  nameNode: Node,
  hunkIndex: Map<string, ChangedFileIndex>,
): string[] {
  const declarationFile = nameNode.getSourceFile();
  const declarationPath = repoRelativeOf(repo, declarationFile.fileName);
  const declarationLine = lineOf(declarationFile, nameNode.getStart());
  const out = new Set<string>();
  for (const node of referenceNodes(project, nameNode)) {
    const file = node.getSourceFile();
    const path = repoRelativeOf(repo, file.fileName);
    const line = lineOf(file, node.getStart());
    if (path === declarationPath && line === declarationLine) continue;
    if (hunkIndex.get(path)?.changedLines.has(line)) continue;
    out.add(`${path}:${line}${isTestPath(path) ? " (test)" : ""}`);
  }
  return [...out].sort();
}

// ── opening the two views ────────────────────────────────────────────────────

export interface TsgoViewOptions {
  repo: string;
  baseSha: string;
  changed: ChangedPath[];
  tsConfigPath?: string;
  log?: LoggerPort;
}

export interface TsgoViews {
  targets: TsgoTargets;
  /**
   * Open ONE view. The caller owns `dispose()` and must run it in a `finally` —
   * each call spawns a `tsgo` child process.
   */
  open(side: "head" | "base"): EngineSnapshot;
}

/**
 * THE SYMMETRY INVARIANT, as code: one argument list, used twice, with the
 * overlay as the only difference.
 *
 * `tsConfigPaths` and `openFiles` are computed ONCE, here, from the head-side
 * diff, and handed to both sides verbatim. Neither side discovers its own
 * layout — which the previous engine structurally could not manage, because its
 * base tree was a different DIRECTORY and its loader necessarily re-grouped it.
 * That asymmetry is cause 1 of WP1's 227 phantom deltas, and it is now gone by
 * construction rather than by care.
 *
 * It hands back a FACTORY rather than an opened pair on purpose. The two
 * snapshots are two ~600 MB Go processes (measured on this repo), and
 * `contracts` does not need them at the same time — see `collectBaseContracts`.
 * An API that returned both open would make the expensive shape the default
 * one.
 */
export function tsgoViews(options: TsgoViewOptions): TsgoViews {
  const log = options.log ?? noopLogger;
  const repo = resolve(options.repo);
  const targets = discoverTsgoTargets({
    repo,
    changed: options.changed,
    ...(options.tsConfigPath ? { tsConfigPath: options.tsConfigPath } : {}),
  });
  const shape = {
    repo,
    tsConfigPaths: targets.tsConfigPaths,
    openFiles: targets.openFiles,
    log,
  } as const;
  return {
    targets,
    open: (side) =>
      openSnapshot(
        side === "head"
          ? shape
          : { ...shape, overlay: buildBaseOverlay(repo, options.baseSha, options.changed) },
      ),
  };
}

// ── a broken tsconfig is not an absent one ───────────────────────────────────

/**
 * The changed files whose OWN tsconfig would not parse.
 *
 * tsgo recovers a usable-looking project from an unparseable tsconfig and
 * reports the failure only in `getConfigFileParsingDiagnostics()`; `tsgo.ts`
 * turns that into a `tsconfig-unparsable` failure and excludes the project.
 * Without this step the excluded project's files simply fall through to
 * `openFiles` and land in the INFERRED project — default compiler options, no
 * `strict`, no `paths` — which is a repository whose build config is broken
 * being silently promoted to tier 1. **Abandoned, not globbed around**, exactly
 * as the old loader did it.
 */
export function abandonedByBrokenTsConfig(
  repo: string,
  targets: TsgoTargets,
  snapshot: EngineSnapshot,
): Set<string> {
  const unparsable = new Set(
    snapshot.failures.filter((f) => f.reason === "tsconfig-unparsable").map((f) => f.tsConfigPath),
  );
  const out = new Set<string>();
  if (unparsable.size === 0) return out;
  for (const [path, tsConfigPath] of targets.nearestByPath) {
    if (unparsable.has(repoRelativeOf(repo, tsConfigPath))) out.add(path);
  }
  return out;
}

/**
 * The same snapshot with `refused` paths reporting "no program holds this".
 *
 * A wrapper rather than a flag threaded through four extractors: `lookup` is
 * the single question every extractor asks about a changed file, so refusing
 * there is the one place that cannot be forgotten in the fifth caller. The
 * files are still compiled — the refusal is discovered only after the snapshot
 * exists — but nothing reads them, and the reason is in `degraded[]`.
 */
export function refusing(snapshot: EngineSnapshot, refused: ReadonlySet<string>): EngineSnapshot {
  if (refused.size === 0) return snapshot;
  return {
    ...snapshot,
    lookup: (path: string): EngineFile | null => {
      const found = snapshot.lookup(path);
      return found && refused.has(found.path) ? null : found;
    },
    dispose: () => snapshot.dispose(),
  };
}

/**
 * THE TWO SPELLINGS OF THE REPO ROOT AGAIN, on the way out this time.
 *
 * `openSnapshot` normalises them on the way IN (its `toRepoRelative`), but a
 * reference node comes back carrying whichever spelling the program that found
 * it reported — the canonical one whenever the file was reached through a
 * symlink, which on macOS is every `$TMPDIR` fixture and every review workspace.
 * Stripping only the given spelling leaves an ABSOLUTE `path:line` citation in
 * the document: it validates, it is unreadable, and it never matches a
 * `git diff` path. Cached per repo because `realpathSync` is a syscall and this
 * runs once per reference site.
 */
const REAL_ROOTS = new Map<string, string>();

export function repoRelativeOf(repo: string, absolute: string): string {
  let real = REAL_ROOTS.get(repo);
  if (real === undefined) {
    try {
      real = realpathSync(repo);
    } catch {
      real = repo;
    }
    REAL_ROOTS.set(repo, real);
  }
  for (const root of real === repo ? [repo] : [repo, real]) {
    const prefix = root.endsWith("/") ? root : `${root}/`;
    if (absolute.startsWith(prefix)) return absolute.slice(prefix.length);
  }
  return absolute;
}
