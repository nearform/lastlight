import { defineConfig, configDefaults } from "vitest/config";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

/**
 * The real opengrep on THIS machine, resolved the way `resolveToolBin` does
 * (override → PATH → the image's baked dir), here in the config process where
 * the developer's real environment is still visible.
 */
function realTool(tool: string): string {
  const override = process.env[`LASTLIGHT_${tool.toUpperCase()}_BIN`];
  const candidates = [
    ...(override ? [override] : []),
    ...(process.env.PATH ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, tool)),
    join("/opt/lastlight/bin", tool),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return "";
}

/** A path that is never executable: `resolveToolBin` reads it as "absent". */
const NO_TOOL = "/nonexistent/lastlight-test-disabled";

export default defineConfig({
  test: {
    // VITEST_MAX_WORKERS caps the fork pool. Unset keeps vitest's default (one
    // worker per core). The guardrails gate sets it: inside the sandbox every
    // package's suite runs at once under turbo, each seeing every HOST core
    // (docker gets --memory but no --cpus), and the oversubscription made a 4 s
    // test time out at 60 s (issue #388).
    ...(process.env.VITEST_MAX_WORKERS ? { maxWorkers: Number(process.env.VITEST_MAX_WORKERS) } : {}),
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
    // Fixture repos are real `git init` trees built in `beforeAll`, and the
    // ts-morph passes over them are not fast. The default 5 s times out on a
    // cold machine and reads as a flake rather than as a slow test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Scanners are OFF for every test unless the test opts in (issue #388).
    // `patterns` — and so every `all` run — used to shell out to whatever
    // opengrep/gitleaks the machine had: ~2.4 s per run on a laptop that has
    // them, nothing on CI that doesn't, so the same test ran different code in
    // each place and `invariants.test.ts` alone paid for ~18 scanner runs.
    // A set-but-unexecutable override resolves as absent BEFORE PATH and the
    // baked dir, so this holds inside the sandbox image too. The real binary
    // rides along under a test-only name for the suites that exist to run it
    // (rules.test.ts, opengrep-locale.test.ts); patterns.test.ts uses stubs.
    env: {
      LASTLIGHT_OPENGREP_BIN: NO_TOOL,
      LASTLIGHT_GITLEAKS_BIN: NO_TOOL,
      LASTLIGHT_TEST_OPENGREP_BIN: realTool("opengrep"),
    },
  },
});
