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
import { QuotaExceededError } from "#src/sandbox/k8s/quota.js";
import { configureWorkflowAssets } from "#src/workflows/loader.js";

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

  it("maps a QuotaExceededError to stopReason error_quota on the agent path", async () => {
    const fake = new FakeSandbox({ throwOnRunAgent: new QuotaExceededError("exceeded quota: pods") });

    const result = await executeAgent(
      "do the thing",
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("error_quota");
    expect(result.error).toContain("exceeded quota");
  });

  it("maps a provision-time QuotaExceededError to stopReason error_quota on the agent path", async () => {
    // The pod-create rejection happens during provisioning, OUTSIDE the
    // in-callback runAgent try/catch — it must still surface as an error_quota
    // RESULT (not a throw) so the runner flags backpressure and requeues, rather
    // than the run terminal-failing red.
    const fake = new FakeSandbox({ throwOnProvision: new QuotaExceededError("exceeded quota: pods") });

    const result = await executeAgent(
      "do the thing",
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("error_quota");
    expect(result.error).toContain("exceeded quota");
  });

  it("propagates a generic provision throw on the agent path (not backpressure)", async () => {
    const fake = new FakeSandbox({ throwOnProvision: new Error("docker unavailable") });

    await expect(
      executeAgent(
        "do the thing",
        { sandbox: "none", stateDir, sessionsDir },
        { sandboxFactory: fake.asFactory() },
      ),
    ).rejects.toThrow("docker unavailable");
  });

  it("keeps error_sandbox for a generic sandbox throw on the agent path", async () => {
    const fake = new FakeSandbox({ throwOnRunAgent: new Error("boom") });

    const result = await executeAgent(
      "do the thing",
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    expect(result.stopReason).toBe("error_sandbox");
  });

  it("maps a QuotaExceededError to stopReason error_quota on the command path", async () => {
    const fake = new FakeSandbox({ throwOnRunCommand: new QuotaExceededError("exceeded quota: pods") });

    const result = await executeCommand(
      { kind: "bash", command: "echo hi" },
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("error_quota");
    expect(result.error).toContain("exceeded quota");
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

  it("forwards config.githubApiBaseUrl into the command env as GITHUB_API_URL", async () => {
    // The eval harness sets githubApiBaseUrl to the fake GitHub URL. Command/
    // script phases (e.g. pr-review's post-review) must receive it so a
    // GitHub-mutating script hits the fake instead of api.github.com.
    const fake = new FakeSandbox({
      commandResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    });

    await executeCommand(
      { kind: "script", script: "console.log(1)", runtime: "js", name: "post" },
      { sandbox: "none", stateDir, sessionsDir, githubApiBaseUrl: "http://127.0.0.1:5599" },
      { sandboxFactory: fake.asFactory() },
    );

    expect(fake.receivedCommandOpts?.sandboxEnv?.GITHUB_API_URL).toBe("http://127.0.0.1:5599");
  });

  it("injects no GITHUB_API_URL when githubApiBaseUrl is unset (prod parity)", async () => {
    const fake = new FakeSandbox({
      commandResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    });

    await executeCommand(
      { kind: "bash", command: "true" },
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    // No base-url override — so the script falls back to api.github.com with its
    // minted token in prod. (sandboxEnv still carries the git identity, below.)
    expect(fake.receivedCommandOpts?.sandboxEnv?.GITHUB_API_URL).toBeUndefined();
  });

  it("threads git identity into command/script phases (so their commits are attributed)", async () => {
    const fake = new FakeSandbox({
      commandResult: { exitCode: 0, stdout: "", stderr: "", timedOut: false },
    });

    await executeCommand(
      { kind: "bash", command: "git commit -am x" },
      { sandbox: "none", stateDir, sessionsDir },
      { sandboxFactory: fake.asFactory() },
    );

    // Same agentGitIdentityEnv the agent path gets — a deterministic-phase commit
    // must not be left identity-less. Resolves to the botLogin default in tests.
    const env = fake.receivedCommandOpts?.sandboxEnv;
    expect(env?.GIT_AUTHOR_NAME).toBe("last-light[bot]");
    expect(env?.GIT_COMMITTER_NAME).toBe("last-light[bot]");
  });

  describe("AGENTS.md host write (host-shared backends vs kubernetes)", () => {
    let agentContextRoot: string;

    beforeEach(() => {
      agentContextRoot = mkdtempSync(join(tmpdir(), "ll-agent-ctx-"));
      mkdirSync(join(agentContextRoot, "agent-context"), { recursive: true });
      writeFileSync(join(agentContextRoot, "agent-context", "persona.md"), "BE HELPFUL");
      configureWorkflowAssets({ builtInRoot: agentContextRoot });
    });

    afterEach(() => {
      configureWorkflowAssets();
      rmSync(agentContextRoot, { recursive: true, force: true });
    });

    it("writes AGENTS.md to the host workspace on a host-shared backend", async () => {
      const fake = new FakeSandbox({ events: successEvents() });
      // `dispose()` removes the fake host workspace dir once the run
      // completes, so check the write while the sandbox is still live — the
      // "session" event (first in successEvents()) fires from inside
      // sandbox.runAgent(), after writeAgentsMd already ran.
      let sawDuringRun: { exists: boolean; content: string } | undefined;
      await executeAgent(
        "do the thing",
        { sandbox: "none", stateDir, sessionsDir },
        {
          sandboxFactory: fake.asFactory(),
          onSessionId: () => {
            const agentsMdPath = join(fake.hostWorkspaceDir, "AGENTS.md");
            sawDuringRun = {
              exists: existsSync(agentsMdPath),
              content: existsSync(agentsMdPath) ? readFileSync(agentsMdPath, "utf8") : "",
            };
          },
        },
      );

      expect(sawDuringRun?.exists).toBe(true);
      expect(sawDuringRun?.content).toContain("BE HELPFUL");
    });

    it("skips the host AGENTS.md write on the kubernetes backend (no host-visible workspace)", async () => {
      const fake = new FakeSandbox({ events: successEvents() });
      // Same dispose-timing note as above: check DURING the run, not after —
      // `dispose()` removes the whole fake host dir regardless of whether the
      // write happened, so a post-run check would pass trivially either way.
      let sawDuringRun: boolean | undefined;
      await executeAgent(
        "do the thing",
        { sandbox: "kubernetes", stateDir, sessionsDir },
        {
          sandboxFactory: fake.asFactory(),
          onSessionId: () => {
            // FakeSandbox hands back a REAL host dir regardless of backend, so
            // a write would succeed here if attempted — proving `false` below
            // is a deliberate skip, not an ENOENT accident swallowed silently.
            sawDuringRun = existsSync(join(fake.hostWorkspaceDir, "AGENTS.md"));
          },
        },
      );

      expect(sawDuringRun).toBe(false);
    });
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
