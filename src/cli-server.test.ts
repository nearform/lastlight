import { describe, it, expect } from "vitest";
import {
  startArgv,
  stopArgv,
  restartArgv,
  buildArgv,
  upArgv,
  restartSidecarsArgv,
  parseLsRemoteSha,
  SIDECARS,
} from "./cli-server.js";

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

  it("build: stamps GIT_SHA when present, omits when empty", () => {
    expect(buildArgv("abc123")).toEqual(["build", "agent", "sandbox", "--build-arg", "GIT_SHA=abc123"]);
    expect(buildArgv("")).toEqual(["build", "agent", "sandbox"]);
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
