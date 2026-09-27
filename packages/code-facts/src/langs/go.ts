/**
 * Go — tree-sitter-go through `@ast-grep/lang-go` (a DYNAMIC grammar, see
 * `dynamic.ts`). Tier 2 only: name matching, never type-aware.
 *
 * Table read off the grammar's `src/node-types.json`:
 *
 *   function_declaration  name: identifier
 *   method_declaration    name: field_identifier, receiver: parameter_list —
 *                         qualified by the receiver's type, so
 *                         `func (s *Service) Run()` is `Service.Run`
 *   type_spec             name: type_identifier, type: struct_type |
 *                         interface_type | … — `struct` / `interface` / `type`
 *   type_alias            name: type_identifier            (`type A = B`)
 *   method_elem           name: field_identifier — an interface's method
 *   const_spec / var_spec name*: identifier — package-level only
 *   call_expression       function: _expression
 *
 * `package_identifier` (the `fmt` in `fmt.Println`) is deliberately NOT a
 * reference kind: it names an import, never a declaration in this repository.
 */
import { GO_TEST_PATH_RE } from "../project.js";
import type { ConstantRule, DeclarationRule, LanguageDescriptor } from "./descriptor.js";

const DECLARATIONS: DeclarationRule[] = [
  { kind: "function_declaration", nameField: "name", symbolKind: "function" },
  {
    kind: "method_declaration",
    nameField: "name",
    symbolKind: "method",
    receiver: { field: "receiver", kind: "type_identifier" },
  },
  {
    kind: "type_spec",
    nameField: "name",
    symbolKind: "type",
    refineKind: { field: "type", map: { struct_type: "struct", interface_type: "interface" } },
  },
  { kind: "type_alias", nameField: "name", symbolKind: "type" },
  {
    kind: "method_elem",
    nameField: "name",
    symbolKind: "interface-method",
    qualifyBy: ["type_spec"],
  },
  // `const_spec`'s `name` field is MULTIPLE (`const a, b = 1, 2`); `field()`
  // returns the first. The rest are still references, which is what they are
  // to everything else.
  { kind: "const_spec", nameField: "name", symbolKind: "variable", nameKinds: ["identifier"], topLevelOnly: true },
  { kind: "var_spec", nameField: "name", symbolKind: "variable", nameKinds: ["identifier"], topLevelOnly: true },
];

/**
 * `const` IS Go's immutability syntax, and it lives on the spec's own kind, so
 * no enclosing test is needed. Unused while `constants` is scoped to `tsjs`
 * (see `constants.ts`), but it is the row that extractor would read.
 */
const CONSTANTS: ConstantRule[] = [
  { kind: "const_spec", nameField: "name", valueField: "value", enclosingKind: null, enclosingTextRe: null },
];

/** Go's export rule is the whole rule: an upper-case first letter. */
function isExported(name: string): boolean {
  const first = name.charAt(0);
  return first !== "" && first === first.toUpperCase() && first !== first.toLowerCase();
}

export const GO_DESCRIPTOR: LanguageDescriptor = {
  id: "go",
  family: "go",
  astGrepLang: "go",
  dynamic: true,
  extensions: [".go"],
  declarations: DECLARATIONS,
  constantDeclarations: CONSTANTS,
  referenceKinds: ["identifier", "field_identifier", "type_identifier"],
  literalKinds: {
    string: ["interpreted_string_literal", "raw_string_literal"],
    number: ["int_literal", "float_literal"],
    boolean: ["true", "false"],
  },
  callKind: "call_expression",
  importKinds: ["import_declaration"],
  isExported,
  isTestPath: (path) => GO_TEST_PATH_RE.test(path),
};
