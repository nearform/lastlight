import { describe, it, expect } from "vitest";
import {
  buildDag,
  evaluateTriggerRule,
  getReadyNodes,
  getNodesToSkip,
  isComplete,
  topoSort,
  type DagNode,
  type NodeStatus,
} from "#src/workflows/dag.js";
import type { PhaseDefinition } from "#src/workflows/schema.js";

function makePhase(name: string, deps?: string[], trigger_rule?: string): PhaseDefinition {
  return {
    name,
    type: "agent",
    prompt: `prompts/${name}.md`,
    depends_on: deps,
    trigger_rule: trigger_rule as PhaseDefinition["trigger_rule"],
  } as PhaseDefinition;
}

describe("buildDag", () => {
  it("builds a simple linear DAG", () => {
    const phases = [makePhase("A"), makePhase("B", ["A"])];
    const dag = buildDag(phases);
    expect(dag).toHaveLength(2);
    expect(dag[0].name).toBe("A");
    expect(dag[1].depends_on).toEqual(["A"]);
  });

  it("throws on self-dependency", () => {
    const phases = [makePhase("A", ["A"])];
    expect(() => buildDag(phases)).toThrow(/depends on itself/);
  });

  it("throws on missing dependency", () => {
    const phases = [makePhase("A", ["nonexistent"])];
    expect(() => buildDag(phases)).toThrow(/unknown phase/);
  });

  it("throws on cycle detection", () => {
    const phases = [makePhase("A", ["C"]), makePhase("B", ["A"]), makePhase("C", ["B"])];
    expect(() => buildDag(phases)).toThrow(/[Cc]ycle/);
  });

  it("allows phases with no dependencies", () => {
    const phases = [makePhase("A"), makePhase("B"), makePhase("C")];
    const dag = buildDag(phases);
    expect(dag.every((n) => n.status === "pending")).toBe(true);
    expect(dag.every((n) => n.depends_on.length === 0)).toBe(true);
  });

  it("defaults trigger_rule to all_success", () => {
    const phases = [makePhase("A"), makePhase("B", ["A"])];
    const dag = buildDag(phases);
    expect(dag[1].trigger_rule).toBe("all_success");
  });
});

describe("buildDag — chain synthesis", () => {
  it("synthesizes a previous-phase chain when no phase declares depends_on", () => {
    const phases = [makePhase("A"), makePhase("B"), makePhase("C")];
    const dag = buildDag(phases, { chainIfNoDeps: true });
    expect(dag[0].depends_on).toEqual([]);
    expect(dag[1].depends_on).toEqual(["A"]);
    expect(dag[2].depends_on).toEqual(["B"]);
    expect(dag.every((n) => n.trigger_rule === "all_success")).toBe(true);
  });

  it("leaves declared edges untouched when any phase declares depends_on", () => {
    const phases = [makePhase("A"), makePhase("B"), makePhase("C", ["A"])];
    const dag = buildDag(phases, { chainIfNoDeps: true });
    expect(dag[0].depends_on).toEqual([]);
    expect(dag[1].depends_on).toEqual([]); // B keeps its (absent) edge — no synthesis
    expect(dag[2].depends_on).toEqual(["A"]);
  });

  it("does not synthesize a chain by default (chainIfNoDeps off)", () => {
    const phases = [makePhase("A"), makePhase("B"), makePhase("C")];
    const dag = buildDag(phases);
    expect(dag.every((n) => n.depends_on.length === 0)).toBe(true);
  });
});

describe("evaluateTriggerRule", () => {
  it("all_success: true when all deps succeeded", () => {
    expect(evaluateTriggerRule("all_success", ["succeeded", "succeeded"])).toBe(true);
  });

  it("all_success: false when any dep failed", () => {
    expect(evaluateTriggerRule("all_success", ["succeeded", "failed"])).toBe(false);
  });

  it("all_success: false when any dep skipped", () => {
    expect(evaluateTriggerRule("all_success", ["succeeded", "skipped"])).toBe(false);
  });

  it("one_success: true when at least one dep succeeded", () => {
    expect(evaluateTriggerRule("one_success", ["succeeded", "failed"])).toBe(true);
  });

  it("one_success: false when no dep succeeded", () => {
    expect(evaluateTriggerRule("one_success", ["failed", "skipped"])).toBe(false);
  });

  it("none_failed_min_one_success: true when no failures and one success", () => {
    expect(evaluateTriggerRule("none_failed_min_one_success", ["succeeded", "skipped"])).toBe(true);
  });

  it("none_failed_min_one_success: false when there is a failure", () => {
    expect(evaluateTriggerRule("none_failed_min_one_success", ["succeeded", "failed"])).toBe(false);
  });

  it("none_failed_min_one_success: false when all skipped (no success)", () => {
    expect(evaluateTriggerRule("none_failed_min_one_success", ["skipped", "skipped"])).toBe(false);
  });

  it("none_failed: true when nothing failed, including when everything skipped", () => {
    expect(evaluateTriggerRule("none_failed", ["succeeded", "skipped"])).toBe(true);
    expect(evaluateTriggerRule("none_failed", ["skipped", "skipped"])).toBe(true);
    expect(evaluateTriggerRule("none_failed", ["succeeded"])).toBe(true);
  });

  it("none_failed: false on any failure, or while a dep is not yet terminal", () => {
    expect(evaluateTriggerRule("none_failed", ["skipped", "failed"])).toBe(false);
    expect(evaluateTriggerRule("none_failed", ["succeeded", "running"])).toBe(false);
  });

  it("all_done: true when all deps are in terminal state", () => {
    expect(evaluateTriggerRule("all_done", ["succeeded", "failed", "skipped"])).toBe(true);
  });

  it("all_done: false when any dep is still pending or running", () => {
    expect(evaluateTriggerRule("all_done", ["succeeded", "running"])).toBe(false);
    expect(evaluateTriggerRule("all_done", ["succeeded", "pending"])).toBe(false);
  });

  it("returns true for empty deps (no dependencies)", () => {
    expect(evaluateTriggerRule("all_success", [])).toBe(true);
  });
});

describe("topoSort", () => {
  it("groups independent nodes in the same layer", () => {
    const phases = [makePhase("A"), makePhase("B"), makePhase("C", ["A", "B"])];
    const dag = buildDag(phases);
    const layers = topoSort(dag);
    expect(layers).toHaveLength(2);
    expect(layers[0]).toEqual(expect.arrayContaining(["A", "B"]));
    expect(layers[1]).toEqual(["C"]);
  });

  it("produces linear layers for a chain", () => {
    const phases = [makePhase("A"), makePhase("B", ["A"]), makePhase("C", ["B"])];
    const dag = buildDag(phases);
    const layers = topoSort(dag);
    expect(layers).toEqual([["A"], ["B"], ["C"]]);
  });

  it("handles diamond shape: A -> B,C -> D", () => {
    const phases = [
      makePhase("A"),
      makePhase("B", ["A"]),
      makePhase("C", ["A"]),
      makePhase("D", ["B", "C"]),
    ];
    const dag = buildDag(phases);
    const layers = topoSort(dag);
    expect(layers[0]).toEqual(["A"]);
    expect(layers[1]).toEqual(expect.arrayContaining(["B", "C"]));
    expect(layers[2]).toEqual(["D"]);
  });
});

describe("getReadyNodes and getNodesToSkip", () => {
  function makeNode(
    name: string,
    depends_on: string[],
    status: NodeStatus,
    trigger_rule: DagNode["trigger_rule"] = "all_success",
  ): DagNode {
    return { name, depends_on, status, trigger_rule };
  }

  it("returns root nodes (no deps) as ready initially", () => {
    const dag: DagNode[] = [
      makeNode("A", [], "pending"),
      makeNode("B", [], "pending"),
    ];
    const ready = getReadyNodes(dag);
    expect(ready.map((n) => n.name)).toEqual(expect.arrayContaining(["A", "B"]));
  });

  it("does not return nodes whose deps are not terminal", () => {
    const dag: DagNode[] = [
      makeNode("A", [], "running"),
      makeNode("B", ["A"], "pending"),
    ];
    const ready = getReadyNodes(dag);
    expect(ready.map((n) => n.name)).not.toContain("B");
  });

  it("returns node as ready when all deps succeeded (all_success rule)", () => {
    const dag: DagNode[] = [
      makeNode("A", [], "succeeded"),
      makeNode("B", ["A"], "pending", "all_success"),
    ];
    expect(getReadyNodes(dag).map((n) => n.name)).toContain("B");
  });

  it("does not return node when all_success rule fails", () => {
    const dag: DagNode[] = [
      makeNode("A", [], "failed"),
      makeNode("B", ["A"], "pending", "all_success"),
    ];
    expect(getReadyNodes(dag).map((n) => n.name)).not.toContain("B");
    expect(getNodesToSkip(dag).map((n) => n.name)).toContain("B");
  });

  it("returns node as ready with all_done rule even when dep failed", () => {
    const dag: DagNode[] = [
      makeNode("A", [], "failed"),
      makeNode("B", ["A"], "pending", "all_done"),
    ];
    expect(getReadyNodes(dag).map((n) => n.name)).toContain("B");
    expect(getNodesToSkip(dag).map((n) => n.name)).not.toContain("B");
  });
});

describe("isComplete", () => {
  it("returns true when all nodes are terminal", () => {
    const dag: DagNode[] = [
      { name: "A", depends_on: [], status: "succeeded", trigger_rule: "all_success" },
      { name: "B", depends_on: ["A"], status: "skipped", trigger_rule: "all_success" },
    ];
    expect(isComplete(dag)).toBe(true);
  });

  it("returns false when any node is pending", () => {
    const dag: DagNode[] = [
      { name: "A", depends_on: [], status: "succeeded", trigger_rule: "all_success" },
      { name: "B", depends_on: ["A"], status: "pending", trigger_rule: "all_success" },
    ];
    expect(isComplete(dag)).toBe(false);
  });

  it("returns false when any node is running", () => {
    const dag: DagNode[] = [
      { name: "A", depends_on: [], status: "running", trigger_rule: "all_success" },
    ];
    expect(isComplete(dag)).toBe(false);
  });
});
