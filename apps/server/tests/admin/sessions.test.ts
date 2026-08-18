import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionReader } from "#src/admin/sessions.js";

/**
 * Regression coverage for the sandbox "Sessions" tab silently hiding the
 * newest sessions. The list handler slices `listSessionIds()` to a
 * `limit * 2` window BEFORE loading + date-sorting each session's meta, so
 * `listSessionIds()` must return ids newest-first (by mtime). When it
 * returned raw readdir order, today's runs — written to repo-suffixed
 * project dirs read after a large generic dir — fell outside the window and
 * never appeared until "Load more" pushed the limit past the backlog.
 */
describe("SessionReader.listSessionIds ordering", () => {
  let home: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "ll-sessions-"));
    fs.mkdirSync(path.join(home, "projects"), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  /** Create a session jsonl in `projectDir` and stamp its mtime. */
  function writeSession(projectDir: string, id: string, mtimeMs: number): void {
    const dir = path.join(home, "projects", projectDir);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, JSON.stringify({ type: "user", message: { role: "user", content: id } }) + "\n");
    const t = new Date(mtimeMs);
    fs.utimesSync(file, t, t);
  }

  it("returns ids newest-first by mtime across project dirs", async () => {
    // An old session in the big generic dir, and a newer one in a
    // repo-suffixed dir — the exact shape that used to hide today's runs.
    writeSession("-home-agent-workspace", "old-session", 1_000_000);
    writeSession("-home-agent-workspace-lastlight", "new-session", 9_000_000);
    writeSession("-home-agent-workspace", "mid-session", 5_000_000);

    const reader = new SessionReader(home, "sandbox");
    expect(await reader.listSessionIds()).toEqual(["new-session", "mid-session", "old-session"]);
  });

  it("keeps the newest session inside a limit*2 window (handler slice semantics)", async () => {
    // 60 old sessions in the generic dir + 1 fresh session in a repo dir.
    for (let i = 0; i < 60; i++) {
      writeSession("-home-agent-workspace", `old-${String(i).padStart(3, "0")}`, 1_000_000 + i);
    }
    writeSession("-home-agent-workspace-lastlight", "todays-run", 9_000_000);

    const reader = new SessionReader(home, "sandbox");
    const limit = 25; // window = 50, smaller than the 61-session backlog
    const windowed = (await reader.listSessionIds()).slice(0, limit * 2);
    expect(windowed).toContain("todays-run");
    expect(windowed[0]).toBe("todays-run");
  });

  it("uses file mtime (not now) as started_at for an empty/timestamp-less file", async () => {
    const mtime = 1_700_000_000_000; // fixed past instant
    writeSession("-home-agent-workspace", "empty-run", mtime);
    // Zero it out so there are no parseable timestamps inside.
    const file = path.join(home, "projects", "-home-agent-workspace", "empty-run.jsonl");
    fs.writeFileSync(file, "");
    const t = new Date(mtime);
    fs.utimesSync(file, t, t);

    const reader = new SessionReader(home, "sandbox");
    const meta = await reader.getSessionMeta("empty-run");
    expect(meta).not.toBeNull();
    // started_at should track the real mtime, not Date.now()
    expect(meta!.started_at).toBeCloseTo(mtime / 1000, 0);
    expect(meta!.message_count).toBe(0);
  });

  it("excludes the -app (chat) project dir under the sandbox scope", async () => {
    writeSession("-app", "chat-session", 9_000_000);
    writeSession("-home-agent-workspace", "sandbox-session", 1_000_000);

    const reader = new SessionReader(home, "sandbox");
    const ids = await reader.listSessionIds();
    expect(ids).toContain("sandbox-session");
    expect(ids).not.toContain("chat-session");
  });
});
