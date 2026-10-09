import { describe, it, expect, afterEach } from "vitest";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import {
  startArgv,
  stopArgv,
  restartArgv,
  buildArgv,
  buildSandboxArgv,
  buildQaArgv,
  upArgv,
  restartSidecarsArgv,
  parseLsRemoteSha,
  resolveImageTag,
  tagsToPrune,
  KEEP_IMAGE_VERSIONS,
  IMAGE_REGISTRY,
  PUBLISHED_IMAGES,
  SIDECARS,
} from "../src/cli-server.js";

describe("cli-server argv builders", () => {
  it("start: whole stack vs one service", () => {
    expect(startArgv()).toEqual(["up", "-d"]);
    expect(startArgv("caddy")).toEqual(["up", "-d", "caddy"]);
  });

  it("stop: down for the stack, stop for a service", () => {
    expect(stopArgv()).toEqual(["down"]);
    expect(stopArgv("agent")).toEqual(["stop", "agent"]);
  });

  it("restart: defaults to agent", () => {
    expect(restartArgv()).toEqual(["restart", "agent"]);
    expect(restartArgv("caddy")).toEqual(["restart", "caddy"]);
  });

  it("build wave 1: agent + shared sandbox-base, stamps GIT_SHA when present", () => {
    // sandbox-base is built here (wave 1); the leaf sandbox images that are
    // FROM it build in later waves, so a single parallel `compose build` can't
    // race the base.
    expect(buildArgv("abc123")).toEqual([
      "build", "agent", "sandbox-base", "--build-arg", "GIT_SHA=abc123",
    ]);
    expect(buildArgv("")).toEqual(["build", "agent", "sandbox-base"]);
  });

  it("build wave 2: lean sandbox (FROM the shared base)", () => {
    expect(buildSandboxArgv()).toEqual(["build", "sandbox"]);
  });

  it("build wave 3: browser-QA sandbox (FROM the shared base, non-fatal)", () => {
    expect(buildQaArgv()).toEqual(["build", "sandbox-qa"]);
  });

  it("up: recreates with --remove-orphans (matches deploy.sh)", () => {
    expect(upArgv()).toEqual(["up", "-d", "--remove-orphans"]);
  });

  it("restart sidecars: all egress + collector services", () => {
    expect(restartSidecarsArgv()).toEqual(["restart", ...SIDECARS]);
    expect(SIDECARS).toContain("coredns-strict");
    expect(SIDECARS).toContain("otel-collector");
  });
});

describe("resolveImageTag", () => {
  const prevEnv = process.env.LASTLIGHT_CORE_VERSION;
  afterEach(() => {
    if (prevEnv === undefined) delete process.env.LASTLIGHT_CORE_VERSION;
    else process.env.LASTLIGHT_CORE_VERSION = prevEnv;
  });

  it("falls back to `latest` when the overlay declares no pin", () => {
    delete process.env.LASTLIGHT_CORE_VERSION;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-noinstance-"));
    // No config.yaml → unpinned → latest.
    expect(resolveImageTag(dir)).toBe("latest");
  });

  it("uses the overlay's deploy.version pin as the image tag", () => {
    delete process.env.LASTLIGHT_CORE_VERSION;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-pin-"));
    fs.writeFileSync(path.join(dir, "config.yaml"), "deploy:\n  version: v0.11.0\n");
    expect(resolveImageTag(dir)).toBe("v0.11.0");
  });

  it("LASTLIGHT_CORE_VERSION overrides the file", () => {
    process.env.LASTLIGHT_CORE_VERSION = "v9.9.9";
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ll-envpin-"));
    fs.writeFileSync(path.join(dir, "config.yaml"), "deploy:\n  version: v0.11.0\n");
    expect(resolveImageTag(dir)).toBe("v9.9.9");
  });
});

describe("PUBLISHED_IMAGES", () => {
  it("re-tags each GHCR repo to the LOCAL name compose + the harness expect", () => {
    const byRepo = Object.fromEntries(PUBLISHED_IMAGES.map((i) => [i.repo, i.localTag]));
    // The harness spawns sandboxes by these fixed names (src/sandbox/images.ts);
    // compose references `lastlight-agent`. A pull must land under exactly these.
    expect(byRepo["lastlight-agent"]).toBe("lastlight-agent");
    expect(byRepo["lastlight-sandbox"]).toBe("lastlight-sandbox:latest");
    expect(byRepo["lastlight-sandbox-qa"]).toBe("lastlight-sandbox-qa:latest");
    // Only sandbox-qa is optional (browser tier).
    expect(PUBLISHED_IMAGES.find((i) => i.repo === "lastlight-sandbox-qa")?.optional).toBe(true);
    expect(PUBLISHED_IMAGES.find((i) => i.repo === "lastlight-agent")?.optional).toBeUndefined();
    expect(IMAGE_REGISTRY).toBe("ghcr.io/nearform");
  });
});

describe("tagsToPrune", () => {
  it("keeps the newest KEEP_IMAGE_VERSIONS versions, drops older ones (numeric sort)", () => {
    // v0.12.8 must outrank v0.12.5 but rank below v0.13.0 — numeric, not lexical.
    const tags = ["v0.13.0", "v0.12.5", "v0.16.0", "v0.12.8", "v0.15.0", "v0.14.0"];
    expect(KEEP_IMAGE_VERSIONS).toBe(2);
    expect(tagsToPrune(tags, "v0.16.0")).toEqual(
      expect.arrayContaining(["v0.14.0", "v0.13.0", "v0.12.8", "v0.12.5"]),
    );
    // Newest two survive.
    expect(tagsToPrune(tags, "v0.16.0")).not.toContain("v0.16.0");
    expect(tagsToPrune(tags, "v0.16.0")).not.toContain("v0.15.0");
  });

  it("never prunes the deployed tag even when it isn't in the newest window", () => {
    const tags = ["v0.16.0", "v0.15.0", "v0.14.0", "v0.13.0"];
    // Pinned rollback to an older version → keep newest two AND the deployed one.
    const removed = tagsToPrune(tags, "v0.13.0");
    expect(removed).not.toContain("v0.13.0");
    expect(removed).toContain("v0.14.0");
  });

  it("drops a stale `latest` once the deploy is pinned to a version", () => {
    // A pinned update never pulls `latest` again, so it is never superseded.
    expect(tagsToPrune(["latest", "v0.16.0", "v0.15.0"], "v0.16.0")).toEqual(["latest"]);
  });

  it("keeps `latest` on an unpinned deploy, and never touches other floating tags", () => {
    expect(tagsToPrune(["latest", "main", "edge"], "latest")).toEqual([]);
    expect(tagsToPrune(["main", "edge", "v0.16.0"], "v0.16.0")).toEqual([]);
  });

  it("keep = 1 leaves only the deployed version", () => {
    expect(tagsToPrune(["v0.16.0", "v0.15.0", "latest"], "v0.16.0", 1)).toEqual(["v0.15.0", "latest"]);
  });

  it("removes nothing when at or below the retention window", () => {
    expect(tagsToPrune(["v0.16.0"], "v0.16.0")).toEqual([]);
    expect(tagsToPrune(["v0.16.0", "v0.15.0"], "v0.16.0")).toEqual([]);
  });
});

describe("parseLsRemoteSha", () => {
  it("extracts the leading SHA", () => {
    expect(parseLsRemoteSha("9c2eabcde1234567890\tHEAD")).toBe("9c2eabcde1234567890");
  });
  it("returns null for junk / empty", () => {
    expect(parseLsRemoteSha("")).toBeNull();
    expect(parseLsRemoteSha("not-a-sha\tHEAD")).toBeNull();
  });
});
