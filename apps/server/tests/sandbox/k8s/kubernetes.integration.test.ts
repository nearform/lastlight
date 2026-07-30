import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ApiException } from "@kubernetes/client-node";
import type { V1PersistentVolumeClaim } from "@kubernetes/client-node";
import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";
import { QuotaExceededError } from "#src/sandbox/k8s/quota.js";
import { makeK8sApis, type K8sApis } from "#src/sandbox/k8s/client.js";
import { reclaimSandbox } from "#src/sandbox/k8s/reclaim.js";
import { pvcNameFor } from "#src/sandbox/k8s/pvc.js";
import { podNameFor, sanitizeLabelValue } from "#src/sandbox/k8s/naming.js";
import { RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";
import { RunId } from "#src/sandbox/k8s/run-id.js";
import {
  CILIUM_CNP_PLURAL,
  CILIUM_GROUP,
  CILIUM_VERSION,
  STRICT_POLICY_NAME,
} from "#src/sandbox/k8s/egress-policy.js";

const RUN = process.env.RUN_K8S_IT === "1";
const IMAGE = process.env.K8S_SANDBOX_IMAGE ??
  "ghcr.io/yo61/lastlight-sandbox:latest";
const HAS_AI = !!process.env.ANTHROPIC_API_KEY;
const HARNESS_ENDPOINT = process.env.LASTLIGHT_K8S_HARNESS_ENDPOINT ??
  "http://lastlight.lastlight.svc.cluster.local:8644";
const HARNESS_NAMESPACE = process.env.LASTLIGHT_K8S_HARNESS_NAMESPACE ?? "lastlight";
const HARNESS_POD_LABELS = { "app.kubernetes.io/name": "lastlight" };

/**
 * Filesystem root where the ArtifactStore's `LocalArtifactBackend` writes,
 * from the perspective of wherever THIS test process runs. In a real
 * `RUN_K8S_IT` run, the sandbox Pod's exit hook uploads to the DEPLOYED
 * harness at `HARNESS_ENDPOINT` — a different process from this test — so
 * asserting on the uploaded file only works when this test's filesystem is
 * the same one that harness writes to (run directly on the harness host, or
 * over a shared NFS/PV mount). Override to whatever that shared root
 * resolves to; the default mirrors the harness's own resolution
 * (`getRuntimeConfig()?.sandboxDir ?? $STATE_DIR/sandboxes`, `STATE_DIR`
 * defaulting to `./data`) and is very unlikely to be correct unmodified.
 */
const HARNESS_SANDBOX_DIR =
  process.env.LASTLIGHT_K8S_HARNESS_SANDBOX_DIR ?? join(process.env.STATE_DIR || "data", "sandboxes");

/** True once the strict CiliumNetworkPolicy has actually been applied in
 *  `namespace` — false when the apply 403'd (RBAC not yet granted, Plan 6)
 *  and the adapter's ensure path fell back to a warning. */
async function strictPolicyPresent(namespace: string): Promise<boolean> {
  const { custom } = makeK8sApis();
  try {
    await custom.getNamespacedCustomObject({
      group: CILIUM_GROUP,
      version: CILIUM_VERSION,
      namespace,
      plural: CILIUM_CNP_PLURAL,
      name: STRICT_POLICY_NAME,
    });
    return true;
  } catch {
    return false;
  }
}

/** Read a PVC by name; `null` on 404 (gone), rethrow anything else. */
async function readPvc(
  apis: K8sApis,
  namespace: string,
  name: string,
): Promise<V1PersistentVolumeClaim | null> {
  try {
    return await apis.core.readNamespacedPersistentVolumeClaim({ name, namespace });
  } catch (err) {
    if (err instanceof ApiException && err.code === 404) return null;
    throw err;
  }
}

/** True when a captured `reclaimSandbox` warning indicates the list RBAC
 *  (Plan 7) isn't granted yet — the only 403 `reclaimSandbox` itself warns
 *  about (a delete 403 warns too, but list 403s first and short-circuits
 *  before any delete is attempted, so this single check covers both). */
function rbacMissing(warnings: string[]): boolean {
  return warnings.some((w) => w.includes("RBAC"));
}

/** Poll until `name` exists with phase Pending/Running (i.e. "live" per
 *  `reclaimSandbox`'s own `isLive`) — Pending counts, so this resolves as
 *  soon as the Pod object is created, well before it's actually scheduled. */
async function waitForPodLive(apis: K8sApis, namespace: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const pod = await apis.core.readNamespacedPodStatus({ name, namespace });
      const phase = pod.status?.phase;
      if ((phase === "Pending" || phase === "Running") && !pod.metadata?.deletionTimestamp) {
        return;
      }
    } catch {
      /* not created yet — keep polling */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`pod ${name} never reached Pending/Running within budget`);
}

describe.runIf(RUN)("KubernetesSandbox Plan 1 (integration)", () => {
  it(
    "runs a bash command in a real pod and streams stdout",
    async () => {
      // Unique per run so a prior run's pod (deterministic name) can't
      // collide, and always dispose so a failed assertion never orphans
      // a pod.
      const taskId = `k8s-it-${Date.now()}`;
      const sbx = new KubernetesSandbox(
        {
          taskId,
          egress: { unrestricted: false, hosts: [] },
          env: {},
          stateDir: "/tmp",
          timeoutSeconds: 120,
        } as any,
        {
          namespace: process.env.LASTLIGHT_K8S_NAMESPACE ??
            "lastlight-sandboxes",
          image: IMAGE,
          storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
            "truenas-iscsi",
          workspaceSize: "2Gi",
          runAsUser: parseInt(
            process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
            10,
          ),
          harnessEndpoint: HARNESS_ENDPOINT,
          harnessNamespace: HARNESS_NAMESPACE,
          harnessPodLabels: HARNESS_POD_LABELS,
        },
      );
      await sbx.provision();
      try {
        const res = await sbx.runCommand(taskId, "echo hello-from-pod", {
          cwd: "/home/agent/workspace",
          timeoutSeconds: 120,
        });
        expect(res.stdout).toContain("hello-from-pod");
        expect(res.exitCode).toBe(0);
      } finally {
        await sbx.dispose();
      }
    },
    180_000,
  );
});

describe.runIf(RUN)("KubernetesSandbox Plan 2 (integration)", () => {
  const mkSbx = (taskId: string, env: Record<string, string>) =>
    new KubernetesSandbox(
      {
        taskId,
        egress: { unrestricted: false, hosts: [] },
        env,
        stateDir: "/tmp",
        timeoutSeconds: 300,
      } as any,
      {
        namespace: process.env.LASTLIGHT_K8S_NAMESPACE ??
          "lastlight-sandboxes",
        image: IMAGE,
        storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
          "truenas-iscsi",
        workspaceSize: "2Gi",
        runAsUser: parseInt(
          process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
          10,
        ),
        harnessEndpoint: HARNESS_ENDPOINT,
        harnessNamespace: HARNESS_NAMESPACE,
        harnessPodLabels: HARNESS_POD_LABELS,
      },
    );

  it(
    "clones a public repo into the PVC and runs a command against it",
    async () => {
      // The pod name derives from the runCommand/runAgent taskId arg, so it
      // must be unique per case — else back-to-back cases collide on a pod name
      // whose prior instance is still terminating (409 AlreadyExists).
      const taskId = `it-clone-${Date.now()}`;
      const sbx = mkSbx(taskId, {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
      });
      try {
        await sbx.provision({
          owner: "octocat",
          repo: "Hello-World",
          branch: "master",
          token: process.env.GITHUB_TOKEN ?? "",
        } as any);
        const res = await sbx.runCommand(
          taskId,
          "cat README && git -C . rev-parse --abbrev-ref HEAD",
          {
            cwd: "/home/agent/workspace/Hello-World",
            timeoutSeconds: 300,
          },
        );
        expect(res.exitCode).toBe(0);
        expect(res.stdout.toLowerCase()).toContain("hello");
      } finally {
        await sbx.dispose();
      }
    },
    300_000,
  );

  it.runIf(HAS_AI)(
    "runs an AI phase whose prompt arrives via the mounted Secret",
    async () => {
      const taskId = `it-ai-${Date.now()}`;
      const sbx = mkSbx(taskId, {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
      });
      const events: any[] = [];
      try {
        await sbx.provision({
          owner: "octocat",
          repo: "Hello-World",
          branch: "master",
          token: process.env.GITHUB_TOKEN ?? "",
        } as any);
        await sbx.runAgent(
          taskId,
          "Reply with exactly the word PONG and nothing else.",
          {
            model: "anthropic/claude-haiku-4-5-20251001",
            sandboxEnv: {},
            agentCwd: "/home/agent/workspace/Hello-World",
          } as any,
          (e) => events.push(e),
        );
        expect(events.some((e) => e.type === "agent_end")).toBe(true);
      } finally {
        await sbx.dispose();
      }
    },
    300_000,
  );
});

describe.runIf(RUN)("KubernetesSandbox Plan 8 artifact-store (integration)", () => {
  const mkSbx = (taskId: string, env: Record<string, string>) =>
    new KubernetesSandbox(
      {
        taskId,
        egress: { unrestricted: false, hosts: [] },
        env,
        stateDir: "/tmp",
        timeoutSeconds: 300,
      } as any,
      {
        namespace: process.env.LASTLIGHT_K8S_NAMESPACE ??
          "lastlight-sandboxes",
        image: IMAGE,
        storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
          "truenas-iscsi",
        workspaceSize: "2Gi",
        runAsUser: parseInt(
          process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
          10,
        ),
        harnessEndpoint: HARNESS_ENDPOINT,
        harnessNamespace: HARNESS_NAMESPACE,
        harnessPodLabels: HARNESS_POD_LABELS,
      },
    );

  // Only `runAgent` mints an artifact token and appends the post-run
  // tar+upload step (`runCommand` never uploads — nothing to upload), so this
  // case needs a real AI call, same gate as the Plan 2 AI case above.
  it.runIf(HAS_AI)(
    "a real run's .lastlight/ findings upload round-trips to the harness host",
    async () => {
      const taskId = `it-artifact-${Date.now()}`;
      const sbx = mkSbx(taskId, {
        GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "",
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY!,
      });
      const events: any[] = [];
      try {
        await sbx.provision({
          owner: "octocat",
          repo: "Hello-World",
          branch: "master",
          token: process.env.GITHUB_TOKEN ?? "",
        } as any);
        await sbx.runAgent(
          taskId,
          "Using your shell/bash tool, run exactly this one command and " +
            "nothing else, then reply with exactly the word DONE: " +
            "mkdir -p .lastlight/pr-review && printf '%s' " +
            '\'{"skip":true,"summary":"k8s artifact-store IT","event":"COMMENT","findings":[]}\' ' +
            "> .lastlight/pr-review/findings.json",
          {
            model: "anthropic/claude-haiku-4-5-20251001",
            sandboxEnv: {},
            agentCwd: "/home/agent/workspace/Hello-World",
          } as any,
          (e) => events.push(e),
        );
        expect(events.some((e) => e.type === "agent_end")).toBe(true);

        // The pod's exit hook best-effort uploads `.lastlight/` right after
        // the agent exits (`|| true` — never masks the agent's own exit
        // code), so give the upload a moment to land before asserting.
        const findingsPath = join(
          HARNESS_SANDBOX_DIR,
          taskId,
          ".lastlight",
          "pr-review",
          "findings.json",
        );
        for (let attempt = 0; attempt < 10 && !existsSync(findingsPath); attempt++) {
          await new Promise((r) => setTimeout(r, 1000));
        }
        expect(existsSync(findingsPath)).toBe(true);
        const doc = JSON.parse(readFileSync(findingsPath, "utf8"));
        expect(doc.summary).toBe("k8s artifact-store IT");
      } finally {
        await sbx.dispose();
      }
    },
    300_000,
  );
});

describe.runIf(RUN)("KubernetesSandbox Plan 3 egress (integration)", () => {
  const NAMESPACE = process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes";

  const mkSbx = (taskId: string) =>
    new KubernetesSandbox(
      {
        taskId,
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 120,
      } as any,
      {
        namespace: NAMESPACE,
        image: IMAGE,
        storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
          "truenas-iscsi",
        workspaceSize: "2Gi",
        runAsUser: parseInt(
          process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
          10,
        ),
        harnessEndpoint: HARNESS_ENDPOINT,
        harnessNamespace: HARNESS_NAMESPACE,
        harnessPodLabels: HARNESS_POD_LABELS,
      },
    );

  it(
    "enforces strict egress: an allowlisted host connects, a non-allowlisted host is blocked",
    async () => {
      // Unique per run, same collision reasoning as the Plan 2 cases.
      const taskId = `it-egress-${Date.now()}`;
      const sbx = mkSbx(taskId);
      try {
        await sbx.provision();

        // curl -sS -m 8: 443 to an allowlisted host succeeds; a non-allowlisted
        // host must fail under the strict policy. Each `||`/`&&` branch keeps
        // the overall command exit 0 so we assert on stdout, not the pod's
        // exit code (a non-zero exit would throw before we get to inspect it).
        // The EVIL curl omits `-w "%{http_code}"`: on a blocked connection curl
        // prints "000" for that format before the shell hits `||`, which would
        // land between "evil=" and "BLOCKED" and break the toContain match. The
        // GITHUB curl keeps `-w` since its failure branch is an unexpected-error
        // case that should fail the test, not something this test massages.
        const script = [
          'echo -n "github="; curl -sS -m 8 -o /dev/null -w "%{http_code}" ' +
            'https://api.github.com/ || echo -n "ERR"',
          'echo; echo -n "evil="; curl -sS -m 8 -o /dev/null ' +
            'https://example.com/ && echo -n "OK" || echo -n "BLOCKED"',
        ].join("; ");
        const result = await sbx.runCommand(taskId, script, {
          cwd: "/home/agent/workspace",
          timeoutSeconds: 60,
        });

        // Skip enforcement assertions if the policy wasn't applied — no
        // CiliumNetworkPolicy RBAC yet (Plan 6), so the adapter's ensure path
        // 403'd and warned instead of failing the run.
        const present = await strictPolicyPresent(NAMESPACE);
        if (!present) {
          console.warn(
            "[IT] CiliumNetworkPolicy not applied (RBAC pending — Plan 6); " +
              "skipping enforcement assertions",
          );
          expect(result.stdout).toContain("github=200"); // works either way
          return;
        }

        expect(result.stdout).toContain("github=200"); // allowlisted → reachable
        expect(result.stdout).toContain("evil=BLOCKED"); // non-allowlisted → denied
      } finally {
        await sbx.dispose();
      }
    },
    180_000,
  );
});

describe.runIf(RUN)("KubernetesSandbox Plan 5 reclaim (integration)", () => {
  const NAMESPACE = process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes";

  const mkSbx = (taskId: string) =>
    new KubernetesSandbox(
      {
        taskId,
        egress: { unrestricted: false, hosts: [] },
        env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN ?? "" },
        stateDir: "/tmp",
        timeoutSeconds: 180,
      } as any,
      {
        namespace: NAMESPACE,
        image: IMAGE,
        storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
          "truenas-iscsi",
        workspaceSize: "2Gi",
        runAsUser: parseInt(
          process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
          10,
        ),
        harnessEndpoint: HARNESS_ENDPOINT,
        harnessNamespace: HARNESS_NAMESPACE,
        harnessPodLabels: HARNESS_POD_LABELS,
      },
    );

  it(
    "reclaim-by-run deletes the run's PVC after dispose",
    async () => {
      // Unique per case, same collision reasoning as the Plan 2/3 cases.
      const taskId = `it-reclaim-run-${Date.now()}`;
      const runId = `it-reclaim-run-id-${Date.now()}`;
      const sanitizedRunId = sanitizeLabelValue(runId);
      const claimName = pvcNameFor(taskId);
      const apis = makeK8sApis();
      const sbx = mkSbx(taskId);

      try {
        // A pre-clone descriptor is what makes `provision()` create a
        // PVC-backed workspace (Case A needs the PVC to survive dispose).
        await sbx.provision({
          owner: "octocat",
          repo: "Hello-World",
          branch: "master",
          token: process.env.GITHUB_TOKEN ?? "",
          runId,
        } as any);
        const res = await sbx.runCommand(taskId, "echo hi", {
          cwd: "/home/agent/workspace/Hello-World",
          timeoutSeconds: 60,
        });
        expect(res.exitCode).toBe(0);
      } finally {
        await sbx.dispose();
      }

      // dispose() only tears down the Pod (+ Secrets) — the PVC is
      // reclaimSandbox's job, so it must still be here, labelled with the
      // run-id Task 1 stamped onto it.
      const afterDispose = await readPvc(apis, NAMESPACE, claimName);
      expect(afterDispose?.metadata?.labels?.[RUN_ID_LABEL]).toBe(sanitizedRunId);

      const warnings: string[] = [];
      const result = await reclaimSandbox(
        apis,
        NAMESPACE,
        { kind: "run", runId: RunId.from(runId) },
        { onWarn: (m) => warnings.push(m) },
      );

      if (rbacMissing(warnings)) {
        console.warn(
          "[IT] reclaimSandbox list RBAC not granted (Plan 7); " +
            "skipping deletion assertion",
        );
        return;
      }

      expect(result.pvcsDeleted).toBeGreaterThanOrEqual(1);
      expect(await readPvc(apis, NAMESPACE, claimName)).toBeNull();
    },
    180_000,
  );

  it(
    "sweep skips a PVC still mounted by a live pod",
    async () => {
      const taskId = `it-reclaim-sweep-${Date.now()}`;
      const runId = `it-reclaim-sweep-id-${Date.now()}`;
      const claimName = pvcNameFor(taskId);
      const podName = podNameFor(taskId, "run").value;
      const apis = makeK8sApis();
      const sbx = mkSbx(taskId);

      await sbx.provision({
        owner: "octocat",
        repo: "Hello-World",
        branch: "master",
        token: process.env.GITHUB_TOKEN ?? "",
        runId,
      } as any);

      // Fire-and-forget: runCommand/runAgent block until the pod finishes, so
      // the only way to hold a pod genuinely live mid-test is to NOT await
      // this call. `dispose()` below deletes the pod out from under it,
      // which makes its log-stream/status-poll reject — expected, not a
      // failure, so swallow it here and await the settled promise in
      // `finally` (bounded, in case the stream is ever slow to close).
      const bg = sbx
        .runCommand(taskId, "sleep 120", {
          cwd: "/home/agent/workspace/Hello-World",
          timeoutSeconds: 150,
        })
        .catch(() => undefined);

      try {
        await waitForPodLive(apis, NAMESPACE, podName);

        const warnings: string[] = [];
        // staleByHours: 0 + maxIdlePVCs: 0 forces every idle PVC in the
        // namespace into "would reclaim" — so this also reclaims any other
        // idle PVC left over in NAMESPACE. Only the live pod's own PVC is
        // asserted on; that's the live-skip this case proves.
        await reclaimSandbox(
          apis,
          NAMESPACE,
          { kind: "sweep", staleByHours: 0, maxIdlePVCs: 0 },
          { onWarn: (m) => warnings.push(m) },
        );

        if (rbacMissing(warnings)) {
          console.warn(
            "[IT] reclaimSandbox list RBAC not granted (Plan 7); " +
              "skipping live-skip assertion",
          );
          return;
        }

        expect(await readPvc(apis, NAMESPACE, claimName)).not.toBeNull();
      } finally {
        await sbx.dispose();
        await Promise.race([bg, new Promise((resolve) => setTimeout(resolve, 20_000))]);
        // Now idle — a follow-up sweep removes it so the case doesn't leak.
        await reclaimSandbox(apis, NAMESPACE, { kind: "sweep", staleByHours: 0, maxIdlePVCs: 0 });
      }
    },
    180_000,
  );
});

describe.runIf(RUN)("KubernetesSandbox Plan 6 quota-backpressure (integration)", () => {
  const NAMESPACE = process.env.LASTLIGHT_K8S_NAMESPACE ?? "lastlight-sandboxes";
  const QUOTA_NAME = "it-sandbox-quota";

  const mkSbx = (taskId: string) =>
    new KubernetesSandbox(
      {
        taskId,
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 120,
      } as any,
      {
        namespace: NAMESPACE,
        image: IMAGE,
        storageClassName: process.env.LASTLIGHT_K8S_STORAGE_CLASS ??
          "truenas-iscsi",
        workspaceSize: "2Gi",
        runAsUser: parseInt(
          process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "10001",
          10,
        ),
        harnessEndpoint: HARNESS_ENDPOINT,
        harnessNamespace: HARNESS_NAMESPACE,
        harnessPodLabels: HARNESS_POD_LABELS,
      },
    );

  it(
    "requeues a second run under a pods=1 ResourceQuota (403 -> QuotaExceededError), " +
      "then it succeeds once the first pod's slot frees",
    async () => {
      // Requires the ADMIN kubeconfig (admin@homelab): the harness ServiceAccount
      // can't create/delete a ResourceQuota until Plan 7's Flux `Role` grants that
      // RBAC verb, so this IT stages the quota itself via admin creds — the same
      // admin-staging pattern Plan 3 used to validate the CiliumNetworkPolicy
      // before its RBAC landed (HANDOVER.md).
      const apis = makeK8sApis();
      // Unique per run, same collision reasoning as the Plan 2/3/5 cases.
      const taskA = `it-quota-a-${Date.now()}`;
      const taskB = `it-quota-b-${Date.now()}`;
      const sbxA = mkSbx(taskA);
      const sbxB = mkSbx(taskB);

      await apis.core.createNamespacedResourceQuota({
        namespace: NAMESPACE,
        body: {
          metadata: { name: QUOTA_NAME },
          spec: { hard: { pods: "1" } },
        },
      });

      try {
        await sbxA.provision();
        // Fire-and-forget, same reasoning as the Plan 5 sweep-skip case:
        // runCommand blocks until the pod finishes, so the only way to hold
        // the quota's single pod slot for B's create attempt is to NOT await
        // this call. `dispose()` below deletes the pod out from under it,
        // which makes its log-stream/status-poll reject — expected, not a
        // failure, so swallow it here and await the settled promise after.
        const bgA = sbxA
          .runCommand(taskA, "sleep 60", {
            cwd: "/home/agent/workspace",
            timeoutSeconds: 90,
          })
          .catch(() => undefined);

        await waitForPodLive(apis, NAMESPACE, podNameFor(taskA, "run").value);

        // The quota's one pod slot is now held by A's pod, so B's pod-create
        // 403s and the adapter rethrows it as QuotaExceededError.
        await sbxB.provision();
        await expect(
          sbxB.runCommand(taskB, "echo hi", {
            cwd: "/home/agent/workspace",
            timeoutSeconds: 60,
          }),
        ).rejects.toBeInstanceOf(QuotaExceededError);

        // Free the slot: dispose A's pod, then retry B — it should now
        // succeed against the same taskId/pod name (A's create never
        // actually landed, so there's no name to collide with).
        await sbxA.dispose();
        await Promise.race([bgA, new Promise((resolve) => setTimeout(resolve, 20_000))]);

        const res = await sbxB.runCommand(taskB, "echo hi", {
          cwd: "/home/agent/workspace",
          timeoutSeconds: 60,
        });
        expect(res.exitCode).toBe(0);
        expect(res.stdout).toContain("hi");
      } finally {
        // Always tear down both sandboxes' pods/secrets, best-effort — dispose()
        // is safe to call even on a sandbox whose pod-create was rejected (it
        // never actually landed, so the delete is a harmless no-op).
        await sbxA.dispose().catch(() => {});
        await sbxB.dispose().catch(() => {});
        // Always delete the quota to restore the "no quota yet" state. As
        // HANDOVER.md flags for Plan 5's Case B: this case creates no PVCs
        // (both sandboxes provision an ephemeral emptyDir workspace), but a
        // run that crashes before reaching this `finally` can still leave the
        // `it-sandbox-quota` object — or A's pod, still holding the one slot —
        // behind in `lastlight-sandboxes`; a repeated run would then need a
        // manual `kubectl delete resourcequota/pod` before it can proceed.
        await apis.core
          .deleteNamespacedResourceQuota({ name: QUOTA_NAME, namespace: NAMESPACE })
          .catch(() => {});
      }
    },
    180_000,
  );
});
