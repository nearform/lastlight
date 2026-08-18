import { describe, it, expect, vi } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { livePvcClaimNames, pvcsToReclaim, reclaimSandbox } from "#src/sandbox/k8s/reclaim.js";
import { RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";
import { RunId } from "#src/sandbox/k8s/run-id.js";

const pod = (o: any) => ({
  metadata: { name: o.name, labels: o.labels },
  status: { phase: o.phase },
  spec: {
    volumes: o.claims?.map((c: string) => ({ persistentVolumeClaim: { claimName: c } })) ?? [],
  },
});
const pvc = (name: string, ageHrs: number, runId?: string, now = 0) => ({
  metadata: {
    name,
    labels: runId ? { [RUN_ID_LABEL]: runId } : {},
    creationTimestamp: new Date(now - ageHrs * 3600_000),
  },
});

describe("livePvcClaimNames", () => {
  it("collects claims from Pending/Running pods, ignores terminal ones", () => {
    const live = livePvcClaimNames([
      pod({ name: "a", phase: "Running", claims: ["ws-1"] }),
      pod({ name: "b", phase: "Succeeded", claims: ["ws-2"] }),
    ] as any);
    expect(live.has("ws-1")).toBe(true);
    expect(live.has("ws-2")).toBe(false);
  });

  it("ignores a Pending/Running pod that already has a deletionTimestamp", () => {
    const live = livePvcClaimNames([
      {
        metadata: { name: "a", deletionTimestamp: new Date(), labels: {} },
        status: { phase: "Running" },
        spec: { volumes: [{ persistentVolumeClaim: { claimName: "ws-1" } }] },
      },
    ] as any);
    expect(live.has("ws-1")).toBe(false);
  });
});

describe("pvcsToReclaim", () => {
  it("never reclaims a live-mounted PVC", () => {
    const out = pvcsToReclaim(
      [pvc("ws-1", 99)] as any,
      { kind: "sweep", staleByHours: 1, maxIdlePVCs: 0 },
      new Set(["ws-1"]),
      0,
    );
    expect(out).toHaveLength(0);
  });
  it("sweep reclaims PVCs older than staleByHours", () => {
    const out = pvcsToReclaim(
      [pvc("old", 5), pvc("new", 0.1)] as any,
      { kind: "sweep", staleByHours: 1, maxIdlePVCs: 99 },
      new Set(),
      0,
    );
    expect(out.map((p: any) => p.metadata.name)).toEqual(["old"]);
  });
  it("sweep LRU-evicts the oldest beyond maxIdlePVCs", () => {
    // staleByHours huge so the age pass reclaims nothing — isolates LRU.
    const out = pvcsToReclaim(
      [pvc("o1", 3), pvc("o2", 2), pvc("o3", 1)] as any,
      { kind: "sweep", staleByHours: 1_000_000, maxIdlePVCs: 1 },
      new Set(),
      0,
    );
    // keep the newest 1, evict the 2 oldest
    expect(out.map((p: any) => p.metadata.name).sort()).toEqual(["o1", "o2"]);
  });
  it("run selector matches the run-id label", () => {
    const out = pvcsToReclaim(
      [pvc("ws-a", 0, "run-42"), pvc("ws-b", 0, "run-99")] as any,
      { kind: "run", runId: RunId.from("run-42") },
      new Set(),
      0,
    );
    expect(out.map((p: any) => p.metadata.name)).toEqual(["ws-a"]);
  });
});

describe("reclaimSandbox", () => {
  it("deletes matched pods + idle PVCs; 404 is success; 403 on list warns + no-ops", async () => {
    const runPod = pod({
      name: "p-42",
      phase: "Succeeded",
      labels: { [RUN_ID_LABEL]: "run-42" },
      claims: ["ws-42"],
    });
    const listPods = vi.fn().mockResolvedValue({ items: [runPod] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("ws-42", 0, "run-42")] });
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
    const res = await reclaimSandbox(apis, "ns", { kind: "run", runId: RunId.from("run-42") });
    expect(delPod).toHaveBeenCalledWith(expect.objectContaining({ name: "p-42" }));
    expect(delPvc).toHaveBeenCalledWith(expect.objectContaining({ name: "ws-42" }));
    expect(res).toMatchObject({ podsDeleted: 1, pvcsDeleted: 1 });

    const warn = vi.fn();
    const apis403 = {
      core: {
        listNamespacedPod: vi.fn().mockRejectedValue(new ApiException(403, "no", {}, {})),
        listNamespacedPersistentVolumeClaim: vi.fn(),
      },
    } as any;
    const r2 = await reclaimSandbox(
      apis403,
      "ns",
      { kind: "run", runId: RunId.from("x") },
      { onWarn: warn },
    );
    expect(warn).toHaveBeenCalledOnce();
    expect(r2).toMatchObject({ podsDeleted: 0, pvcsDeleted: 0 });
  });

  it("cancel: reclaims the run's PVC even though its own (live) pod still mounts it", async () => {
    // The run's own pod is still Running (a cancel races the pod's teardown),
    // so livePvcClaimNames would normally mark ws-42 as live and protect it.
    // For a `run` reclaim we want the opposite: deleting THIS run's PVC is the
    // whole point, so the selector's own matching pod(s) must be excluded from
    // the live set before computing pvcsToReclaim.
    const runPod = pod({
      name: "p-42",
      phase: "Running",
      labels: { [RUN_ID_LABEL]: "run-42" },
      claims: ["ws-42"],
    });
    const listPods = vi.fn().mockResolvedValue({ items: [runPod] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("ws-42", 0, "run-42")] });
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
    const res = await reclaimSandbox(apis, "ns", { kind: "run", runId: RunId.from("run-42") });
    expect(delPod).toHaveBeenCalledWith(expect.objectContaining({ name: "p-42" }));
    expect(delPvc).toHaveBeenCalledWith(expect.objectContaining({ name: "ws-42" }));
    expect(res).toMatchObject({ podsDeleted: 1, pvcsDeleted: 1 });
  });

  it("run selector never deletes a DIFFERENT live run's PVC it happens to mount", async () => {
    // A live pod belonging to a DIFFERENT run mounts ws-other — that must stay
    // protected; only the selector's own pods are excluded from `live`.
    const ownPod = pod({
      name: "p-42",
      phase: "Succeeded",
      labels: { [RUN_ID_LABEL]: "run-42" },
      claims: ["ws-42"],
    });
    const otherPod = pod({
      name: "p-other",
      phase: "Running",
      labels: { [RUN_ID_LABEL]: "run-other" },
      claims: ["ws-other"],
    });
    const listPods = vi.fn().mockResolvedValue({ items: [ownPod, otherPod] });
    const listPvcs = vi.fn().mockResolvedValue({
      items: [pvc("ws-42", 0, "run-42"), pvc("ws-other", 0, "run-other")],
    });
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
    const res = await reclaimSandbox(apis, "ns", { kind: "run", runId: RunId.from("run-42") });
    expect(delPod).toHaveBeenCalledTimes(1);
    expect(delPod).toHaveBeenCalledWith(expect.objectContaining({ name: "p-42" }));
    expect(delPvc).toHaveBeenCalledTimes(1);
    expect(delPvc).toHaveBeenCalledWith(expect.objectContaining({ name: "ws-42" }));
    expect(res).toMatchObject({ podsDeleted: 1, pvcsDeleted: 1 });
  });

  it("sweep deletes no pods, only idle PVCs", async () => {
    const listPods = vi.fn().mockResolvedValue({ items: [] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("old", 5)] });
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
    const sweepSelector = { kind: "sweep" as const, staleByHours: 1, maxIdlePVCs: 99 };
    const res = await reclaimSandbox(apis, "ns", sweepSelector);
    expect(delPod).not.toHaveBeenCalled();
    expect(delPvc).toHaveBeenCalledWith(expect.objectContaining({ name: "old" }));
    expect(res).toMatchObject({ podsDeleted: 0, pvcsDeleted: 1 });
  });

  it("is idempotent: a 404 on delete counts as success and does not throw", async () => {
    const runPod = pod({
      name: "p-42",
      phase: "Succeeded",
      labels: { [RUN_ID_LABEL]: "run-42" },
      claims: ["ws-42"],
    });
    const listPods = vi.fn().mockResolvedValue({ items: [runPod] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("ws-42", 0, "run-42")] });
    const delPod = vi.fn().mockRejectedValue(new ApiException(404, "gone", {}, {}));
    const delPvc = vi.fn().mockRejectedValue(new ApiException(404, "gone", {}, {}));
    const apis = {
      core: {
        listNamespacedPod: listPods,
        listNamespacedPersistentVolumeClaim: listPvcs,
        deleteNamespacedPod: delPod,
        deleteNamespacedPersistentVolumeClaim: delPvc,
      },
    } as any;
    const res = await reclaimSandbox(apis, "ns", { kind: "run", runId: RunId.from("run-42") });
    expect(res).toMatchObject({ podsDeleted: 1, pvcsDeleted: 1 });
  });

  it("is best-effort: a non-404 delete failure warns and continues to next", async () => {
    const pod1 = pod({
      name: "p-1",
      phase: "Succeeded",
      labels: { [RUN_ID_LABEL]: "run-42" },
      claims: ["ws-1"],
    });
    const pod2 = pod({
      name: "p-2",
      phase: "Succeeded",
      labels: { [RUN_ID_LABEL]: "run-42" },
      claims: ["ws-2"],
    });
    const listPods = vi.fn().mockResolvedValue({ items: [pod1, pod2] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [] });
    const delPod = vi
      .fn()
      .mockRejectedValueOnce(new ApiException(500, "boom", {}, {}))
      .mockResolvedValueOnce({});
    const delPvc = vi.fn().mockResolvedValue({});
    const apis = {
      core: {
        listNamespacedPod: listPods,
        listNamespacedPersistentVolumeClaim: listPvcs,
        deleteNamespacedPod: delPod,
        deleteNamespacedPersistentVolumeClaim: delPvc,
      },
    } as any;
    const warn = vi.fn();
    const runSelector = { kind: "run" as const, runId: RunId.from("run-42") };
    const res = await reclaimSandbox(apis, "ns", runSelector, { onWarn: warn });
    expect(delPod).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledOnce();
    expect(res).toMatchObject({ podsDeleted: 1, pvcsDeleted: 0 });
  });

  it("passes the managed-by label selector to both list calls", async () => {
    const listPods = vi.fn().mockResolvedValue({ items: [] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [] });
    const apis = {
      core: {
        listNamespacedPod: listPods,
        listNamespacedPersistentVolumeClaim: listPvcs,
        deleteNamespacedPod: vi.fn(),
        deleteNamespacedPersistentVolumeClaim: vi.fn(),
      },
    } as any;
    const sweepSelector = { kind: "sweep" as const, staleByHours: 1, maxIdlePVCs: 99 };
    await reclaimSandbox(apis, "ns", sweepSelector);
    const expected = expect.objectContaining({
      namespace: "ns",
      labelSelector: "app.kubernetes.io/managed-by=lastlight",
    });
    expect(listPods).toHaveBeenCalledWith(expected);
    expect(listPvcs).toHaveBeenCalledWith(expected);
  });
});
