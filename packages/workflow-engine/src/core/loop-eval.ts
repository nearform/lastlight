/**
 * Minimal expression evaluator for generic loop `until` conditions.
 *
 * Supported forms:
 *   output.contains('text')   — true if the output string contains 'text'
 *   variable == 'value'       — equality check against the context map
 *   variable != 'value'       — inequality check against the context map
 *
 * Deliberately limited to avoid eval() and expression-injection risk.
 * Complex conditions should use until_bash instead.
 */

export interface LoopEvalContext {
  output: string;
  /**
   * Flattened key/value store. Values are serialized to strings for the
   * quoted-literal comparison; the `true`/`false` bare-literal path
   * special-cases boolean-ish values ("true", "false", "1", "0").
   * Dotted keys (e.g. `scratch.socratic.ready`) are resolved by reading
   * the first segment from top level and walking the rest through nested
   * objects.
   */
  [key: string]: unknown;
}

/** Walk a dotted path through the eval context. */
function readPath(ctx: LoopEvalContext, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = ctx[parts[0]];
  for (let i = 1; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, parts[i])) return undefined;
    cur = (cur as Record<string, unknown>)[parts[i]];
  }
  return cur;
}

function coerceBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const lower = v.toLowerCase();
    return lower === "true" || lower === "1" || lower === "yes";
  }
  return false;
}

/**
 * Evaluate a single until expression against the given context.
 * Returns false (safe default) for any unrecognised expression.
 */
export function evalUntilExpression(expr: string, ctx: LoopEvalContext): boolean {
  const trimmed = expr.trim();

  // output.contains('text') or output.contains("text")
  const containsMatch = trimmed.match(/^output\.contains\(['"](.+)['"]\)$/);
  if (containsMatch) {
    return String(ctx.output ?? "").includes(containsMatch[1]);
  }

  // dotted.path == true / == false / != true / != false (bare boolean literal)
  const boolMatch = trimmed.match(/^([\w.]+)\s*(==|!=)\s*(true|false)$/);
  if (boolMatch) {
    const [, key, op, lit] = boolMatch;
    const actual = coerceBool(readPath(ctx, key));
    const expected = lit === "true";
    return op === "==" ? actual === expected : actual !== expected;
  }

  // dotted.path == 'value' or dotted.path == "value"
  const eqMatch = trimmed.match(/^([\w.]+)\s*==\s*['"](.+)['"]$/);
  if (eqMatch) {
    const [, key, value] = eqMatch;
    const v = readPath(ctx, key);
    return String(v ?? "") === value;
  }

  // dotted.path != 'value' or dotted.path != "value"
  const neqMatch = trimmed.match(/^([\w.]+)\s*!=\s*['"](.+)['"]$/);
  if (neqMatch) {
    const [, key, value] = neqMatch;
    const v = readPath(ctx, key);
    if (v === undefined) return false; // absent variable — safe default
    return String(v) !== value;
  }

  // Unrecognised — safe default
  return false;
}
