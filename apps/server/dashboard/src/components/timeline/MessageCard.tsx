import clsx from "clsx";
import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

interface Props {
  title: ReactNode;
  timestamp?: string;
  children?: ReactNode;
  headerRight?: ReactNode;
  isNew?: boolean;
  dense?: boolean;
  tint?: "none" | "user";
}

function formatTime(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function MessageCard({
  title,
  timestamp,
  children,
  headerRight,
  isNew,
  dense,
  tint = "none",
}: Props) {
  return (
    <div
      className={clsx(
        "border border-hairline rounded-md overflow-hidden",
        // Assistant/tool blocks use the shared content surface: a subtle card in
        // dark mode, flat white on the page in light mode. User messages keep
        // their faint info tint in both.
        tint === "user" ? "bg-info/5" : "ll-surface",
        isNew && "message-new",
      )}
    >
      <div
        className={clsx(
          "flex items-center gap-2 px-3 border-b border-hairline",
          dense ? "py-1" : "py-1.5",
        )}
      >
        <div className="flex items-center gap-2 min-w-0 flex-1">{title}</div>
        {headerRight}
        <span className="text-2xs text-faint font-mono shrink-0">
          {formatTime(timestamp)}
        </span>
      </div>
      {children != null && <div className={dense ? "px-3 py-1.5" : "px-3 py-2"}>{children}</div>}
    </div>
  );
}

export function RowIcon({
  Icon,
  color,
  bg,
}: {
  Icon: LucideIcon;
  color: string;
  bg: string;
}) {
  return (
    <span
      className={clsx(
        "inline-flex items-center justify-center w-5 h-5 rounded shrink-0",
        bg,
        color,
      )}
    >
      <Icon size={12} className="stroke-[2.25]" />
    </span>
  );
}
