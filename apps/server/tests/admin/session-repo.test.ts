import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDb } from "#src/state/db.js";
import { SessionReader } from "#src/admin/sessions.js";
import { ChatSessionReader } from "#src/admin/chat-session-reader.js";

let db: StateDb;
let dir: string;

beforeEach(() => {
  db = new StateDb(":memory:");
  // `messaging_sessions` is owned by SessionManager, not `migrate()`, and
  // `getChatThread` LEFT JOINs it. Create the shape the join needs.
  db.database.exec(`
    CREATE TABLE IF NOT EXISTS messaging_sessions (
      id TEXT PRIMARY KEY,
      agent_session_id TEXT,
      platform TEXT
    );
    CREATE TABLE IF NOT EXISTS messaging_messages (
      session_id TEXT,
      role TEXT,
      content TEXT,
      timestamp TEXT
    );
  `);
  dir = mkdtempSync(join(tmpdir(), "lastlight-session-repo-"));
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Write one sandbox-session jsonl under the on-disk layout SessionReader scans. */
function writeSandboxSession(sessionId: string): void {
  const projectDir = join(dir, "projects", "-home-agent-workspace");
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({
      type: "user",
      timestamp: "2026-08-06T10:00:00.000Z",
      message: { role: "user", content: "You are the ARCHITECT" },
    }) + "\n",
  );
}

describe("ExecutionStore.repoForSessionId", () => {
  it("resolves a session id to the repo its execution ran against", () => {
    db.executions.recordStart({
      id: "e1",
      triggerType: "github",
      triggerId: "t1",
      skill: "pr-review",
      repo: "nearform/lastlight",
      issueNumber: 7,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    db.executions.recordSessionId("e1", "sess-1");
    expect(db.executions.repoForSessionId("sess-1")).toBe("nearform/lastlight");
  });

  it("qualifies a BARE repo name from the owning run's owner column", () => {
    // The regression this exists for: `runSimpleWorkflow` carries `owner` and
    // `repo` separately, so EVERY phase execution of a workflow run stores the
    // bare name. Returning `lastlight` here would match nothing in an
    // `owner/repo` allow-list — and a non-null non-match HIDES the row, which
    // is the one outcome per-repo visibility must never produce.
    db.runs.createRun({
      id: "run-1",
      workflowName: "pr-review",
      triggerId: "nearform/lastlight#7",
      owner: "nearform",
      repo: "lastlight",
      issueNumber: 7,
      currentPhase: "review",
      status: "running",
      startedAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:00:00.000Z",
    });
    db.executions.recordStart({
      id: "e1",
      triggerType: "webhook",
      triggerId: "nearform/lastlight#7",
      skill: "pr-review:review",
      repo: "lastlight",
      issueNumber: 7,
      startedAt: "2026-08-06T10:00:00.000Z",
      workflowRunId: "run-1",
    });
    db.executions.recordSessionId("e1", "sess-1");
    expect(db.executions.repoForSessionId("sess-1")).toBe("nearform/lastlight");
  });

  it("returns null — not a bare name — when there is no owner to qualify with", () => {
    // Null reads as "no repo, always visible". A bare name would read as a
    // repo that is in nobody's allow-list.
    db.executions.recordStart({
      id: "e1",
      triggerType: "webhook",
      triggerId: "t1",
      skill: "pr-review:review",
      repo: "lastlight",
      issueNumber: 7,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    db.executions.recordSessionId("e1", "sess-1");
    expect(db.executions.repoForSessionId("sess-1")).toBeNull();
  });

  it("returns null for a session with no execution row", () => {
    expect(db.executions.repoForSessionId("unknown")).toBeNull();
  });

  it("returns null when the execution carries no repo (a cron/Slack run)", () => {
    db.executions.recordStart({
      id: "e1",
      triggerType: "slack",
      triggerId: "t1",
      skill: "chat",
      repo: null as unknown as string,
      issueNumber: null as unknown as number,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    db.executions.recordSessionId("e1", "sess-1");
    expect(db.executions.repoForSessionId("sess-1")).toBeNull();
  });
});

describe("SessionReader repo resolution", () => {
  it("carries the repo from the executions join onto SessionMeta", async () => {
    writeSandboxSession("sess-1");
    const reader = new SessionReader(dir, "sandbox", () => "nearform/lastlight");
    const meta = await reader.getSessionMeta("sess-1");
    expect(meta?.repo).toBe("nearform/lastlight");
  });

  it("reports null — never throws — when no lookup is wired in", async () => {
    writeSandboxSession("sess-1");
    const reader = new SessionReader(dir, "sandbox");
    const meta = await reader.getSessionMeta("sess-1");
    // Null means "unfilterable", and the dashboard keeps such rows visible.
    expect(meta?.repo).toBeNull();
  });
});

describe("ChatSessionReader repo resolution", () => {
  it("sources the repo straight from executions.repo", async () => {
    db.executions.recordStart({
      id: "e1",
      triggerType: "slack",
      triggerId: "thread-1",
      skill: "chat",
      repo: "nearform/lastlight",
      issueNumber: null as unknown as number,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    const reader = new ChatSessionReader(db, dir);
    const meta = await reader.getSessionMeta("thread-1");
    expect(meta?.repo).toBe("nearform/lastlight");
  });

  it("leaves a repo-less thread null so it is never filtered out", async () => {
    db.executions.recordStart({
      id: "e1",
      triggerType: "slack",
      triggerId: "thread-1",
      skill: "chat",
      repo: null as unknown as string,
      issueNumber: null as unknown as number,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    const reader = new ChatSessionReader(db, dir);
    const meta = await reader.getSessionMeta("thread-1");
    expect(meta?.repo).toBeNull();
  });
});
