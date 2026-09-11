import { useEffect, useState } from "react";

/** Below this the three-pane splits collapse to one tabbed column. */
const NARROW_QUERY = "(max-width: 1023px)";

/**
 * True when the viewport is too narrow for side-by-side panes. Subscribes to
 * `matchMedia` the same way the theme hook watches `prefers-color-scheme`, and
 * degrades to `false` where `matchMedia` is missing.
 */
export function useIsNarrow(): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && !!window.matchMedia?.(NARROW_QUERY).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia?.(NARROW_QUERY);
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setNarrow(e.matches);
    setNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return narrow;
}
