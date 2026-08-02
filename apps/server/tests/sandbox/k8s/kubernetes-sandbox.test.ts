import { describe, it, expect, vi, afterEach } from "vitest";
import { PassThrough } from "node:stream";
import { ApiException } from "@kubernetes/client-node";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// pod-lifecycle.ts and egress-ensurer.ts now log via the pino LoggerPort
// instead of console — mock the logger module so the "warns once" assertions
// below can inspect the captured warn calls instead of console output.
const { warnSpy } = vi.hoisted(() => ({ warnSpy: vi.fn() }));
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: warnSpy,
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { KubernetesSandbox } from "#src/sandbox/k8s/kubernetes-sandbox.js";
import { configureWorkflowAssets } from "#src/workflows/loader.js";
import {
  STRICT_POLICY_NAME,
  OPEN_POLICY_NAME,
  EGRESS_POLICY_LABEL,
} from "#src/sandbox/k8s/egress-policy.js";
import { EgressEnsurer } from "#src/sandbox/k8s/egress-ensurer.js";
import { SkillBundleRegistry } from "#src/sandbox/k8s/skill-bundle.js";
import { AgentContextRegistry } from "#src/sandbox/k8s/agent-context-registry.js";
import { createArtifactStore, artifactStore as sharedArtifactStore } from "#src/sandbox/artifact-store.js";
import { LocalArtifactBackend } from "#src/sandbox/artifact-backend.js";

interface FakeOpts {
  /** The `V1Pod.status` object `readNamespacedPodStatus` returns. */
  status?: Record<string, unknown>;
  /** Make `deleteNamespacedPod` reject. */
  deleteThrows?: boolean;
  /** Make `readNamespacedPersistentVolumeClaim` resolve (PVC already exists)
   *  instead of the default 404-reject (PVC missing, must be created). */
  pvcExists?: boolean;
  /** Make `createNamespacedPod` reject (pod-create failure path). */
  createPodThrows?: boolean;
  /** Override `custom.createNamespacedCustomObject` — defaults to a spy that
   *  resolves, so the egress-ensure call is a silent no-op in tests that
   *  don't care about it. */
  createNamespacedCustomObject?: ReturnType<typeof vi.fn>;
  /** Number of non-404 `readNamespacedPodStatus` responses to return AFTER
   *  `deleteNamespacedPod` succeeds, before it 404s (pod actually gone) —
   *  exercises `dispose`'s post-delete `waitForPodGone` poll. Default 0: the
   *  pod reads back as gone on the very first poll after delete, so tests
   *  that don't care about this wait stay fast. */
  goneAfterDeletePolls?: number;
}

function fakeApis(opts: FakeOpts = {}) {
  const status = opts.status ?? { phase: "Succeeded" };
  const created: any[] = [];
  const deleted: string[] = [];
  const secretsCreated: any[] = [];
  const secretsDeleted: string[] = [];
  const secretsPatched: any[] = [];
  const pvcsRead: any[] = [];
  const pvcsCreated: any[] = [];
  const customCreated =
    opts.createNamespacedCustomObject ?? vi.fn(async () => ({}));
  let podDeleted = false;
  let postDeletePolls = 0;
  const goneAfterDeletePolls = opts.goneAfterDeletePolls ?? 0;
  return {
    apis: {
      core: {
        createNamespacedPod: vi.fn(async ({ body }: any) => {
          if (opts.createPodThrows) throw new Error("pod create failed");
          created.push(body);
          // Real createNamespacedPod echoes back the created object, with a
          // server-assigned uid — the ownerRef patch reads it off this return.
          return { ...body, metadata: { ...body.metadata, uid: "pod-uid-1" } };
        }),
        readNamespacedPodStatus: vi.fn(async () => {
          // Mirrors real k8s: once the pod is actually deleted, subsequent
          // status reads 404. `goneAfterDeletePolls` delays that 404 by N
          // polls, for tests exercising `waitForPodGone`'s loop.
          if (podDeleted) {
            if (postDeletePolls < goneAfterDeletePolls) {
              postDeletePolls += 1;
              return { status };
            }
            throw new ApiException(404, "Not Found", {}, {});
          }
          return { status };
        }),
        deleteNamespacedPod: vi.fn(async ({ name }: any) => {
          if (opts.deleteThrows) throw new Error("boom");
          deleted.push(name);
          podDeleted = true;
          return {};
        }),
        createNamespacedSecret: vi.fn(async ({ body }: any) => {
          secretsCreated.push(body);
          return body;
        }),
        patchNamespacedSecret: vi.fn(async ({ name, body }: any) => {
          secretsPatched.push({ name, body });
          return {};
        }),
        deleteNamespacedSecret: vi.fn(async ({ name }: any) => {
          secretsDeleted.push(name);
          return {};
        }),
        readNamespacedPersistentVolumeClaim: vi.fn(async ({ name, namespace }: any) => {
          pvcsRead.push({ name, namespace });
          if (opts.pvcExists) return { metadata: { name, namespace } };
          throw new ApiException(404, "Not Found", {}, {});
        }),
        createNamespacedPersistentVolumeClaim: vi.fn(async ({ body }: any) => {
          pvcsCreated.push(body);
          return body;
        }),
      },
      log: {
        log: vi.fn(async (_n: string, _p: string, _c: string, s: PassThrough) => {
          s.write('{"type":"agent_end"}\n');
          s.end();
          return { abort() {} };
        }),
      },
      custom: {
        createNamespacedCustomObject: customCreated,
      },
      kc: {} as any,
    } as any,
    created,
    deleted,
    secretsCreated,
    secretsDeleted,
    secretsPatched,
    pvcsRead,
    pvcsCreated,
    customCreated,
  };
}

const factoryOpts = {
  taskId: "t1",
  egress: { unrestricted: false, hosts: [] },
  env: {},
  stateDir: "/tmp",
  timeoutSeconds: 60,
} as any;

/** Full `K8sAdapterConfig` — `storageClassName`/`workspaceSize`/`runAsUser`
 *  are required as of Task 6, as are the three `harness*` fields. */
function cfg(apis: any, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    namespace: "ns",
    image: "img",
    storageClassName: "truenas-iscsi",
    workspaceSize: "5Gi",
    runAsUser: 10001,
    harnessEndpoint: "http://lastlight.lastlight.svc.cluster.local:8644",
    harnessNamespace: "lastlight",
    harnessPodLabels: { "app.kubernetes.io/name": "lastlight" },
    apis,
    ...overrides,
  };
}

describe("KubernetesSandbox", () => {
  it("runAgent creates a pod, streams parsed events, and deletes the pod", async () => {
    const { apis, created, deleted, secretsCreated, secretsDeleted, pvcsRead, pvcsCreated } =
      fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    // No pre-clone descriptor — ephemeral emptyDir workspace, no PVC touched.
    expect(pvcsRead).toHaveLength(0);
    expect(pvcsCreated).toHaveLength(0);
    const events: any[] = [];
    await sbx.runAgent(
      "t1",
      "hello",
      {
        model: "openai/x",
        sandboxEnv: { GITHUB_TOKEN: "ghs_abc" },
        agentCwd: "/home/agent/workspace",
      } as any,
      (e) => events.push(e),
    );
    expect(created).toHaveLength(1);
    expect(events).toContainEqual({ type: "agent_end" });

    // Per-run creds arrive via the pod's own Secret, never as inline env
    // (kubectl-visible) on the pod spec.
    const credsSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(credsSecret.stringData).toMatchObject({ GITHUB_TOKEN: "ghs_abc" });
    const container = created[0].spec.containers[0];
    expect(container.env).toBeUndefined();
    expect(container.envFrom).toContainEqual({ secretRef: { name: credsSecret.metadata.name } });

    await sbx.dispose();
    expect(deleted).toHaveLength(1);
    expect(secretsDeleted.length).toBeGreaterThanOrEqual(1);
  });

  it("passes --profile to agentic-pi so the github_* extension is enabled", async () => {
    // Regression: without --profile, agentic-pi doesn't enable its github_*
    // tools (they're gated per profile) — so triage/pr-review agents run with
    // only local file/bash tools and can't touch GitHub, despite GITHUB_TOKEN
    // being in the pod env. The docker backend already passes --profile.
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", profile: "issues-write", agentCwd: "/home/agent/workspace" } as any,
      () => {},
    );
    const cmd = created[0].spec.containers[0].command as string[];
    // Threaded positionally (injection-safe), and the script passes --profile.
    expect(cmd).toContain("issues-write");
    const script = cmd.find((a) => a.includes("agentic-pi run"))!;
    expect(script).toContain("--profile");
  });

  it("throws when profile is not one of the closed set", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    // The `as any` simulates a value that reached here already erased to
    // `string` — the runtime guard is the last line of defence once
    // `GitAccessProfile` narrowing is bypassed.
    await expect(
      sbx.runAgent(
        "t1",
        "hello",
        { model: "openai/x", profile: "admin", agentCwd: "/home/agent/workspace" } as any,
        () => {},
      ),
    ).rejects.toThrow(/Refusing to pass profile "admin"/);
    expect(created).toHaveLength(0);
  });

  it("omits --profile when no profile is set", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", agentCwd: "/home/agent/workspace" } as any,
      () => {},
    );
    const cmd = created[0].spec.containers[0].command as string[];
    const script = cmd.find((a) => a.includes("agentic-pi run"))!;
    expect(script).not.toContain("--profile");
  });

  it("F0: suppresses agentic-pi's web-search auto-enable when webSearch is omitted", async () => {
    // Before this task the k8s backend hard-coded the agentic-pi invocation
    // and ignored thinking/webSearch entirely — so a phase that never opted
    // into search could still get it, since agentic-pi auto-enables whenever
    // any `*_API_KEY` env var is present (exactly what a *_API_KEY in
    // sandboxEnv below would trigger without the suppressor).
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    await sbx.runAgent(
      "t1",
      "hello",
      {
        model: "openai/x",
        sandboxEnv: { TAVILY_API_KEY: "tvly-x" },
        agentCwd: "/home/agent/workspace",
      } as any,
      () => {},
    );
    const cmd = created[0].spec.containers[0].command as string[];
    const script = cmd.find((a) => a.includes("agentic-pi run"))!;
    expect(script).toContain("--no-web-search");
    expect(script).not.toContain("--web-search-provider");
  });

  it("F0: honours webSearch:true + webSearchProvider by threading a --web-search-provider flag", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    await sbx.runAgent(
      "t1",
      "hello",
      {
        model: "openai/x",
        webSearch: true,
        webSearchProvider: "tavily",
        agentCwd: "/home/agent/workspace",
      } as any,
      () => {},
    );
    const cmd = created[0].spec.containers[0].command as string[];
    const script = cmd.find((a) => a.includes("agentic-pi run"))!;
    expect(script).not.toContain("--no-web-search");
    expect(script).toContain("--web-search-provider");
    // Provider value stays argv (injection-safe), never spliced into the script text.
    expect(cmd).toContain("tavily");
    expect(script).not.toContain("tavily");
  });

  it("F0: honours thinking by threading a --thinking flag, value bound to argv", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", thinking: "high", agentCwd: "/home/agent/workspace" } as any,
      () => {},
    );
    const cmd = created[0].spec.containers[0].command as string[];
    const script = cmd.find((a) => a.includes("agentic-pi run"))!;
    expect(script).toContain("--thinking");
    // Level value stays argv (injection-safe), never spliced into the script text.
    expect(cmd).toContain("high");
    expect(script).not.toContain("high");
  });

  it("F0: rejects a thinking value outside the closed set", async () => {
    const { apis } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    await expect(
      sbx.runAgent(
        "t1",
        "hello",
        { model: "openai/x", thinking: "extreme", agentCwd: "/home/agent/workspace" } as any,
        () => {},
      ),
    ).rejects.toThrow(/Refusing to pass thinking/);
  });

  it("F0: rejects a web-search-provider value outside the closed set", async () => {
    const { apis } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "lastlight-sandboxes" }));
    await sbx.provision();
    await expect(
      sbx.runAgent(
        "t1",
        "hello",
        {
          model: "openai/x",
          webSearch: true,
          webSearchProvider: "duckduckgo",
          agentCwd: "/home/agent/workspace",
        } as any,
        () => {},
      ),
    ).rejects.toThrow(/Refusing to pass web-search-provider/);
  });

  it("runCommand returns the container's real exit code (0)", async () => {
    const { apis } = fakeApis({
      status: { phase: "Succeeded", containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    const res = await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(res.exitCode).toBe(0);
    expect(res.timedOut).toBe(false);
  });

  it("runCommand returns the container's real exit code (2)", async () => {
    const { apis } = fakeApis({
      status: { phase: "Failed", containerStatuses: [{ state: { terminated: { exitCode: 2 } } }] },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    const res = await sbx.runCommand("t1", "exit 2", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(res.exitCode).toBe(2);
    expect(res.timedOut).toBe(false);
  });

  it("runCommand flags a deadline kill as timedOut", async () => {
    const { apis } = fakeApis({
      status: { phase: "Failed", reason: "DeadlineExceeded" },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    const res = await sbx.runCommand("t1", "sleep 999", { cwd: "/w", timeoutSeconds: 1 } as any);
    expect(res.timedOut).toBe(true);
  });

  it("fails fast with the real reason when the container can't start (ImagePullBackOff)", async () => {
    const { apis } = fakeApis({
      status: {
        phase: "Pending",
        containerStatuses: [
          { state: { waiting: { reason: "ImagePullBackOff", message: 'back-off pulling image "nope"' } } },
        ],
      },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { image: "nope" }));
    await sbx.provision();
    await expect(
      sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
    ).rejects.toThrow(/ImagePullBackOff/);
  });

  it("fails fast with the init container's reason when clone fails (git auth error)", async () => {
    const { apis } = fakeApis({
      status: {
        phase: "Pending",
        containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
        initContainerStatuses: [
          {
            name: "clone",
            state: {
              terminated: {
                exitCode: 128,
                reason: "Error",
                message: "fatal: could not read Username",
              },
            },
          },
        ],
      },
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await expect(
      sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
    ).rejects.toThrow(/init container "clone" failed \(exit 128\): Error/);
    // Fails on the FIRST poll, not after the full ~60s start budget.
    expect(apis.core.readNamespacedPodStatus).toHaveBeenCalledTimes(1);
  });

  it("appends the init container's logs so the real git error is visible", async () => {
    const { apis } = fakeApis({
      status: {
        phase: "Pending",
        containerStatuses: [{ state: { waiting: { reason: "PodInitializing" } } }],
        initContainerStatuses: [
          { name: "clone", state: { terminated: { exitCode: 128, reason: "Error" } } },
        ],
      },
    });
    apis.core.readNamespacedPodLog = vi.fn(
      async () =>
        "Cloning into '/home/agent/workspace/Hello-World'...\n" +
        "fatal: could not create work tree dir: Permission denied",
    ) as any;
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await expect(
      sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
    ).rejects.toThrow(/Permission denied/);
    expect(apis.core.readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ container: "clone" }),
    );
  });

  it("dispose swallows a delete failure", async () => {
    const { apis } = fakeApis({ deleteThrows: true });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    await expect(sbx.dispose()).resolves.toBeUndefined();
  });

  it("dispose polls until the pod is gone (404) before returning", async () => {
    // RWO Multi-Attach fix: after a successful delete, dispose must wait for
    // the API to 404 the pod (proving the RWO volume is released) before it
    // returns — otherwise a sequential next-phase pod on the same PVC can
    // race the still-attaching volume. One extra non-404 poll after delete
    // (goneAfterDeletePolls: 1) proves dispose actually LOOPS, not just
    // checks once.
    const { apis, deleted } = fakeApis({
      status: { phase: "Running", containerStatuses: [{ state: { running: {} } }] },
      goneAfterDeletePolls: 1,
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    // runAgent (not runCommand) — runCommand's own awaitPodResult poll would
    // otherwise mix into the same readNamespacedPodStatus call count this
    // test isolates to dispose's post-delete wait.
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
      () => {},
    );
    const before = (apis.core.readNamespacedPodStatus as any).mock.calls.length;
    await sbx.dispose();
    const after = (apis.core.readNamespacedPodStatus as any).mock.calls.length;

    expect(deleted).toHaveLength(1);
    expect(after - before).toBeGreaterThanOrEqual(2); // still-present, then 404
  });

  it("dispose does not wait when the delete itself throws (pod already gone)", async () => {
    const { apis } = fakeApis({ deleteThrows: true });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
      () => {},
    );
    const before = (apis.core.readNamespacedPodStatus as any).mock.calls.length;
    await sbx.dispose();
    const after = (apis.core.readNamespacedPodStatus as any).mock.calls.length;
    expect(after).toBe(before); // no wait attempted — delete failed, nothing to poll for
  });

  it("dispose warns and returns when the pod-gone poll budget is exhausted", async () => {
    const { apis } = fakeApis({
      status: { phase: "Running", containerStatuses: [{ state: { running: {} } }] },
      goneAfterDeletePolls: Number.POSITIVE_INFINITY,
    });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
      () => {},
    );

    warnSpy.mockClear();
    vi.useFakeTimers();
    try {
      const disposePromise = sbx.dispose();
      await vi.runAllTimersAsync();
      await expect(disposePromise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("still present"), expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("KubernetesSandbox egress policy", () => {
  // Each test injects its OWN fresh EgressEnsurer via cfg() — isolation comes
  // from a per-test instance (the ensure-once cache is an instance field, not
  // a process-global Map), so tests are free to share the default namespace.
  it(
    "applies the egress policy pair and labels the pod strict for a restricted phase",
    async () => {
      const { apis, created, customCreated } = fakeApis();
      const sbx = new KubernetesSandbox(
        { taskId: "t1", egress: { unrestricted: false, hosts: [] }, env: {}, stateDir: "/tmp",
          timeoutSeconds: 60 } as any,
        cfg(apis, { egressEnsurer: new EgressEnsurer() }),
      );
      await sbx.provision();
      await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);

      const applied = customCreated.mock.calls.map((c: any) => c[0].body.metadata.name);
      expect(applied).toEqual(expect.arrayContaining([STRICT_POLICY_NAME, OPEN_POLICY_NAME]));
      expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("strict");
    },
  );

  it("labels the pod open for an unrestricted phase", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(
      { taskId: "t2", egress: { unrestricted: true, hosts: [] }, env: {}, stateDir: "/tmp",
        timeoutSeconds: 60 } as any,
      cfg(apis, { egressEnsurer: new EgressEnsurer() }),
    );
    await sbx.provision();
    await sbx.runCommand("t2", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
    expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("open");
  });

  it(
    "a 403 (RBAC not yet granted) warns once and still runs the pod on default-allow",
    async () => {
      const create = vi.fn(async () => {
        throw new ApiException(403, "Forbidden", {}, {});
      });
      const { apis, created } = fakeApis({ createNamespacedCustomObject: create });
      warnSpy.mockClear();
      const sbx = new KubernetesSandbox(
        factoryOpts,
        cfg(apis, { egressEnsurer: new EgressEnsurer() }),
      );
      await sbx.provision();
      await expect(
        sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
      ).resolves.toMatchObject({ exitCode: 0 });
      expect(created).toHaveLength(1);
      expect(created[0].metadata.labels[EGRESS_POLICY_LABEL]).toBe("strict");
      expect(warnSpy).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "warns only once across two runs in the same namespace (ensure-once cache)",
    async () => {
      const create = vi.fn(async () => {
        throw new ApiException(403, "Forbidden", {}, {});
      });
      const { apis } = fakeApis({ createNamespacedCustomObject: create });
      warnSpy.mockClear();
      const sbx = new KubernetesSandbox(
        factoryOpts,
        cfg(apis, { egressEnsurer: new EgressEnsurer() }),
      );
      await sbx.provision();
      await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
      await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    },
  );

  it(
    "a non-403 error fails the run and clears the cache so a later run retries the apply",
    async () => {
      const create = vi
        .fn()
        .mockRejectedValueOnce(new ApiException(500, "Server Error", {}, {}))
        .mockResolvedValue({});
      const { apis } = fakeApis({ createNamespacedCustomObject: create });
      const sbx = new KubernetesSandbox(
        factoryOpts,
        cfg(apis, { egressEnsurer: new EgressEnsurer() }),
      );
      await sbx.provision();

      await expect(
        sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any),
      ).rejects.toThrow();
      expect(create).toHaveBeenCalledTimes(1);

      await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);
      expect(create.mock.calls.length).toBeGreaterThan(1);
    },
  );

  it("builds the harness toEndpoints rule from an endpoint with an explicit port", async () => {
    const { apis, customCreated } = fakeApis();
    const sbx = new KubernetesSandbox(
      factoryOpts,
      cfg(apis, {
        egressEnsurer: new EgressEnsurer(),
        harnessEndpoint: "http://h.ns.svc:9000",
        harnessNamespace: "ll-sys",
        harnessPodLabels: { app: "lastlight" },
      }),
    );
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);

    const strictBody = customCreated.mock.calls
      .map((c: any) => c[0].body)
      .find((b: any) => b.metadata.name === STRICT_POLICY_NAME);
    expect(strictBody).toBeDefined();
    // The DNS rule also has a `toEndpoints` — filter to the harness one by
    // its distinctive `app` label (same gotcha noted in Task 4).
    const harnessRule = strictBody.spec.egress.find(
      (rule: any) => rule.toEndpoints?.[0]?.matchLabels?.app === "lastlight",
    );
    expect(harnessRule).toBeDefined();
    expect(harnessRule.toEndpoints[0].matchLabels).toMatchObject({
      "k8s:io.kubernetes.pod.namespace": "ll-sys",
      app: "lastlight",
    });
    expect(harnessRule.toPorts[0].ports).toContainEqual({ port: "9000", protocol: "TCP" });
  });

  it("falls back to port 8644 when the harness endpoint has no explicit port", async () => {
    const { apis, customCreated } = fakeApis();
    const sbx = new KubernetesSandbox(
      factoryOpts,
      cfg(apis, { egressEnsurer: new EgressEnsurer(), harnessEndpoint: "http://h.ns.svc" }),
    );
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);

    const strictBody = customCreated.mock.calls
      .map((c: any) => c[0].body)
      .find((b: any) => b.metadata.name === STRICT_POLICY_NAME);
    expect(strictBody).toBeDefined();
    // cfg()'s default harnessPodLabels key distinguishes this from the DNS rule.
    const harnessRule = strictBody.spec.egress.find(
      (rule: any) => rule.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight",
    );
    expect(harnessRule).toBeDefined();
    expect(harnessRule.toPorts[0].ports).toContainEqual({ port: "8644", protocol: "TCP" });
  });
});

describe("KubernetesSandbox PVC workspace (pre-clone)", () => {
  const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_abc" };

  it("ensures the PVC (created on 404) and returns the repo subdir as agentCwd", async () => {
    const { apis, pvcsRead, pvcsCreated } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    const result = await sbx.provision(pre as any);

    expect(pvcsRead).toHaveLength(1); // existence check first
    expect(pvcsCreated).toHaveLength(1); // 404 → create
    expect(pvcsCreated[0].spec.accessModes).toEqual(["ReadWriteOnce"]);
    expect(result.hostWorkspaceDir).toBe("/home/agent/workspace");
    expect(result.agentCwd).toBe("/home/agent/workspace/web");
  });

  it("reuses an existing PVC without re-creating it", async () => {
    const { apis, pvcsRead, pvcsCreated } = fakeApis({ pvcExists: true });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision(pre as any);

    expect(pvcsRead).toHaveLength(1);
    expect(pvcsCreated).toHaveLength(0);
  });

  it("stages a PVC-backed pod with a clone initContainer sharing the creds Secret", async () => {
    const { apis, created } = fakeApis();
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    const result = await sbx.provision(pre as any);
    await sbx.runCommand("t1", "true", { cwd: result.agentCwd, timeoutSeconds: 30 } as any);

    expect(created).toHaveLength(1);
    const pod = created[0];
    const vol = pod.spec.volumes.find((v: any) => v.name === "workspace");
    expect(vol.persistentVolumeClaim?.claimName).toMatch(/^ws-/);
    expect(pod.spec.initContainers).toHaveLength(1);
    expect(pod.spec.initContainers[0].name).toBe("clone");
    const credsSecretName = pod.spec.containers[0].envFrom[0].secretRef.name;
    expect(pod.spec.initContainers[0].envFrom).toContainEqual({
      secretRef: { name: credsSecretName },
    });
  });
});

describe("KubernetesSandbox (agent-context delivery — HTTP init-fetch, nearform#240)", () => {
  const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" };
  let ctxRoot: string;

  afterEach(() => {
    configureWorkflowAssets();
    if (ctxRoot) rmSync(ctxRoot, { recursive: true, force: true });
  });

  it("registers the context, wires the init + creds token, keeps the prompt Secret " +
    "clean, and evicts on dispose", async () => {
    ctxRoot = mkdtempSync(join(tmpdir(), "ll-agent-ctx-"));
    mkdirSync(join(ctxRoot, "agent-context"), { recursive: true });
    writeFileSync(join(ctxRoot, "agent-context", "persona.md"), "BE HELPFUL");
    configureWorkflowAssets({ builtInRoot: ctxRoot });

    const { apis, created, secretsCreated } = fakeApis();
    const agentContextRegistry = new AgentContextRegistry();
    const sbx = new KubernetesSandbox(
      {
        taskId: "t1",
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 60,
      } as any,
      cfg(apis, { agentContextRegistry }),
    );
    await sbx.provision(pre as any);
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace/web" } as any,
      () => {},
    );

    // The resolved text is served over the route, gated by a per-run token that
    // rides the creds Secret — NOT stuffed into the prompt Secret as an `agents`
    // key any more.
    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    const token = creds.stringData.LASTLIGHT_AGENT_CONTEXT_TOKEN;
    expect(token).toBeTruthy();
    expect(agentContextRegistry.get(token)).toBe("BE HELPFUL");

    const promptSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt"));
    expect(promptSecret.stringData.agents).toBeUndefined();

    const pod = created[0];
    const promptVol = pod.spec.volumes.find((v: any) => v.name === "prompt");
    expect(promptVol.secret.items).toEqual([{ key: "prompt", path: "prompt" }]);

    // The agent-context init fetches the route and writes AGENTS.md into the
    // workspace ROOT (never cwd-relative — a pre-cloned run's cwd is
    // `WORKSPACE_DIR/<repo>`, so a cwd-relative write would land inside the repo
    // tree and a repo-write phase would commit the bot's AGENTS.md).
    const initCtx = pod.spec.initContainers.find((c: any) => c.name === "agent-context");
    expect(initCtx).toBeDefined();
    const initScript: string = initCtx.command[2];
    expect(initScript).toContain("/internal/agent-context");
    expect(initScript).toContain("Authorization: Bearer $LASTLIGHT_AGENT_CONTEXT_TOKEN");
    expect(initScript).toContain("-o /home/agent/workspace/AGENTS.md");
    // creds Secret's envFrom is attached so the token env resolves.
    expect(initCtx.envFrom).toContainEqual({ secretRef: { name: creds.metadata.name } });

    // The runAgent script no longer copies AGENTS.md itself.
    const script: string = pod.spec.containers[0].command[2];
    expect(script).not.toContain("AGENTS.md");

    await sbx.dispose();
    expect(agentContextRegistry.get(token)).toBeUndefined();
  });

  it("adds no agent-context init/token when the resolved context is empty", async () => {
    ctxRoot = mkdtempSync(join(tmpdir(), "ll-agent-ctx-empty-"));
    configureWorkflowAssets({ builtInRoot: ctxRoot }); // no agent-context/ subdir at all

    const { apis, created, secretsCreated } = fakeApis();
    const agentContextRegistry = new AgentContextRegistry();
    const sbx = new KubernetesSandbox(
      {
        taskId: "t1",
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 60,
      } as any,
      cfg(apis, { agentContextRegistry }),
    );
    await sbx.provision(pre as any);
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace/web" } as any,
      () => {},
    );

    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(creds.stringData.LASTLIGHT_AGENT_CONTEXT_TOKEN).toBeUndefined();
    const pod = created[0];
    expect((pod.spec.initContainers ?? []).some((c: any) => c.name === "agent-context")).toBe(false);
    const promptSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt"));
    expect(promptSecret.stringData.agents).toBeUndefined();
    const promptVol = pod.spec.volumes.find((v: any) => v.name === "prompt");
    expect(promptVol.secret.items).toEqual([{ key: "prompt", path: "prompt" }]);
  });

  /**
   * The kubernetes half of issue #180: a run whose target repo contributed
   * `agent-context/*.md` must serve the SAME composed text the host-shared
   * backends write to disk. The orchestrator hands it over through
   * `setAgentContext`; the adapter must use it verbatim rather than re-composing
   * from the module-level layers, which know nothing about a per-run repo layer.
   */
  it("serves the agent context the orchestrator resolved for the run, not the module-level one", async () => {
    ctxRoot = mkdtempSync(join(tmpdir(), "ll-agent-ctx-run-"));
    mkdirSync(join(ctxRoot, "agent-context"), { recursive: true });
    writeFileSync(join(ctxRoot, "agent-context", "security.md"), "OPERATOR SECURITY RULES");
    configureWorkflowAssets({ builtInRoot: ctxRoot });

    const { apis, secretsCreated } = fakeApis();
    const agentContextRegistry = new AgentContextRegistry();
    const sbx = new KubernetesSandbox(
      {
        taskId: "t1",
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 60,
      } as any,
      cfg(apis, { agentContextRegistry }),
    );
    // What a per-run resolver produces for a repo that ADDED a file: the
    // operator's rules plus the repo's own, never the repo replacing them.
    sbx.setAgentContext("OPERATOR SECURITY RULES\n\n---\n\nREPO CONVENTIONS");
    await sbx.provision(pre as any);
    await sbx.runAgent(
      "t1",
      "hello",
      { model: "openai/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace/web" } as any,
      () => {},
    );

    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    const token = creds.stringData.LASTLIGHT_AGENT_CONTEXT_TOKEN;
    expect(agentContextRegistry.get(token)).toBe("OPERATOR SECURITY RULES\n\n---\n\nREPO CONVENTIONS");
  });
});

describe("KubernetesSandbox (creds + workspace + prompt)", () => {
  const pre = { owner: "acme", repo: "web", branch: "feature/x", token: "ghs_x" };

  it(
    "runAgent: ensures a PVC, writes creds+prompt Secrets, delivers the prompt, " +
      "patches ownerRefs, streams, reaps",
    async () => {
      const { apis, created, deleted, secretsCreated, secretsPatched, pvcsCreated } = fakeApis();
      const sbx = new KubernetesSandbox(
        {
          taskId: "acme-web-pr12",
          egress: { unrestricted: false, hosts: [] },
          env: { ANTHROPIC_API_KEY: "sk-1", GITHUB_TOKEN: "ghs_x" },
          stateDir: "/tmp",
          timeoutSeconds: 120,
        } as any,
        cfg(apis),
      );
      await sbx.provision(pre as any);
      expect(pvcsCreated).toHaveLength(1);

      const events: any[] = [];
      await sbx.runAgent(
        "acme-web-pr12",
        "REVIEW THIS PR",
        {
          model: "anthropic/claude-sonnet-4-6",
          sandboxEnv: {},
          agentCwd: "/home/agent/workspace/web",
        } as any,
        (e) => events.push(e),
      );

      // creds + prompt Secrets created before the pod; prompt carries the text.
      const promptSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt"));
      expect(promptSecret.stringData.prompt).toBe("REVIEW THIS PR");
      const credsSecret = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
      expect(credsSecret.stringData.ANTHROPIC_API_KEY).toBe("sk-1");

      // pod created with envFrom the creds Secret + prompt piped to stdin, model
      // passed as a positional arg (not interpolated into the script text).
      const pod = created[0];
      expect(pod.spec.containers[0].envFrom).toContainEqual({
        secretRef: { name: credsSecret.metadata.name },
      });
      const command: string[] = pod.spec.containers[0].command;
      expect(command.join(" ")).toContain("< /lastlight/prompt");
      // Model, harness endpoint, github profile, thinking level, and
      // web-search provider are their own trailing argv elements, bound to
      // `$1`..`$5` at exec time — NOT interpolated into the script string
      // (command[2]). This run passes no profile/thinking/provider, so those
      // three trailing elements are the empty string; per F0, an omitted
      // `webSearch` still suppresses it explicitly in the script text itself
      // (`--no-web-search`), not via one of these argv slots.
      expect(command.at(-5)).toBe("anthropic/claude-sonnet-4-6");
      expect(command.at(-4)).toBe("http://lastlight.lastlight.svc.cluster.local:8644");
      expect(command.at(-3)).toBe("");
      expect(command.at(-2)).toBe("");
      expect(command.at(-1)).toBe("");
      expect(command[2]).not.toContain("claude-sonnet-4-6");
      expect(command[2]).toContain("--no-web-search");

      // ownerRefs patched (both secrets), each as a JSON-Patch "add" op.
      expect(secretsPatched).toHaveLength(2);
      const patchedNames = secretsPatched.map((p: any) => p.name);
      expect(patchedNames).toEqual(
        expect.arrayContaining([credsSecret.metadata.name, promptSecret.metadata.name]),
      );
      for (const { body } of secretsPatched) {
        expect(body).toEqual([
          {
            op: "add",
            path: "/metadata/ownerReferences",
            value: [
              expect.objectContaining({ kind: "Pod", name: pod.metadata.name, uid: "pod-uid-1" }),
            ],
          },
        ]);
      }

      expect(events).toContainEqual({ type: "agent_end" });

      await sbx.dispose();
      expect(deleted).toContain(pod.metadata.name);
    },
  );

  it("runCommand: no prompt Secret, no `< /lastlight/prompt`, creds via envFrom", async () => {
    const { apis, created, secretsCreated } = fakeApis();
    const sbx = new KubernetesSandbox(
      {
        taskId: "acme-web-pr12",
        egress: { unrestricted: false, hosts: [] },
        env: { GITHUB_TOKEN: "ghs_x" },
        stateDir: "/tmp",
        timeoutSeconds: 60,
      } as any,
      cfg(apis),
    );
    await sbx.provision(pre as any);
    const res = await sbx.runCommand("acme-web-pr12", "echo hi", {
      cwd: "/home/agent/workspace/web",
      timeoutSeconds: 60,
    });
    expect(res.exitCode).toBe(0);
    expect(secretsCreated.some((s: any) => s.metadata.name.endsWith("-prompt"))).toBe(false);
    expect(created[0].spec.containers[0].command.join(" ")).not.toContain("/lastlight/prompt");
  });

  it("ephemeral provision (no pre-clone) uses emptyDir, no PVC", async () => {
    const { apis, created, pvcsCreated } = fakeApis();
    const sbx = new KubernetesSandbox(
      {
        taskId: "cron-health-1",
        egress: { unrestricted: false, hosts: [] },
        env: {},
        stateDir: "/tmp",
        timeoutSeconds: 60,
      } as any,
      cfg(apis),
    );
    await sbx.provision(); // no PrePopulateSpec
    await sbx.runCommand("cron-health-1", "echo hi", {
      cwd: "/home/agent/workspace",
      timeoutSeconds: 60,
    });
    expect(pvcsCreated).toHaveLength(0);
    expect(created[0].spec.volumes.find((v: any) => v.name === "workspace").emptyDir).toBeDefined();
  });

  it("pod-create failure best-effort deletes the creds+prompt Secrets, then rethrows", async () => {
    const { apis, secretsCreated, secretsDeleted } = fakeApis({ createPodThrows: true });
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis));
    await sbx.provision();
    await expect(
      sbx.runAgent(
        "t1",
        "hello",
        { model: "anthropic/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
        () => {},
      ),
    ).rejects.toThrow(/pod create failed/);

    const credsName = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds")).metadata
      .name;
    const promptName = secretsCreated.find((s: any) => s.metadata.name.endsWith("-prompt")).metadata
      .name;
    expect(secretsDeleted).toEqual(expect.arrayContaining([credsName, promptName]));
  });
});

describe("KubernetesSandbox skills staging", () => {
  it("stages a bundle, wires init + token + --skill, evicts on dispose", async () => {
    const src = mkdtempSync(join(tmpdir(), "skills-src-"));
    const skillSrc = join(src, "pr-review");
    mkdirSync(skillSrc, { recursive: true });
    writeFileSync(join(skillSrc, "SKILL.md"), "# pr-review");

    try {
      const { apis, created, secretsCreated } = fakeApis();
      const skillRegistry = new SkillBundleRegistry();
      const sbx = new KubernetesSandbox(
        {
          taskId: "t-skills",
          egress: { unrestricted: false, hosts: [] },
          env: {},
          stateDir: "/tmp",
          timeoutSeconds: 60,
        } as any,
        cfg(apis, { namespace: "ns-skills", skillRegistry }),
      );
      await sbx.provision();
      const dirs = sbx.stageSkills("pr-review", [skillSrc]);
      expect(dirs).toEqual(["/lastlight-skills/pr-review"]);

      await sbx.runAgent(
        "t-skills",
        "hello",
        {
          model: "anthropic/x",
          sandboxEnv: {},
          agentCwd: "/home/agent/workspace",
          skillDirs: dirs,
        } as any,
        () => {},
      );

      const pod = created[0];
      expect(pod.spec.initContainers.some((c: any) => c.name === "skills")).toBe(true);
      expect(pod.spec.volumes.some((v: any) => v.name === "skills")).toBe(true);
      const cmd = pod.spec.containers[0].command.join(" ");
      expect(cmd).toContain("--skill /lastlight-skills/pr-review");
      const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
      const token = creds.stringData.LASTLIGHT_SKILL_TOKEN;
      expect(token).toBeTruthy();
      expect(skillRegistry.get(token)).toBeDefined();

      await sbx.dispose();
      expect(skillRegistry.get(token)).toBeUndefined();
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });

  it("runCommand stages no skills: no init, no token, no --skill", async () => {
    const { apis, created, secretsCreated } = fakeApis();
    const skillRegistry = new SkillBundleRegistry();
    const overrides = { namespace: "ns-no-skills", skillRegistry };
    const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, overrides));
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);

    const pod = created[0];
    expect(pod.spec.initContainers ?? []).toHaveLength(0);
    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(creds.stringData.LASTLIGHT_SKILL_TOKEN).toBeUndefined();
    expect(pod.spec.containers[0].command.join(" ")).not.toContain("--skill");
  });
});

describe("KubernetesSandbox artifact upload", () => {
  it(
    "runAgent mints an artifact token, injects it into creds, and appends a " +
      "best-effort tar+curl upload that runs after the agent, evicted on dispose",
    async () => {
      const { apis, created, secretsCreated } = fakeApis();
      const artifactStore = createArtifactStore(
        new LocalArtifactBackend(() => "/tmp/artifact-test"),
      );
      const sbx = new KubernetesSandbox(
        factoryOpts,
        cfg(apis, { namespace: "ns-artifacts", artifactStore }),
      );
      await sbx.provision();

      await sbx.runAgent(
        "t1",
        "hello",
        { model: "anthropic/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
        () => {},
      );

      const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
      const token = creds.stringData.LASTLIGHT_ARTIFACT_TOKEN;
      expect(token).toBeTruthy();
      expect(artifactStore.resolve(token)).toBe("t1");

      // Script no longer starts with a bare `exec` — a post-run upload step
      // must run after the agent, so the agent's own exit code ($?) can be
      // captured, then restored via the final `exit $rc`.
      const script: string = created[0].spec.containers[0].command[2];
      expect(script.trim().startsWith("exec ")).toBe(false);
      expect(script).toContain("rc=$?");
      expect(script).toContain("tar -czf - .lastlight");
      expect(script).toContain("curl -sf -X POST");
      expect(script).toContain("Authorization: Bearer $LASTLIGHT_ARTIFACT_TOKEN");
      expect(script).toContain("$2/internal/sandbox-artifacts");
      expect(script).toContain("|| true");
      expect(script).toContain("exit $rc");

      await sbx.dispose();
      expect(artifactStore.resolve(token)).toBeUndefined();
    },
  );

  it("runCommand mints no artifact token: no LASTLIGHT_ARTIFACT_TOKEN in creds", async () => {
    const { apis, secretsCreated } = fakeApis();
    const artifactStore = createArtifactStore(new LocalArtifactBackend(() => "/tmp/artifact-test"));
    const sbx = new KubernetesSandbox(
      factoryOpts,
      cfg(apis, { namespace: "ns-artifacts-cmd", artifactStore }),
    );
    await sbx.provision();
    await sbx.runCommand("t1", "true", { cwd: "/w", timeoutSeconds: 30 } as any);

    const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
    expect(creds.stringData.LASTLIGHT_ARTIFACT_TOKEN).toBeUndefined();
  });

  it(
    "defaults to the module artifactStore singleton when none is injected — " +
      "the same instance the /internal/sandbox-artifacts route resolves against",
    async () => {
      const { apis, secretsCreated } = fakeApis();
      // No `artifactStore` override in these overrides — exercises the real
      // default (`cfg.artifactStore ?? artifactStore` in kubernetes-sandbox.ts),
      // which Task 6 points at the shared module singleton instead of a
      // throwaway per-instance store.
      const sbx = new KubernetesSandbox(factoryOpts, cfg(apis, { namespace: "ns-artifacts-default" }));
      await sbx.provision();

      await sbx.runAgent(
        "t1",
        "hello",
        { model: "anthropic/x", sandboxEnv: {}, agentCwd: "/home/agent/workspace" } as any,
        () => {},
      );

      const creds = secretsCreated.find((s: any) => s.metadata.name.endsWith("-creds"));
      const token = creds.stringData.LASTLIGHT_ARTIFACT_TOKEN;
      expect(token).toBeTruthy();
      // Resolved via the imported singleton directly (not a fresh store) —
      // if the adapter's default ever regresses back to a per-instance store,
      // this resolves to `undefined` and the test fails. `register` keys on
      // `this.opts.taskId` (the constructor's `factoryOpts.taskId`, "t1"),
      // not the `taskId` arg passed to `runAgent`.
      expect(sharedArtifactStore.resolve(token)).toBe("t1");

      await sbx.dispose();
      expect(sharedArtifactStore.resolve(token)).toBeUndefined();
    },
  );
});
