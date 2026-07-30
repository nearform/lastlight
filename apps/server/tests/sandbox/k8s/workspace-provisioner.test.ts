import { describe, it, expect, vi } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { WorkspaceProvisioner } from "#src/sandbox/k8s/workspace-provisioner.js";
import { WORKSPACE_DIR } from "#src/sandbox/k8s/pod.js";
import { RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";

/** Minimal fake `CoreV1Api` covering only the two PVC methods the provisioner
 *  touches — a 404 on read (the default) drives the create path; `pvcExists`
 *  flips read to resolve so the reuse path is exercised instead. */
function fakeCore(opts: { pvcExists?: boolean } = {}) {
  const pvcsRead: any[] = [];
  const pvcsCreated: any[] = [];
  const core = {
    readNamespacedPersistentVolumeClaim: vi.fn(async ({ name, namespace }: any) => {
      pvcsRead.push({ name, namespace });
      if (opts.pvcExists) return { metadata: { name, namespace } };
      throw new ApiException(404, "Not Found", {}, {});
    }),
    createNamespacedPersistentVolumeClaim: vi.fn(async ({ body }: any) => {
      pvcsCreated.push(body);
      return body;
    }),
  } as any;
  return { core, pvcsRead, pvcsCreated };
}

const cfg = {
  namespace: "ns",
  storageClassName: "truenas-iscsi",
  workspaceSize: "5Gi",
  taskId: "acme-web-pr12",
};

describe("WorkspaceProvisioner", () => {
  it("provisions an ephemeral emptyDir workspace when no pre-clone descriptor", async () => {
    const { core, pvcsRead, pvcsCreated } = fakeCore();
    const provisioner = new WorkspaceProvisioner(core, cfg);

    const out = await provisioner.provision();

    expect(out.workspace).toEqual({ kind: "emptyDir" });
    expect(out.pre).toBeUndefined();
    expect(out.result).toEqual({ hostWorkspaceDir: WORKSPACE_DIR, agentCwd: WORKSPACE_DIR });
    // Nothing PVC-related is touched for an ephemeral run.
    expect(pvcsRead).toHaveLength(0);
    expect(pvcsCreated).toHaveLength(0);
  });

  it("ensures the PVC (created on 404) and returns the repo subdir as agentCwd", async () => {
    const { core, pvcsRead, pvcsCreated } = fakeCore();
    const provisioner = new WorkspaceProvisioner(core, cfg);
    const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" } as any;

    const out = await provisioner.provision(pre);

    expect(pvcsRead).toHaveLength(1); // existence check first
    expect(pvcsCreated).toHaveLength(1); // 404 → create
    expect(pvcsCreated[0].spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvcsCreated[0].metadata.name).toMatch(/^ws-/);
    expect(out.workspace).toEqual({ kind: "pvc", claimName: expect.stringMatching(/^ws-/) });
    expect(out.pre).toBe(pre);
    expect(out.result.hostWorkspaceDir).toBe(WORKSPACE_DIR);
    expect(out.result.agentCwd).toBe(`${WORKSPACE_DIR}/web`);
  });

  it("reuses an existing PVC without re-creating it", async () => {
    const { core, pvcsRead, pvcsCreated } = fakeCore({ pvcExists: true });
    const provisioner = new WorkspaceProvisioner(core, cfg);
    const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" } as any;

    await provisioner.provision(pre);

    expect(pvcsRead).toHaveLength(1);
    expect(pvcsCreated).toHaveLength(0);
  });

  it("stamps the run-id label on a created PVC when the descriptor carries a runId", async () => {
    const { core, pvcsCreated } = fakeCore();
    const provisioner = new WorkspaceProvisioner(core, cfg);
    const pre = {
      owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x", runId: "Run-42",
    } as any;

    await provisioner.provision(pre);

    // Stamp/select symmetry (F7): the sanitized runId is on the PVC so the
    // reclaim selector can match it back.
    expect(pvcsCreated[0].metadata.labels[RUN_ID_LABEL]).toBe("run-42");
  });

  it("rethrows a non-404 read error instead of blindly creating", async () => {
    const { core } = fakeCore();
    core.readNamespacedPersistentVolumeClaim = vi.fn(async () => {
      throw new ApiException(500, "Server Error", {}, {});
    });
    const provisioner = new WorkspaceProvisioner(core, cfg);
    const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" } as any;

    await expect(provisioner.provision(pre)).rejects.toThrow();
    expect(core.createNamespacedPersistentVolumeClaim).not.toHaveBeenCalled();
  });
});
