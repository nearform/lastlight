import { useEffect, useState } from "react";
import { auth } from "../api";
import type { StreamStatus } from "./useSessionStream";

/**
 * The board's change signal — modelled on {@link useSessionStream}.
 *
 * What comes back is a REVISION, never a board: the caller refetches `/board`
 * at its own scope when the revision moves. See `admin/board-stream.ts` on the
 * server for why the frame deliberately carries no repo names.
 *
 * `enabled` is how the page closes the connection while the tab is hidden. That
 * matters more than stopping a poll did: a poll costs nothing while it is not
 * firing, whereas an idle EventSource holds a connection open all night.
 */
export function useBoardStream(enabled: boolean) {
  const [revision, setRevision] = useState<string | null>(null);
  const [status, setStatus] = useState<StreamStatus>("closed");

  useEffect(() => {
    if (!enabled) {
      setStatus("closed");
      return;
    }
    setStatus("connecting");

    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (cancelled) return;
      // EventSource cannot set headers, so the token rides the query string —
      // the same accommodation `authMiddleware` already makes for the session
      // and log streams.
      const token = auth.getToken();
      const qs = new URLSearchParams();
      if (token) qs.set("token", token);
      const url = `/admin/api/board/stream?${qs}`;

      es = new EventSource(url);

      es.addEventListener("board", (ev) => {
        if (cancelled) return;
        try {
          const data = JSON.parse((ev as MessageEvent).data) as { revision?: string };
          if (typeof data.revision === "string") setRevision(data.revision);
          setStatus("live");
        } catch {
          /* A malformed frame is not worth tearing the stream down for. */
        }
      });

      es.onerror = () => {
        if (cancelled) return;
        es?.close();
        es = null;
        setStatus("reconnecting");
        reconnectTimer = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      setStatus("closed");
    };
  }, [enabled]);

  return { revision, status };
}
