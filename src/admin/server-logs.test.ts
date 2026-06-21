import { describe, it, expect, vi } from "vitest";
import { createAdminRoutes, type AdminConfig } from "./routes.js";
import { createToken } from "./auth.js";
import type { StateDb } from "../state/db.js";
import type { SessionReader } from "./sessions.js";

const resolveServerContainer = vi.fn(async (req?: string): Promise<string | null> =>
  req && req !== "agent" && req !== "lastlight-agent-1" ? null : "lastlight-agent-1",
);
const listServerContainers = vi.fn(async () => [
  { name: "lastlight-agent-1", service: "agent", status: "Up 2 hours", image: "lastlight-agent" },
  { name: "lastlight-coredns-strict-1", service: "coredns-strict", status: "Up 2 hours", image: "coredns" },
]);
const getContainerLogs = vi.fn(async (_name: string, _opts?: unknown): Promise<string[]> => [
  "2026-06-21T07:00:00Z line one",
  "2026-06-21T07:00:01Z line two",
]);

vi.mock("./docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
  killContainer: vi.fn(async () => {}),
  getContainerStats: vi.fn(async () => []),
  listServerContainers: () => listServerContainers(),
  resolveServerContainer: (req?: string) => resolveServerContainer(req),
  getContainerLogs: (name: string, opts?: unknown) => getContainerLogs(name, opts),
  streamContainerLogs: vi.fn(() => () => {}),
}));
vi.mock("arctic", () => ({ Slack: class {}, GitHub: class {} }));

const SECRET = "test-secret";
const empty = {
  listSessionIds: () => [], read: async () => [], getSessionMeta: async () => null,
  exists: () => false, getFilePath: () => null, normalizeRawLine: (r: Record<string, unknown>) => [r],
} as unknown as SessionReader;
const db = { executions: {}, runs: {}, approvals: {} } as unknown as StateDb;
const config: AdminConfig = { stateDir: "/tmp", sessionsDir: "/tmp/s", adminPassword: "pw", adminSecret: SECRET };
const app = createAdminRoutes(db, empty, empty, config);
const authed = (path: string) =>
  app.fetch(new Request(`http://localhost${path}`, { headers: { Authorization: `Bearer ${createToken(SECRET)}` } }));

describe("server log endpoints", () => {
  it("401s without a token", async () => {
    const res = await app.fetch(new Request("http://localhost/server/containers"));
    expect(res.status).toBe(401);
  });

  it("lists lastlight containers", async () => {
    const res = await authed("/server/containers");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { containers: any[] };
    expect(body.containers.map((c) => c.service)).toContain("agent");
  });

  it("returns logs for the resolved (default agent) container", async () => {
    const res = await authed("/server/logs?tail=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { container: string; lines: string[] };
    expect(resolveServerContainer).toHaveBeenCalled();
    expect(body.container).toBe("lastlight-agent-1");
    expect(body.lines).toHaveLength(2);
  });

  it("404s when the requested container does not resolve", async () => {
    const res = await authed("/server/logs?container=does-not-exist");
    expect(res.status).toBe(404);
  });
});
