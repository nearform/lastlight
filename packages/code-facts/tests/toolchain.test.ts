/**
 * Binary resolution and the toolchain stamp — §D1's order and §D3's manifest.
 *
 * The resolution order (`LASTLIGHT_<TOOL>_BIN` → `PATH` → the baked
 * `/opt/lastlight/bin` path) is what lets the eval harness measure this
 * pipeline at all: it defaults to `--sandbox none`, rejects `docker`/`smol`,
 * and `gondolin` needs `/dev/kvm`, so **no eval configuration on a Mac can see
 * `/opt/lastlight/`**. Get the order wrong and every rung silently measures a
 * toolchain that is not there.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BAKED_BIN_DIR,
  bundledVersions,
  envVarFor,
  loadManifest,
  packageRoot,
  parseVersion,
  platformKey,
  resolveFactsBin,
  resolveToolBin,
  sourceFor,
  stampTool,
  toolchainStamp,
  PLATFORM_KEYS,
} from "../src/toolchain.js";

function fakeBin(name: string, body = "#!/bin/sh\necho 1.2.3\n"): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "ll-facts-tool-"));
  const bin = join(dir, name);
  writeFileSync(bin, body, "utf8");
  chmodSync(bin, 0o755);
  return { dir, bin };
}

describe("binary resolution order (§D1)", () => {
  it("prefers LASTLIGHT_<TOOL>_BIN over PATH", () => {
    const preferred = fakeBin("opengrep");
    const onPath = fakeBin("opengrep");
    try {
      const resolved = resolveToolBin("opengrep", {
        LASTLIGHT_OPENGREP_BIN: preferred.bin,
        PATH: onPath.dir,
      });
      expect(resolved).toBe(preferred.bin);
    } finally {
      rmSync(preferred.dir, { recursive: true, force: true });
      rmSync(onPath.dir, { recursive: true, force: true });
    }
  });

  it("falls back to PATH when the env var is unset", () => {
    const onPath = fakeBin("opengrep");
    try {
      expect(resolveToolBin("opengrep", { PATH: onPath.dir })).toBe(onPath.bin);
    } finally {
      rmSync(onPath.dir, { recursive: true, force: true });
    }
  });

  it("resolves nothing — rather than something else — when the env var points at a bad path", () => {
    const onPath = fakeBin("opengrep");
    try {
      // A pointer that is WRONG is a configuration error the operator wants to
      // see. Falling through to a different binary would hide it.
      expect(
        resolveToolBin("opengrep", {
          LASTLIGHT_OPENGREP_BIN: "/nonexistent/opengrep",
          PATH: onPath.dir,
        }),
      ).toBeNull();
    } finally {
      rmSync(onPath.dir, { recursive: true, force: true });
    }
  });

  it("returns null when nothing resolves, so `patterns` can degrade", () => {
    expect(resolveToolBin("opengrep", { PATH: "" })).toBeNull();
  });

  it("applies the same order to the facts CLI itself", () => {
    const preferred = fakeBin("lastlight-facts");
    try {
      expect(resolveFactsBin({ LASTLIGHT_FACTS_BIN: preferred.bin, PATH: "" })).toBe(preferred.bin);
      expect(resolveFactsBin({ PATH: preferred.dir })).toBe(preferred.bin);
      expect(resolveFactsBin({ PATH: "" })).toBeNull();
    } finally {
      rmSync(preferred.dir, { recursive: true, force: true });
    }
  });

  it("maps a hyphenated tool name onto a legal env var", () => {
    expect(envVarFor("opengrep")).toBe("LASTLIGHT_OPENGREP_BIN");
    expect(envVarFor("ast-grep")).toBe("LASTLIGHT_AST_GREP_BIN");
    expect(envVarFor("lastlight-facts")).toBe("LASTLIGHT_LASTLIGHT_FACTS_BIN");
  });

  it("keeps the baked image path as the last resort", () => {
    expect(BAKED_BIN_DIR).toBe("/opt/lastlight/bin");
  });
});

describe("the manifest (§D3)", () => {
  it("pins every external binary the image installs, including the two that float today", () => {
    const manifest = loadManifest();
    expect(Object.keys(manifest.binaries).sort()).toEqual([
      "ast-grep",
      "gitleaks",
      "opengrep",
      "semgrep",
      "uv",
    ]);
    for (const [name, entry] of Object.entries(manifest.binaries)) {
      expect(entry.version, name).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.probe.length, name).toBeGreaterThan(0);
    }
  });

  it("keeps gitleaks at the version the image already pins, so WP2 is a refactor not a bump", () => {
    // sandbox-base.Dockerfile installs gitleaks v8.21.2 today.
    expect(loadManifest().binaries.gitleaks.version).toBe("8.21.2");
  });

  it("does NOT duplicate the npm-resolved engines — the lockfile is the stronger pin", () => {
    const raw = readFileSync(join(packageRoot(), "toolchain.json"), "utf8");
    expect(raw).not.toMatch(/"ts-morph"\s*:/);
    expect(raw).not.toMatch(/"@ast-grep\/napi"\s*:/);
  });

  it("stamps the bundled engine versions read off the INSTALLED packages", () => {
    const bundled = bundledVersions();
    const pkg = JSON.parse(readFileSync(join(packageRoot(), "package.json"), "utf8")) as {
      version: string;
      dependencies: Record<string, string>;
    };
    expect(bundled["ts-morph"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(bundled["@ast-grep/napi"]).toMatch(/^\d+\.\d+\.\d+/);
    expect(bundled["lastlight-code-facts"]).toBe(pkg.version);
  });

  it("stamps a resolved binary as ok / mismatch / missing", () => {
    const matching = fakeBin("gitleaks", "#!/bin/sh\necho 8.21.2\n");
    const drifted = fakeBin("gitleaks", "#!/bin/sh\necho 8.30.1\n");
    try {
      expect(stampTool("gitleaks", { LASTLIGHT_GITLEAKS_BIN: matching.bin })).toMatchObject({
        status: "ok",
        resolved: "8.21.2",
        expected: "8.21.2",
      });
      expect(stampTool("gitleaks", { LASTLIGHT_GITLEAKS_BIN: drifted.bin })).toMatchObject({
        status: "mismatch",
        resolved: "8.30.1",
      });
      expect(stampTool("gitleaks", { PATH: "" })).toMatchObject({ status: "missing" });
    } finally {
      rmSync(matching.dir, { recursive: true, force: true });
      rmSync(drifted.dir, { recursive: true, force: true });
    }
  });

  it("marks manifest binaries an extractor never needed as `unprobed`, not `missing`", () => {
    const stamp = toolchainStamp([], { PATH: "" });
    expect(stamp.binaries.opengrep.status).toBe("unprobed");
    expect(stamp.binaries.opengrep.expected).toBe(loadManifest().binaries.opengrep.version);
  });

  it("parses the version out of whatever the tool prints", () => {
    expect(parseVersion("1.27.1")).toBe("1.27.1");
    expect(parseVersion("opengrep version 1.27.1\n")).toBe("1.27.1");
    expect(parseVersion("v8.21.2")).toBe("8.21.2");
    expect(parseVersion("gitleaks 8.21.2-rc1")).toBe("8.21.2-rc1");
  });

  it("resolves the package root from the module, for both src/ and dist/ layouts", () => {
    const root = packageRoot();
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { name: string };
    expect(pkg.name).toBe("lastlight-code-facts");
    expect(root).toBe(fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, ""));
  });
});

/**
 * WS6 stage 0 — `sources` is per-platform.
 *
 * This is a manifest bug, not a platform limit, and the distinction is the
 * point: the third consumer of this file "refuses on a mismatch, printing the
 * commands to fix it", and on darwin it printed a `manylinux_x86` URL. Both
 * release streams DO publish a darwin-arm64 build at the pinned version —
 * verified against the GitHub releases, not guessed — and darwin-arm64 is where
 * the eval harness actually runs, because `--sandbox none` on a Mac cannot see
 * `/opt/lastlight/` at all.
 */
describe("per-platform sources (WS6 stage 0)", () => {
  it("carries every platform key for every binary", () => {
    for (const [name, entry] of Object.entries(loadManifest().binaries)) {
      expect(Object.keys(entry.sources).sort(), name).toEqual([...PLATFORM_KEYS].sort());
      for (const [key, url] of Object.entries(entry.sources)) {
        expect(url, `${name} ${key}`).not.toBe("");
      }
    }
  });

  it("bumps the manifest schema version, because `source` became `sources`", () => {
    expect(loadManifest().version).toBe(2);
  });

  it("resolves the REAL published asset for each host, darwin included", () => {
    // The exact asset names on the pinned releases. A guess here is the bug.
    expect(sourceFor("opengrep", "linux-x64")).toBe(
      "https://github.com/opengrep/opengrep/releases/download/v1.27.1/opengrep_manylinux_x86",
    );
    expect(sourceFor("opengrep", "darwin-arm64")).toBe(
      "https://github.com/opengrep/opengrep/releases/download/v1.27.1/opengrep_osx_arm64",
    );
    expect(sourceFor("gitleaks", "darwin-arm64")).toBe(
      "https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_darwin_arm64.tar.gz",
    );
    // The row that unbreaks an arm64 image build; sandbox-base.Dockerfile now
    // picks between these two on TARGETARCH.
    expect(sourceFor("gitleaks", "linux-arm64")).toBe(
      "https://github.com/gitleaks/gitleaks/releases/download/v8.21.2/gitleaks_8.21.2_linux_arm64.tar.gz",
    );
  });

  it("maps process.platform/arch onto a manifest key, and refuses the rest", () => {
    expect(platformKey("darwin", "arm64")).toBe("darwin-arm64");
    expect(platformKey("linux", "x64")).toBe("linux-x64");
    expect(platformKey("linux", "arm64")).toBe("linux-arm64");
    // `null` rather than a linux default: a wrong install command is worse than
    // an absent one, because the operator runs it and it half-works.
    expect(platformKey("win32", "x64")).toBeNull();
    expect(platformKey("linux", "ppc64")).toBeNull();
    expect(sourceFor("gitleaks", null)).toBeNull();
    expect(sourceFor("no-such-tool", "linux-x64")).toBeNull();
  });

  it("stamps WHICH BUILD resolved, on probed and unprobed entries alike", () => {
    const here = platformKey();
    const stamp = toolchainStamp(["gitleaks"], { PATH: "" });
    expect(stamp.binaries.gitleaks.platform).toBe(here);
    expect(stamp.binaries.opengrep.status).toBe("unprobed");
    // A scorecard measured on a Mac and one measured in the image are different
    // measurements, and nothing in the envelope used to say which.
    expect(stamp.binaries.opengrep.platform).toBe(here);
  });
});
