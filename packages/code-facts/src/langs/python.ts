/**
 * Python — tree-sitter-python through `@ast-grep/lang-python` (a DYNAMIC
 * grammar, see `dynamic.ts`). Tier 2 only: name matching, never type-aware.
 *
 * Table read off the grammar's `src/node-types.json` (0.25.0):
 *
 *   function_definition  name: identifier   — a method when a class_definition
 *                                             immediately encloses it
 *   class_definition     name: identifier
 *   assignment           left: pattern      — module-level only: a local is not
 *                                             a symbol anybody reviews
 *   call                 function: primary_expression
 *
 * **`constantDeclarations` is EMPTY on purpose.** Python has no immutability
 * syntax — `MAX = 3600` and `count = 0` are the same node — so a constant rule
 * would have to be a naming convention (`UPPER_CASE`), and `constants` stays
 * TS/JS-only anyway (its literal sweep is scoped to the `tsjs` family; see
 * `constants.ts`). Adding one is its own change with its own measurement.
 */
import { PYTHON_TEST_PATH_RE } from "../project.js";
import type { DeclarationRule, LanguageDescriptor, SyntaxNode } from "./descriptor.js";

const DECLARATIONS: DeclarationRule[] = [
  {
    kind: "function_definition",
    nameField: "name",
    symbolKind: "function",
    memberOf: [{ kinds: ["class_definition"], symbolKind: "method" }],
    extendToParent: ["decorated_definition"],
  },
  {
    kind: "class_definition",
    nameField: "name",
    symbolKind: "class",
    qualifyBy: ["class_definition"],
    extendToParent: ["decorated_definition"],
  },
  {
    kind: "assignment",
    nameField: "left",
    symbolKind: "variable",
    // `a, b = pair` and `self.x = 1` bind no single module-level name.
    nameKinds: ["identifier"],
    topLevelOnly: true,
  },
];

/**
 * Visible outside its module, by convention: no leading underscore on the name
 * or on any class it is qualified by, and not nested inside a function (a
 * closure is not importable). Dunder methods (`__init__`, `__eq__`) are the
 * protocol surface and count as public.
 */
function isExported(name: string, node: SyntaxNode): boolean {
  const privateName = (n: string): boolean => n.startsWith("_") && !/^__\w+__$/.test(n);
  if (privateName(name)) return false;
  for (let current = node.parent(); current; current = current.parent()) {
    const kind = current.kind();
    if (kind === "function_definition") return false;
    if (kind === "class_definition") {
      const className = current.field("name")?.text() ?? "";
      if (privateName(className)) return false;
    }
  }
  return true;
}

/** pytest's two file spellings, plus anything under a `test/` or `tests/` directory. */
const PYTHON_TEST_DIR_RE = /(^|[/\\])tests?[/\\]|(^|[/\\])conftest\.py$/;

export const PYTHON_DESCRIPTOR: LanguageDescriptor = {
  id: "python",
  family: "python",
  astGrepLang: "python",
  dynamic: true,
  extensions: [".py"],
  declarations: DECLARATIONS,
  constantDeclarations: [],
  referenceKinds: ["identifier"],
  literalKinds: {
    string: ["string"],
    number: ["integer", "float"],
    boolean: ["true", "false"],
  },
  callKind: "call",
  importKinds: ["import_statement", "import_from_statement", "future_import_statement"],
  isExported,
  isTestPath: (path) => PYTHON_TEST_PATH_RE.test(path) || PYTHON_TEST_DIR_RE.test(path),
};
