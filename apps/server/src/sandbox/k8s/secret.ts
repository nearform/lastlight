import type { V1Secret, V1OwnerReference } from "@kubernetes/client-node";
import { Rfc1123Label } from "./resource-name.js";

export function buildSecretManifest(i: {
  name: string;
  namespace: string;
  data: Record<string, string>;
  labels?: Record<string, string>;
}): V1Secret {
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: i.name,
      namespace: i.namespace,
      labels: { "app.kubernetes.io/managed-by": "lastlight", ...(i.labels ?? {}) },
    },
    // stringData: k8s base64-encodes on write; keeps the builder plaintext-simple.
    stringData: i.data,
  };
}

/** Cascade-GC ref: when the Pod is deleted, k8s GCs the owned Secret. */
export function podOwnerReference(podName: string, podUid: string): V1OwnerReference {
  return {
    apiVersion: "v1",
    kind: "Pod",
    name: podName,
    uid: podUid,
    controller: true,
    blockOwnerDeletion: true,
  };
}

/** Derives the creds/prompt Secret name from a pod name. Takes the
 *  `Rfc1123Label` `podNameFor` (naming.ts) returns — not a raw string — so a
 *  Secret name can only ever be derived from an actual pod name; the
 *  compiler rejects anything else, which is what makes the "stays within 63
 *  chars" invariant a structural fact rather than a comment (F6).
 *  `podNameFor` reserves an 8-char budget so this never overflows for a
 *  label it produced; `Rfc1123Label.withSuffix` is the enforced backstop —
 *  it throws instead of silently emitting an invalid >63-char Secret name
 *  if that budget were ever wrong. */
export function secretNameFor(podName: Rfc1123Label, kind: "creds" | "prompt"): string {
  return podName.withSuffix(kind).value;
}
