import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExecutorConfig, SandboxBackend } from "lastlight-workflow-engine";

/**
 * Host path of a run's repo checkout — mirrors the `sandbox/index.ts` layout.
 *
 * Shared by the two in-process handlers that read what a sandboxed phase wrote
 * under `.lastlight/pr-review/`: `post-review` (findings.json) and
 * `survey-units` (units.json, and the responses it writes back). One copy, so
 * the two cannot disagree about where the checkout is.
 *
 * pr-review pre-clones into a `<repo>/` subdir (a sibling of the workspace
 * root's AGENTS.md / skill bundle). The workspace-root fallback is the layout
 * the kubernetes artifact upload unpacks into (`artifact-store.ts` `rootFor`);
 * with neither present the repo subdir is returned, so a caller's read fails
 * against the path it should have been.
 */
export function resolveHostRepoDir(
  config: Pick<ExecutorConfig, "sandboxDir" | "stateDir">,
  taskId: string,
  repo: string,
): string {
  const sandboxBase = resolve(config.sandboxDir || join(config.stateDir || "data", "sandboxes"));
  const workDir = join(sandboxBase, taskId);
  const repoDir = join(workDir, repo);
  if (existsSync(join(repoDir, ".lastlight", "pr-review"))) return repoDir;
  if (existsSync(join(workDir, ".lastlight", "pr-review"))) return workDir;
  return repoDir;
}

/**
 * Backends whose workspace the HARNESS can read.
 *
 * Every backend but one hands out a `hostAgentCwd` that exists on this machine —
 * docker and smol as the host end of a bind mount, the two in-process backends
 * because the agent IS this process. **`kubernetes` does not**: its paths are
 * in-pod, which is the same caveat `hostWorkspaceDir` already carries there
 * (`deliverAgentContext` routes around it through a sink for exactly this
 * reason).
 *
 * Three readers:
 *  - `fanout.ts`: a `context_file` read is not even ATTEMPTED there, and the
 *    branch is given the path to open itself. Attempting it would ENOENT every
 *    time and turn "the harness cannot see this workspace" into "the seeding
 *    step failed", which is a worse lie than the one this key removes.
 *  - `config.ts` (`loadConfig`): `review.analysis.surveyEngine: units` on a
 *    backend marked `false` here is REFUSED at startup — `survey-units` reads
 *    `units.json` and writes the responses from the harness.
 *  - `survey-units.ts`: the same check again at run time, as a guard that
 *    degrades (a loud summary, no call) rather than fails.
 */
export const HOST_READABLE_WORKSPACE: Record<SandboxBackend, boolean> = {
  none: true,
  docker: true,
  gondolin: true,
  smol: true,
  kubernetes: false,
};
