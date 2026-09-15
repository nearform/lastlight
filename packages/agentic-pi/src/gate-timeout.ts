/**
 * Gate-command timeout guidance + hardening for the bash tool (lastlight#385).
 *
 * Pi's bash `timeout` is an optional, model-chosen per-call value with no
 * default. Models pick chat-sized numbers (60–300s) for full test suites and
 * installs, cut their own runs off, then loop retrying with bigger values. When
 * the caller passes `gateTimeoutSeconds`, we (a) add one prompt guideline to the
 * bash tool telling the model which timeout to use for gate commands and to
 * judge them by exit code, and (b) raise any smaller model-supplied timeout on a
 * recognisable install/build/test command up to the gate value.
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
    "timed-out gate command with a larger timeout; report it as timed out."
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
 * The timeout to actually use: a model timeout below the gate value on a gate
 * command is raised to it. An absent timeout (no limit) is left alone.
 */
export function resolveGateTimeout(
  command: string,
  timeout: number | undefined,
  gateTimeoutSeconds: number,
): number | undefined {
  if (timeout === undefined || timeout >= gateTimeoutSeconds) return timeout;
  return isGateCommand(command) ? gateTimeoutSeconds : timeout;
}

/** Wrap a bash ToolDefinition with the gate guideline and timeout floor. */
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
