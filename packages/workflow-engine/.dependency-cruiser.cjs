/**
 * Package-local boundary gate for @lastlight/workflow-engine. The engine may
 * import only its own `src/**` tree, `zod`, and node built-ins — never any
 * other package or heavy external. (The app-side belt lives in
 * apps/server/.dependency-cruiser.cjs.)
 *
 *   pnpm --filter @lastlight/workflow-engine run lint:boundaries
 */
module.exports = {
  forbidden: [
    {
      name: "engine-externals-zod-only",
      severity: "error",
      comment:
        "The workflow engine's only allowed external is zod (+ node built-ins). Everything else is an app-layer concern behind a port.",
      from: { path: "^src/" },
      to: {
        dependencyTypes: ["npm", "npm-dev", "npm-optional", "npm-peer", "npm-no-pkg"],
        // zod is the only runtime external; @types/node provides the node
        // built-in type declarations (node:crypto, …).
        pathNot: "node_modules/(zod|@types/node)/",
      },
    },
    {
      name: "engine-self-contained",
      severity: "error",
      comment: "The workflow engine must not reach outside its own src/ tree.",
      from: { path: "^src/" },
      to: {
        path: "^\\.\\.",
        // node_modules externals are governed by the zod-only rule above; this
        // rule guards against reaching a sibling source tree via `../`.
        pathNot: "node_modules",
      },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    tsPreCompilationDeps: true,
  },
};
