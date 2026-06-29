/**
 * Orchestration coverage via the {@link FakeSandbox} adapter.
 *
 * Before the Sandbox port existed, the ~300 lines of skill-staging /
 * artifact-harvest / event-loop / fallback orchestration only ran under the
 * `RUN_SANDBOX_IT` / `RUN_SMOL_IT` integration tests, which skip by default —
 * so `npm test` never exercised them. The FakeSandbox replays canned pi events
 * through the real orchestrator, so these flows now run in CI without Docker or
 * a VM.
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { FakeSandbox, type SandboxEvent } from "#src/sandbox/sandbox.js";

/** Poll a predicate for up to `timeoutMs` — the agent-path shim flushes its
 * jsonl fire-and-forget (`void shim.flush()`), so the write lands just after
 * executeAgent resolves. */
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return pred();
}

/** A canned event stream for a successful agent run (text answer + agent_end). */
function successEvents(sessionId = "sess-fake"): SandboxEvent[] {
  return [
    { type: "session", id: sessionId },
    {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "done" }],
        usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
      },
    },
    { type: "agent_end", messages: [] },
  ];
}

describe("Sandbox orchestrator (FakeSandbox)", () => {
  let stateDir: string;
  let sessionsDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ll-orch-"));
    sessionsDir = join(stateDir, "agent-sessions");
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("drives a successful agent run end-to-end (provision → run → finalize → dispose)", async () => {
    const fake = new FakeSandbox({ events: successEvents() });
    const seen: string[] = [];

    const result = await executeAgent(
      "do the thing",
      { sandbox: "none", stateDir, sessionsDir },
      { onSessionId: (id) => seen.push(id), sandboxFactory: fake.asFactory() },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("done");
    expect(result.stopReason).toBe("success");
    // Per-message usage flowed through the accumulator into the result.
    expect(result.inputTokens).toBe(100);
    expect(result.outputTokens).toBe(20);
    // The lifecycle ran: one provision, disposed afterwards.
    expect(fake.provisionCalls).toBe(1);
    expect(fake.disposed).toBe(true);
    // The session-id notify fired from the replayed `session` event.
    expect(seen).toEqual(["sess-fake"]);
  });

  it("emits a session jsonl envelope for the dashboard", async () => {
    const fake = new FakeSandbox({ events: successEvents("sess-jsonl") });
    await executeAgent(
      "do the thing",
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    const projectsDir = join(sessionsDir, "projects");
    const jsonlFiles = (): string[] => {
      if (!existsSync(projectsDir)) return [];
      const out: string[] = [];
      for (const slug of readdirSync(projectsDir)) {
        for (const f of readdirSync(join(projectsDir, slug))) {
          if (f.endsWith(".jsonl")) out.push(join(projectsDir, slug, f));
        }
      }
      return out;
    };
    // The shim flushes asynchronously — poll until the envelope carries the answer.
    expect(
      await waitFor(() => {
        const fs = jsonlFiles();
        return fs.length === 1 && readFileSync(fs[0], "utf8").includes("done");
      }),
    ).toBe(true);
  });

  it("converges errors onto the single fallback path", async () => {
    const fake = new FakeSandbox({ throwOnRunAgent: new Error("kaboom in the sandbox") });

    const result = await executeAgent(
      "do the thing",
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("error_sandbox");
    expect(result.error).toContain("kaboom in the sandbox");
    // Even on failure the workspace is disposed (the bracket's finally).
    expect(fake.disposed).toBe(true);
  });

  it("computes a strict EgressPolicy by default and passes it at construction", async () => {
    const fake = new FakeSandbox({ events: successEvents() });
    await executeAgent(
      "x",
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    expect(fake.egress?.unrestricted).toBe(false);
    // The default allowlist is non-empty and includes github.com.
    expect(fake.egress?.hosts).toContain("github.com");
  });

  it("computes an unrestricted EgressPolicy for an opted-out phase", async () => {
    const fake = new FakeSandbox({ events: successEvents() });
    await executeAgent(
      "x",
      { sandbox: "none", stateDir, sessionsDir, unrestrictedEgress: true },
      { sandboxFactory: fake.asFactory() },
    );

    expect(fake.egress?.unrestricted).toBe(true);
    expect(fake.egress?.hosts).toEqual([]);
  });

  it("stages the phase's skills for real and hands the dirs to runAgent", async () => {
    // A real skill source on disk — staging copies/symlinks it for real.
    const skillSrc = join(stateDir, "skills", "demo");
    mkdirSync(skillSrc, { recursive: true });
    writeFileSync(join(skillSrc, "SKILL.md"), "# demo\n");

    const fake = new FakeSandbox({ events: successEvents() });
    await executeAgent(
      "x",
      {
        sandbox: "none",
        stateDir,
        sessionsDir,
        skillPaths: [skillSrc],
        telemetry: { phaseName: "architect" },
      },
      { sandboxFactory: fake.asFactory() },
    );

    // Staging ran for real: stageSkillBundle only returns paths after it has
    // created the per-phase bundle (symlink), under the phase key.
    expect(fake.stagedSkillDirs).toHaveLength(1);
    expect(fake.stagedSkillDirs![0]).toContain(join(".lastlight-skills", "architect", "demo"));
    // The same staged dirs were forwarded into the agent run.
    expect(fake.receivedAgentOpts?.skillDirs).toEqual(fake.stagedSkillDirs);
    // The agent cwd matches what provision returned.
    expect(fake.receivedAgentOpts?.agentCwd).toBe(fake.agentCwd);
  });

  it("runs a bash command phase and mirrors it to a session jsonl", async () => {
    const fake = new FakeSandbox({
      commandResult: { exitCode: 0, stdout: "hello\n", stderr: "", timedOut: false },
    });

    const result = await executeCommand(
      { kind: "bash", command: "echo hello" },
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    expect(result.success).toBe(true);
    expect(result.output).toBe("hello"); // trailing newline stripped
    expect(fake.receivedCommand).toBe("echo hello");
    expect(fake.receivedCommandOpts?.cwd).toBe(fake.agentCwd);
    expect(fake.disposed).toBe(true);
    // A user-facing session jsonl was written.
    expect(existsSync(join(sessionsDir, "projects"))).toBe(true);
  });

  it("stages a script file into the workspace and runs the mapped path", async () => {
    const fake = new FakeSandbox({
      commandResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    });

    await executeCommand(
      { kind: "script", script: "console.log(1)", runtime: "js", name: "probe" },
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    // The script ran via the sandbox-mapped absolute path under the workspace.
    // (in-process maps to the host workspace path verbatim).
    expect(fake.receivedCommand).toMatch(/^node .*\.lastlight-scripts\/probe\/script\.mjs$/);
    expect(fake.receivedCommand).toContain(
      join(fake.hostWorkspaceDir, ".lastlight-scripts", "probe", "script.mjs"),
    );
  });

  it("skips the session jsonl when writeSession is false", async () => {
    const fake = new FakeSandbox({
      commandResult: { exitCode: 0, stdout: "ok", stderr: "", timedOut: false },
    });

    const result = await executeCommand(
      { kind: "bash", command: "true" },
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory(), writeSession: false },
    );

    expect(result.success).toBe(true);
    expect(result.sessionId).toBeUndefined();
    expect(existsSync(join(sessionsDir, "projects"))).toBe(false);
  });
});
