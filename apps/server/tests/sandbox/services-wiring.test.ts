import { describe, it, expect } from "vitest";
import { FakeSandbox } from "#src/sandbox/sandbox.js";
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
