/**
 * Integration test: `authFile` is honored for model authentication.
 *
 * Proves the credential store passed via `RunOptions.authFile` (→ CLI
 * `--auth-file`) is what Pi's AuthStorage reads. AuthStorage's precedence is
 * `api_key from auth.json` (2) > `environment variable` (4), so we put the REAL
 * key ONLY in the auth file and set a BOGUS `OPENAI_API_KEY` in the env: if the
 * run authenticates, the auth file was used (a bogus env key would 401).
 *
 * This is the same mechanism OAuth providers (Codex / Claude Pro / Copilot)
 * ride on — an OAuth `auth.json` entry resolves the same way — but it's tested
 * with an api_key credential so it needs no subscription login in CI.
 *
 * Gated on OPENAI_API_KEY (like the other integration tests).
 */
import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../src/index.js";

const REAL_OPENAI_KEY = process.env.OPENAI_API_KEY;

describe("run() — authFile credential store", {
  skip: REAL_OPENAI_KEY ? false : "OPENAI_API_KEY not set (integration test)",
}, () => {
  test("reads the model key from --auth-file, not the environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agpi-authfile-"));
    const authFile = join(dir, "auth.json");
    writeFileSync(authFile, JSON.stringify({ openai: { type: "api_key", key: REAL_OPENAI_KEY } }));

    // Poison the env key: AuthStorage must prefer the auth file. If authFile
    // were ignored, the run would fall back to this bogus key and 401.
    const savedEnv = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-bogus-must-not-be-used";
    try {
      const result = await run({
        model: "openai/gpt-5.4-nano",
        prompt: "say 'authfile works' verbatim and nothing else",
        thinking: "off",
        noSession: true,
        authFile,
      });
      assert.equal(result.ok, true, `run failed: ${JSON.stringify(result.warnings)}`);
      assert.equal(result.agentEnded, true);
      assert.ok(
        result.finalText.toLowerCase().includes("authfile works"),
        `expected the phrase, got: ${result.finalText}`,
      );
    } finally {
      process.env.OPENAI_API_KEY = savedEnv;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
