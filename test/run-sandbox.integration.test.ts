/**
 * Integration test: run() + --sandbox gondolin against a real LLM and QEMU.
 *
 * Skipped unless:
 *   - OPENAI_API_KEY is set
 *   - preflight check succeeds (QEMU + accelerator available)
 *
 * Verifies that:
 *   - The sandbox boots and the agent's `write` tool routes through it.
 *   - Side effects (files) appear on the host via the RealFSProvider mount.
 *   - The sandbox_status event reports the gondolin backend.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";

import { run } from "../src/index.js";
import { preflightGondolin } from "../src/sandbox/preflight.js";

const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const PREFLIGHT = preflightGondolin();

const skipReason = !HAS_OPENAI
  ? "OPENAI_API_KEY not set"
  : !PREFLIGHT.ok
    ? `gondolin preflight failed: ${PREFLIGHT.reason}`
    : false;

describe("run() + --sandbox gondolin", { skip: skipReason }, () => {
  test("VM-routed write tool produces a file on the host", async () => {
    const workspace = "/tmp/agentic-pi-sandbox-integration-test";
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = await run({
      model: "openai/gpt-5.4-nano",
      prompt:
        "use the write tool to create a file called report.md containing exactly the text 'sandbox+programmatic ok'",
      thinking: "off",
      noSession: true,
      sandbox: "gondolin",
      cwd: workspace,
    });

    assert.equal(
      result.ok,
      true,
      `run failed: ${result.fatalError?.message ?? "(no error message)"}`,
    );
    assert.equal(result.agentEnded, true);
    assert.equal(result.sandbox?.backend, "gondolin");
    assert.equal((result.sandbox?.status as { guestPath?: string })?.guestPath, "/workspace");

    const reportPath = `${workspace}/report.md`;
    assert.ok(existsSync(reportPath), "agent's write tool did not produce the host file");
    assert.equal(readFileSync(reportPath, "utf8").trim(), "sandbox+programmatic ok");

    // The agent should have used the `write` tool (or `bash`, but the
    // prompt was specific). Either is acceptable; we assert >= 1 tool call.
    const toolCalls = result.records.filter((r) => r.type === "tool_execution_start");
    assert.ok(toolCalls.length > 0, "expected at least one tool_execution_start");

    rmSync(workspace, { recursive: true, force: true });
  });

  test("sandboxEnv is visible inside the VM via bash", async () => {
    const workspace = "/tmp/agentic-pi-sandbox-env-test";
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = await run({
      model: "openai/gpt-5.4-nano",
      prompt:
        'use the bash tool to run `echo "AGENTIC_PI_SENTINEL=$AGENTIC_PI_SENTINEL"` and report exactly what it prints',
      thinking: "off",
      noSession: true,
      sandbox: "gondolin",
      cwd: workspace,
      sandboxEnv: { AGENTIC_PI_SENTINEL: "marker-value-9f3c" },
    });

    assert.equal(
      result.ok,
      true,
      `run failed: ${result.fatalError?.message ?? "(no error message)"}`,
    );
    assert.equal(result.sandbox?.backend, "gondolin");

    // The status echoes back which keys were injected (values omitted
    // for safety) so consumers can verify wiring without snooping creds.
    const envKeys = (result.sandbox?.status as { envKeys?: string[] })?.envKeys;
    assert.ok(envKeys?.includes("AGENTIC_PI_SENTINEL"));

    // The agent ran bash; its output should include the marker value.
    const bashEnds = result.records.filter(
      (r) => r.type === "tool_execution_end" && (r as { toolName?: string }).toolName === "bash",
    );
    assert.ok(bashEnds.length > 0, "expected at least one bash tool_execution_end");
    const bashOutputs = JSON.stringify(bashEnds);
    assert.ok(
      bashOutputs.includes("marker-value-9f3c"),
      `bash output should include the sandbox env value; got: ${bashOutputs.slice(0, 500)}`,
    );

    rmSync(workspace, { recursive: true, force: true });
  });
});
