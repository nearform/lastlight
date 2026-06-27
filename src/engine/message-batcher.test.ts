import { describe, it, expect, vi } from "vitest";
import type { EventEnvelope } from "../connectors/types.js";
import { MessageBatcher } from "./message-batcher.js";

/** A messaging-style envelope with a session id and Slack-style ts in raw. */
function env(sessionId: string, body: string, ts?: string): EventEnvelope {
  return {
    id: `evt-${body}`,
    source: "slack",
    type: "message",
    sender: "u",
    senderIsBot: false,
    body,
    raw: { sessionId, ts },
    reply: vi.fn().mockResolvedValue(undefined),
    timestamp: new Date(),
  };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * Controllable dispatch + sleep. `dispatch` records each combined envelope and
 * returns a promise the test resolves; `sleep` resolves the next time it's
 * awaited via `releaseSleep`, so the settle window is deterministic.
 */
function harness() {
  const dispatched: Array<{ envelope: EventEnvelope; resolve: () => void }> = [];
  const dispatch = (envelope: EventEnvelope) =>
    new Promise<void>((resolve) => dispatched.push({ envelope, resolve }));
  let pendingSleep: (() => void) | null = null;
  const sleep = () => new Promise<void>((resolve) => { pendingSleep = resolve; });
  const releaseSleep = async () => { pendingSleep?.(); pendingSleep = null; await tick(); };
  return { dispatched, dispatch, sleep, releaseSleep };
}

describe("MessageBatcher", () => {
  it("collapses a burst into one combined, send-ordered dispatch", async () => {
    const h = harness();
    const b = new MessageBatcher({ dispatch: h.dispatch, sleep: h.sleep, debounceMs: 50 });

    // Arrive out of order (B before A); all land within the settle window.
    b.submit(env("s1", "B", "200"));
    b.submit(env("s1", "A", "100"));
    b.submit(env("s1", "C", "300"));
    await tick();
    expect(h.dispatched).toHaveLength(0); // still settling

    await h.releaseSleep(); // settle window elapses → drain
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].envelope.body).toBe("A\nB\nC"); // one classify, send order
  });

  it("passes a lone message through unchanged (single-entry batch)", async () => {
    const h = harness();
    const b = new MessageBatcher({ dispatch: h.dispatch, sleep: h.sleep, debounceMs: 50 });
    const e = env("s1", "hello", "100");
    b.submit(e);
    await h.releaseSleep();
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0].envelope).toBe(e); // not re-wrapped
  });

  it("batches messages that arrive while a turn is in flight into the next dispatch", async () => {
    const h = harness();
    const b = new MessageBatcher({ dispatch: h.dispatch, sleep: h.sleep, debounceMs: 0 });

    b.submit(env("s1", "A", "100"));
    await tick();
    expect(h.dispatched).toHaveLength(1); // A dispatched (debounce 0)

    // B, C arrive while A's dispatch is in flight.
    b.submit(env("s1", "B", "200"));
    b.submit(env("s1", "C", "300"));
    await tick();
    expect(h.dispatched).toHaveLength(1); // still just A

    h.dispatched[0].resolve(); // A finishes
    await tick();
    expect(h.dispatched).toHaveLength(2);
    expect(h.dispatched[1].envelope.body).toBe("B\nC"); // batched follow-up
  });

  it("runs different sessions in parallel", async () => {
    const h = harness();
    const b = new MessageBatcher({ dispatch: h.dispatch, sleep: h.sleep, debounceMs: 0 });
    b.submit(env("s1", "A", "100"));
    b.submit(env("s2", "X", "100"));
    await tick();
    expect(h.dispatched).toHaveLength(2);
    expect(h.dispatched.map((d) => d.envelope.body).sort()).toEqual(["A", "X"]);
  });

  it("passes through (unbatched) an envelope with no session key", async () => {
    const h = harness();
    const b = new MessageBatcher({ dispatch: h.dispatch, sleep: h.sleep, debounceMs: 50 });
    const e = { ...env("ignored", "hi"), raw: {} } as EventEnvelope;
    b.submit(e);
    await tick();
    expect(h.dispatched).toHaveLength(1); // dispatched immediately, no settle
    expect(h.dispatched[0].envelope).toBe(e);
  });

  it("keeps draining if a dispatch throws", async () => {
    const calls: string[] = [];
    let failFirst = true;
    const dispatch = async (e: EventEnvelope) => {
      calls.push(e.body);
      if (failFirst) { failFirst = false; throw new Error("boom"); }
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const b = new MessageBatcher({ dispatch, debounceMs: 0 });

    b.submit(env("s1", "A", "100"));
    await tick(); // A dispatched (throws), drain unwinds
    b.submit(env("s1", "B", "200"));
    await tick();

    expect(calls).toEqual(["A", "B"]); // the throw didn't wedge the next turn
    expect(b.activeSessions).toBe(0);
    errSpy.mockRestore();
  });
});
