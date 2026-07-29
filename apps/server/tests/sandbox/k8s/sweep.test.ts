import { describe, it, expect, vi } from "vitest";
import { sweepK8sSandboxes } from "#src/sandbox/k8s/sweep.js";

// Off-cluster / client-build failure: makeK8sApis() always throws here, so
// any test that omits `opts.apis` exercises the "no kubeconfig" catch path.
// Tests that pass an explicit fake `apis` never reach this mock.
vi.mock("#src/sandbox/k8s/client.js", () => ({
  makeK8sApis: () => {
    throw new Error("no kubeconfig found");
  },
}));

/** Minimal PVC fixture — mirrors reclaim.test.ts's `pvc` helper. Defaults
 *  `now` to the real clock since `reclaimSandbox` (via `sweepK8sSandboxes`,
 *  which has no `now` seam) always ages against `Date.now()`. */
function pvc(name: string, ageHrs: number, now = Date.now()) {
  return {
    metadata: {
      name,
      labels: {},
      creationTimestamp: new Date(now - ageHrs * 3_600_000),
    },
  };
}

describe("sweepK8sSandboxes", () => {
  it("reclaims a stale idle PVC via the sweep selector from retentionHours/maxIdle", async () => {
    const listPods = vi.fn().mockResolvedValue({ items: [] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("old", 30)] });
    const delPod = vi.fn().mockResolvedValue({});
    const delPvc = vi.fn().mockResolvedValue({});
    const apis = {
      core: {
        listNamespacedPod: listPods,
        listNamespacedPersistentVolumeClaim: listPvcs,
        deleteNamespacedPod: delPod,
        deleteNamespacedPersistentVolumeClaim: delPvc,
      },
    } as any;

    // retentionHours=12 → the 30h-old PVC is stale and gets reclaimed.
    await sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, apis, namespace: "ns" });

    expect(listPods).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns",
        labelSelector: "app.kubernetes.io/managed-by=lastlight",
      }),
    );
    expect(delPvc).toHaveBeenCalledWith(expect.objectContaining({ name: "old" }));
    expect(delPod).not.toHaveBeenCalled();
  });

  it("keeps a fresh PVC under the LRU cap untouched", async () => {
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("fresh", 0.1)] });
    const delPvc = vi.fn().mockResolvedValue({});
    const apis = {
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
        listNamespacedPersistentVolumeClaim: listPvcs,
        deleteNamespacedPod: vi.fn(),
        deleteNamespacedPersistentVolumeClaim: delPvc,
      },
    } as any;

    await sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, apis, namespace: "ns" });

    expect(delPvc).not.toHaveBeenCalled();
  });

  it("swallows a rejecting (transport-failure) client without throwing", async () => {
    const apis = {
      core: {
        listNamespacedPod: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        listNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        deleteNamespacedPod: vi.fn(),
        deleteNamespacedPersistentVolumeClaim: vi.fn(),
      },
    } as any;

    await expect(
      sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, apis, namespace: "ns" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a client-build failure (off-cluster, no kubeconfig) without throwing", async () => {
    // No `apis` supplied — falls through to the (mocked, throwing) makeK8sApis().
    await expect(
      sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, namespace: "ns" }),
    ).resolves.toBeUndefined();
  });
});
