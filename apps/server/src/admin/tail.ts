import fs from "node:fs";
import fsp from "node:fs/promises";
import { logger } from "../logging/logger.js";

const log = logger("tail");

export interface TailedLine {
  index: number;
  msg: Record<string, unknown>;
}

export type TailHandler = (lines: TailedLine[]) => void;

export interface Tailer {
  stop: () => void;
}

function parseLine(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export async function tailJsonl(
  filePath: string,
  onLines: TailHandler,
  opts: { sinceIndex?: number; intervalMs?: number } = {},
): Promise<Tailer> {
  const intervalMs = opts.intervalMs ?? 500;
  const sinceIndex = opts.sinceIndex ?? -1;

  let offset = 0;
  let lineIndex = -1;
  let stopped = false;
  let buffered = "";

  // Initial pass
  try {
    const stat = await fsp.stat(filePath);
    if (stat.size > 0) {
      const fh = await fsp.open(filePath, "r");
      try {
        const buf = Buffer.alloc(stat.size);
        await fh.read(buf, 0, stat.size, 0);
        offset = stat.size;
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        if (!text.endsWith("\n")) {
          buffered = lines.pop() ?? "";
          offset -= Buffer.byteLength(buffered, "utf8");
        }
        const out: TailedLine[] = [];
        for (const raw of lines) {
          lineIndex++;
          if (lineIndex <= sinceIndex) continue;
          const msg = parseLine(raw);
          if (msg) out.push({ index: lineIndex, msg });
        }
        if (out.length) onLines(out);
      } finally {
        await fh.close();
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  // Two things kick `tick()`: an fs.watch callback and a setInterval. They
  // can fire near-simultaneously when a chat turn writes a burst of lines,
  // and without serialisation BOTH would `stat()` the same size, see the
  // same `offset`, and emit the same delta twice — which is exactly the
  // duplicated-message bug we hit on the live chat-session stream.
  let tickInFlight = false;
  let tickQueued = false;
  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (tickInFlight) {
      // Coalesce: remember that another tick is wanted, but don't start it
      // until the current one finishes. The running tick reads everything
      // up to the current end of file, so a single follow-up is sufficient.
      tickQueued = true;
      return;
    }
    tickInFlight = true;
    try {
      const stat = await fsp.stat(filePath);
      if (stat.size < offset) {
        offset = 0;
        lineIndex = -1;
        buffered = "";
      }
      if (stat.size > offset) {
        const fh = await fsp.open(filePath, "r");
        try {
          const len = stat.size - offset;
          const buf = Buffer.alloc(len);
          await fh.read(buf, 0, len, offset);
          offset = stat.size;
          const text = buffered + buf.toString("utf8");
          const lines = text.split("\n");
          if (!text.endsWith("\n")) {
            buffered = lines.pop() ?? "";
          } else {
            buffered = "";
          }
          const out: TailedLine[] = [];
          for (const raw of lines) {
            lineIndex++;
            const msg = parseLine(raw);
            if (msg) out.push({ index: lineIndex, msg });
          }
          if (out.length) onLines(out);
        } finally {
          await fh.close();
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        log.error("Tail read failed", { filePath, err });
      }
    } finally {
      tickInFlight = false;
      if (tickQueued) {
        tickQueued = false;
        // Run the coalesced follow-up next-tick to avoid recursion blowup.
        setImmediate(() => { void tick(); });
      }
    }
  };

  let watcher: fs.FSWatcher | null = null;
  try {
    if (fs.existsSync(filePath)) {
      watcher = fs.watch(filePath, { persistent: false }, () => {
        void tick();
      });
      watcher.on("error", () => { /* ignore */ });
    }
  } catch { /* ignore */ }

  const timer = setInterval(() => { void tick(); }, intervalMs);

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
      watcher?.close();
    },
  };
}
