import { defineConfig, configDefaults } from "vitest/config";

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
