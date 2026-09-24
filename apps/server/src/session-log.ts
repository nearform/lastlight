import fs from "node:fs";
import { promises as fsp } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const CHAT_PROJECT_SLUG = "-app";

export type SessionLogScope = "sandbox" | "chat";

/** Normalized message shape returned by session-log readers. */
export interface JsonlMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: string;
  reasoning?: unknown;
  finish_reason?: string;
  [k: string]: unknown;
}

export interface SessionLogRef {
  projectSlug: string;
  sessionId: string;
}

export interface SessionLogEntry {
  id: string;
  filePath: string;
  mtimeMs: number;
  projectSlug: string;
}

export interface NormalizedLogRecord {
  timestamp: string;
  msg: JsonlMessage;
  raw: Record<string, unknown>;
}

/**
 * Filesystem cwd → project-dir slug (matches the SDK convention). The
 * absolute path with `/` replaced by `-`. `/app` → `-app`,
 * `/home/agent/workspace` → `-home-agent-workspace`.
 */
export function projectSlugForCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

export class SessionLog {
  private homeDir: string;

  constructor(homeDir: string) {
    this.homeDir = homeDir;
  }

  normalizeSessionId(sessionId: string): string | null {
    const safeId = path.basename(sessionId);
    if (safeId !== sessionId) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(safeId)) return null;
    return safeId;
  }

  pathForProject(
    projectSlug: string,
    sessionId: string,
    opts: { requireExists?: boolean } = {},
  ): string | null {
    const safeId = this.normalizeSessionId(sessionId);
    if (!safeId || !this.isSafeProjectSlug(projectSlug)) return null;
    const file = path.join(this.homeDir, "projects", projectSlug, `${safeId}.jsonl`);
    if (opts.requireExists && !fs.existsSync(file)) return null;
    return file;
  }

  findSession(scope: SessionLogScope, sessionId: string): SessionLogEntry | null {
    const safeId = this.normalizeSessionId(sessionId);
    if (!safeId) return null;
    for (const projectDir of this.projectDirs(scope)) {
      const projectSlug = path.basename(projectDir);
      const filePath = this.pathForProject(projectSlug, safeId, { requireExists: true });
      if (!filePath) continue;
      return {
        id: safeId,
        filePath,
        mtimeMs: this.mtimeMs(filePath),
        projectSlug,
      };
    }
    return null;
  }

  listSessions(scope: SessionLogScope): SessionLogEntry[] {
    const entries: SessionLogEntry[] = [];
    for (const dir of this.projectDirs(scope)) {
      const projectSlug = path.basename(dir);
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const id = f.slice(0, -6);
          if (id.startsWith("agent-")) continue;
          const filePath = path.join(dir, f);
          entries.push({ id, filePath, mtimeMs: this.mtimeMs(filePath), projectSlug });
        }
      } catch {
        // skip unreadable dirs
      }
    }
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return entries;
  }

  relatedFilesForSession(
    scope: SessionLogScope,
    sessionId: string,
    opts: { includeAgents?: boolean } = {},
  ): string[] {
    const entry = this.findSession(scope, sessionId);
    if (!entry) return [];
    const files = [entry.filePath];
    if (!opts.includeAgents) return files;

    const dir = path.dirname(entry.filePath);
    for (const agentDir of [dir, path.join(dir, entry.id, "subagents")]) {
      try {
        for (const f of fs.readdirSync(agentDir)) {
          if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
          files.push(path.join(agentDir, f));
        }
      } catch {
        // dir doesn't exist or is unreadable
      }
    }
    return files;
  }

  async appendEnvelopeLines(ref: SessionLogRef, lines: object[]): Promise<void> {
    if (lines.length === 0) return;
    const filePath = this.pathForProject(ref.projectSlug, ref.sessionId, { requireExists: false });
    if (!filePath) return;
    const data = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.appendFile(filePath, data);
  }

  async readNormalizedFile(
    filePath: string,
    opts: { skipEmptySystem?: boolean } = {},
  ): Promise<NormalizedLogRecord[]> {
    const out: NormalizedLogRecord[] = [];
    const stream = fs.createReadStream(filePath, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        for (const msg of this.normalizeLine(raw)) {
          if (opts.skipEmptySystem && msg.role === "system" && !msg.content) continue;
          const timestamp = (msg.timestamp as string | undefined) ?? (raw.timestamp as string | undefined) ?? "";
          out.push({ timestamp, msg, raw });
        }
      } catch {
        // skip malformed lines
      }
    }
    return out;
  }

  async readNormalizedSession(
    scope: SessionLogScope,
    sessionId: string,
    opts: { includeAgents?: boolean; skipEmptySystem?: boolean } = {},
  ): Promise<Array<{ index: number; msg: JsonlMessage }>> {
    const allMessages: NormalizedLogRecord[] = [];
    for (const file of this.relatedFilesForSession(scope, sessionId, { includeAgents: opts.includeAgents })) {
      allMessages.push(...await this.readNormalizedFile(file, { skipEmptySystem: opts.skipEmptySystem }));
    }
    allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return allMessages.map((m, i) => ({ index: i, msg: m.msg }));
  }

  normalizeLine(raw: Record<string, unknown>): JsonlMessage[] {
    return unwrapLine(raw);
  }

  private isSafeProjectSlug(projectSlug: string): boolean {
    return Boolean(projectSlug) && path.basename(projectSlug) === projectSlug && projectSlug !== "." && projectSlug !== "..";
  }

  private projectDirs(scope: SessionLogScope): string[] {
    const projectsDir = path.join(this.homeDir, "projects");
    try {
      return fs
        .readdirSync(projectsDir)
        .filter((name) => (scope === "chat" ? name === CHAT_PROJECT_SLUG : name !== CHAT_PROJECT_SLUG))
        .map((d) => path.join(projectsDir, d))
        .filter((p) => fs.statSync(p).isDirectory());
    } catch {
      return [];
    }
  }

  private mtimeMs(filePath: string): number {
    try {
      return fs.statSync(filePath).mtimeMs;
    } catch {
      return 0;
    }
  }
}

function unwrapLine(raw: Record<string, unknown>): JsonlMessage[] {
  // Already in role-based format (Hermes / Agent SDK --print output)
  if (typeof raw.role === "string") {
    return [raw as JsonlMessage];
  }

  const type = raw.type as string | undefined;
  if (!type) return [];

  // Skip internal types
  if (type === "queue-operation" || type === "summary" || type === "login") return [];
  if (type === "last-prompt" || type === "attachment") return [];

  const timestamp = raw.timestamp as string | undefined;

  // Parse the message field — can be a JSON string or an object
  let msg: Record<string, unknown> = {};
  if (raw.message != null) {
    if (typeof raw.message === "string") {
      try {
        msg = JSON.parse(raw.message) as Record<string, unknown>;
      } catch {
        msg = { content: raw.message };
      }
    } else if (typeof raw.message === "object") {
      msg = raw.message as Record<string, unknown>;
    }
  }

  if (type === "user") {
    const content = msg.content ?? raw.content;
    // User messages with tool_result blocks → emit each as a separate tool message
    if (Array.isArray(content)) {
      const hasToolResults = content.some(
        (b) => (b as Record<string, unknown>).type === "tool_result",
      );
      if (hasToolResults) {
        return content
          .filter((b) => (b as Record<string, unknown>).type === "tool_result")
          .map((b) => {
            const block = b as Record<string, unknown>;
            return {
              role: "tool",
              content: block.content,
              tool_call_id: block.tool_use_id as string,
              timestamp,
            };
          });
      }
    }
    return [{ role: "user", content, timestamp }];
  }

  if (type === "assistant") {
    if (raw.isApiErrorMessage || raw.error) {
      return [{ role: "system", content: String(raw.error ?? "API error"), timestamp }];
    }

    const content = msg.content;
    const model = msg.model as string | undefined;
    const stopReason = msg.stop_reason as string | undefined;
    const rawStopReason = msg.raw_stop_reason as string | undefined;
    const responseModel = msg.response_model as string | undefined;

    let textContent: string | undefined;
    let toolCalls: unknown[] | undefined;
    let reasoning: unknown;

    if (Array.isArray(content)) {
      const textBlocks: string[] = [];
      const tools: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textBlocks.push(b.text);
        } else if (b.type === "tool_use") {
          tools.push({
            id: b.id,
            function: { name: b.name, arguments: b.input },
          });
        } else if (b.type === "thinking" || b.type === "reasoning") {
          reasoning = b.thinking ?? b.text;
        }
      }
      if (textBlocks.length) textContent = textBlocks.join("\n");
      if (tools.length) toolCalls = tools;
    } else if (typeof content === "string") {
      textContent = content;
    }

    // Skip lines that only have thinking (no text, no tools) — they're noise
    if (!textContent && !toolCalls && reasoning) return [];

    // Skip completely empty assistant messages
    if (!textContent && !toolCalls) return [];

    return [{
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
      reasoning,
      finish_reason: stopReason,
      ...(rawStopReason ? { raw_stop_reason: rawStopReason } : {}),
      model,
      ...(responseModel ? { response_model: responseModel } : {}),
      timestamp,
    }];
  }

  if (type === "tool_result") {
    const content = msg.content ?? raw.content;
    const toolUseId = (msg.tool_use_id as string) ?? (raw.tool_use_id as string);
    return [{
      role: "tool",
      content,
      tool_call_id: toolUseId,
      timestamp,
    }];
  }

  if (type === "tool_use") {
    return [{
      role: "assistant",
      tool_calls: [{
        id: msg.id ?? raw.uuid,
        function: { name: msg.name, arguments: msg.input },
      }],
      timestamp,
    }];
  }

  return [];
}
