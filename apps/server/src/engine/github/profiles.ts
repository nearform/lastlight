import type { GitHubTokenPermissions } from "./git-auth.js";
import type { ExecutorConfig, GitAccessProfile } from "lastlight-workflow-engine";
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

/**
 * The operator-only agent context, composed from the module-level asset layers
 * (built-in ⊕ overlay). `_dir` is accepted for call-site compatibility and
 * deliberately ignored — agent context is resolved layer-wise by the loader, not
 * from a single directory. Prefer {@link agentContextFor}, which honours a run's
 * own resolved value.
 */
export function loadAgentContext(_dir?: string): string {
  return loadResolvedAgentContext();
}

/**
 * The agent context (AGENTS.md body) for ONE run.
 *
 * `config.agentContext` is the text the runner composed off this run's asset
 * resolver — the only value that includes the target repo's additive
 * `agent-context/*.md` (issue #180), and the only one that has had the
 * additive-only rule applied to it. It is used verbatim: re-composing here would
 * silently drop the repo layer (the module-level loader has never heard of it).
 *
 * Absent ⇒ the module-level facade, byte-identical to the pre-repo-layer
 * behaviour, which is every run that carries no repo layer.
 */
export function agentContextFor(config: Pick<ExecutorConfig, "agentContext" | "agentContextDir">): string {
  return config.agentContext ?? loadAgentContext(config.agentContextDir);
}

/**
 * A sandbox adapter that DELIVERS the agent context itself instead of reading it
 * off a host-shared workspace.
 *
 * Only the kubernetes backend implements it: its `hostWorkspaceDir` is an in-pod
 * path, so the orchestrator can't write `AGENTS.md` there — the adapter serves
 * the text over its own authenticated init-fetch channel instead. Declared here,
 * beside the agent-context loader, rather than on the `Sandbox` port: it is a
 * capability of one backend, and every other adapter is served by the plain
 * workspace write.
 *
 * The orchestrator constructs one adapter per run (see `withSandbox`), so the
 * value handed over is per-instance run state — never shared between runs.
 */
export interface AgentContextSink {
  setAgentContext(text: string): void;
}

/**
 * Hand `text` to `sandbox` if it implements {@link AgentContextSink}. Returns
 * whether it did, so a caller can tell "delivered" from "this backend doesn't
 * take it" (in which case the adapter keeps its own module-level fallback and
 * the run is exactly as it was before this seam existed).
 */
export function provideAgentContext(sandbox: unknown, text: string): boolean {
  const sink = sandbox as Partial<AgentContextSink> | null;
  if (typeof sink?.setAgentContext !== "function") return false;
  sink.setAgentContext(text);
  return true;
}
