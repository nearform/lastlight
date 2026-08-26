import { describe, it, expect } from "vitest";
import { PhaseRef } from "#src/workflows/phase-ref.js";

describe("PhaseRef.format — the single label authority", () => {
  it("pins the literal generated label strings", () => {
    expect(PhaseRef.review("reviewer").format()).toBe("reviewer");
    expect(PhaseRef.fix("reviewer", 1).format()).toBe("reviewer_fix_1");
    expect(PhaseRef.recheck("reviewer", 1).format()).toBe("reviewer_recheck_1");
    expect(PhaseRef.iter("reviewer", 1).format()).toBe("reviewer_iter_1");
    expect(PhaseRef.iterRetry("socratic", 7).format()).toBe("socratic_iter_7_retry");
  });
});

describe("PhaseRef.parse — round-trips generated labels back to base + kind", () => {
  it("parses each generated suffix", () => {
    expect(PhaseRef.parse("reviewer_fix_2")).toMatchObject({ base: "reviewer", kind: "fix", index: 2 });
    expect(PhaseRef.parse("reviewer_recheck_2")).toMatchObject({ base: "reviewer", kind: "recheck", index: 2 });
    expect(PhaseRef.parse("reviewer_iter_3")).toMatchObject({ base: "reviewer", kind: "iter", index: 3 });
    expect(PhaseRef.parse("socratic_iter_7_retry")).toMatchObject({ base: "socratic", kind: "retry", index: 7 });
  });

  it("does not mistake a plain iteration for a retry", () => {
    expect(PhaseRef.parse("socratic_iter_7")).toMatchObject({ base: "socratic", kind: "iter", index: 7 });
  });

  it("parses a bare declared name as a plain phase", () => {
    expect(PhaseRef.parse("reviewer")).toMatchObject({ base: "reviewer", kind: "phase" });
  });

  it("parses the dropped legacy reviewer_2 form as a plain phase (not a recheck)", () => {
    expect(PhaseRef.parse("reviewer_2")).toMatchObject({ base: "reviewer_2", kind: "phase" });
  });
});

// ── Fan-out branches (WP11c) ────────────────────────────────────────────────

describe("PhaseRef — the fan-out branch labels", () => {
  it("pins the three generated branch label strings", () => {
    expect(PhaseRef.branch("survey", "contract").format()).toBe("survey_branch_contract");
    expect(PhaseRef.branchRetry("survey", "contract").format()).toBe("survey_branch_contract_retry");
    expect(PhaseRef.branchCheck("survey", "contract").format()).toBe("survey_branch_contract_check");
  });

  it("round-trips a branch label whose BASE contains underscores", () => {
    // The reason branch names are restricted to `[A-Za-z0-9-]` by the schema:
    // the base is greedy and may itself be `survey_contract`, so the split is
    // only unambiguous while the branch half has no underscore of its own.
    for (const ref of [
      PhaseRef.branch("pr_review_survey", "contract"),
      PhaseRef.branchRetry("pr_review_survey", "contract"),
      PhaseRef.branchCheck("pr_review_survey", "contract"),
    ]) {
      const back = PhaseRef.parse(ref.format());
      expect(back.base, ref.format()).toBe("pr_review_survey");
      expect(back.branch, ref.format()).toBe("contract");
      expect(back.kind, ref.format()).toBe(ref.kind);
    }
  });

  it("does not mistake a bare branch for its retry or its check", () => {
    expect(PhaseRef.parse("survey_branch_spec")).toMatchObject({ kind: "branch", branch: "spec" });
    expect(PhaseRef.parse("survey_branch_spec_retry")).toMatchObject({ kind: "branchRetry", branch: "spec" });
    expect(PhaseRef.parse("survey_branch_spec_check")).toMatchObject({ kind: "branchCheck", branch: "spec" });
  });

  it("leaves the loop forms alone — the two namespaces do not collide", () => {
    expect(PhaseRef.parse("survey_iter_1")).toMatchObject({ kind: "iter", index: 1 });
    expect(PhaseRef.parse("survey_branch_a_iter_1")).toMatchObject({ kind: "iter", index: 1 });
  });

  it("groups a branch under its parent by longest prefix, like every other label", () => {
    // This is what the dashboard's `WorkflowPipeline.tsx` grouping relies on:
    // the parent phase name is a prefix of every label it owns, so a fan-out's
    // branches nest under `survey` with no dashboard change at all.
    for (const label of ["survey_branch_spec", "survey_branch_spec_retry", "survey_branch_spec_check"]) {
      expect(label.startsWith("survey")).toBe(true);
    }
  });
});
