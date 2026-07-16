import { describe, it, expect } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { WorkflowStateStore } from "@lastlight/workflow-engine";

/**
 * Compile-time fence (extraction design §7): `StateDb satisfies
 * WorkflowStateStore`. A future `StateDb` change that drops or renames a method
 * the engine's store port depends on surfaces here as a tsc error rather than a
 * runtime surprise. The production composition root (`runner.ts`, `store: db`)
 * enforces the same assignability under the main `typecheck` task; this pins it
 * explicitly.
 */
type Assert<T extends true> = T;
type _StateDbSatisfiesStore = Assert<StateDb extends WorkflowStateStore ? true : false>;

// A value-level witness too, so the assignability is exercised even where only
// values (not the type alias above) are checked.
const _witness: WorkflowStateStore = null as unknown as StateDb;

describe("StateDb satisfies WorkflowStateStore", () => {
  it("compiles — the assignability above is the fence", () => {
    expect(_witness).toBeNull();
  });
});
