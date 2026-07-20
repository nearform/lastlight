import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, type ServerContainer } from "../api";
import { useServerLogStream } from "../hooks/useServerLogStream";

/** Time windows for the paused (snapshot) mode — mapped to `docker logs --since`. */
const SINCE_OPTIONS: { label: string; value: string }[] = [
  { label: "Last 5m", value: "5m" },
  { label: "Last 15m", value: "15m" },
  { label: "Last 1h", value: "1h" },
  { label: "Last 6h", value: "6h" },
  { label: "Last 24h", value: "24h" },
  { label: "All", value: "" },
];

const MAX_ROW_OPTIONS = [200, 500, 1000, 2000, 5000];

/** Left-border accent so error/warn lines pop while scanning (best-effort). */
function lineAccent(line: string): string {
  if (/\b(error|fatal|fail(ed|ure)?|exception|panic)\b/i.test(line)) return "border-error/50";
  if (/\bwarn(ing)?\b/i.test(line)) return "border-warning/50";
  return "border-transparent";
}

// Ordered alternation, one pass per line. Groups: 1 url · 2 [tag] · 3 level
// word. Kept deliberately sparse — number/string tinting just added noise to
// timestamps, versions, ports, and cron expressions.
const TOKEN_RE = /(https?:\/\/\S+)|(\[[^\]\n]{0,40}\])|\b(FATAL|ERROR|WARN(?:ING)?|INFO|DEBUG|TRACE)\b/gi;

/**
 * Dependency-free syntax highlight for one `docker logs --timestamps` line —
 * dims the RFC3339 prefix, anchors `[tag]` segments, tints levels and URLs.
 * Deliberately regex-based (no Prism/highlight.js) to keep the bundle lean.
 */
function highlightLogLine(raw: string): ReactNode {
  const tsMatch = raw.match(/^(\S+Z)\s([\s\S]*)$/);
  const ts = tsMatch?.[1] ?? null;
  const body = tsMatch?.[2] ?? raw;

  const nodes: ReactNode[] = [];
  if (ts) nodes.push(<span key="ts" className="text-base-content/40">{ts} </span>);

  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(body))) {
    if (m.index > last) nodes.push(body.slice(last, m.index));
    const tok = m[0];
    let cls = "";
    if (m[1]) cls = "text-info underline decoration-dotted";
    else if (m[2]) cls = "text-primary font-medium";
    else if (m[3])
      cls = /fatal|error/i.test(tok)
        ? "text-error font-semibold"
        : /warn/i.test(tok)
          ? "text-warning font-semibold"
          : /info/i.test(tok)
            ? "text-info"
            : "text-base-content/50";
    nodes.push(
      <span key={key++} className={cls}>
        {tok}
      </span>,
    );
    last = m.index + tok.length;
  }
  if (last < body.length) nodes.push(body.slice(last));
  return nodes;
}

/**
 * Server / harness log viewer — streams (or snapshots) `docker logs` for any
 * `lastlight-*` container over the admin API. Fills the gap the CLI covered
 * (`lastlight server logs`): the cron's code-based discovery/skip decisions log
 * to stdout, not the DB, so this is the only in-dashboard window onto "what the
 * cron is actually doing". Live follow, time-windowed snapshot, max-rows cap,
 * and a client-side text filter.
 */
export function LogsPage() {
  const [containers, setContainers] = useState<ServerContainer[]>([]);
  const [container, setContainer] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const [since, setSince] = useState("15m");
  const [maxRows, setMaxRows] = useState(1000);
  const [filter, setFilter] = useState("");
  const [snapshot, setSnapshot] = useState<string[]>([]);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const { lines: streamLines, status } = useServerLogStream(container, maxRows, live);

  // Load the container list once; default to the agent (or the first).
  useEffect(() => {
    let cancelled = false;
    api
      .serverContainers()
      .then(({ containers }) => {
        if (cancelled) return;
        setContainers(containers);
        setContainer((cur) => cur ?? containers.find((c) => c.service === "agent")?.name ?? containers[0]?.name ?? null);
      })
      .catch(() => {
        /* leave the list empty — the selector just shows nothing */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Paused mode: fetch a time-windowed snapshot whenever the query changes.
  const loadSnapshot = useMemo(
    () => async () => {
      if (!container) return;
      setLoading(true);
      setSnapshotError(null);
      try {
        const { lines } = await api.serverLogs({ container, tail: maxRows, since: since || undefined });
        setSnapshot(lines);
      } catch (e) {
        setSnapshotError((e as Error).message);
      } finally {
        setLoading(false);
      }
    },
    [container, maxRows, since],
  );

  useEffect(() => {
    if (!live) void loadSnapshot();
  }, [live, loadSnapshot]);

  const lines = live ? streamLines : snapshot;

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return lines;
    return lines.filter((l) => l.toLowerCase().includes(q));
  }, [lines, filter]);

  // Auto-scroll to the newest line while live.
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (live) bottomRef.current?.scrollIntoView({ block: "end" });
  }, [visible.length, live]);

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Controls */}
      <div className="flex flex-wrap items-center gap-2 px-4 py-2 border-b border-base-300 bg-base-200/40 text-sm">
        <select
          className="select select-sm select-bordered"
          value={container ?? ""}
          onChange={(e) => setContainer(e.target.value || null)}
          aria-label="Container"
        >
          {containers.length === 0 && <option value="">no containers</option>}
          {containers.map((c) => (
            <option key={c.name} value={c.name}>
              {c.service} {c.status.toLowerCase().startsWith("up") ? "" : "· stopped"}
            </option>
          ))}
        </select>

        <label className="flex items-center gap-1 cursor-pointer">
          <input
            type="checkbox"
            className="toggle toggle-sm toggle-primary"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
          />
          <span>Live</span>
        </label>

        {!live && (
          <select
            className="select select-sm select-bordered"
            value={since}
            onChange={(e) => setSince(e.target.value)}
            aria-label="Time window"
          >
            {SINCE_OPTIONS.map((o) => (
              <option key={o.label} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        )}

        <select
          className="select select-sm select-bordered"
          value={maxRows}
          onChange={(e) => setMaxRows(Number(e.target.value))}
          aria-label="Max rows"
        >
          {MAX_ROW_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {n.toLocaleString()} rows
            </option>
          ))}
        </select>

        <input
          type="text"
          className="input input-sm input-bordered flex-1 min-w-[10rem]"
          placeholder="Filter lines…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />

        {!live && (
          <button className="btn btn-sm btn-ghost" onClick={() => void loadSnapshot()} disabled={loading}>
            {loading ? "Loading…" : "Refresh"}
          </button>
        )}

        <span className="text-xs text-base-content/50 tabular-nums">
          {visible.length.toLocaleString()}
          {filter.trim() && `/${lines.length.toLocaleString()}`} lines
          {live && (
            <span className={`ml-2 ${status === "live" ? "text-success" : "text-warning"}`}>
              ● {status}
            </span>
          )}
        </span>
      </div>

      {/* Log body — lines never wrap; the pane scrolls horizontally instead. The
          inner min-w-max wrapper grows to the widest line so the scroll works. */}
      <div className="flex-1 overflow-auto bg-base-100 font-mono text-xs leading-relaxed p-3">
        {snapshotError && <div className="text-error mb-2">Failed to load logs: {snapshotError}</div>}
        {visible.length === 0 && !loading && (
          <div className="text-base-content/40 italic">
            {filter.trim() ? "No lines match the filter." : "No log lines."}
          </div>
        )}
        <div className="min-w-max">
          {visible.map((line, i) => (
            <div key={i} className={`whitespace-pre border-l-2 pl-2 ${lineAccent(line)}`}>
              {highlightLogLine(line)}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </div>
    </div>
  );
}
