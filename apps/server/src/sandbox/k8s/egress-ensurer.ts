import { ApiException, type CustomObjectsApi } from "@kubernetes/client-node";
import { applyEgressPolicies } from "./egress-apply.js";
import type { HarnessSelector } from "./egress-policy.js";

/**
 * Applies the strict/open CiliumNetworkPolicy egress pair to a namespace,
 * once per namespace for the lifetime of this instance.
 *
 * The ensure-once cache is an instance field (a `Map` keyed by namespace), not
 * a process-global — production shares one instance (the module-level
 * {@link egressEnsurer} singleton, injected via `K8sAdapterConfig.egressEnsurer`)
 * across every `KubernetesSandbox`, so the policies still apply exactly once
 * per namespace per process. Tests inject a fresh instance instead, so two
 * tests sharing a namespace don't need one to dodge the other's cache.
 */
export class EgressEnsurer {
  private readonly ensured = new Map<string, Promise<void>>();

  /**
   * Apply the egress policy pair to `namespace`, once. Best-effort: a 403 (the
   * CiliumNetworkPolicy RBAC verb not yet granted — Plan 6) is logged as a
   * single warning and the returned promise resolves, so the caller runs on
   * Cilium's default-allow instead of failing. Any other error clears the
   * cached entry — so a later call retries the apply — and rethrows.
   *
   * @param custom - Kubernetes `CustomObjectsApi` client used to apply the CRDs.
   * @param namespace - Namespace the policy pair is scoped to; also the cache key.
   * @param hosts - Allowlisted hosts for the strict policy's `toFQDNs` rule.
   * @param harness - Harness Pod selector both policies carve an exception for.
   * @returns A promise that resolves once the policies are applied (or the
   *   403 is warned-and-swallowed); the same promise is returned to every
   *   caller for `namespace` until it settles or is cleared by a real error.
   */
  ensure(
    custom: CustomObjectsApi,
    namespace: string,
    hosts: readonly string[],
    harness: HarnessSelector,
  ): Promise<void> {
    const pending = this.ensured.get(namespace);
    if (pending) return pending;
    const applied = applyEgressPolicies(custom, { namespace, hosts, harness }).catch((err) => {
      if (err instanceof ApiException && err.code === 403) {
        console.warn(
          `[k8s] egress policies not applied in ${namespace}: RBAC for ` +
            `CiliumNetworkPolicy is not granted (Plan 6). Running WITHOUT egress ` +
            `enforcement (Cilium default-allow).`,
        );
        return; // resolve — don't retry/re-log every run
      }
      this.ensured.delete(namespace); // real error: allow a later call to retry
      throw err;
    });
    this.ensured.set(namespace, applied);
    return applied;
  }
}

/** Process-wide singleton: production shares one instance across every
 *  `KubernetesSandbox`, so the egress policy pair is applied once per
 *  namespace per process (the same "ensure once" behaviour the previous
 *  module-global cache gave). */
export const egressEnsurer = new EgressEnsurer();
