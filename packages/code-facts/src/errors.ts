/**
 * The fail-loud contract.
 *
 * The failure this package is engineered against is a tool that cannot see the
 * sources and reports success anyway: dependency-cruiser refused to parse
 * TS >= 7 and EXITED 0, so the import-boundary gate was green while seeing
 * nothing (root `CLAUDE.md`). A silently-empty obligation list is that bug with
 * a green pipeline.
 *
 * So there are two loudness surfaces, and they are not the same surface:
 *
 *   - THE EXIT CODE, below. Right when a human or a test runs the CLI.
 *   - THE ENVELOPE (`schema.ts`) — `coverage` + `degraded[]` + the toolchain
 *     stamp. Right when a workflow phase runs it.
 *
 * Design review §D12 is why they had to be separated. `cron-review.yaml` runs
 * every thirty minutes, and `assessedHeadShaByWorkflow` — the only thing that stops it
 * re-dispatching a PR forever — is populated from SUCCEEDED runs only
 * (`pr-decisions.ts:918`, whose comment records the 1260-execution /
 * $1.30-an-hour incident). A `facts` phase that exits non-zero fails the run,
 * records nothing, is re-dispatched in thirty minutes and exits non-zero again,
 * forever, at 2–3x the cost of that incident.
 *
 * Hence `--never-fail` (see `cli.ts`): the phase wrapper catches the non-zero
 * exit, writes the envelope with `coverage: "none"` and a populated
 * `degraded[]`, and returns 0. Locked decision 6's actual requirement is that
 * an empty obligation list and an unavailable analyser must never be
 * indistinguishable — the envelope satisfies that completely. THE EXIT CODE WAS
 * NEVER WHAT MADE IT LOUD.
 */

/** Analysis ran and the result is trustworthy. */
export const EXIT_OK = 0;
/** Analysis could not run. Nothing downstream may read this as "no findings". */
export const EXIT_UNAVAILABLE = 2;
/** Analysis ran in a degraded tier — results PLUS a populated `degraded[]`. */
export const EXIT_DEGRADED = 3;

export type ExitCode = typeof EXIT_OK | typeof EXIT_UNAVAILABLE | typeof EXIT_DEGRADED;

/**
 * A named reason the analysis could not run. The `reason` is what lands in the
 * envelope's `degraded[]`, so it is written for a reader deciding whether an
 * empty result means "clean" or "blind" — never a bare stack trace.
 */
export class FactsError extends Error {
  readonly extractor: string;
  readonly exitCode: ExitCode;

  constructor(extractor: string, message: string, exitCode: ExitCode = EXIT_UNAVAILABLE) {
    super(message);
    this.name = "FactsError";
    this.extractor = extractor;
    this.exitCode = exitCode;
  }
}

/** `unknown` from a catch block → a one-line reason string, never `[object Object]`. */
export function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
