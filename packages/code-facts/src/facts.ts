/**
 * `facts` — the impact cone.
 *
 * For every symbol the diff touched: which hunks changed it, every reference
 * site (cross-file, cross-barrel, cross-workspace), implementations of a
 * changed interface or abstract member, its callees, and which test files
 * reference it.
 *
 * The field that earns this extractor its place is `referencesInDiff` beside
 * `referenceCount`. A symbol whose shape changed in the diff and whose
 * references are MOSTLY OUTSIDE it is the cross-file contract bug the reviewer
 * most needs to find — and it is invisible in the diff, because each file reads
 * correctly on its own.
 *
 * v3's enumerator guessed this with regexes and still produced the
 * investigation's only gold match. Making it mechanically true is the
 * highest-leverage single change available.
 */
import type { ClassDeclaration, Node, SourceFile } from "ts-morph";
import { Node as TsNode, SyntaxKind } from "ts-morph";
import type { FactsPayload, SymbolFact } from "./schema.js";
import type { Programs } from "./project.js";
import { isTestPath, locationOf, repoRelative, sourceFileAt } from "./project.js";
import type { FileHunks } from "./git.js";
import type { ChangedPath } from "./git.js";
import { hasAnalysableExtension } from "./project.js";

export interface ChangedFileIndex {
  path: string;
  changedLines: Set<number>;
  hunks: string[];
}

export function indexHunks(hunks: FileHunks[]): Map<string, ChangedFileIndex> {
  const index = new Map<string, ChangedFileIndex>();
  for (const file of hunks) {
    index.set(file.path, {
      path: file.path,
      changedLines: new Set(file.changedLines),
      hunks: file.hunks,
    });
  }
  return index;
}

/** `path:start-end` → does it overlap [from, to]? */
function hunksTouching(entry: ChangedFileIndex, from: number, to: number): string[] {
  return entry.hunks.filter((hunk) => {
    const match = /:(\d+)-(\d+)$/.exec(hunk);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start <= to && end >= from;
  });
}

interface Candidate {
  name: string;
  kind: string;
  exported: boolean;
  nameNode: Node;
  body: Node;
}

function isExported(node: Node): boolean {
  return TsNode.isExportable(node) ? node.isExported() : false;
}

/**
 * Every named declaration worth an obligation: module-level functions, classes,
 * interfaces, type aliases, enums and variables, plus class members (a changed
 * method is the unit a reviewer reasons about, not the class it sits in).
 */
function candidatesIn(file: SourceFile): Candidate[] {
  const out: Candidate[] = [];

  const pushClassMembers = (declaration: ClassDeclaration): void => {
    for (const method of declaration.getMethods()) {
      out.push({
        name: `${declaration.getName() ?? "(anonymous)"}.${method.getName()}`,
        kind: method.isAbstract() ? "abstract-method" : "method",
        exported: isExported(declaration),
        nameNode: method.getNameNode(),
        body: method,
      });
    }
    for (const property of declaration.getProperties()) {
      out.push({
        name: `${declaration.getName() ?? "(anonymous)"}.${property.getName()}`,
        kind: "property",
        exported: isExported(declaration),
        nameNode: property.getNameNode(),
        body: property,
      });
    }
  };

  for (const declaration of file.getFunctions()) {
    const nameNode = declaration.getNameNode();
    if (!nameNode) continue;
    out.push({
      name: declaration.getName() ?? "(anonymous)",
      kind: "function",
      exported: isExported(declaration),
      nameNode,
      body: declaration,
    });
  }
  for (const declaration of file.getClasses()) {
    const nameNode = declaration.getNameNode();
    if (nameNode) {
      out.push({
        name: declaration.getName() ?? "(anonymous)",
        kind: "class",
        exported: isExported(declaration),
        nameNode,
        body: declaration,
      });
    }
    pushClassMembers(declaration);
  }
  for (const declaration of file.getInterfaces()) {
    out.push({
      name: declaration.getName(),
      kind: "interface",
      exported: isExported(declaration),
      nameNode: declaration.getNameNode(),
      body: declaration,
    });
    for (const member of declaration.getMethods()) {
      out.push({
        name: `${declaration.getName()}.${member.getName()}`,
        kind: "interface-method",
        exported: isExported(declaration),
        nameNode: member.getNameNode(),
        body: member,
      });
    }
  }
  for (const declaration of file.getTypeAliases()) {
    out.push({
      name: declaration.getName(),
      kind: "type",
      exported: isExported(declaration),
      nameNode: declaration.getNameNode(),
      body: declaration,
    });
  }
  for (const declaration of file.getEnums()) {
    out.push({
      name: declaration.getName(),
      kind: "enum",
      exported: isExported(declaration),
      nameNode: declaration.getNameNode(),
      body: declaration,
    });
  }
  for (const statement of file.getVariableStatements()) {
    for (const declaration of statement.getDeclarations()) {
      const nameNode = declaration.getNameNode();
      if (!TsNode.isIdentifier(nameNode)) continue; // destructuring — no single symbol
      out.push({
        name: declaration.getName(),
        kind: "variable",
        exported: statement.isExported(),
        nameNode,
        body: declaration,
      });
    }
  }
  return out;
}

/** The nearest enclosing named declaration — "who calls this". */
function enclosingSymbol(node: Node): string | null {
  let current: Node | undefined = node.getParent();
  while (current) {
    if (
      TsNode.isFunctionDeclaration(current) ||
      TsNode.isMethodDeclaration(current) ||
      TsNode.isClassDeclaration(current) ||
      TsNode.isInterfaceDeclaration(current) ||
      TsNode.isVariableDeclaration(current)
    ) {
      const name = current.getName();
      if (name) return name;
    }
    current = current.getParent();
  }
  return null;
}

function calleesOf(body: Node): string[] {
  const names = new Set<string>();
  for (const call of body.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expression = call.getExpression();
    const text = expression.getText();
    // `a.b.c(...)` → `a.b.c`; anything with a newline or a paren is a computed
    // callee and naming it would be noise.
    if (text.length <= 80 && !/[\n()]/.test(text)) names.add(text);
  }
  return [...names].sort();
}

export interface ExtractFactsOptions {
  repo: string;
  /**
   * ONE PROGRAM PER TSCONFIG the diff touches, not one for the diff. A changed
   * file is looked up in each in turn; reference queries then run inside the
   * program that owns the file, which is the only place they could resolve.
   */
  project: Programs;
  hunks: FileHunks[];
  changed: ChangedPath[];
  /** Cap on reference sites recorded per symbol. `0` = unbounded. */
  maxReferences?: number;
}

export const DEFAULT_MAX_REFERENCES = 200;

export function extractFacts(options: ExtractFactsOptions): FactsPayload {
  const { repo } = options;
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
    const source =
      changed.status === "deleted" || !hasAnalysableExtension(changed.path)
        ? undefined
        : sourceFileAt(options.project, repo, changed.path);

    files.push({
      path: changed.path,
      status: changed.status,
      hunks,
      changedLines,
      analysed: source !== undefined,
    });
    if (!source || !entry) continue;

    for (const candidate of candidatesIn(source)) {
      const from = candidate.body.getStartLineNumber();
      const to = candidate.body.getEndLineNumber();
      const touching = hunksTouching(entry, from, to);
      if (touching.length === 0) continue;

      const references: SymbolFact["references"] = [];
      let referencesInDiff = 0;
      const testFiles = new Set<string>();
      let referenceCount = 0;

      for (const node of findReferences(candidate.nameNode)) {
        const file = node.getSourceFile();
        const path = repoRelative(repo, file.getFilePath());
        const line = node.getStartLineNumber();
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
        declaredAt: locationOf(repo, source, candidate.nameNode.getStart()),
        changedHunks: touching,
        references,
        implementations: implementationsOf(repo, candidate),
        callees: calleesOf(candidate.body),
        tests: [...testFiles].sort(),
        referenceCount,
        referencesInDiff,
        // The compiler resolved every site above. `syntactic.ts` is the other
        // engine and it says `name-match`; the two produce the same JSON shape
        // and only this field tells them apart.
        resolution: "type-aware",
        // `null` = nobody looked, and nobody did. `nameAmbiguity` costs a
        // repo-wide parse, which a type-resolved run has no other use for —
        // and the question it answers ("could this name mean something else?")
        // is one the compiler has already answered here.
        nameAmbiguity: null,
      });
    }
  }

  symbols.sort((a, b) => a.declaredAt.localeCompare(b.declaredAt) || a.name.localeCompare(b.name));
  return { files, symbols };
}

/**
 * The language service's reference query. It throws on a node the service
 * cannot key (a computed member name, say); a throw here would take the whole
 * extractor down for one odd declaration, so it degrades to "no references"
 * for that symbol and the rest of the document survives.
 */
function findReferences(nameNode: Node): Node[] {
  try {
    if (!TsNode.isReferenceFindable(nameNode)) return [];
    return nameNode.findReferencesAsNodes();
  } catch {
    return [];
  }
}

interface ImplementationGetable {
  getImplementations(): { getNode(): Node }[];
}

/**
 * ts-morph mixes `getImplementations()` into the name-node types but exports no
 * `Node.isImplementationGetable` guard for it, so this is a duck-typed narrow
 * rather than a cast — a cast would silently break if the mixin moved.
 */
function asImplementationGetable(node: Node): ImplementationGetable | null {
  const candidate = node as unknown as Partial<ImplementationGetable>;
  return typeof candidate.getImplementations === "function"
    ? (candidate as ImplementationGetable)
    : null;
}

/**
 * Implementations / overrides of a changed interface or abstract member. Only
 * asked for the kinds where it means something — on a plain function the
 * language service returns the declaration itself, which is noise.
 *
 * **`null` means nobody asked; `[]` means the query ran and found none.** Every
 * one of these three early exits used to return `[]`, so "this is a function,
 * the question does not apply" and "this exported interface has no implementers
 * anywhere" were the same JSON — and only the second is a fact worth an
 * obligation.
 */
function implementationsOf(repo: string, candidate: Candidate): string[] | null {
  if (!["interface", "interface-method", "abstract-method", "class"].includes(candidate.kind)) {
    return null;
  }
  try {
    const getable = asImplementationGetable(candidate.nameNode);
    if (!getable) return null;
    const out = new Set<string>();
    for (const implementation of getable.getImplementations()) {
      const node = implementation.getNode();
      const path = repoRelative(repo, node.getSourceFile().getFilePath());
      const location = `${path}:${node.getStartLineNumber()}`;
      if (location === `${repoRelative(repo, candidate.nameNode.getSourceFile().getFilePath())}:${candidate.nameNode.getStartLineNumber()}`) {
        continue;
      }
      out.add(location);
    }
    return [...out].sort();
  } catch {
    // The query threw, so this is "looked and could not see", not "looked and
    // there are none".
    return null;
  }
}
