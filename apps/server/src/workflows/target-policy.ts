/**
 * Per-workflow RUNTIME POLICY — the git-token profile a run is minted, how its
 * sandbox workspace is keyed and refreshed, whether it pre-populates a
 * synthesized branch or pins to a PR's real head ref, and whether it is shaped
 * like `pr-fix`.
 *
 * ## Why this is a workflow's own metadata
 *
 * All five of these used to be literal name tables in compiled core code — a
 * `switch` in `runner.ts` and four `new Set([...])`s here. A workflow that
 * exists only in a deployment OVERLAY could therefore never register itself
 * into any of them: it silently got `git_access: read` (cannot submit a
 * review, cannot push), a cold per-run clone, and no head-ref pinning (it
 * reviews the BASE branch and says nothing about it). The only way to ship a
 * first-class overlay workflow was a core patch naming an arm core does not
 * ship (issue #368).
 *
 * The failure mode is the one `./pr-scope.ts` documents for `pr_scoped`, and
 * this is the same refactor: everything these tables control is invisible in a
 * run's output until it isn't. So each is declared on the workflow — see
 * `git_access` / `workspace` / `prepopulate_synth_branch` /
 * `prepopulate_pr_head_ref` / `pr_fix_shaped` in
 * `packages/workflow-engine/src/core/schema.ts`, which carry the full prose —
 * and read back off the loaded definitions here.
 *
 * ## Resolution
 *
 * Derived from the loader's merged layer stack (built-ins + the deployment
 * overlay) and memoised on `getAssetVersion()`, so an admin asset reload
 * re-derives it without a callback registry — exactly as `prScopedWorkflows()`
 * does. Unlike `pr_scoped` there is NO legacy-name floor: this was a hard
 * cutover, with every built-in YAML declaring its behaviour explicitly and a
 * test pinning the derived policy entry-for-entry. What guards an overlay that
 * forked a workflow before these keys existed is `validateAssets`, which warns
 * when a workflow reachable from a configured `routes.github.*` declares none
 * of them.
 *
 * A name the loader has never heard of — every in-process handler
 * (`chat`, `approval-response`, …), and any caller passing a bare skill name —
 * resolves to {@link DEFAULT_POLICY}, which is what the old tables' `default:`
 * arm and `Set.has() === false` gave it.
 *
 * This stays a LEAF module (it imports the loader, but no importer of it —
 * `runner.ts`, `simple.ts`, the engine — is imported by the loader) so both
 * `simple.ts` (taskId keying) and `runner.ts` (`gitSandboxAccessForWorkflow`)
 * can read one source of truth without an import cycle.
 */

import type { GitAccessProfile } from "lastlight-workflow-engine";
import { getAssetVersion, listAgentWorkflows } from "./loader.js";
import { logger } from "../logging/logger.js";

const log = logger("target-policy");

/** How a workflow's sandbox workspace is keyed, and how a re-run treats it. */
export type WorkspacePolicy = "per-run" | "per-target-reuse" | "per-target-recreate";

/** The resolved runtime policy for one workflow. */
export interface WorkflowTargetPolicy {
  /** Permission profile the run's GitHub token is minted against. */
  readonly gitAccess: GitAccessProfile;
  /** Workspace keying + re-run refresh strategy. */
  readonly workspace: WorkspacePolicy;
  /** Pre-populate even though the branch is synthesized and not on the remote. */
  readonly prepopulateSynthBranch: boolean;
  /** Against a real PR, pin the pre-clone to the PR's head ref. */
  readonly prepopulatePrHeadRef: boolean;
  /** Dispatched through `handlePrFix`; member of the per-PR fix family. */
  readonly prFixShaped: boolean;
}

/**
 * What an undeclared — or unknown — workflow gets.
 *
 * Every field is the value the deleted hardcoded tables produced for a name
 * they did not list, so a workflow that declares nothing behaves exactly as one
 * missing from all five did.
 */
export const DEFAULT_POLICY: WorkflowTargetPolicy = {
  gitAccess: "read",
  workspace: "per-run",
  prepopulateSynthBranch: false,
  prepopulatePrHeadRef: false,
  prFixShaped: false,
};

let cached: ReadonlyMap<string, WorkflowTargetPolicy> | null = null;
let cachedAtVersion = -1;

function derive(): ReadonlyMap<string, WorkflowTargetPolicy> {
  const byName = new Map<string, WorkflowTargetPolicy>();
  for (const def of listAgentWorkflows()) {
    byName.set(def.name, {
      gitAccess: def.git_access ?? DEFAULT_POLICY.gitAccess,
      workspace: def.workspace ?? DEFAULT_POLICY.workspace,
      prepopulateSynthBranch: def.prepopulate_synth_branch === true,
      prepopulatePrHeadRef: def.prepopulate_pr_head_ref === true,
      prFixShaped: def.pr_fix_shaped === true,
    });
  }
  return byName;
}

function policies(): ReadonlyMap<string, WorkflowTargetPolicy> {
  const version = getAssetVersion();
  if (cached && cachedAtVersion === version) return cached;
  let byName: ReadonlyMap<string, WorkflowTargetPolicy>;
  try {
    byName = derive();
  } catch (err: unknown) {
    // A loader that cannot read its workflows must not take the process with
    // it: every lookup then falls through to DEFAULT_POLICY, the least
    // privileged answer (read token, cold per-run workspace, no pinning).
    log.warn("Could not read the workflow definitions — every workflow falls back to the default policy", { err });
    byName = new Map();
  }
  cached = byName;
  cachedAtVersion = version;
  return cached;
}

/**
 * The resolved policy for one workflow, by name.
 *
 * Cheap to call — memoised per asset version, and every caller is on a dispatch
 * path that already resolves config.
 */
export function workflowTargetPolicy(workflowName: string): WorkflowTargetPolicy {
  return policies().get(workflowName) ?? DEFAULT_POLICY;
}

/** What the GitHub token minted for this workflow's sandbox may do. */
export function gitAccessFor(workflowName: string): GitAccessProfile {
  return workflowTargetPolicy(workflowName).gitAccess;
}

/** Is this workflow's workspace keyed by (repo, target) rather than per-run? */
export function isPerTargetWorkspace(workflowName: string): boolean {
  return workflowTargetPolicy(workflowName).workspace !== "per-run";
}

/** Keyed by (repo, target) and REFRESHED across runs (`per-target-reuse`). */
export function isPerTargetReuse(workflowName: string): boolean {
  return workflowTargetPolicy(workflowName).workspace === "per-target-reuse";
}

/**
 * Keyed by (repo, target) and RECREATED from the default branch on a fresh run
 * (`per-target-recreate`) — read as `recreateFromBase` by the sandbox.
 */
export function isPerTargetRecreate(workflowName: string): boolean {
  return workflowTargetPolicy(workflowName).workspace === "per-target-recreate";
}

/** Pre-populate the sandbox even though this workflow's branch is synthesized. */
export function prepopulatesSynthBranch(workflowName: string): boolean {
  return workflowTargetPolicy(workflowName).prepopulateSynthBranch;
}

/** Against a real PR, pin the pre-clone to the PR's actual head ref. */
export function prepopulatesPrHeadRef(workflowName: string): boolean {
  return workflowTargetPolicy(workflowName).prepopulatePrHeadRef;
}

/** Is this workflow dispatched through `handlePrFix`? */
export function isPrFixShaped(workflowName: string): boolean {
  return workflowTargetPolicy(workflowName).prFixShaped;
}

/**
 * Every `pr_fix_shaped` workflow, by name — the fix FAMILY.
 *
 * Kept as a set (not just the predicate) because several callers need to
 * ENUMERATE it rather than test one name: the shared per-PR workspace key, the
 * fix ledger's per-family scan (`engine/pr-state.ts`) and the admin PR-retry
 * route's `latestForTrigger` all ask "which of these last worked this PR".
 */
export function prFixShapedWorkflows(): ReadonlySet<string> {
  const names = new Set<string>();
  for (const [name, policy] of policies()) if (policy.prFixShaped) names.add(name);
  return names;
}

/** Drop the memo. Tests only — production invalidates on `getAssetVersion()`. */
export function __resetTargetPolicyCacheForTest(): void {
  cached = null;
  cachedAtVersion = -1;
}
