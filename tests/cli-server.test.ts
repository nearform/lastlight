import { describe, it, expect } from "vitest";
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
  SIDECARS,
} from "#src/cli/cli-server.js";

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

describe("parseLsRemoteSha", () => {
  it("extracts the leading SHA", () => {
    expect(parseLsRemoteSha("9c2eabcde1234567890\tHEAD")).toBe("9c2eabcde1234567890");
  });
  it("returns null for junk / empty", () => {
    expect(parseLsRemoteSha("")).toBeNull();
    expect(parseLsRemoteSha("not-a-sha\tHEAD")).toBeNull();
  });
});
