import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";
import { AgentWorkflowSchema, resolveDynamicBranches, type TemplateContext } from "lastlight-workflow-engine";

/**
 * The soft-failure policy of the `site-review` fan-out, read off the SHIPPED
 * YAML as an EFFECTIVE value.
 *
 * This test exists because of a specific, measured, silent failure. All six
 * (since removed) agent survey phases declared `on_soft_failure: { retries: 1, then: complete }` at
 * PHASE level, where it belongs to `generic_loop` and zod therefore STRIPS it.
 * The policy silently reverted to `{ retries: 0, then: fail }`, so one degenerate
 * turn hard-failed the whole review — which records no
 * `assessedHeadShaByWorkflow` and hands `cron-review.yaml` something to
 * re-dispatch every thirty minutes, forever. It shipped that way until
 * 2026-08-22.
 *
 * A test asserting the KEY IS PRESENT in the YAML text would not have caught it,
 * because the key was present. What was absent was its effect. So every
 * assertion here reads the PARSED definition — the value the runner will
 * actually use — and the vacuity control at the bottom proves that reading can
 * fail.
 */

const def = getWorkflow("pr-review");
const survey = def.phases.find((p) => p.name === "site-review");

describe("the site-review fan-out's soft-failure policy survives parsing", () => {
  it("is a DYNAMIC fanout over site-plan's manifest, capped at sixteen (top 8, paired)", () => {
    expect(survey?.type).toBe("fanout");
    expect(survey?.branches).toBeUndefined();
    expect(survey?.branches_from).toEqual({ file: ".lastlight/pr-review/sites/branches.json", max: 16 });
  });

  it("carries `{ retries: 1, then: complete }` AFTER the schema has had it", () => {
    // Not "the YAML says so" — "the parsed object says so".
    expect(survey?.on_branch_soft_failure).toEqual({ retries: 1, then: "complete" });
  });

  it("re-runs a branch once when its gate says no, AFTER the schema has had it", () => {
    expect(survey?.on_branch_gate_failure).toEqual({ retries: 1 });
  });

  it("does not rely on `on_soft_failure`, the name that gets stripped here", () => {
    // The trap, pinned as a negative: if anyone renames the key back, this test
    // fails rather than the review silently hard-failing on a degenerate turn.
    const raw = survey as unknown as Record<string, unknown>;
    expect(raw.on_soft_failure).toBeUndefined();
    expect(raw.generic_loop).toBeUndefined();
  });

  it("declares a concurrency ceiling that reads from config, with a packaged default", () => {
    // `{ from, default }` rather than a literal, so an operator dials it without
    // forking the workflow — and `default` is what a deployment whose context
    // lacks the key falls back to, loudly.
    expect(survey?.max_concurrent).toEqual({ from: "siteConcurrency", default: 6 });
  });

  it("runs the pair slots on their own model, and the primaries on the phase's", () => {
    // The shape `sites --plan --pair` writes: primaries, then `-b` pairs.
    const manifest = { items: [{ id: "site-001" }, { id: "site-001-b", pair: true }] };
    const ctx = { models: { "review-site-pair": "pair/model" } } as unknown as TemplateContext;
    const { branches } = resolveDynamicBranches(survey!, manifest, ctx);
    expect(branches.map((b) => [b.name, b.model ?? null, b.context_file])).toEqual([
      ["site-001", null, ".lastlight/pr-review/sites/site-001.md"],
      ["site-001-b", "pair/model", ".lastlight/pr-review/sites/site-001-b.md"],
    ]);
    expect(branches[1].until_bash).toContain("sites --check site-001-b --dir .lastlight/pr-review");
  });

  /**
   * Vacuity control. If the assertions above ever stop reading the PARSED
   * definition — the exact mistake that let the original bug ship — this proves
   * the reading can come back empty.
   */
  it("is asserting on the parsed value, and the parser really does strip", () => {
    const stripped = AgentWorkflowSchema.parse({
      name: "x",
      phases: [
        {
          name: "p",
          type: "fanout",
          skills: ["pr-review"],
          // The WRONG key, at phase level, exactly as the six surveys had it.
          on_soft_failure: { retries: 1, then: "complete" },
          branches: [{ name: "a", prompt: "prompts/a.md" }],
        },
      ],
    }).phases[0] as unknown as Record<string, unknown>;

    expect(stripped.on_soft_failure).toBeUndefined();
    expect(stripped.on_branch_soft_failure).toBeUndefined();
  });
});
