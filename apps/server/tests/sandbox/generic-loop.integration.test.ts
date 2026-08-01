import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { AgentWorkflowDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";
import { VERIFY_SCRIPT_NAME } from "#src/engine/fix-scratch.js";

/**
 * The one genuinely new production runtime path in Phase 4: `generic_loop` +
 * `until_bash` (04-retry.md §4.5). The unit suite stubs `executeCommand`, so it
 * proves the loop's control flow but nothing about the gate ACTUALLY running in
 * a sandbox against the persisted workspace.
 *
 * This test keeps the sandbox real and stubs only the AI: `executeAgent` is
 * mocked (it stands in for the fix agent and writes `.git/lastlight-verify.sh` the
 * way the `fixing` skill instructs), while `executeCommand` — which backs
 * `runUntilBash` — is the real thing and executes inside a docker container.
 *
 * Opt-in + self-gating, same contract as command-exec.integration.test.ts:
 *
 *   docker compose --profile build-only build sandbox-base
 *   docker compose --profile build-only build sandbox
 *   RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/generic-loop.integration.test.ts
 */

// Partial mock: keep every real export except `executeAgent`.
vi.mock("#src/engine/agent-executor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/engine/agent-executor.js")>();
  return { ...actual, executeAgent: vi.fn() };
});

const { executeAgent } = await import("#src/engine/agent-executor.js");
const { runWorkflow } = await import("#src/workflows/runner.js");
const mockExecuteAgent = vi.mocked(executeAgent);

function sandboxImageBuilt(): boolean {
  try {
    const out = execFileSync("docker", ["images", "-q", "lastlight-sandbox:latest"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

const RUN = process.env.RUN_SANDBOX_IT === "1" && sandboxImageBuilt();
const TIMEOUT = 240_000;

let stateDir: string;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string): void {
  savedEnv[k] = process.env[k];
  process.env[k] = v;
}

function baseCtx(taskId: string): TemplateContext {
  return {
    owner: "acme",
    repo: "widget",
    issueNumber: 7,
    issueTitle: "Bump lodash",
    issueBody: "",
    issueLabels: [],
    commentBody: "",
    sender: "tester",
    branch: "main",
    taskId,
    issueDir: ".lastlight/issue-7",
    bootstrapLabel: "lastlight:bootstrap",
  };
}

function dockerConfig(): ExecutorConfig {
  return { sandbox: "docker", stateDir, sessionsDir: join(stateDir, "agent-sessions") };
}

/**
 * Host path of the workspace `until_bash` runs in (cwd, no pre-clone).
 *
 * The `.git/` dir is created because the gate lives inside it — the real
 * article is a git checkout, where it always exists (see
 * `src/engine/fix-scratch.ts`).
 */
function workspaceOf(taskId: string): string {
  const dir = join(stateDir, "sandboxes", taskId);
  mkdirSync(join(dir, ".git"), { recursive: true });
  return dir;
}

const GATE = `if [ -f ${VERIFY_SCRIPT_NAME} ]; then sh ${VERIFY_SCRIPT_NAME}; else echo 'no gate — RED'; exit 1; fi`;

const agentOk = (output: string) => ({ success: true, output, error: undefined, turns: 1, durationMs: 5 });

describe.skipIf(!RUN)("generic_loop + until_bash (integration)", () => {
  beforeAll(() => {
    const base = join(process.cwd(), "data", "sandbox-it");
    mkdirSync(base, { recursive: true });
    stateDir = mkdtempSync(join(base, "loop-"));
    setEnv("LASTLIGHT_SANDBOX_NETWORK", "default");
    setEnv("LASTLIGHT_DNS_STRICT", "8.8.8.8");
    setEnv("LASTLIGHT_DNS_OPEN", "8.8.8.8");
    setEnv("SANDBOX_DATA_VOLUME", join(stateDir, "sandbox-data"));
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  // Each case asserts on the ITERATION COUNT, which is the whole point of the
  // loop — so the mock has to start each one at zero. Without this the second
  // case reads the first case's two calls as its own and the counts silently
  // accumulate down the file. `mockReset` (not `mockClear`) also drops the
  // `mockImplementationOnce` queue, so a case that ends early cannot leak a
  // pending implementation into the next one.
  beforeEach(() => {
    mockExecuteAgent.mockReset();
  });

  it("iterates once more when the gate script fails, and stops when it passes", async () => {
    const taskId = "it-loop-1";
    const ws = workspaceOf(taskId);
    // Iteration 1 writes a RED gate (the fix didn't take); iteration 2 rewrites
    // it green. Exactly the shape the `fixing` skill describes, minus the AI.
    mockExecuteAgent
      .mockImplementationOnce(async () => {
        writeFileSync(join(ws, VERIFY_SCRIPT_NAME), "#!/bin/sh\necho gate-red\nexit 1\n");
        return agentOk("attempt 1");
      })
      .mockImplementationOnce(async () => {
        writeFileSync(join(ws, VERIFY_SCRIPT_NAME), "#!/bin/sh\necho gate-green\nexit 0\n");
        return agentOk("attempt 2");
      });

    const wf: AgentWorkflowDefinition = {
      kind: "pr-fix",
      name: "it-loop",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "fix",
          type: "agent",
          prompt: "prompts/pr-fix.md",
          timeout_seconds: 120,
          generic_loop: { max_iterations: 3, until_bash: GATE, interactive: false, fresh_context: false },
        },
      ],
    };

    const result = await runWorkflow(wf, baseCtx(taskId), dockerConfig(), {});

    expect(result.success).toBe(true);
    // TWO iterations: the red gate bought one more, the green one ended it —
    // and neither the third iteration nor an early exit happened.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(result.phases.map((p) => p.phase)).toContain("fix_iter_2");
    expect(result.phases.map((p) => p.phase)).not.toContain("fix_iter_3");
  }, TIMEOUT);

  it("treats a MISSING gate script as red (gate=skipped never authorises a push)", async () => {
    const taskId = "it-loop-missing";
    workspaceOf(taskId); // deliberately empty — the agent writes no gate
    mockExecuteAgent.mockImplementation(async () => agentOk("I forgot to write a gate"));

    const wf: AgentWorkflowDefinition = {
      kind: "pr-fix",
      name: "it-loop-missing",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "fix",
          type: "agent",
          prompt: "prompts/pr-fix.md",
          timeout_seconds: 120,
          generic_loop: { max_iterations: 2, until_bash: GATE, interactive: false, fresh_context: false },
        },
      ],
    };

    await runWorkflow(wf, baseCtx(taskId), dockerConfig(), {});

    // Never completes ⇒ every iteration is spent ⇒ nothing signals "green".
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  }, TIMEOUT);

  it("honours the phase-level timeout_seconds instead of runUntilBash's 30s default", async () => {
    const taskId = "it-loop-timeout";
    const ws = workspaceOf(taskId);
    // A gate that would outlast BOTH the phase timeout and the 30s default, so
    // the elapsed time says which one was applied.
    mockExecuteAgent.mockImplementation(async () => {
      writeFileSync(join(ws, VERIFY_SCRIPT_NAME), "#!/bin/sh\nsleep 90\nexit 0\n");
      return agentOk("wrote a slow gate");
    });

    const wf: AgentWorkflowDefinition = {
      kind: "pr-fix",
      name: "it-loop-timeout",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "fix",
          type: "agent",
          prompt: "prompts/pr-fix.md",
          timeout_seconds: 5,
          generic_loop: { max_iterations: 1, until_bash: GATE, interactive: false, fresh_context: false },
        },
      ],
    };

    const started = Date.now();
    await runWorkflow(wf, baseCtx(taskId), dockerConfig(), {});
    const elapsed = Date.now() - started;

    // Killed at ~5s, not 30s (the default) and not 90s (the script). The
    // inverse case is the trap this whole knob exists for: a REAL test suite
    // killed at 30s reports a false red.
    expect(elapsed).toBeLessThan(30_000);
  }, TIMEOUT);
});
