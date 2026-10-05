/**
 * Behaviour-preserving helpers for workflows MACHINE-CONVERTED from YAML
 * (`scripts/yaml-to-ts.mjs`). Each one reproduces a quirk of the YAML
 * expression evaluator (`core/loop-eval.ts`) or output rules exactly, so a
 * converted workflow behaves like its YAML original. Hand-written workflows
 * should use plain TypeScript instead; these are a migration aid, and every
 * call site is a place to simplify once the port is reviewed.
 */

import type { WorkflowContext } from "./context.js";

const str = (v: unknown): string | undefined => (typeof v === "string" || typeof v === "number" ? String(v) : undefined);

/** `path.contains('x')` — false unless the value is a string/number. */
export const yContains = (v: unknown, needle: string): boolean => str(v)?.includes(needle) ?? false;
/** `path.startsWith('x')` — leading whitespace ignored. */
export const yStartsWith = (v: unknown, needle: string): boolean => str(v)?.trimStart().startsWith(needle) ?? false;
/** `path == true|false` — "true"/"1"/"yes" coerce; a MISSING key is `false`. */
export function yBool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return ["true", "1", "yes"].includes(v.toLowerCase());
  return false;
}
/** `path == 'x'` — a missing key compares as "". */
export const yEq = (v: unknown, value: string): boolean => String(v ?? "") === value;
/** `path != 'x'` — a MISSING key is `false` (the opposite polarity of `!= true`). */
export const yNeq = (v: unknown, value: string): boolean => (v === undefined ? false : String(v) !== value);

/** `on_output.contains_BLOCKED` — any case-insensitive occurrence of the word, anywhere. */
export const yBlocked = (output: string): boolean => output.toUpperCase().includes("BLOCKED");

/** `contains_BLOCKED.unless_label` / `unless_title_matches` bypass. */
export function yBlockedBypassed(ctx: WorkflowContext, unlessLabel?: string, unlessTitle?: string): boolean {
  const labels = Array.isArray(ctx.vars.issueLabels) ? ctx.vars.issueLabels : [];
  if (unlessLabel && labels.includes(unlessLabel)) return true;
  if (unlessTitle) return new RegExp(unlessTitle, "i").test(String(ctx.vars.issueTitle ?? ""));
  return false;
}

export type YPhaseStatus = "succeeded" | "failed" | "skipped";

/**
 * The YAML DAG trigger rule (`core/dag.ts`). NB a workflow with no
 * `depends_on` is a synthesized chain where every phase is `all_success` on
 * its predecessor — so ONE skipped phase skips everything after it.
 */
export function yTrigger(
  rule: "all_success" | "one_success" | "none_failed" | "none_failed_min_one_success" | "all_done",
  deps: readonly string[],
  st: Readonly<Record<string, YPhaseStatus>>,
): boolean {
  if (deps.length === 0) return true;
  const s = deps.map((d) => st[d]);
  switch (rule) {
    case "all_success":
      return s.every((x) => x === "succeeded");
    case "one_success":
      return s.some((x) => x === "succeeded");
    case "none_failed":
      return !s.includes("failed") && s.every((x) => x !== undefined);
    case "none_failed_min_one_success":
      return !s.includes("failed") && s.includes("succeeded");
    case "all_done":
      return s.every((x) => x !== undefined);
  }
}

/** Dotted-path read over a plain object (the `phaseOutputs.X.y` half of a YAML path). */
export function yGet(root: unknown, path: string): unknown {
  let cur = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}
