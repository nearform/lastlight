import { describe, it, expect, vi } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { reclaimStalePod } from "#src/sandbox/k8s/pod-lifecycle.js";

/**
 * Reclaiming a previous attempt's tombstone before creating a run (issue #336).
 *
 * Sandbox object names are deterministic — `podNameFor` is a sha1 of the taskId
 * with no attempt component — so a retry regenerates the same pod name and the
 * same `<pod>-creds` / `<pod>-prompt` Secret names. `dispose()` normally deletes
 * the pod (cascade-GCing both Secrets), but a harness that dies mid-run never
 * runs it. The tombstone then makes every retry of that run fail: first on the
 * Secret create (409 AlreadyExists), and — if only the Secrets were cleaned —
 * again on the pod create.
 *
 * The live/terminal distinction is the safety property. A 409 against a RUNNING
 * pod is genuine concurrency (two dispatches racing for one taskId) and must
 * keep failing; a 409 against a tombstone is a dead run's litter.
 */

function fakeCore(opts: { phase?: string; absent?: boolean; goneAfterDelete?: boolean } = {}) {
  const { phase = "Succeeded", absent = false, goneAfterDelete = true } = opts;
  let deleted = false;
  const core = {
    readNamespacedPodStatus: vi.fn(async ({ name, namespace }: any) => {
      if (absent || (deleted && goneAfterDelete)) throw new ApiException(404, "Not Found", {}, {});
      return { metadata: { name, namespace }, status: { phase } };
    }),
    deleteNamespacedPod: vi.fn(async () => {
      deleted = true;
      return {};
    }),
  } as any;
  return { core };
}

describe("reclaimStalePod", () => {
  it("reclaims a Succeeded tombstone so the retry can proceed", async () => {
    const { core } = fakeCore({ phase: "Succeeded" });

    const reclaimed = await reclaimStalePod(core, "lastlight-sandboxes", "ll-run-abc");

    expect(reclaimed).toBe(true);
    expect(core.deleteNamespacedPod).toHaveBeenCalledWith({
      name: "ll-run-abc",
      namespace: "lastlight-sandboxes",
    });
  });

  it("reclaims a Failed tombstone too", async () => {
    const { core } = fakeCore({ phase: "Failed" });

    await expect(reclaimStalePod(core, "ns", "ll-run-abc")).resolves.toBe(true);
    expect(core.deleteNamespacedPod).toHaveBeenCalled();
  });

  // The safety property. Deleting here would kill a legitimately in-flight run
  // belonging to another dispatch, turning a loud 409 into silent sabotage.
  it("leaves a Running pod alone — that is real concurrency, not litter", async () => {
    const { core } = fakeCore({ phase: "Running" });

    const reclaimed = await reclaimStalePod(core, "ns", "ll-run-abc");

    expect(reclaimed).toBe(false);
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it("leaves a Pending pod alone", async () => {
    const { core } = fakeCore({ phase: "Pending" });

    await expect(reclaimStalePod(core, "ns", "ll-run-abc")).resolves.toBe(false);
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  it("is a no-op when no pod of that name exists", async () => {
    const { core } = fakeCore({ absent: true });

    const reclaimed = await reclaimStalePod(core, "ns", "ll-run-abc");

    expect(reclaimed).toBe(false);
    expect(core.deleteNamespacedPod).not.toHaveBeenCalled();
  });

  // The workspace PVC is (repo,PR)-scoped and RWO, so the replacement pod cannot
  // attach it until the tombstone is really gone. Returning before that races the
  // volume release and surfaces as a Multi-Attach error on the new pod.
  it("waits for the pod to be gone before returning", async () => {
    const { core } = fakeCore({ phase: "Succeeded", goneAfterDelete: true });

    await reclaimStalePod(core, "ns", "ll-run-abc");

    const deleteOrder = core.deleteNamespacedPod.mock.invocationCallOrder[0];
    const reads = core.readNamespacedPodStatus.mock.invocationCallOrder;
    expect(reads.some((o: number) => o > deleteOrder)).toBe(true);
  });
});
