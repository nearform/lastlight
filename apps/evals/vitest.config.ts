import { defineConfig, configDefaults } from "vitest/config";

export default defineConfig({
  test: {
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
