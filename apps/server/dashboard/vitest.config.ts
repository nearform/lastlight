import { defineConfig, configDefaults } from "vitest/config";

/**
 * Pure-function tests only — no DOM.
 *
 * The board's logic was deliberately extracted DOM-free (`cardActions.ts`,
 * `sortGatedFirst`, `isGated`, `timeAgo`, and `LabelChip` called as the plain
 * function it is), so this package needs no jsdom and no testing-library: the
 * `node` environment plus esbuild's JSX transform is the whole setup. A test
 * that needed to RENDER would need jsdom + @testing-library/react added here
 * first; don't reach for them to test something that could be a function.
 */
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
    exclude: [...configDefaults.exclude],
  },
});
