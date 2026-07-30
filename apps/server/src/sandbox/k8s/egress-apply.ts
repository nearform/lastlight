import { ApiException, type CustomObjectsApi } from "@kubernetes/client-node";
import {
  CILIUM_CNP_PLURAL,
  CILIUM_GROUP,
  CILIUM_VERSION,
  renderEgressPolicies,
  type CiliumNetworkPolicy,
  type HarnessSelector,
} from "./egress-policy.js";

/**
 * Create-or-replace the strict/open CiliumNetworkPolicy pair in `namespace`.
 * Idempotent: a `409 AlreadyExists` on create falls through to a `replace`
 * (carrying the live object's `resourceVersion`) so a redeploy that changes the
 * allowlist updates the running policy. Any other error propagates — the caller
 * (the adapter) turns a `403` (RBAC not yet granted — Plan 6) into a warning.
 */
export async function applyEgressPolicies(
  custom: CustomObjectsApi,
  opts: { namespace: string; hosts: readonly string[]; harness?: HarnessSelector },
): Promise<void> {
  const { strict, open } = renderEgressPolicies({
    namespace: opts.namespace,
    hosts: opts.hosts,
    harness: opts.harness,
  });
  await createOrReplace(custom, opts.namespace, strict);
  await createOrReplace(custom, opts.namespace, open);
}

async function createOrReplace(
  custom: CustomObjectsApi,
  namespace: string,
  body: CiliumNetworkPolicy,
): Promise<void> {
  const coords = {
    group: CILIUM_GROUP,
    version: CILIUM_VERSION,
    namespace,
    plural: CILIUM_CNP_PLURAL,
  };
  try {
    await custom.createNamespacedCustomObject({ ...coords, body });
  } catch (err) {
    if (!(err instanceof ApiException) || err.code !== 409) throw err;
    const name = body.metadata.name;
    const current = (await custom.getNamespacedCustomObject({
      ...coords,
      name,
    })) as CiliumNetworkPolicy & {
      metadata: { resourceVersion?: string };
    };
    const withVersion = {
      ...body,
      metadata: { ...body.metadata, resourceVersion: current.metadata.resourceVersion },
    };
    await custom.replaceNamespacedCustomObject({ ...coords, name, body: withVersion });
  }
}
