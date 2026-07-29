import { describe, it, expect } from "vitest";
import { AgentContextRegistry } from "#src/sandbox/k8s/agent-context-registry.js";

describe("AgentContextRegistry", () => {
  it("register → get round-trips the text; evict + unknown → undefined", () => {
    const reg = new AgentContextRegistry();
    const token = reg.register("BE HELPFUL");
    expect(reg.get(token)).toBe("BE HELPFUL");
    expect(reg.get("nope")).toBeUndefined();
    reg.evict(token);
    expect(reg.get(token)).toBeUndefined();
  });

  it("expires entries past the TTL", () => {
    const reg = new AgentContextRegistry(0); // immediate expiry
    const token = reg.register("x");
    expect(reg.get(token)).toBeUndefined();
  });

  it("mints a distinct token per registration", () => {
    const reg = new AgentContextRegistry();
    expect(reg.register("a")).not.toBe(reg.register("a"));
  });
});
