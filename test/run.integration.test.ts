/**
 * Integration test: run() programmatic API against a real LLM.
 *
 * Skipped unless OPENAI_API_KEY is set. Costs ~$0.001 per run on gpt-5.4-nano.
 *
 * Verifies two contracts that in-process consumers (lastlight) depend on:
 *   1. RunResult is populated correctly and onEvent fires for every record.
 *   2. The library NEVER writes to process.stdout or process.stderr.
 *
 * (2) is checked in a child process so the test runner's own progress
 *     writes don't pollute the assertion.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

import { run } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const CLI_DIST = join(REPO_ROOT, "dist", "index.js");

const HAS_OPENAI = !!process.env.OPENAI_API_KEY;

describe("run() — basic programmatic flow", {
  skip: HAS_OPENAI ? false : "OPENAI_API_KEY not set (integration test)",
}, () => {
  test("returns a populated RunResult and fires onEvent for every record", async () => {
    const liveEvents: string[] = [];
    const liveWarnings: string[] = [];

    const result = await run({
      model: "openai/gpt-5.4-nano",
      prompt: "say 'programmatic mode works' verbatim and nothing else",
      thinking: "off",
      noSession: true,
      onEvent: (record) => liveEvents.push(record.type),
      onWarn: (msg) => liveWarnings.push(msg),
    });

    // Lifecycle
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 0);
    assert.equal(result.agentEnded, true);
    assert.equal(result.toolErrors, false);

    // Identity
    assert.ok(result.sessionId, "sessionId should be populated");
    assert.match(result.sessionId!, /^[a-f0-9-]{36}$/);

    // Output
    assert.ok(
      result.finalText.toLowerCase().includes("programmatic mode works"),
      `expected finalText to include the literal phrase, got: ${result.finalText}`,
    );

    // Stats
    assert.ok(result.stats, "stats should be populated");
    assert.ok(result.stats!.tokens.total > 0);
    assert.ok(result.stats!.cost > 0);

    // Status mirrors
    assert.equal(result.sandbox?.backend, "none");
    assert.equal(result.github?.status, "skipped");
    assert.equal(result.github?.reason, "no-profile");

    // onEvent fires for every record, in order
    assert.equal(liveEvents.length, result.records.length);
    assert.ok(liveEvents.includes("session"));
    assert.ok(liveEvents.includes("agent_start"));
    assert.ok(liveEvents.includes("agent_end"));
    assert.ok(liveEvents.includes("usage_snapshot"));

    // No warnings expected on a clean run.
    assert.equal(liveWarnings.length, 0);
  });

  test("does not write to process.stdout or process.stderr", () => {
    // Spawn a child so the test runner's own reporter output is not
    // counted against our assertion. The child imports the built
    // dist (npm run build must precede `npm test:integration`).
    const inline = `
import { run } from ${JSON.stringify(CLI_DIST)};
await run({
  model: "openai/gpt-5.4-nano",
  prompt: "say 'hi' and nothing else",
  thinking: "off",
  noSession: true,
});
`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", inline], {
      encoding: "utf8",
      env: process.env,
      timeout: 60_000,
    });

    assert.equal(
      child.status,
      0,
      `child exited non-zero (${child.status}). stderr: ${child.stderr}`,
    );
    assert.equal(
      child.stdout,
      "",
      `library wrote to stdout: ${JSON.stringify(child.stdout.slice(0, 500))}`,
    );
    assert.equal(
      child.stderr,
      "",
      `library wrote to stderr: ${JSON.stringify(child.stderr.slice(0, 500))}`,
    );
  });

  test("with OTEL enabled + an unreachable collector, still writes nothing to stdout/stderr", () => {
    // The full runner path with telemetry on, pointed at a dead endpoint.
    // Every export fails; the contract still holds (diagnostics route to
    // onWarn, never the console). Proves the unit-level guard end-to-end.
    const inline = `
import { run } from ${JSON.stringify(CLI_DIST)};
const r = await run({
  model: "openai/gpt-5.4-nano",
  prompt: "say 'hi' and nothing else",
  thinking: "off",
  noSession: true,
  otel: true,
  otelEndpoint: "http://127.0.0.1:1",
});
if (r.telemetry?.status !== "configured") {
  throw new Error("expected telemetry configured, got: " + JSON.stringify(r.telemetry));
}
`;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", inline], {
      encoding: "utf8",
      env: { ...process.env, OTEL_EXPORTER_OTLP_TIMEOUT: "300", OTEL_BSP_SCHEDULE_DELAY: "50" },
      timeout: 60_000,
    });

    assert.equal(
      child.status,
      0,
      `child exited non-zero (${child.status}). stderr: ${child.stderr}`,
    );
    assert.equal(
      child.stdout,
      "",
      `library wrote to stdout: ${JSON.stringify(child.stdout.slice(0, 500))}`,
    );
    assert.equal(
      child.stderr,
      "",
      `library wrote to stderr: ${JSON.stringify(child.stderr.slice(0, 500))}`,
    );
  });
});
