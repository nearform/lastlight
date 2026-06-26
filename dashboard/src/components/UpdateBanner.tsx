import { useEffect, useState } from "react";
import { api, type ServerInfo, UnauthorizedError } from "../api";

const short = (sha: string | null) => (sha ? sha.slice(0, 8) : "unknown");

/**
 * Thin "update available" strip shown under the header when the running
 * instance is behind the latest core or overlay. Detection only — the update
 * is run with `lastlight server update` on the host (the agent never rebuilds
 * itself). Renders nothing when up to date, unknown, or the lookup fails.
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<ServerInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .serverInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((err) => {
        // Don't surface transient/version-lookup errors; the banner is a nudge.
        if (err instanceof UnauthorizedError) return;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!info) return null;
  const parts: string[] = [];
  if (info.core.behind) parts.push(`core ${short(info.core.current)} → ${short(info.core.latest)}`);
  if (info.overlay.behind) parts.push(`overlay ${short(info.overlay.current)} → ${short(info.overlay.latest)}`);
  if (parts.length === 0) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-1.5 text-xs bg-warning/15 text-warning-content border-b border-warning/30">
      <span className="font-medium">Update available</span>
      <span className="text-base-content/70">{parts.join(" · ")}</span>
      <span className="ml-auto text-base-content/60">
        run <code className="px-1 rounded bg-base-300/60">lastlight server update</code> on the host
      </span>
    </div>
  );
}
