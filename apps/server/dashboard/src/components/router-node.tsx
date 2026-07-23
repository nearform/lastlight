import { Position, Handle, type Node, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import {
  SparklesIcon,
  CodeBracketIcon,
  FunnelIcon,
  RectangleGroupIcon,
  BoltIcon,
  NoSymbolIcon,
  ChatBubbleLeftRightIcon,
} from "@heroicons/react/24/solid";
import { handleClass } from "./pipeline-node";

/**
 * Playground-specific node presentation. Unlike the shared `pipeline-node`
 * (which renders every phase as one uniform "brand" card), the router
 * playground wants a distinct visual identity PER COLUMN — inputs, event
 * types, the router hub, and handlers each get their own icon + colour — plus
 * one unmistakable "hot path" treatment so a triggered route reads at a glance.
 */

export type RouterColumn = "input" | "event" | "router" | "handler" | "terminal";
export type RouterVariant =
  | "github"
  | "slack"
  | "deterministic"
  | "classifier"
  | "router"
  | "workflow"
  | "in-process"
  // Fall-through outcomes — the event never reaches a handler. `ignore` drops
  // it silently; `reply` posts a canned message. Rendered as the path endpoint.
  | "ignore"
  | "reply";

export interface RouterNodeData extends Record<string, unknown> {
  label: string;
  column: RouterColumn;
  variant: RouterVariant;
  subtitle?: string;
  /** A short pill on the right of the card (e.g. the router fall-through action). */
  badge?: { label: string; tone: "warning" | "info" | "ghost" };
  /** The clicked selector (active input / event) — a soft "you are here" state. */
  selected?: boolean;
  /** Part of the just-triggered route — the strong, contrasting hot-path state. */
  matched?: boolean;
  /** Not on the triggered route while a result is shown — recede into the back. */
  dimmed?: boolean;
}

/** GitHub mark — heroicons has no brand logos, so inline the octocat glyph. */
function GitHubMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

/** Slack mark — inline hash/octothorpe brand glyph. */
function SlackMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" className={className} aria-hidden>
      <path d="M3.5 10.1a1.5 1.5 0 1 1-1.5-1.5h1.5v1.5Zm.8 0a1.5 1.5 0 0 1 3 0v3.75a1.5 1.5 0 0 1-3 0V10.1ZM5.8 3.5A1.5 1.5 0 1 1 7.3 2v1.5H5.8Zm0 .8a1.5 1.5 0 0 1 0 3H2a1.5 1.5 0 0 1 0-3h3.8ZM12.5 5.8A1.5 1.5 0 1 1 14 7.3h-1.5V5.8Zm-.8 0a1.5 1.5 0 0 1-3 0V2.05a1.5 1.5 0 0 1 3 0V5.8ZM10.2 12.5a1.5 1.5 0 1 1-1.5 1.5v-1.5h1.5Zm0-.8a1.5 1.5 0 0 1 0-3H14a1.5 1.5 0 0 1 0 3h-3.8Z" />
    </svg>
  );
}

/** Column → icon + the colour of its small icon tile. */
function iconFor(variant: RouterVariant) {
  switch (variant) {
    case "github":
      return { Icon: GitHubMark, tile: "bg-neutral text-neutral-content" };
    case "slack":
      return { Icon: SlackMark, tile: "bg-[#4A154B] text-white" };
    case "deterministic":
      return { Icon: CodeBracketIcon, tile: "bg-base-content/55 text-base-100" };
    case "classifier":
      return { Icon: SparklesIcon, tile: "bg-info text-info-content" };
    case "router":
      return { Icon: FunnelIcon, tile: "bg-primary text-primary-content" };
    case "workflow":
      return { Icon: RectangleGroupIcon, tile: "bg-success text-success-content" };
    case "in-process":
      return { Icon: BoltIcon, tile: "bg-warning text-warning-content" };
    case "ignore":
      return { Icon: NoSymbolIcon, tile: "bg-base-content/45 text-base-100" };
    case "reply":
      return { Icon: ChatBubbleLeftRightIcon, tile: "bg-info text-info-content" };
  }
}

/** Idle (un-triggered) surface per column — the resting visual hierarchy. */
function idleSurface(data: RouterNodeData): string {
  if (data.column === "router") return "border-primary/45 bg-primary/5";
  if (data.variant === "workflow") return "border-success/25 bg-success/[0.04]";
  if (data.variant === "in-process") return "border-warning/30 bg-warning/[0.05]";
  return "border-base-300 bg-base-100"; // inputs + event types
}

export function RouterFlowNode({ data }: NodeProps<Node<RouterNodeData>>) {
  const { Icon, tile } = iconFor(data.variant);
  const isRouter = data.column === "router";
  // A terminal endpoint sits in the handler column atop a dimmed handler, so it
  // needs an opaque fill to occlude it cleanly (matched's tint is translucent).
  const isTerminal = data.variant === "ignore" || data.variant === "reply";

  const card = clsx(
    "relative flex items-center gap-2.5 rounded-lg border px-2.5 shadow-sm cursor-pointer",
    "overflow-hidden whitespace-nowrap transition-all duration-150",
    isRouter ? "py-2.5" : "py-2",
    // Layer precedence: matched (hot path) beats selected beats idle.
    data.matched
      ? "border-primary bg-primary/10 ring-2 ring-primary/60 ring-offset-2 ring-offset-base-100 shadow-lg shadow-primary/25 scale-[1.03]"
      : data.selected
        ? "border-base-content/40 bg-base-200 ring-1 ring-base-content/15 shadow"
        : idleSurface(data),
    data.dimmed && !data.matched && "opacity-30",
    isTerminal && "!bg-base-100",
  );

  return (
    <div className={card}>
      <Handle type="target" position={Position.Left} id="left" className={handleClass} />
      <span
        className={clsx(
          "grid place-items-center rounded-md shrink-0",
          isRouter ? "w-7 h-7" : "w-6 h-6",
          tile,
        )}
      >
        <Icon className={isRouter ? "w-4 h-4" : "w-3.5 h-3.5"} />
      </span>
      <div className="min-w-0 flex-1 leading-tight">
        <div
          className={clsx(
            "truncate font-semibold text-base-content",
            isRouter ? "text-sm" : "text-xs",
          )}
          title={data.label}
        >
          {data.label}
        </div>
        {data.subtitle && (
          <div className="truncate font-mono text-[10px] text-base-content/50" title={data.subtitle}>
            {data.subtitle}
          </div>
        )}
      </div>
      {data.badge && (
        <span
          className={clsx("badge badge-xs shrink-0 whitespace-nowrap", {
            "badge-warning": data.badge.tone === "warning",
            "badge-info": data.badge.tone === "info",
            "badge-ghost": data.badge.tone === "ghost",
          })}
        >
          {data.badge.label}
        </span>
      )}
      <Handle type="source" position={Position.Right} id="right" className={handleClass} />
    </div>
  );
}

export const routerNodeTypes = { routerNode: RouterFlowNode };
