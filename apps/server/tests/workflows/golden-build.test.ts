import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";
import { buildDag, getReadyNodes, getNodesToSkip, isComplete } from "#src/workflows/dag.js";

/**
 * Golden test: the unified scheduler must execute `build.yaml` in exactly the
 * same phase order as the old linear runner. build.yaml declares no
 * `depends_on`, so chain synthesis must reproduce its declaration order as a
 * sequential chain. If this order ever changes, the build cycle's contract
 * (architect → executor → reviewer → pr) has shifted — fail loudly.
 */
describe("golden — build.yaml phase sequence is unchanged under the unified scheduler", () => {
  it("schedules build phases in declaration order", () => {
    const def = getWorkflow("build");
    const declared = def.phases.map((p) => p.name);

    // build.yaml is a linear workflow — no explicit edges.
    expect(def.phases.every((p) => !p.depends_on?.length)).toBe(true);

    // Simulate the scheduler: chain-synthesize, then repeatedly run the
    // earliest-declared ready node (sequential), collecting the visit order.
    const dag = buildDag(def.phases, { chainIfNoDeps: true });
    const order: string[] = [];
    let guard = 0;
    while (!isComplete(dag) && guard++ < 100) {
      for (const n of getNodesToSkip(dag)) n.status = "skipped";
      const ready = getReadyNodes(dag);
      if (ready.length === 0) break;
      const node = ready[0];
      order.push(node.name);
      node.status = "succeeded";
    }

    expect(order).toEqual(declared);
    // Pin the actual phase names so an accidental rename/reorder is caught.
    expect(declared).toEqual(["phase_0", "guardrails", "guardrails_gate", "architect", "executor", "reviewer", "pr"]);
  });

  it("synthesizes a previous-phase chain for build.yaml", () => {
    const def = getWorkflow("build");
    const dag = buildDag(def.phases, { chainIfNoDeps: true });
    expect(dag[0].depends_on).toEqual([]);
    for (let i = 1; i < dag.length; i++) {
      expect(dag[i].depends_on).toEqual([def.phases[i - 1].name]);
    }
  });
});
