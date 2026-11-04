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

const { publishSpy } = vi.hoisted(() => ({ publishSpy: vi.fn() }));
vi.mock("#src/engine/claude-code/publish-notes.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/claude-code/publish-notes.js")>();
  return { ...actual, publishClaudeNotes: (...a: unknown[]) => publishSpy(...a) };
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

async function run(
  opts: {
    model?: string;
    backend?: "docker" | "none";
    prompt?: string;
    phase?: string;
    buildAssets?: "repo" | "server";
    access?: boolean;
    stateDir?: string;
    runId?: string;
  } = {},
) {
  const d = dirs();
  const stateDir = opts.stateDir ?? d.stateDir;
  const sessionsDir = d.sessionsDir;
  const fake = new FakeSandbox({
    claudeCodePort: fakePort,
    returnRunResult: { success: true, output: "done", turns: 1, durationMs: 1, stopReason: "end_turn" } as never,
  });
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
      ...(opts.buildAssets ? { buildAssets: opts.buildAssets } : {}),
    },
    {
      sandboxFactory: fake.asFactory(),
      taskId: "run-42-architect",
      ...(opts.access
        ? {
            githubAccess: {
              owner: "acme",
              repo: "widget",
              profile: "repo-write",
              prePopulateBranch: "lastlight/7-x",
              ...(opts.runId ? { runId: opts.runId } : {}),
            } as never,
          }
        : {}),
    },
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
  publishSpy.mockReset();
  publishSpy.mockResolvedValue({ published: true, oid: "oid-1", refused: [] });
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
    fakePort.exec.mockClear();
    const { result } = await run();
    expect(result).toMatchObject({ success: false, stopReason: "error_secret_leak" });
    expect(result.error).toContain(".lastlight/issue-7/architect-plan.md");
    // redacted from inside the sandbox, never written through a host path
    const redact = fakePort.exec.mock.calls.find((c) => (c[0] as string[]).includes(".lastlight/issue-7/architect-plan.md") || (c[0] as string[]).some((a) => a.endsWith("architect-plan.md")));
    expect(redact).toBeDefined();
    expect(JSON.stringify(result)).not.toContain("TESTTOKEN");
  });

  it.each([
    [{ kind: "failed", reason: "stalled" }],
    [{ kind: "usage_limit", resetsAt: null }],
  ])("checks the workspace for the token on a %o outcome too", async (outcome) => {
    sessionSpy.mockImplementation(async (_port, o) => {
      writeFileSync(join(o.cwd, "env.txt"), String(process.env.CLAUDE_CODE_OAUTH_TOKEN));
      return { ...outcome, sessionId: SESSION };
    });
    const { result } = await run();
    expect(result).toMatchObject({ success: false, stopReason: "error_secret_leak" });
  });

  it("checks the workspace when the session runner throws", async () => {
    sessionSpy.mockImplementation(async (_port, o) => {
      writeFileSync(join(o.cwd, "env.txt"), String(process.env.CLAUDE_CODE_OAUTH_TOKEN));
      throw new Error("docker exec died");
    });
    const { result } = await run();
    expect(result).toMatchObject({ success: false, stopReason: "error_secret_leak" });
  });

  it("fails closed when a note holds the token at publish time", async () => {
    emitsBasicSession();
    const actual = await vi.importActual<typeof import("#src/engine/claude-code/publish-notes.js")>("#src/engine/claude-code/publish-notes.js");
    publishSpy.mockImplementation(async (o: { holdsSecret?: (b: Buffer) => boolean }) => {
      expect(o.holdsSecret?.(Buffer.from(`x ${process.env.CLAUDE_CODE_OAUTH_TOKEN}`))).toBe(true);
      expect(o.holdsSecret?.(Buffer.from("clean"))).toBe(false);
      throw new actual.NotesSecretError(".lastlight/issue-7/x.md");
    });
    const { result } = await run({ access: true, buildAssets: "repo" });
    expect(result).toMatchObject({ success: false, stopReason: "error_secret_leak" });
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

  it("publishes the phase's notes from the host in repo mode", async () => {
    emitsBasicSession();
    const { result, fake } = await run({ access: true, buildAssets: "repo" });
    expect(result.success).toBe(true);
    expect(publishSpy).toHaveBeenCalledTimes(1);
    const arg = publishSpy.mock.calls[0]![0];
    expect(arg).toMatchObject({
      owner: "acme",
      repo: "widget",
      branch: "lastlight/7-x",
      workspace: fake.agentCwd,
      message: "docs(lastlight): architect notes",
    });
    expect(typeof arg.gh.publishSignedCommit).toBe("function");
    // the host's token never went into the container
    expect(Object.values(fake.env ?? {})).not.toContain("ghp_pat");
  });

  it("does not publish in server mode, or after a leak", async () => {
    emitsBasicSession();
    await run({ access: true, buildAssets: "server" });
    expect(publishSpy).not.toHaveBeenCalled();

    sessionSpy.mockImplementation(async (_port, o) => {
      writeFileSync(join(o.cwd, "leak.txt"), String(process.env.CLAUDE_CODE_OAUTH_TOKEN));
      o.onEvent({ type: "message_end", sessionId: SESSION, message: { role: "assistant", content: [{ type: "text", text: "x" }] } });
      return { kind: "done", sessionId: SESSION };
    });
    const { result } = await run({ access: true, buildAssets: "repo" });
    expect(result.stopReason).toBe("error_secret_leak");
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it("moves the next phase's checkout onto the published notes, in its own sandbox, once", async () => {
    const oid = "a".repeat(40);
    publishSpy.mockResolvedValue({ published: true, oid, refused: [] });
    emitsBasicSession();
    const first = await run({ access: true, buildAssets: "repo", runId: "run-42" });
    expect(first.result.success).toBe(true);
    // the Claude sandbox holds no GitHub credential, so it never runs the sync
    expect(first.fake.receivedCommand).toBeUndefined();

    const next = await run({ access: true, model: "deepseek/deepseek-chat", stateDir: first.stateDir, runId: "run-42", phase: "executor" });
    expect(next.fake.receivedCommand).toContain("git fetch origin");
    expect(next.fake.receivedCommand).toContain(oid);
    expect(next.fake.receivedCommand).toContain("reset --mixed");
    expect(next.fake.receivedCommand).toContain("merge-base --is-ancestor");
    expect(next.fake.receivedCommandOpts?.sandboxEnv?.GIT_CONFIG_COUNT).toBe("2");

    const third = await run({ access: true, model: "deepseek/deepseek-chat", stateDir: first.stateDir, runId: "run-42", phase: "reviewer" });
    expect(third.fake.receivedCommand).toBeUndefined();
  });

  it("does not sync a phase of another run", async () => {
    publishSpy.mockResolvedValue({ published: true, oid: "b".repeat(40), refused: [] });
    emitsBasicSession();
    const first = await run({ access: true, buildAssets: "repo", runId: "run-42" });
    const other = await run({ access: true, model: "deepseek/deepseek-chat", stateDir: first.stateDir, runId: "run-43", phase: "executor" });
    expect(other.fake.receivedCommand).toBeUndefined();
  });

  it("resumes the session a usage limit stopped, with the kept transcript and `continue`", async () => {
    const line = JSON.stringify({ type: "user", sessionId: SESSION, message: { role: "user", content: "plan it" } });
    sessionSpy.mockImplementationOnce(async (_port, o) => {
      o.onRawLine(line);
      return { kind: "usage_limit", sessionId: SESSION, resetsAt: null };
    });
    const first = await run({ runId: "run-77", access: true, buildAssets: "server" });
    expect(first.result.stopReason).toBe("usage_limit");

    emitsBasicSession();
    await run({ runId: "run-77", access: true, buildAssets: "server", stateDir: first.stateDir });
    const resumed = sessionSpy.mock.calls.at(-1)![1];
    expect(resumed.resume).toEqual({ sessionId: SESSION, lines: [line] });
    expect(resumed.prompt).toBe("continue");

    // once: a later attempt of the phase starts fresh
    await run({ runId: "run-77", access: true, buildAssets: "server", stateDir: first.stateDir });
    expect(sessionSpy.mock.calls.at(-1)![1].resume).toBeUndefined();
  });

  it("does not resume another phase's session", async () => {
    sessionSpy.mockImplementationOnce(async (_port, o) => {
      o.onRawLine("{}");
      return { kind: "usage_limit", sessionId: SESSION, resetsAt: null };
    });
    const first = await run({ runId: "run-78", access: true, buildAssets: "server" });
    emitsBasicSession();
    await run({ runId: "run-78", access: true, buildAssets: "server", stateDir: first.stateDir, phase: "reviewer" });
    expect(sessionSpy.mock.calls.at(-1)![1].resume).toBeUndefined();
  });

  it("fails the phase when the publish fails", async () => {
    emitsBasicSession();
    publishSpy.mockRejectedValue(new Error("GraphQL: STALE_DATA"));
    const { result } = await run({ access: true, buildAssets: "repo" });
    expect(result).toMatchObject({ success: false, stopReason: "error_publish" });
    expect(result.error).toContain("STALE_DATA");
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
