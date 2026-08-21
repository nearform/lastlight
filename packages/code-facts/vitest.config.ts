import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "tests/fixtures/**"],
    // Fixture repos are real `git init` trees built in `beforeAll`, and the
    // ts-morph passes over them are not fast. The default 5 s times out on a
    // cold machine and reads as a flake rather than as a slow test.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
