import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findTokenLeak, redactInSandbox, scanTreeForToken } from "#src/engine/claude-code/leak-scan.js";

const TOKEN = "sk-ant-oat01-ABCDEFGHIJKLMNOPQRSTUVWXYZ";

describe("findTokenLeak", () => {
  it("names the first source holding the token or its first 24 characters", () => {
    expect(findTokenLeak(TOKEN, [{ name: "plan", text: "x sk-ant-oat01-ABCDEFGHIJKLMNOPQRST y" }])).toBe("plan");
    expect(findTokenLeak(TOKEN, [{ name: "a", text: "clean" }, { name: "diff", text: `+${TOKEN}` }])).toBe("diff");
  });

  it("finds the token JSON-escaped or base64-encoded", () => {
    expect(findTokenLeak(TOKEN, [{ name: "j", text: JSON.stringify({ t: TOKEN }) }])).toBe("j");
    expect(findTokenLeak(TOKEN, [{ name: "b64", text: Buffer.from(TOKEN).toString("base64") }])).toBe("b64");
  });

  it("returns null for clean sources or no token", () => {
    expect(findTokenLeak(TOKEN, [{ name: "plan", text: "sk-ant-oat01- is the prefix shape" }])).toBeNull();
    expect(findTokenLeak("", [{ name: "plan", text: "anything" }])).toBeNull();
  });
});

describe("scanTreeForToken", () => {
  function tree() {
    const dir = mkdtempSync(join(tmpdir(), "leak-tree-"));
    mkdirSync(join(dir, "repo", "src"), { recursive: true });
    mkdirSync(join(dir, "repo", ".git"), { recursive: true });
    mkdirSync(join(dir, "repo", "node_modules", "x"), { recursive: true });
    mkdirSync(join(dir, ".lastlight", "issue-7"), { recursive: true });
    writeFileSync(join(dir, "repo", "src", "clean.ts"), "export const a = 1;\n");
    return dir;
  }

  it("finds the token in any regular file of the workspace, notes included", () => {
    const dir = tree();
    writeFileSync(join(dir, "repo", "src", "leak.ts"), `const t = "${TOKEN}";`);
    writeFileSync(join(dir, ".lastlight", "issue-7", "architect-plan.md"), `token: ${TOKEN}`);
    expect(scanTreeForToken(dir, TOKEN).hits.sort()).toEqual([".lastlight/issue-7/architect-plan.md", "repo/src/leak.ts"]);
  });

  it("skips .git and node_modules, and never follows a link", () => {
    const dir = tree();
    writeFileSync(join(dir, "repo", ".git", "x"), TOKEN);
    writeFileSync(join(dir, "repo", "node_modules", "x", "y.js"), TOKEN);
    const outside = mkdtempSync(join(tmpdir(), "leak-outside-"));
    writeFileSync(join(outside, "secret"), TOKEN);
    symlinkSync(join(outside, "secret"), join(dir, "repo", "src", "link"));
    expect(scanTreeForToken(dir, TOKEN).hits).toEqual([]);
  });

  it("finds the token at the end of a file larger than one read", () => {
    const dir = tree();
    writeFileSync(join(dir, "repo", "big.log"), Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 120), Buffer.from(TOKEN)]));
    expect(scanTreeForToken(dir, TOKEN).hits).toEqual(["repo/big.log"]);
  });

  it("finds a token split across two reads", () => {
    const dir = tree();
    const chunk = 1024 * 1024;
    writeFileSync(join(dir, "repo", "split.bin"), Buffer.concat([Buffer.alloc(chunk - 10, 120), Buffer.from(TOKEN)]));
    expect(scanTreeForToken(dir, TOKEN).hits).toEqual(["repo/split.bin"]);
  });

  it("reports an incomplete scan when the file cap is hit, rather than clean", () => {
    const dir = tree();
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, "repo", `f${i}.txt`), "x");
    expect(scanTreeForToken(dir, TOKEN, { maxFiles: 3 }).incomplete).toBe(true);
    expect(scanTreeForToken(dir, TOKEN).incomplete).toBe(false);
  });

  it("reports an incomplete scan past the byte budget, without reading the rest", () => {
    const dir = tree();
    writeFileSync(join(dir, "repo", "a.bin"), Buffer.alloc(4096, 120));
    expect(scanTreeForToken(dir, TOKEN, { maxTotalBytes: 1024 }).incomplete).toBe(true);
  });
});

describe("redactInSandbox", () => {
  it("overwrites the files from inside the sandbox, never through a host path", async () => {
    const exec = vi.fn(async () => ({ code: 0, stdout: "", stderr: "" }));
    await redactInSandbox({ exec, stream: vi.fn() } as never, "/home/agent/workspace", ["repo/.env", "-odd name"]);
    expect(exec).toHaveBeenCalledTimes(1);
    const [argv, opts] = exec.mock.calls[0]! as unknown as [string[], { cwd: string }];
    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    expect(argv.slice(-2)).toEqual(["./repo/.env", "./-odd name"]);
    expect(argv[2]).toContain("[ -L");
    expect(opts.cwd).toBe("/home/agent/workspace");
  });
});
