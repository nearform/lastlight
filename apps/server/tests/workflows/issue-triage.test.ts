import { describe, it, expect } from "vitest";
import { getWorkflow, getWorkflowByIntent } from "#src/workflows/loader.js";

/**
 * Contract test for the built-in issue-triage workflow. Loads the REAL
 * workflows/ dir (like golden-build.test.ts) so a schema break or a dropped
 * postcondition is caught.
 */
describe("issue-triage — built-in workflow", () => {
  it("loads with a single triage phase using the issue-triage skill", () => {
    const def = getWorkflow("issue-triage");
    expect(def.name).toBe("issue-triage");
    expect(def.phases.map((p) => p.name)).toEqual(["triage"]);
    expect(def.phases[0].skill).toBe("issue-triage");
  });

  it("gates the triage phase on a completion marker (no silent no-op successes)", () => {
    // Without this, an agent that bails — e.g. the k8s sandbox exposed no
    // github_* tools, so it couldn't list/label issues and just explained it
    // couldn't proceed — still scored `succeeded`. The marker turns that
    // bail-out RED (the skill only emits it after doing the work).
    const def = getWorkflow("issue-triage");
    expect(def.phases[0].on_output?.requires_marker).toBe("TRIAGE_COMPLETE");
  });

  it("is resolvable by the triage intent", () => {
    expect(getWorkflowByIntent("triage")?.name).toBe("issue-triage");
  });
});
