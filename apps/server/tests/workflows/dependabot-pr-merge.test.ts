import { describe, it, expect } from "vitest";
import { getWorkflow, getCronWorkflows, getWorkflowByIntent } from "#src/workflows/loader.js";

/**
 * Contract test for the built-in dependabot-pr-merge workflow + its cron sweep.
 * Loads the REAL workflows/ dir (like golden-build.test.ts) so a schema break or
 * an accidental rewiring of the intent / cron is caught.
 */
describe("dependabot-pr-merge — built-in workflow + cron", () => {
  it("loads with a single assess phase and the dependabot-pr-merge intent", () => {
    const def = getWorkflow("dependabot-pr-merge");
    expect(def.name).toBe("dependabot-pr-merge");
    expect(def.classification?.intent).toBe("dependabot-pr-merge");
    expect(def.phases.map((p) => p.name)).toEqual(["assess"]);
    expect(def.phases[0].prompt).toBe("prompts/dependabot-pr-merge.md");
  });

  it("gates the assess phase on a completion marker (no silent no-op successes)", () => {
    // The postcondition that turns an empty/overflow-retry run RED instead of a
    // false green — its absence is the bug this workflow keeps hitting.
    const def = getWorkflow("dependabot-pr-merge");
    expect(def.phases[0].on_output?.requires_marker).toBe("ASSESSMENT_COMPLETE");
  });

  it("is resolvable by intent (the router's deterministic pr.checks_passed route)", () => {
    expect(getWorkflowByIntent("dependabot-pr-merge")?.name).toBe("dependabot-pr-merge");
  });

  it("registers a per-PR discovery cron that always runs (no webhooksEnabled gate)", () => {
    const cron = getCronWorkflows().find((c) => c.workflow === "dependabot-pr-merge");
    expect(cron).toBeDefined();
    // The cron runner (src/index.ts) keys the per-PR fan-out off this flag —
    // find green dependency PRs in code, dispatch one bounded run each. The old
    // `mode: scan` agent sweep (which overflowed on busy repos) is retired.
    expect(cron!.context?.discover).toBe("green-dependency-prs");
    expect(cron!.context?.mode).toBeUndefined();
    // Intentionally NOT gated on webhooksEnabled — the backstop runs alongside
    // the real-time pr.checks_passed webhook (auto-merge is idempotent).
    expect(cron!.condition?.unless).toBeUndefined();
  });
});
