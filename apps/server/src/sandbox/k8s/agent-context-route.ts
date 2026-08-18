import type { Hono } from "hono";
import type { AgentContextRegistry } from "./agent-context-registry.js";

/**
 * Mount the internal agent-context endpoint on the shared Hono app. A sandbox
 * Pod's initContainer fetches `GET /internal/agent-context` with the per-run
 * token (`Authorization: Bearer <token>`) it received in its creds Secret; the
 * token gates each Pod to its own resolved agent-context, which the init writes
 * to `<workspace>/AGENTS.md`. Mirrors the skill-bundle route — a separate route
 * because agent-context is per-run-constant and must reach a no-skills phase.
 * Backend-agnostic: with no k8s runs nothing is ever registered, so every
 * request 401s.
 */
export function mountAgentContext(app: Hono, registry: AgentContextRegistry): void {
  app.get("/internal/agent-context", (c) => {
    const header = c.req.header("authorization") ?? "";
    const token = header.replace(/^Bearer\s+/i, "").trim();
    const text = token ? registry.get(token) : undefined;
    if (text === undefined) return c.body(null, 401);
    return c.body(text, 200, { "Content-Type": "text/markdown; charset=utf-8" });
  });
}
