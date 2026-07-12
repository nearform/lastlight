import { useEffect, useState } from "react";
import { api, type ServerInfo, UnauthorizedError } from "../api";

/**
 * Tiny version label for the header — shows the pinned core version (e.g.
 * `v0.12.0`) when the instance is on its pin and up to date. The full-width
 * "Update available" / "Redeploy needed" strip lives in {@link UpdateBanner};
 * this is just the quiet at-rest label, tucked beside the theme toggle so it
 * doesn't eat a whole row. Renders nothing when unpinned, drifted, or unknown.
 */
export function VersionPin() {
  const [info, setInfo] = useState<ServerInfo | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .serverInfo()
      .then((i) => {
        if (!cancelled) setInfo(i);
      })
      .catch((err) => {
        if (err instanceof UnauthorizedError) return;
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Only the quiet at-rest case: pinned and not behind. Anything else (unpinned,
  // drifted) is handled by UpdateBanner's strip.
  if (!info?.pinned || info.core.behind || info.overlay.behind) return null;

  return (
    <code
      className="font-mono text-2xs text-base-content/40 shrink-0"
      title={`Pinned to ${info.pinned}`}
    >
      {info.pinned}
    </code>
  );
}
