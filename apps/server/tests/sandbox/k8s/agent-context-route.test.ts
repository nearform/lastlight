import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountAgentContext } from "#src/sandbox/k8s/agent-context-route.js";
import { AgentContextRegistry } from "#src/sandbox/k8s/agent-context-registry.js";

function appWith(registry: AgentContextRegistry): Hono {
  const app = new Hono();
  mountAgentContext(app, registry);
  return app;
}

describe("GET /internal/agent-context", () => {
  it("serves the registered text to a valid bearer token", async () => {
    const reg = new AgentContextRegistry();
    const token = reg.register("BE HELPFUL");
    const app = appWith(reg);
    const res = await app.request("/internal/agent-context", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(await res.text()).toBe("BE HELPFUL");
  });

  it("401s an unknown token", async () => {
    const app = appWith(new AgentContextRegistry());
    const res = await app.request("/internal/agent-context", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("401s a missing Authorization header", async () => {
    const app = appWith(new AgentContextRegistry());
    const res = await app.request("/internal/agent-context");
    expect(res.status).toBe(401);
  });
});
