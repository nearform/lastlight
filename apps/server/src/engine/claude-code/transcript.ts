/**
 * Claude Code transcript → agentic-pi event records.
 *
 * Claude Code appends one JSON line per event to
 * `$CLAUDE_CONFIG_DIR/projects/<dir>/<session>.jsonl`. The harness tails that
 * file and feeds each line here; the records this returns are the same ones
 * agentic-pi emits, so the RunResultAccumulator, the AgenticShim (dashboard
 * session log) and telemetry need no Claude-specific code.
 *
 * Pure: no I/O. A line it does not understand — a newer Claude Code's event
 * type, a summary, non-JSON — yields nothing and never throws.
 */
import type { SandboxEvent } from "../../sandbox/sandbox.js";

type Json = Record<string, unknown>;

interface ClaudeUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const ZERO_USAGE: ClaudeUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const LIMIT_RE = /\b(usage limit|limit reached|hit your limit|limit (?:will )?resets?)\b/i;
const AUTH_RE = /authentication_error|invalid api key|oauth token (?:has )?(?:expired|revoked)|please run \/login|not logged in/i;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((c) => (isObject(c) && c.type === "text" && typeof c.text === "string" ? c.text : ""))
    .join("");
}

export class ClaudeTranscriptTranslator {
  private readonly sessionId: string;
  private readonly now: () => Date;
  private sessionSent = false;
  /** Usage already reported per Claude message id: one message streams over several lines. */
  private readonly reported = new Map<string, ClaudeUsage>();
  private readonly toolNames = new Map<string, string>();
  private limit: { resetsAt: string | null } | null = null;
  private auth = false;

  constructor(opts: { sessionId: string; now?: () => Date }) {
    this.sessionId = opts.sessionId;
    this.now = opts.now ?? (() => new Date());
  }

  /** Set once a usage-limit message was seen; `resetsAt` null when no time was printed. */
  get usageLimit(): { resetsAt: string | null } | null {
    return this.limit;
  }

  get authFailed(): boolean {
    return this.auth;
  }

  translate(line: string): SandboxEvent[] {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      return [];
    }
    if (!isObject(rec) || !isObject(rec.message)) return [];
    const msg = rec.message;
    const out: SandboxEvent[] = [];

    if (rec.type === "assistant" && msg.role === "assistant" && Array.isArray(msg.content)) {
      if (rec.isApiErrorMessage === true) return this.withSession(out, this.apiError(textOf(msg.content)), rec);
      const content = this.assistantContent(msg.content);
      if (content.length === 0) return [];
      out.push({
        type: "message_end",
        message: { role: "assistant", content, usage: this.usageDelta(msg) },
      });
      return this.withSession([], out, rec);
    }

    if (rec.type === "user" && msg.role === "user" && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (!isObject(block) || block.type !== "tool_result" || typeof block.tool_use_id !== "string") continue;
        out.push({
          type: "tool_execution_end",
          toolCallId: block.tool_use_id,
          toolName: this.toolNames.get(block.tool_use_id) ?? "unknown",
          result: typeof block.content === "string" ? block.content : textOf(block.content),
          isError: block.is_error === true,
        });
      }
      return out.length ? this.withSession([], out, rec) : [];
    }
    return [];
  }

  private withSession(prefix: SandboxEvent[], events: SandboxEvent[], rec: Json): SandboxEvent[] {
    if (events.length === 0) return prefix;
    if (this.sessionSent) return [...prefix, ...events];
    this.sessionSent = true;
    const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : this.now().toISOString();
    return [{ type: "session", id: this.sessionId, timestamp }, ...prefix, ...events];
  }

  private assistantContent(blocks: unknown[]): Json[] {
    const content: Json[] = [];
    for (const b of blocks) {
      if (!isObject(b)) continue;
      if (b.type === "text" && typeof b.text === "string") content.push({ type: "text", text: b.text });
      else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.length > 0) {
        content.push({ type: "thinking", thinking: b.thinking });
      } else if (b.type === "tool_use" && typeof b.id === "string" && typeof b.name === "string") {
        this.toolNames.set(b.id, b.name);
        content.push({ type: "toolCall", id: b.id, name: b.name, arguments: isObject(b.input) ? b.input : {} });
      }
    }
    return content;
  }

  /**
   * Claude Code writes a message's content blocks as separate lines, each
   * carrying the message's usage so far. Report only what is new since the
   * last line of the same message, so the accumulator's sums are right.
   */
  private usageDelta(msg: Json): Json {
    const u = isObject(msg.usage) ? msg.usage : {};
    const now: ClaudeUsage = {
      input: num(u.input_tokens),
      output: num(u.output_tokens),
      cacheRead: num(u.cache_read_input_tokens),
      cacheWrite: num(u.cache_creation_input_tokens),
    };
    const id = typeof msg.id === "string" ? msg.id : null;
    const before = (id && this.reported.get(id)) || ZERO_USAGE;
    if (id) this.reported.set(id, now);
    const d = (k: keyof ClaudeUsage) => Math.max(0, now[k] - before[k]);
    const delta = { input: d("input"), output: d("output"), cacheRead: d("cacheRead"), cacheWrite: d("cacheWrite") };
    return {
      ...delta,
      totalTokens: delta.input + delta.output + delta.cacheRead + delta.cacheWrite,
      // A subscription bills no per-token cost; the window, not dollars, is the limit.
      cost: { total: 0 },
    };
  }

  private apiError(text: string): SandboxEvent[] {
    if (AUTH_RE.test(text)) {
      this.auth = true;
      return [{ type: "fatal_error", error: { name: "auth_failed", message: "Claude Code sign-in failed or expired" } }];
    }
    if (LIMIT_RE.test(text)) {
      this.limit = { resetsAt: parseLimitReset(text, this.now()) };
      return [{ type: "fatal_error", error: { name: "usage_limit", message: text.slice(0, 200) } }];
    }
    // Overloaded, rate-limited, network: Claude Code retries these itself, and
    // the stall watchdog catches one that never recovers.
    return [];
  }
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Offset (ms) of `tz` from UTC at instant `at`; 0 for UTC or an unknown zone. */
function tzOffsetMs(at: number, tz: string): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    }).formatToParts(new Date(at));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - at;
  } catch {
    return 0;
  }
}

/** The UTC instant of a wall-clock time in `tz`. */
function wallToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo, d, h, mi);
  const first = guess - tzOffsetMs(guess, tz);
  return guess - tzOffsetMs(first, tz);
}

/** Wall-clock date parts of instant `at` in `tz`. */
function wallParts(at: number, tz: string): { y: number; mo: number; d: number } {
  const shifted = new Date(at + tzOffsetMs(at, tz));
  return { y: shifted.getUTCFullYear(), mo: shifted.getUTCMonth(), d: shifted.getUTCDate() };
}

/**
 * The reset time Claude Code prints in its limit message, as ISO: the epoch
 * form (`…limit reached|1793804400`), or `resets 3pm`, `resets 9:30am`,
 * `resets Nov 7, 5pm`, each optionally followed by `(Area/City)`. A bare time
 * is its next occurrence after `now`. UTC unless a zone is printed. Null when
 * no time can be read.
 */
export function parseLimitReset(text: string, now: Date): string | null {
  const epoch = /\|(\d{9,11})\b/.exec(text);
  if (epoch) return new Date(Number(epoch[1]) * 1000).toISOString();

  const m =
    /resets?\s+(?:at\s+)?(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(
      text,
    );
  if (!m) return null;
  const [, monthName, dayStr, hourStr, minStr, ampm, tzRaw] = m;
  if (!ampm && minStr === undefined) return null;
  let hour = Number(hourStr);
  const minute = minStr === undefined ? 0 : Number(minStr);
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm.toLowerCase() === "pm" ? 12 : 0);
  }
  if (hour > 23 || minute > 59) return null;
  const tz = tzRaw?.trim() || "UTC";
  const nowMs = now.getTime();
  const today = wallParts(nowMs, tz);

  if (monthName && dayStr) {
    const mo = MONTHS.indexOf(monthName.toLowerCase());
    if (mo < 0) return null;
    let at = wallToUtc(today.y, mo, Number(dayStr), hour, minute, tz);
    if (at < nowMs) at = wallToUtc(today.y + 1, mo, Number(dayStr), hour, minute, tz);
    return new Date(at).toISOString();
  }
  let at = wallToUtc(today.y, today.mo, today.d, hour, minute, tz);
  if (at <= nowMs) at = wallToUtc(today.y, today.mo, today.d + 1, hour, minute, tz);
  return new Date(at).toISOString();
}
