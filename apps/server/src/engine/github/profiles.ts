import type { GitHubTokenPermissions } from "./git-auth.js";
import type { GitAccessProfile } from "lastlight-workflow-engine";
import { loadAgentContext as loadResolvedAgentContext } from "../../workflows/loader.js";

// The shared execution vocabulary (ExecutorConfig / ExecutionResult /
// GitSandboxAccess / GitAccessProfile / extension + skill status) now lives in
// the workflow engine (`workflow-engine/core/types.ts`). Re-export it here so
// every existing `../engine/github/profiles.js` import keeps resolving
// unchanged (kills the engine→app type dependency; see extraction design §2).
export type {
  ExecutorConfig,
  ExecutionResult,
  ExtensionStatus,
  ExtensionStatusMap,
  SkillSummary,
  SkillsStatus,
  GitAccessProfile,
  GitSandboxAccess,
} from "lastlight-workflow-engine";

/**
 * agentic-pi's GitHub extension uses the same four profile names — they
 * pass through unchanged. Kept as an explicit map so renames on either
 * side surface as a type error rather than a silent runtime mismatch.
 */
export const AGENTIC_PROFILE_FOR: Record<GitAccessProfile, string> = {
  read: "read",
  "issues-write": "issues-write",
  "review-write": "review-write",
  "repo-write": "repo-write",
};

export const GITHUB_PERMISSION_PROFILES: Record<GitAccessProfile, GitHubTokenPermissions> = {
  read: {
    contents: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
  },
  "issues-write": {
    contents: "read",
    issues: "write",
    pull_requests: "read",
    metadata: "read",
  },
  "review-write": {
    contents: "read",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
  "repo-write": {
    contents: "write",
    issues: "write",
    pull_requests: "write",
    workflows: "write",
    metadata: "read",
  },
};

export function loadAgentContext(_dir?: string): string {
  return loadResolvedAgentContext();
}
