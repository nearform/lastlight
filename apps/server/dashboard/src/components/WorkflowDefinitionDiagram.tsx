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
import { phaseSkillNames, type WorkflowFullDefinition, type WorkflowFullPhase } from "../api";
import {
  edgeStyle,
  pipelineNodeTypes,
  type PipelineNodeData,
  type PhaseTag,
} from "./pipeline-node";
import { cardHeight, mainHandles, place, NODE_WIDTH, type FlowDir } from "../lib/graph-axis";

type PhaseNodeData = PipelineNodeData;

const nodeTypes = pipelineNodeTypes;

/**
 * Derive the metadata badges for a definition phase — the run-style card shows
 * these in place of the timestamp/duration a live run would carry.
 */
function phaseTags(phase: WorkflowFullPhase): PhaseTag[] {
  const tags: PhaseTag[] = [];
  for (const skill of phaseSkillNames(phase)) {
    tags.push({ label: `skill: ${skill}`, tone: "skill", mono: true });
  }
  if (phase.prompt) tags.push({ label: "prompt", tone: "info", mono: true });
  // `loop`, `gate` and `context` used to be badges here. They moved into the
  // card's header — loop and gate as markers, the type as the header icon —
  // and saying each thing twice cost every card a tag row of height, which is
  // exactly what `ROW_HEIGHT` has to pay for.
  return tags;
}

/** Clear space between one card and the next, along the flow. */
const MAIN_GAP = 34;
/** Pitch ACROSS it — the sibling rows of one DAG layer. */
const CROSS_PITCH = NODE_WIDTH + 50;

/**
 * Height of one definition card. Definition cards vary a lot — the phase id
 * line plus a tag chip per skill and per prompt — so the pitch follows the
 * content rather than a constant that has to cover the worst case everywhere.
 */
function phaseHeight(phase: WorkflowFullPhase): number {
  return cardHeight({
    label: phase.label ?? phase.name,
    // The phase id, shown whenever it differs from the label.
    bodyLines: (phase.label ?? phase.name) !== phase.name ? 1 : 0,
    tagRows: phaseTags(phase).length,
    loops: !!(phase.loop || phase.generic_loop),
  });
}

/** Both views flow top-to-bottom; the card and the handles support either. */
const FLOW: FlowDir = "TB";

/**
 * Compute layered positions for a DAG. Each phase's LAYER is `1 + max(layer of
 * its dependencies)`, one step further along the flow; siblings within a layer
 * fan out across it in declaration order. Used when any phase has `depends_on`.
 */
function layoutDag(phases: WorkflowFullPhase[]): Map<string, { x: number; y: number }> {
  const layerByName = new Map<string, number>();
  for (const phase of phases) {
    const deps = phase.depends_on ?? [];
    let layer = 0;
    for (const dep of deps) {
      const depLayer = layerByName.get(dep);
      if (depLayer !== undefined) layer = Math.max(layer, depLayer + 1);
    }
    layerByName.set(phase.name, layer);
  }
  // A layer starts where the deepest card of the layer before it ended, so a
  // layer holding one tall card pushes the next one down and a layer of bare
  // cards costs only what it needs.
  const deepestByLayer = new Map<number, number>();
  for (const phase of phases) {
    const layer = layerByName.get(phase.name) ?? 0;
    deepestByLayer.set(layer, Math.max(deepestByLayer.get(layer) ?? 0, phaseHeight(phase)));
  }
  const mainByLayer = new Map<number, number>();
  let main = 0;
  for (const layer of [...deepestByLayer.keys()].sort((a, b) => a - b)) {
    mainByLayer.set(layer, main);
    main += deepestByLayer.get(layer)! + MAIN_GAP;
  }

  const seatsByLayer = new Map<number, number>();
  const out = new Map<string, { x: number; y: number }>();
  for (const phase of phases) {
    const layer = layerByName.get(phase.name) ?? 0;
    const seat = seatsByLayer.get(layer) ?? 0;
    seatsByLayer.set(layer, seat + 1);
    out.set(phase.name, place(FLOW, mainByLayer.get(layer) ?? 0, seat * CROSS_PITCH));
  }
  return out;
}

/** Linear layout — every phase one step further along the flow than the last. */
function layoutLinear(phases: WorkflowFullPhase[]): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  let main = 0;
  for (const phase of phases) {
    out.set(phase.name, place(FLOW, main, 0));
    main += phaseHeight(phase) + MAIN_GAP;
  }
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
  height = "100%",
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
          phaseType: phase.type,
          hasGate: !!(phase.approval_gate ?? phase.loop?.approval_gate),
          iterates: !!(phase.loop || phase.generic_loop),
          // Distinct from `iterates`: this one draws the return arc.
          loops: !!(phase.loop || phase.generic_loop),
          selected: phase.name === selectedPhase,
          flow: FLOW,
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
            sourceHandle: mainHandles(FLOW).source,
            targetHandle: mainHandles(FLOW).target,
            animated: false,
            style: edgeStyle("pending", true),
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
          sourceHandle: mainHandles(FLOW).source,
          targetHandle: mainHandles(FLOW).target,
          animated: false,
          style: edgeStyle("pending", true),
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
    <div ref={wrapperRef} className="ll-canvas" style={{ width: "100%", height }}>
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
        <Background variant={BackgroundVariant.Dots} gap={16} size={0.5} color="var(--ll-canvas-dot, #ccc)" />
      </ReactFlow>
    </div>
  );
}
