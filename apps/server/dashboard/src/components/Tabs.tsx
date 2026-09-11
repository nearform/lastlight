import type { ReactNode } from "react";
import clsx from "clsx";

/**
 * The one tab strip. Three near-identical copies of this markup grew up
 * independently (the phase panel's Details/Loaded strip, the definition page's
 * Diagram/YAML strip, and the prompt-source sub-tabs); the panelised layout
 * needs a strip that can hold five tabs in a phone-width column, so the idiom
 * is factored out here rather than copied a fourth time.
 *
 * Scrolls horizontally instead of wrapping — a wrapped strip changes the height
 * of the pane it labels, which on a narrow screen is the whole page.
 */
export function Tabs({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      role="tablist"
      className={clsx(
        "flex gap-1 shrink-0 border-b border-hairline overflow-x-auto whitespace-nowrap",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      role="tab"
      aria-selected={active}
      className={clsx(
        // `min-h-9` rather than the bare text height: this strip is the primary
        // navigation on a phone, where a 20px target is not hittable.
        "shrink-0 min-h-9 px-3 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
        active
          ? "border-primary text-primary"
          : "border-transparent text-muted hover:text-base-content",
      )}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
