/**
 * Excerpting + hard byte-capping for GitHub Actions job logs.
 *
 * A raw job log routinely runs to megabytes. Handing one to the agent as a tool
 * result would blow the context window in a single call, so `github_get_job_logs`
 * never returns one: it returns the error-bearing part, capped, with a notice
 * saying so.
 *
 * The excerpting strategy mirrors lastlight's harness-side `extractErrorExcerpt`
 * (strip Actions' per-line ISO timestamps, anchor on real error lines with a
 * little context either side, fall back to the tail) so the agent sees the same
 * shape of evidence whether it came pre-fetched in the prompt or from its own
 * tool call. It is duplicated rather than imported on purpose: agentic-pi is a
 * self-contained leaf with no workspace dependencies (see CLAUDE.md).
 */

/** ISO-8601 timestamp prefix that Actions prepends to every log line. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/;

/** Lines that carry no actionable signal on their own. */
const NOISE_RE = /Process completed with exit code|##\[error\]Process completed|^##\[error\]$/i;

const ERROR_RE = /error|ERR!|FAIL|failed|Error:|npm ERR/i;

/** Lines of context kept before / after each anchor line. */
const CONTEXT_BEFORE = 2;
const CONTEXT_AFTER = 6;

/** Tail size when a log has no error lines to anchor on. */
const TAIL_LINES = 60;

/**
 * Default cap on the returned excerpt. Roughly 4k tokens — big enough for a
 * stack trace plus its build context, small enough that a couple of these
 * don't crowd out the rest of the conversation.
 */
export const DEFAULT_LOG_EXCERPT_BYTES = 16_000;

/** Floor/ceiling on a caller-supplied `max_bytes`, so the agent can't opt out. */
export const MIN_LOG_EXCERPT_BYTES = 1_000;
export const MAX_LOG_EXCERPT_BYTES = 64_000;

export interface LogExcerpt {
  /** The excerpt, prefixed with a truncation notice when it isn't the whole log. */
  text: string;
  /** True when `text` is not the entire log. */
  truncated: boolean;
  /** Byte length of the excerpt (excluding the notice). */
  bytes: number;
  /** Byte length of the log we were given. */
  originalBytes: number;
}

export function excerptJobLog(
  fullLog: string,
  maxBytes: number = DEFAULT_LOG_EXCERPT_BYTES,
): LogExcerpt {
  const cap = Math.min(Math.max(maxBytes, MIN_LOG_EXCERPT_BYTES), MAX_LOG_EXCERPT_BYTES);
  const originalBytes = Buffer.byteLength(fullLog, "utf8");
  const lines = fullLog.split("\n").map((l) => l.replace(TIMESTAMP_RE, ""));

  const real: number[] = [];
  const noise: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ERROR_RE.test(line) || /^\s*$/.test(line)) continue;
    (NOISE_RE.test(line) ? noise : real).push(i);
  }

  // Prefer real error lines; "Process completed with exit code 1" on its own is
  // better than nothing but tells you only that something failed, not what.
  const anchors = real.length > 0 ? real : noise;
  const excerpt =
    anchors.length > 0
      ? contextExcerpt(lines, anchors)
      : lines.slice(-TAIL_LINES).join("\n");

  // Cap from the END: the failure that stopped the job is the last one, and a
  // long log's early errors are usually retried-and-recovered noise.
  const capped = tailBytes(excerpt, cap);
  const bytes = Buffer.byteLength(capped, "utf8");
  // "Truncated" means we dropped log CONTENT, so compare against the
  // timestamp-stripped log rather than the raw bytes. Stripping Actions'
  // per-line ISO prefix removes ~30 bytes a line without losing anything, so a
  // byte comparison against `fullLog` would report every short log truncated
  // and put a misleading notice on an excerpt that is in fact complete.
  const truncated = capped !== lines.join("\n");

  return {
    text: truncated
      ? `[truncated — showing ${bytes} of ${originalBytes} bytes of this job's log]\n${capped}`
      : capped,
    truncated,
    bytes,
    originalBytes,
  };
}

/** De-duplicated context window around each anchor line. */
function contextExcerpt(lines: string[], anchors: number[]): string {
  const included = new Set<number>();
  for (const i of anchors) {
    const start = Math.max(0, i - CONTEXT_BEFORE);
    const end = Math.min(lines.length, i + CONTEXT_AFTER);
    for (let j = start; j < end; j++) included.add(j);
  }
  return [...included]
    .sort((a, b) => a - b)
    .map((i) => lines[i])
    .join("\n");
}

/**
 * Keep the last `maxBytes` bytes, then drop the leading partial line. That
 * second step also repairs the mojibake a byte-exact cut through a multi-byte
 * character would otherwise leave at the front.
 */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const tail = buf.subarray(buf.byteLength - maxBytes).toString("utf8");
  const nl = tail.indexOf("\n");
  return nl === -1 ? tail : tail.slice(nl + 1);
}
