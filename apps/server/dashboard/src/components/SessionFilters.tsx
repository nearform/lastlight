import clsx from "clsx";
import { SlidersHorizontal } from "lucide-react";
import { getSessionType } from "../sessionTypes";

interface Props {
  availableSources: string[];
  sourceCounts: Record<string, number>;
  totalCount: number;
  sourceFilter: string | null;
  onFilterChange: (src: string | null) => void;
}

/**
 * Session-specific filter strip — was previously baked into the global header,
 * but workflow runs don't have a "session type", so it now lives inside the
 * sessions tab body and the header keeps only globally-relevant controls.
 */
export function SessionFilters({
  availableSources,
  sourceCounts,
  totalCount,
  sourceFilter,
  onFilterChange,
}: Props) {
  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b border-hairline bg-base-200/40 shrink-0">
      <div className="flex items-center gap-1 flex-1 min-w-0 overflow-x-auto flex-nowrap">
        <SlidersHorizontal size={12} className="text-faint shrink-0" />
        <button
          onClick={() => onFilterChange(null)}
          className={clsx(
            "btn btn-xs ll-control font-medium shrink-0",
            sourceFilter === null ? "btn-primary" : "btn-ghost text-muted",
          )}
        >
          all <span className="text-2xs opacity-60 ml-0.5">{totalCount}</span>
        </button>
        {availableSources.map((src) => {
          const { Icon, label, color } = getSessionType(src);
          return (
            <button
              key={src}
              onClick={() => onFilterChange(src)}
              className={clsx(
                "btn btn-xs ll-control font-medium gap-1 shrink-0",
                sourceFilter === src ? "btn-primary" : "btn-ghost text-muted",
              )}
            >
              <Icon size={12} className={sourceFilter === src ? "" : color} />
              <span className="text-2xs">{label}</span>
              <span className="text-2xs opacity-50">{sourceCounts[src] ?? 0}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
