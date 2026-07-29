import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import type { RunId } from "./run-id.js";
import { Rfc1123Label } from "./resource-name.js";

/** Stable per-(repo,PR) claim name — NO run/phase hash, so pods reuse it
 *  (unlike `podNameFor`, which appends one; see `naming.ts`). */
export function pvcNameFor(taskId: string): string {
  return Rfc1123Label.slug(taskId, { prefix: "ws-" }).value;
}

export function buildPvcManifest(i: {
  name: string; namespace: string;
  /** Empty/blank means "no preference" and is OMITTED from the manifest
   *  (never sent as `""`) so k8s falls back to the cluster's annotated
   *  default StorageClass — an explicit `storageClassName: ""` on a PVC is a
   *  k8s sentinel for "no class", which would instead disable dynamic
   *  provisioning entirely. */
  storageClassName: string; size: string;
  /** Run identity (see `run-id.ts`); when set, its `matchLabels()` is
   *  stamped onto the PVC so `reclaimSandbox` (Plan 5) can select it back by
   *  the same label (F7 — stamp/select symmetry, enforced by `RunId`). */
  runId?: RunId;
}): V1PersistentVolumeClaim {
  return {
    apiVersion: "v1",
    kind: "PersistentVolumeClaim",
    metadata: {
      name: i.name, namespace: i.namespace,
      labels: {
        "app.kubernetes.io/managed-by": "lastlight",
        "lastlight.io/component": "workspace",
        ...(i.runId ? i.runId.matchLabels() : {}),
      },
    },
    spec: {
      accessModes: ["ReadWriteOnce"],
      ...(i.storageClassName ? { storageClassName: i.storageClassName } : {}),
      resources: { requests: { storage: i.size } },
    },
  };
}
