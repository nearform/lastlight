import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import type { StateDb } from "#src/state/db.js";
import { executions } from "#src/state/schema/sqlite.js";
import { SessionReader } from "#src/admin/sessions.js";
import { ChatSessionReader } from "#src/admin/chat-session-reader.js";
import { makeTestDb } from "../helpers/state-db.js";

let db: StateDb;
let dir: string;

beforeEach(async () => {
  // `messaging_sessions` / `messaging_messages` are in the Drizzle baseline now
  // (SessionManager owns no DDL), so the migrated db already has the shape
  // `getChatThread`'s LEFT JOIN needs.
  db = await makeTestDb();
  dir = mkdtempSync(join(tmpdir(), "lastlight-session-repo-"));
});

afterEach(() => {
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
  it("resolves a session id to the repo its execution ran against", async () => {
    await db.executions.recordStart({
      id: "e1",
      triggerType: "webhook",
      triggerId: "t1",
      skill: "pr-review",
      repo: "nearform/lastlight",
      issueNumber: 7,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    await db.executions.recordSessionId("e1", "sess-1");
    expect(await db.executions.repoForSessionId("sess-1")).toBe("nearform/lastlight");
  });

  it("qualifies a BARE repo name from the row's own owner column", async () => {
    // The regression this exists for: `runSimpleWorkflow` carries `owner` and
    // `repo` separately, so EVERY phase execution of a workflow run stores the
    // bare name. Returning `lastlight` here would match nothing in an
    // `owner/repo` allow-list — and a non-null non-match HIDES the row, which
    // is the one outcome per-repo visibility must never produce.
    //
    // The account used to be fetched by joining the owning run. Since #279 the
    // ledger row carries its own `owner`, so this answers without the join —
    // which is what makes it work for a `build-cycle` or chat row too, neither
    // of which has a `workflow_run_id` to join through.
    await db.executions.recordStart({
      id: "e1",
      triggerType: "webhook",
      triggerId: "nearform/lastlight#7",
      skill: "pr-review:review",
      owner: "nearform",
      repo: "lastlight",
      issueNumber: 7,
      startedAt: "2026-08-06T10:00:00.000Z",
      workflowRunId: "run-1",
    });
    await db.executions.recordSessionId("e1", "sess-1");
    expect(await db.executions.repoForSessionId("sess-1")).toBe("nearform/lastlight");
  });

  it("splits a qualified repo handed to recordStart rather than storing a second shape", async () => {
    // The write choke point enforces (owner, BARE repo) — issue #279. The
    // dispatcher used to write the qualified string here.
    await db.executions.recordStart({
      id: "e1",
      triggerType: "webhook",
      triggerId: "3",
      skill: "build-cycle",
      repo: "nearform/lastlight",
      issueNumber: 3,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    await db.executions.recordSessionId("e1", "sess-1");

    const [row] = await db.client
      .select({ owner: executions.owner, repo: executions.repo })
      .from(executions)
      .where(eq(executions.id, "e1"));
    expect(row).toEqual({ owner: "nearform", repo: "lastlight" });
    expect(await db.executions.repoForSessionId("sess-1")).toBe("nearform/lastlight");
  });

  it("returns null — not a bare name — when there is no owner to qualify with", async () => {
    // Null reads as "no repo, always visible". A bare name would read as a
    // repo that is in nobody's allow-list.
    await db.executions.recordStart({
      id: "e1",
      triggerType: "webhook",
      triggerId: "t1",
      skill: "pr-review:review",
      repo: "lastlight",
      issueNumber: 7,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    await db.executions.recordSessionId("e1", "sess-1");
    expect(await db.executions.repoForSessionId("sess-1")).toBeNull();
  });

  it("returns null for a session with no execution row", async () => {
    expect(await db.executions.repoForSessionId("unknown")).toBeNull();
  });

  it("returns null when the execution carries no repo (a cron/Slack run)", async () => {
    await db.executions.recordStart({
      id: "e1",
      triggerType: "chat",
      triggerId: "t1",
      skill: "chat",
      repo: null as unknown as string,
      issueNumber: null as unknown as number,
      startedAt: "2026-08-06T10:00:00.000Z",
    });
    await db.executions.recordSessionId("e1", "sess-1");
    expect(await db.executions.repoForSessionId("sess-1")).toBeNull();
  });
});

describe("SessionReader repo resolution", () => {
  it("carries the repo from the executions join onto SessionMeta", async () => {
    writeSandboxSession("sess-1");
    const reader = new SessionReader(dir, "sandbox", async () => "nearform/lastlight");
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
    await db.executions.recordStart({
      id: "e1",
      triggerType: "chat",
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
    await db.executions.recordStart({
      id: "e1",
      triggerType: "chat",
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
