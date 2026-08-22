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
import type { JSDocTag, Node, SourceFile } from "ts-morph";
import { Node as TsNode, SyntaxKind } from "ts-morph";
import type { ContractDelta, ContractsPayload } from "./schema.js";
import type { Programs } from "./project.js";
import { isTestPath, repoRelative, sourceFileAt } from "./project.js";
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
        if (tag.getTagName() !== "throws" && tag.getTagName() !== "throw") continue;
        const thrown = jsDocThrownType(tag);
        if (thrown) out.add(thrown);
      }
    }
  }
  return [...out].sort();
}

/**
 * The type named by one `@throws` tag — **from the tag's TYPE EXPRESSION first,
 * and only then from its comment text.**
 *
 * TypeScript parses `@throws` as a `JSDocThrowsTag` and lifts the braces into a
 * separate `typeExpression`, so `getCommentText()` returns the DESCRIPTION and
 * nothing else:
 *
 *   `@throws {ValidationError} when the id is empty`  → comment `"when the id is empty"`
 *   `@throws {ValidationError}`                       → comment `undefined`
 *
 * Reading the type off the comment therefore recorded `"when"` as the thrown
 * type in the first case and NOTHING in the second — and `{Type}` is the
 * dominant JSDoc spelling, so that was the common case, not the edge one. Both
 * halves cost: `throws` is compared raw in `sameShape`, so editing the prose
 * after a `@throws` moved the "thrown type" and produced a `changed` delta that
 * did not happen, and a bare `@throws {TypeError}` was an absence claim about a
 * documented throw that is right there in the source.
 *
 * The comment fallback keeps the un-braced spelling (`@throws Foo when …`)
 * working, which is what a `JSDocUnknownTag` for `@throw` also lands on.
 */
function jsDocThrownType(tag: JSDocTag): string | null {
  // Duck-typed rather than cast: `getTypeExpression` is mixed into the tag
  // types that have one, and ts-morph exports no guard for the mixin — the same
  // shape `facts.asImplementationGetable` is narrowed with.
  const typed = tag as unknown as {
    getTypeExpression?: () => { getTypeNode?: () => { getText(): string } | undefined } | undefined;
  };
  const named =
    typeof typed.getTypeExpression === "function"
      ? typed.getTypeExpression()?.getTypeNode?.()?.getText().trim()
      : undefined;
  if (named) return named;

  const text = tag.getCommentText()?.trim();
  if (!text) return null;
  return text.replace(/^\{(.+?)\}.*$/, "$1").split(/\s+/)[0] || null;
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
    // `throws` is a type-text surface too — `thrownTypes` falls back to
    // `getType().getText()` for anything that is not a `new` expression — and
    // `sameShape` compares it RAW, with no `canonicalType` pass. An unstripped
    // path here is therefore a delta on every single run, because the base tree
    // lives in a temp worktree whose path is different every time.
    throws: shape.throws.map(stripImportPaths),
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

/**
 * BOTH forms, and the second one is the one that bit us.
 *
 *   `import("/abs/path/mod").User`  → `User`        — a qualified member
 *   `typeof import("./schema/sqlite.js")` → `typeof sqlite`  — the module ITSELF
 *
 * The original regex required the trailing `.`, so the bare form — a module
 * namespace type, which is what a `typeof import(...)` parameter is — survived
 * with its specifier intact. `tests/invariants.test.ts` found it on this
 * monorepo's own Drizzle commit, where 2 of 207 contract deltas carried
 * `typeof import("./schema/sqlite.js")` straight into the emitted signature.
 *
 * That is the same defect as the dotted case in both of its halves: the text is
 * unreadable in an obligation (the comment above promises `../../..` is gone),
 * and an ABSOLUTE specifier — which is what a type outside the tsconfig's root
 * prints as — differs between the head tree and the temp base worktree, so the
 * symbol reads as `changed` on every run. Phantom deltas are not noise; IRIS
 * measured a half-mechanism seed at −3, worse than no seed at all.
 *
 * Collapsing the module to its basename loses the ability to distinguish
 * `import("./a/mod")` from `import("./b/mod")` — exactly the trade the dotted
 * form has always made, and the same direction: mask a rare real delta rather
 * than manufacture a routine phantom one.
 */
function stripImportPaths(text: string): string {
  return text.replace(/import\("([^"]*)"\)(\.?)/g, (_match, specifier: string, dot: string) =>
    dot ? "" : moduleLabel(specifier),
  );
}

/** `./state/schema/sqlite.js` → `sqlite`; `@scope/pkg` → `pkg`. */
function moduleLabel(specifier: string): string {
  const last = specifier.split("/").filter(Boolean).at(-1) ?? "";
  return last.replace(/\.[cm]?[jt]sx?$/, "") || "module";
}

/**
 * Does `text[i]` close a bracket group?
 *
 * The `text[i - 1] !== "="` is the whole reason this is a function. **`=>` is
 * not a closing angle bracket**, and counting it as one drove the depth NEGATIVE
 * for the rest of the string — so every signature (which is to say every
 * function, which is to say most of what this extractor compares) had its
 * return type split at a union that was never top-level. `tests/noise-floor.test.ts`
 * measures what that cost: 12 phantom deltas on a fixture whose only real change
 * is one added parameter.
 */
function closesGroup(text: string, i: number): boolean {
  const ch = text[i];
  if (ch === ")" || ch === "]" || ch === "}") return true;
  return ch === ">" && text[i - 1] !== "=";
}

function opensGroup(ch: string): boolean {
  return ch === "(" || ch === "[" || ch === "{" || ch === "<";
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
    if (opensGroup(ch)) depth++;
    else if (closesGroup(text, i)) depth--;
    else if (depth === 0 && ch === separator) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/**
 * `(…) => A | B` parses as `(…) => (A | B)`: the arrow binds LOOSER than the
 * union, so it has to come off before anything splits on `|`. Otherwise the
 * parameter list travels with the first union member and sorting moves it into
 * the middle of the return type — two orderings of the same type stay different
 * and the delta is phantom.
 */
function splitArrow(text: string): [string, string] | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < text.length - 1; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (opensGroup(ch)) depth++;
    else if (closesGroup(text, i)) depth--;
    else if (depth === 0 && ch === "=" && text[i + 1] === ">") {
      return [text.slice(0, i), text.slice(i + 2)];
    }
  }
  return null;
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
    // A body with exactly ONE member never reached the split above and fell
    // through to the union branch, where the property name sorted as part of
    // the first union member — `{ then: "a" | "b" }` and `{ then: "b" | "a" }`
    // stayed different. Route it through the same member path.
    if (trimmed.length > 0) return canonicaliseMember(trimmed);
  }

  const arrow = splitArrow(trimmed);
  if (arrow) {
    return `${canonicalise(arrow[0], false)} => ${canonicalise(arrow[1], false)}`;
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
      if (opensGroup(c)) depth++;
      else if (closesGroup(trimmed, j)) {
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
  /** One program per tsconfig the diff touches — see `loadProject`. */
  headProject: Programs;
  /**
   * `null` when the base tree could not be materialised — degrade, never lie.
   *
   * The two sides discover their own groups. That is not sloppiness: a PR that
   * ADDS a package tsconfig has one on the head side and none on the base side,
   * and forcing the head layout onto the base tree would compile a tsconfig
   * that does not exist there. What must match is the FILE SET, and the
   * one-sided guard below is what enforces that per file.
   */
  baseProject: Programs;
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
    const headFile = sourceFileAt(headProject, repo, path);
    const baseFile = baseDir ? sourceFileAt(baseProject, baseDir, path) : undefined;
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
