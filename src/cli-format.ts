/**
 * Presentation helpers for the `lastlight` CLI — plain tables, relative ages,
 * status coloring, and a dependency-free SSE follower. All human formatting is
 * skipped when the caller passes `--json` (the command prints raw JSON itself).
 */
import chalk from "chalk";
import { humanTimeDiff } from "./time-diff.js";

/** Render an array of records as an aligned text table. */
export function table(
  rows: Array<Record<string, string>>,
  columns: Array<{ key: string; header: string }>,
): string {
  if (rows.length === 0) return chalk.dim("(none)");
  const widths = columns.map((col) =>
    Math.max(col.header.length, ...rows.map((r) => stripAnsi(r[col.key] ?? "").length)),
  );
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stripAnsi(s).length));
  const headerLine = columns.map((c, i) => chalk.bold(pad(c.header, widths[i]))).join("  ");
  const body = rows.map((r) =>
    columns.map((c, i) => pad(r[c.key] ?? "", widths[i])).join("  "),
  );
  return [headerLine, ...body].join("\n");
}

const ANSI = /\[[0-9;]*m/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

/** "3m ago" / "2h ago" / "5d ago" from an ISO timestamp or unix-seconds number. */
export function age(input: string | number | null | undefined): string {
  if (input === null || input === undefined || input === "") return "";

  const ms =
    typeof input === "number" ? input * 1000 : Date.parse(input as string);

  if (Number.isNaN(ms)) return String(input);

  const now = Date.now();
  const { value, unit } = humanTimeDiff(ms, now);

  const suffix = (() => {
    switch (unit) {
      case "second":
        return "s";
      case "minute":
        return "m";
      case "hour":
        return "h";
      case "day":
        return "d";
      case "week":
        return "w";
      default:
        return "s";
    }
  })();

  return `${value}${suffix} ago`;
}

/** Color a workflow-run / execution status string. */
export function colorStatus(status: string | null | undefined): string {
  const s = (status ?? "").toLowerCase();
  switch (s) {
    case "succeeded":
    case "success":
    case "approved":
      return chalk.green(status!);
    case "failed":
    case "error":
    case "rejected":
      return chalk.red(status!);
    case "running":
    case "paused":
    case "pending":
      return chalk.yellow(status!);
    case "cancelled":
      return chalk.dim(status!);
    default:
      return status ?? "";
  }
}

/** ✓ / ✗ for a boolean-ish success value. */
export function checkmark(success: boolean | undefined): string {
  if (success === undefined) return chalk.yellow("…");
  return success ? chalk.green("✓") : chalk.red("✗");
}

/**
 * Follow a server-sent-events endpoint, invoking `onEvent` for each `data:`
 * payload until the stream closes or the process is interrupted. Uses the
 * global `fetch` ReadableStream — no EventSource polyfill or extra dependency.
 * The token is passed as a `?token=` query param (the server's auth middleware
 * accepts it there for SSE, which can't set headers).
 */
export async function followSSE(
  url: string,
  token: string,
  onEvent: (data: string) => void,
): Promise<void> {
  const u = new URL(url);
  if (token) u.searchParams.set("token", token);
  const res = await fetch(u, { headers: { Accept: "text/event-stream" } });
  if (!res.ok || !res.body) {
    throw new Error(`stream failed: ${res.status} ${res.statusText}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    // SSE frames are separated by a blank line; each frame may have multiple
    // `data:` lines that concatenate into one payload.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (data) onEvent(data);
    }
  }
}
