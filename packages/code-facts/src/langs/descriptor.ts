/**
 * `LanguageDescriptor` — what a language contributes to the syntactic engine.
 *
 * **This is a DATA shape, not a plugin system.** Roughly 85% of what the engine
 * needs from a language is a table of tree-sitter node kinds: which kinds
 * declare a name, which field on them holds that name, which kinds are an
 * identifier occurrence, which are a literal. The remaining 15% is genuinely
 * per-language logic — "is this declaration exported?" is `export_statement` in
 * TS/JS, `public` in Java and a leading underscore convention in Python — so it
 * is a function, and there are only three of them.
 *
 * The shape exists so that adding a language is *reviewable*: a new descriptor
 * is a table you can diff against the grammar's `node-types.json`, plus three
 * small predicates. Nothing about it is dynamic — `register.ts` holds a literal
 * array, imported at build time. There is no discovery, no registration API and
 * no lifecycle, because every one of those would be a surface with no second
 * implementor.
 *
 * **What a descriptor CANNOT do is resolve a type.** Everything the engine
 * built from one is a NAME MATCH: `run` here and `run` there are the same
 * string, and nothing says they are the same symbol. That is why every
 * `SymbolFact` produced this way carries `resolution: "name-match"` beside
 * `nameAmbiguity`, and why `docs/plans` calls this layer a hypothesis
 * generator. See `syntactic.ts`.
 */
import { parse, type Lang, type SgNode } from "@ast-grep/napi";

/**
 * One node of the parsed tree, at the width this package uses it.
 *
 * `SgNode`'s `field()` is typed against the static node-type map of a *known*
 * language, and a descriptor's `nameField` is a plain string read out of a
 * table — so the generic parameter cannot be inferred and the call does not
 * typecheck against `SgNode` directly. This alias is the one place that gap is
 * bridged, deliberately narrow: four accessors, all of them total.
 */
export interface SyntaxNode {
  kind(): string;
  text(): string;
  range(): { start: { line: number; column: number; index: number }; end: { line: number; column: number; index: number } };
  field(name: string): SyntaxNode | null;
  parent(): SyntaxNode | null;
  children(): SyntaxNode[];
}

/** `SgNode` at the width above. The cast is checked by every test that runs the engine. */
export function asSyntaxNode(node: SgNode): SyntaxNode {
  return node as unknown as SyntaxNode;
}

/**
 * A named declaration worth an obligation.
 *
 * `kind` and `nameField` come straight from the grammar; `symbolKind` is the
 * word this package's documents use (`facts` has always emitted `function`,
 * `class`, `method`, …, and a consumer must not have to learn a second
 * vocabulary per language).
 */
export interface DeclarationRule {
  /** The tree-sitter node kind — `function_declaration`, `method_definition`, … */
  kind: string;
  /** The field on that node holding the declared name. */
  nameField: string;
  /** The word the document uses: `function`, `class`, `method`, `interface`, … */
  symbolKind: string;
  /**
   * Node kinds of an enclosing declaration to QUALIFY the name with, nearest
   * first — `["class_declaration"]` turns `run` into `Service.run`.
   *
   * A changed method is the unit a reviewer reasons about, but `run` on its own
   * is not a name anybody can look up. Absent = the bare name is the name.
   */
  qualifyBy?: string[];
  /**
   * The node kinds the NAME field is allowed to be. Absent = any.
   *
   * `const { a, b } = obj` has a `variable_declarator` whose name field is an
   * `object_pattern`, and its text is `{ a, b }` — a "symbol" nothing can look
   * up and nothing declares. The type-aware engine skips it for the same reason
   * (`TsNode.isIdentifier(nameNode)`), and the two engines have to agree on
   * what a symbol IS before their reference sets can be compared at all.
   */
  nameKinds?: string[];
  /**
   * Only count this declaration when NOTHING else encloses it.
   *
   * A local `const` inside a function body is not a symbol a reviewer takes an
   * obligation about, and the type-aware engine does not emit one
   * (`file.getVariableStatements()` returns the source file's direct children
   * only). Without this the syntactic engine emitted every local in every
   * changed file — 784 "symbols" against tier 1's 254 on this monorepo, most of
   * them named `repo`, `source` or `env`, which then dragged the aggregate
   * precision down with names that were never comparable.
   */
  topLevelOnly?: boolean;
}

/**
 * A constant binding: a name, a literal value, and the syntax that makes it
 * immutable.
 *
 * The immutability test is the whole reason this is not just another
 * `DeclarationRule`. In TS/JS a `variable_declarator` is a constant only under
 * a `const` `lexical_declaration` — the declarator node itself is identical
 * under `let`. Expressed as an enclosing kind plus a text test rather than a
 * predicate, because that is what it is in every language the plan names
 * (`const` / `final` / `static final` / `val`).
 */
export interface ConstantRule {
  kind: string;
  nameField: string;
  /** The field holding the initialiser. Checked against `literalKinds`. */
  valueField: string;
  /** The ancestor that carries the immutability keyword. `null` = none needed. */
  enclosingKind: string | null;
  /** What that ancestor's text must start with. `null` = any. */
  enclosingTextRe: RegExp | null;
}

/** The literal node kinds, by the `valueKind` this package's documents use. */
export interface LiteralKinds {
  string: string[];
  number: string[];
  boolean: string[];
}

export interface LanguageDescriptor {
  /** Stable id — used in logs and in the gate's per-language census. */
  id: string;
  astGrepLang: Lang;
  /** Lower-case, with the dot. Longest match wins in `descriptorForPath`. */
  extensions: string[];
  declarations: DeclarationRule[];
  constantDeclarations: ConstantRule[];
  /**
   * Node kinds that are an occurrence of a name — the raw material of the
   * name-matched reference set. A declaration's own name node is one of these
   * too and the engine excludes it by position, not by kind.
   */
  referenceKinds: string[];
  literalKinds: LiteralKinds;
  /** The call node, for `callees`. */
  callKind: string;
  /**
   * Is this declaration visible outside its file?
   *
   * Takes the declared NAME as well as the node because several languages
   * answer partly from the name (Go's leading capital, Python's leading
   * underscore) and partly from the syntax.
   */
  isExported(name: string, node: SyntaxNode): boolean;
  /** This language's test-file convention — Go's `_test.go`, Maven's `src/test/`. */
  isTestPath(path: string): boolean;
}

/** What a caller wants out of a scan — see `interestingKinds`. */
export interface KindSelection {
  declarations?: boolean;
  references?: boolean;
  literals?: boolean;
  calls?: boolean;
}

/**
 * The node kinds one scan asks the parser for, deduplicated — **and no more
 * than that.**
 *
 * The selection is not a micro-optimisation. `constants`' literal sweep is the
 * one thing in this package that has ever dominated its wall clock, and it
 * wants four node kinds; asking for every identifier in every file as well
 * would materialise a JS object per identifier across the whole repository for
 * a sink that drops all of them. `findAll` is the allocation, not the parse.
 *
 * Declarations come along whenever references do, even if nobody asked for
 * them: the enclosing-declaration stack is what gives a reference its
 * `inSymbol`, and a declaration's own name node has to be recognised so it is
 * not counted as a reference to itself.
 */
export function interestingKinds(
  descriptor: LanguageDescriptor,
  want: KindSelection,
): string[] {
  const kinds = new Set<string>();
  if (want.declarations || want.references) {
    for (const rule of descriptor.declarations) kinds.add(rule.kind);
    for (const rule of descriptor.constantDeclarations) kinds.add(rule.kind);
  }
  if (want.references) for (const kind of descriptor.referenceKinds) kinds.add(kind);
  if (want.literals) {
    for (const kind of descriptor.literalKinds.string) kinds.add(kind);
    for (const kind of descriptor.literalKinds.number) kinds.add(kind);
    for (const kind of descriptor.literalKinds.boolean) kinds.add(kind);
  }
  if (want.calls) kinds.add(descriptor.callKind);
  return [...kinds];
}

/**
 * Which of `kinds` this descriptor's GRAMMAR actually has — and which it does
 * not.
 *
 * **This is a loudness surface, and it was a bug before it was a function.**
 * ast-grep does not ignore a node kind its grammar has never heard of: it
 * REFUSES THE WHOLE RULE (`Rule contains invalid kind matcher`). One shared
 * rule table across the TS and JS grammars therefore threw on every `.js` file
 * — `type_identifier` is TypeScript-only — and the scan caught the throw and
 * moved on, so `.js` files silently contributed nothing to set B. Measured: the
 * `.js` half of `constants`' own language-dispatch test went red, and it is the
 * only reason this was caught at all.
 *
 * So the kinds a language actually supports are resolved ONCE per descriptor
 * and cached. The fast path is a single probe of the whole rule; only a
 * grammar that rejects something pays for the per-kind bisect. The rejected
 * list is returned rather than swallowed, because "this descriptor names a kind
 * its grammar does not have" is exactly the kind of drift a test should be able
 * to assert about — benign for TS-only kinds in the JS grammar, and a typo
 * everywhere else.
 */
const KIND_SUPPORT = new Map<string, { kinds: string[]; rejected: string[] }>();

export function supportedKinds(
  descriptor: LanguageDescriptor,
  kinds: string[],
): { kinds: string[]; rejected: string[] } {
  const key = `${descriptor.id} ${kinds.join(",")}`;
  const cached = KIND_SUPPORT.get(key);
  if (cached) return cached;

  const root = parse(descriptor.astGrepLang, "").root() as unknown as {
    findAll(rule: unknown): unknown[];
  };
  const accepts = (kind: string): boolean => {
    try {
      root.findAll({ rule: { kind } });
      return true;
    } catch {
      return false;
    }
  };

  let result: { kinds: string[]; rejected: string[] };
  try {
    root.findAll({ rule: { any: kinds.map((kind) => ({ kind })) } });
    result = { kinds: [...kinds], rejected: [] };
  } catch {
    const accepted = kinds.filter(accepts);
    const rejectedSet = new Set(accepted);
    result = { kinds: accepted, rejected: kinds.filter((kind) => !rejectedSet.has(kind)) };
  }
  KIND_SUPPORT.set(key, result);
  return result;
}

/** `valueKind` for a literal node kind, or `null` when it is not a literal. */
export function literalKindOf(
  descriptor: LanguageDescriptor,
  kind: string,
): "string" | "number" | "boolean" | null {
  if (descriptor.literalKinds.string.includes(kind)) return "string";
  if (descriptor.literalKinds.number.includes(kind)) return "number";
  if (descriptor.literalKinds.boolean.includes(kind)) return "boolean";
  return null;
}

/**
 * Walk up at most `depth` parents looking for one of `kinds`.
 *
 * Shared by the `isExported` predicates, which are the only place the engine
 * looks UP rather than tracking the enclosing stack on the way down — they run
 * once per declaration (tens per file), not once per node.
 */
export function ancestorOfKind(
  node: SyntaxNode,
  kinds: string[],
  depth = 3,
): SyntaxNode | null {
  let current = node.parent();
  for (let i = 0; current && i < depth; i++) {
    if (kinds.includes(current.kind())) return current;
    current = current.parent();
  }
  return null;
}
