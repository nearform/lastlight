// The PhaseExecutor now lives in the workflow engine
// (`workflow-engine/core/phase-executor.ts`). This one-line re-export keeps the
// old `src/workflows/phase-executor.js` import path (runner, tests via the
// `#src/workflows/phase-executor.js` alias) resolving unchanged.
export * from "@lastlight/workflow-engine";
