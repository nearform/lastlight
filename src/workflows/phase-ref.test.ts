import { describe, it, expect } from "vitest";
import { PhaseRef, phaseIndexInDefinition, nextPhaseAfter } from "./phase-ref.js";
import type { AgentWorkflowDefinition } from "./schema.js";

const def = (...names: string[]): AgentWorkflowDefinition =>
  ({ phases: names.map((name) => ({ name })) }) as AgentWorkflowDefinition;

describe("PhaseRef.format — the single label authority", () => {
  it("pins the literal generated label strings", () => {
    expect(PhaseRef.review("reviewer").format()).toBe("reviewer");
    expect(PhaseRef.fix("reviewer", 1).format()).toBe("reviewer_fix_1");
    expect(PhaseRef.recheck("reviewer", 1).format()).toBe("reviewer_recheck_1");
    expect(PhaseRef.iter("reviewer", 1).format()).toBe("reviewer_iter_1");
  });
});

describe("phaseIndexInDefinition — definition-aware resolution", () => {
  const definition = def("architect", "executor", "reviewer", "pr");

  it("round-trips every generated label back to its base phase", () => {
    for (const ref of [
      PhaseRef.review("reviewer"),
      PhaseRef.fix("reviewer", 2),
      PhaseRef.recheck("reviewer", 2),
      PhaseRef.iter("reviewer", 3),
    ]) {
      expect(phaseIndexInDefinition(definition, ref.format())).toBe(2);
    }
  });

  it("prefers an exact literal phase name over suffix-stripping", () => {
    const literal = def("reviewer", "reviewer_fix_1");
    expect(phaseIndexInDefinition(literal, "reviewer_fix_1")).toBe(1);
  });

  it("resolves the dropped legacy reviewer_2 form to -1", () => {
    expect(phaseIndexInDefinition(definition, "reviewer_2")).toBe(-1);
  });

  it("returns -1 for unknown / untracked labels", () => {
    expect(phaseIndexInDefinition(definition, "waiting_approval")).toBe(-1);
  });
});

describe("nextPhaseAfter", () => {
  const definition = def("architect", "executor", "reviewer", "pr");

  it("steps to the next declared phase, even from a generated label", () => {
    expect(nextPhaseAfter(definition, "reviewer_recheck_1")).toBe("pr");
  });

  it("returns null at the end of the workflow", () => {
    expect(nextPhaseAfter(definition, "pr")).toBeNull();
  });
});
