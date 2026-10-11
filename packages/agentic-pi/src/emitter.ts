/**
 * JSONL event emitter.
 *
 * Two sinks ship: `StdoutSink` (used by the CLI) and `CollectorSink` (used
 * by the programmatic `run()` API to capture events in-process). The
 * `Emitter` wraps a sink and injects `sessionId` + `timestamp` into every
 * record, plus the session header.
 *
 * Consumers can provide their own sink — e.g. lastlight could write
 * straight to the dashboard's shim jsonl while also calling onEvent for
 * accumulator-side state updates.
 */

export interface EmitterRecord {
  type: string;
  [key: string]: unknown;
}

export interface EmitterSink {
  write(record: EmitterRecord): void;
  /**
   * Resolve once buffered output has been flushed. The runner awaits this
   * between agent events so a slow reader throttles the agent instead of
   * letting serialized records pile up in the heap. Optional: in-memory sinks
   * have nothing to drain.
   */
  drain?(): Promise<void>;
}

export interface EmitterContext {
  sessionId: string;
  cwd: string;
  startedAt: string;
}

/** The slice of a writable stream `StdoutSink` needs (`process.stdout` by default). */
export interface DrainableStream {
  write(chunk: string, callback?: (err?: Error | null) => void): boolean;
  readonly writableNeedDrain?: boolean;
  once(event: "drain" | "close" | "error", listener: () => void): unknown;
  off(event: "drain" | "close" | "error", listener: () => void): unknown;
}

/** Writes JSONL to process.stdout. Used by the CLI. */
export class StdoutSink implements EmitterSink {
  constructor(private readonly out: DrainableStream = process.stdout) {}

  write(record: EmitterRecord): void {
    this.out.write(`${JSON.stringify(record)}\n`);
  }

  /**
   * Backpressure for the agent loop: wait only while the buffer is over its
   * high-water mark. Cheap enough to await between every event, but writes
   * below the mark may still be pending when it resolves — use {@link flush}
   * before exiting.
   */
  drain(): Promise<void> {
    if (!this.out.writableNeedDrain) return Promise.resolve();
    return this.settleOn("drain");
  }

  /**
   * Resolve once every write so far has been flushed. Writes complete in
   * order, so an empty write's callback fires only after all earlier ones —
   * the same flush Pi's json mode does before it exits.
   */
  flush(): Promise<void> {
    return this.settleOn(undefined, (done) =>
      this.out.write("", (err) => {
        // A failed write calls back BEFORE the stream emits `error`, and
        // done() drops our listener — so leave one to absorb that event
        // rather than crash at exit over a reader that went away. Not a wait:
        // an already-destroyed stream fails the write without re-emitting.
        if (err) this.out.once("error", () => {});
        done();
      }),
    );
  }

  // `close`/`error` settle every wait too: a reader that went away never
  // emits `drain` or completes a write, and waiting would hang the agent.
  private settleOn(event: "drain" | undefined, start?: (done: () => void) => void): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        if (event) this.out.off(event, done);
        this.out.off("close", done);
        this.out.off("error", done);
        resolve();
      };
      if (event) this.out.once(event, done);
      this.out.once("close", done);
      this.out.once("error", done);
      start?.(done);
    });
  }
}

/** Captures every record in an in-memory array. Used by `run()`. */
export class CollectorSink implements EmitterSink {
  readonly records: EmitterRecord[] = [];
  /** Optional pass-through (e.g. for live observation by the programmatic caller). */
  constructor(private readonly onRecord?: (r: EmitterRecord) => void) {}
  write(record: EmitterRecord): void {
    this.records.push(record);
    this.onRecord?.(record);
  }
}

/** Fan-out sink — writes the same record to every downstream sink. */
export class TeeSink implements EmitterSink {
  constructor(private readonly sinks: EmitterSink[]) {}
  write(record: EmitterRecord): void {
    for (const s of this.sinks) s.write(record);
  }
  async drain(): Promise<void> {
    await Promise.all(this.sinks.map((s) => s.drain?.()));
  }
}

/**
 * Reduce a Pi `message_update` to the delta that is actually new.
 *
 * Pi's session event carries the whole assistant message so far TWICE — as
 * `message` and as `assistantMessageEvent.partial` — and fires once per token.
 * Serializing it verbatim makes output quadratic in the response size: a long
 * streamed `write` produces gigabytes of JSON and kills the process with a V8
 * heap OOM (Pi #7290; four nearform site-review branches died this way, exit
 * 134 mid-response). Pi strips both in its own json/rpc modes (`toJsonEvent`,
 * not exported); this is the same reduction. Consumers that need the partial
 * message assemble the deltas between `message_start` and `message_end`; the
 * latter stays authoritative.
 */
export function toWireEvent(event: EmitterRecord): EmitterRecord {
  if (event.type !== "message_update") return event;
  const message = event.message as { usage?: unknown } | undefined;
  const update = event.assistantMessageEvent as
    | ({ type?: string; partial?: { content?: unknown[] }; contentIndex?: number } & Record<string, unknown>)
    | undefined;
  const { message: _message, assistantMessageEvent: _update, ...rest } = event;
  const wire: EmitterRecord = { ...rest, type: "message_update" };
  // Copied, not referenced: Pi mutates one usage object as the stream runs,
  // and CollectorSink keeps the records, so a shared reference would make
  // every collected update show the final usage instead of its own.
  if (message?.usage !== undefined) wire.usage = structuredClone(message.usage);
  if (update) {
    const { partial, ...delta } = update;
    if (update.type === "toolcall_start" && typeof update.contentIndex === "number") {
      // The start event names its tool only through the partial; keep that.
      const block = partial?.content?.[update.contentIndex] as { type?: string; id?: string; name?: string } | undefined;
      if (block?.type === "toolCall") Object.assign(delta, { id: block.id, toolName: block.name });
    }
    wire.assistantMessageEvent = delta;
  }
  return wire;
}

export class Emitter {
  constructor(
    private readonly ctx: EmitterContext,
    private readonly sink: EmitterSink,
  ) {}

  sessionHeader(): void {
    this.sink.write({
      type: "session",
      version: 3,
      id: this.ctx.sessionId,
      timestamp: this.ctx.startedAt,
      cwd: this.ctx.cwd,
    });
  }

  event(event: EmitterRecord): void {
    this.sink.write({
      ...toWireEvent(event),
      sessionId: this.ctx.sessionId,
      timestamp: new Date().toISOString(),
    });
  }

  /** Wait for the sink's buffered output to flush (no-op for in-memory sinks). */
  drain(): Promise<void> {
    return this.sink.drain?.() ?? Promise.resolve();
  }
}
