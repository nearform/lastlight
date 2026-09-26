/**
 * The pi extension that enforces a {@link CommandPolicy} on the bash tool
 * (lastlight#403).
 *
 * Pi's `tool_call` handler may return `{ block: true, reason }`: the model gets
 * the reason as the tool result and carries on, so a blocked install costs one
 * turn rather than the run. It fires for the host built-in bash and the
 * gondolin override alike — both are named `bash` — which is why this is an
 * extension and not a wrapper on one tool definition (compare gate-timeout.ts).
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { type ClassifyOptions, type CommandPolicy, decideCommand } from "./command-policy.js";

/** Long enough to read the command; short enough that a heredoc can't bloat the stream. */
const COMMAND_LIMIT = 2000;

/** The JSONL record emitted for every `log` or `block` decision. */
export interface CommandPolicyEvent {
  type: "command_policy";
  action: "log" | "block";
  class: string;
  pattern: string;
  command: string;
  [key: string]: unknown;
}

/**
 * The extension, or `undefined` when there is no policy to enforce (so a
 * default run registers nothing and its JSONL stays byte-identical).
 * `emit` is called once per non-`allow` match.
 */
export function commandPolicyGate(
  policy: CommandPolicy | undefined,
  cwd: string,
  emit: (event: CommandPolicyEvent) => void,
  /** Where the `host` class draws the workspace boundary — see {@link ClassifyOptions}. */
  options: ClassifyOptions = {},
): ExtensionFactory | undefined {
  if (!policy || !Object.keys(policy).some((k) => k !== "reason" && policy[k as keyof CommandPolicy] !== "allow")) {
    return undefined;
  }
  return (pi) => {
    pi.on("tool_call", (event) => {
      if (event.toolName !== "bash") return undefined;
      const command = (event.input as { command?: unknown }).command;
      if (typeof command !== "string") return undefined;
      const decision = decideCommand(policy, command, cwd, options);
      if (decision.action === "allow") return undefined;
      const action = decision.action;
      const shown = command.length > COMMAND_LIMIT ? `${command.slice(0, COMMAND_LIMIT - 1)}…` : command;
      for (const m of decision.matches) {
        emit({ type: "command_policy", action, class: m.cls, pattern: m.pattern, command: shown });
      }
      return action === "block" ? { block: true, reason: decision.reason } : undefined;
    });
  };
}
