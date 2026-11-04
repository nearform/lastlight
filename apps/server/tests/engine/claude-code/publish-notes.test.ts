import { describe, it, expect, vi } from "vitest";
import { linkSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { join } from "path";
import { tmpdir } from "os";
import { NotesSecretError, openNoteUnder, publishClaudeNotes, readNotesDir, type NotesGitHub } from "#src/engine/claude-code/publish-notes.js";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  mkdirSync(join(dir, ".lastlight", "issue-7"), { recursive: true });
  return dir;
}

function fakeGh(tip: string | null = "tip-sha"): NotesGitHub & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    getBranchTip: vi.fn(async () => {
      calls.push("getBranchTip");
      return tip;
    }),
    getDefaultBranchTip: vi.fn(async () => {
      calls.push("getDefaultBranchTip");
      return "default-sha";
    }),
    createBranchAt: vi.fn(async () => {
      calls.push("createBranchAt");
    }),
    publishSignedCommit: vi.fn(async () => {
      calls.push("publishSignedCommit");
      return { oid: "new-oid" };
    }),
  };
}

describe("readNotesDir", () => {
  it("reads regular files as repo-relative paths", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".lastlight", "issue-7", "architect-plan.md"), "# Plan");
    const { files, refused } = await readNotesDir(ws);
    expect(files.map((f) => [f.path, f.contents.toString()])).toEqual([[".lastlight/issue-7/architect-plan.md", "# Plan"]]);
    expect(refused).toEqual([]);
  });

  it("refuses links and odd files, still reading the regular ones", async () => {
    const ws = workspace();
    const d = join(ws, ".lastlight", "issue-7");
    writeFileSync(join(d, "status.md"), "ok");
    symlinkSync("/etc/passwd", join(d, "passwd.md"));
    writeFileSync(join(ws, "outside.txt"), "x");
    linkSync(join(ws, "outside.txt"), join(d, "hard.md"));
    execFileSync("mkfifo", [join(d, "pipe")]);
    const { files, refused } = await readNotesDir(ws);
    expect(files.map((f) => f.path)).toEqual([".lastlight/issue-7/status.md"]);
    expect(Object.fromEntries(refused.map((r) => [r.path, r.reason]))).toEqual({
      ".lastlight/issue-7/passwd.md": "symlink",
      ".lastlight/issue-7/hard.md": "hardlink",
      ".lastlight/issue-7/pipe": "not_regular",
    });
  });

  it("refuses a .lastlight that is itself a link", async () => {
    const ws = mkdtempSync(join(tmpdir(), "notes-"));
    const elsewhere = mkdtempSync(join(tmpdir(), "elsewhere-"));
    writeFileSync(join(elsewhere, "x.md"), "x");
    symlinkSync(elsewhere, join(ws, ".lastlight"));
    const { files, refused } = await readNotesDir(ws);
    expect(files).toEqual([]);
    expect(refused).toEqual([{ path: ".lastlight", reason: "symlink" }]);
  });

  it("never reads a file reached through a directory swapped for a link after the walk saw it", () => {
    const ws = workspace();
    const outside = mkdtempSync(join(tmpdir(), "outside-"));
    writeFileSync(join(outside, "app-key.pem"), "PRIVATE");
    symlinkSync(outside, join(ws, ".lastlight", "swapped"));
    const root = realpathSync(join(ws, ".lastlight"));
    expect(openNoteUnder(join(ws, ".lastlight", "swapped", "app-key.pem"), root, 1024)).toBeNull();
    writeFileSync(join(ws, ".lastlight", "issue-7", "ok.md"), "ok");
    expect(openNoteUnder(join(ws, ".lastlight", "issue-7", "ok.md"), root, 1024)?.toString()).toBe("ok");
  });

  it("caps size and count", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".lastlight", "issue-7", "big.md"), Buffer.alloc(2 * 1024 * 1024));
    expect((await readNotesDir(ws)).refused).toEqual([{ path: ".lastlight/issue-7/big.md", reason: "too_large" }]);
    const ws2 = workspace();
    for (let i = 0; i < 51; i++) writeFileSync(join(ws2, ".lastlight", "issue-7", `n${i}.md`), "x");
    const r = await readNotesDir(ws2);
    expect(r.files).toEqual([]);
    expect(r.refused).toEqual([{ path: ".lastlight", reason: "too_many" }]);
  });
});

describe("publishClaudeNotes", () => {
  const base = { owner: "acme", repo: "widget", branch: "lastlight/7-x", message: "docs(lastlight): architect notes" };

  it("publishes the notes as one signed commit", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".lastlight", "issue-7", "architect-plan.md"), "# Plan");
    writeFileSync(join(ws, ".lastlight", "issue-7", "status.md"), "planned");
    const gh = fakeGh();
    const out = await publishClaudeNotes({ ...base, gh, workspace: ws });
    expect(out).toEqual({ published: true, oid: "new-oid", refused: [] });
    expect(gh.publishSignedCommit).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widget",
      branch: "lastlight/7-x",
      expectedHeadOid: "tip-sha",
      headline: "docs(lastlight): architect notes",
      additions: [
        { path: ".lastlight/issue-7/architect-plan.md", contents: Buffer.from("# Plan").toString("base64") },
        { path: ".lastlight/issue-7/status.md", contents: Buffer.from("planned").toString("base64") },
      ],
      deletions: [],
    });
  });

  it("creates the branch from the default branch when missing", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".lastlight", "issue-7", "architect-plan.md"), "# Plan");
    const gh = fakeGh(null);
    await publishClaudeNotes({ ...base, gh, workspace: ws });
    expect(gh.calls).toEqual(["getBranchTip", "getDefaultBranchTip", "createBranchAt", "publishSignedCommit"]);
    expect(gh.createBranchAt).toHaveBeenCalledWith("acme", "widget", "lastlight/7-x", "default-sha");
    expect(vi.mocked(gh.publishSignedCommit).mock.calls[0]![0].expectedHeadOid).toBe("default-sha");
  });

  it("publishes nothing for an empty dir", async () => {
    const gh = fakeGh();
    expect(await publishClaudeNotes({ ...base, gh, workspace: workspace() })).toEqual({ published: false, refused: [] });
    expect(gh.calls).toEqual([]);
  });

  it("refuses to publish a note holding the secret, checked on the bytes it would send", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".lastlight", "issue-7", "ok.md"), "fine");
    writeFileSync(join(ws, ".lastlight", "issue-7", "env.md"), "TOKEN=sk-secret");
    const gh = fakeGh();
    await expect(
      publishClaudeNotes({ ...base, gh, workspace: ws, holdsSecret: (b) => b.includes("sk-secret") }),
    ).rejects.toThrow(NotesSecretError);
    expect(gh.calls).toEqual([]);
  });

  it("refuses a bot-owned branch", async () => {
    const ws = workspace();
    writeFileSync(join(ws, ".lastlight", "issue-7", "x.md"), "x");
    const gh = fakeGh();
    await expect(publishClaudeNotes({ ...base, branch: "renovate/x", gh, workspace: ws })).rejects.toThrow(/renovate\/x/);
    expect(gh.calls).toEqual([]);
  });

  it("runs no git: the module cannot start a process", async () => {
    const { readFileSync } = await import("fs");
    const src = readFileSync(join(import.meta.dirname, "../../../src/engine/claude-code/publish-notes.ts"), "utf8");
    expect(src).not.toMatch(/child_process|execa|\bspawn\(|\bexec(File)?(Sync)?\(/);
  });
});
