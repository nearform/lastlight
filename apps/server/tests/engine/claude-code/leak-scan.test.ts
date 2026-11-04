import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { findTokenLeak, redactTokenFiles, scanTreeForToken } from "#src/engine/claude-code/leak-scan.js";

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
    expect(scanTreeForToken(dir, TOKEN).sort()).toEqual([".lastlight/issue-7/architect-plan.md", "repo/src/leak.ts"]);
  });

  it("skips .git and node_modules, and never follows a link", () => {
    const dir = tree();
    writeFileSync(join(dir, "repo", ".git", "x"), TOKEN);
    writeFileSync(join(dir, "repo", "node_modules", "x", "y.js"), TOKEN);
    const outside = mkdtempSync(join(tmpdir(), "leak-outside-"));
    writeFileSync(join(outside, "secret"), TOKEN);
    symlinkSync(join(outside, "secret"), join(dir, "repo", "src", "link"));
    expect(scanTreeForToken(dir, TOKEN)).toEqual([]);
  });

  it("redacts the files it found, in place", () => {
    const dir = tree();
    writeFileSync(join(dir, ".lastlight", "issue-7", "architect-plan.md"), `token: ${TOKEN}`);
    redactTokenFiles(dir, [".lastlight/issue-7/architect-plan.md"]);
    expect(readFileSync(join(dir, ".lastlight", "issue-7", "architect-plan.md"), "utf8")).toBe(
      "[redacted: contained the Claude token]\n",
    );
  });
});
