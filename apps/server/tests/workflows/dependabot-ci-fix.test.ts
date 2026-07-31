import { describe, it, expect } from "vitest";
import { getWorkflow, getCronWorkflows, getWorkflowByIntent } from "#src/workflows/loader.js";

/**
 * Contract test for the built-in dependabot-ci-fix workflow + its red-PR cron
 * backstop. Loads the REAL workflows/ dir (like dependabot-pr-merge.test.ts) so a
 * schema break or an accidental rewiring of the intent / cron is caught.
 */
describe("dependabot-ci-fix — built-in workflow + cron", () => {
  it("loads with diagnose → fix and the dependabot-ci-fix intent", () => {
    const def = getWorkflow("dependabot-ci-fix");
    expect(def.name).toBe("dependabot-ci-fix");
    expect(def.classification?.intent).toBe("dependabot-ci-fix");
    // Diagnose-then-fix: the cheap classification runs BEFORE the expensive
    // install + test cycle. Still fix-only — it never classifies/labels/merges;
    // once its push turns checks green, `dependabot-pr-merge` owns that
    // decision (see router pr.checks_passed).
    expect(def.phases.map((p) => p.name)).toEqual(["diagnose", "fix"]);
  });

  it("gates both phases on a completion marker", () => {
    const def = getWorkflow("dependabot-ci-fix");
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    expect(byName.get("diagnose")?.on_output?.requires_marker).toBe("DIAGNOSIS_COMPLETE");
    // Closes the missing-postcondition gap: a run that inspects the PR and
    // stops without pushing or labelling used to report green.
    expect(byName.get("fix")?.on_output?.requires_marker).toBe("CI_FIX_COMPLETE");
  });

  it("skips the fix phase on the three non-fixable diagnosis classes", () => {
    const def = getWorkflow("dependabot-ci-fix");
    const fix = def.phases.find((p) => p.name === "fix")!;
    // A NON-FAILING skip, deliberately not `on_output.contains_BLOCKED:
    // {action: fail}`: `failed` is reserved for malfunction, and correctly
    // determining a PR can't be fixed here is a succeeded run.
    expect(fix.skip_if).toEqual([
      "phaseOutputs.diagnosis.contains('class=flaky')",
      "phaseOutputs.diagnosis.contains('class=infra-dependent')",
      "phaseOutputs.diagnosis.contains('class=upstream-broken')",
    ]);
    expect(fix.messages?.on_skipped_done).toBeTruthy();
  });

  it("runs diagnose on `fixing` and fix on `fixing` + `building`", () => {
    const def = getWorkflow("dependabot-ci-fix");
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    expect(byName.get("diagnose")?.skill).toBe("fixing");
    expect(byName.get("diagnose")?.output_var).toBe("diagnosis");
    // `fixing` first — the runner directs the agent to the primary skill.
    expect(byName.get("fix")?.skills).toEqual(["fixing", "building"]);
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
