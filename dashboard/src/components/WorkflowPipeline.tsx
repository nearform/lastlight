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
  WorkflowApproval,
} from "../api";

type PhaseStatus = "pending" | "active" | "paused" | "done" | "failed";

interface PhaseNodeData extends Record<string, unknown> {
  label: string;
  status: PhaseStatus;
  timestamp?: string;
  duration?: number;
  selected?: boolean;
  /** "approval" nodes are human-in-the-loop gates, not executed phases. */
  kind?: "phase" | "approval";
  /** Pulse the status dot (a pending gate awaiting a decision). */
  pulse?: boolean;
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

/** Tiny lock glyph for the approval-gate node header. */
function LockIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} className="w-2 h-2">
      <rect x="5" y="11" width="14" height="9" rx="1.5" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

/** Status → border/background classes, shared by the phase card and the gate diamond. */
function statusSurface(status: PhaseStatus): string {
  return clsx({
    "border-success/60 bg-success/15": status === "done",
    "border-error/60 bg-error/15": status === "failed",
    "border-info/60 bg-info/15": status === "active",
    "border-warning/60 bg-warning/15": status === "paused",
    "border-base-300 bg-base-300/70": status === "pending",
  });
}

const handleClass = "!bg-base-300/60 !border-none !w-1 !h-1";

/**
 * Approval gate — rendered as a diamond (the classic flowchart decision shape)
 * so it reads as a human-in-the-loop checkpoint, not an executed phase. The
 * gate name + time sit in a caption beneath the diamond; the edge handles hang
 * off the diamond itself so the pipeline line passes through its centre.
 */
function ApprovalDiamondNode({ data }: { data: PhaseNodeData }) {
  const diamondClass = clsx(
    "w-9 h-9 rotate-45 rounded-[4px] border-2 shadow-md flex items-center justify-center transition-shadow",
    statusSurface(data.status),
    {
      "animate-pulse": data.pulse,
      "ring-2 ring-primary ring-offset-2 ring-offset-base-100": data.selected,
    },
  );
  return (
    <div className="flex flex-col items-center gap-1 cursor-pointer">
      <div className="relative flex items-center justify-center w-9 h-9">
        <Handle type="target" position={Position.Left} className={handleClass} />
        <div className={diamondClass}>
          {/* counter-rotate the glyph so the lock sits upright in the diamond */}
          <span className="-rotate-45 text-base-content/55">
            <LockIcon />
          </span>
        </div>
        <Handle type="source" position={Position.Right} className={handleClass} />
      </div>
      <div className="flex flex-col items-center leading-tight">
        <span className="text-[9px] font-semibold uppercase tracking-wider text-base-content/40">
          approval
        </span>
        <span className="text-xs font-medium font-mono text-base-content/80">{data.label}</span>
        {data.timestamp && (
          <span className="text-2xs text-base-content/40 font-mono">{formatTime(data.timestamp)}</span>
        )}
      </div>
    </div>
  );
}

function PhaseFlowNode({ data }: NodeProps<Node<PhaseNodeData>>) {
  if (data.kind === "approval") return <ApprovalDiamondNode data={data} />;

  const dotClass = clsx("w-2.5 h-2.5 rounded-full shrink-0", {
    "bg-success": data.status === "done",
    "bg-error": data.status === "failed",
    "bg-info animate-pulse": data.status === "active",
    "bg-warning": data.status === "paused",
    "bg-base-300": data.status === "pending",
  });

  const containerClass = clsx(
    "flex flex-col items-center gap-1 px-3 py-2 rounded-lg border shadow-md min-w-[80px] text-center cursor-pointer transition-shadow",
    statusSurface(data.status),
    { "ring-2 ring-primary ring-offset-1 ring-offset-base-100": data.selected },
  );

  return (
    <div className={containerClass}>
      <Handle type="target" position={Position.Left} className={handleClass} />
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
      <Handle type="source" position={Position.Right} className={handleClass} />
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
    const buildApprovalNode = (a: WorkflowApproval, x: number): Node<PhaseNodeData> => {
      const id = `approval:${a.id}`;
      const status: PhaseStatus =
        a.status === "approved" ? "done" : a.status === "rejected" ? "failed" : "paused";
      return {
        id,
        type: "phase",
        position: { x, y: 0 },
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
    const approvalsAfterIdx = new Map<number, WorkflowApproval[]>();
    for (const a of approvalRows) {
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
      if (children.length > maxColumnDepth) maxColumnDepth = children.length;
      let childPrev = name;
      children.forEach((childName, childIdx) => {
        const y = (childIdx + 1) * (NODE_ROW_HEIGHT + ROW_GAP);
        reactFlowNodes.push(buildNode(childName, x, y));
        reactFlowEdges.push({
          id: `${childPrev}->${childName}`,
          source: childPrev,
          target: childName,
          style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
          animated: false,
        });
        childPrev = childName;
      });
    });

    const canvasHeight = (maxColumnDepth + 1) * (NODE_ROW_HEIGHT + ROW_GAP) + 20;

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
