import { Position, Handle, type Node, type NodeProps } from "@xyflow/react";
import clsx from "clsx";

/**
 * Shared pipeline node presentation, used by BOTH the workflow-run pipeline
 * (WorkflowPipeline) and the read-only definition diagram
 * (WorkflowDefinitionDiagram) so the two views stay visually identical.
 *
 * A node renders as a centered card with a status dot + label. Runs additionally
 * carry a timestamp + duration; definitions instead carry `tags` (skill / prompt
 * / loop / gate / context) and an optional `subtitle` (the phase id). Approval
 * gates render as the diamond decision shape regardless of source.
 */

export type PhaseStatus = "pending" | "active" | "paused" | "done" | "failed" | "skipped";

export interface PhaseTag {
  label: string;
  /** DaisyUI badge tone. Defaults to `ghost`. */
  tone?: "info" | "warning" | "error" | "ghost" | "skill";
  /** Render in monospace, lower-case (for code-y tags like `skill: x`). */
  mono?: boolean;
}

export interface PipelineNodeData extends Record<string, unknown> {
  label: string;
  status: PhaseStatus;
  /** Run-view: when the phase started. */
  timestamp?: string;
  /** Run-view: phase duration in seconds. */
  duration?: number;
  /** Definition-view: metadata badges (skill / prompt / loop / gate / context). */
  tags?: PhaseTag[];
  /** Secondary line under the label (e.g. the phase id when it differs). */
  subtitle?: string;
  /**
   * Override the status-derived surface with a neutral brand (primary) tint.
   * Used by the definition view, whose phases have no run status — a brand
   * tint reads as "this is a definition", distinct from the status palette.
   */
  accent?: "brand";
  selected?: boolean;
  /** "approval" nodes are human-in-the-loop gates, not executed phases. */
  kind?: "phase" | "approval";
  /** Pulse the node (a pending gate awaiting a decision). */
  pulse?: boolean;
  /** Definition-view: draw a "return" arc over the card to signal it iterates. */
  loops?: boolean;
}

export function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.round(secs)}s`;
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
  return `${m}m${s}s`;
}

export function formatTime(ts: string): string {
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
export function statusSurface(status: PhaseStatus): string {
  return clsx({
    "border-success/60 bg-success/15": status === "done",
    "border-error/60 bg-error/15": status === "failed",
    "border-info/60 bg-info/15": status === "active",
    "border-warning/60 bg-warning/15": status === "paused",
    "border-base-300 bg-base-300/70": status === "pending",
    // Skipped: cascade-skipped by an upstream failure/gate — it never ran, so
    // read it as muted-and-not-run (a dashed neutral), distinct from red failed.
    "border-base-300 border-dashed bg-base-200/40": status === "skipped",
  });
}

// Handles are pure edge anchors — the graph is read-only (no connecting/
// dragging), so render them invisible and non-interactive. Edges still attach
// to their positions; React Flow doesn't need them visible.
export const handleClass =
  "!opacity-0 !bg-transparent !border-none !w-1 !h-1 !min-w-0 !min-h-0 !pointer-events-none";

/**
 * "Return" arc drawn under a looping phase (definition view) — a curved arrow
 * that exits the bottom-right of the card and loops back into the bottom-left,
 * so the phase reads as iterating rather than just carrying a flat `loop` badge.
 */
function LoopArc() {
  return (
    <div className="pointer-events-none absolute -bottom-3.5 left-1/2 -translate-x-1/2 w-[65%] h-4 text-warning">
      <svg viewBox="0 0 100 22" className="w-full h-full overflow-visible">
        {/* arc from the card's bottom-right, down and around to the bottom-left */}
        <path
          d="M 92 0 C 92 22, 8 22, 8 0"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
        {/* arrowhead pointing up into the card on the left */}
        <path d="M 3.5 7 L 8 -1 L 12.5 7 Z" fill="currentColor" />
      </svg>
    </div>
  );
}

/** Render the definition-view metadata badges. */
function TagRow({ tags }: { tags: PhaseTag[] }) {
  return (
    <div className="flex flex-wrap justify-center gap-1">
      {tags.map((t, i) => (
        <span
          key={i}
          className={clsx(
            "badge badge-xs whitespace-nowrap h-auto",
            {
              "badge-info": t.tone === "info",
              "badge-secondary": t.tone === "skill",
              "badge-warning": t.tone === "warning",
              "badge-error": t.tone === "error",
              "badge-ghost": t.tone === "ghost" || !t.tone,
            },
            t.mono && "font-mono normal-case",
          )}
        >
          {t.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Approval gate — rendered as a diamond (the classic flowchart decision shape)
 * so it reads as a human-in-the-loop checkpoint, not an executed phase. The
 * gate name + time sit in a caption beneath the diamond; the edge handles hang
 * off the diamond itself so the pipeline line passes through its centre.
 */
export function ApprovalDiamondNode({ data }: { data: PipelineNodeData }) {
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
        <Handle type="target" position={Position.Left} id="left" className={handleClass} />
        <Handle type="target" position={Position.Top} id="top" className={handleClass} />
        <div className={diamondClass}>
          {/* counter-rotate the glyph so the lock sits upright in the diamond */}
          <span className="-rotate-45 text-base-content/55">
            <LockIcon />
          </span>
        </div>
        <Handle type="source" position={Position.Right} id="right" className={handleClass} />
        <Handle type="source" position={Position.Bottom} id="bottom" className={handleClass} />
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

export function PhaseFlowNode({ data }: NodeProps<Node<PipelineNodeData>>) {
  if (data.kind === "approval") return <ApprovalDiamondNode data={data} />;

  const brand = data.accent === "brand";

  const dotClass = clsx("w-2.5 h-2.5 rounded-full shrink-0", {
    "bg-primary": brand,
    "bg-success": !brand && data.status === "done",
    "bg-error": !brand && data.status === "failed",
    "bg-info animate-pulse": !brand && data.status === "active",
    "bg-warning": !brand && data.status === "paused",
    "bg-base-300": !brand && data.status === "pending",
    "bg-base-300 opacity-60": !brand && data.status === "skipped",
  });

  const containerClass = clsx(
    "relative flex flex-col items-center gap-1 px-3 py-2 rounded-lg border shadow-md min-w-[80px] text-center cursor-pointer transition-shadow",
    brand ? "border-primary/40 bg-primary/10" : statusSurface(data.status),
    { "ring-2 ring-primary ring-offset-1 ring-offset-base-100": data.selected },
  );

  return (
    <div className={containerClass}>
      {data.loops && <LoopArc />}
      {/* Horizontal handles carry the main left-to-right pipeline; the vertical
          handles carry loop-iteration stacks so those edges run straight down. */}
      <Handle type="target" position={Position.Left} id="left" className={handleClass} />
      <Handle type="target" position={Position.Top} id="top" className={handleClass} />
      <div className="flex items-center gap-1.5">
        <span className={dotClass} />
        <span className="text-xs font-medium text-base-content/80">{data.label}</span>
      </div>
      {data.subtitle && (
        <span className="text-2xs text-base-content/50 font-mono truncate max-w-full">
          {data.subtitle}
        </span>
      )}
      {data.timestamp && (
        <span className="text-2xs text-base-content/40 font-mono">{formatTime(data.timestamp)}</span>
      )}
      {data.duration !== undefined && (
        <span className="text-2xs text-base-content/40 font-mono">{formatDuration(data.duration)}</span>
      )}
      {data.tags && data.tags.length > 0 && <TagRow tags={data.tags} />}
      <Handle type="source" position={Position.Right} id="right" className={handleClass} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={handleClass} />
    </div>
  );
}

/** Shared node-type map for both pipeline views. */
export const pipelineNodeTypes = { phase: PhaseFlowNode };
