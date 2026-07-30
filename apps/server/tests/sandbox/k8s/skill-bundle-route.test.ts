import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { mountSkillBundle } from "#src/sandbox/k8s/skill-bundle-route.js";
import { SkillBundleRegistry } from "#src/sandbox/k8s/skill-bundle.js";

function appWith(registry: SkillBundleRegistry): Hono {
  const app = new Hono();
  mountSkillBundle(app, registry);
  return app;
}

describe("GET /internal/skill-bundle", () => {
  it("serves the registered tar to a valid bearer token", async () => {
    const reg = new SkillBundleRegistry();
    const token = reg.register(Buffer.from("TARBYTES"));
    const app = appWith(reg);
    const res = await app.request("/internal/skill-bundle", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/gzip");
    expect(Buffer.from(await res.arrayBuffer()).toString()).toBe("TARBYTES");
  });

  it("401s an unknown token", async () => {
    const app = appWith(new SkillBundleRegistry());
    const res = await app.request("/internal/skill-bundle", {
      headers: { authorization: "Bearer nope" },
    });
    expect(res.status).toBe(401);
  });

  it("401s a missing Authorization header", async () => {
    const app = appWith(new SkillBundleRegistry());
    const res = await app.request("/internal/skill-bundle");
    expect(res.status).toBe(401);
  });
});
