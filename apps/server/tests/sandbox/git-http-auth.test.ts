import { describe, it, expect } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  GITHUB_EXTRAHEADER_KEY,
  githubBasicAuthB64,
  githubExtraheaderArgs,
  githubExtraheaderValue,
} from "#src/sandbox/git-http-auth.js";
import { agentGitIdentityEnv } from "#src/sandbox/sandbox.js";

const WEIRD = "ghs_weird.tok/en+v=";

describe("git-http-auth helpers", () => {
  it("base64-encodes x-access-token:<token>, tolerating URL-unsafe charsets", () => {
    const b64 = githubBasicAuthB64(WEIRD);
    expect(Buffer.from(b64, "base64").toString("utf8")).toBe(`x-access-token:${WEIRD}`);
    expect(githubExtraheaderValue(WEIRD)).toBe(`AUTHORIZATION: basic ${b64}`);
  });

  it("emits a one-shot `-c http.<url>.extraheader=…` arg pair", () => {
    expect(githubExtraheaderArgs(WEIRD)).toEqual([
      "-c",
      `${GITHUB_EXTRAHEADER_KEY}=AUTHORIZATION: basic ${githubBasicAuthB64(WEIRD)}`,
    ]);
  });
});

describe("agentGitIdentityEnv", () => {
  it("keeps COUNT=1 + safe.directory when no token is passed", () => {
    const env = agentGitIdentityEnv("last-light[bot]");
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_VALUE_0).toBe("*");
    expect(env.GIT_CONFIG_KEY_1).toBeUndefined();
  });

  it("adds a github.com-scoped extraheader (COUNT=2) tolerating a weird token", () => {
    const env = agentGitIdentityEnv("last-light[bot]", WEIRD);
    expect(env.GIT_CONFIG_COUNT).toBe("2");
    expect(env.GIT_CONFIG_KEY_0).toBe("safe.directory");
    expect(env.GIT_CONFIG_KEY_1).toBe(GITHUB_EXTRAHEADER_KEY);
    expect(Buffer.from(env.GIT_CONFIG_VALUE_1.replace(/^AUTHORIZATION: basic /, ""), "base64").toString("utf8"))
      .toBe(`x-access-token:${WEIRD}`);
  });

  it("git resolves the extraheader for github.com only (scoped, not sent elsewhere)", () => {
    const env = { ...process.env, ...agentGitIdentityEnv("last-light[bot]", WEIRD) };
    const dir = mkdtempSync(join(tmpdir(), "ll-gitauth-"));
    try {
      execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
      const gh = execFileSync(
        "git",
        ["-C", dir, "config", "--get-urlmatch", "http.extraheader", "https://github.com/o/r.git"],
        { env, encoding: "utf8" },
      ).trim();
      expect(gh).toBe(githubExtraheaderValue(WEIRD));

      let other = "";
      try {
        other = execFileSync(
          "git",
          ["-C", dir, "config", "--get-urlmatch", "http.extraheader", "https://registry.npmjs.org/x"],
          { env, encoding: "utf8", stdio: "pipe" },
        ).trim();
      } catch (err) {
        expect((err as { status?: number }).status).toBe(1);
      }
      expect(other).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
