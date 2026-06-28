import { defineConfig, configDefaults } from "vitest/config";
import { resolve } from "path";
import { fileURLToPath } from "url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "#src": resolve(__dirname, "src"),
    },
  },
  test: {
    environment: "node",
    // Default suite: tests/ tree (mirrors src/). The eval HARNESS now lives in
    // the separate `lastlight-evals` package; core keeps just the slim seam guard
    // (`tests/engine/agent-executor.seam.test.ts`) proving it still forwards
    // `githubApiBaseUrl` into agentic-pi.
    include: ['tests/**/*.test.ts'],
    exclude: [...configDefaults.exclude],
    // Force LASTLIGHT_LOCAL_DEV=1 so any test that touches configureGitAuth
    // (or imports a code path that does) skips the `git config --global`
    // writes that would otherwise overwrite the contributor's real git
    // identity with `last-light[bot]`. Existing tests that explicitly
    // exercise the global-write path can still `delete process.env.LASTLIGHT_LOCAL_DEV`
    // in beforeEach (see tests/engine/git-auth.test.ts).
    env: {
      LASTLIGHT_LOCAL_DEV: "1",
    },
  },
});
