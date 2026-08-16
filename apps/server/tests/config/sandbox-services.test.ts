import { describe, it, expect } from "vitest";
import { ImageAllowlist, PortMapping } from "lastlight-shared/sandbox-services";

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
