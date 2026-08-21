/**
 * `contracts` — the semantic delta, base vs head.
 *
 * Two `Project`s over the same checkout: one at `base` (materialised with
 * `git worktree add --detach` into a temp dir — the agent's working tree is
 * never mutated), one at `head`. For each changed EXPORTED symbol, the
 * before/after of signature, parameter types, return shape, nullability and
 * thrown types.
 *
 * This is the `getUser() -> User | null` becoming `getUser() -> User` +
 * `throws NotFoundError` class of regression, made mechanical — and
 * `consumersOutsideDiff` is the half that makes it an obligation rather than a
 * curiosity, because those are the call sites the PR did not touch and the
 * reviewer will not see.
 */
import type { Node, Project, SourceFile } from "ts-morph";
import { Node as TsNode, SyntaxKind } from "ts-morph";
import type { ContractDelta, ContractsPayload } from "./schema.js";
import { isTestPath, repoRelative } from "./project.js";
import type { ChangedFileIndex } from "./facts.js";
import type { ChangedPath } from "./git.js";

interface Shape {
  kind: string;
  signature: string;
  parameters: { name: string; type: string; optional: boolean }[];
  returns: string | null;
  nullableReturn: boolean;
  throws: string[];
}

interface NamedDeclaration {
  name: string;
  node: Node;
  nameNode: Node;
  exported: boolean;
}

/** Exported, module-level, named. Class methods are keyed `Class.method`. */
function exportedDeclarations(file: SourceFile): NamedDeclaration[] {
  const out: NamedDeclaration[] = [];
  for (const [name, declarations] of file.getExportedDeclarations()) {
    for (const declaration of declarations) {
      // `getExportedDeclarations()` follows re-exports, so a barrel would
      // otherwise attribute another file's symbol to this one.
      if (declaration.getSourceFile() !== file) continue;
      const nameNode =
        (TsNode.hasName(declaration) ? declaration.getNameNode() : undefined) ?? declaration;
      out.push({ name, node: declaration, nameNode, exported: true });
      if (TsNode.isClassDeclaration(declaration)) {
        for (const method of declaration.getMethods()) {
          if (method.hasModifier(SyntaxKind.PrivateKeyword)) continue;
          out.push({
            name: `${name}.${method.getName()}`,
            node: method,
            nameNode: method.getNameNode(),
            exported: true,
          });
        }
      }
      if (TsNode.isInterfaceDeclaration(declaration)) {
        for (const method of declaration.getMethods()) {
          out.push({
            name: `${name}.${method.getName()}`,
            node: method,
            nameNode: method.getNameNode(),
            exported: true,
          });
        }
      }
    }
  }
  return out;
}

/** `throw new NotFoundError(...)` in the body, plus any JSDoc `@throws`. */
function thrownTypes(node: Node): string[] {
  const out = new Set<string>();
  for (const statement of node.getDescendantsOfKind(SyntaxKind.ThrowStatement)) {
    const expression = statement.getExpression();
    if (expression && TsNode.isNewExpression(expression)) {
      out.add(expression.getExpression().getText());
    } else if (expression) {
      out.add(expression.getType().getText(expression));
    }
  }
  if (TsNode.isJSDocable(node)) {
    for (const doc of node.getJsDocs()) {
      for (const tag of doc.getTags()) {
        if (tag.getTagName() === "throws" || tag.getTagName() === "throw") {
          const text = tag.getCommentText()?.trim();
          if (text) out.add(text.replace(/^\{(.+?)\}.*$/, "$1").split(/\s+/)[0]);
        }
      }
    }
  }
  return [...out].sort();
}

function functionLike(node: Node): Node | null {
  if (
    TsNode.isFunctionDeclaration(node) ||
    TsNode.isMethodDeclaration(node) ||
    TsNode.isMethodSignature(node) ||
    TsNode.isArrowFunction(node) ||
    TsNode.isFunctionExpression(node)
  ) {
    return node;
  }
  if (TsNode.isVariableDeclaration(node)) {
    const initializer = node.getInitializer();
    if (
      initializer &&
      (TsNode.isArrowFunction(initializer) || TsNode.isFunctionExpression(initializer))
    ) {
      return initializer;
    }
  }
  return null;
}

/**
 * The declaration's observable contract.
 *
 * Type TEXT rather than a structural type comparison: it is stable, readable in
 * an obligation, and — the part that matters here — it does not depend on the
 * repo's own `typescript`, which we must never resolve.
 */
export function shapeOf(node: Node): Shape {
  const shape = rawShapeOf(node);
  // The absolute-path form is stripped from what we EMIT as well as from what
  // we compare: `import("/private/var/folders/…/src/user").User` is unreadable
  // in an obligation and names a temp directory that will not exist tomorrow.
  return {
    ...shape,
    signature: stripImportPaths(shape.signature),
    returns: shape.returns === null ? null : stripImportPaths(shape.returns),
    parameters: shape.parameters.map((parameter) => ({
      ...parameter,
      type: stripImportPaths(parameter.type),
    })),
  };
}

function rawShapeOf(node: Node): Shape {
  const fn = functionLike(node);
  if (fn) {
    const parameters =
      TsNode.isFunctionDeclaration(fn) ||
      TsNode.isMethodDeclaration(fn) ||
      TsNode.isMethodSignature(fn) ||
      TsNode.isArrowFunction(fn) ||
      TsNode.isFunctionExpression(fn)
        ? fn.getParameters().map((parameter) => ({
            name: parameter.getName(),
            type: parameter.getType().getText(parameter),
            optional: parameter.isOptional(),
          }))
        : [];
    const returns = fn.getType().getCallSignatures()[0]?.getReturnType();
    const returnText = returns ? returns.getText(fn) : null;
    return {
      kind: "function",
      signature: `(${parameters
        .map((p) => `${p.name}${p.optional ? "?" : ""}: ${p.type}`)
        .join(", ")}) => ${returnText ?? "unknown"}`,
      parameters,
      returns: returnText,
      nullableReturn: returnText !== null && /\b(?:null|undefined)\b/.test(returnText),
      throws: thrownTypes(fn),
    };
  }

  const typeText = node.getType().getText(node);
  return {
    kind: node.getKindName(),
    signature: typeText,
    parameters: [],
    returns: typeText,
    nullableReturn: /\b(?:null|undefined)\b/.test(typeText),
    throws: [],
  };
}

// ── canonical type text ──────────────────────────────────────────────────────
//
// A type's PRINTED form is not stable between two programs, and both
// instabilities produce phantom "changed" deltas — which are not merely noise:
// IRIS measured a half-mechanism seed as ACTIVELY HARMFUL (−3, worse than no
// seed at all), and a contract delta that did not happen is exactly that.
//
//  1. **Absolute paths.** An unnamed type prints as
//     `import("/abs/path/to/mod").Foo`, and the base tree lives in a temp
//     worktree, so every such type differs by its own location.
//  2. **Union member order.** TypeScript does not guarantee it across programs;
//     `"fail" | "complete"` and `"complete" | "fail"` are the same type.
//
// Both are normalised away before comparison. The EMITTED text keeps the import
// paths stripped too — a 4000-character type full of `../../..` is unreadable
// in an obligation regardless.

function stripImportPaths(text: string): string {
  return text.replace(/import\("[^"]*"\)\./g, "");
}

/** Split on `separator` at bracket depth 0, ignoring string literals. */
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{" || ch === "<") depth++;
    else if (ch === ")" || ch === "]" || ch === "}" || ch === ">") depth--;
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

const CLOSERS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/**
 * `sortMembers` is true only inside `{ … }`: object members have no meaningful
 * order, but function PARAMETERS and generic ARGUMENTS do, so `(` and `<`
 * groups are canonicalised without being reordered.
 */
function canonicalise(text: string, sortMembers = false): string {
  const trimmed = text.trim();

  // MEMBERS BEFORE UNIONS, and the order is load-bearing. Inside an object body
  // the `;` between members and the `|` inside a member's value sit at the SAME
  // bracket depth, so splitting on `|` first shreds the member list and the
  // sort never reaches the value that actually needed reordering.
  if (sortMembers) {
    for (const separator of [";", ","]) {
      const members = splitTopLevel(trimmed, separator);
      if (members.length > 1) {
        return members
          .map((member) => canonicaliseMember(member))
          .filter((member) => member.length > 0)
          .sort()
          .join("; ");
      }
    }
  }

  const unionParts = splitTopLevel(trimmed, "|");
  if (unionParts.length > 1) {
    return unionParts
      .map((part) => canonicalise(part, sortMembers))
      .sort()
      .join(" | ");
  }

  // No top-level split left — descend into each bracketed group.
  let out = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    const closer = CLOSERS[ch];
    if (!closer) {
      out += ch;
      i++;
      continue;
    }
    let depth = 0;
    let end = i;
    for (let j = i; j < trimmed.length; j++) {
      const c = trimmed[j];
      if (CLOSERS[c]) depth++;
      else if (c === ")" || c === "]" || c === "}" || c === ">") {
        depth--;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    if (end <= i) {
      out += trimmed.slice(i);
      break;
    }
    out += ch + canonicalise(trimmed.slice(i + 1, end), ch === "{") + closer;
    i = end + 1;
  }
  return out.trim();
}

/**
 * `then: "complete" | "fail"` — the property NAME must be split off before the
 * value's union is sorted, or the name sorts as part of the first member and
 * the two orderings still differ. That single omission left one phantom delta
 * standing on the first real repo this ran against.
 */
function canonicaliseMember(member: string): string {
  const halves = splitTopLevel(member, ":");
  if (halves.length < 2) return canonicalise(member, false);
  const name = halves[0];
  const value = halves.slice(1).join(":");
  return `${canonicalise(name, false)}: ${canonicalise(value, false)}`;
}

export function canonicalType(text: string): string {
  return canonicalise(stripImportPaths(text));
}

function sameShape(a: Shape, b: Shape): boolean {
  return (
    canonicalType(a.signature) === canonicalType(b.signature) &&
    a.kind === b.kind &&
    a.throws.join("|") === b.throws.join("|") &&
    a.nullableReturn === b.nullableReturn
  );
}

export interface ExtractContractsOptions {
  repo: string;
  headProject: Project;
  /** `null` when the base tree could not be materialised — degrade, never lie. */
  baseProject: Project | null;
  baseDir: string | null;
  changed: ChangedPath[];
  hunkIndex: Map<string, ChangedFileIndex>;
}

export interface ExtractContractsResult {
  payload: ContractsPayload;
  degraded: { extractor: string; reason: string }[];
}

export function extractContracts(options: ExtractContractsOptions): ExtractContractsResult {
  const { repo, headProject, baseProject, baseDir } = options;
  const contracts: ContractDelta[] = [];
  const oneSided: string[] = [];

  for (const change of options.changed) {
    const path = change.path;
    const headFile = headProject.getSourceFile((f) => repoRelative(repo, f.getFilePath()) === path);
    const baseFile =
      baseProject && baseDir
        ? baseProject.getSourceFile((f) => repoRelative(baseDir, f.getFilePath()) === path)
        : undefined;
    if (!headFile && !baseFile) continue;

    /**
     * A file the diff MODIFIED must be in both programs, or the comparison is
     * not a comparison. If it is only in one, every export reads as `added` or
     * `removed` — 65 phantom removals on the first real repo this was run
     * against, from one tsconfig resolving differently on the two sides.
     *
     * That is not a cosmetic bug. IRIS measured a half-mechanism seed as
     * ACTIVELY HARMFUL (−3, worse than no seed at all), and "this PR deleted
     * the export `foo`" when it did nothing of the kind is exactly that. So the
     * file is skipped and the omission is recorded, rather than guessed at.
     */
    const expectsBoth = change.status === "modified" || change.status === "renamed";
    if (expectsBoth && (!headFile || !baseFile)) {
      oneSided.push(`${path} (${headFile ? "base" : "head"} side not analysed)`);
      continue;
    }

    const headDeclarations = headFile ? exportedDeclarations(headFile) : [];
    const baseDeclarations = baseFile ? exportedDeclarations(baseFile) : [];
    const baseByName = new Map(baseDeclarations.map((d) => [d.name, d]));
    const headByName = new Map(headDeclarations.map((d) => [d.name, d]));

    for (const head of headDeclarations) {
      const base = baseByName.get(head.name);
      const after = shapeOf(head.node);
      const before = base ? shapeOf(base.node) : null;
      if (before && sameShape(before, after)) continue;
      contracts.push({
        symbol: head.name,
        file: path,
        change: before ? "changed" : "added",
        before,
        after,
        consumersOutsideDiff: consumersOutsideDiff(repo, head.nameNode, options.hunkIndex),
      });
    }

    for (const base of baseDeclarations) {
      if (headByName.has(base.name)) continue;
      contracts.push({
        symbol: base.name,
        file: path,
        change: "removed",
        before: shapeOf(base.node),
        after: null,
        // A removed symbol's remaining consumers are the interesting ones, and
        // they are found at HEAD by name — the declaration is gone, so there is
        // no node to query. The seeder gets the removal; `facts` carries the
        // reference map that was true before it.
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

/**
 * Reference sites the diff did NOT touch. Test files are kept — a test that
 * still asserts the old contract is precisely the signal — but flagged nowhere,
 * so the seeder can tell them apart by path.
 */
function consumersOutsideDiff(
  repo: string,
  nameNode: Node,
  hunkIndex: Map<string, ChangedFileIndex>,
): string[] {
  try {
    if (!TsNode.isReferenceFindable(nameNode)) return [];
    const declarationPath = repoRelative(repo, nameNode.getSourceFile().getFilePath());
    const declarationLine = nameNode.getStartLineNumber();
    const out = new Set<string>();
    for (const node of nameNode.findReferencesAsNodes()) {
      const path = repoRelative(repo, node.getSourceFile().getFilePath());
      const line = node.getStartLineNumber();
      if (path === declarationPath && line === declarationLine) continue;
      if (hunkIndex.get(path)?.changedLines.has(line)) continue;
      out.add(`${path}:${line}${isTestPath(path) ? " (test)" : ""}`);
    }
    return [...out].sort();
  } catch {
    return [];
  }
}
