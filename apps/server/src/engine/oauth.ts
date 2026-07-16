/**
 * Re-export shim. The OAuth layer now lives in `@lastlight/shared` (the CLI's
 * `oauth login` and the harness both use it). This file preserves the original
 * `#src/engine/oauth.js` import path so the many in-tree importers — and the
 * `vi.mock("#src/engine/oauth.js")` targets in the test suite — keep resolving
 * to the same module singleton. See docs/plans/monorepo-migration Phase 4.
 */
export * from "@lastlight/shared/oauth";
