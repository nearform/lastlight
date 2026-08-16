import { describe, it, expect } from "vitest";
import { PortMapping } from "lastlight-shared/sandbox-services";

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
