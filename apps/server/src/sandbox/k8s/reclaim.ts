import { ApiException } from "@kubernetes/client-node";
import type { V1PersistentVolumeClaim, V1Pod } from "@kubernetes/client-node";
import type { K8sApis } from "./client.js";
import { RUN_ID_LABEL } from "./pod.js";
import type { RunId } from "./run-id.js";
import { logger } from "../../logging/logger.js";

const log = logger("reclaim");

/** Selects the label every sandbox Pod/PVC carries (`pod.ts` / `pvc.ts`) — the
 *  list-scope for `reclaimSandbox` so it never touches non-Last-Light objects. */
const MANAGED_BY_SELECTOR = "app.kubernetes.io/managed-by=lastlight";

/** What to reclaim. `run` targets one run's own Pod + PVC (cancel/cleanup) —
 *  carrying a `RunId` (not a raw string) so the selector compares against
 *  exactly the label `pod.ts`/`pvc.ts` stamped (F7). `sweep` reclaims only
 *  idle PVCs (age + LRU cap), never a Pod. */
export type ReclaimSelector =
  | { kind: "run"; runId: RunId }
  | { kind: "sweep"; staleByHours: number; maxIdlePVCs: number };

const LIVE_PHASES = new Set(["Pending", "Running"]);

/** True when a pod is still using its volumes: phase is Pending/Running AND it
 *  has not been marked for deletion yet. Pure — no client. */
function isLive(pod: V1Pod): boolean {
  return LIVE_PHASES.has(pod.status?.phase ?? "") && pod.metadata?.deletionTimestamp === undefined;
}

/**
 * Claim names mounted by any LIVE pod (see {@link isLive}). Pure — plain
 * arrays in, a `Set` out, no client — so the reclaim-selection logic is
 * unit-testable without a fake `K8sApis`.
 */
export function livePvcClaimNames(pods: V1Pod[]): Set<string> {
  const claims = new Set<string>();
  for (const pod of pods) {
    if (!isLive(pod)) continue;
    for (const volume of pod.spec?.volumes ?? []) {
      const claimName = volume.persistentVolumeClaim?.claimName;
      if (claimName) claims.add(claimName);
    }
  }
  return claims;
}

/**
 * Pure PVC selection for `reclaimSandbox`. NEVER returns a PVC whose name is
 * in `live` — that invariant holds regardless of selector kind. For `run`,
 * matches PVCs whose `RUN_ID_LABEL` equals `selector.runId.label`. For `sweep`,
 * first selects PVCs older than `staleByHours` (by `creationTimestamp`), then
 * — if more than `maxIdlePVCs` PVCs remain idle (not selected, not live) —
 * LRU-evicts the oldest of those beyond the cap, keeping the newest
 * `maxIdlePVCs`.
 */
export function pvcsToReclaim(
  pvcs: V1PersistentVolumeClaim[],
  selector: ReclaimSelector,
  live: Set<string>,
  now: number,
): V1PersistentVolumeClaim[] {
  const idle = pvcs.filter((p) => p.metadata?.name && !live.has(p.metadata.name));

  if (selector.kind === "run") {
    return idle.filter((p) => p.metadata?.labels?.[RUN_ID_LABEL] === selector.runId.label);
  }

  const maxAgeMs = selector.staleByHours * 3_600_000;
  const ageOf = (p: V1PersistentVolumeClaim): number => {
    const created = p.metadata?.creationTimestamp;
    return created ? now - new Date(created).getTime() : 0;
  };

  const stale = idle.filter((p) => ageOf(p) > maxAgeMs);
  const staleNames = new Set(stale.map((p) => p.metadata?.name));
  const survivors = idle.filter((p) => !staleNames.has(p.metadata?.name));

  const evicted: V1PersistentVolumeClaim[] = [];
  if (survivors.length > selector.maxIdlePVCs) {
    // Newest first; keep the leading `maxIdlePVCs`, evict everything older.
    const byAgeAsc = [...survivors].sort((a, b) => ageOf(a) - ageOf(b));
    evicted.push(...byAgeAsc.slice(selector.maxIdlePVCs));
  }

  return [...stale, ...evicted];
}

export interface ReclaimResult {
  podsDeleted: number;
  pvcsDeleted: number;
}

export interface ReclaimOpts {
  now?: number;
  onWarn?: (message: string) => void;
}

/**
 * Delete what `selector` matches, minus whatever is currently LIVE. The only
 * code (besides a per-run `dispose`) that deletes sandbox Pods/PVCs — lists
 * both (scoped to the managed-by label), computes the live set, then deletes
 * matched pods (run selector only) before matched PVCs. Idempotent (a 404 on
 * delete counts as success) and best-effort per object (a non-404 delete
 * failure warns and moves on to the next object). A 403 on the initial list
 * means the RBAC verb isn't granted yet (Plan 7) — warns once and no-ops,
 * mirroring `egress-apply.ts`'s handling of the same case.
 */
export async function reclaimSandbox(
  apis: K8sApis,
  namespace: string,
  selector: ReclaimSelector,
  opts?: ReclaimOpts,
): Promise<ReclaimResult> {
  // Custom `onWarn` (a test seam / caller-supplied string logger) keeps its
  // message-only contract; the default (production) path logs structured —
  // with `{ err }` where available — so the stack survives instead of being
  // flattened into a string by the caller-agnostic callback shape.
  const warn = (message: string, fields?: Record<string, unknown>): void => {
    if (opts?.onWarn) opts.onWarn(message);
    else log.warn(message, fields);
  };
  const now = opts?.now ?? Date.now();

  let pods: V1Pod[];
  let pvcs: V1PersistentVolumeClaim[];
  try {
    const [podList, pvcList] = await Promise.all([
      apis.core.listNamespacedPod({ namespace, labelSelector: MANAGED_BY_SELECTOR }),
      apis.core.listNamespacedPersistentVolumeClaim({
        namespace,
        labelSelector: MANAGED_BY_SELECTOR,
      }),
    ]);
    pods = podList.items ?? [];
    pvcs = pvcList.items ?? [];
  } catch (err) {
    if (err instanceof ApiException && err.code === 403) {
      warn(
        "reclaimSandbox: RBAC for listing Pods/PVCs is not granted (Plan 7). Skipping reclaim.",
        { namespace },
      );
      return { podsDeleted: 0, pvcsDeleted: 0 };
    }
    throw err;
  }

  const isSelectorPod = (p: V1Pod): boolean =>
    selector.kind === "run" && p.metadata?.labels?.[RUN_ID_LABEL] === selector.runId.label;
  const matchedPods = pods.filter(isSelectorPod);

  // A `run` reclaim targets the run's OWN objects — including a still-live
  // pod racing its own teardown (e.g. a cancel). Exclude the selector's own
  // pods from `live` before selecting PVCs, so this run's PVC isn't protected
  // by the very pod we're about to delete. `sweep` uses the full live set —
  // it must never reclaim a PVC any live pod (of any run) still mounts.
  const liveForPvcs =
    selector.kind === "run"
      ? livePvcClaimNames(pods.filter((p) => !isSelectorPod(p)))
      : livePvcClaimNames(pods);

  const matchedPvcs = pvcsToReclaim(pvcs, selector, liveForPvcs, now);

  let podsDeleted = 0;
  for (const pod of matchedPods) {
    const name = pod.metadata?.name;
    if (!name) continue;
    const deleteOp = (): Promise<unknown> => apis.core.deleteNamespacedPod({ name, namespace });
    if (await deleteBestEffort(deleteOp, name, "Pod", warn)) {
      podsDeleted += 1;
    }
  }

  let pvcsDeleted = 0;
  for (const pvc of matchedPvcs) {
    const name = pvc.metadata?.name;
    if (!name) continue;
    if (
      await deleteBestEffort(
        () => apis.core.deleteNamespacedPersistentVolumeClaim({ name, namespace }),
        name,
        "PVC",
        warn,
      )
    ) {
      pvcsDeleted += 1;
    }
  }

  return { podsDeleted, pvcsDeleted };
}

/** Delete one object: a 404 is success (already gone); any other error warns
 *  and returns false so the caller moves on instead of aborting the reclaim. */
async function deleteBestEffort(
  op: () => Promise<unknown>,
  name: string,
  kind: string,
  warn: (message: string, fields?: Record<string, unknown>) => void,
): Promise<boolean> {
  try {
    await op();
    return true;
  } catch (err) {
    if (err instanceof ApiException && err.code === 404) return true;
    warn(`reclaimSandbox: failed to delete ${kind} ${name}`, { kind, name, err });
    return false;
  }
}
