/**
 * Issue #503: on the gondolin backend the egress allowlist must reach
 * agentic-pi as apex + `*.` patterns, because gondolin matches hostnames
 * exactly. Bare hosts alone let `crates.io` through but block
 * `index.crates.io`, `registry.npmjs.org`, …
 *
 * agentic-pi is mocked so `run` captures its options and stops; the VM never
 * boots.
 */
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach } from "vitest";

const runSpy = vi.fn();

vi.mock("agentic-pi", () => ({
  run: (opts: unknown) => {
    runSpy(opts);
    throw new Error("gondolin-egress test: stop after capturing run options");
  },
}));

const { executeAgent } = await import("#src/engine/agent-executor.js");

function dirs() {
  const stateDir = mkdtempSync(join(tmpdir(), "ll-gondolin-egress-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  return { stateDir, sessionsDir };
}

describe("gondolin egress patterns reach agentic-pi", () => {
  beforeEach(() => runSpy.mockClear());

  it("passes apex + subdomain patterns for the default allowlist", async () => {
    await executeAgent("noop prompt", { sandbox: "gondolin", ...dirs() });

    expect(runSpy).toHaveBeenCalledTimes(1);
    const hosts = runSpy.mock.calls[0][0].allowedHttpHosts as string[];
    expect(hosts).toEqual(expect.arrayContaining(["crates.io", "*.crates.io", "npmjs.org", "*.npmjs.org"]));
  });

  it("keeps the allow-all sentinel as is for unrestricted egress", async () => {
    await executeAgent("noop prompt", { sandbox: "gondolin", unrestrictedEgress: true, ...dirs() });

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(runSpy.mock.calls[0][0].allowedHttpHosts).toEqual(["*"]);
  });
});
