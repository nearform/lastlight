import { describe, it, expect } from "vitest";
import { getWorkflow, getCronWorkflows, getWorkflowByIntent } from "#src/workflows/loader.js";

/**
 * Contract test for the built-in dependabot-ci-fix workflow + its red-PR cron
 * backstop. Loads the REAL workflows/ dir (like dependabot-pr-merge.test.ts) so a
 * schema break or an accidental rewiring of the intent / cron is caught.
 */
describe("dependabot-ci-fix — built-in workflow + cron", () => {
  it("loads with a single fix phase and the dependabot-ci-fix intent", () => {
    const def = getWorkflow("dependabot-ci-fix");
    expect(def.name).toBe("dependabot-ci-fix");
    expect(def.classification?.intent).toBe("dependabot-ci-fix");
    // Fix-only: it never classifies/labels/merges — once its push turns checks
    // green, `dependabot-pr-merge` owns that decision (see router pr.checks_passed).
    expect(def.phases.map((p) => p.name)).toEqual(["fix"]);
  });

  it("is resolvable by intent (the router's pr.checks_failed fallback route)", () => {
    expect(getWorkflowByIntent("dependabot-ci-fix")?.name).toBe("dependabot-ci-fix");
  });

  it("registers a per-PR red-discovery cron that always runs (no webhooksEnabled gate)", () => {
    const cron = getCronWorkflows().find((c) => c.workflow === "dependabot-ci-fix");
    expect(cron).toBeDefined();
    // The cron runner (src/index.ts) keys the per-PR fan-out off this flag — find
    // settled-red dependency PRs in code, dispatch one bounded run each.
    expect(cron!.context?.discover).toBe("red-dependency-prs");
    // Additive backstop alongside the real-time pr.checks_failed webhook.
    expect(cron!.condition?.unless).toBeUndefined();
  });
});
