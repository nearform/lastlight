/**
 * `lastlight facts` — the CLI's edge to `lastlight-code-facts`.
 *
 * Two properties, both of which fail silently:
 *
 *  1. **The import must stay DYNAMIC.** `ts-morph` is ~14 MB of vendored
 *     compiler. A well-meaning refactor that hoists it to a static import makes
 *     every `lastlight login` pay for it, and nothing else would notice.
 *  2. **The CLI must not gain an edge to `lastlight-core`.** `code-facts` is a
 *     leaf with no workspace dependencies precisely so that adding it here
 *     cannot smuggle one in.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

describe("lastlight facts — wiring", () => {
  it("dispatches `facts` and does NOT statically import the analysis package", () => {
    const source = readFileSync(join(PACKAGE_ROOT, "src", "cli.ts"), "utf8");
    expect(source).toMatch(/case "facts": return cmdFacts\(\);/);
    // The only permitted form is the lazy one.
    expect(source).toMatch(/await import\("lastlight-code-facts"\)/);
    expect(source).not.toMatch(/^\s*import .*from "lastlight-code-facts"/m);
  });

  it("declares the dependency, and still has no edge to lastlight-core", () => {
    const pkg = JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkg.dependencies["lastlight-code-facts"]).toBe("workspace:*");
    expect(Object.keys(pkg.dependencies)).not.toContain("lastlight-core");
  });

  /**
   * End-to-end through the real bin, on a real two-commit repo: the analysis
   * layer is only useful if it is reachable from the command a phase or a human
   * actually types.
   */
  // 30 s, not the 5 s default: this spawns tsx and loads ts-morph's ~14 MB
  // vendored compiler in a child process. It finishes in under a second alone
  // and blows the default when `turbo run test` has every package running at
  // once — which reads as a flake rather than as a slow test.
  it("runs an extractor end-to-end from source and emits a valid envelope", { timeout: 60_000 }, () => {
    const repo = mkdtempSync(join(tmpdir(), "ll-cli-facts-"));
    const env = {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    };
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: repo, env, stdio: "pipe" });
    };
    try {
      git(["init", "-q", "-b", "main"]);
      git(["config", "user.email", "t@example.com"]);
      git(["config", "user.name", "t"]);
      mkdirSync(join(repo, "src"), { recursive: true });
      writeFileSync(join(repo, "src", "a.ts"), "export const LIMIT = 10;\n");
      writeFileSync(
        join(repo, "tsconfig.json"),
        JSON.stringify({ compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*"] }),
      );
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "base"]);
      writeFileSync(join(repo, "src", "a.ts"), "export const LIMIT = 25;\n");
      git(["add", "-A"]);
      git(["commit", "-q", "-m", "head"]);

      const stdout = execFileSync(
        process.execPath,
        [
          join(PACKAGE_ROOT, "node_modules", "tsx", "dist", "cli.mjs"),
          join(PACKAGE_ROOT, "src", "cli.ts"),
          "facts",
          "constants",
          "--repo",
          repo,
          "--base",
          "HEAD~1",
          "--head",
          "HEAD",
        ],
        { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
      );

      const document = JSON.parse(stdout) as {
        coverage: string;
        toolchain: { manifest: number };
        constants: { constant: string }[];
      };
      expect(document.coverage).toBe("full");
      expect(document.toolchain.manifest).toBe(1);
      expect(document.constants.map((c) => c.constant)).toContain("LIMIT");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
