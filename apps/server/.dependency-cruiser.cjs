/**
 * Boundary gate for the extracted workflow engine (Phase 3 /
 * workflow-engine-extraction-design §7). The engine at `src/workflow-engine`
 * must stay domain-agnostic: it may import only its own tree, `zod`, and node
 * built-ins — never the app layer (engine/state/notify/admin/connectors/config/
 * sandbox/cli/cron/telemetry) or heavy externals (better-sqlite3, octokit, …).
 *
 *   pnpm --filter lastlight run lint:boundaries
 */
module.exports = {
  forbidden: [
    {
      name: "engine-no-app-imports",
      severity: "error",
      comment:
        "src/workflow-engine must not import the app layer — invert the coupling into a port (ports/ports.ts).",
      from: { path: "^src/workflow-engine" },
      to: {
        path: "^src/",
        pathNot: "^src/workflow-engine/",
      },
    },
    {
      name: "engine-externals-zod-only",
      severity: "error",
      comment:
        "src/workflow-engine's only allowed external is zod (+ node built-ins). Anything else (better-sqlite3, octokit, agentic-pi, slack, hono, otel, …) is an app-layer concern behind a port.",
      from: { path: "^src/workflow-engine" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg"],
        pathNot: "node_modules/zod/",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    // Catch type-only imports too — the Milestone-B package lift makes a
    // type-only app import unresolvable, so forbid it now.
    tsPreCompilationDeps: true,
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default", "types"],
    },
  },
};
