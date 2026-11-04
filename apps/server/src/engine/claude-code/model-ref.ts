/**
 * The `claude-code` runtime is selected by a model reference, nothing else:
 * an operator who sets `models.<role>: claude-code/<model>` runs that role's
 * phases in the real, interactive Claude Code CLI inside the docker sandbox.
 * No default and no workflow names this prefix, so a deployment that never
 * writes one sees no change.
 */

export const CLAUDE_CODE_PREFIX = "claude-code/";

export interface ClaudeCodeConfig {
  /** Env var on the harness that holds the operator's `claude setup-token` token. */
  tokenEnv: string;
  /** How long the session may take to reach its input prompt. */
  readyTimeoutSeconds: number;
  /** A session whose transcript does not grow for this long is stalled. */
  stallMinutes: number;
  /** How often the harness checks for the done marker. */
  pollSeconds: number;
}

export const CLAUDE_CODE_DEFAULTS: Readonly<ClaudeCodeConfig> = Object.freeze({
  tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
  readyTimeoutSeconds: 60,
  stallMinutes: 15,
  pollSeconds: 2,
});

export function isClaudeCodeModel(model: string | undefined): boolean {
  return typeof model === "string" && model.startsWith(CLAUDE_CODE_PREFIX);
}

export function claudeCodeModelId(model: string): string {
  const id = model.startsWith(CLAUDE_CODE_PREFIX) ? model.slice(CLAUDE_CODE_PREFIX.length).trim() : "";
  if (!id) throw new Error(`"${model}" names no Claude model id after "${CLAUDE_CODE_PREFIX}"`);
  return id;
}

export function claudeCodeConfigured(models: Record<string, string | undefined>): boolean {
  return Object.values(models).some(isClaudeCodeModel);
}

/**
 * Normalize the operator's `claudeCode:` block. Malformed values stop the boot
 * rather than fall back: a stall watchdog of 0 would fail every phase, and a
 * silently ignored typo would hide that.
 */
export function parseClaudeCodeConfig(raw: unknown): ClaudeCodeConfig {
  const block =
    raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const out: ClaudeCodeConfig = { ...CLAUDE_CODE_DEFAULTS };
  const tokenEnv = block.tokenEnv;
  if (tokenEnv !== undefined && tokenEnv !== null) {
    if (typeof tokenEnv !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tokenEnv.trim())) {
      throw new Error("claudeCode.tokenEnv must be an environment variable name");
    }
    out.tokenEnv = tokenEnv.trim();
  }
  for (const key of ["readyTimeoutSeconds", "stallMinutes", "pollSeconds"] as const) {
    const v = block[key];
    if (v === undefined || v === null) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
      throw new Error(`claudeCode.${key} must be a number greater than 0`);
    }
    out[key] = v;
  }
  return out;
}
