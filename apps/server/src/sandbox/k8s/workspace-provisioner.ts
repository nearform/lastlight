import { ApiException, type CoreV1Api } from "@kubernetes/client-node";
import type { PrePopulateSpec, ProvisionResult } from "../sandbox.js";
import { WORKSPACE_DIR, type PodSpecInput } from "./pod.js";
import { buildPvcManifest, pvcNameFor } from "./pvc.js";
import { RunId } from "./run-id.js";

/** The pod's workspace descriptor — an ephemeral in-pod `emptyDir`, or a
 *  stable per-(repo,PR) RWO PVC (design B). Mirrors `PodSpecInput.workspace`. */
type Workspace = PodSpecInput["workspace"];

/**
 * Everything a `provision()` call hands the orchestrator: the {@link ProvisionResult}
 * returned across the `Sandbox` port, plus the two pieces `runPod` needs later
 * — the {@link Workspace} descriptor (emptyDir vs PVC) and the pre-clone
 * descriptor (clone-init coordinates). Bundling them into one value is what
 * lets `KubernetesSandbox` hold a single provision-scoped field instead of the
 * old loose `pre` + `workspace` pair.
 */
export interface Provisioned {
  result: ProvisionResult;
  workspace: Workspace;
  pre?: PrePopulateSpec;
}

/** The subset of config the provisioner needs to size/class the PVC and derive
 *  its stable name. `taskId` keys the per-(repo,PR) claim (see `pvcNameFor`). */
export interface WorkspaceProvisionerConfig {
  namespace: string;
  storageClassName: string;
  workspaceSize: string;
  taskId: string;
}

/**
 * Owns the pod's workspace lifecycle: an ephemeral `emptyDir` for a run with no
 * pre-clone descriptor, or a stable per-(repo,PR) RWO PVC (design B, locked
 * decision #2) when handed one. The PVC is created once and reused across
 * runs/phases — never recreated or resized here (Plan 4/5). Extracted from
 * `KubernetesSandbox` (F1) so the PVC-ensure logic is independently testable
 * against a fake `CoreV1Api`.
 */
export class WorkspaceProvisioner {
  constructor(
    private readonly core: CoreV1Api,
    private readonly cfg: WorkspaceProvisionerConfig,
  ) {}

  /** Provision the workspace for this sandbox. Without a pre-clone descriptor
   *  the run gets an ephemeral `emptyDir` and nothing is touched cluster-side;
   *  with one, the per-(repo,PR) PVC is ensured and the agent's cwd becomes the
   *  checkout subdir the clone-init writes at `<WORKSPACE_DIR>/<repo>`. */
  async provision(pre?: PrePopulateSpec): Promise<Provisioned> {
    if (!pre) {
      return {
        result: { hostWorkspaceDir: WORKSPACE_DIR, agentCwd: WORKSPACE_DIR },
        workspace: { kind: "emptyDir" },
      };
    }
    const claimName = pvcNameFor(this.cfg.taskId);
    await this.ensurePvc(claimName, pre.runId ? RunId.from(pre.runId) : undefined);
    return {
      result: { hostWorkspaceDir: WORKSPACE_DIR, agentCwd: `${WORKSPACE_DIR}/${pre.repo}` },
      workspace: { kind: "pvc", claimName },
      pre,
    };
  }

  /** Ensure the named PVC exists, creating it on a 404. The `runId` (when the
   *  descriptor carried one) is stamped as a label so `reclaimSandbox` (Plan 5)
   *  can select the claim back by the same value — the stamp/select symmetry
   *  `RunId` enforces (F7). Any non-404 read error propagates. */
  private async ensurePvc(name: string, runId?: RunId): Promise<void> {
    try {
      await this.core.readNamespacedPersistentVolumeClaim({ name, namespace: this.cfg.namespace });
      return;
    } catch (err) {
      if (!(err instanceof ApiException) || err.code !== 404) throw err;
    }
    await this.core.createNamespacedPersistentVolumeClaim({
      namespace: this.cfg.namespace,
      body: buildPvcManifest({
        name,
        namespace: this.cfg.namespace,
        storageClassName: this.cfg.storageClassName,
        size: this.cfg.workspaceSize,
        runId,
      }),
    });
  }
}
