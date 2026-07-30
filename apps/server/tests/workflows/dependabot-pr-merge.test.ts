import { describe, it, expect } from "vitest";
import {
  getWorkflow,
  getCronWorkflows,
  getWorkflowByIntent,
  loadPromptTemplate,
} from "#src/workflows/loader.js";

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

  it("keeps the branch-rebase request independent of the merge verdict (#245)", () => {
    // The assess prompt used to say "If FUNCTIONAL: do NOT merge, and do NOT
    // request a rebase", fusing two unrelated decisions. A conflicted major bump
    // then got neither: no auto-merge (correct) AND no `@dependabot recreate`
    // (wrong — regenerating a bot's own branch merges nothing and pre-empts no
    // review), so it sat conflicted until a human ran the command by hand.
    const prompt = loadPromptTemplate("prompts/dependabot-pr-merge.md");

    expect(prompt).not.toMatch(/do NOT request a rebase/i);
    // FUNCTIONAL must still refuse to land it...
    expect(prompt).toMatch(/If \*\*FUNCTIONAL\*\*: do NOT merge and do NOT enable auto-merge/);
    // ...while the marker vocabulary can express "rebased AND left for a human".
    expect(prompt).toContain("rebase-and-human");
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
