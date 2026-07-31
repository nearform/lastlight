import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";

/**
 * Contract test for the built-in pr-fix workflow. It carries the same
 * diagnose-then-fix shape as `dependabot-ci-fix` (both are in
 * `PR_FIX_SHAPED_WORKFLOWS`, so anything keyed off that set must improve them
 * together) but had no contract test at all until now — the divergence would
 * have been silent.
 */
describe("pr-fix — built-in workflow", () => {
  const def = getWorkflow("pr-fix");

  it("loads with diagnose → fix", () => {
    expect(def.name).toBe("pr-fix");
    expect(def.phases.map((p) => p.name)).toEqual(["diagnose", "fix"]);
  });

  it("gates both phases on a completion marker", () => {
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    expect(byName.get("diagnose")?.on_output?.requires_marker).toBe("DIAGNOSIS_COMPLETE");
    expect(byName.get("fix")?.on_output?.requires_marker).toBe("CI_FIX_COMPLETE");
  });

  it("skips the fix phase on the three non-fixable diagnosis classes", () => {
    const fix = def.phases.find((p) => p.name === "fix")!;
    expect(fix.skip_if).toEqual([
      "phaseOutputs.diagnosis.contains('class=flaky')",
      "phaseOutputs.diagnosis.contains('class=infra-dependent')",
      "phaseOutputs.diagnosis.contains('class=upstream-broken')",
    ]);
    expect(fix.messages?.on_skipped_done).toBeTruthy();
  });

  it("runs diagnose on `fixing` and fix on `fixing` + `building`", () => {
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    expect(byName.get("diagnose")?.skill).toBe("fixing");
    expect(byName.get("diagnose")?.output_var).toBe("diagnosis");
    expect(byName.get("fix")?.skills).toEqual(["fixing", "building"]);
  });

  it("matches dependabot-ci-fix's fix-phase gating (PR_FIX_SHAPED_WORKFLOWS parity)", () => {
    const dep = getWorkflow("dependabot-ci-fix");
    const pick = (d: typeof def) => {
      const fix = d.phases.find((p) => p.name === "fix")!;
      return { skills: fix.skills, skip_if: fix.skip_if, marker: fix.on_output?.requires_marker };
    };
    expect(pick(def)).toEqual(pick(dep));
  });
});
