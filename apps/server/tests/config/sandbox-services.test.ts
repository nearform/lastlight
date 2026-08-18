import { describe, it, expect } from "vitest";
import {
  ImageAllowlist,
  parseServiceSpec,
  PortMapping,
  ServiceSet,
} from "lastlight-shared/sandbox-services";
import type { ServiceSpec } from "lastlight-shared/sandbox-services";
import { defaultRepoConfigPolicy, resolveRepoConfig, sanitizeRepoConfigLayer } from "lastlight-shared/repo-config-schema";
import type { RepoConfigBase, RepoConfigPolicy } from "lastlight-shared/repo-config-schema";

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

describe("parseServiceSpec — name validation", () => {
  const ok = (name: string) =>
    parseServiceSpec(name, { image: "postgres:16-alpine", ports: ["5432"] }) !== undefined;

  // The k8s backend composes `svc-<name>` / `fwd-<name>-<port>` as CONTAINER names, and
  // the API server validates those as RFC 1123 labels. An invalid name is a 422 at pod
  // creation, which fails the WHOLE run at provision — so it must be rejected here,
  // where a bad value is warned about and dropped instead.
  it("rejects an underscore, which Actions allows and kubernetes does not", () => {
    expect(ok("my_service")).toBe(false);
  });

  it("rejects a trailing hyphen — `svc-my-` is not a valid label either", () => {
    expect(ok("my-")).toBe(false);
  });

  it("rejects a leading hyphen and uppercase", () => {
    expect(ok("-svc")).toBe(false);
    expect(ok("Postgres")).toBe(false);
  });

  it("accepts a leading digit, which RFC 1123 permits", () => {
    expect(ok("123-abc")).toBe(true);
  });

  it("accepts ordinary names", () => {
    expect(ok("postgres")).toBe(true);
    expect(ok("my-service")).toBe(true);
  });

  it("rejects a name long enough to overflow the composed forwarder label", () => {
    // `fwd-<name>-<port>` must stay within the 63-char label limit.
    expect(ok("a".repeat(53))).toBe(true);
    expect(ok("a".repeat(54))).toBe(false);
  });

  it("rejects an empty name", () => {
    expect(ok("")).toBe(false);
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

// ---------------------------------------------------------------------------
// The repo-config surface: a repo declaring services in .lastlight/lastlight.yml
// ---------------------------------------------------------------------------

const policyWith = (over: Partial<RepoConfigPolicy> = {}): RepoConfigPolicy => ({
  ...defaultRepoConfigPolicy(),
  allowedImages: ["docker.io/library/postgres:*"],
  maxServices: 2,
  ...over,
});

const emptyBase = (): RepoConfigBase => ({ value: {}, sources: {} });

describe("sanitizeRepoConfigLayer — services", () => {
  it("keeps a well-formed declaration", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      {
        services: {
          postgres: {
            image: "postgres:16-alpine",
            env: { POSTGRES_PASSWORD: "probe" },
            ports: ["5433:5432"],
            healthCmd: "pg_isready",
            runAsUser: 70,
          },
        },
      },
      policyWith(),
      emptyBase(),
    );
    expect(warnings).toEqual([]);
    expect(layer.services).toBeDefined();
  });

  it("warns and drops an image outside the operator allowlist", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      { services: { redis: { image: "redis:7", ports: ["6379"] } } },
      policyWith(),
      emptyBase(),
    );
    expect(layer.services).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(["service-not-allowed"]);
  });

  it("denies everything when the operator set no allowlist", () => {
    const { warnings } = sanitizeRepoConfigLayer(
      { services: { postgres: { image: "postgres:16-alpine", ports: ["5432"] } } },
      policyWith({ allowedImages: null }),
      emptyBase(),
    );
    expect(warnings.map((w) => w.code)).toEqual(["service-not-allowed"]);
  });

  it("rejects an image carrying an unresolved Actions expression", () => {
    const { warnings } = sanitizeRepoConfigLayer(
      { services: { postgres: { image: "postgres:${{ matrix.pg }}", ports: ["5432"] } } },
      policyWith(),
      emptyBase(),
    );
    expect(warnings.map((w) => w.code)).toEqual(["invalid-value"]);
  });

  it("rejects a malformed port and keeps the service out", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      { services: { postgres: { image: "postgres:16-alpine", ports: ["nope"] } } },
      policyWith(),
      emptyBase(),
    );
    expect(layer.services).toBeUndefined();
    expect(warnings.map((w) => w.code)).toEqual(["invalid-value"]);
  });

  it("rejects a non-mapping services block", () => {
    const { warnings } = sanitizeRepoConfigLayer({ services: ["postgres"] }, policyWith(), emptyBase());
    expect(warnings.map((w) => w.code)).toEqual(["invalid-value"]);
  });
});

describe("resolveRepoConfig — services reach the merged config", () => {
  // Guards the seam the sandbox adapters read: shapeMerged builds a FIXED shape and
  // drops anything not listed in it, so a block can be accepted by the sanitizer and
  // still vanish before any consumer sees it.
  it("carries a declared service through to merged.services", () => {
    const resolved = resolveRepoConfig(emptyBase(), policyWith(), {
      repo: "nearform/example",
      config: {
        services: {
          postgres: { image: "postgres:16-alpine", ports: ["5433:5432"], healthCmd: "pg_isready" },
        },
      },
      files: [],
      warnings: [],
    } as never);
    expect(resolved.warnings).toEqual([]);
    expect(Object.keys(resolved.merged.services)).toEqual(["postgres"]);
    // Plain data, so it survives JSON persistence and resume rehydration.
    expect(JSON.parse(JSON.stringify(resolved.merged.services)).postgres.image).toBe(
      "postgres:16-alpine",
    );
  });

  it("yields an empty services map when the repo declared none", () => {
    const resolved = resolveRepoConfig(emptyBase(), policyWith(), undefined);
    expect(resolved.merged.services).toEqual({});
  });
});
