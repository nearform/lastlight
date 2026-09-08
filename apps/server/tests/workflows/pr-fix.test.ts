import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";
import {
  CI_FIX_MARKER_POSTCONDITION,
  DIAGNOSIS_MARKER_POSTCONDITION,
  parseFixOutcomeMarker,
  renderAttemptLine,
} from "#src/engine/fix-markers.js";
import { VERIFY_SCRIPT_NAME } from "#src/engine/fix-scratch.js";
import { prFixShapedWorkflows } from "#src/workflows/target-policy.js";
import { defaultFixConfig } from "lastlight-shared";

/**
 * Contract test for the built-in pr-fix workflow. It carries the same
 * diagnose-then-fix shape as `dependabot-ci-fix` (both are in
 * `pr_fix_shaped`, so anything keyed off that family must improve them
 * together) but had no contract test at all until now — the divergence would
 * have been silent.
 */
describe("pr-fix — built-in workflow", () => {
  const def = getWorkflow("pr-fix");

  it("loads with diagnose → fix", () => {
    expect(def.name).toBe("pr-fix");
    expect(def.phases.map((p) => p.name)).toEqual(["diagnose", "fix"]);
  });

  it("gates both phases on the PARSEABLE completion marker", () => {
    // Colon included, and pinned to the parser's own constants: the engine
    // enforces `requires_marker` as a bare substring while `lastMarkerLine`
    // only recognises `<TAG>:`, so declaring the bare tag let an output that
    // merely mentioned it pass a gate it then parsed to nothing — a green phase
    // with a null diagnosis, and an attempt counter that never advanced.
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    expect(byName.get("diagnose")?.on_output?.requires_marker).toBe(DIAGNOSIS_MARKER_POSTCONDITION);
    expect(byName.get("fix")?.on_output?.requires_marker).toBe(CI_FIX_MARKER_POSTCONDITION);
    expect(DIAGNOSIS_MARKER_POSTCONDITION).toBe("DIAGNOSIS_COMPLETE:");
    expect(CI_FIX_MARKER_POSTCONDITION).toBe("CI_FIX_COMPLETE:");
  });

  it("skips the fix phase on the three non-fixable diagnosis classes", () => {
    const fix = def.phases.find((p) => p.name === "fix")!;
    // Read off the harvested, PARSED class — not off the diagnose phase's
    // output, which matched an agent's prose ("not class=flaky, it's
    // reproducible"), matched a replayed `{{priorAttempts}}` line, and was
    // empty across a resume boundary.
    expect(fix.skip_if).toEqual([
      "scratch.fixMarkers.diagnosis.class == 'flaky'",
      "scratch.fixMarkers.diagnosis.class == 'infra-dependent'",
      "scratch.fixMarkers.diagnosis.class == 'upstream-broken'",
    ]);
    expect(fix.messages?.on_skipped_done).toBeTruthy();
  });

  it("runs diagnose on `fixing` and fix on `fixing` + `building`", () => {
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    expect(byName.get("diagnose")?.skill).toBe("fixing");
    expect(byName.get("diagnose")?.output_var).toBe("diagnosis");
    expect(byName.get("fix")?.skills).toEqual(["fixing", "building"]);
  });

  it("matches dependabot-ci-fix's fix-phase gating (pr_fix_shaped parity)", () => {
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
 * (`pr_fix_shaped`) and a gate on only one of them is a gate an
 * `@bot fix this` comment can route around.
 */
describe.each(["pr-fix", "dependabot-ci-fix"])("%s — the local push gate", (name) => {
  const fix = getWorkflow(name).phases.find((p) => p.name === "fix")!;

  it("declares the gate loop with a persistent context", () => {
    expect(fix.generic_loop?.fresh_context).toBe(false); // iteration 2 sees iteration 1
    expect(fix.generic_loop?.until_bash).toBeTruthy(); // the SCRIPT is still the gate
  });

  /**
   * The push short-circuit. `until` is evaluated BEFORE `until_bash` and skips
   * it entirely when it matches, so this is the one place the loop can say
   * "there is nothing left to gate".
   *
   * Once the agent has pushed, the commit is on the branch and GitHub's checks
   * are running against it — a strictly better authority than a fresh container
   * re-running a slower copy of the same suite. Run `49c101aa` paid 6m48s for
   * that copy, on a commit GitHub had already passed 4m30s earlier.
   */
  it("short-circuits the gate once the agent has pushed", () => {
    expect(fix.generic_loop?.until).toBe("output.contains('outcome=pushed tried=')");
  });

  it("matches a live CI_FIX_COMPLETE line and NOT a replayed journal line", () => {
    const needle = fix.generic_loop!.until!.match(/^output\.contains\('(.+)'\)$/)![1];

    // The live marker, exactly as `skills/fixing/SKILL.md` specifies it.
    const live = `${CI_FIX_MARKER_POSTCONDITION} pr=7 attempt=1 outcome=pushed tried=regen lockfile gate=green`;
    expect(live).toContain(needle);
    expect(parseFixOutcomeMarker(live)?.outcome).toBe("pushed");

    // The `{{priorAttempts}}` line an EARLIER attempt left behind, replayed into
    // this prompt and liable to be quoted back in the agent's own prose. It
    // carries `outcome=pushed` — which is exactly why the needle can't be that
    // alone — but `renderAttemptLine` deliberately never renders `tried=`.
    const replayed = renderAttemptLine(1, {
      diagnosis: {
        pr: 7, attempt: 1, class: "env-mismatch", rawClass: "env-mismatch",
        cause: "node 22 vs 20", ciVsLocal: "node version", unreproducible: [],
      },
      fix: { pr: 7, attempt: 1, outcome: "pushed", rawOutcome: "pushed", tried: "bump", gate: "green", rawGate: "green" },
    })!;
    expect(replayed).toContain("outcome=pushed");
    expect(replayed).not.toContain(needle);
  });

  it("still gates the outcomes that pushed nothing", () => {
    const needle = fix.generic_loop!.until!.match(/^output\.contains\('(.+)'\)$/)![1];
    // No push ⇒ no new commit ⇒ no GitHub check ⇒ the local gate is the only
    // evidence there is, and its RED verdict is what earns the next iteration.
    // Short-circuiting these too would exit every loop at iteration 1 and turn
    // `fix.localIterations` into dead config.
    for (const outcome of ["no-change", "gave-up"]) {
      const line = `${CI_FIX_MARKER_POSTCONDITION} pr=7 attempt=1 outcome=${outcome} tried=bumped the pin gate=red`;
      expect(line).not.toContain(needle);
    }
  });

  it("reads both loop budgets from the run's effective fix config", () => {
    // The keys were parsed, clamped per repo, CLI-displayed and read by
    // NOTHING (#256): the operative numbers were these two literals, and the
    // YAML comments asked a human to keep them in step. Now the literal is the
    // FALLBACK and the config block is the value, so a repo that lowered its
    // own budget is honoured and the admin panel stops reporting a bound the
    // loop is not held to.
    const defaults = defaultFixConfig();
    expect(fix.generic_loop?.max_iterations).toEqual({
      from: "fix.localIterations",
      default: defaults.localIterations,
    });
    expect(fix.timeout_seconds).toEqual({
      from: "fix.gateTimeoutSeconds",
      default: defaults.gateTimeoutSeconds,
    });
    // `runUntilBash` falls back to `?? 30`, and 30s kills a real test suite
    // mid-run and reports a false red — so the fallback must stay generous
    // even if the reference never resolves.
    expect(defaults.gateTimeoutSeconds).toBeGreaterThan(30);
  });

  it("keeps the CI_FIX_COMPLETE postcondition on the looped phase", () => {
    // A `generic_loop` used to silently drop `on_output` — the marker is what
    // the cross-attempt memory is harvested from, so it must survive the loop.
    expect(fix.on_output?.requires_marker).toBe(CI_FIX_MARKER_POSTCONDITION);
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
    // Pinned to the constant, since that is the only reason the YAML literal
    // and the harness's delete agree on a path.
    expect(cmd).toContain(VERIFY_SCRIPT_NAME);
    // And under `.git/`, which is what makes `git add -A` unable to commit it
    // on every backend rather than only the ones that remembered to exclude it.
    expect(VERIFY_SCRIPT_NAME.startsWith(".git/")).toBe(true);
  });

  // The INTERPRETER, not just the path — the other half of "the gate the
  // harness runs is the gate the agent verified". `sh <script>` discards the
  // script's shebang, and `/bin/sh` in the sandbox image is dash, which
  // rejects the `set -euo pipefail` the `fixing` skill asks the agent to open
  // with and exits 2 on line 2. That made this gate a CONSTANT RED in
  // milliseconds on every run ever recorded: the loop still iterated, so it
  // looked alive, but no iteration could go green, and the harness's half of
  // "no green gate ⇒ no push" never fired — leaving the agent's own
  // self-reported `gate=green` (it runs the script directly, shebang honoured)
  // as the only thing gating a push. Asserted across the whole fix-shaped
  // family: the two workflows carry the same loop and must not diverge.
  it.each([...prFixShapedWorkflows()])("runs %s's gate under bash, never sh", (name) => {
    const phase = getWorkflow(name).phases.find((p) => p.name === "fix")!;
    const cmd = phase.generic_loop!.until_bash!;
    expect(cmd).toContain(`bash ${VERIFY_SCRIPT_NAME}`);
    // `bash <path>` does not contain `<space>sh <path>`, so this catches a
    // regression to the dash-invoking form without flagging the fix itself.
    expect(cmd).not.toContain(` sh ${VERIFY_SCRIPT_NAME}`);
  });

  it("treats a missing gate script as an explicit red, not an accident of exit codes", () => {
    const cmd = fix.generic_loop!.until_bash!;
    // The `else` branch is the point: no script ⇒ `gate=skipped` ⇒ RED ⇒ the
    // loop continues and nothing authorises a push.
    expect(cmd).toContain(`if [ -f ${VERIFY_SCRIPT_NAME} ]`);
    expect(cmd).toMatch(/else\b[\s\S]*exit 1/);
  });
});
