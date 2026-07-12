import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { CollectorSink, Emitter, TeeSink, type EmitterRecord } from "../src/emitter.js";

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
