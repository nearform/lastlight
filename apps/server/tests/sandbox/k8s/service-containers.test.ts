import { describe, it, expect } from "vitest";
import { buildServiceContainers, SERVICE_DEFAULT_UID } from "#src/sandbox/k8s/service-containers.js";
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
  runAsUser: 70,
};

const opts = { forwarderImage: "alpine/socat:latest" };

describe("buildServiceContainers", () => {
  it("emits a native sidecar, not a regular container", () => {
    const [c] = buildServiceContainers(setOf(pg), opts);
    expect(c!.name).toBe("svc-postgres");
    expect(c!.image).toBe("postgres:16-alpine");
    // restartPolicy: Always on an init container IS the native-sidecar marker.
    expect((c as { restartPolicy?: string }).restartPolicy).toBe("Always");
  });

  it("is restricted-PSS compliant and never root", () => {
    const [c] = buildServiceContainers(setOf(pg), opts);
    expect(c!.securityContext?.allowPrivilegeEscalation).toBe(false);
    expect(c!.securityContext?.capabilities?.drop).toEqual(["ALL"]);
    expect(c!.securityContext?.runAsUser).toBe(70);
  });

  it("turns healthCmd into a startupProbe so the agent waits for readiness", () => {
    const [c] = buildServiceContainers(setOf(pg), opts);
    expect(c!.startupProbe?.exec?.command).toEqual(["pg_isready"]);
  });

  it("carries declared env inline — it is public repo config, not a secret", () => {
    const [c] = buildServiceContainers(setOf(pg), opts);
    expect(c!.env).toEqual([{ name: "POSTGRES_PASSWORD", value: "probe" }]);
  });

  it("adds a forwarder sidecar only for a remapped port", () => {
    const remapped = { ...pg, ports: [PortMapping.parse("5433:5432")!] };
    const out = buildServiceContainers(setOf(remapped), opts);
    expect(out.map((c) => c.name)).toEqual(["svc-postgres", "fwd-postgres-5433"]);
    expect(out[1]!.args).toEqual(["TCP-LISTEN:5433,fork,reuseaddr", "TCP:127.0.0.1:5432"]);
    expect((out[1] as { restartPolicy?: string }).restartPolicy).toBe("Always");
  });

  it("adds no forwarder when the port is not remapped", () => {
    expect(buildServiceContainers(setOf(pg), opts)).toHaveLength(1);
  });

  it("defaults to a non-root uid when the repo did not say", () => {
    const out = buildServiceContainers(setOf({ ...pg, runAsUser: undefined }), opts);
    expect(out[0]!.securityContext?.runAsUser).toBe(SERVICE_DEFAULT_UID);
    expect(SERVICE_DEFAULT_UID).toBeGreaterThan(0);
  });

  it("passes a declared command through as the escape hatch", () => {
    const out = buildServiceContainers(setOf({ ...pg, command: ["postgres", "-p", "5433"] }), opts);
    expect(out[0]!.command).toEqual(["postgres", "-p", "5433"]);
  });

  it("omits the probe entirely when no healthCmd was declared", () => {
    const out = buildServiceContainers(setOf({ ...pg, healthCmd: undefined }), opts);
    expect(out[0]!.startupProbe).toBeUndefined();
  });

  it("is empty for an empty set", () => {
    expect(buildServiceContainers(ServiceSet.empty(), opts)).toEqual([]);
  });
});
