import type { ReactNode } from "react";
import clsx from "clsx";
import {
  Group,
  Panel,
  type PanelProps,
  Separator,
  useDefaultLayout,
} from "react-resizable-panels";

/**
 * The resizable-pane trio, wrapped once so every split in the dashboard shares
 * one grab-bar and one persistence story.
 *
 * It replaced two hand-rolled drag implementations: the run page's pixel-based
 * divider, which forgot its size on every reload, and the definition page's
 * ratio-based one, which persisted but only across its own three stacked
 * sections. The library also brings keyboard resizing and the `separator` role
 * neither of those had.
 *
 * Layouts persist per `id`, which must be stable and unique across the app —
 * it is the localStorage key. `panelIds` is listed explicitly because several
 * of these groups render a pane conditionally (the PR State tab, the phase
 * pane), and the library needs the full cast to restore the right layout.
 */
export function Split({
  id,
  panelIds,
  orientation = "horizontal",
  className,
  children,
}: {
  id: string;
  panelIds: string[];
  orientation?: "horizontal" | "vertical";
  className?: string;
  children: ReactNode;
}) {
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({
    id,
    panelIds,
    storage: typeof window === "undefined" ? undefined : window.localStorage,
    onlySaveAfterUserInteractions: true,
  });
  return (
    <Group
      id={id}
      orientation={orientation}
      defaultLayout={defaultLayout}
      onLayoutChanged={onLayoutChanged}
      className={clsx("min-h-0 min-w-0", className)}
    >
      {children}
    </Group>
  );
}

/**
 * One pane.
 *
 * The three classes are not decoration. The library renders the pane as a flex
 * item, which defaults to `min-width: auto` — so a pane whose content has a
 * wide minimum (a header row of timestamps, say) refuses to shrink and holds
 * the whole column open past the divider, which looks exactly like "resizing
 * does nothing". `overflow-hidden` needs the `!` to beat the library's own
 * inline `overflow: auto`: panes here own their scrolling internally, and a
 * pane that scrolls as well gives a graph canvas two scroll containers.
 */
export function SplitPane({ className, ...rest }: PanelProps) {
  return <Panel className={clsx("min-w-0 min-h-0 overflow-hidden!", className)} {...rest} />;
}

/**
 * The draggable bar between two panes. The visual is the same short rounded
 * grab-bar both old implementations drew — turned by the group's orientation,
 * so a vertical boundary shows a tall bar rather than a wide one.
 */
export function SplitHandle({
  orientation = "horizontal",
  className,
}: {
  /** The orientation of the PARENT group — i.e. how the panes are laid out. */
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  const upright = orientation === "horizontal";
  return (
    <Separator
      className={clsx(
        "group flex items-center justify-center",
        upright ? "w-2 cursor-col-resize" : "h-2 cursor-row-resize",
        className,
      )}
    >
      <div
        className={clsx(
          "rounded-full bg-base-300 transition-colors group-hover:bg-primary/50",
          upright ? "h-12 w-1" : "w-12 h-1",
        )}
      />
    </Separator>
  );
}
