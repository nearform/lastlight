import type { JSX } from "react";
import clsx from "clsx";

type Input = Record<string, unknown>;

interface ToolRenderer {
  summary: (input: Input) => JSX.Element | null;
  argsLang?: string;
}

function str(v: unknown): string {
  if (v == null) return "";
  return typeof v === "string" ? v : JSON.stringify(v);
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={clsx("font-mono text-xs text-strong", className)}>{children}</span>
  );
}

function KV({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <span className="inline-flex items-baseline gap-1 min-w-0">
      <span className="text-2xs text-faint">{k}:</span>
      <span className="font-mono text-xs text-strong truncate">{v}</span>
    </span>
  );
}

function Trunc({ children, max = 80 }: { children: string; max?: number }) {
  if (children.length <= max) return <>{children}</>;
  return <>{children.slice(0, max)}…</>;
}

function shortPath(p: string): string {
  if (p.length < 50) return p;
  const parts = p.split("/");
  if (parts.length > 3) return "…/" + parts.slice(-2).join("/");
  return p;
}

const renderers: Record<string, ToolRenderer> = {
  terminal: {
    argsLang: "bash",
    summary: (i) => {
      const cmd = str(i.command);
      const timeout = i.timeout;
      return (
        <span className="flex items-center gap-2 min-w-0 flex-1">
          <Mono className="truncate flex-1"><Trunc max={140}>{cmd}</Trunc></Mono>
          {timeout != null && (
            <span className="text-2xs text-faint shrink-0">{String(timeout)}s</span>
          )}
        </span>
      );
    },
  },
  read_file: {
    summary: (i) => {
      const path = shortPath(str(i.path ?? i.file_path));
      const offset = i.offset ?? i.line_start;
      const limit = i.limit ?? i.line_end;
      return (
        <span className="flex items-center gap-3 min-w-0 flex-1">
          <Mono className="truncate">{path}</Mono>
          {offset != null && (
            <span className="text-2xs text-faint shrink-0 font-mono">
              L{String(offset)}
              {limit != null ? `-${String(limit)}` : ""}
            </span>
          )}
        </span>
      );
    },
  },
  write_file: {
    summary: (i) => {
      const path = shortPath(str(i.path ?? i.file_path));
      const content = str(i.content);
      const lines = content ? content.split("\n").length : 0;
      return (
        <span className="flex items-center gap-3 min-w-0 flex-1">
          <Mono className="truncate flex-1">{path}</Mono>
          {lines > 0 && (
            <span className="text-2xs text-faint shrink-0 font-mono">{lines} lines</span>
          )}
        </span>
      );
    },
  },
  edit_file: {
    summary: (i) => {
      const path = shortPath(str(i.path ?? i.file_path));
      const replaceAll = i.replace_all === true;
      return (
        <span className="flex items-center gap-3 min-w-0 flex-1">
          <Mono className="truncate flex-1">{path}</Mono>
          {replaceAll && <span className="badge badge-xs badge-warning shrink-0">replace_all</span>}
        </span>
      );
    },
  },
  search_files: {
    summary: (i) => (
      <span className="flex items-center gap-3 min-w-0 flex-1">
        <KV k="pattern" v={<Trunc max={60}>{str(i.pattern)}</Trunc>} />
        {i.target != null && <KV k="in" v={String(i.target)} />}
        {i.path != null && <KV k="path" v={shortPath(str(i.path))} />}
      </span>
    ),
  },
  list_files: {
    summary: (i) => <Mono className="truncate">{shortPath(str(i.path ?? "."))}</Mono>,
  },
  todo: {
    summary: (i) => {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      const byStatus: Record<string, number> = {};
      for (const t of todos) {
        const s = (t as Record<string, unknown>)?.status as string | undefined;
        if (s) byStatus[s] = (byStatus[s] ?? 0) + 1;
      }
      return (
        <span className="flex items-center gap-2 text-2xs shrink-0">
          <span className="text-muted font-mono">{todos.length} todos</span>
          {Object.entries(byStatus).map(([k, v]) => (
            <span
              key={k}
              className={clsx(
                "badge badge-xs",
                k === "completed" && "badge-success",
                k === "in_progress" && "badge-warning",
                k === "pending" && "badge-ghost",
              )}
            >
              {k.replace("_", " ")} {v}
            </span>
          ))}
        </span>
      );
    },
  },
  skill_view: {
    summary: (i) => (
      <KV k="name" v={<Mono>{str(i.name)}</Mono>} />
    ),
  },
  web_fetch: {
    summary: (i) => <Mono className="truncate">{str(i.url)}</Mono>,
  },
  web_search: {
    summary: (i) => <Mono className="truncate"><Trunc max={120}>{str(i.query)}</Trunc></Mono>,
  },
  bash: { argsLang: "bash", summary: (i) => <Mono className="truncate"><Trunc max={140}>{str(i.command)}</Trunc></Mono> },
  read: { summary: (i) => <Mono className="truncate">{shortPath(str(i.file_path))}</Mono> },
  write: { summary: (i) => <Mono className="truncate">{shortPath(str(i.file_path))}</Mono> },
  edit: { summary: (i) => <Mono className="truncate">{shortPath(str(i.file_path))}</Mono> },
  grep: {
    summary: (i) => (
      <span className="flex items-center gap-3 min-w-0 flex-1">
        <Mono className="truncate">/{str(i.pattern)}/</Mono>
        {i.path ? <KV k="in" v={shortPath(str(i.path))} /> : null}
      </span>
    ),
  },
  glob: { summary: (i) => <Mono>{str(i.pattern)}</Mono> },
  task: {
    summary: (i) => (
      <span className="flex items-center gap-2 min-w-0 flex-1">
        <span className="badge badge-xs badge-secondary shrink-0">{str(i.subagent_type) || "agent"}</span>
        <span className="text-xs text-strong truncate"><Trunc max={100}>{str(i.description) || str(i.prompt)}</Trunc></span>
      </span>
    ),
  },
  todowrite: {
    summary: (i) => {
      const todos = Array.isArray(i.todos) ? i.todos : [];
      return <span className="text-2xs text-muted font-mono">{todos.length} todos</span>;
    },
  },
  webfetch: { summary: (i) => <Mono className="truncate">{str(i.url)}</Mono> },
  websearch: { summary: (i) => <Mono className="truncate">{str(i.query)}</Mono> },
};

function mcpSummary(_toolName: string, input: Input): JSX.Element {
  const entries = Object.entries(input).slice(0, 3);
  if (entries.length === 0) {
    return <span className="text-2xs text-faint">no params</span>;
  }
  return (
    <span className="flex items-center gap-3 min-w-0 flex-1 flex-wrap">
      {entries.map(([k, v]) => (
        <KV key={k} k={k} v={<Trunc max={50}>{str(v)}</Trunc>} />
      ))}
    </span>
  );
}

export function getToolRenderer(toolName: string): ToolRenderer | null {
  return renderers[toolName.toLowerCase()] ?? null;
}

export function renderToolSummary(toolName: string, input: Input): JSX.Element {
  const r = getToolRenderer(toolName);
  if (r) {
    const out = r.summary(input);
    if (out) return out;
  }
  if (toolName.toLowerCase().startsWith("mcp_")) {
    return mcpSummary(toolName, input);
  }
  const entries = Object.entries(input).slice(0, 2);
  if (entries.length === 0) {
    return <span className="text-2xs text-faint">no args</span>;
  }
  return (
    <span className="flex items-center gap-3 min-w-0 flex-1">
      {entries.map(([k, v]) => (
        <KV key={k} k={k} v={<Trunc max={60}>{str(v)}</Trunc>} />
      ))}
    </span>
  );
}

export function getArgsLang(toolName: string): string {
  return getToolRenderer(toolName)?.argsLang ?? "json";
}

export function formatToolName(name: string): { prefix?: string; label: string } {
  const lower = name.toLowerCase();
  if (lower.startsWith("mcp_")) {
    const parts = name.slice(4).split("_");
    if (parts.length >= 2) {
      return { prefix: parts[0], label: parts.slice(1).join("_") };
    }
  }
  return { label: name };
}
