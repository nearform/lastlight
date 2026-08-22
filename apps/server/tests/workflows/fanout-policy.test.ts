import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";
import { AgentWorkflowSchema } from "lastlight-workflow-engine";

/**
 * The soft-failure policy of the `survey` fan-out, read off the SHIPPED YAML as
 * an EFFECTIVE value.
 *
 * This test exists because of a specific, measured, silent failure. All six
 * survey phases declared `on_soft_failure: { retries: 1, then: complete }` at
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
const survey = def.phases.find((p) => p.name === "survey");

describe("the survey fan-out's soft-failure policy survives parsing", () => {
  it("is a fanout phase with six branches", () => {
    expect(survey?.type).toBe("fanout");
    expect(survey?.branches).toHaveLength(6);
  });

  it("carries `{ retries: 1, then: complete }` AFTER the schema has had it", () => {
    // Not "the YAML says so" — "the parsed object says so".
    expect(survey?.on_branch_soft_failure).toEqual({ retries: 1, then: "complete" });
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
    expect(survey?.max_concurrent).toEqual({ from: "surveyConcurrency", default: 6 });
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
