/**
 * The TypeScript / TSX / JavaScript descriptors.
 *
 * **This exists so the tier-2 path runs through the SAME code a second language
 * would.** TS/JS is the only tier where a type-resolved reference set is also
 * available (ts-morph, tier 1), which makes it the only place a name-matched
 * reference set can be *measured* rather than argued about: build both over the
 * same symbols and diff them. `scripts/name-match-gate.ts` is that measurement,
 * and it is the reason this file was written before any new grammar was added —
 * a name-matching engine that turns out to be too noisy to ship costs 0 MB to
 * discover here and 36.5 MB to discover after four grammars are vendored.
 *
 * `@ast-grep/napi` already bundles the ts / tsx / js / jsx grammars, so nothing
 * here adds a dependency.
 *
 * Three descriptors rather than one, because they are three grammars:
 *
 *   - `typescript`  `.ts` `.mts` `.cts`
 *   - `tsx`         `.tsx` `.jsx`   — `.jsx` is parsed by the TSX grammar, which
 *                                     is what `astGrepLangFor` has always done:
 *                                     the JavaScript grammar does not accept JSX
 *   - `javascript`  `.js` `.mjs` `.cjs` `.es6`
 *
 * The three share one rule table (`RULES` below) because tree-sitter-typescript
 * is tree-sitter-javascript plus type syntax: every JS node kind is a TS node
 * kind, and a TS-only kind (`interface_declaration`) simply never matches in a
 * `.js` file. Duplicating the table per grammar is how `.es6` came to be missing
 * from one of the two extension tables this package used to carry.
 */
import { Lang } from "@ast-grep/napi";
import { JS_TEST_PATH_RE } from "../project.js";
import {
  ancestorOfKind,
  type ConstantRule,
  type DeclarationRule,
  type LanguageDescriptor,
  type LiteralKinds,
  type SyntaxNode,
} from "./descriptor.js";

/**
 * Every named declaration `facts` has ever emitted an obligation for, keyed by
 * grammar node kind.
 *
 * The `symbolKind` column is deliberately the SAME vocabulary tier 1 uses
 * (`facts.candidatesIn`), so a consumer reading a tier-2 document does not meet
 * a second set of words for the same things. Two kinds tier 1 distinguishes
 * with a type query — `abstract-method` and `interface-method` — are distinct
 * node kinds here, so the distinction survives.
 */
const DECLARATIONS: DeclarationRule[] = [
  { kind: "function_declaration", nameField: "name", symbolKind: "function" },
  { kind: "generator_function_declaration", nameField: "name", symbolKind: "function" },
  { kind: "class_declaration", nameField: "name", symbolKind: "class" },
  { kind: "abstract_class_declaration", nameField: "name", symbolKind: "class" },
  { kind: "interface_declaration", nameField: "name", symbolKind: "interface" },
  { kind: "type_alias_declaration", nameField: "name", symbolKind: "type" },
  { kind: "enum_declaration", nameField: "name", symbolKind: "enum" },
  {
    kind: "method_definition",
    nameField: "name",
    symbolKind: "method",
    qualifyBy: ["class_declaration", "abstract_class_declaration"],
  },
  {
    kind: "abstract_method_signature",
    nameField: "name",
    symbolKind: "abstract-method",
    qualifyBy: ["abstract_class_declaration", "class_declaration"],
  },
  {
    kind: "method_signature",
    nameField: "name",
    symbolKind: "interface-method",
    qualifyBy: ["interface_declaration"],
  },
  {
    kind: "public_field_definition",
    nameField: "name",
    symbolKind: "property",
    qualifyBy: ["class_declaration", "abstract_class_declaration"],
  },
  {
    kind: "variable_declarator",
    nameField: "name",
    symbolKind: "variable",
    // `const { a, b } = obj` binds no single name, and a local inside a
    // function body is not a symbol anybody takes an obligation about. Both
    // exclusions mirror the type-aware engine exactly — see `DeclarationRule`.
    nameKinds: ["identifier"],
    topLevelOnly: true,
  },
];

/**
 * A `variable_declarator` is a constant only under a `const`
 * `lexical_declaration` — under `let` the declarator node is byte-identical, so
 * the keyword is the only signal and it lives on the parent.
 */
const CONSTANTS: ConstantRule[] = [
  {
    kind: "variable_declarator",
    nameField: "name",
    valueField: "value",
    enclosingKind: "lexical_declaration",
    enclosingTextRe: /^const\b/,
  },
];

/**
 * Every kind that is an occurrence of a NAME.
 *
 * `property_identifier` is in the list and it is the honest half of what name
 * matching is: `config.limit` and a `limit` field on an unrelated class are the
 * same string, and this layer cannot tell them apart. It is included rather
 * than dropped because dropping it would silently lose `service.run()` — the
 * ordinary call site of every changed method — and an under-approximation that
 * looks precise is worse than an over-approximation that is labelled. What
 * labels it is `nameAmbiguity`.
 */
const REFERENCE_KINDS = [
  "identifier",
  "type_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
];

/**
 * `template_string` is deliberately ABSENT.
 *
 * Set B (`constants`) has always been built from exactly these four kinds, and
 * a backtick literal is a `template_string`, so adding it here would silently
 * widen `hardCodedDuplicates` on every repo — a change to a shipped extractor's
 * output smuggled in under a refactor. If it should be there it is its own
 * change, with its own measurement.
 */
const LITERAL_KINDS: LiteralKinds = {
  string: ["string"],
  number: ["number"],
  boolean: ["true", "false"],
};

/**
 * `export`-ness, from the syntax alone.
 *
 * A declaration is exported when an `export_statement` encloses it — directly
 * for a function or class, one level further for a `variable_declarator` (which
 * sits inside a `lexical_declaration`) and for a class member (which sits
 * inside a `class_body`).
 *
 * What this does NOT see: `module.exports = …`, `export { x }` at the bottom of
 * the file, and a re-export through a barrel. All three are references rather
 * than declaration syntax, so a symbol reached that way still gets a reference
 * set; only the `exported` flag under-reports. That is the right direction for
 * a field a seeder uses to RANK — an over-claimed `exported: true` invites an
 * obligation about a cross-package contract that does not exist.
 */
function isExported(_name: string, node: SyntaxNode): boolean {
  return ancestorOfKind(node, ["export_statement"], 4) !== null;
}

function descriptor(id: string, astGrepLang: Lang, extensions: string[]): LanguageDescriptor {
  return {
    id,
    astGrepLang,
    extensions,
    declarations: DECLARATIONS,
    constantDeclarations: CONSTANTS,
    referenceKinds: REFERENCE_KINDS,
    literalKinds: LITERAL_KINDS,
    callKind: "call_expression",
    isExported,
    isTestPath: (path) => JS_TEST_PATH_RE.test(path),
  };
}

export const TYPESCRIPT_DESCRIPTOR = descriptor("typescript", Lang.TypeScript, [
  ".ts",
  ".mts",
  ".cts",
]);

/** `.jsx` too: the JavaScript grammar does not accept JSX, and the TSX one does. */
export const TSX_DESCRIPTOR = descriptor("tsx", Lang.Tsx, [".tsx", ".jsx"]);

export const JAVASCRIPT_DESCRIPTOR = descriptor("javascript", Lang.JavaScript, [
  ".js",
  ".mjs",
  ".cjs",
  ".es6",
]);

export const TSJS_DESCRIPTORS: LanguageDescriptor[] = [
  TYPESCRIPT_DESCRIPTOR,
  TSX_DESCRIPTOR,
  JAVASCRIPT_DESCRIPTOR,
];
