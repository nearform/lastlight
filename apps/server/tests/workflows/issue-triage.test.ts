import { describe, it, expect } from "vitest";
import { getWorkflow, getWorkflowByIntent, getCronWorkflows } from "#src/workflows/loader.js";

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

  it("is dispatched by the triage-new-issues cron, so the marker covers cron runs too", () => {
    // The every-15-min scan (webhooks-disabled backstop) is exactly the
    // batch/cron path that produced the false-green bail this marker fixes. If
    // this `workflow:` wiring drifts — a rename, an accidental edit — the marker
    // enforcement silently stops applying to cron-triggered runs, and nothing
    // else catches it. (Mirrors dependabot-pr-merge.test.ts's cron coverage.)
    const cron = getCronWorkflows().find((c) => c.workflow === "issue-triage");
    expect(cron).toBeDefined();
    expect(cron!.name).toBe("triage-new-issues");
    expect(cron!.context?.mode).toBe("scan");
  });
});
