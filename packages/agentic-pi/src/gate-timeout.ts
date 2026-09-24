/**
 * Gate-command timeout guidance + hardening for the bash tool (lastlight#385).
 *
 * Pi's bash `timeout` is an optional, model-chosen per-call value with no
 * default. Models pick chat-sized numbers (60–300s) for full test suites and
 * installs, cut their own runs off, then loop retrying with bigger values. When
 * the caller passes `gateTimeoutSeconds`, we (a) add one prompt guideline to the
 * bash tool telling the model which timeout to use for gate commands and to
 * judge them by exit code, and (b) CLAMP the model-supplied timeout to the gate
 * value — raising it on a recognisable install/build/test command, and lowering
 * anything above it.
 *
 * **The gate value is a ceiling, not just a floor** (2026-09-22). Pi's schema
 * documents `timeout` as "optional, no default timeout", and an omitted one
 * really does mean *no limit*: a `review-falsify` probe ran
 * `npx eslint --inspect-config`, which starts a web server that never exits,
 * and wedged one eval case for **7.5 hours** before it was killed by hand. The
 * model never chose that — it simply never passed a `timeout`, which is the
 * overwhelmingly common case. So an absent timeout now becomes the gate value
 * rather than infinity, and that single rule is what bounds every bash call the
 * agent makes. `gateTimeoutSeconds` is the right number to bound it with
 * because it is already defined as the budget for the LONGEST legitimate
 * command class (a full install / build / test suite); nothing an agent runs
 * has a reason to outlive it.
 *
 * Killing is Pi's job and it already does it correctly: `core/tools/bash.js`
 * spawns with `detached: true` and calls `killProcessTree(child.pid)` on
 * timeout, so the whole process GROUP dies, not just the shell. That is why
 * this fix is a number and not a kill implementation — the reaper was always
 * there, nothing was ever scheduled to fire it.
 *
 * Implemented by wrapping the bash ToolDefinition (promptGuidelines + execute)
 * rather than a system-prompt append, so the guidance travels with the tool and
 * applies identically to Pi's host bash and the gondolin VM bash.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyToolDefinition = ToolDefinition<any, any, any>;

export function gateTimeoutGuideline(seconds: number): string {
  return (
    `Installs, builds and full test suites: pass \`timeout: ${seconds}\` and run as ` +
    "`<cmd> > /tmp/gate.log 2>&1; echo EXIT=$?` — the exit code is the verdict; read the log " +
    "tail only to diagnose. Short timeouts are for quick commands only. Never re-run a " +
    "timed-out gate command with a larger timeout; report it as timed out. " +
    `Every command is capped at ${seconds}s whether or not you pass a timeout, so never run ` +
    "anything that does not exit on its own — no servers, watchers, inspectors or REPLs; use " +
    "the flag that makes the tool run once and exit (`--run`, `--no-watch`, `--list`, …)."
  );
}

// Package-manager verbs may be preceded by flags (`pnpm --filter pkg test`,
// `npm --prefix dir ci`) — the form that timed out in the #385 run.
const PM_FLAGS = String.raw`(?:\s+--?[\w-]+(?:[=\s]+(?!-)\S+)?)*?`;
const GATE_COMMAND = new RegExp(
  String.raw`\b(?:npm|pnpm|yarn|bun)${PM_FLAGS}\s+(?:ci|install|i|test|run\s+(?:test|build|typecheck|lint)|exec\s+(?:vitest|jest|tsc))\b` +
    String.raw`|\b(?:vitest|jest|pytest|cargo\s+(?:test|build)|go\s+test|make\s+(?:test|build))\b` +
    String.raw`|\bturbo\s+run\b`,
);

/** True when `command` is clearly an install / build / test-suite run. */
export function isGateCommand(command: string): boolean {
  return GATE_COMMAND.test(command);
}

/**
 * The timeout to actually use — the model's value CLAMPED to the gate budget.
 *
 * - absent (Pi: "no default timeout", i.e. run forever) ⇒ the gate value. This
 *   is the hang fix; see the module doc.
 * - a gate command below the gate value ⇒ raised to it (the #385 behaviour).
 * - anything above the gate value ⇒ lowered to it. An operator who needs a
 *   longer command raises `gate.timeoutSeconds`, which is the one number that
 *   already means "the longest a single command may run".
 * - anything else ⇒ left exactly as the model asked.
 *
 * Never returns `undefined`: every bash call the agent makes is bounded.
 */
export function resolveGateTimeout(
  command: string,
  timeout: number | undefined,
  gateTimeoutSeconds: number,
): number {
  if (timeout === undefined) return gateTimeoutSeconds;
  if (isGateCommand(command)) return gateTimeoutSeconds;
  return Math.min(timeout, gateTimeoutSeconds);
}

/** Wrap a bash ToolDefinition with the gate guideline and the timeout clamp. */
export function withGateTimeout<T extends AnyToolDefinition>(tool: T, gateTimeoutSeconds: number): T {
  return {
    ...tool,
    promptGuidelines: [...(tool.promptGuidelines ?? []), gateTimeoutGuideline(gateTimeoutSeconds)],
    execute: (toolCallId, params, ...rest) => {
      const p = params as { command: string; timeout?: number };
      const timeout = resolveGateTimeout(p.command, p.timeout, gateTimeoutSeconds);
      return tool.execute(toolCallId, timeout === p.timeout ? params : { ...p, timeout }, ...rest);
    },
  };
}

/**
 * Apply the gate wrapper to the session's bash tool. Wraps a `bash` already in
 * `customTools` (the gondolin override); otherwise, when `builtinBash` is given
 * (Pi's host built-ins are active), appends a wrapped replacement — a custom
 * tool named `bash` supersedes the built-in in Pi's tool registry.
 */
export function applyGateTimeout(
  customTools: AnyToolDefinition[],
  gateTimeoutSeconds: number | undefined,
  builtinBash?: () => AnyToolDefinition,
): AnyToolDefinition[] {
  if (gateTimeoutSeconds === undefined) return customTools;
  if (customTools.some((t) => t.name === "bash")) {
    return customTools.map((t) => (t.name === "bash" ? withGateTimeout(t, gateTimeoutSeconds) : t));
  }
  return builtinBash ? [...customTools, withGateTimeout(builtinBash(), gateTimeoutSeconds)] : customTools;
}
