import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCorePin, pickTagCommit } from "@lastlight/shared/core-pin";

/** Make a throwaway overlay dir with the given config.yaml body (or none). */
function overlay(body?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "core-pin-"));
  dirs.push(dir);
  if (body !== undefined) writeFileSync(join(dir, "config.yaml"), body);
  return dir;
}

const dirs: string[] = [];
afterEach(() => {
  delete process.env.LASTLIGHT_CORE_VERSION;
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("readCorePin", () => {
  it("reads deploy.version from config.yaml", () => {
    expect(readCorePin(overlay("deploy:\n  version: v0.10.6\n"))).toBe("v0.10.6");
  });

  it("trims surrounding whitespace", () => {
    expect(readCorePin(overlay('deploy:\n  version: "  v1.2.3  "\n'))).toBe("v1.2.3");
  });

  it("treats an unset / null version as track-main (null)", () => {
    expect(readCorePin(overlay("deploy:\n  version: null\n"))).toBeNull();
    expect(readCorePin(overlay("deploy: {}\n"))).toBeNull();
    expect(readCorePin(overlay("managedRepos: []\n"))).toBeNull();
  });

  it("treats the sentinels main / latest as track-main (null)", () => {
    expect(readCorePin(overlay("deploy:\n  version: main\n"))).toBeNull();
    expect(readCorePin(overlay("deploy:\n  version: LATEST\n"))).toBeNull();
  });

  it("returns null for a missing / unreadable config.yaml (never throws)", () => {
    expect(readCorePin(overlay())).toBeNull();
    expect(readCorePin("/no/such/overlay/dir")).toBeNull();
  });

  it("LASTLIGHT_CORE_VERSION overrides the file", () => {
    process.env.LASTLIGHT_CORE_VERSION = "v2.0.0";
    expect(readCorePin(overlay("deploy:\n  version: v0.10.6\n"))).toBe("v2.0.0");
  });

  it("an env sentinel (main) falls through to the file", () => {
    process.env.LASTLIGHT_CORE_VERSION = "main";
    expect(readCorePin(overlay("deploy:\n  version: v0.10.6\n"))).toBe("v0.10.6");
  });
});

describe("pickTagCommit", () => {
  const pin = "v0.11.0";
  const tagObj = "d68ba9390b9ae0a672bb70bf8ef8244e6143c3b6";
  const commit = "def4a3ffde2934c15bffc3cfd0b6f79f7486d947";

  it("returns the peeled commit for an annotated tag (not the tag object)", () => {
    // Exactly what `git ls-remote origin refs/tags/v0.11.0*` emits.
    const out = `${tagObj}\trefs/tags/${pin}\n${commit}\trefs/tags/${pin}^{}`;
    expect(pickTagCommit(out, pin)).toBe(commit);
  });

  it("returns the tag SHA for a lightweight tag (no peeled row)", () => {
    const out = `${commit}\trefs/tags/${pin}`;
    expect(pickTagCommit(out, pin)).toBe(commit);
  });

  it("ignores sibling tags the glob also matched (v0.11.0 vs v0.11.0-rc1)", () => {
    const rc = "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111";
    const out =
      `${rc}\trefs/tags/${pin}-rc1\n` +
      `${tagObj}\trefs/tags/${pin}\n${commit}\trefs/tags/${pin}^{}`;
    expect(pickTagCommit(out, pin)).toBe(commit);
  });

  it("returns null for empty / junk output", () => {
    expect(pickTagCommit(null, pin)).toBeNull();
    expect(pickTagCommit("", pin)).toBeNull();
    expect(pickTagCommit("not-a-sha\trefs/tags/v0.11.0", pin)).toBeNull();
  });
});
