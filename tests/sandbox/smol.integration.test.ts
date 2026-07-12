import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import type { AgentWorkflowDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";
import { runWorkflow } from "#src/workflows/runner.js";
import { smolAvailable } from "#src/sandbox/smol.js";

/**
 * Integration tests that ACTUALLY boot a smolvm micro-VM and execute
 * deterministic `type: bash` / `type: script` phases end-to-end through the
 * real workflow runner — no AI, no mocks. The smol-backend analogue of
 * command-exec.integration.test.ts.
 *
 * Opt-in + self-gating: runs only when `RUN_SMOL_IT=1`, the smolvm CLI is
 * installed, AND `SMOLVM_IMAGE` points at a bootable VM image. The default
 * `npx vitest run` (and CI without smolvm) skip it instantly. SMOLVM_IMAGE is
 * required because the default OCI ref (lastlight-sandbox:latest) isn't loaded
 * into smolvm's offline store — without an image the VM can't boot, so the run
 * would fail rather than test anything. We skip (not fail) when it's absent.
 * To run (Apple Silicon / Linux KVM host):
 *
 *   curl -sSL https://smolmachines.com/install.sh | sh   # install smolvm
 *   smolvm serve &                                        # start the daemon
 *   docker compose --profile build-only build sandbox-base            # shared base first
 *   docker compose --profile build-only build sandbox                 # then the image
 *   docker save lastlight-sandbox:latest -o /tmp/smol-img.tar   # export it
 *   # …point SMOLVM_IMAGE at that archive (loads offline under the strict
 *   #   allowlist), or any image with agentic-pi + node + git baked in.
 *   RUN_SMOL_IT=1 SMOLVM_IMAGE=/tmp/smol-img.tar \
 *     npx vitest run tests/sandbox/smol.integration.test.ts
 *
 * Each command phase boots + tears down its own micro-VM, so these are slow —
 * hence the long per-test timeout.
 */

const RUN =
  process.env.RUN_SMOL_IT === "1" &&
  !!process.env.SMOLVM_IMAGE &&
  smolAvailable();

const TIMEOUT = 180_000;

let stateDir: string;

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

function smolConfig(): ExecutorConfig {
  return {
    sandbox: "smol",
    stateDir,
    sessionsDir: join(stateDir, "agent-sessions"),
  };
}

describe.skipIf(!RUN)("smol micro-VM command execution (integration)", () => {
  beforeAll(() => {
    const base = join(process.cwd(), "data", "smol-it");
    mkdirSync(base, { recursive: true });
    stateDir = mkdtempSync(join(base, "run-"));
  });

  afterAll(() => {
    if (stateDir) rmSync(stateDir, { recursive: true, force: true });
  });

  it("runs a no-AI bash workflow in the VM and threads output downstream", async () => {
    const wf: AgentWorkflowDefinition = {
      kind: "agent",
      name: "smol-it-bash",
      phases: [
        { name: "phase_0", type: "context" },
        // Write + read back a file in the mounted workspace, then emit a single
        // line (so it's forwarded as LL_OUT_EMIT, which is single-line only).
        { name: "emit", type: "bash", command: "echo hi > marker && [ \"$(cat marker)\" = hi ] && echo hello-from-smol", output_var: "greeting" },
        { name: "consume", type: "bash", command: "echo template={{phaseOutputs.emit}} env=$LL_OUT_EMIT" },
      ],
    };

    const result = await runWorkflow(wf, baseCtx("smol-it-bash-1"), smolConfig(), {});

    expect(result.success).toBe(true);
    const emit = result.phases.find((p) => p.phase === "emit");
    expect(emit?.success).toBe(true);
    expect(emit?.output).toContain("hello-from-smol");

    const consume = result.phases.find((p) => p.phase === "consume");
    expect(consume?.success).toBe(true);
    expect(consume?.output).toContain("env=hello-from-smol");

    // The command run is mirrored to a session jsonl, exactly like an agent turn.
    const projects = join(stateDir, "agent-sessions", "projects");
    expect(existsSync(projects)).toBe(true);
    const jsonls = readdirSync(projects, { recursive: true } as never).filter((f: string) => String(f).endsWith(".jsonl"));
    expect(jsonls.length).toBeGreaterThan(0);
  }, TIMEOUT);

  it("fails the workflow when a bash phase exits non-zero", async () => {
    const wf: AgentWorkflowDefinition = {
      kind: "agent",
      name: "smol-it-fail",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "boom", type: "bash", command: "echo nope >&2; exit 3" },
      ],
    };

    const result = await runWorkflow(wf, baseCtx("smol-it-fail-1"), smolConfig(), {});

    expect(result.success).toBe(false);
    expect(result.phases.find((p) => p.phase === "boom")?.success).toBe(false);
  }, TIMEOUT);

  it("enforces the native egress allowlist (on-list ok, off-list blocked)", async () => {
    // github.com is in DEFAULT_ALLOWLIST → reachable; example.com is not →
    // smolvm's --allow-host blocks it (DNS sinkhole), so the fetch exits
    // non-zero and the phase fails. curl-or-wget keeps this image-portable
    // (the lastlight-sandbox image has curl; a bare alpine archive has wget).
    const fetch = (url: string) =>
      `curl -fsS --max-time 15 ${url} >/dev/null 2>&1 || wget -q -T 15 -O /dev/null ${url}`;
    const onList: AgentWorkflowDefinition = {
      kind: "agent",
      name: "smol-it-egress-ok",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "fetch", type: "bash", command: fetch("https://github.com") },
      ],
    };
    const okResult = await runWorkflow(onList, baseCtx("smol-it-egress-ok-1"), smolConfig(), {});
    expect(okResult.success).toBe(true);

    const offList: AgentWorkflowDefinition = {
      kind: "agent",
      name: "smol-it-egress-block",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "fetch", type: "bash", command: fetch("https://example.com") },
      ],
    };
    const blockResult = await runWorkflow(offList, baseCtx("smol-it-egress-block-1"), smolConfig(), {});
    expect(blockResult.success).toBe(false);
  }, TIMEOUT);
});
