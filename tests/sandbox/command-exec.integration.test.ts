import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { AgentWorkflowDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";
import { runWorkflow } from "#src/workflows/runner.js";

/**
 * Integration tests that ACTUALLY start a docker sandbox and execute
 * deterministic `type: bash` / `type: script` phases end-to-end through the
 * real workflow runner — no AI, no mocks. This is the one path the unit suite
 * can't cover (it stubs `executeCommand`).
 *
 * Opt-in + self-gating: runs only when `RUN_SANDBOX_IT=1` AND the lean sandbox
 * image is built, so the default `npx vitest run` (and CI without docker) skip
 * it instantly. To run:
 *
 *   docker compose --profile build-only build sandbox-base   # shared base first
 *   docker compose --profile build-only build sandbox        # then the lean image
 *   RUN_SANDBOX_IT=1 npx vitest run src/sandbox/command-exec.integration.test.ts
 *
 * Each command phase spins up + tears down its own container, so these are
 * slow (tens of seconds) — hence the long per-test timeout.
 */

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

const TIMEOUT = 180_000;

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
    issueNumber: 1,
    issueTitle: "integration",
    issueBody: "",
    issueLabels: [],
    commentBody: "",
    sender: "tester",
    branch: "main",
    taskId,
    issueDir: ".lastlight/issue-1",
    bootstrapLabel: "lastlight:bootstrap",
  };
}

function dockerConfig(): ExecutorConfig {
  return {
    sandbox: "docker",
    stateDir,
    sessionsDir: join(stateDir, "agent-sessions"),
  };
}

describe.skipIf(!RUN)("sandbox command execution (integration)", () => {
  beforeAll(() => {
    // Base the workspace under the repo's gitignored `data/` dir (i.e. inside
    // the project, under the user's home). Docker Desktop on macOS shares
    // /Users by default but NOT /var/folders (os.tmpdir()) or /tmp — so the
    // workspace bind mount is only visible to the daemon under a shared path.
    // This mirrors scripts/dev-local.sh (STATE_DIR=$PROJECT_ROOT/data). On Linux
    // any path works.
    const base = join(process.cwd(), "data", "sandbox-it");
    mkdirSync(base, { recursive: true });
    stateDir = mkdtempSync(join(base, "run-"));
    // Run on the default bridge (the compose sandbox-egress network + coredns
    // sidecars don't exist outside docker-compose) and point DNS at a real
    // resolver so the container has working name resolution + NAT.
    setEnv("LASTLIGHT_SANDBOX_NETWORK", "default");
    setEnv("LASTLIGHT_DNS_STRICT", "8.8.8.8");
    setEnv("LASTLIGHT_DNS_OPEN", "8.8.8.8");
    // Host-path data volume → bind-mount mode (mirrors scripts/dev-local.sh),
    // so the harness and the daemon see the same workspace FS.
    setEnv("SANDBOX_DATA_VOLUME", join(stateDir, "sandbox-data"));
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("runs a no-AI bash workflow and threads output to a downstream phase", async () => {
    const wf: AgentWorkflowDefinition = {
      kind: "agent",
      name: "it-bash",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "emit", type: "bash", command: "echo hello-from-sandbox", output_var: "greeting" },
        // Consumes the upstream output two ways: template substitution + the
        // forwarded LL_OUT_<PHASE> env var.
        { name: "consume", type: "bash", command: "echo template={{phaseOutputs.emit}} env=$LL_OUT_EMIT" },
      ],
    };

    const result = await runWorkflow(wf, baseCtx("it-bash-1"), dockerConfig(), {});

    expect(result.success).toBe(true);
    const emit = result.phases.find((p) => p.phase === "emit");
    expect(emit?.success).toBe(true);
    expect(emit?.output).toContain("hello-from-sandbox");

    const consume = result.phases.find((p) => p.phase === "consume");
    expect(consume?.success).toBe(true);
    expect(consume?.output).toContain("template=hello-from-sandbox");
    expect(consume?.output).toContain("env=hello-from-sandbox");

    // The command run is mirrored to a session jsonl (visible in the dashboard
    // + CLI), exactly like an agent turn.
    const projects = join(stateDir, "agent-sessions", "projects");
    expect(existsSync(projects)).toBe(true);
    const jsonls = readdirSync(projects, { recursive: true } as never).filter((f: string) => String(f).endsWith(".jsonl"));
    expect(jsonls.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it("fails the workflow when a bash phase exits non-zero", async () => {
    const wf: AgentWorkflowDefinition = {
      kind: "agent",
      name: "it-bash-fail",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "boom", type: "bash", command: "echo nope >&2; exit 3" },
      ],
    };

    const result = await runWorkflow(wf, baseCtx("it-bash-fail-1"), dockerConfig(), {});

    expect(result.success).toBe(false);
    const boom = result.phases.find((p) => p.phase === "boom");
    expect(boom?.success).toBe(false);
  }, TIMEOUT);

  it("runs an inline JS script via node", async () => {
    const wf: AgentWorkflowDefinition = {
      kind: "agent",
      name: "it-js",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "calc",
          type: "script",
          runtime: "js",
          script: "console.log('js-answer:', 6 * 7);",
          output_var: "out",
        },
      ],
    };

    const result = await runWorkflow(wf, baseCtx("it-js-1"), dockerConfig(), {});

    expect(result.success).toBe(true);
    const calc = result.phases.find((p) => p.phase === "calc");
    expect(calc?.success).toBe(true);
    expect(calc?.output).toContain("js-answer: 42");
  }, TIMEOUT);

  it("runs an inline Python script via uv run (stdlib only, offline)", async () => {
    const wf: AgentWorkflowDefinition = {
      kind: "agent",
      name: "it-py",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "calc",
          type: "script",
          runtime: "python",
          timeout_seconds: 120,
          script: "import sys\nprint('py-answer:', 6 * 7)\nprint('py-version-ok:', sys.version_info[0] == 3)",
          output_var: "out",
        },
      ],
    };

    const result = await runWorkflow(wf, baseCtx("it-py-1"), dockerConfig(), {});

    expect(result.success).toBe(true);
    const calc = result.phases.find((p) => p.phase === "calc");
    expect(calc?.success).toBe(true);
    expect(calc?.output).toContain("py-answer: 42");
    expect(calc?.output).toContain("py-version-ok: True");
  }, TIMEOUT);
});
