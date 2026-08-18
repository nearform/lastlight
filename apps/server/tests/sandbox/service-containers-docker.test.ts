import { describe, it, expect } from "vitest";
import {
  buildServiceRunArgs,
  serviceContainerName,
  serviceLabelArgs,
  SERVICE_LABEL_SELECTOR,
} from "#src/sandbox/service-containers-docker.js";
import { ImageAllowlist, PortMapping, ServiceSet } from "lastlight-shared/sandbox-services";

const setOf = (...specs: Parameters<typeof ServiceSet.create>[0]) =>
  ServiceSet.create(specs, {
    allowlist: ImageAllowlist.of(["docker.io/library/postgres:*"]),
    maxServices: 3,
  }).set;

const pg = {
  name: "postgres",
  image: "postgres:16-alpine",
  env: { POSTGRES_PASSWORD: "probe" },
  ports: [PortMapping.parse("5432")!],
  healthCmd: ["pg_isready"],
};

const opts = {
  taskId: "t1",
  sandboxContainer: "lastlight-sandbox-t1",
  forwarderImage: "alpine/socat:latest",
};

describe("buildServiceRunArgs", () => {
  it("joins the sandbox's network namespace", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).toContain("--network");
    expect(svc!.args).toContain("container:lastlight-sandbox-t1");
  });

  // Verified against a real daemon: docker rejects publishing outright with a joined
  // namespace — "conflicting options: port publishing and the container type network
  // mode". Ports are a forwarder's job here, never docker's.
  it("never publishes a port", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).not.toContain("-p");
    expect(svc!.args).not.toContain("--publish");
  });

  it("stamps the task label so a sweep can find an orphan", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).toEqual(expect.arrayContaining(serviceLabelArgs("t1")));
    expect(serviceLabelArgs("t1")).toContain(SERVICE_LABEL_SELECTOR);
  });

  it("passes declared env through", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).toEqual(expect.arrayContaining(["-e", "POSTGRES_PASSWORD=probe"]));
  });

  it("names the container deterministically per task and service", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.name).toBe(serviceContainerName("t1", "postgres"));
  });

  it("adds a forwarder sibling only for a remapped port", () => {
    const out = buildServiceRunArgs(setOf({ ...pg, ports: [PortMapping.parse("5433:5432")!] }), opts);
    expect(out.map((c) => c.name)).toEqual([
      "lastlight-svc-t1-postgres",
      "lastlight-fwd-t1-postgres-5433",
    ]);
    expect(out[1]!.args).toEqual(
      expect.arrayContaining(["TCP-LISTEN:5433,fork,reuseaddr", "TCP:127.0.0.1:5432"]),
    );
    // The forwarder joins the same namespace, or it would forward to nothing.
    expect(out[1]!.args).toContain("container:lastlight-sandbox-t1");
  });

  // Declared once, honoured on both backends — otherwise the field means two different
  // things depending on where the phase happened to run.
  it("honours a declared runAsUser", () => {
    const [svc] = buildServiceRunArgs(setOf({ ...pg, runAsUser: 70 }), opts);
    expect(svc!.args).toEqual(expect.arrayContaining(["--user", "70"]));
  });

  it("leaves the image's own user alone when none was declared", () => {
    const [svc] = buildServiceRunArgs(setOf(pg), opts);
    expect(svc!.args).not.toContain("--user");
  });

  it("passes a declared command through after the image", () => {
    const [svc] = buildServiceRunArgs(setOf({ ...pg, command: ["postgres", "-p", "5433"] }), opts);
    const imageIdx = svc!.args.indexOf("postgres:16-alpine");
    expect(svc!.args.slice(imageIdx + 1)).toEqual(["postgres", "-p", "5433"]);
  });

  it("is empty for an empty set", () => {
    expect(buildServiceRunArgs(ServiceSet.empty(), opts)).toEqual([]);
  });
});
