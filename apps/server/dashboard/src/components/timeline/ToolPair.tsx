import { useEffect, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import clsx from "clsx";
import DOMPurify from "dompurify";
import AnsiToHtml from "ansi-to-html";
import { Maximize2, X } from "lucide-react";
import type { ToolPair as ToolPairType } from "../../timeline/types";
import { MessageCard, RowIcon } from "./MessageCard";
import { CodeBlock } from "./CodeBlock";
import {
  renderToolSummary,
  getArgsLang,
  formatToolName,
} from "../../timeline/toolRenderers";
import { summarizeResult, formatBytes } from "../../timeline/resultPreview";
import { classifyTool, FAMILY_VISUAL, iconForTool } from "../../timeline/toolFamily";

interface Props {
  pair: ToolPairType;
  isNew?: boolean;
}

// Inline the tool result stays a preview: it sits inside a scrolling feed of
// hundreds of cards, and Prism highlights synchronously. The full-screen view
// is the escape hatch, so it gets a limit high enough to be moot against the
// shim's own 64KB tool_result cap (engine/event-shim.ts).
const INLINE_TRUNCATE_CHARS = 8000;
const FULLSCREEN_TRUNCATE_CHARS = 200_000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[\d;]*m/;
const ansiConverter = new AnsiToHtml({ fg: "#c9d1d9", bg: "transparent", escapeXML: true });

function stringifyResultContent(content: unknown): { text: string; isJson: boolean } {
  if (content == null) return { text: "", isJson: false };
  if (typeof content === "string") return { text: content, isJson: false };
  if (Array.isArray(content)) {
    const allText = content.every(
      (c) => c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string",
    );
    if (allText) {
      return {
        text: content.map((c) => (c as Record<string, string>).text).join("\n"),
        isJson: false,
      };
    }
  }
  try {
    return { text: JSON.stringify(content, null, 2), isJson: true };
  } catch {
    return { text: String(content), isJson: false };
  }
}

function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return (
    text.slice(0, limit) +
    `\n\n... (${(text.length - limit).toLocaleString()} more chars)`
  );
}

function Pane({
  label,
  tone,
  children,
}: {
  label: string;
  tone?: "error";
  children: ReactNode;
}) {
  // `min-w-0` on the column is what keeps an unwrapped 400-column log line
  // scrolling inside its own <pre> instead of widening the grid track and
  // pushing the whole feed sideways.
  return (
    <div className="flex flex-col min-w-0 min-h-0">
      <div
        className={clsx(
          "text-2xs uppercase tracking-wider font-semibold mb-1 shrink-0",
          tone === "error" ? "text-error" : "text-base-content/55",
        )}
      >
        {label}
      </div>
      <div className="flex-1 min-w-0 min-h-0">{children}</div>
    </div>
  );
}

function PaneNote({ children }: { children: ReactNode }) {
  return <div className="text-2xs text-base-content/40 italic py-2">{children}</div>;
}

function ToolPanes({
  argsJson,
  argsLang,
  resultText,
  resultIsJson,
  hasResult,
  isError,
  maxHeight,
  limit,
  className,
}: {
  argsJson: string;
  argsLang: string;
  resultText: string;
  resultIsJson: boolean;
  hasResult: boolean;
  isError: boolean;
  maxHeight: string;
  limit: number;
  className?: string;
}) {
  return (
    <div className={clsx("grid gap-3 md:grid-cols-2", className)}>
      <Pane label="Input">
        <CodeBlock code={argsJson} language={argsLang} maxHeight={maxHeight} />
      </Pane>
      <Pane label={isError ? "Error" : "Output"} tone={isError ? "error" : undefined}>
        {!hasResult ? (
          <PaneNote>(still running - no result yet)</PaneNote>
        ) : resultText ? (
          <CodeBlock
            code={truncate(resultText, limit)}
            language={resultIsJson ? "json" : "text"}
            maxHeight={maxHeight}
          />
        ) : (
          <PaneNote>(empty)</PaneNote>
        )}
      </Pane>
    </div>
  );
}

export function ToolPair({ pair, isNew }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [maximized, setMaximized] = useState(false);

  const input = (pair.use.content as { input?: Record<string, unknown> })?.input ?? {};
  const resultContent = (pair.result?.content as { content?: unknown })?.content;
  const isError = (pair.result?.content as { is_error?: boolean })?.is_error === true;
  const { text: resultText, isJson } = useMemo(
    () => stringifyResultContent(resultContent),
    [resultContent],
  );
  const argsJson = useMemo(() => JSON.stringify(input, null, 2), [input]);
  const summary = summarizeResult(resultContent);
  const toolLabel = formatToolName(pair.toolName);
  const family = classifyTool(pair.toolName);
  const vis = FAMILY_VISUAL[family];
  const Icon = iconForTool(pair.toolName, family);
  const argsLang = getArgsLang(pair.toolName);
  const title = toolLabel.prefix ? `${toolLabel.prefix}.${toolLabel.label}` : toolLabel.label;

  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMaximized(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [maximized]);

  const panes = (
    <ToolPanes
      argsJson={argsJson}
      argsLang={argsLang}
      resultText={resultText}
      resultIsJson={isJson}
      hasResult={pair.result != null}
      isError={isError}
      maxHeight="22rem"
      limit={INLINE_TRUNCATE_CHARS}
      className="mt-2"
    />
  );

  const resultRow = pair.result && (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className="w-full flex items-center gap-2 text-left min-w-0 cursor-pointer hover:text-base-content"
    >
      <span
        className={clsx(
          "text-2xs uppercase tracking-wider font-semibold shrink-0",
          isError ? "text-error" : "text-base-content/55",
        )}
      >
        {isError ? "Error" : "Result"}
      </span>
      {summary.kind === "empty" ? (
        <span className="text-2xs text-base-content/40 italic">(empty)</span>
      ) : (
        <>
          <span className="text-base-content/25 shrink-0">-</span>
          {!expanded && (() => {
            const preview =
              summary.kind === "text" ? summary.preview :
              summary.kind === "json" ? summary.preview :
              summary.kind === "array" ? `[${summary.length}] ${summary.preview ? "- " + summary.preview : ""}` :
              "";
            const hasAnsi = typeof preview === "string" && ANSI_RE.test(preview);
            return hasAnsi ? (
              <span
                className="text-xs font-mono truncate flex-1"
                dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(ansiConverter.toHtml(preview), { ADD_ATTR: ["style"] }) }}
              />
            ) : (
              <span
                className={clsx(
                  "text-xs font-mono truncate flex-1",
                  summary.kind === "json" ? "text-base-content/60" : "text-base-content/75",
                )}
              >
                {preview}
              </span>
            );
          })()}
          <span className="ml-auto text-2xs text-base-content/40 font-mono shrink-0 flex items-center gap-2">
            {summary.kind === "text" && summary.lines && summary.lines > 1 && (
              <span>{summary.lines.toLocaleString()} lines</span>
            )}
            {summary.kind === "array" && (
              <span>{summary.length.toLocaleString()} items</span>
            )}
            <span>{formatBytes(summary.bytes)}</span>
            <span>{expanded ? "-" : "+"}</span>
          </span>
        </>
      )}
    </button>
  );

  const body = resultRow || expanded ? (
    <>
      {resultRow}
      {expanded && panes}
    </>
  ) : null;

  return (
    <>
      <MessageCard
        isNew={isNew}
        timestamp={pair.timestamp}
        dense
        title={
          <>
            <RowIcon Icon={Icon} color={vis.color} bg={vis.bg} />
            <span className="text-2xs font-semibold uppercase tracking-wider text-base-content/80 shrink-0 font-mono">
              {title}
            </span>
            <span className="text-base-content/25 shrink-0">-</span>
            {renderToolSummary(pair.toolName, input)}
          </>
        }
        headerRight={
          <div className="flex items-center gap-1.5 shrink-0">
            {pair.result == null && (
              <span className="badge badge-xs badge-warning animate-pulse">running</span>
            )}
            {isError && <span className="badge badge-xs badge-error">error</span>}
            <button
              onClick={() => setExpanded(!expanded)}
              className="text-2xs text-base-content/45 hover:text-base-content font-mono"
              title="Toggle input and output"
            >
              {expanded ? "- io" : "+ io"}
            </button>
            <button
              onClick={() => setMaximized(true)}
              className="text-base-content/40 hover:text-base-content"
              title="Open full screen"
            >
              <Maximize2 size={12} />
            </button>
          </div>
        }
      >
        {body}
      </MessageCard>

      {/* Portalled because the feed is a scroll container inside a flex app
          shell — a `fixed` overlay rendered in place is one `transform` on any
          ancestor away from being clipped to that container. */}
      {maximized &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            onClick={() => setMaximized(false)}
          >
            <div
              className="ll-surface border border-base-300 rounded-xl shadow-2xl w-full h-full flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2 px-4 py-2 border-b border-base-300/60 shrink-0">
                <RowIcon Icon={Icon} color={vis.color} bg={vis.bg} />
                <span className="text-2xs font-semibold uppercase tracking-wider text-base-content/80 shrink-0 font-mono">
                  {title}
                </span>
                <span className="text-base-content/25 shrink-0">-</span>
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {renderToolSummary(pair.toolName, input)}
                </div>
                {isError && <span className="badge badge-xs badge-error shrink-0">error</span>}
                <button
                  onClick={() => setMaximized(false)}
                  className="btn btn-xs btn-ghost shrink-0"
                  title="Close (Esc)"
                >
                  <X size={14} />
                </button>
              </div>
              <div className="flex-1 min-h-0 overflow-auto p-4">
                {/* A viewport calc rather than `100%`: a percentage max-height
                    against a flex/grid track that is itself content-sized
                    resolves to none in some engines, and the panes would then
                    grow past the dialog instead of scrolling inside it. */}
                <ToolPanes
                  argsJson={argsJson}
                  argsLang={argsLang}
                  resultText={resultText}
                  resultIsJson={isJson}
                  hasResult={pair.result != null}
                  isError={isError}
                  maxHeight="calc(100vh - 10rem)"
                  limit={FULLSCREEN_TRUNCATE_CHARS}
                />
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
