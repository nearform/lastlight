import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type ReactFlowInstance,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type {
  WorkflowRun,
  WorkflowDefinition,
  PhaseHistoryEntry,
  WorkflowRunExecution,
  WorkflowApproval,
} from "../api";
import {
  pipelineNodeTypes,
  type PhaseStatus,
  type PipelineNodeData,
} from "./pipeline-node";

type PhaseNodeData = PipelineNodeData;

const nodeTypes = pipelineNodeTypes;

const NODE_WIDTH = 110;
const NODE_GAP = 40;
// Approximate rendered height of a stacked node (label + timestamp + duration
// + padding). Sets the vertical pitch between loop iterations + their gates.
const NODE_ROW_HEIGHT = 78;
const ROW_GAP = 20;
// Extra one-time gap below the loop parent only. The parent card is taller than
// a normal node (wrapped 2-line label + timestamp + duration), so the first
// iteration needs to start lower to clear it — without spreading the rest of
// the stack apart.
const LOOP_PARENT_EXTRA = 34;

/**
 * Map a dynamic phase name (e.g. "reviewer_fix_1", "reviewer_recheck_1") back
 * to the declared phase it iterates on. The runner names loop iterations like
 * `${parent}_recheck_${n}` (re-reviews) or `${parent}_fix_${n}` (fix
 * iterations), so the parent is the longest declared name `d` such that the
 * dynamic name is `${d}` or starts with `${d}_`.
 */
function findParentDeclared(name: string, declared: string[]): string | null {
  let best: string | null = null;
  for (const d of declared) {
    if (name === d || name.startsWith(`${d}_`)) {
      if (!best || d.length > best.length) best = d;
    }
  }
  return best;
}

interface Props {
  run: WorkflowRun;
  /** Workflow YAML definition. The pipeline is fully definition-driven. */
  definition: WorkflowDefinition | null;
  /**
   * Per-phase execution rows from /workflow-runs/:id/executions. Used as the
   * source of truth for node timing (started, duration) — phase_history only
   * records the moment persistPhase fired, which is *after* a phase
   * completes, so its timestamps are useless as start times.
   */
  executions?: WorkflowRunExecution[];
  /**
   * Approval gates for this run (all statuses). Rendered in place of the
   * generic `waiting_approval` history marker as status-colored gate nodes,
   * labeled by gate name. Node ids are `approval:<id>` so the detail panel can
   * resolve the clicked gate back to its record.
   */
  approvals?: WorkflowApproval[];
  /** Pixel height of the pipeline canvas. Defaults to 180. */
  height?: number | string;
  /** Optional: phase name currently selected (for visual indicator). */
  selectedPhase?: string | null;
  /** Optional: invoked when the user clicks a phase node. */
  onPhaseClick?: (phaseName: string) => void;
}

/**
 * Pipeline visualisation for a workflow run. Fully driven by the workflow
 * YAML definition (passed in as a prop, fetched once by the parent so the
 * detail panel can share it) — no hardcoded phase lists, no fallback labels.
 *
 * Phase visual states are derived from `run.phaseHistory` (completed) and
 * `run.currentPhase` (active). Phases that show up in history but aren't in
 * the definition (e.g. dynamically-named loop iterations like
 * reviewer_recheck_1, reviewer_fix_1) are appended after the definition's phases so they remain
 * visible.
 */
export function WorkflowPipeline({
  run,
  definition,
  executions,
  approvals,
  height = 180,
  selectedPhase,
  onPhaseClick,
}: Props) {
  const { nodes, edges, canvasHeight } = useMemo(() => {
    if (!definition) {
      return { nodes: [] as Node<PhaseNodeData>[], edges: [] as Edge[], canvasHeight: 0 };
    }

    const historyMap = new Map<string, PhaseHistoryEntry>();
    for (const entry of run.phaseHistory) {
      historyMap.set(entry.phase, entry);
    }

    // phase → most-recent-execution. Loop iterations (reviewer_recheck_1, etc.) get
    // their own keys here so each iteration is independently selectable.
    const execByPhase = new Map<string, WorkflowRunExecution>();
    for (const ex of executions ?? []) {
      execByPhase.set(ex.phase, ex);
    }

    const declaredNames = definition.phases.map((p) => p.name);
    const declaredSet = new Set(declaredNames);
    const declaredLabelByName = new Map(
      definition.phases.map((p) => [p.name, p.label] as const),
    );

    // Dynamic phases that don't appear in the YAML — loop iterations like
    // `reviewer_recheck_1` (re-reviews) and `reviewer_fix_1` (fix attempts).
    const dynamicNames = Array.from(
      new Set([
        ...run.phaseHistory.map((e) => e.phase),
        ...(executions ?? []).map((e) => e.phase),
      ]),
    ).filter((name) => !declaredSet.has(name));

    // Group each dynamic phase under its declared parent, sorted by start
    // time so iteration order matches the actual run.
    const childrenByParent = new Map<string, string[]>();
    const orphans: string[] = [];
    for (const name of dynamicNames) {
      const parent = findParentDeclared(name, declaredNames);
      if (parent) {
        const arr = childrenByParent.get(parent) ?? [];
        arr.push(name);
        childrenByParent.set(parent, arr);
      } else {
        orphans.push(name);
      }
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => {
        const ea = execByPhase.get(a)?.startedAt;
        const eb = execByPhase.get(b)?.startedAt;
        if (ea && eb) return ea.localeCompare(eb);
        return a.localeCompare(b);
      });
    }

    const buildNode = (name: string, x: number, y: number): Node<PhaseNodeData> => {
      const label = declaredLabelByName.get(name) ?? name;
      const histEntry = historyMap.get(name);
      const exec = execByPhase.get(name);

      let status: PhaseStatus = "pending";
      let timestamp: string | undefined;
      let duration: number | undefined;

      if (exec) {
        // Execution row is the source of truth for both timing and status —
        // phase_history is just a "this happened" marker written after the
        // fact and would otherwise show finish time as if it were start time.
        timestamp = exec.startedAt;
        if (typeof exec.durationMs === "number") {
          duration = exec.durationMs / 1000;
        }
        if (exec.success === true) status = "done";
        else if (exec.success === false) status = "failed";
        else status = "active";
      } else if (histEntry) {
        status = histEntry.success ? "done" : "failed";
        timestamp = histEntry.timestamp;
      } else if (name === run.currentPhase) {
        status = run.status === "paused" ? "paused" : "active";
      }

      // A declared loop phase (e.g. `socratic`) has no execution of its own —
      // the work happened in its dynamic iterations. Derive its status + timing
      // from them so it doesn't render as a perpetually "pending" parent.
      if (status === "pending") {
        const kids = childrenByParent.get(name) ?? [];
        const kidExecs = kids
          .map((k) => execByPhase.get(k))
          .filter((e): e is WorkflowRunExecution => !!e);
        if (kidExecs.length > 0) {
          const lastExec = execByPhase.get(kids[kids.length - 1]!);
          if (kidExecs.some((kx) => kx.success === undefined)) status = "active";
          else if (lastExec?.success === true) status = "done";
          else if (lastExec?.success === false) status = "failed";
          // Span the loop: earliest iteration start + summed iteration durations.
          timestamp = kidExecs.reduce(
            (min, kx) => (kx.startedAt < min ? kx.startedAt : min),
            kidExecs[0]!.startedAt,
          );
          const totalMs = kidExecs.reduce((sum, kx) => sum + (kx.durationMs ?? 0), 0);
          if (totalMs > 0) duration = totalMs / 1000;
        }
      }

      return {
        id: name,
        type: "phase",
        position: { x, y },
        data: { label, status, timestamp, duration, selected: selectedPhase === name },
        style: { width: NODE_WIDTH },
      };
    };

    // An approval gate, rendered in place of the generic `waiting_approval`
    // history marker. Colored by approval status; a pending gate pulses to
    // signal it's blocking the run.
    const buildApprovalNode = (a: WorkflowApproval, x: number, y = 0): Node<PhaseNodeData> => {
      const id = `approval:${a.id}`;
      const status: PhaseStatus =
        a.status === "approved" ? "done" : a.status === "rejected" ? "failed" : "paused";
      return {
        id,
        type: "phase",
        position: { x, y },
        data: {
          label: a.gate,
          status,
          kind: "approval",
          pulse: a.status === "pending",
          timestamp: a.respondedAt ?? a.createdAt,
          selected: selectedPhase === id,
        },
        style: { width: NODE_WIDTH },
      };
    };

    const reactFlowNodes: Node<PhaseNodeData>[] = [];
    const reactFlowEdges: Edge[] = [];
    const linkTo = (target: string, prev: string | undefined) => {
      if (!prev) return;
      reactFlowEdges.push({
        id: `${prev}->${target}`,
        source: prev,
        target,
        sourceHandle: "right",
        targetHandle: "left",
        style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
        animated: false,
      });
    };

    // Start time of a declared phase (execution row first, else its history
    // marker) — used to slot each approval gate into its true chronological
    // position rather than dumping all gates at the tail.
    const startOf = (name: string): string | undefined =>
      execByPhase.get(name)?.startedAt ?? historyMap.get(name)?.timestamp;

    // For each approval, the declared phase it should follow: the last declared
    // phase (in declaration order) that started before the gate was created.
    // -1 → before the first phase. Robust to non-monotonic start times — it
    // tracks the highest matching index, not a running count. So a
    // `post_architect` gate lands right after Architect, not after PR.
    const approvalRows = approvals ?? [];
    // An approval whose gate names a dynamic loop iteration (e.g. the interactive
    // generic_loop gate `socratic_iter_2`) belongs in that iteration's vertical
    // stack, not the main horizontal row. Split those out; the rest slot into
    // the top row by chronological position.
    const dynamicSet = new Set(dynamicNames);
    const loopApprovalsByIter = new Map<string, WorkflowApproval[]>();
    const mainRowApprovals: WorkflowApproval[] = [];
    for (const a of approvalRows) {
      if (dynamicSet.has(a.gate)) {
        const arr = loopApprovalsByIter.get(a.gate) ?? [];
        arr.push(a);
        loopApprovalsByIter.set(a.gate, arr);
      } else {
        mainRowApprovals.push(a);
      }
    }
    const approvalsAfterIdx = new Map<number, WorkflowApproval[]>();
    for (const a of mainRowApprovals) {
      let afterIdx = -1;
      declaredNames.forEach((name, idx) => {
        const s = startOf(name);
        if (s && s < a.createdAt) afterIdx = idx;
      });
      const arr = approvalsAfterIdx.get(afterIdx) ?? [];
      arr.push(a);
      approvalsAfterIdx.set(afterIdx, arr);
    }

    // Ordered top-row slots: declared phases in declaration order, with approval
    // gates spliced into their chronological slot. The generic `waiting_approval`
    // marker is suppressed once approvals have loaded (the gate nodes replace
    // it); if they haven't, it falls back to rendering as a plain orphan so a
    // paused run never loses the node.
    type Slot = { kind: "phase"; name: string } | { kind: "approval"; a: WorkflowApproval };
    const slots: Slot[] = [];
    for (const a of approvalsAfterIdx.get(-1) ?? []) slots.push({ kind: "approval", a });
    declaredNames.forEach((name, idx) => {
      slots.push({ kind: "phase", name });
      for (const a of approvalsAfterIdx.get(idx) ?? []) slots.push({ kind: "approval", a });
    });
    for (const name of orphans) {
      if (name === "waiting_approval" && approvalRows.length > 0) continue;
      slots.push({ kind: "phase", name });
    }

    // Lay the slots out left-to-right. Loop iterations stack vertically under
    // their declared parent's column.
    let maxColumnDepth = 0;
    let prevId: string | undefined;
    slots.forEach((slot, col) => {
      const x = col * (NODE_WIDTH + NODE_GAP);
      if (slot.kind === "approval") {
        const node = buildApprovalNode(slot.a, x);
        reactFlowNodes.push(node);
        linkTo(node.id, prevId);
        prevId = node.id;
        return;
      }
      const name = slot.name;
      reactFlowNodes.push(buildNode(name, x, 0));
      linkTo(name, prevId);
      prevId = name;

      const children = childrenByParent.get(name) ?? [];
      // Weave each iteration's interactive gate in right after the iteration it
      // belongs to, so the vertical stack reads run → gate → run → gate → run.
      type StackItem =
        | { kind: "phase"; name: string }
        | { kind: "approval"; a: WorkflowApproval };
      const stackItems: StackItem[] = [];
      for (const childName of children) {
        stackItems.push({ kind: "phase", name: childName });
        for (const a of loopApprovalsByIter.get(childName) ?? []) {
          stackItems.push({ kind: "approval", a });
        }
      }
      if (stackItems.length > maxColumnDepth) maxColumnDepth = stackItems.length;
      let childPrev = name;
      stackItems.forEach((item, idx) => {
        const y = (idx + 1) * (NODE_ROW_HEIGHT + ROW_GAP) + LOOP_PARENT_EXTRA;
        const childId = item.kind === "phase" ? item.name : `approval:${item.a.id}`;
        reactFlowNodes.push(
          item.kind === "phase" ? buildNode(item.name, x, y) : buildApprovalNode(item.a, x, y),
        );
        reactFlowEdges.push({
          id: `${childPrev}->${childId}`,
          source: childPrev,
          target: childId,
          sourceHandle: "bottom",
          targetHandle: "top",
          style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
          animated: false,
        });
        childPrev = childId;
      });
    });

    const canvasHeight =
      maxColumnDepth > 0
        ? (maxColumnDepth + 1) * (NODE_ROW_HEIGHT + ROW_GAP) + LOOP_PARENT_EXTRA + 20
        : (NODE_ROW_HEIGHT + ROW_GAP) + 20;

    return { nodes: reactFlowNodes, edges: reactFlowEdges, canvasHeight };
  }, [definition, run, executions, approvals, selectedPhase]);

  // Re-center on resize. The pipeline section is wrapped in a draggable
  // divider; without this the nodes drift off-screen as the section shrinks.
  // The `mounted` guard + try/catch + no-animation prevent xyflow's async
  // tick from accessing a torn-down store when the component is unmounted
  // or the run is swapped mid-fit (manifests as
  // `Cannot read properties of undefined (reading 'payload')`).
  //
  // Hooks must be declared before any conditional return — keep these above
  // the `!definition` short-circuit to satisfy the rules of hooks.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const flowRef = useRef<ReactFlowInstance<Node<PhaseNodeData>, Edge> | null>(null);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    const el = wrapperRef.current;
    if (!el) return undefined;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        if (!mountedRef.current) return;
        const flow = flowRef.current;
        if (!flow) return;
        try {
          if (flow.getNodes().length === 0) return;
          flow.fitView({ padding: 0.2, minZoom: 0.4, maxZoom: 1 });
        } catch {
          /* fitView raced against unmount / node-list update — safe to ignore */
        }
      });
    });
    ro.observe(el);
    return () => {
      mountedRef.current = false;
      cancelAnimationFrame(raf);
      ro.disconnect();
      flowRef.current = null;
    };
  }, []);

  if (!definition) {
    return (
      <div className="p-4 text-sm text-base-content/50">Loading workflow definition…</div>
    );
  }

  // Grow the canvas when loop iterations stack vertically. The default
  // `height` prop is the minimum (used by simple linear runs); when there
  // are children, expand to fit them.
  const numericHeight = typeof height === "number" ? height : 180;
  const effectiveHeight = Math.max(numericHeight, canvasHeight);

  return (
    <div ref={wrapperRef} style={{ width: "100%", height: effectiveHeight }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        // Cap auto-fit zoom so single-node workflows (e.g. triage) don't
        // expand to fill the whole canvas. 1.0 keeps nodes at their declared
        // pixel size; min keeps very long pipelines readable.
        fitViewOptions={{ padding: 0.2, minZoom: 0.4, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        // Allow pan + scroll-zoom so long pipelines and tall iteration stacks
        // are navigable when fitView can't squeeze them into the viewport.
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={(_, node) => onPhaseClick?.(node.id)}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="var(--color-base-300, #ccc)" />
      </ReactFlow>
    </div>
  );
}
