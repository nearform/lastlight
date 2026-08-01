/**
 * Minimal expression evaluator for generic loop `until` conditions and
 * phase-level `skip_if` guards.
 *
 * Supported forms:
 *   output.contains('text')   — true if the output string contains 'text'
 *   a.b.c.contains('text')    — same, against any dotted path in the context
 *                               (`output` is just the degenerate one-segment case)
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

  // <dotted.path>.contains('text') — `output.contains(...)` is the one-segment
  // case (the only form the generic loop uses). A longer path lets a `skip_if`
  // read a *sibling* value the loop never needed, e.g.
  // `phaseOutputs.diagnosis.contains('class=flaky')`.
  const containsMatch = trimmed.match(/^([\w.]+)\.contains\(['"](.+)['"]\)$/);
  if (containsMatch) {
    const [, key, needle] = containsMatch;
    const v = readPath(ctx, key);
    // Strings/numbers only — stringifying an object yields "[object Object]",
    // which is a substring match waiting to surprise someone.
    if (typeof v !== "string" && typeof v !== "number") return false;
    return String(v).includes(needle);
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

/**
 * Evaluate a phase's `skip_if` guard against the run's render context.
 *
 * Returns the **first matching expression** (so the caller can name it in the
 * skip reason) or `undefined` when none match. The list is OR-ed: the
 * production consumer is "skip the fix phase when the diagnosis landed in any
 * of the non-fixable classes", where one expression per class reads as the
 * class list it is. AND is expressible by collapsing to a single expression.
 *
 * Safe defaults throughout — an unrecognised expression and an absent variable
 * both evaluate false, so a malformed or not-yet-populated guard **runs** the
 * phase rather than silently swallowing it.
 */
export function evalSkipIf(
  expressions: readonly string[],
  ctx: LoopEvalContext,
): string | undefined {
  return expressions.find((expr) => evalUntilExpression(expr, ctx));
}
