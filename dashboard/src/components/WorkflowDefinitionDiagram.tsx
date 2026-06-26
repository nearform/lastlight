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
import type { WorkflowFullDefinition, WorkflowFullPhase } from "../api";
import {
  pipelineNodeTypes,
  type PipelineNodeData,
  type PhaseTag,
} from "./pipeline-node";

type PhaseNodeData = PipelineNodeData;

const nodeTypes = pipelineNodeTypes;

/**
 * Derive the metadata badges for a definition phase — the run-style card shows
 * these in place of the timestamp/duration a live run would carry.
 */
function phaseTags(phase: WorkflowFullPhase): PhaseTag[] {
  const tags: PhaseTag[] = [];
  if (phase.type === "context") tags.push({ label: "context", tone: "ghost" });
  if (phase.skill) tags.push({ label: `skill: ${phase.skill}`, tone: "info", mono: true });
  if (phase.prompt) tags.push({ label: "prompt", tone: "info", mono: true });
  if (phase.loop || phase.generic_loop) tags.push({ label: "loop", tone: "warning" });
  const gate = phase.approval_gate ?? phase.loop?.approval_gate;
  if (gate) tags.push({ label: "gate", tone: "error" });
  return tags;
}

const NODE_WIDTH = 150;
const NODE_GAP = 50;
const ROW_HEIGHT = 120;

/**
 * Compute layered positions for a DAG. Each phase's column is `1 + max(column
 * of its dependencies)`; rows within a column are assigned in declaration
 * order. Used when any phase has `depends_on`.
 */
function layoutDag(phases: WorkflowFullPhase[]): Map<string, { x: number; y: number }> {
  const colByName = new Map<string, number>();
  for (const phase of phases) {
    const deps = phase.depends_on ?? [];
    let col = 0;
    for (const dep of deps) {
      const depCol = colByName.get(dep);
      if (depCol !== undefined) col = Math.max(col, depCol + 1);
    }
    colByName.set(phase.name, col);
  }
  const rowByCol = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const phase of phases) {
    const col = colByName.get(phase.name) ?? 0;
    const row = rowByCol.get(col) ?? 0;
    rowByCol.set(col, row + 1);
    out.set(phase.name, { x: col * (NODE_WIDTH + NODE_GAP), y: row * ROW_HEIGHT });
  }
  return out;
}

/** Linear left-to-right layout — every phase one column to the right of the previous. */
function layoutLinear(phases: WorkflowFullPhase[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  phases.forEach((p, i) => {
    out.set(p.name, { x: i * (NODE_WIDTH + NODE_GAP), y: 0 });
  });
  return out;
}

interface Props {
  definition: WorkflowFullDefinition;
  selectedPhase: string | null;
  onPhaseClick: (phaseName: string) => void;
  height?: number | string;
}

export function WorkflowDefinitionDiagram({
  definition,
  selectedPhase,
  onPhaseClick,
  height = 320,
}: Props) {
  const isDag = useMemo(
    () => definition.phases.some((p) => Array.isArray(p.depends_on) && p.depends_on.length > 0),
    [definition.phases],
  );

  const positions = useMemo(
    () => (isDag ? layoutDag(definition.phases) : layoutLinear(definition.phases)),
    [isDag, definition.phases],
  );

  const nodes: Node<PhaseNodeData>[] = useMemo(() => {
    return definition.phases.map((phase) => {
      const pos = positions.get(phase.name) ?? { x: 0, y: 0 };
      const label = phase.label ?? phase.name;
      return {
        id: phase.name,
        type: "phase",
        position: pos,
        data: {
          label,
          status: "pending" as const,
          accent: "brand" as const,
          subtitle: phase.name !== label ? phase.name : undefined,
          tags: phaseTags(phase),
          loops: !!(phase.loop || phase.generic_loop),
          selected: phase.name === selectedPhase,
        },
        draggable: false,
        style: { width: NODE_WIDTH },
      };
    });
  }, [definition.phases, positions, selectedPhase]);

  const edges: Edge[] = useMemo(() => {
    const out: Edge[] = [];
    if (isDag) {
      for (const phase of definition.phases) {
        for (const dep of phase.depends_on ?? []) {
          out.push({
            id: `${dep}->${phase.name}`,
            source: dep,
            target: phase.name,
            sourceHandle: "right",
            targetHandle: "left",
            animated: false,
            style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
          });
        }
      }
    } else {
      for (let i = 1; i < definition.phases.length; i++) {
        const prev = definition.phases[i - 1]!.name;
        const cur = definition.phases[i]!.name;
        out.push({
          id: `${prev}->${cur}`,
          source: prev,
          target: cur,
          sourceHandle: "right",
          targetHandle: "left",
          animated: false,
          style: { stroke: "var(--color-base-300, #ccc)", strokeWidth: 1.5 },
        });
      }
    }
    return out;
  }, [definition.phases, isDag]);

  // Re-center the diagram whenever the wrapper size changes (e.g. when a
  // phase is selected and the diagram section shrinks via the resizable
  // divider). React Flow's `fitView` prop only runs on mount, so we hold a
  // reference to the flow instance and refit on every resize tick.
  // Guard against the xyflow async tick accessing a torn-down store after
  // unmount / node-list change — manifested as
  // `Cannot read properties of undefined (reading 'payload')`.
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
          flow.fitView({ padding: 0.2 });
        } catch {
          /* fitView raced against unmount — safe to ignore */
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

  return (
    <div ref={wrapperRef} style={{ width: "100%", height }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        fitViewOptions={{ padding: 0.2, minZoom: 0.4, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.5}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        onInit={(instance) => {
          flowRef.current = instance;
        }}
        onNodeClick={(_, node) => onPhaseClick(node.id)}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="var(--color-base-300, #ccc)" />
      </ReactFlow>
    </div>
  );
}
