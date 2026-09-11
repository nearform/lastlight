import { Position, Handle, type Node, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import { truncateSummary } from "../lib/phase-outcome";
import { type FlowDir } from "../lib/graph-axis";

/**
 * Shared pipeline node presentation, used by BOTH the workflow-run pipeline
 * (WorkflowPipeline) and the read-only definition diagram
 * (WorkflowDefinitionDiagram) so the two views stay visually identical.
 *
 * A phase renders as a two-part card: a tinted HEADER strip carrying the phase
 * type's icon, the label, and a right-hand marker slot; and a BODY carrying
 * what the phase did. Runs put the outcome summary and a time·duration line in
 * the body; definitions put the phase id and its metadata tags there. Approval
 * gates render as the diamond decision shape regardless of source.
 *
 * ## The one rule: type owns hue, status owns surface
 *
 * A reader must never confuse "this is an agent phase" with "this phase
 * failed", so the two facts never share a visual channel:
 *
 * | channel                        | carries |
 * | ------------------------------ | ------- |
 * | the type icon's colour + glyph | TYPE    |
 * | border + body wash             | STATUS  |
 * | header right-slot dot          | STATUS  |
 * | connector dots + edge stroke   | STATUS  |
 * | header right-slot badges       | the phase's DECLARATIONS (gate / loop) |
 *
 * Type draws from its OWN four hues (`--ll-type-*` in `index.css`), and status
 * only from `success` / `error` / `info` / `warning` / `base-300`. The type
 * hues are separate tokens rather than daisyUI's `primary` / `secondary` /
 * `accent` because two of those are both green in the light theme, which
 * collapsed agent and post-review into one colour.
 *
 * Type is deliberately ONLY the icon. A tinted header strip was tried and
 * abandoned: a phase with no body renders as header-only, so the wash became
 * the entire card and a solid lavender block read as a status. The hint has to
 * sit under the signal, and a 14px glyph cannot outshout a border.
 */

/**
 * `unmet` is the generic-loop `until_bash` exit-condition check that RAN and
 * came back RED (`stopReason: "condition_not_met"`). It is neither a success
 * (the loop is not finished) nor a failure (a red gate is the loop working as
 * designed — it is what earns the agent another iteration), so it gets its own
 * muted tone rather than borrowing green or red.
 */
export type PhaseStatus =
  | "pending"
  | "active"
  | "paused"
  | "done"
  | "failed"
  | "skipped"
  | "unmet";

/** The phase kinds a workflow YAML may declare. Mirrors `WorkflowFullPhase["type"]`. */
export type PhaseType = "context" | "agent" | "bash" | "script" | "post-review";

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
  /**
   * The phase kind from the YAML — drives the header accent and icon.
   *
   * Named `phaseType` rather than `type` because React Flow's `Node` already
   * has a `type` field, and a `data.type` sitting beside `node.type` is a trap.
   * Optional: derived phase names and orphan nodes reach the card with nothing
   * declared, and fall back to the generic accent.
   */
  phaseType?: PhaseType;
  /** Run-view: when the phase started. */
  timestamp?: string;
  /** Run-view: phase duration in seconds. */
  duration?: number;
  /** Definition-view: metadata badges (skill / prompt / context). */
  tags?: PhaseTag[];
  /** Secondary line under the label (e.g. the phase id when it differs). */
  subtitle?: string;
  /**
   * Run-view: the phase's OUTCOME SUMMARY — what it did, from its
   * `phase_history` entry (see `lib/phase-outcome.ts`). Clipped to at most two
   * short lines; the full text rides the card's `title` and the detail panel. A
   * card is narrow, so this is deliberately a hint that a phase is worth
   * clicking, not the place to read the outcome.
   */
  summary?: string;
  /**
   * The summary says the phase declined to do its work. Display-only: it mutes
   * the summary line so a green-but-did-nothing phase is distinguishable from a
   * green-and-did-a-lot one at a glance, and never touches {@link status}.
   */
  summaryNoOp?: boolean;
  /**
   * Suppress the status channel entirely — used by the definition view, whose
   * phases have no run status.
   *
   * Note this is NOT "paint everything primary". Painting a definition in the
   * brand colour and painting a run where every phase is grey-pending look
   * uncomfortably alike; drawing no status at all is what makes a definition
   * read as a definition.
   */
  accent?: "brand";
  selected?: boolean;
  /** "approval" nodes are human-in-the-loop gates, not executed phases. */
  kind?: "phase" | "approval";
  /** Pulse the node (a pending gate awaiting a decision). */
  pulse?: boolean;
  /** Definition-view: draw a "return" arc over the card to signal it iterates. */
  loops?: boolean;
  /**
   * The phase DECLARES an approval gate. Header marker only — distinct from a
   * gate's own node, and from whether that gate has fired.
   */
  hasGate?: boolean;
  /**
   * The phase iterates. Deliberately separate from {@link loops}, which draws
   * the return arc: reusing `loops` for the header marker would newly draw arcs
   * on run cards, which is a change nobody asked for.
   */
  iterates?: boolean;
  /**
   * Draw the CROSS-axis connector dots as well as the main ones. Set on
   * loop-stack children, the only nodes whose edges run across the flow.
   */
  stacked?: boolean;
  /**
   * Which way the graph flows, so the card knows which pair of connector dots
   * is the one its pipeline edges actually use. Defaults to `TB` — both views
   * run vertically — and the dots are purely decorative, so a node that omits
   * it renders the right thing anyway.
   */
  flow?: FlowDir;
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

/**
 * Start time and duration on ONE line — they are both "when", they are both
 * short, and giving each its own row cost every card a line of height for no
 * information. The middot only appears when both are present, so a phase with
 * a time and no duration does not render a dangling separator.
 */
function MetaLine({ timestamp, duration }: { timestamp?: string; duration?: number }) {
  if (!timestamp && duration === undefined) return null;
  return (
    <span className="text-2xs text-faint font-mono whitespace-nowrap tabular-nums">
      {timestamp && formatTime(timestamp)}
      {timestamp && duration !== undefined && " · "}
      {duration !== undefined && formatDuration(duration)}
    </span>
  );
}

// ── Type accents ───────────────────────────────────────────────────────────

/**
 * The type accent classes. Each sets a local `--ll-type` that the icon reads —
 * see `index.css`, where the four hues are defined per theme.
 *
 * These are NOT daisyUI's `primary`/`secondary`/`accent`: in the light theme
 * two of those are both green, which collapsed the one distinction this channel
 * exists to draw.
 */
type AccentClass = "ll-type-agent" | "ll-type-review" | "ll-type-cmd" | "ll-type-context";

const ICON_CLASS = "w-3.5 h-3.5 shrink-0";

/** `type: agent` — a model runs. The workhorse. */
function BoltIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={ICON_CLASS}>
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}

/** `type: bash` — a shell command. Prompt chevron + cursor. */
function TerminalIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={ICON_CLASS}>
      <path d="M5 7l4 4-4 4" />
      <path d="M12 17h7" />
    </svg>
  );
}

/** `type: script` — inline source. Braces, the universal "this is code". */
function BracesIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={ICON_CLASS}>
      <path d="M8 3H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1" />
      <path d="M16 3h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1" />
    </svg>
  );
}

/** `type: context` — gathers facts, runs no model. Stacked layers. */
function LayersIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={ICON_CLASS}>
      <path d="m12 3 9 5-9 5-9-5 9-5Z" />
      <path d="m3 13 9 5 9-5" />
    </svg>
  );
}

/** `type: post-review` — submits the review in-process. Bubble with a verdict. */
function ReviewIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={ICON_CLASS}>
      <path d="M21 12a7 7 0 0 1-7 7H8l-5 3 1.5-4.5A7 7 0 0 1 10 5h4a7 7 0 0 1 7 7Z" />
      <path d="m8.5 12 2 2 4-4" />
    </svg>
  );
}

/** No declared type — a derived name, an orphan, a phase we have no YAML for. */
function GenericIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={ICON_CLASS}>
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

interface TypeAccent {
  cls: AccentClass;
  Icon: () => React.ReactElement;
  title: string;
}

/**
 * Phase type → header accent.
 *
 * `bash` and `script` deliberately SHARE `ll-type-cmd`: they are siblings —
 * deterministic commands run in the sandbox with no model behind them — and it
 * is the glyph, not the hue, that tells them apart. Giving each its own colour
 * would spend a scarce channel on a distinction nobody scans for.
 */
const TYPE_ACCENT: Record<PhaseType, TypeAccent> = {
  agent: { cls: "ll-type-agent", Icon: BoltIcon, title: "agent phase — runs a model" },
  "post-review": { cls: "ll-type-review", Icon: ReviewIcon, title: "post-review phase — submits the review" },
  bash: { cls: "ll-type-cmd", Icon: TerminalIcon, title: "bash phase — shell command" },
  script: { cls: "ll-type-cmd", Icon: BracesIcon, title: "script phase — inline source" },
  context: { cls: "ll-type-context", Icon: LayersIcon, title: "context phase — gathers facts" },
};

const GENERIC_ACCENT: TypeAccent = {
  cls: "ll-type-context",
  Icon: GenericIcon,
  title: "phase",
};

function accentFor(phaseType: PhaseType | undefined): TypeAccent {
  return (phaseType && TYPE_ACCENT[phaseType]) || GENERIC_ACCENT;
}

// ── Status channels ────────────────────────────────────────────────────────

/**
 * Status → border + background, for the shapes that are a single surface (the
 * approval diamond, the fan-out container). The two-part phase card splits this
 * into {@link statusBorder} / {@link statusBody} instead.
 */
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
    // Unmet: the loop's exit check ran and said "not yet". Solid border (it DID
    // run, unlike skipped) but a neutral tone (it is not a pass or a failure).
    "border-base-content/25 bg-base-200/60": status === "unmet",
  });
}

/** The card's border colour and style, all four sides. */
export function statusBorder(status: PhaseStatus): string {
  return clsx({
    "border-success/60": status === "done",
    "border-error/65": status === "failed",
    "border-info/65": status === "active",
    "border-warning/65": status === "paused",
    "border-node-border": status === "pending",
    "border-node-border border-dashed": status === "skipped",
    "border-base-content/20": status === "unmet",
  });
}

/** The body wash — much fainter than the old single-surface tint, since it is now a larger area. */
export function statusBody(status: PhaseStatus): string {
  return clsx({
    "bg-success/8": status === "done",
    "bg-error/8": status === "failed",
    "bg-info/8": status === "active",
    "bg-warning/8": status === "paused",
    "bg-base-200/50": status === "pending" || status === "skipped" || status === "unmet",
  });
}

/** Status → the dot's fill, shared by the header dot and the connector dots. */
function statusDotBg(status: PhaseStatus): string {
  return clsx({
    "bg-success": status === "done",
    "bg-error": status === "failed",
    "bg-info": status === "active",
    "bg-warning": status === "paused",
    "bg-base-300": status === "pending",
    "bg-base-300/60": status === "skipped",
    "bg-base-content/30": status === "unmet",
  });
}

function StatusDot({ status }: { status: PhaseStatus }) {
  return (
    <span
      title={status}
      className={clsx(
        "w-2 h-2 rounded-full shrink-0",
        statusDotBg(status),
        status === "active" && "animate-pulse",
      )}
    />
  );
}

/**
 * Edge stroke for an edge LEAVING a node in this state.
 *
 * Tinted by SOURCE, not target: tinting by target leaves the whole pipeline
 * grey until the very last node, whereas tinting by source reads as progress
 * flowing rightwards. Opacity does the restraint — a canvas of fully saturated
 * lines is spaghetti — so `failed` and `active` get the lift, because they are
 * what a reader scans for, and everything else sits back.
 */
export function edgeStyle(status: PhaseStatus, brand = false): React.CSSProperties {
  if (brand) return { stroke: "var(--color-primary)", strokeOpacity: 0.45, strokeWidth: 1.5 };
  const map: Record<PhaseStatus, [string, number]> = {
    done: ["var(--color-success)", 0.55],
    failed: ["var(--color-error)", 0.75],
    active: ["var(--color-info)", 0.75],
    paused: ["var(--color-warning)", 0.7],
    unmet: ["var(--color-base-content)", 0.3],
    pending: ["var(--color-base-300)", 1],
    skipped: ["var(--color-base-300)", 0.5],
  };
  const [stroke, strokeOpacity] = map[status];
  return { stroke, strokeOpacity, strokeWidth: 1.5 };
}

// ── Handles and connector dots ─────────────────────────────────────────────

// Handles are pure edge anchors — the graph is read-only (no connecting/
// dragging), so render them invisible and non-interactive. Edges still attach
// to their positions; React Flow doesn't need them visible.
//
// The visible connector dots below are a SEPARATE decorative sibling rather
// than a restyle of these, for three independent reasons: `router-node.tsx`
// imports this class and would gain dots it never asked for; xyflow derives an
// edge's anchor from the handle's MEASURED bounds, so growing a 1px handle to
// 8px shifts every anchor and detaches edges from the dots; and a visible
// handle takes pointer events, which would swallow clicks near the card edge
// where the whole card is the click target.
export const handleClass =
  "opacity-0! bg-transparent! border-none! w-1! h-1! min-w-0! min-h-0! pointer-events-none!";

const DOT_SIDE = {
  left: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
  right: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
  top: "top-0 left-1/2 -translate-y-1/2 -translate-x-1/2",
  bottom: "bottom-0 left-1/2 translate-y-1/2 -translate-x-1/2",
} as const;

/**
 * The visible plug on the end of an edge, sitting on the same edge midpoint the
 * invisible Handle occupies. The ring is in the canvas colour so the dot reads
 * as a terminator rather than as a blob the line disappears into.
 *
 * Note the card must NOT carry `overflow-hidden` (a tempting way to clip the
 * header wash to the rounded corners) — it would clip these, and the LoopArc.
 */
function ConnectorDot({
  side,
  status,
  brand,
}: {
  side: keyof typeof DOT_SIDE;
  status: PhaseStatus;
  brand?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        "absolute z-10 w-2 h-2 rounded-full pointer-events-none ll-dot-ring",
        DOT_SIDE[side],
        brand ? "bg-primary/70" : statusDotBg(status),
      )}
    />
  );
}

/**
 * The two connector-dot sides for each axis. The MAIN pair is where the
 * pipeline's own edges land; the CROSS pair only appears on a stacked node,
 * whose siblings chain across the flow.
 */
function dotSides(flow: FlowDir | undefined): {
  main: [keyof typeof DOT_SIDE, keyof typeof DOT_SIDE];
  cross: [keyof typeof DOT_SIDE, keyof typeof DOT_SIDE];
} {
  return flow === "LR"
    ? { main: ["left", "right"], cross: ["top", "bottom"] }
    : { main: ["top", "bottom"], cross: ["left", "right"] };
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

/**
 * "Return" arc drawn under a looping phase (definition view) — a curved arrow
 * that exits the bottom-right of the card and loops back into the bottom-left,
 * so the phase reads as iterating rather than just carrying a flat `loop` badge.
 */
function LoopArc() {
  // Muted rather than amber: the arc's SHAPE already says "iterates", and in
  // `warning` it was the single most saturated thing on a definition canvas
  // whose whole point is that nothing on it has a status.
  return (
    <div className="pointer-events-none absolute -bottom-3.5 left-1/2 -translate-x-1/2 w-[65%] h-4 text-faint">
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

/**
 * A header marker — what the phase DECLARES, not how its run went.
 *
 * Deliberately NEUTRAL. An earlier pass tinted these red and amber for "a gate
 * is a stop, a loop is a caution", which put declaration semantics in the exact
 * two colours the status channel uses for failed and paused — so a healthy
 * phase that merely declares a gate wore a red badge. They are labels, not
 * verdicts, and they read as labels.
 */
function HeaderMarker({ children }: { children: React.ReactNode }) {
  return (
    <span className="ll-chip text-[8px] font-semibold uppercase tracking-wider leading-none px-1 py-0.5 rounded-sm">
      {children}
    </span>
  );
}

/** Render the definition-view metadata badges. */
function TagRow({ tags }: { tags: PhaseTag[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t, i) => (
        <span
          key={i}
          className={clsx(
            // `ll-chip`, not daisyUI's filled badges: `badge-secondary`
            // rendered as a heavy near-black pill on the light theme, which
            // made the least important thing on the card the loudest.
            "ll-chip text-[10px] leading-none px-1.5 py-1 rounded-sm whitespace-nowrap",
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
 * The header strip, shared by the phase card and the fan-out container so the
 * two cannot drift — which is the whole reason this module exists.
 */
function NodeHeader({
  data,
  accent,
  divided,
}: {
  data: PipelineNodeData;
  accent: TypeAccent;
  divided: boolean;
}) {
  const { Icon } = accent;
  const brand = data.accent === "brand";
  return (
    <div
      className={clsx(
        "flex items-start gap-1.5 px-2 py-1.5 rounded-t-[7px] ll-head",
        divided && "border-b border-hairline",
        accent.cls,
      )}
    >
      <span className="mt-px ll-type-ink" title={accent.title}>
        <Icon />
      </span>
      <span className="text-xs font-medium leading-tight text-strong text-left line-clamp-2">
        {data.label}
      </span>
      <span className="ml-auto shrink-0 flex items-center gap-1 pt-0.5">
        {data.hasGate && <HeaderMarker>gate</HeaderMarker>}
        {data.iterates && <HeaderMarker>loop</HeaderMarker>}
        {!brand && <StatusDot status={data.status} />}
      </span>
    </div>
  );
}

export function PhaseFlowNode({ data }: NodeProps<Node<PipelineNodeData>>) {
  if (data.kind === "approval") return <ApprovalDiamondNode data={data} />;

  const brand = data.accent === "brand";
  const accent = accentFor(data.phaseType);

  // Nothing to put in the body → render the header alone, rather than a bare
  // 12px empty strip under it.
  const hasBody = Boolean(
    data.summary ||
      data.timestamp ||
      data.duration !== undefined ||
      data.subtitle ||
      data.tags?.length,
  );

  return (
    // The full outcome summary as the card's tooltip — a narrow node can only
    // ever show a clipped line, and truncating with no way to read the rest is
    // how you learn a phase did something without learning what.
    <div
      className={clsx(
        "relative ll-node rounded-node border shadow-panel cursor-pointer transition-shadow hover:shadow-pop",
        brand ? "border-node-border" : statusBorder(data.status),
        data.selected && "ring-2 ring-primary ring-offset-2 ring-offset-base-100 shadow-pop",
      )}
      title={data.summary ?? data.label}
    >
      {data.loops && <LoopArc />}
      {/* All four handles exist on every card; which pair the pipeline uses is
          the layout's choice (see lib/graph-axis.ts). Vertically, the top and
          bottom carry the main chain and the sides carry loop stacks. */}
      <Handle type="target" position={Position.Left} id="left" className={handleClass} />
      <Handle type="target" position={Position.Top} id="top" className={handleClass} />

      <NodeHeader data={data} accent={accent} divided={hasBody} />

      {hasBody && (
        <div
          className={clsx(
            "flex flex-col gap-1 px-2 py-1.5 rounded-b-[7px] text-left",
            brand ? "bg-base-100/50" : statusBody(data.status),
          )}
        >
          {data.summary && (
            <span
              className={clsx(
                "text-2xs leading-tight break-words line-clamp-2",
                data.summaryNoOp ? "italic text-faint" : "text-muted",
              )}
            >
              {truncateSummary(data.summary, 56)}
            </span>
          )}
          <MetaLine timestamp={data.timestamp} duration={data.duration} />
          {data.subtitle && (
            <span className="text-2xs text-faint font-mono truncate max-w-full">
              {data.subtitle}
            </span>
          )}
          {data.tags && data.tags.length > 0 && <TagRow tags={data.tags} />}
        </div>
      )}

      <Handle type="source" position={Position.Right} id="right" className={handleClass} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={handleClass} />
      {dotSides(data.flow).main.map((side) => (
        <ConnectorDot key={side} side={side} status={data.status} brand={brand} />
      ))}
      {data.stacked &&
        dotSides(data.flow).cross.map((side) => (
          <ConnectorDot key={side} side={side} status={data.status} brand={brand} />
        ))}
    </div>
  );
}

/**
 * Approval gate — rendered as a diamond (the classic flowchart decision shape)
 * so it reads as a human-in-the-loop checkpoint, not an executed phase. The
 * gate name + time sit in a caption beneath the diamond; the edge handles hang
 * off the diamond itself so the pipeline line passes through its centre.
 *
 * It is deliberately the one member of the family with NO type accent: a human
 * gate is not a phase type, and the absence is itself the signal.
 */
export function ApprovalDiamondNode({ data }: { data: PipelineNodeData }) {
  const diamondClass = clsx(
    "ll-node w-9 h-9 rotate-45 rounded-[4px] border-2 shadow-panel flex items-center justify-center transition-shadow",
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
          <span className="-rotate-45 text-muted">
            <LockIcon />
          </span>
        </div>
        <Handle type="source" position={Position.Right} id="right" className={handleClass} />
        <Handle type="source" position={Position.Bottom} id="bottom" className={handleClass} />
        {/* The rotated square's vertices ARE these midpoints, which is what
            makes a diamond↔card connection read as one continuous line. */}
        {dotSides(data.flow).main.map((side) => (
          <ConnectorDot key={side} side={side} status={data.status} />
        ))}
        {data.stacked &&
          dotSides(data.flow).cross.map((side) => (
            <ConnectorDot key={side} side={side} status={data.status} />
          ))}
      </div>
      {/* No "approval" eyebrow: the lock glyph already says it, and the line it
          cost was height inside a loop stack, where pitch is a fixed constant. */}
      <div className="flex flex-col items-center leading-tight">
        <span className="text-xs font-medium font-mono text-strong">{data.label}</span>
        {data.timestamp && (
          <span className="text-2xs text-faint font-mono">{formatTime(data.timestamp)}</span>
        )}
      </div>
    </div>
  );
}

/**
 * A `type: fanout` phase, drawn as a CONTAINER its branches sit inside.
 *
 * React Flow expresses this with `parentId` on the children (positions become
 * relative to this node), which is why this is a custom type rather than the
 * built-in `group`: `group` has no handles, and the main left-to-right pipeline
 * has to enter and leave the fan-out like any other column.
 *
 * Containment is what says "these ran at once". The branches carry no edges
 * between them and none from this header — a fan-out has no first or last
 * branch, and any line drawn between them would assert an order the run does
 * not have. The card renders a header and then empty space; the children are
 * absolutely positioned into that space by the layout.
 *
 * It gets the shared header but deliberately NOT the left rail: dashed-plus-
 * rail reads as a mistake, and the dashed border is already the "this is a
 * region, not a card" signal.
 */
export function FanoutGroupNode({ data }: NodeProps<Node<PipelineNodeData>>) {
  const accent = accentFor(data.phaseType);
  return (
    <div
      className={clsx(
        "relative ll-node w-full h-full rounded-panel border-2 border-dashed shadow-panel transition-shadow",
        statusSurface(data.status),
        { "ring-2 ring-primary ring-offset-1 ring-offset-base-100": data.selected },
      )}
      title={data.summary}
    >
      <Handle type="target" position={Position.Left} id="left" className={handleClass} />
      <Handle type="target" position={Position.Top} id="top" className={handleClass} />
      {/* The header is the clickable phase card; the space below it belongs to
          the branch children, so nothing here may capture their pointer events. */}
      <div className="cursor-pointer">
        <NodeHeader data={data} accent={accent} divided />
        <div className="flex flex-col gap-0.5 px-2 py-1.5 bg-base-100/25">
          <MetaLine timestamp={data.timestamp} duration={data.duration} />
          {data.subtitle && (
            <span className="text-2xs text-faint font-mono">{data.subtitle}</span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Right} id="right" className={handleClass} />
      <Handle type="source" position={Position.Bottom} id="bottom" className={handleClass} />
      {dotSides(data.flow).main.map((side) => (
        <ConnectorDot key={side} side={side} status={data.status} />
      ))}
    </div>
  );
}

/** Shared node-type map for both pipeline views. */
export const pipelineNodeTypes = { phase: PhaseFlowNode, fanout: FanoutGroupNode };
