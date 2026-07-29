import type { Hono } from "hono";
import type { SkillBundleRegistry } from "./skill-bundle.js";

/**
 * Mount the internal skill-bundle endpoint on the shared Hono app. A sandbox
 * Pod's initContainer fetches `GET /internal/skill-bundle` with the per-run
 * token (`Authorization: Bearer <token>`) it received in its creds Secret; the
 * token gates each Pod to its own bundle. Backend-agnostic — with no k8s runs,
 * nothing is ever registered, so every request 401s.
 */
export function mountSkillBundle(app: Hono, registry: SkillBundleRegistry): void {
  app.get("/internal/skill-bundle", (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const tar = token ? registry.get(token) : undefined;
    if (!tar) return c.body(null, 401);
    return c.body(new Uint8Array(tar), 200, { "Content-Type": "application/gzip" });
  });
}
