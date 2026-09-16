/**
 * `GET /board/stream` and the signature behind it.
 *
 * The property worth pinning is what the frame CARRIES: a revision, and never
 * the board. The stream is scope-independent on purpose — `GET /board` narrows
 * per caller by `?repos=` and per-actor team visibility, so a frame that grew a
 * repo list would be a side channel around that boundary.
 *
 * The tick behaviour itself is deliberately NOT tested through the socket: a
 * "no second frame without a change" assertion costs a real `BOARD_TICK_MS` of
 * wall clock. The same logic is reachable as `boardSignature`, so it is tested
 * there, where it is free.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createAdminRoutes, type AdminConfig } from "#src/admin/routes.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import { makeTestDb } from "../helpers/state-db.js";
import { createToken } from "#src/admin/auth.js";
import { resetBoardCacheForTests } from "#src/admin/board-cache.js";
import {
  boardSignature,
  noteBoardRunChange,
  resetBoardStreamForTests,
} from "#src/admin/board-stream.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";

const SECRET = "test-secret";
const REPO = "acme/widget";

let db: StateDb;

function runtimeConfig(): LastLightConfig {
  return {
    stateDir: "/tmp",
    managedRepos: [REPO],
    botName: "last-light",
    botLogin: "last-light[bot]",
    holdLabel: "lastlight-ignore",
    models: {},
    variants: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    autonomy: { repos: [REPO], stages: {}, budget: {} },
  } as unknown as LastLightConfig;
}

function makeApp(over: Partial<AdminConfig> = {}) {
  return createAdminRoutes(db, {} as unknown as SessionReader, {} as unknown as SessionReader, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: SECRET,
    ...over,
  } as AdminConfig);
}

beforeEach(async () => {
  db = await makeTestDb();
  resetBoardCacheForTests();
  resetBoardStreamForTests();
  setRuntimeConfig(runtimeConfig());
});

afterEach(() => {
  resetRuntimeConfigForTests();
  resetBoardCacheForTests();
  resetBoardStreamForTests();
  vi.restoreAllMocks();
});

describe("GET /board/stream", () => {
  it("opens with a handshake frame carrying a revision and no repo names", async () => {
    const app = makeApp();
    const token = createToken(SECRET, "password");
    const res = await app.fetch(
      new Request(`http://localhost/board/stream?token=${encodeURIComponent(token)}`),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    const reader = res.body!.getReader();
    try {
      const { value } = await reader.read();
      const frame = new TextDecoder().decode(value);
      expect(frame).toContain("event: board");

      const payload = JSON.parse(/data: (.*)/.exec(frame)![1]!) as Record<string, unknown>;
      expect(typeof payload.revision).toBe("string");
      // The whole reason this is a signal and not a board.
      expect(frame).not.toContain(REPO);
    } finally {
      await reader.cancel();
    }
  });
});

describe("boardSignature", () => {
  it("is stable when nothing has happened", async () => {
    expect(await boardSignature(db)).toBe(await boardSignature(db));
  });

  it("moves when a run reaches a terminal state", async () => {
    // The run half of a card is read live while the GitHub half is cached, so
    // a run finishing changes the board without touching the cache.
    const before = await boardSignature(db);
    noteBoardRunChange();
    expect(await boardSignature(db)).not.toBe(before);
  });

  it("moves when an active run advances a phase", async () => {
    // Neither counter moves for this — it is why the signature reads the live
    // shape of every active run rather than trusting the counters alone.
    await db.runs.createRun({
      id: "run-1",
      workflowName: "build",
      triggerId: `${REPO}#1`,
      owner: "acme",
      repo: "widget",
      issueNumber: 1,
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    const before = await boardSignature(db);

    // `appendPhase` is the single seam every phase write goes through, and it
    // is what moves `currentPhase` — the field the signature reads.
    await db.runs.appendPhase("run-1", "reviewer", {
      phase: "reviewer",
      timestamp: new Date().toISOString(),
      success: true,
    });
    expect(await boardSignature(db)).not.toBe(before);
  });
});
