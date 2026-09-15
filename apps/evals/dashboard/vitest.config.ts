import { defineConfig } from "vitest/config";

/**
 * `environment: "node"` on purpose: everything worth testing here is pure logic
 * (metric roll-ups, repeat grouping, route parsing), and the highest-value test
 * — client vs. harness `summarizeModels` — has to import the harness's own
 * `src/report.ts`, which reads the filesystem. jsdom would buy nothing and cost
 * the ability to run that comparison.
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
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
