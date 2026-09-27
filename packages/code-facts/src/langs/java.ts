/**
 * Java — tree-sitter-java through `@ast-grep/lang-java` (a DYNAMIC grammar, see
 * `dynamic.ts`). Tier 2 only: name matching, never type-aware.
 *
 * Table read off the grammar's `src/node-types.json`:
 *
 *   class / interface / enum / record / annotation_type _declaration
 *                           name: identifier — nested types qualified
 *   method_declaration      name: identifier — `interface-method` directly
 *                           inside an interface
 *   constructor_declaration name: identifier
 *   variable_declarator     name: identifier — a FIELD only when its parent is
 *                           `field_declaration` / `constant_declaration`; the
 *                           same node under `local_variable_declaration` is a
 *                           local and is skipped
 *   method_invocation       object?: primary_expression, name: identifier —
 *                           the callee is `object.name`, there is no
 *                           `function` field (hence `calleeOf`)
 */
import { JAVA_TEST_PATH_RE } from "../project.js";
import type {
  ConstantRule,
  DeclarationRule,
  LanguageDescriptor,
  SyntaxNode,
} from "./descriptor.js";

const TYPE_KINDS = [
  "class_declaration",
  "interface_declaration",
  "enum_declaration",
  "record_declaration",
  "annotation_type_declaration",
];
const INTERFACE_KINDS = ["interface_declaration", "annotation_type_declaration"];

const DECLARATIONS: DeclarationRule[] = [
  { kind: "class_declaration", nameField: "name", symbolKind: "class", qualifyBy: TYPE_KINDS },
  { kind: "record_declaration", nameField: "name", symbolKind: "class", qualifyBy: TYPE_KINDS },
  { kind: "interface_declaration", nameField: "name", symbolKind: "interface", qualifyBy: TYPE_KINDS },
  { kind: "annotation_type_declaration", nameField: "name", symbolKind: "interface", qualifyBy: TYPE_KINDS },
  { kind: "enum_declaration", nameField: "name", symbolKind: "enum", qualifyBy: TYPE_KINDS },
  {
    kind: "method_declaration",
    nameField: "name",
    symbolKind: "method",
    qualifyBy: TYPE_KINDS,
    memberOf: [{ kinds: INTERFACE_KINDS, symbolKind: "interface-method" }],
  },
  { kind: "constructor_declaration", nameField: "name", symbolKind: "constructor", qualifyBy: TYPE_KINDS },
  {
    kind: "variable_declarator",
    nameField: "name",
    symbolKind: "property",
    qualifyBy: TYPE_KINDS,
    nameKinds: ["identifier"],
    parentKinds: ["field_declaration", "constant_declaration"],
  },
];

/**
 * `static final` on the enclosing `field_declaration` — both words, either
 * order, before the `=`. Unused while `constants` is scoped to `tsjs` (see
 * `constants.ts`), but it is the row that extractor would read.
 */
const CONSTANTS: ConstantRule[] = [
  {
    kind: "variable_declarator",
    nameField: "name",
    valueField: "value",
    enclosingKind: "field_declaration",
    enclosingTextRe: /^[^=]*\bstatic\b[^=]*\bfinal\b|^[^=]*\bfinal\b[^=]*\bstatic\b/,
  },
];

/** `a.b.c(x)` → `a.b.c`; a bare `run(x)` → `run`. */
function calleeOf(node: SyntaxNode): string | null {
  const name = node.field("name")?.text();
  if (!name) return null;
  const object = node.field("object")?.text();
  return object ? `${object}.${name}` : name;
}

/** The `modifiers` child of a declaration, when it has one. */
function modifiersOf(node: SyntaxNode): SyntaxNode | null {
  return node.children().find((child) => child.kind() === "modifiers") ?? null;
}

/**
 * `public` — on the declaration itself, or on the `field_declaration` around a
 * field's declarator. A member of an interface is implicitly public.
 */
function isExported(_name: string, node: SyntaxNode): boolean {
  const holder = node.kind() === "variable_declarator" ? node.parent() : node;
  if (holder === null) return false;
  const modifiers = modifiersOf(holder);
  if (modifiers !== null && /\bpublic\b/.test(modifiers.text())) return true;
  // interface_body → interface_declaration
  const body = holder.parent();
  const owner = body?.parent() ?? null;
  return body?.kind() === "interface_body" && owner !== null && INTERFACE_KINDS.includes(owner.kind());
}

export const JAVA_DESCRIPTOR: LanguageDescriptor = {
  id: "java",
  family: "java",
  astGrepLang: "java",
  dynamic: true,
  extensions: [".java"],
  declarations: DECLARATIONS,
  constantDeclarations: CONSTANTS,
  referenceKinds: ["identifier", "type_identifier"],
  literalKinds: {
    string: ["string_literal"],
    number: [
      "decimal_integer_literal",
      "hex_integer_literal",
      "octal_integer_literal",
      "binary_integer_literal",
      "decimal_floating_point_literal",
      "hex_floating_point_literal",
    ],
    boolean: ["true", "false"],
  },
  callKind: "method_invocation",
  calleeOf,
  importKinds: ["import_declaration"],
  isExported,
  isTestPath: (path) => JAVA_TEST_PATH_RE.test(path),
};
