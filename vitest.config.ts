import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Default suite: src unit tests + the deterministic (AI-free) eval-harness
    // mechanism tests (`evals/**/*.test.ts`). The paid AI eval is a plain
    // script (`evals/run.ts`, run via `npm run eval`), not a test, so a weak
    // model never fails the build. `evals/datasets/**` holds fixture *.test.ts
    // files (held-out tests run inside a seeded workspace) — never collect them.
    include: ['src/**/*.test.ts', 'evals/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'evals/datasets/**'],
    // Force LASTLIGHT_LOCAL_DEV=1 so any test that touches configureGitAuth
    // (or imports a code path that does) skips the `git config --global`
    // writes that would otherwise overwrite the contributor's real git
    // identity with `last-light[bot]`. Existing tests that explicitly
    // exercise the global-write path can still `delete process.env.LASTLIGHT_LOCAL_DEV`
    // in beforeEach (see src/engine/git-auth.test.ts).
    env: {
      LASTLIGHT_LOCAL_DEV: "1",
    },
  },
});
