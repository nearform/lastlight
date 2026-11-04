/**
 * A phase on a `claude-code/` model runs through the Claude Code session
 * runner, never agentic-pi, in a container whose env holds the Claude token
 * and no GitHub or provider credential.
 */
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => noopLogger };
  return { logger: () => noopLogger };
});

const { sessionSpy } = vi.hoisted(() => ({ sessionSpy: vi.fn() }));
vi.mock("#src/engine/claude-code/session.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/claude-code/session.js")>();
  return { ...actual, runClaudeCodeSession: (...a: unknown[]) => sessionSpy(...a) };
});

const { executeAgent, executeCommand } = await import("#src/engine/agent-executor.js");
const { FakeSandbox } = await import("#src/sandbox/sandbox.js");

const SESSION = "6f1c2a9e-0000-4000-8000-000000000001";
const fakePort = { exec: vi.fn(), stream: vi.fn() };

function dirs() {
  const stateDir = mkdtempSync(join(tmpdir(), "ll-exec-claude-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  return { stateDir, sessionsDir };
}

async function run(opts: { model?: string; backend?: "docker" | "none"; prompt?: string; phase?: string } = {}) {
  const { stateDir, sessionsDir } = dirs();
  const fake = new FakeSandbox({ claudeCodePort: fakePort });
  // Keep the workspace after the run so a test can read what was left in it.
  fake.dispose = () => {};
  const result = await executeAgent(
    opts.prompt ?? "Write the architect plan.",
    {
      sandbox: opts.backend ?? "docker",
      stateDir,
      sessionsDir,
      model: opts.model ?? "claude-code/claude-opus-5-5",
      telemetry: { workflowName: "build", phaseName: opts.phase ?? "architect" },
    },
    { sandboxFactory: fake.asFactory(), taskId: "run-42-architect" },
  );
  return { fake, result, stateDir, sessionsDir };
}

function emitsBasicSession() {
  sessionSpy.mockImplementation(async (_port, o) => {
    const lines = [
      JSON.stringify({ type: "assistant", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "Plan written." }], usage: { input_tokens: 10, output_tokens: 5 } } }),
    ];
    for (const l of lines) o.onRawLine(l);
    o.onEvent({ type: "session", id: SESSION, timestamp: "2026-11-04T10:00:00Z" });
    o.onEvent({
      type: "message_end",
      sessionId: SESSION,
      message: { role: "assistant", content: [{ type: "text", text: "Plan written." }], usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } },
    });
    return { kind: "done", sessionId: SESSION };
  });
}

const saved = { ...process.env };
beforeEach(() => {
  sessionSpy.mockReset();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-TESTTOKEN";
  process.env.DEEPSEEK_API_KEY = "deepseek-key";
  process.env.GITHUB_TOKEN = "ghp_pat";
});
afterEach(() => {
  process.env = { ...saved };
});

describe("executeAgent on a claude-code model", () => {
  it("runs the Claude session, not agentic-pi, with a credential-free container env", async () => {
    emitsBasicSession();
    const { fake, result } = await run();

    expect(sessionSpy).toHaveBeenCalledTimes(1);
    const [port, o] = sessionSpy.mock.calls[0]!;
    expect(port).toBe(fakePort);
    expect(o).toMatchObject({ model: "claude-opus-5-5", prompt: "Write the architect plan." });
    expect(fake.receivedAgentOpts).toBeUndefined();

    expect(fake.env?.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-TESTTOKEN");
    expect(fake.env?.CLAUDE_CONFIG_DIR).toBe("/home/agent/.claude-ll");
    for (const k of Object.keys(fake.env ?? {})) {
      expect(k).not.toMatch(/^(GIT_TOKEN|GITHUB_|GH_TOKEN|GIT_CONFIG_|DEEPSEEK_API_KEY|AGENTIC_PI_)/);
    }

    expect(result).toMatchObject({ success: true, output: "Plan written.", sessionId: SESSION, stopReason: "success" });
  });

  it("writes the session log the dashboard reads, and keeps the raw transcript for a resume", async () => {
    emitsBasicSession();
    const { sessionsDir, stateDir } = await run();
    const projects = join(sessionsDir, "projects");
    const logText = () =>
      readdirSync(projects, { recursive: true })
        .map(String)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => readFileSync(join(projects, f), "utf8"))
        .join("");
    // The shim flushes asynchronously.
    for (let i = 0; i < 50 && !logText().includes("Plan written."); i++) await new Promise((r) => setTimeout(r, 20));
    expect(logText()).toContain("Plan written.");

    const kept = join(stateDir, "claude-code", "run-42-architect", "architect.jsonl");
    expect(readFileSync(kept, "utf8")).toContain('"Plan written."');
    expect(statSync(kept).mode & 0o777).toBe(0o600);
  });

  it("fails fast when the token env var is not set", async () => {
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    const { fake, result } = await run();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CLAUDE_CODE_OAUTH_TOKEN/);
    expect(fake.provisionCalls).toBe(0);
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("refuses a non-docker backend", async () => {
    const { result, fake } = await run({ backend: "none" });
    expect(result).toMatchObject({ success: false, error: "claude-code models need sandbox: docker" });
    expect(fake.provisionCalls).toBe(0);
  });

  it("refuses a phase whose prompt needs GitHub tools", async () => {
    const { result } = await run({ phase: "executor", prompt: "Implement it, then call `github_publish` with …" });
    expect(result).toMatchObject({
      success: false,
      error: "claude-code is not supported for the executor phase yet: it needs GitHub tools",
    });
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("maps a usage limit to a retryable stop with the reset time", async () => {
    sessionSpy.mockResolvedValue({ kind: "usage_limit", sessionId: SESSION, resetsAt: "2026-11-04T15:00:00.000Z" });
    const { result } = await run();
    expect(result).toMatchObject({
      success: false,
      stopReason: "usage_limit",
      retryAfter: "2026-11-04T15:00:00.000Z",
      sessionId: SESSION,
    });
    expect(result.error).toMatch(/usage limit/i);
  });

  it("fails a phase whose workspace holds the token, and redacts the file", async () => {
    sessionSpy.mockImplementation(async (_port, o) => {
      mkdirSync(join(o.cwd, ".lastlight", "issue-7"), { recursive: true });
      writeFileSync(join(o.cwd, ".lastlight", "issue-7", "architect-plan.md"), `env: ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`);
      o.onEvent({ type: "message_end", sessionId: SESSION, message: { role: "assistant", content: [{ type: "text", text: "Done." }] } });
      return { kind: "done", sessionId: SESSION };
    });
    const { result, fake } = await run();
    expect(result).toMatchObject({ success: false, stopReason: "error_secret_leak" });
    expect(result.error).toContain(".lastlight/issue-7/architect-plan.md");
    expect(readFileSync(join(fake.hostWorkspaceDir, ".lastlight", "issue-7", "architect-plan.md"), "utf8")).toBe(
      "[redacted: contained the Claude token]\n",
    );
    expect(JSON.stringify(result)).not.toContain("TESTTOKEN");
  });

  it("fails a phase whose final answer holds the token, without returning it", async () => {
    sessionSpy.mockImplementation(async (_port, o) => {
      o.onEvent({
        type: "message_end",
        sessionId: SESSION,
        message: { role: "assistant", content: [{ type: "text", text: `my env has ${process.env.CLAUDE_CODE_OAUTH_TOKEN}` }] },
      });
      return { kind: "done", sessionId: SESSION };
    });
    const { result } = await run();
    expect(result).toMatchObject({ success: false, stopReason: "error_secret_leak", output: "" });
    expect(JSON.stringify(result)).not.toContain("TESTTOKEN");
  });

  it("scrubs the token from the dashboard log and the kept transcript", async () => {
    sessionSpy.mockImplementation(async (_port, o) => {
      const tok = process.env.CLAUDE_CODE_OAUTH_TOKEN!;
      o.onRawLine(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: `TOKEN=${tok}` }] } }));
      o.onEvent({ type: "session", id: SESSION, timestamp: "2026-11-04T10:00:00Z" });
      o.onEvent({ type: "message_end", sessionId: SESSION, message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "Bash", arguments: { command: "env" } }] } });
      o.onEvent({ type: "tool_execution_end", sessionId: SESSION, toolCallId: "t1", toolName: "Bash", result: `TOKEN=${tok}`, isError: false });
      o.onEvent({ type: "message_end", sessionId: SESSION, message: { role: "assistant", content: [{ type: "text", text: `I saw TOKEN=${tok} there.` }] } });
      o.onEvent({ type: "message_end", sessionId: SESSION, message: { role: "assistant", content: [{ type: "text", text: "ok" }] } });
      return { kind: "done", sessionId: SESSION };
    });
    const { sessionsDir, stateDir } = await run();
    const projects = join(sessionsDir, "projects");
    const logText = () =>
      readdirSync(projects, { recursive: true }).map(String).filter((f) => f.endsWith(".jsonl"))
        .map((f) => readFileSync(join(projects, f), "utf8")).join("");
    for (let i = 0; i < 50 && !logText().includes("I saw TOKEN="); i++) await new Promise((r) => setTimeout(r, 20));
    expect(logText()).toContain("I saw TOKEN=[redacted] there.");
    expect(logText()).not.toContain("TESTTOKEN");
    const kept = readFileSync(join(stateDir, "claude-code", "run-42-architect", "architect.jsonl"), "utf8");
    expect(kept).toContain("TOKEN=");
    expect(kept).not.toContain("TESTTOKEN");
  });

  it("never hands the Claude token to a command phase", async () => {
    const { stateDir, sessionsDir } = dirs();
    const fake = new FakeSandbox({});
    await executeCommand(
      { kind: "bash", command: "echo hi" } as never,
      { sandbox: "docker", stateDir, sessionsDir, model: "claude-code/claude-opus-5-5" },
      { sandboxFactory: fake.asFactory() },
    );
    expect(fake.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(fake.receivedCommand).toBeDefined();
  });

  it.each([
    ["stalled", "error_stalled"],
    ["timeout", "error_timeout"],
    ["auth_failed", "error_auth"],
    ["not_ready", "error_sandbox"],
    ["exited", "error_sandbox"],
  ])("maps a %s session to %s", async (reason, stopReason) => {
    sessionSpy.mockResolvedValue({ kind: "failed", reason, sessionId: SESSION });
    const { result } = await run();
    expect(result).toMatchObject({ success: false, stopReason });
    expect(result.error).toBeTruthy();
    expect(JSON.stringify(result)).not.toContain("TESTTOKEN");
  });
});
