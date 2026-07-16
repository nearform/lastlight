/**
 * Re-export shim. The workflow/asset loader now lives in `@lastlight/shared`
 * (both the CLI's `fork` and the harness use it). This file preserves the
 * original `#src/workflows/loader.js` import path so the many in-tree importers
 * — and the `vi.mock("#src/workflows/loader.js")` targets in the test suite —
 * keep resolving to the same module singleton (its layer/cache state is
 * process-global). See docs/plans/monorepo-migration Phase 4.
 */
export * from "@lastlight/shared/workflow-loader";
