import { describe, it, expect } from "vitest";
import { pvcNameFor, buildPvcManifest } from "#src/sandbox/k8s/pvc.js";
import { RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";
import { RunId } from "#src/sandbox/k8s/run-id.js";

describe("pvcNameFor", () => {
  it("is a stable RFC-1123 ws- name (no per-run hash)", () => {
    expect(pvcNameFor("acme-web-pr12")).toBe(pvcNameFor("acme-web-pr12"));
    expect(pvcNameFor("acme-web-pr12")).toMatch(/^ws-[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(pvcNameFor("Acme/Web#PR12").length).toBeLessThanOrEqual(63);
  });
});

describe("buildPvcManifest", () => {
  it("is an RWO claim in the sandbox namespace with the requested class + size", () => {
    const pvc = buildPvcManifest({
      name: "ws-acme-web-pr12", namespace: "lastlight-sandboxes",
      storageClassName: "truenas-iscsi", size: "5Gi",
    });
    expect(pvc.spec?.accessModes).toEqual(["ReadWriteOnce"]);
    expect(pvc.spec?.storageClassName).toBe("truenas-iscsi");
    expect(pvc.spec?.resources?.requests?.storage).toBe("5Gi");
  });

  it("labels the PVC with the run id when given", () => {
    const pvc = buildPvcManifest({
      name: "ws-x", namespace: "ns", storageClassName: "sc", size: "5Gi",
      runId: RunId.from("run-42"),
    });
    expect(pvc.metadata?.labels?.[RUN_ID_LABEL]).toBe("run-42");
  });

  it("omits storageClassName (rather than sending an empty string) so the PVC " +
    "falls back to the cluster's default StorageClass", () => {
    const pvc = buildPvcManifest({
      name: "ws-x", namespace: "ns", storageClassName: "", size: "5Gi",
    });
    expect(pvc.spec?.storageClassName).toBeUndefined();
    expect("storageClassName" in (pvc.spec ?? {})).toBe(false);
  });
});
