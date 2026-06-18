import { useEffect, useMemo, useRef } from "react";
import {
  ReactFlow,
  type Node,
  type Edge,
  type ReactFlowInstance,
  Position,
  Handle,
  type NodeProps,
  Background,
  BackgroundVariant,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import clsx from "clsx";
import type {
  WorkflowRun,
  WorkflowDefinition,
  PhaseHistoryEntry,
  WorkflowRunExecution,
} from "../api";

type PhaseStatus = "pending" | "active" | "paused" | "done" | "failed";

interface PhaseNodeData extends Record<string, unknown> {
  label: string;
  status: PhaseStatus;
  timestamp?: string;
  duration?: number;
  selected?: boolean;
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m${s}s`;
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function PhaseFlowNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  const dotClass = clsx("w-2.5 h-2.5 rounded-full shrink-0", {
    "bg-success": data.status === "done",
    "bg-error": data.status === "failed",
    "bg-info animate-pulse": data.status === "active",
    "bg-warning": data.status === "paused",
    "bg-base-300": data.status === "pending",
  });

  const containerClass = clsx(
    "flex flex-col items-center gap-1 px-3 py-2 rounded-lg border shadow-md min-w-[80px] text-center cursor-pointer transition-shadow",
    {
      "border-success/60 bg-success/15": data.status === "done",
      "border-error/60 bg-error/15": data.status === "failed",
      "border-info/60 bg-info/15": data.status === "active",
      "border-warning/60 bg-warning/15": data.status === "paused",
      "border-base-300 bg-base-300/70": data.status === "pending",
      "ring-2 ring-primary ring-offset-1 ring-offset-base-100": data.selected,
    },
  );

  return (
    <div className={containerClass}>
      <Handle type="target" position={Position.Left} className="!bg-base-300/60 !border-none !w-1 !h-1" />
      <div className="flex items-center gap-1.5">
        <span className={dotClass} />
        <span className="text-xs font-medium text-base-content/80">{data.label}</span>
      </div>
      {data.timestamp && (
        <span className="text-2xs text-base-content/40 font-mono">{formatTime(data.timestamp)}</span>
      )}
      {data.duration !== undefined && (
        <span className="text-2xs text-base-content/40 font-mono">{formatDuration(data.duration)}</span>
      )}
      <Handle type="source" position={Position.Right} className="!bg-base-300/60 !border-none !w-1 !h-1" />
    </div>
  );
}

const nodeTypes = { phase: PhaseFlowNode };

const NODE_WIDTH = 110;
const NODE_GAP = 40;
// Approximate rendered height of a PhaseFlowNode (label + timestamp + duration
// + padding). Used to stack loop iterations vertically under their parent.
const NODE_ROW_HEIGHT = 78;
const ROW_GAP = 20;

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

      return {
        id: name,
        type: "phase",
        position: { x, y },
        data: { label, status, timestamp, duration, selected: selectedPhase === name },
        style: { width: NODE_WIDTH },
      };
    };

    const reactFlowNodes: Node<PhaseNodeData>[] = [];
    const reactFlowEdges: Edge[] = [];

    // Top row: declared phases in declaration order. Iterations stack below.
    let maxColumnDepth = 0;
    declaredNames.forEach((name, idx) => {
      const x = idx * (NODE_WIDTH + NODE_GAP);
      reactFlowNodes.push(buildNode(name, x, 0));

      const children = childrenByParent.get(name) ?? [];
      if (children.length > maxColumnDepth) maxColumnDepth = children.length;

      let prevId = name;
      children.forEach((childName, childIdx) => {
        const y = (childIdx + 1) * (NODE_ROW_HEIGHT + ROW_GAP);
        reactFlowNodes.push(buildNode(childName, x, y));
        reactFlowEdges.push({
          id: `${prevId}->${childName}`,
          source: prevId,
          target: childName,
          style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
          animated: false,
        });
        prevId = childName;
      });
    });

    // Horizontal edges between declared phases (top row).
    for (let i = 0; i < declaredNames.length - 1; i++) {
      const a = declaredNames[i]!;
      const b = declaredNames[i + 1]!;
      reactFlowEdges.push({
        id: `${a}->${b}`,
        source: a,
        target: b,
        style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
        animated: false,
      });
    }

    // Orphaned dynamic phases (no matching declared parent) — append after
    // the last declared column on row 0, same as the previous behavior.
    orphans.forEach((name, idx) => {
      const x = (declaredNames.length + idx) * (NODE_WIDTH + NODE_GAP);
      reactFlowNodes.push(buildNode(name, x, 0));
      const prev = idx === 0
        ? declaredNames[declaredNames.length - 1]
        : orphans[idx - 1];
      if (prev) {
        reactFlowEdges.push({
          id: `${prev}->${name}`,
          source: prev,
          target: name,
          style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
          animated: false,
        });
      }
    });

    const canvasHeight = (maxColumnDepth + 1) * (NODE_ROW_HEIGHT + ROW_GAP) + 20;

    return { nodes: reactFlowNodes, edges: reactFlowEdges, canvasHeight };
  }, [definition, run, executions, selectedPhase]);

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
