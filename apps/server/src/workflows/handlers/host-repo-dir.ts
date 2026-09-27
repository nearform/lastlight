import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExecutorConfig } from "lastlight-workflow-engine";

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
