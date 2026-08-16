import { describe, it, expect } from "vitest";
import { FakeSandbox } from "#src/sandbox/sandbox.js";
import {
  SERVICE_CAPABLE_BACKENDS,
  serviceEnv,
  servicesFor,
  withSandbox,
} from "#src/engine/executors/orchestrator.js";
import { ImageAllowlist, PortMapping, ServiceSet } from "lastlight-shared/sandbox-services";

const postgres = {
  name: "postgres",
  image: "postgres:16-alpine",
  env: {},
  ports: [PortMapping.parse("5432")!],
};

const setWith = (...specs: Parameters<typeof ServiceSet.create>[0]) =>
  ServiceSet.create(specs, {
    allowlist: ImageAllowlist.of(["docker.io/library/postgres:*"]),
    maxServices: 2,
  }).set;

describe("Sandbox port — services", () => {
  it("records the ServiceSet handed to the factory", () => {
    const fake = new FakeSandbox();
    fake.asFactory()("none", {
      taskId: "t1",
      egress: { unrestricted: false, hosts: [] },
      env: {},
      stateDir: "/tmp",
      services: setWith(postgres),
    });
    expect(fake.services?.specs.map((s) => s.name)).toEqual(["postgres"]);
  });

  it("leaves services undefined when the phase declared none", () => {
    const fake = new FakeSandbox();
    fake.asFactory()("none", {
      taskId: "t1",
      egress: { unrestricted: false, hosts: [] },
      env: {},
      stateDir: "/tmp",
    });
    expect(fake.services).toBeUndefined();
  });
});

describe("service capability by backend", () => {
  it("supports exactly the two container backends", () => {
    expect([...SERVICE_CAPABLE_BACKENDS].sort()).toEqual(["docker", "kubernetes"]);
  });

  it("yields an empty set when the phase declared none", () => {
    expect(servicesFor({} as never).isEmpty).toBe(true);
  });

  // `services` arrives as the RAW declaration map (plain data straight off the merged
  // repo config), so these also cover the parse at the orchestrator boundary.
  it("admits a declared service the operator permits", () => {
    const set = servicesFor({
      services: { postgres: { image: "postgres:16-alpine", ports: ["5432"] } },
      serviceBounds: { allowedImages: ["docker.io/library/postgres:*"], maxServices: 2 },
    } as never);
    expect(set.specs.map((s) => s.name)).toEqual(["postgres"]);
    expect(set.specs[0]!.ports[0]!.target).toBe(5432);
  });

  it("drops a service the operator's allowlist does not permit", () => {
    const set = servicesFor({
      services: { redis: { image: "redis:7", ports: ["6379"] } },
      serviceBounds: { allowedImages: ["docker.io/library/postgres:*"], maxServices: 2 },
    } as never);
    expect(set.isEmpty).toBe(true);
  });

  it("drops everything when the operator granted no images at all", () => {
    const set = servicesFor({
      services: { postgres: { image: "postgres:16-alpine", ports: ["5432"] } },
      serviceBounds: { allowedImages: null, maxServices: 2 },
    } as never);
    expect(set.isEmpty).toBe(true);
  });

  it("skips a declaration that no longer parses instead of throwing", () => {
    const set = servicesFor({
      services: { broken: { image: "postgres:${{ matrix.pg }}" } },
      serviceBounds: { allowedImages: ["docker.io/library/postgres:*"], maxServices: 2 },
    } as never);
    expect(set.isEmpty).toBe(true);
  });
});

describe("serviceEnv", () => {
  it("publishes the port the agent should dial, which is the LISTEN side", () => {
    const set = setWith({ ...postgres, ports: [PortMapping.parse("5433:5432")!] });
    expect(serviceEnv(set)).toEqual({ LASTLIGHT_SERVICES: '{"postgres":[5433]}' });
  });

  it("injects nothing when there are no services", () => {
    expect(serviceEnv(ServiceSet.empty())).toEqual({});
  });
});

describe("withSandbox — unsupported backends degrade rather than fail", () => {
  const ctx = (backend: string) => ({
    backend,
    taskId: "t1",
    env: {},
    stateDir: "/tmp",
    config: {
      services: { postgres: { image: "postgres:16-alpine", ports: ["5432"] } },
      serviceBounds: { allowedImages: ["docker.io/library/postgres:*"], maxServices: 2 },
    },
  });

  it("drops services on a backend that cannot run them, and STILL provisions", async () => {
    const fake = new FakeSandbox();
    const out = await withSandbox(
      { ...ctx("gondolin"), sandboxFactory: fake.asFactory() } as never,
      async () => "ok",
    );
    expect(out).toBe("ok");
    expect(fake.services?.isEmpty).toBe(true);
    expect(fake.provisionCalls).toBe(1); // degraded, NOT failed
    // …and with no services, nothing is injected for the agent to discover.
    expect(fake.env?.LASTLIGHT_SERVICES).toBeUndefined();
  });

  it("keeps them on a container backend and publishes the discovery env", async () => {
    const fake = new FakeSandbox();
    await withSandbox(
      { ...ctx("docker"), sandboxFactory: fake.asFactory() } as never,
      async () => "ok",
    );
    expect(fake.services?.specs.map((s) => s.name)).toEqual(["postgres"]);
    expect(fake.env?.LASTLIGHT_SERVICES).toBe('{"postgres":[5432]}');
  });
});
