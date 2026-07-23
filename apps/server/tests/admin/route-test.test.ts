import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the classifier + screener before importing the admin routes, so the
// route-test endpoint (and routeEvent underneath it) classify deterministically
// without any real LLM call. Mirrors tests/engine/router.test.ts.
vi.mock("#src/engine/screen/classifier.js", () => ({
  classifyComment: vi.fn().mockResolvedValue({ intent: "chat" }),
  classifyIssueIntent: vi.fn().mockResolvedValue(false),
  classifyCommentAddsInfo: vi.fn().mockResolvedValue(false),
  WELL_KNOWN_INTENTS: new Set([
    "build", "explore", "question", "triage", "review", "security",
    "verify", "qa-test", "demo", "approve", "reject", "status", "reset", "chat",
  ]),
}));
vi.mock("#src/engine/screen/screen.js", async () => {
  const actual = await vi.importActual<typeof import("#src/engine/screen/screen.js")>("#src/engine/screen/screen.js");
  return { ...actual, screenForInjection: vi.fn().mockResolvedValue({ flagged: false }) };
});

import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import { classifyComment } from "#src/engine/screen/classifier.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionSource } from "#src/admin/sessions.js";
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from "#src/config/config.js";

const mockClassify = vi.mocked(classifyComment);

const mockSessions = {} as unknown as SessionSource;
const mockDb = {} as unknown as StateDb;

// Spies for the (absent-by-default) execution callbacks — asserting they are
// NEVER called proves the endpoint can't start a run.
const resumeWorkflow = vi.fn();
const retryWorkflow = vi.fn();
const triggerCron = vi.fn();

function makeConfig(overrides: Partial<AdminConfig> = {}): AdminConfig {
  return {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "", // no password + no OAuth → auth disabled (open)
    adminSecret: "test-secret",
    resumeWorkflow,
    retryWorkflow,
    triggerCron,
    ...overrides,
  };
}

async function post(app: ReturnType<typeof createAdminRoutes>, path: string, body: unknown) {
  return app.fetch(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  mockClassify.mockReset();
  mockClassify.mockResolvedValue({ intent: "chat" });
  resumeWorkflow.mockReset();
  retryWorkflow.mockReset();
  triggerCron.mockReset();
  setRuntimeConfig({
    managedRepos: ["cliftonc/drizby", "cliftonc/lastlight"],
  } as unknown as LastLightConfig);
});
afterEach(() => resetRuntimeConfigForTests());

describe("POST /route-test", () => {
  it("classifies a comment for real and returns the matched handler + reasoning", async () => {
    mockClassify.mockResolvedValue({ intent: "build", reason: "the user asks to implement it" });
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await post(app, "/route-test", {
      source: "github",
      type: "comment.created",
      repo: "cliftonc/drizby",
      issueNumber: 42,
      body: "@last-light build a login page",
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      route: { action: string; handler?: string };
      classification?: { intent: string };
      explanation: { routingKind: string; reason?: string };
    };
    expect(mockClassify).toHaveBeenCalled(); // real-classifier path
    expect(b.route.action).toBe("handler");
    expect(b.route.handler).toBeTruthy();
    expect(b.classification?.intent).toBe("build");
    expect(b.explanation.routingKind).toBe("classifier");
    expect(b.explanation.reason).toBe("the user asks to implement it");
  });

  it("never invokes any execution callback (cannot start a workflow)", async () => {
    mockClassify.mockResolvedValue({ intent: "build", reason: "x" });
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    await post(app, "/route-test", {
      source: "github",
      type: "comment.created",
      repo: "cliftonc/drizby",
      issueNumber: 42,
      body: "@last-light build a login page",
    });
    expect(resumeWorkflow).not.toHaveBeenCalled();
    expect(retryWorkflow).not.toHaveBeenCalled();
    expect(triggerCron).not.toHaveBeenCalled();
  });

  it("routes a deterministic event without calling the classifier", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await post(app, "/route-test", {
      source: "github",
      type: "pr.opened",
      repo: "cliftonc/drizby",
      prNumber: 7,
      isPullRequest: true,
      body: "",
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as {
      route: { action: string; handler?: string };
      classification?: unknown;
      explanation: { routingKind: string };
    };
    expect(mockClassify).not.toHaveBeenCalled();
    expect(b.route.action).toBe("handler");
    expect(b.route.handler).toBe("pr-review");
    expect(b.explanation.routingKind).toBe("deterministic");
    expect(b.classification).toBeUndefined();
  });

  it("is hermetic — returns a route without db/github even for an unmanaged repo", async () => {
    mockClassify.mockResolvedValue({ intent: "chat" });
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await post(app, "/route-test", {
      source: "slack",
      type: "message",
      repo: "someone/unmanaged",
      body: "hello there",
    });
    expect(res.status).toBe(200);
    const b = (await res.json()) as { route: { action: string } };
    expect(["handler", "reply", "ignore"]).toContain(b.route.action);
  });

  it("rejects a request without a type", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await post(app, "/route-test", { source: "github", body: "hi" });
    expect(res.status).toBe(400);
  });
});

describe("GET /route-graph", () => {
  it("returns inputs, event types, handlers, and edges", async () => {
    const app = createAdminRoutes(mockDb, mockSessions, mockSessions, makeConfig());
    const res = await app.fetch(new Request("http://localhost/route-graph"));
    expect(res.status).toBe(200);
    const g = (await res.json()) as {
      inputs: { id: string }[];
      eventTypes: { type: string; routing: string }[];
      handlers: { name: string; kind: string }[];
      deterministicEdges: { from: string; to: string }[];
      intentEdges: { intent: string; to: string }[];
    };
    expect(g.inputs.map((i) => i.id)).toEqual(["github", "slack"]);
    expect(g.eventTypes.some((e) => e.type === "comment.created" && e.routing === "classifier")).toBe(true);
    expect(g.eventTypes.some((e) => e.type === "pr.opened" && e.routing === "deterministic")).toBe(true);
    expect(g.handlers.some((h) => h.name === "pr-review")).toBe(true);
    expect(g.handlers.some((h) => h.kind === "in-process" && h.name === "chat")).toBe(true);
    expect(g.deterministicEdges.some((e) => e.from === "pr.opened" && e.to === "pr-review")).toBe(true);
    expect(g.intentEdges.some((e) => e.intent === "review")).toBe(true);
  });
});
