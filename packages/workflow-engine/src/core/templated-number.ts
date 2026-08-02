/**
 * A numeric phase budget that may be READ FROM THE RUN'S CONTEXT rather than
 * frozen in the YAML.
 *
 * ## Why this exists
 *
 * `fix.localIterations` and `fix.gateTimeoutSeconds` were parsed, typed,
 * clamped per repository, displayed by the CLI and documented on both doc
 * surfaces — and read by nothing (issue #256). The two numbers that actually
 * governed the fix loop were the literals in `workflows/pr-fix.yaml` and
 * `workflows/dependabot-ci-fix.yaml`, whose comments asked the reader to "keep
 * the two in step by hand". A config key whose only effect is to disagree with
 * the running value is worse than no key: the admin panel, `lastlight repo
 * config show` and a repo's `.lastlight/lastlight.yml` all reported a budget
 * the loop was not running under.
 *
 * ## The shape, and why it is not a bare `{{template}}`
 *
 * ```yaml
 * timeout_seconds: { from: fix.gateTimeoutSeconds, default: 900 }
 * generic_loop:
 *   max_iterations: { from: fix.localIterations, default: 2 }
 * ```
 *
 * A bare `"{{fix.gateTimeoutSeconds}}"` would have been shorter and worse.
 * `renderTemplate` resolves an absent key to the EMPTY STRING, so every
 * unresolvable reference would need an invented fallback somewhere in the
 * engine — a made-up number for a phase's kill timeout, chosen far from the
 * workflow that depends on it. Here the fallback is stated by the workflow
 * itself, next to the reference, and it is the packaged value: the YAML still
 * says what this loop does out of the box, and the `from:` says where a
 * deployment or a repository may move it. (It also keeps `{{` out of a field
 * neighbouring `generic_loop.until_bash`, which `validateShellCommand` rejects
 * outright.)
 *
 * ## What resolution guarantees
 *
 * The `from:` path is looked up in the run's template context — the same
 * two-level dot walk `{{a.b}}` uses, so `fix.localIterations` resolves against
 * the EFFECTIVE, already repo-clamped `fix` block seeded on the context by the
 * runner. A repo that lowered its own budget is honoured for free; a repo that
 * tried to raise it was clamped before it ever reached here.
 *
 * Anything else — key absent, non-numeric, zero, negative, `NaN` — falls back
 * to `default` and warns. It never throws and never yields a non-positive
 * number, because both consumers are a kill timeout and a loop bound, where
 * `0` means "never run" and a negative means nothing at all.
 */

import { z } from "zod";
import { lookupContextKey, type TemplateContext } from "./templates.js";
import { noopLogger, type LoggerPort } from "../ports/ports.js";

/**
 * A phase budget: a literal, or a reference into the run context with the
 * packaged value as its declared fallback.
 *
 * `.strict()` on the object arm so a typo (`form:`, `defaults:`) is a load
 * error naming the workflow, not a silent fall back to a default the author
 * never meant to be operative.
 */
export const TemplatedNumberSchema = z.union([
  z.number().int().positive(),
  z
    .object({
      /** Dotted path into the run's template context, e.g. `fix.localIterations`. */
      from: z.string().min(1),
      /** The packaged value — used verbatim when `from` resolves to nothing usable. */
      default: z.number().int().positive(),
    })
    .strict(),
]);

export type TemplatedNumber = z.infer<typeof TemplatedNumberSchema>;

/**
 * Resolve a {@link TemplatedNumber} against a run's context.
 *
 * `undefined` in, `undefined` out — the fields this governs are optional and
 * their callers supply their own absent-value behaviour (`?? 30` for a
 * command phase's timeout).
 *
 * A resolved non-integer is rounded UP rather than rejected: the only duration
 * key that reaches here (`fix.gateTimeoutSeconds`) is documented as accepting
 * any positive number, and truncating a test-suite budget downward is the one
 * rounding direction that can turn a passing gate red.
 */
export function resolveTemplatedNumber(
  value: TemplatedNumber | undefined,
  ctx: TemplateContext,
  /** Names the phase/field in the warning, e.g. `fix.timeout_seconds`. */
  where: string,
  /** Structured logger for the misresolve warning; silent by default. */
  log: LoggerPort = noopLogger,
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;

  const raw = lookupContextKey(ctx, value.from);
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) {
    // Not an error: a workflow may legitimately run in a context that carries
    // no `fix` block (a manual trigger, a resumed pre-upgrade run). The warning
    // is what stops a MISSPELLED `from:` from looking identical to that.
    log.warn("templated number did not resolve to a positive number — using default", {
      where,
      from: value.from,
      default: value.default,
    });
    return value.default;
  }
  return Math.ceil(n);
}
