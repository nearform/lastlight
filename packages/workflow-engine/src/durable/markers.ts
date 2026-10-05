/**
 * Typed readers for the status lines agents and gate scripts print (spike).
 *
 * The YAML engine decides `contains_BLOCKED` with
 * `output.toUpperCase().includes("BLOCKED")` — any mention of the word anywhere
 * (a quoted earlier report, "not BLOCKED") flips the verdict. Here the verdict
 * is the first line that STARTS with a known status token, and "no verdict" is
 * an explicit, typed outcome the workflow must handle.
 */

export function readStatusLine<S extends string>(output: string, statuses: readonly S[]): S | undefined {
  for (const raw of output.split("\n")) {
    const line = raw.trim().replace(/^\*\*|\*\*$/g, "");
    const hit = statuses.find((s) => line === s || line.startsWith(`${s} `) || line.startsWith(`${s}:`) || line.startsWith(`${s} —`));
    if (hit) return hit;
  }
  return undefined;
}
