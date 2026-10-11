import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";

import {
  CollectorSink,
  Emitter,
  StdoutSink,
  TeeSink,
  toWireEvent,
  type EmitterRecord,
  type EmitterSink,
} from "../src/emitter.js";

const ctx = {
  sessionId: "test-session-id",
  cwd: "/tmp/test",
  startedAt: "2026-01-01T00:00:00.000Z",
};

describe("CollectorSink", () => {
  test("captures every record", () => {
    const sink = new CollectorSink();
    sink.write({ type: "a" });
    sink.write({ type: "b" });
    assert.equal(sink.records.length, 2);
    assert.equal(sink.records[0].type, "a");
    assert.equal(sink.records[1].type, "b");
  });

  test("optional onRecord callback fires for each write", () => {
    const seen: string[] = [];
    const sink = new CollectorSink((r) => seen.push(r.type));
    sink.write({ type: "x" });
    sink.write({ type: "y" });
    assert.deepEqual(seen, ["x", "y"]);
  });
});

describe("TeeSink", () => {
  test("fans out to every downstream sink", () => {
    const a = new CollectorSink();
    const b = new CollectorSink();
    const tee = new TeeSink([a, b]);
    tee.write({ type: "fanout" });
    assert.equal(a.records.length, 1);
    assert.equal(b.records.length, 1);
    assert.equal(a.records[0].type, "fanout");
    assert.equal(b.records[0].type, "fanout");
  });

  test("empty downstream list is harmless", () => {
    const tee = new TeeSink([]);
    assert.doesNotThrow(() => tee.write({ type: "noop" }));
  });
});

describe("Emitter", () => {
  test("sessionHeader writes the version-3 session record", () => {
    const sink = new CollectorSink();
    const emitter = new Emitter(ctx, sink);
    emitter.sessionHeader();
    assert.equal(sink.records.length, 1);
    const r = sink.records[0];
    assert.equal(r.type, "session");
    assert.equal(r.version, 3);
    assert.equal(r.id, ctx.sessionId);
    assert.equal(r.cwd, ctx.cwd);
    assert.equal(r.timestamp, ctx.startedAt);
  });

  test("event injects sessionId and a fresh timestamp", () => {
    const sink = new CollectorSink();
    const emitter = new Emitter(ctx, sink);
    emitter.event({ type: "agent_start" });
    const r = sink.records[0];
    assert.equal(r.type, "agent_start");
    assert.equal(r.sessionId, ctx.sessionId);
    assert.ok(typeof r.timestamp === "string");
    assert.notEqual(r.timestamp, ctx.startedAt); // fresh, not session-start
    assert.match(r.timestamp as string, /^\d{4}-\d{2}-\d{2}T/);
  });

  test("event preserves caller fields", () => {
    const sink = new CollectorSink();
    const emitter = new Emitter(ctx, sink);
    emitter.event({ type: "custom", foo: "bar", n: 42 });
    const r = sink.records[0] as EmitterRecord & { foo: string; n: number };
    assert.equal(r.foo, "bar");
    assert.equal(r.n, 42);
  });
});

/**
 * Pi-shaped `message_update` events for one streamed tool call: like Pi, the
 * SAME assistant message object is mutated in place and referenced from both
 * `message` and `assistantMessageEvent.partial` on every delta.
 */
function* streamToolCall(totalChars: number, chunk: number): Generator<EmitterRecord> {
  const block = { type: "toolCall", id: "call_1", name: "write", arguments: { path: "f.txt", content: "" } };
  const message = { role: "assistant", content: [block], usage: { input: 10, output: 0 } };
  yield {
    type: "message_update",
    message,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: message },
  };
  for (let sent = 0; sent < totalChars; sent += chunk) {
    const delta = "x".repeat(Math.min(chunk, totalChars - sent));
    block.arguments.content += delta;
    message.usage.output += 1;
    yield {
      type: "message_update",
      message,
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta, partial: message },
    };
  }
}

/** Counts serialized bytes the way StdoutSink would write them, keeping nothing. */
class ByteCountSink implements EmitterSink {
  bytes = 0;
  write(record: EmitterRecord): void {
    this.bytes += JSON.stringify(record).length + 1;
  }
}

function bytesFor(totalChars: number): number {
  const sink = new ByteCountSink();
  const emitter = new Emitter(ctx, sink);
  for (const e of streamToolCall(totalChars, 8)) emitter.event(e);
  return sink.bytes;
}

describe("toWireEvent", () => {
  test("strips both cumulative snapshots from a message_update, keeping the delta and usage", () => {
    const message = { role: "assistant", content: [{ type: "text", text: "hello wor" }], usage: { output: 3 } };
    const wire = toWireEvent({
      type: "message_update",
      message,
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wor", partial: message },
    });
    assert.deepEqual(wire, {
      type: "message_update",
      usage: { output: 3 },
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "wor" },
    });
  });

  test("toolcall_start keeps the tool's id and name, which only the partial carried", () => {
    const [start] = streamToolCall(0, 8);
    const wire = toWireEvent(start);
    assert.deepEqual(wire.assistantMessageEvent, {
      type: "toolcall_start",
      contentIndex: 0,
      id: "call_1",
      toolName: "write",
    });
    assert.equal("message" in wire, false);
  });

  test("collected updates keep the usage at their own point in the stream", () => {
    // Pi mutates one usage object while streaming; CollectorSink keeps records.
    const sink = new CollectorSink();
    const emitter = new Emitter(ctx, sink);
    for (const e of streamToolCall(24, 8)) emitter.event(e);
    const outputs = sink.records.map((r) => (r.usage as { output: number }).output);
    assert.deepEqual(outputs, [0, 1, 2, 3]);
  });

  test("passes every other record through untouched", () => {
    const end = { type: "message_end", message: { role: "assistant", content: [] } };
    assert.equal(toWireEvent(end), end);
  });
});

describe("Emitter output size", () => {
  // Measured: four nearform site-review branches died with a V8 heap OOM
  // (exit 134) mid-response, because each per-token record re-serialized the
  // whole message twice — quadratic in the response size (Pi #7290).
  test("a streamed tool call costs output linear in its size, not quadratic", () => {
    const small = bytesFor(20_000);
    const large = bytesFor(40_000);
    // Doubling the argument roughly doubles the output; the old shape quadrupled it.
    assert.ok(large / small < 2.2, `doubling the payload grew output ${(large / small).toFixed(2)}x`);
    // And the absolute cost stays a small multiple of the payload (old shape: ~100 MB here).
    assert.ok(large < 40_000 * 40, `40 KB streamed produced ${large} bytes`);
  });
});

/** A writable stand-in whose buffer state the test controls. */
class FakeStream extends EventEmitter {
  writableNeedDrain = false;
  written: string[] = [];
  private pending: Array<() => void> = [];
  write(chunk: string, callback?: () => void): boolean {
    this.written.push(chunk);
    if (callback) this.pending.push(callback);
    return !this.writableNeedDrain;
  }
  /** Complete every queued write, in order, as the OS would. */
  completeWrites(): void {
    for (const cb of this.pending.splice(0)) cb();
  }
}

describe("StdoutSink.drain", () => {
  test("resolves at once when nothing is buffered", async () => {
    const out = new FakeStream();
    const sink = new StdoutSink(out);
    sink.write({ type: "a" });
    await sink.drain();
    assert.deepEqual(out.written, ['{"type":"a"}\n']);
  });

  test("waits for the stream's drain event when the buffer is full", async () => {
    const out = new FakeStream();
    out.writableNeedDrain = true;
    const sink = new StdoutSink(out);
    let drained = false;
    const pending = sink.drain().then(() => {
      drained = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(drained, false);
    out.writableNeedDrain = false;
    out.emit("drain");
    await pending;
    assert.equal(drained, true);
    assert.equal(out.listenerCount("drain") + out.listenerCount("close") + out.listenerCount("error"), 0);
  });

  test("a reader that goes away settles the wait instead of hanging the agent", async () => {
    const out = new FakeStream();
    out.writableNeedDrain = true;
    const pending = new StdoutSink(out).drain();
    out.emit("close");
    await pending;
  });

  test("flush waits for writes still pending below the high-water mark", async () => {
    // writableNeedDrain stays false here, so drain() would resolve at once and
    // process.exit() would drop the run's last records.
    const out = new FakeStream();
    const sink = new StdoutSink(out);
    sink.write({ type: "usage_snapshot" });
    let flushed = false;
    const pending = sink.flush().then(() => {
      flushed = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(flushed, false);
    out.completeWrites();
    await pending;
    assert.equal(out.listenerCount("close") + out.listenerCount("error"), 0);
  });

  test("flush settles when the reader goes away", async () => {
    const out = new FakeStream();
    const pending = new StdoutSink(out).flush();
    out.emit("close");
    await pending;
  });

  test("a failed final write neither crashes the process nor hangs flush", async () => {
    // Node's Writable calls the write callback first and emits `error` after;
    // with no listener left by then, that event is an uncaught exception.
    const out = new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error("write EPIPE"), { code: "EPIPE" }));
      },
    });
    const listenersAtError: number[] = [];
    const emit = out.emit.bind(out);
    out.emit = ((event: string | symbol, ...args: unknown[]) => {
      if (event === "error") listenersAtError.push(out.listenerCount("error"));
      return emit(event, ...args);
    }) as typeof out.emit;
    await new StdoutSink(out).flush();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(listenersAtError, [1], "the stream error must reach a listener");
    // Destroyed now: the write fails without re-emitting `error`, so flush
    // must settle on the callback rather than wait for the event.
    await new StdoutSink(out).flush();
  });

  test("Emitter and TeeSink forward drain; in-memory sinks need none", async () => {
    const out = new FakeStream();
    out.writableNeedDrain = true;
    const emitter = new Emitter(ctx, new TeeSink([new CollectorSink(), new StdoutSink(out)]));
    let drained = false;
    const pending = emitter.drain().then(() => {
      drained = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(drained, false);
    out.emit("drain");
    await pending;
    await new Emitter(ctx, new CollectorSink()).drain();
  });
});
