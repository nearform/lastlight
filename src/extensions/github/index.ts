/**
 * GitHub extension entry point.
 *
 * Composes auth + tools + profile gating into something the runner can hand
 * to `createAgentSession({ customTools, tools })`.
 *
 * Safe by default: if `--profile` is not set OR the necessary GITHUB_ env
 * vars are missing, this returns an empty tool set and the runner continues
 * without GitHub support. The caller can inspect `status` / `reason` to
 * decide whether to surface a warning.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { buildAuthFromEnv, type AuthFailureReason, type GitHubAuth } from "./auth.js";
import { buildGitHubTools } from "./tools.js";
import { PROFILE_TOOLS, isGitAccessProfile, type GitAccessProfile } from "./profiles.js";

export { isGitAccessProfile, type GitAccessProfile } from "./profiles.js";

/** Why the extension didn't load tools. */
export type GitHubExtensionSkipReason =
  | "no-profile" // user did not pass --profile; safe default
  | AuthFailureReason;

export interface GitHubExtensionResult {
  /** Tools to pass into `createAgentSession({ customTools })`. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  customTools: ToolDefinition<any>[];
  /** Tool names registered (subset of the profile's allowlist). */
  toolNames: string[];
  /** Whether the extension is active. */
  status: "configured" | "skipped";
  /** Set when `status === "skipped"`. */
  reason?: GitHubExtensionSkipReason;
  /** Human-readable extra detail for warnings / logs. */
  message?: string;
  /** Always echoed back so the consumer knows what they asked for. */
  profile?: GitAccessProfile;
  /**
   * The auth backend that was constructed (App or static-token). Exposed
   * so the runner can mint a short-lived installation token to inject
   * into the sandbox VM as `GITHUB_TOKEN`. Only present when
   * `status === "configured"`.
   */
  auth?: GitHubAuth;
}

/**
 * Build the GitHub extension for a given profile.
 *
 * - No profile → status:"skipped", reason:"no-profile" (silent, expected).
 * - Profile set but no GITHUB_* env vars → status:"skipped", reason:"no-credentials".
 * - PEM file missing or partial creds → status:"skipped" with a specific reason
 *   and a message the caller should surface (these are misconfigurations,
 *   not opt-outs).
 */
export function loadGitHubExtension(
  profileName?: string,
  opts: { baseUrl?: string } = {},
): GitHubExtensionResult {
  if (!profileName) {
    return {
      customTools: [],
      toolNames: [],
      status: "skipped",
      reason: "no-profile",
    };
  }
  if (!isGitAccessProfile(profileName)) {
    throw new Error(
      `Unknown GitHub profile '${profileName}'. Expected one of: ${Object.keys(PROFILE_TOOLS).join(", ")}`,
    );
  }

  const { auth, reason, message } = buildAuthFromEnv();
  if (!auth) {
    return {
      customTools: [],
      toolNames: [],
      status: "skipped",
      reason,
      message,
      profile: profileName,
    };
  }

  const allowed = new Set(PROFILE_TOOLS[profileName]);
  const allTools = buildGitHubTools(auth, { baseUrl: opts.baseUrl });
  const profileTools = allTools.filter((t) => allowed.has(t.name));

  return {
    customTools: profileTools,
    toolNames: profileTools.map((t) => t.name),
    status: "configured",
    profile: profileName,
    auth,
  };
}

/**
 * True if the skip is a misconfiguration the user almost certainly wants to
 * know about (vs. a benign "didn't pass --profile" case).
 */
export function isMisconfigurationSkip(result: GitHubExtensionResult): boolean {
  if (result.status !== "skipped") return false;
  return result.reason === "pem-unreadable" || result.reason === "invalid-config";
}
