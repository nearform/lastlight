import { resolveKubernetesConfig } from "../../config/config.js";
import { makeK8sApis, type K8sApis } from "./client.js";
import { reclaimSandbox } from "./reclaim.js";

/**
 * The `kubernetes` backend's backstop sweep (Plan 5). The host-dir sweep
 * (`src/cron/sandbox-sweep.ts`) has nothing to reap on this backend — there
 * are no host clones — so instead this reclaims idle PVCs via
 * `reclaimSandbox`'s `sweep` selector: age (`retentionHours`) then an LRU cap
 * (`maxIdlePVCs`). Mirrors the host sweep's config knobs
 * (`cleanup.sandbox.retentionHours` / `.maxDirs`) 1:1.
 *
 * Best-effort and off-cluster-safe: building the client (`makeK8sApis`) or
 * running the reclaim can fail — no kubeconfig in a dev harness, a transient
 * transport error — and this must never throw out of the cron handler that
 * calls it, so both are wrapped in one try/catch that warns and returns.
 * (A 403 on the list itself is already handled inside `reclaimSandbox`.)
 *
 * `apis` / `namespace` are test seams — production omits both and uses the
 * real client + the resolved `kubernetes.namespace`.
 */
export interface SweepK8sOpts {
  retentionHours: number;
  maxIdlePVCs: number;
  apis?: K8sApis;
  namespace?: string;
}

export async function sweepK8sSandboxes(opts: SweepK8sOpts): Promise<void> {
  try {
    const apis = opts.apis ?? makeK8sApis();
    const namespace = opts.namespace ?? resolveKubernetesConfig().namespace;
    await reclaimSandbox(apis, namespace, {
      kind: "sweep",
      staleByHours: opts.retentionHours,
      maxIdlePVCs: opts.maxIdlePVCs,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[k8s] sweepK8sSandboxes: skipping — ${message}`);
  }
}
