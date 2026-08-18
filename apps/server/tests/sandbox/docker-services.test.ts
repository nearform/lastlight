import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn(), execFile: vi.fn() };
});

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

import { execFileSync } from "child_process";
import { DockerSandbox } from "#src/sandbox/docker.js";
import { reapSandboxWorkspace } from "#src/sandbox/reap.js";
import { ImageAllowlist, PortMapping, ServiceSet } from "lastlight-shared/sandbox-services";

const mockExec = vi.mocked(execFileSync);

/** Every `docker` invocation made, as argv arrays. */
const dockerCalls = (): string[][] =>
  mockExec.mock.calls.filter((c) => c[0] === "docker").map((c) => (c[1] as string[]) ?? []);

const pg = {
  name: "postgres",
  image: "postgres:16-alpine",
  env: { POSTGRES_PASSWORD: "probe" },
  ports: [PortMapping.parse("5432")!],
};

const setOf = (...specs: Parameters<typeof ServiceSet.create>[0]) =>
  ServiceSet.create(specs, {
    allowlist: ImageAllowlist.of(["docker.io/library/postgres:*"]),
    maxServices: 3,
  }).set;

/** A driver whose sandbox container is already "created", so services can join it. */
function driverWithSandbox(taskId = "t1"): DockerSandbox {
  const sbx = new DockerSandbox({ imageName: "lastlight-sandbox:latest", env: {} });
  // The registry `startServices`/`destroy` read to find the namespace owner.
  (sbx as unknown as { activeContainers: Map<string, unknown> }).activeContainers.set(taskId, {
    containerId: "deadbeef",
    containerName: `lastlight-sandbox-${taskId}`,
    worktreePath: "/tmp/ws",
  });
  return sbx;
}

beforeEach(() => {
  mockExec.mockReset();
  mockExec.mockReturnValue("" as never);
});

describe("DockerSandbox.startServices", () => {
  it("starts one container per service, joined to the sandbox namespace", async () => {
    const sbx = driverWithSandbox();
    await sbx.startServices("t1", setOf(pg));

    const run = dockerCalls().find((a) => a[0] === "run");
    expect(run).toBeDefined();
    expect(run).toContain("container:lastlight-sandbox-t1");
    expect(run).toContain("lastlight-svc-t1-postgres");
  });

  it("does nothing at all for an empty set", async () => {
    const sbx = driverWithSandbox();
    await sbx.startServices("t1", ServiceSet.empty());
    expect(dockerCalls()).toHaveLength(0);
  });

  it("does not health-poll a service whose container failed to start", async () => {
    const sbx = driverWithSandbox();
    mockExec.mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a[0] === "run") throw new Error("no such image");
      return "" as never;
    });

    await sbx.startServices("t1", setOf({ ...pg, healthCmd: ["pg_isready"] }));

    // Without the gate this polls a nonexistent container once a second for 90s,
    // each `docker exec` failing instantly with "No such container".
    expect(dockerCalls().filter((a) => a[0] === "exec")).toHaveLength(0);
  });

  it("does nothing when the sandbox container is unknown", async () => {
    const sbx = new DockerSandbox({ imageName: "x", env: {} });
    await sbx.startServices("nope", setOf(pg));
    expect(dockerCalls()).toHaveLength(0);
  });
});

describe("DockerSandbox teardown", () => {
  it("removes service containers BEFORE the sandbox that owns their namespace", async () => {
    const sbx = driverWithSandbox();
    mockExec.mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      // The label query the sweep/teardown uses to find this task's services.
      if (a[0] === "ps") return "svc123\nfwd456\n" as never;
      return "" as never;
    });

    await sbx.destroy("t1");

    const removals = dockerCalls().filter((a) => a[0] === "rm");
    expect(removals).toHaveLength(2);
    // Services first: a joined container SURVIVES removal of the namespace owner
    // (verified against a real daemon), so the reverse order orphans them.
    expect(removals[0]).toEqual(expect.arrayContaining(["svc123", "fwd456"]));
    expect(removals[1]).toEqual(expect.arrayContaining(["lastlight-sandbox-t1"]));
  });

  it("finds orphans by label, which is the only handle after a harness crash", async () => {
    const sbx = driverWithSandbox();
    mockExec.mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a[0] === "ps") return "svc123\n" as never;
      return "" as never;
    });

    await sbx.destroy("t1");

    const ps = dockerCalls().find((a) => a[0] === "ps");
    expect(ps).toEqual(expect.arrayContaining(["--filter", "label=lastlight.taskId=t1"]));
    expect(ps).toEqual(
      expect.arrayContaining(["--filter", "label=lastlight.component=service"]),
    );
  });

  it("still removes the sandbox when there are no services to clean up", async () => {
    const sbx = driverWithSandbox();
    mockExec.mockReturnValue("" as never);

    await sbx.destroy("t1");

    const removals = dockerCalls().filter((a) => a[0] === "rm");
    expect(removals).toHaveLength(1);
    expect(removals[0]).toEqual(expect.arrayContaining(["lastlight-sandbox-t1"]));
  });

  it("never lets a service-cleanup failure block the sandbox removal", async () => {
    const sbx = driverWithSandbox();
    mockExec.mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a[0] === "ps") throw new Error("daemon hiccup");
      return "" as never;
    });

    await expect(sbx.destroy("t1")).resolves.toBeUndefined();
    expect(dockerCalls().filter((a) => a[0] === "rm")).toHaveLength(1);
  });
});

describe("reapSandboxWorkspace — leaked service containers", () => {
  it("removes orphaned services by label when it reaps a workspace", () => {
    mockExec.mockImplementation((cmd, args) => {
      const a = (args as string[]) ?? [];
      if (a[0] === "ps") return "orphan123\n" as never;
      return "" as never;
    });

    // A harness crash between provision() and dispose() leaves the service running with
    // no sandbox to own it. The sweep routes every removal through here, so this is
    // where the backstop belongs.
    reapSandboxWorkspace({
      taskId: "t1",
      stateDir: "/tmp/does-not-exist",
      isLive: () => false,
    });

    const rm = dockerCalls().find((a) => a[0] === "rm");
    expect(rm).toEqual(expect.arrayContaining(["orphan123"]));
  });

  it("leaves services alone when the sandbox container is still live", () => {
    mockExec.mockReturnValue("live123\n" as never);

    reapSandboxWorkspace({
      taskId: "t1",
      stateDir: "/tmp/does-not-exist",
      isLive: () => true,
    });

    expect(dockerCalls().filter((a) => a[0] === "rm")).toHaveLength(0);
  });
});
