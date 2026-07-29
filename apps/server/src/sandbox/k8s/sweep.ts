import { resolveKubernetesConfig } from "../../config/config.js";
import { sweepSandboxes } from "../../cron/sandbox-sweep.js";
import { makeK8sApis, type K8sApis } from "./client.js";
import { reclaimSandbox } from "./reclaim.js";

/**
 * The `kubernetes` backend's backstop sweep (Plan 5) — it runs in place of the
 * host-dir sweep (`src/cron/sandbox-sweep.ts`), which is disabled on this
 * backend, so it must cover BOTH surfaces the backend leaves behind:
 *
 *   1. **Cluster PVCs** — idle per-(repo,PR) workspace PVCs, reclaimed via
 *      `reclaimSandbox`'s `sweep` selector: age (`retentionHours`) then an LRU
 *      cap (`maxIdlePVCs`).
 *   2. **Host-local artifact dirs** — the artifact store is host-local on every
 *      backend (`LocalArtifactBackend`), so a pod's uploaded `.lastlight/` lands
 *      at `<sandboxDir>/<taskId>` on the harness even under k8s. Reap-on-success
 *      (`simple.ts`) and the cancel route gc these on their own paths, but
 *      cancel-missed / failed / reuse-success runs would otherwise accumulate
 *      indefinitely (nothing else sweeps `<sandboxDir>` on k8s). When `stateDir`
 *      is given, this delegates to the same `sweepSandboxes` the host backend
 *      uses (age + LRU, same knobs) to bound them.
 *
 * Mirrors the host sweep's config knobs (`cleanup.sandbox.retentionHours` /
 * `.maxDirs`) 1:1.
 *
 * Best-effort and off-cluster-safe: building the client (`makeK8sApis`) or
 * running the PVC reclaim can fail — no kubeconfig in a dev harness, a transient
 * transport error — and this must never throw out of the cron handler that
 * calls it, so those are wrapped in a try/catch that warns and returns. The
 * host-dir sweep is a pure filesystem op (already per-dir best-effort) and runs
 * first, so a cluster-side failure never skips it.
 *
 * `apis` / `namespace` / `isLive` are test seams — production omits them and
 * uses the real client, the resolved `kubernetes.namespace`, and the real
 * live-container probe (a no-op on a k8s host, where docker is absent).
 */
export interface SweepK8sOpts {
  retentionHours: number;
  maxIdlePVCs: number;
  /** When set, also age/LRU-sweep host-local artifact dirs under
   *  `<sandboxDir>/<taskId>`. Omit (existing cluster-only callers) to skip it. */
  stateDir?: string;
  sandboxDir?: string;
  /** LRU cap for host artifact dirs (defaults to `maxIdlePVCs` — the same
   *  `cleanup.sandbox.maxDirs` knob feeds both). */
  maxDirs?: number;
  apis?: K8sApis;
  namespace?: string;
  isLive?: (taskId: string) => boolean;
}

export async function sweepK8sSandboxes(opts: SweepK8sOpts): Promise<void> {
  if (opts.stateDir) {
    sweepSandboxes({
      stateDir: opts.stateDir,
      sandboxDir: opts.sandboxDir,
      retentionHours: opts.retentionHours,
      maxDirs: opts.maxDirs ?? opts.maxIdlePVCs,
      isLive: opts.isLive,
    });
  }
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
    console.warn(`[k8s] sweepK8sSandboxes: skipping PVC reclaim — ${message}`);
  }
}
