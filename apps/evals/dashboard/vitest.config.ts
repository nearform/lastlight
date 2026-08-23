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
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
