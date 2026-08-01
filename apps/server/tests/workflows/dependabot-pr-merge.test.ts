import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getWorkflow,
  getCronWorkflows,
  getWorkflowByIntent,
  loadPromptTemplate,
} from "#src/workflows/loader.js";
import { renderTemplate } from "#src/workflows/templates.js";
import type { TemplateContext } from "#src/workflows/templates.js";

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

/**
 * Phase 5 (issue #252, 05-impact.md): a MAJOR bump is judged by IMPACT, not by
 * semver magnitude, and the merge decision is gated on the code-computed check
 * state instead of the `mergeable_state` heuristic.
 */
describe("dependabot-pr-merge — major-bump impact (#252)", () => {
  const prompt = loadPromptTemplate("prompts/dependabot-pr-merge.md");

  it("stages the dependency-impact rubric alongside code-review", () => {
    // A skill, not more prompt prose: the rubric is needed only when the PR IS
    // a major, and pi surfaces skills as an on-demand catalogue. It also makes
    // the rubric per-repo overridable via `.lastlight/skills/`.
    const def = getWorkflow("dependabot-pr-merge");
    expect(def.phases[0].skills).toEqual(["code-review", "dependency-impact"]);
    expect(def.phases[0].skill).toBeUndefined();
  });

  it("branches a major into the rubric instead of auto-FUNCTIONAL", () => {
    // The ONLY rule about bump magnitude in the codebase used to be this prose
    // conjunct, which made every major FUNCTIONAL — a `@types/*` dev bump and a
    // runtime framework rewrite alike.
    expect(prompt).not.toContain("it is not a **major** version bump of a runtime dependency");
    expect(prompt).toContain("dependency-impact");
    expect(prompt).toContain("{{dependencies.autoMergeMaxImpact}}");
    // Unknown ⇒ high is the rubric's load-bearing default and must survive in
    // the prompt too, not only in the skill the agent may or may not read.
    expect(prompt).toContain("Unknown ⇒ high");
  });

  it("gates BOTH merge mechanisms on the settled check state, not mergeable_state", () => {
    // 09-state-machine.md → D10. Auto-merge was credited with a safety
    // guarantee it only has on a repo WITH required checks: with none, it
    // merges an already-mergeable PR essentially immediately, so gating only
    // the direct merge handed majors an ungated path on exactly the repos the
    // prompt itself documents as hazardous.
    expect(prompt).toContain("{{checksState}}");
    expect(prompt).toContain("{{settledCheckCount}}");
    expect(prompt).toContain("{{dependencies.minSettledChecks}}");
    // The heuristic it replaces is gone.
    expect(prompt).not.toMatch(/confirm via `github_get_pull_request` that/i);
    expect(prompt).not.toMatch(/Only if `mergeable_state` is `clean`/);
  });

  it("says the tier belongs to the BUMP, not to the verdict", () => {
    // The eval's `depmerge__high-framework-major` case caught the reading this
    // closes: an agent that classified a major FUNCTIONAL emitted
    // `impact=none`, reasoning that the tier is only assigned on the path to
    // TRIVIAL. Its behaviour was safe — no auto-merge, `requires-human`
    // applied — but the impact label is what STEP 2b calls the record of why a
    // major did or did not land, and `none` on a major erases it. Three places
    // in the prompt could be read that way; all three now say otherwise.
    expect(prompt).toContain("Every major gets a tier, whatever the verdict");
    expect(prompt).toContain("`none` on a major is always wrong");
    // STEP 2's TRIVIAL test must read as CONSULTING 2a, not as gating it.
    expect(prompt).toContain("STEP 2a runs for every major regardless");
    // …and the marker spec, which is where the value is actually written.
    expect(prompt).toMatch(/`none` \*\*only\*\* for a\s*\n?non-major/);
  });

  it("extends the marker with the impact tier, keeping the ASSESSMENT_COMPLETE prefix", () => {
    // `requires_marker` matches the literal prefix, so appending a field is
    // backward-compatible with the postcondition contract above.
    expect(prompt).toContain(
      "ASSESSMENT_COMPLETE: pr={{prNumber}} verdict=<TRIVIAL|FUNCTIONAL> " +
        "impact=<none|low|medium|high> action=<automerge|merge|rebase|rebase-and-human|comment|already-handled>",
    );
  });

  it("keeps the audit comment inside the anti-spam discipline", () => {
    // One comment per auto-merged major, against a cron that re-runs daily.
    expect(prompt).toContain("{{#if dependencies.auditComment}}");
    expect(prompt).toContain("At most two comments, ever.");
    expect(prompt).toContain("{{prLabels}}");
  });

  // `renderTemplate`'s `{{#if}}` is explicitly NON-nesting (the block ends at
  // the FIRST `{{/if}}`), so a nested conditional leaves raw mustache in the
  // agent's prompt — invisible to every other assertion here.
  it("leaves no unrendered mustache, with or without the policy context", () => {
    const full = {
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      issueTitle: "Bump lodash from 4 to 5",
      prLabels: ["dependency-major-low"],
      checksState: "passing",
      checksSettledPassing: true,
      mayMerge: true,
      mayMergeReason: "checks-passing: 3 settled check(s), all green",
      settledCheckCount: 3,
      dependencies: {
        autoMergeMaxImpact: "medium",
        requireSettledChecks: true,
        minSettledChecks: 1,
        auditComment: true,
      },
    } as unknown as TemplateContext;
    const bare = { owner: "acme", repo: "widgets", prNumber: 7 } as unknown as TemplateContext;
    for (const ctx of [full, bare]) {
      expect(renderTemplate(prompt, ctx)).not.toContain("{{");
    }
  });

  // The banner is gated on `mayMerge` — the projected decision — and NOT on
  // `checksSettledPassing`, which is only one of the predicate's four inputs.
  // The two disagree in both directions, which is the whole reason the decision
  // is projected rather than restated: a raised `minSettledChecks` closes the
  // gate while checks are `passing`, and `requireSettledChecks: false` opens it
  // while they are red.
  it("renders the closed-gate warning from the projected decision, not from the check state", () => {
    const base = { owner: "acme", repo: "widgets", prNumber: 7 };
    const render = (ctx: Record<string, unknown>) =>
      renderTemplate(prompt, { ...base, ...ctx } as unknown as TemplateContext);

    const open = render({
      checksState: "passing",
      checksSettledPassing: true,
      mayMerge: true,
      mayMergeReason: "checks-passing: 3 settled check(s), all green",
    });
    const closed = render({
      checksState: "failing",
      checksSettledPassing: false,
      mayMerge: false,
      mayMergeReason: "checks-failing: CI is red on the head commit",
    });
    // Checks are green, but too few of them settled for the operator's policy.
    const closedDespiteGreen = render({
      checksState: "passing",
      checksSettledPassing: true,
      mayMerge: false,
      mayMergeReason: "too-few-checks: 1 settled check(s), dependencies.minSettledChecks is 3",
    });
    // Checks are red, but this deployment turned the gate off entirely.
    const openDespiteRed = render({
      checksState: "failing",
      checksSettledPassing: false,
      mayMerge: true,
      mayMergeReason: "checks-not-required: dependencies.requireSettledChecks is off",
    });

    expect(open).not.toContain("On this run the gate is CLOSED");
    expect(closed).toContain("On this run the gate is CLOSED");
    expect(closedDespiteGreen).toContain("On this run the gate is CLOSED");
    expect(openDespiteRed).not.toContain("On this run the gate is CLOSED");
    // The reason the decision produced is what the prompt states.
    expect(closed).toContain("CI is red on the head commit");
    expect(closedDespiteGreen).toContain("minSettledChecks is 3");
  });
});

describe("dependency-impact skill", () => {
  const skill = readFileSync(
    fileURLToPath(new URL("../../skills/dependency-impact/SKILL.md", import.meta.url)),
    "utf8",
  );

  it("carries the frontmatter the loader requires", () => {
    expect(skill).toMatch(/^---\n/);
    expect(skill).toContain("name: dependency-impact");
    expect(skill).toMatch(/\ndescription: .+/);
    // Would drop the skill from the agent's catalogue entirely.
    expect(skill).not.toContain("disable-model-invocation");
  });

  it("names all three tiers and the unknown⇒high default", () => {
    for (const tier of ["low", "medium", "high"]) {
      expect(skill).toContain(`- **${tier}** —`);
    }
    expect(skill).toContain("**Unknown ⇒ high.**");
  });

  it("keeps the no-checkout discipline — this is the cheap path", () => {
    expect(skill).toContain("**No checkout.**");
    expect(skill).toMatch(/never pull a lockfile diff/i);
  });
});
