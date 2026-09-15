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
    // Only our own harness tests (the deterministic, AI-free `mechanism.test.ts`
    // seam guard) plus the read-only `scripts/` measurement tools, whose own
    // arithmetic — arm selection, the repeat-group audit, argv — is a way to get
    // a published number wrong. `datasets/**` holds code-fix FIXTURE tests —
    // held-out tests run inside a seeded workspace at grade time, never
    // collected here.
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "datasets/**"],
  },
});
