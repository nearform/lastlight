import { describe, it, expect } from "vitest";
import { ImageAllowlist, PortMapping, ServiceSet } from "lastlight-shared/sandbox-services";
import type { ServiceSpec } from "lastlight-shared/sandbox-services";

describe("PortMapping", () => {
  it("parses the Actions listen:target form", () => {
    const m = PortMapping.parse("5433:5432")!;
    expect(m.listen).toBe(5433);
    expect(m.target).toBe(5432);
    expect(m.needsForwarder).toBe(true);
  });

  it("parses a bare port as listen === target", () => {
    const m = PortMapping.parse("5432")!;
    expect(m.listen).toBe(5432);
    expect(m.target).toBe(5432);
    expect(m.needsForwarder).toBe(false);
  });

  it("rejects malformed, out-of-range and privileged listen ports", () => {
    expect(PortMapping.parse("")).toBeUndefined();
    expect(PortMapping.parse("abc:5432")).toBeUndefined();
    expect(PortMapping.parse("5432:")).toBeUndefined();
    expect(PortMapping.parse("0:5432")).toBeUndefined();
    expect(PortMapping.parse("70000:5432")).toBeUndefined();
    // The forwarder runs unprivileged, so it cannot bind below 1024.
    expect(PortMapping.parse("80:5432")).toBeUndefined();
  });

  it("allows a privileged TARGET — only the listen side is bound by us", () => {
    expect(PortMapping.parse("8080:80")?.target).toBe(80);
  });
});

describe("ImageAllowlist", () => {
  it("denies everything when absent or null — opposite polarity to allowedModels", () => {
    expect(ImageAllowlist.of(undefined).permits("postgres:16")).toBe(false);
    expect(ImageAllowlist.of(null).permits("postgres:16")).toBe(false);
    expect(ImageAllowlist.of([]).permits("postgres:16")).toBe(false);
    expect(ImageAllowlist.of(undefined).isEmpty).toBe(true);
  });

  it("matches a trailing-* tag wildcard", () => {
    const a = ImageAllowlist.of(["docker.io/library/postgres:*"]);
    expect(a.permits("docker.io/library/postgres:16-alpine")).toBe(true);
    expect(a.permits("docker.io/library/postgres")).toBe(true);
    expect(a.permits("docker.io/library/redis:7")).toBe(false);
  });

  it("normalises an unqualified image to docker.io/library", () => {
    const a = ImageAllowlist.of(["docker.io/library/postgres:*"]);
    expect(a.permits("postgres:16-alpine")).toBe(true);
  });

  it("honours a non-Docker-Hub registry", () => {
    // nearform/fastify-mssql pulls from mcr.microsoft.com — see 00-evidence.md
    const a = ImageAllowlist.of(["mcr.microsoft.com/mssql/server:*"]);
    expect(a.permits("mcr.microsoft.com/mssql/server:2017-CU8-ubuntu")).toBe(true);
    expect(a.permits("postgres:16")).toBe(false);
  });

  it("never lets a registry be smuggled past an unqualified pattern", () => {
    const a = ImageAllowlist.of(["docker.io/library/postgres:*"]);
    expect(a.permits("evil.example.com/library/postgres:16")).toBe(false);
  });
});

const spec = (over: Partial<ServiceSpec> & { name: string }): ServiceSpec => ({
  image: "postgres:16-alpine",
  env: {},
  ports: [PortMapping.parse("5432")!],
  ...over,
});

const bounds = (patterns: string[] = ["docker.io/library/postgres:*"], maxServices = 2) => ({
  allowlist: ImageAllowlist.of(patterns),
  maxServices,
});

describe("ServiceSet", () => {
  it("keeps a permitted service", () => {
    const { set, violations } = ServiceSet.create([spec({ name: "postgres" })], bounds());
    expect(violations).toEqual([]);
    expect(set.specs.map((s) => s.name)).toEqual(["postgres"]);
    expect(set.isEmpty).toBe(false);
  });

  it("drops a service whose image is not allowlisted, keeping the rest", () => {
    const specs = [spec({ name: "postgres" }), spec({ name: "redis", image: "redis:7" })];
    const { set, violations } = ServiceSet.create(specs, bounds());
    expect(set.specs.map((s) => s.name)).toEqual(["postgres"]);
    expect(violations).toEqual([{ name: "redis", reason: "image-not-allowed" }]);
  });

  it("drops beyond maxServices rather than failing the set", () => {
    const specs = [
      spec({ name: "a" }),
      spec({ name: "b", ports: [PortMapping.parse("5433")!] }),
      spec({ name: "c", ports: [PortMapping.parse("5434")!] }),
    ];
    const { set, violations } = ServiceSet.create(specs, bounds(undefined, 2));
    expect(set.specs.map((s) => s.name)).toEqual(["a", "b"]);
    expect(violations).toEqual([{ name: "c", reason: "too-many" }]);
  });

  // The invariant no per-item validator can see: one shared netns = one port space.
  it("drops a service whose target port another service already binds", () => {
    const specs = [spec({ name: "a" }), spec({ name: "b" })];
    const { set, violations } = ServiceSet.create(specs, bounds());
    expect(set.specs.map((s) => s.name)).toEqual(["a"]);
    expect(violations).toEqual([{ name: "b", reason: "port-collision" }]);
  });

  it("treats a forwarder listen port as occupying the same space", () => {
    const specs = [
      spec({ name: "a", ports: [PortMapping.parse("5433:5432")!] }),
      spec({ name: "b", ports: [PortMapping.parse("5433")!] }),
    ];
    const { set, violations } = ServiceSet.create(specs, bounds());
    expect(set.specs.map((s) => s.name)).toEqual(["a"]);
    expect(violations).toEqual([{ name: "b", reason: "port-collision" }]);
  });

  it("reports only the mappings that actually need a forwarder", () => {
    const specs = [
      spec({ name: "a", ports: [PortMapping.parse("5433:5432")!] }),
      spec({ name: "b", ports: [PortMapping.parse("6379")!] }),
    ];
    const { set } = ServiceSet.create(specs, bounds());
    const fwd = set.forwarders();
    expect(fwd).toHaveLength(1);
    expect(fwd[0]!.service.name).toBe("a");
    expect(fwd[0]!.mapping.listen).toBe(5433);
  });

  it("is empty when nothing was declared", () => {
    const { set, violations } = ServiceSet.create([], bounds());
    expect(set.isEmpty).toBe(true);
    expect(violations).toEqual([]);
    expect(ServiceSet.empty().isEmpty).toBe(true);
  });
});
