/**
 * Integration test: run() + --sandbox gondolin + --sandbox-image <path>.
 *
 * Skipped unless:
 *   - OPENAI_API_KEY is set
 *   - preflight check succeeds (QEMU + accelerator available)
 *   - A locally-built agentic-pi-dev image dir is present
 *     (./images/agentic-pi-dev/out-<host-arch>/)
 *
 * Verifies that the custom image is what actually boots: `git --version`
 * and `gh --version` only succeed when the agentic-pi-dev image is in use
 * — they're not in gondolin's stock alpine-base.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { arch } from "node:os";

import { run } from "../src/index.js";
import { preflightGondolin } from "../src/sandbox/preflight.js";

const HAS_OPENAI = !!process.env.OPENAI_API_KEY;
const PREFLIGHT = preflightGondolin();

function hostGondolinArch(): "aarch64" | "x86_64" | null {
  const a = arch();
  if (a === "arm64") return "aarch64";
  if (a === "x64") return "x86_64";
  return null;
}

const HOST_ARCH = hostGondolinArch();
const IMAGE_PATH = HOST_ARCH
  ? resolve(import.meta.dirname, "..", "images", "agentic-pi-dev", `out-${HOST_ARCH}`)
  : null;
const HAS_IMAGE = !!IMAGE_PATH && existsSync(IMAGE_PATH);

const skipReason = !HAS_OPENAI
  ? "OPENAI_API_KEY not set"
  : !PREFLIGHT.ok
    ? `gondolin preflight failed: ${PREFLIGHT.reason}`
    : !HAS_IMAGE
      ? `local agentic-pi-dev image not built (expected at ${IMAGE_PATH ?? "<unknown-arch>"})`
      : false;

describe("run() + --sandbox gondolin + --sandbox-image <local-path>", { skip: skipReason }, () => {
  test("git and gh are available inside the custom image", async () => {
    const workspace = "/tmp/agentic-pi-sandbox-image-integration-test";
    rmSync(workspace, { recursive: true, force: true });
    mkdirSync(workspace, { recursive: true });

    const result = await run({
      model: "openai/gpt-5.4-nano",
      prompt:
        "use the bash tool to run exactly `git --version && gh --version` and report what it prints",
      thinking: "off",
      noSession: true,
      sandbox: "gondolin",
      sandboxImage: IMAGE_PATH!,
      cwd: workspace,
    });

    assert.equal(
      result.ok,
      true,
      `run failed: ${result.fatalError?.message ?? "(no error message)"}`,
    );
    assert.equal(result.sandbox?.backend, "gondolin");

    const image = (result.sandbox?.status as { image?: { source?: string; name?: string } })?.image;
    assert.equal(image?.source, "local-path");
    assert.equal(image?.name, `out-${HOST_ARCH}`);

    const bashEnds = result.records.filter(
      (r) => r.type === "tool_execution_end" && (r as { toolName?: string }).toolName === "bash",
    );
    const bashOutputs = JSON.stringify(bashEnds);
    assert.ok(
      /git version/i.test(bashOutputs),
      `expected 'git version' in bash output; got: ${bashOutputs.slice(0, 500)}`,
    );
    assert.ok(
      /gh version/i.test(bashOutputs),
      `expected 'gh version' in bash output; got: ${bashOutputs.slice(0, 500)}`,
    );

    rmSync(workspace, { recursive: true, force: true });
  });
});
