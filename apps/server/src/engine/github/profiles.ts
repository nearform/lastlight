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
export const AGENTIC_PROFILE_FOR: Record<GitAccessProfile, GitAccessProfile> = {
  read: "read",
  "issues-write": "issues-write",
  "review-write": "review-write",
  "repo-write": "repo-write",
};

/**
 * The closed set of valid `--profile` values — the single source of truth for
 * every sandbox adapter's `runAgent` guard. `RunAgentOpts.profile` is typed to
 * the `GitAccessProfile` union, so a caller inside the codebase can't construct
 * an invalid value; this set exists as defence-in-depth against values that
 * arrive already erased to `string` (an `any`-cast test double, a future
 * untyped caller) before they reach the agentic-pi CLI. Was previously
 * hand-rolled as an identical `Set` in both the k8s and docker adapters —
 * centralized here, next to `GitAccessProfile`, to kill that triplication.
 */
export const AGENTIC_PROFILES: ReadonlySet<GitAccessProfile> = new Set<GitAccessProfile>([
  "read",
  "issues-write",
  "review-write",
  "repo-write",
]);

export const GITHUB_PERMISSION_PROFILES: Record<GitAccessProfile, GitHubTokenPermissions> = {
  read: {
    contents: "read",
    issues: "read",
    pull_requests: "read",
    metadata: "read",
  },
  // `pull_requests: "write"` is NOT an over-grant — it is what "comment on a
  // PR" costs. GitHub resolves `POST /repos/:o/:r/issues/:n/comments` against
  // the *target's* type: an issue checks `issues`, a pull request checks
  // `pull_requests`. So an issues-write token could comment on issues but 403'd
  // ("Resource not accessible by integration") on every PR — breaking
  // `pr-comment`, and `verify` / `qa-test` / `demo` / `issue-comment` whenever
  // they land on a PR (issue #239). The same rule governs labels + assignees on
  // a PR. The profile's tool set (`ISSUES_WRITE_TOOLS` in agentic-pi) is
  // unchanged and stays the behavioural boundary: no PR-review or
  // PR-creation tool is registered here — that's still `review-write`.
  "issues-write": {
    contents: "read",
    issues: "write",
    pull_requests: "write",
    metadata: "read",
  },
  // Same token scope as `issues-write` since #239 — GitHub has no finer grain
  // than `pull_requests: write` for "comment on a PR" vs "submit a review".
  // The two profiles stay distinct because the *tool set* differs:
  // `REVIEW_WRITE_TOOLS` adds `github_create_pull_request` +
  // `github_create_pull_request_review`, which the comment workflows must not
  // be able to call.
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
