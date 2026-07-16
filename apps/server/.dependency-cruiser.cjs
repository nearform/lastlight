/**
 * App-side belt for the extracted workflow engine (Phase 3 Milestone B).
 *
 * The engine now lives in its own package (@lastlight/workflow-engine) whose
 * self-containment is enforced by packages/workflow-engine/.dependency-cruiser.cjs.
 * This belt keeps the app honest from its side: import the engine only via its
 * public barrel (or /test-support) — never a deep `dist/core|ports` path — so
 * the package's export surface stays the contract.
 *
 *   pnpm --filter @lastlight/core run lint:boundaries
 */
module.exports = {
  forbidden: [
    {
      name: "engine-barrel-only",
      severity: "error",
      comment:
        "Import @lastlight/workflow-engine via its barrel (or /test-support) — never a deep dist/core|ports path.",
      from: { path: "^src/" },
      to: { path: "@lastlight/workflow-engine/dist/(core|ports)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
