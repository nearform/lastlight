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
}

export interface EmitterContext {
  sessionId: string;
  cwd: string;
  startedAt: string;
}

/** Writes JSONL to process.stdout. Used by the CLI. */
export class StdoutSink implements EmitterSink {
  write(record: EmitterRecord): void {
    process.stdout.write(`${JSON.stringify(record)}\n`);
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
      ...event,
      sessionId: this.ctx.sessionId,
      timestamp: new Date().toISOString(),
    });
  }
}
