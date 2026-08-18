import { SpanStatusCode, trace } from "@opentelemetry/api";
import { resolveKubernetesConfig } from "../../config/config.js";
import { sweepSandboxes } from "../../cron/sandbox-sweep.js";
import { makeK8sApis, type K8sApis } from "./client.js";
import { reclaimSandbox, type ReclaimCensus } from "./reclaim.js";
import { logger } from "../../logging/logger.js";
import { recordSandboxSweep, setSpanAttributes } from "../../telemetry/index.js";

const log = logger("k8s");
const tracer = () => trace.getTracer("lastlight");

/** How a sweep run was invoked. A label the job records; it never infers it —
 *  a function cannot tell who called it, and inferring would couple the job to
 *  its callers. Keeps `{trigger="cron"}` a valid liveness query when someone
 *  triggers a run by hand. */
export type SweepTrigger = "cron" | "manual" | "startup" | "library";

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
  /** How this run was invoked. Defaults to `library` — the honest answer when a
   *  caller does not say. */
  trigger?: SweepTrigger;
}

const EMPTY_CENSUS: ReclaimCensus = {
  pvcsFound: 0,
  pvcsLive: 0,
  pvcsStale: 0,
  pvcsCurrent: 0,
  deletedStale: 0,
  deletedOverCap: 0,
  deletedFailed: 0,
};

export async function sweepK8sSandboxes(opts: SweepK8sOpts): Promise<void> {
  const trigger = opts.trigger ?? "library";
  // The job owns its span: it is triggered from cron, at startup, from an admin
  // route, or as a library, and its telemetry must not depend on which. If a
  // caller already has a span active this becomes its child and inherits the
  // trace; with none active it starts a root. Either way no caller has to pass
  // a trace id.
  return tracer().startActiveSpan("sandbox.sweep", async (span) => {
    const startedAt = Date.now();
    let census: ReclaimCensus = { ...EMPTY_CENSUS };
    let failure: unknown;

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
      const result = await reclaimSandbox(apis, namespace, {
        kind: "sweep",
        staleByHours: opts.retentionHours,
        maxIdlePVCs: opts.maxIdlePVCs,
      });
      census = result.census;
    } catch (err) {
      failure = err;
      log.warn("sweepK8sSandboxes: skipping PVC reclaim", { err });
      span.recordException(err instanceof Error ? err : new Error(String(err)));
      span.setStatus({ code: SpanStatusCode.ERROR });
    } finally {
      // Reported from `finally` so a failed reclaim still says what it saw. A
      // summary emitted only on success would go missing on exactly the runs
      // worth reading, and an absent event is meant to mean "did not run".
      const durationMs = Date.now() - startedAt;
      const config = { retentionHours: opts.retentionHours, maxIdlePVCs: opts.maxIdlePVCs };

      setSpanAttributes(span, {
        trigger,
        "pvcs.found": census.pvcsFound,
        "pvcs.stale": census.pvcsStale,
        "deleted.stale": census.deletedStale,
        "deleted.overCap": census.deletedOverCap,
        ...config,
      });

      // Unconditional: emitted with zeros on an idle run, so the shape never
      // varies and absence of the event means the sweep did not run.
      log.info("Sweep complete", {
        trigger,
        pvcs: {
          found: census.pvcsFound,
          live: census.pvcsLive,
          stale: census.pvcsStale,
          current: census.pvcsCurrent,
        },
        deleted: {
          stale: census.deletedStale,
          overCap: census.deletedOverCap,
          failed: census.deletedFailed,
        },
        config,
        durationMs,
        ...(failure ? { err: failure } : {}),
      });

      recordSandboxSweep({ ...census, durationMs }, { trigger });
      span.end();
    }
  });
}
