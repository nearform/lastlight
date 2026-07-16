import type { PhaseDefinition } from "./schema.js";

export type NodeStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export type TriggerRule = "all_success" | "one_success" | "none_failed_min_one_success" | "all_done";

export interface DagNode {
  name: string;
  depends_on: string[];
  trigger_rule: TriggerRule;
  status: NodeStatus;
  output?: string;
}

const TERMINAL: NodeStatus[] = ["succeeded", "failed", "skipped"];

export interface BuildDagOptions {
  /**
   * When set and **no** phase declares `depends_on`, synthesize a chain:
   * each phase depends on the one declared before it (trigger rule
   * `all_success`). This reproduces the old linear runner's semantics —
   * sequential execution with a failure cascade — as a degenerate DAG, so
   * the unified scheduler can treat every workflow uniformly. When any phase
   * declares an explicit edge, the declared graph is used verbatim (no
   * synthesis).
   */
  chainIfNoDeps?: boolean;
}

/** Build a DAG from phase definitions. Validates edges and detects cycles. */
export function buildDag(phases: PhaseDefinition[], opts: BuildDagOptions = {}): DagNode[] {
  const names = new Set(phases.map((p) => p.name));

  for (const phase of phases) {
    if (!phase.depends_on?.length) continue;
    for (const dep of phase.depends_on) {
      if (dep === phase.name) throw new Error(`Phase "${phase.name}" depends on itself`);
      if (!names.has(dep)) throw new Error(`Phase "${phase.name}" depends on unknown phase "${dep}"`);
    }
  }

  const anyDeclared = phases.some((p) => p.depends_on && p.depends_on.length > 0);
  const synthesizeChain = opts.chainIfNoDeps === true && !anyDeclared;

  const nodes: DagNode[] = phases.map((p, i) => ({
    name: p.name,
    depends_on: synthesizeChain
      ? (i > 0 ? [phases[i - 1].name] : [])
      : (p.depends_on ?? []),
    trigger_rule: p.trigger_rule ?? "all_success",
    status: "pending" as NodeStatus,
  }));

  // Detect cycles via DFS
  const nodeMap = new Map(nodes.map((n) => [n.name, n]));
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>(nodes.map((n) => [n.name, WHITE]));

  // NOTE: DFS follows depends_on edges (child → parent), the reverse of conventional
  // execution-order direction. Cycle detection still works: a GRAY ancestor reachable
  // from a descendant via depends_on edges indicates a cycle in this representation.
  function dfs(name: string, path: string[]): void {
    color.set(name, GRAY);
    for (const dep of nodeMap.get(name)!.depends_on) {
      if (color.get(dep) === GRAY) {
        throw new Error(`Cycle detected: ${[...path, name, dep].join(" -> ")}`);
      }
      if (color.get(dep) === WHITE) {
        dfs(dep, [...path, name]);
      }
    }
    color.set(name, BLACK);
  }

  for (const node of nodes) {
    if (color.get(node.name) === WHITE) dfs(node.name, []);
  }

  return nodes;
}

/** Evaluate a trigger rule against upstream dependency statuses. */
export function evaluateTriggerRule(rule: TriggerRule, depStatuses: NodeStatus[]): boolean {
  if (depStatuses.length === 0) return true;
  switch (rule) {
    case "all_success":
      return depStatuses.every((s) => s === "succeeded");
    case "one_success":
      return depStatuses.some((s) => s === "succeeded");
    case "none_failed_min_one_success":
      return !depStatuses.some((s) => s === "failed") && depStatuses.some((s) => s === "succeeded");
    case "all_done":
      return depStatuses.every((s) => TERMINAL.includes(s));
  }
}

/** Return nodes that are ready to run: pending, all deps terminal, trigger rule satisfied. */
export function getReadyNodes(dag: DagNode[]): DagNode[] {
  const nodeMap = new Map(dag.map((n) => [n.name, n]));
  return dag.filter((node) => {
    if (node.status !== "pending") return false;
    const deps = node.depends_on.map((d) => nodeMap.get(d)!);
    if (!deps.every((d) => TERMINAL.includes(d.status))) return false;
    return evaluateTriggerRule(node.trigger_rule, deps.map((d) => d.status));
  });
}

/** Return nodes that should be skipped: pending, all deps terminal, trigger rule NOT satisfied. */
export function getNodesToSkip(dag: DagNode[]): DagNode[] {
  const nodeMap = new Map(dag.map((n) => [n.name, n]));
  return dag.filter((node) => {
    if (node.status !== "pending") return false;
    const deps = node.depends_on.map((d) => nodeMap.get(d)!);
    if (!deps.every((d) => TERMINAL.includes(d.status))) return false;
    return !evaluateTriggerRule(node.trigger_rule, deps.map((d) => d.status));
  });
}

/** Check if all nodes are in a terminal state. */
export function isComplete(dag: DagNode[]): boolean {
  return dag.every((n) => TERMINAL.includes(n.status));
}

/**
 * Return layers of parallelizable phase names (topological sort).
 * Each layer contains phases that can run concurrently.
 */
export function topoSort(dag: DagNode[]): string[][] {
  const inDegree = new Map<string, number>(dag.map((n) => [n.name, n.depends_on.length]));
  const layers: string[][] = [];
  let current = dag.filter((n) => (inDegree.get(n.name) ?? 0) === 0).map((n) => n.name);

  while (current.length > 0) {
    layers.push([...current]);
    const next: string[] = [];
    for (const name of current) {
      for (const node of dag) {
        if (node.depends_on.includes(name)) {
          const deg = (inDegree.get(node.name) ?? 0) - 1;
          inDegree.set(node.name, deg);
          if (deg === 0) next.push(node.name);
        }
      }
    }
    current = next;
  }

  return layers;
}
