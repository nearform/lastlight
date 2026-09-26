/**
 * Per-phase `command_policy` (issue #403): which classes of bash command an
 * agent phase may run — `allow`, `log` (run it, record it) or `block` (refuse
 * it with a model-facing reason).
 *
 * The enforcement lives in agentic-pi (a pi `tool_call` extension with the
 * pattern table). This package is a leaf that cannot depend on it, so the
 * class/mode vocabulary is restated here; core hands the RESOLVED policy to
 * agentic-pi, whose parser refuses anything this schema would not have.
 *
 * ```yaml
 * command_policy:
 *   install: block
 *   test: { from: probeTestPolicy }   # a mode read from the run context
 * ```
 *
 * A mode may be templated for the same reason a budget may be
 * (`templated-number.ts`): the right answer can depend on config the workflow
 * YAML cannot see. `falsify` may run a targeted test only when `prepare`
 * installed the tree (`review.analysis.probes: full`); under `static` a test
 * run cannot work, so it is blocked. Core seeds the key; the YAML names it.
 */

import { z } from "zod";
import { lookupContextKey, type TemplateContext } from "./templates.js";
import { noopLogger, type LoggerPort } from "../ports/ports.js";

export const COMMAND_POLICY_MODES = ["allow", "log", "block"] as const;
export type CommandPolicyMode = (typeof COMMAND_POLICY_MODES)[number];

const ModeSchema = z.enum(COMMAND_POLICY_MODES);

const TemplatedModeSchema = z.union([
  ModeSchema,
  z
    .object({
      /** Dotted path into the run's template context. */
      from: z.string().min(1),
      /** Used when `from` resolves to nothing usable; omit it and that is an error. */
      default: ModeSchema.optional(),
    })
    .strict(),
]);

export type TemplatedMode = z.infer<typeof TemplatedModeSchema>;

/**
 * `.strict()`, so an unknown class (`tests:`, `network:`) is a load error naming
 * the workflow — a typo that silently allowed everything would look exactly like
 * a policy that works. Absent classes are `allow`, except `install-scratch`
 * (an install whose directory is outside the checkout), which falls back to
 * `install`.
 */
export const CommandPolicySchema = z
  .object({
    install: TemplatedModeSchema.optional(),
    "install-scratch": TemplatedModeSchema.optional(),
    test: TemplatedModeSchema.optional(),
    /** A command reaching outside the workspace (issue #404). */
    host: TemplatedModeSchema.optional(),
    /** Replaces the model-facing text a blocked call returns. */
    reason: z.string().min(1).optional(),
  })
  .strict();

export type CommandPolicySpec = z.infer<typeof CommandPolicySchema>;

/** A policy with every mode resolved — what `ExecutorConfig.commandPolicy` carries. */
export type CommandPolicy = {
  install?: CommandPolicyMode;
  "install-scratch"?: CommandPolicyMode;
  test?: CommandPolicyMode;
  host?: CommandPolicyMode;
  reason?: string;
};

const CLASSES = ["install", "install-scratch", "test", "host"] as const;

function isMode(v: unknown): v is CommandPolicyMode {
  return typeof v === "string" && (COMMAND_POLICY_MODES as readonly string[]).includes(v);
}

/**
 * Resolve every templated mode against the run context. `undefined` in,
 * `undefined` out.
 *
 * - key present and a mode → that mode.
 * - key present and NOT a mode → throws, `default` or not: a config value
 *   of `"blok"` is a typo to surface, never a silent fallback.
 * - key absent → the `default` (at debug — absence is a designed state here,
 *   e.g. "the analysis pipeline is off, so nothing seeded it"); no `default`
 *   → throws, naming the key, like `resolveTemplatedNumber`.
 */
export function resolveCommandPolicy(
  spec: CommandPolicySpec | undefined,
  ctx: TemplateContext | undefined,
  /** Names the phase in errors and warnings, e.g. `falsify.command_policy`. */
  where: string,
  log: LoggerPort = noopLogger,
): CommandPolicy | undefined {
  if (!spec) return undefined;
  const out: CommandPolicy = {};
  for (const cls of CLASSES) {
    const value = spec[cls];
    if (value === undefined) continue;
    if (typeof value === "string") {
      out[cls] = value;
      continue;
    }
    const raw = ctx ? lookupContextKey(ctx, value.from) : undefined;
    if (isMode(raw)) {
      out[cls] = raw;
      continue;
    }
    if (raw !== undefined || value.default === undefined) {
      throw new Error(
        `${where}.${cls}: \`from: ${value.from}\` did not resolve to ${COMMAND_POLICY_MODES.join("|")} ` +
          `(got ${raw === undefined ? "nothing" : JSON.stringify(raw)})` +
          (raw === undefined ? " — there is no fallback" : ""),
      );
    }
    log.debug("templated command-policy mode absent from the run context — using default", {
      where: `${where}.${cls}`,
      from: value.from,
      default: value.default,
    });
    out[cls] = value.default;
  }
  if (spec.reason !== undefined) out.reason = spec.reason;
  return out;
}
