/**
 * The container env for a `claude-code` phase.
 *
 * The Claude session runs with permissions bypassed on text an issue or PR
 * author wrote, so it must hold nothing worth stealing except the one
 * credential it needs: the operator's own Claude token. Every GitHub
 * credential, provider key and gateway setting the executor would hand an
 * agentic-pi phase is dropped — the host already pre-cloned the repo with its
 * own minted token, and anything the phase writes that must reach GitHub is
 * published by the host after the phase ends.
 */
import { CLAUDE_CONFIG_DIR } from "./session.js";

const CREDENTIAL_PREFIXES = /^(GIT_TOKEN|GITHUB_|GH_|GIT_CONFIG_|ANTHROPIC_|AGENTIC_PI_|LASTLIGHT_)/;
const SECRET_SHAPED = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|HEADERS)$/;

export function sandboxEnvForClaudeCode(
  env: Record<string, string>,
  token: string,
  providerEnvKeys: readonly string[],
): Record<string, string> {
  const providerKeys = new Set(providerEnvKeys);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (providerKeys.has(k) || CREDENTIAL_PREFIXES.test(k) || SECRET_SHAPED.test(k)) continue;
    out[k] = v;
  }
  out.CLAUDE_CODE_OAUTH_TOKEN = token;
  out.CLAUDE_CONFIG_DIR = CLAUDE_CONFIG_DIR;
  out.DISABLE_AUTOUPDATER = "1";
  out.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  return out;
}
