/**
 * AGENTS.md delivery — one composition, two backends (issue #180).
 *
 * `tests/engine/orchestrator.test.ts` already pins WHERE the file lands (host
 * workspace vs nothing on kubernetes). This file pins WHAT lands there: the
 * agent context the RUNNER composed for this run — the only value that carries
 * the target repo's additive `agent-context/*.md` — with the module-level
 * composition as the fallback when no repo layer applied.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeAgent } from "#src/engine/agent-executor.js";
import { FakeSandbox, type SandboxEvent } from "#src/sandbox/sandbox.js";
import { configureWorkflowAssets, loadAgentContext } from "#src/workflows/loader.js";
import type { AgentContextSink } from "#src/engine/github/profiles.js";

/** Minimal successful stream — the `session` event fires from inside
 *  `runAgent`, i.e. while the fake workspace still exists. */
function successEvents(): SandboxEvent[] {
  return [
    { type: "session", id: "sess-ctx" },
    { type: "agent_end", messages: [] },
  ];
}

/** A FakeSandbox that also implements the kubernetes-style delivery sink. */
class SinkSandbox extends FakeSandbox implements AgentContextSink {
  received?: string;
  setAgentContext(text: string): void {
    this.received = text;
  }
}

describe("agent-context delivery", () => {
  let stateDir: string;
  let sessionsDir: string;
  let contextRoot: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ll-ctx-delivery-"));
    sessionsDir = join(stateDir, "agent-sessions");
    contextRoot = mkdtempSync(join(tmpdir(), "ll-ctx-operator-"));
    mkdirSync(join(contextRoot, "agent-context"), { recursive: true });
    writeFileSync(join(contextRoot, "agent-context", "security.md"), "OPERATOR SECURITY RULES");
    configureWorkflowAssets({ builtInRoot: contextRoot });
  });

  afterEach(() => {
    configureWorkflowAssets();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(contextRoot, { recursive: true, force: true });
  });

  /** Run one agent turn and capture `AGENTS.md` while the workspace is live
   *  (`dispose()` removes the fake host dir the moment the run returns). */
  async function agentsMdDuringRun(
    fake: FakeSandbox,
    config: Parameters<typeof executeAgent>[1],
  ): Promise<string | undefined> {
    let seen: string | undefined;
    await executeAgent("do the thing", { stateDir, sessionsDir, ...config }, {
      sandboxFactory: fake.asFactory(),
      onSessionId: () => {
        const path = join(fake.hostWorkspaceDir, "AGENTS.md");
        seen = existsSync(path) ? readFileSync(path, "utf8") : undefined;
      },
    });
    return seen;
  }

  it("writes the run's own composed context, not a re-composition of the global layers", async () => {
    const composed = "OPERATOR SECURITY RULES\n\n---\n\nREPO CONVENTIONS";
    const fake = new FakeSandbox({ events: successEvents() });

    const written = await agentsMdDuringRun(fake, { sandbox: "none", agentContext: composed });

    expect(written).toBe(composed);
    expect(written).toContain("REPO CONVENTIONS");
  });

  it("falls back to the module-level composition when the run supplied none", async () => {
    const fake = new FakeSandbox({ events: successEvents() });

    const written = await agentsMdDuringRun(fake, { sandbox: "none" });

    // Byte-identical to what every run wrote before the seam existed.
    expect(written).toBe(loadAgentContext());
    expect(written).toBe("OPERATOR SECURITY RULES");
  });

  it("hands the same text to a kubernetes adapter's sink instead of writing it", async () => {
    const composed = "OPERATOR SECURITY RULES\n\n---\n\nREPO CONVENTIONS";
    const fake = new SinkSandbox({ events: successEvents() });

    const written = await agentsMdDuringRun(fake, { sandbox: "kubernetes", agentContext: composed });

    // Same bytes as the host path above — the two backends can't drift.
    expect(fake.received).toBe(composed);
    // …and no host write: on a real cluster `hostWorkspaceDir` is an in-pod path.
    expect(written).toBeUndefined();
  });

  it("offers the fallback composition to the sink too, so k8s never re-composes", async () => {
    const fake = new SinkSandbox({ events: successEvents() });

    await agentsMdDuringRun(fake, { sandbox: "kubernetes" });

    expect(fake.received).toBe("OPERATOR SECURITY RULES");
  });
});
