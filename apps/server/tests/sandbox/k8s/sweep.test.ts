import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, vi } from "vitest";
import { sweepK8sSandboxes } from "#src/sandbox/k8s/sweep.js";

/** A fake `apis` whose PVC list is empty, so the cluster half of the sweep is a
 *  no-op and the test isolates the host-artifact half. */
function emptyApis() {
  return {
    core: {
      listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
      listNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedPod: vi.fn(),
      deleteNamespacedPersistentVolumeClaim: vi.fn(),
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

// Off-cluster / client-build failure: makeK8sApis() always throws here, so
// any test that omits `opts.apis` exercises the "no kubeconfig" catch path.
// Tests that pass an explicit fake `apis` never reach this mock.
vi.mock("#src/sandbox/k8s/client.js", () => ({
  makeK8sApis: () => {
    throw new Error("no kubeconfig found");
  },
}));

// sweep.ts (and reap.ts, exercised via the host-artifact-dir sweep) now log
// via the pino LoggerPort instead of console — mock the logger module so the
// suite's stderr stays free of real pino JSON (no assertions here depend on
// the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

/** Minimal PVC fixture — mirrors reclaim.test.ts's `pvc` helper. Defaults
 *  `now` to the real clock since `reclaimSandbox` (via `sweepK8sSandboxes`,
 *  which has no `now` seam) always ages against `Date.now()`. */
function pvc(name: string, ageHrs: number, now = Date.now()) {
  return {
    metadata: {
      name,
      labels: {},
      creationTimestamp: new Date(now - ageHrs * 3_600_000),
    },
  };
}

describe("sweepK8sSandboxes", () => {
  it("reclaims a stale idle PVC via the sweep selector from retentionHours/maxIdle", async () => {
    const listPods = vi.fn().mockResolvedValue({ items: [] });
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("old", 30)] });
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

    // retentionHours=12 → the 30h-old PVC is stale and gets reclaimed.
    await sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, apis, namespace: "ns" });

    expect(listPods).toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: "ns",
        labelSelector: "app.kubernetes.io/managed-by=lastlight",
      }),
    );
    expect(delPvc).toHaveBeenCalledWith(expect.objectContaining({ name: "old" }));
    expect(delPod).not.toHaveBeenCalled();
  });

  it("keeps a fresh PVC under the LRU cap untouched", async () => {
    const listPvcs = vi.fn().mockResolvedValue({ items: [pvc("fresh", 0.1)] });
    const delPvc = vi.fn().mockResolvedValue({});
    const apis = {
      core: {
        listNamespacedPod: vi.fn().mockResolvedValue({ items: [] }),
        listNamespacedPersistentVolumeClaim: listPvcs,
        deleteNamespacedPod: vi.fn(),
        deleteNamespacedPersistentVolumeClaim: delPvc,
      },
    } as any;

    await sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, apis, namespace: "ns" });

    expect(delPvc).not.toHaveBeenCalled();
  });

  it("swallows a rejecting (transport-failure) client without throwing", async () => {
    const apis = {
      core: {
        listNamespacedPod: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        listNamespacedPersistentVolumeClaim: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        deleteNamespacedPod: vi.fn(),
        deleteNamespacedPersistentVolumeClaim: vi.fn(),
      },
    } as any;

    await expect(
      sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, apis, namespace: "ns" }),
    ).resolves.toBeUndefined();
  });

  it("swallows a client-build failure (off-cluster, no kubeconfig) without throwing", async () => {
    // No `apis` supplied — falls through to the (mocked, throwing) makeK8sApis().
    await expect(
      sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, namespace: "ns" }),
    ).resolves.toBeUndefined();
  });

  it("also age-sweeps host-local artifact dirs when stateDir is given", async () => {
    // The artifact store is host-local on EVERY backend, so a k8s pod's uploaded
    // `.lastlight/` lands at `<sandboxDir>/<taskId>` on the harness. The host-dir
    // sweep is disabled on k8s (this runs instead), so this backstop must reap
    // those dirs too — otherwise cancelled / failed / reuse-success runs leak
    // artifact storage on the host indefinitely.
    const stateDir = mkdtempSync(join(tmpdir(), "k8s-hostsweep-"));
    const stale = join(stateDir, "sandboxes", "old-run");
    const fresh = join(stateDir, "sandboxes", "live-run");
    mkdirSync(join(stale, ".lastlight"), { recursive: true });
    mkdirSync(join(fresh, ".lastlight"), { recursive: true });
    const past = (Date.now() - 48 * 3_600_000) / 1000; // 48h old → beyond 12h retention
    utimesSync(stale, past, past);

    await sweepK8sSandboxes({
      retentionHours: 12,
      maxIdlePVCs: 40,
      maxDirs: 40,
      stateDir,
      apis: emptyApis(),
      namespace: "ns",
      isLive: () => false, // no docker on a k8s host; keep the unit test hermetic
    });

    expect(existsSync(stale)).toBe(false); // aged out
    expect(existsSync(fresh)).toBe(true); // recent → kept
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("leaves host artifact dirs untouched when stateDir is omitted (cluster-only sweep)", async () => {
    // Back-compat: the existing call sites that pass no stateDir must not gain a
    // host-dir sweep — the param opting into it is explicit.
    await expect(
      sweepK8sSandboxes({ retentionHours: 12, maxIdlePVCs: 40, apis: emptyApis(), namespace: "ns" }),
    ).resolves.toBeUndefined();
  });
});
