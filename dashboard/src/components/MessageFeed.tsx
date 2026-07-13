import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { OctagonX } from "lucide-react";
import { useMessageStream, type StreamStatus } from "../hooks/useMessageStream";
import { toBaseMessages } from "../adapters/lastlightToTimeline";
import { processMessages, isToolPair } from "../timeline";
import type { TimelineItem as TimelineItemT } from "../timeline";
import { TimelineItem } from "./timeline/TimelineItem";
import { ProviderIcon } from "./ProviderIcon";

export type MessageOrder = "newest" | "oldest";

interface Props {
  sessionId: string | null;
  order: MessageOrder;
  onOrderChange: (o: MessageOrder) => void;
  searchQuery: string;
  isLive?: boolean;
  onTerminate?: () => Promise<void>;
  /** API base path for the session source. Defaults to /admin/api/sessions. */
  sourcePath?: string;
}

const STATUS_DOT: Record<StreamStatus, string> = {
  live: "bg-success",
  connecting: "bg-warning animate-pulse",
  reconnecting: "bg-warning animate-pulse",
  closed: "bg-error",
};

function matchesQuery(text: string, q: string): boolean {
  if (!q) return true;
  return text.toLowerCase().includes(q.toLowerCase());
}

function isUserMessage(item: TimelineItemT): boolean {
  return !isToolPair(item) && item.message.type === "user";
}

export function MessageFeed({ sessionId, order, onOrderChange, searchQuery, isLive, onTerminate, sourcePath }: Props) {
  const { messages, status, error, newIds } = useMessageStream(sessionId, sourcePath);
  const [showConfirm, setShowConfirm] = useState(false);
  const [terminating, setTerminating] = useState(false);

  const handleTerminate = useCallback(async () => {
    if (!onTerminate) return;
    setTerminating(true);
    try {
      await onTerminate();
    } finally {
      setTerminating(false);
      setShowConfirm(false);
    }
  }, [onTerminate]);

  // The model the agent actually ran with rides along on assistant messages
  // (the same field getSessionMeta reads for the sandbox list) — pull it from
  // the already-streamed messages so we don't re-read the session JSONL.
  const model = useMemo(() => {
    for (const m of messages) {
      if (m.role === "assistant" && typeof m.model === "string") return m.model;
    }
    return null;
  }, [messages]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledAwayRef = useRef(false);
  const prevMessageCountRef = useRef(0);

  const items = useMemo(() => {
    const base = toBaseMessages(messages);
    const processed = processMessages(base);
    const filtered = searchQuery
      ? processed.filter((item) => {
          const texts: string[] = [];
          if (item.kind === "single") {
            const c = item.message.content as { text?: string } | undefined;
            if (c?.text) texts.push(c.text);
          } else {
            texts.push(item.toolName);
            texts.push(JSON.stringify((item.use.content as { input?: unknown })?.input ?? {}));
            const resultContent = (item.result?.content as { content?: unknown })?.content;
            if (resultContent) texts.push(String(resultContent).slice(0, 2000));
          }
          return texts.some((t) => matchesQuery(t, searchQuery));
        })
      : processed;
    return order === "newest" ? [...filtered].reverse() : filtered;
  }, [messages, order, searchQuery]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = messages.length > prevMessageCountRef.current;
    prevMessageCountRef.current = messages.length;
    if (!grew || userScrolledAwayRef.current) return;
    if (order === "newest") {
      el.scrollTop = 0;
    } else {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length, order]);

  useEffect(() => {
    userScrolledAwayRef.current = true;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    prevMessageCountRef.current = 0;
  }, [sessionId]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    if (order === "newest") {
      userScrolledAwayRef.current = el.scrollTop > 50;
    } else {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
      userScrolledAwayRef.current = !atBottom;
    }
  };

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-base-content/40 text-sm">
        Select a session from the left to view its messages.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-2 border-b border-base-300 bg-base-200/80 backdrop-blur flex items-center gap-3 shrink-0">
        <div className={clsx("w-1.5 h-1.5 rounded-full shrink-0", STATUS_DOT[status])} title={status} />
        <span className="text-xs font-mono text-base-content/60 truncate">{sessionId}</span>
        {model && (
          <span
            className="inline-flex items-center gap-1 text-2xs font-mono text-base-content/70 bg-base-300/60 rounded px-1.5 py-0.5 shrink-0"
            title="Model used for this session"
          >
            <ProviderIcon model={model} size={12} />
            {model}
          </span>
        )}
        <span className="text-base-content/30 text-xs">-</span>
        <span className="text-xs text-base-content/60">
          <span className="text-base-content font-semibold">{items.length}</span>
          {searchQuery && (
            <span className="text-base-content/50"> / {messages.length}</span>
          )}{" "}
          {searchQuery ? "matching" : "messages"}
        </span>
        {error && <span className="text-xs text-error">- {error}</span>}
        <div className="ml-auto flex items-center gap-1 shrink-0">
          {isLive && onTerminate && (
            <button
              onClick={() => setShowConfirm(true)}
              className="btn btn-xs h-6 min-h-0 btn-error btn-outline gap-1"
              title="Terminate this session"
            >
              <OctagonX size={12} />
              terminate
            </button>
          )}
          <button
            onClick={() => onOrderChange("newest")}
            className={clsx(
              "btn btn-xs h-6 min-h-0",
              order === "newest" ? "btn-primary" : "btn-ghost text-base-content/60",
            )}
          >
            newest
          </button>
          <button
            onClick={() => onOrderChange("oldest")}
            className={clsx(
              "btn btn-xs h-6 min-h-0",
              order === "oldest" ? "btn-primary" : "btn-ghost text-base-content/60",
            )}
          >
            oldest
          </button>
        </div>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto bg-base-100 px-4 py-3 space-y-2"
      >
        {items.map((item) => {
          const isNew =
            item.kind === "single"
              ? newIds.has(Number(item.message.id.replace(/-text$/, "")))
              : newIds.has(Number(item.use.id.split("-")[0]));
          if (isUserMessage(item)) {
            return (
              <div key={item.id} className="flex justify-end">
                <div className="w-fit max-w-[85%] sm:max-w-[70%] md:max-w-[60%] min-w-0">
                  <TimelineItem item={item} isNew={isNew} />
                </div>
              </div>
            );
          }
          return <TimelineItem key={item.id} item={item} isNew={isNew} />;
        })}
        {items.length === 0 && (
          <div className="p-6 text-center text-base-content/40 text-sm">
            {searchQuery ? "no messages match search" : "no messages yet"}
          </div>
        )}
      </div>

      {/* Terminate confirmation modal */}
      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-base-200 border border-base-300 rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl">
            <h3 className="text-base font-semibold text-base-content mb-2">Terminate session?</h3>
            <p className="text-sm text-base-content/60 mb-4">
              This will kill the Docker sandbox container and mark the execution as failed. The agent's work in progress will be lost.
            </p>
            <div className="flex justify-end gap-2">
              <button
                onClick={() => setShowConfirm(false)}
                className="btn btn-sm btn-ghost"
                disabled={terminating}
              >
                Cancel
              </button>
              <button
                onClick={handleTerminate}
                className="btn btn-sm btn-error"
                disabled={terminating}
              >
                {terminating ? "Terminating..." : "Terminate"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
