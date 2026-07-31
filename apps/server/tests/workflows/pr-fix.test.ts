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
      return {
        skills: fix.skills,
        skip_if: fix.skip_if,
        marker: fix.on_output?.requires_marker,
        loop: fix.generic_loop,
        timeout: fix.timeout_seconds,
      };
    };
    expect(pick(def)).toEqual(pick(dep));
  });
});

/**
 * The within-run local gate loop (04-retry.md §4.5, 09-state-machine.md §S1).
 * Asserted on BOTH fix workflows together — they are one family
 * (`PR_FIX_SHAPED_WORKFLOWS`) and a gate on only one of them is a gate an
 * `@bot fix this` comment can route around.
 */
describe.each(["pr-fix", "dependabot-ci-fix"])("%s — the local push gate", (name) => {
  const fix = getWorkflow(name).phases.find((p) => p.name === "fix")!;

  it("declares the gate loop with a persistent context", () => {
    expect(fix.generic_loop?.max_iterations).toBe(2); // = fix.localIterations
    expect(fix.generic_loop?.fresh_context).toBe(false); // iteration 2 sees iteration 1
    expect(fix.generic_loop?.until).toBeUndefined(); // the SCRIPT is the gate, not prose
  });

  it("carries an explicit, generous timeout_seconds", () => {
    // `runUntilBash` falls back to `phase.timeout_seconds ?? 30`, and 30s kills
    // a real test suite mid-run and reports a false red. The value tracks
    // `fix.gateTimeoutSeconds` in config/default.yaml, which cannot be
    // templated in (the schema parses a plain number).
    expect(fix.timeout_seconds).toBe(900);
    expect(fix.timeout_seconds).toBeGreaterThan(30);
  });

  it("keeps the CI_FIX_COMPLETE postcondition on the looped phase", () => {
    // A `generic_loop` used to silently drop `on_output` — the marker is what
    // the cross-attempt memory is harvested from, so it must survive the loop.
    expect(fix.on_output?.requires_marker).toBe("CI_FIX_COMPLETE");
  });

  it("resolves the gate script inside the checkout on every backend", () => {
    const cmd = fix.generic_loop!.until_bash!;
    // A literal string: `validateShellCommand` rejects any `{{`, so the path
    // cannot be templated per backend.
    expect(cmd).not.toContain("{{");
    // Never `../`: gondolin is the packaged default and mounts ONLY cwd, so a
    // workspace-root gate is unreachable in the guest. cwd is the checkout on
    // every backend, so a bare relative path is the one form that works.
    expect(cmd).not.toContain("../");
    expect(cmd).toContain(".lastlight-verify.sh");
  });

  it("treats a missing gate script as an explicit red, not an accident of exit codes", () => {
    const cmd = fix.generic_loop!.until_bash!;
    // The `else` branch is the point: no script ⇒ `gate=skipped` ⇒ RED ⇒ the
    // loop continues and nothing authorises a push.
    expect(cmd).toMatch(/if \[ -f \.lastlight-verify\.sh \]/);
    expect(cmd).toMatch(/else\b[\s\S]*exit 1/);
  });
});
