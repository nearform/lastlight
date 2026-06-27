import { describe, it, expect, vi } from "vitest";
import { ChatCoordinator } from "./chat-coordinator.js";

const noReply = async () => {};
/** Flush the microtask + setImmediate queues so drain loops make progress. */
const tick = () => new Promise<void>((r) => setImmediate(r));

/**
 * A controllable `runTurn`: each invocation records its args and returns a
 * promise the test resolves explicitly, so we decide exactly when a "turn"
 * finishes and can observe what is queued mid-flight.
 */
function makeRunTurn() {
  const calls: Array<{
    sessionId: string;
    message: string;
    sender: string;
    reply: (m: string) => Promise<void>;
    resolve: () => void;
  }> = [];
  const runTurn = (
    sessionId: string,
    message: string,
    sender: string,
    reply: (m: string) => Promise<void>,
  ) =>
    new Promise<void>((resolve) => {
      calls.push({ sessionId, message, sender, reply, resolve });
    });
  return { calls, runTurn };
}

describe("ChatCoordinator", () => {
  it("runs the first message immediately", async () => {
    const { calls, runTurn } = makeRunTurn();
    const c = new ChatCoordinator({ runTurn });

    c.submit({ sessionId: "s1", message: "hello", sender: "u", reply: noReply });
    await tick();

    expect(calls).toHaveLength(1);
    expect(calls[0].sessionId).toBe("s1");
    expect(calls[0].message).toBe("hello");
  });

  it("queues messages that arrive mid-turn and drains them as ONE combined turn", async () => {
    const { calls, runTurn } = makeRunTurn();
    const c = new ChatCoordinator({ runTurn });

    c.submit({ sessionId: "s1", message: "A", sender: "u", reply: noReply });
    await tick();
    expect(calls).toHaveLength(1); // A is in flight

    // B, C, D land while A's turn runs.
    c.submit({ sessionId: "s1", message: "B", sender: "u", reply: noReply });
    c.submit({ sessionId: "s1", message: "C", sender: "u", reply: noReply });
    c.submit({ sessionId: "s1", message: "D", sender: "u", reply: noReply });
    await tick();
    expect(calls).toHaveLength(1); // still only A; the rest are queued

    calls[0].resolve(); // A finishes
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[1].message).toBe("B\nC\nD"); // merged into one turn

    calls[1].resolve();
    await tick();
    expect(calls).toHaveLength(2); // queue fully drained
    expect(c.activeSessions).toBe(0);
  });

  it("sorts a batch back into send order by ts (webhook can reorder)", async () => {
    const { calls, runTurn } = makeRunTurn();
    const c = new ChatCoordinator({ runTurn });

    c.submit({ sessionId: "s1", message: "first", sender: "u", reply: noReply, ts: 100 });
    await tick();
    // These arrive out of order (later-ts message delivered before earlier-ts).
    c.submit({ sessionId: "s1", message: "C", sender: "u", reply: noReply, ts: 303 });
    c.submit({ sessionId: "s1", message: "A", sender: "u", reply: noReply, ts: 301 });
    c.submit({ sessionId: "s1", message: "B", sender: "u", reply: noReply, ts: 302 });

    calls[0].resolve();
    await tick();

    expect(calls[1].message).toBe("A\nB\nC"); // re-sorted by ts, not arrival order
  });

  it("keeps untimed messages in arrival order (sorted last, stably)", async () => {
    const { calls, runTurn } = makeRunTurn();
    const c = new ChatCoordinator({ runTurn });

    c.submit({ sessionId: "s1", message: "first", sender: "u", reply: noReply, ts: 1 });
    await tick();
    c.submit({ sessionId: "s1", message: "no-ts-1", sender: "u", reply: noReply });
    c.submit({ sessionId: "s1", message: "timed", sender: "u", reply: noReply, ts: 50 });
    c.submit({ sessionId: "s1", message: "no-ts-2", sender: "u", reply: noReply });

    calls[0].resolve();
    await tick();

    expect(calls[1].message).toBe("timed\nno-ts-1\nno-ts-2");
  });

  it("replies via (and attributes) the most recent message in a batch", async () => {
    const { calls, runTurn } = makeRunTurn();
    const c = new ChatCoordinator({ runTurn });
    const replyLast = async () => {};

    c.submit({ sessionId: "s1", message: "A", sender: "alice", reply: noReply });
    await tick();
    c.submit({ sessionId: "s1", message: "B", sender: "bob", reply: noReply });
    c.submit({ sessionId: "s1", message: "C", sender: "carol", reply: replyLast });

    calls[0].resolve();
    await tick();

    expect(calls[1].sender).toBe("carol");
    expect(calls[1].reply).toBe(replyLast);
  });

  it("runs different sessions in parallel", async () => {
    const { calls, runTurn } = makeRunTurn();
    const c = new ChatCoordinator({ runTurn });

    c.submit({ sessionId: "s1", message: "A", sender: "u", reply: noReply });
    c.submit({ sessionId: "s2", message: "X", sender: "u", reply: noReply });
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls.map((x) => x.sessionId).sort()).toEqual(["s1", "s2"]);
  });

  it("starts a fresh turn for a message that arrives after the queue drained", async () => {
    const { calls, runTurn } = makeRunTurn();
    const c = new ChatCoordinator({ runTurn });

    c.submit({ sessionId: "s1", message: "A", sender: "u", reply: noReply });
    await tick();
    calls[0].resolve();
    await tick();
    expect(c.activeSessions).toBe(0);

    c.submit({ sessionId: "s1", message: "B", sender: "u", reply: noReply });
    await tick();

    expect(calls).toHaveLength(2);
    expect(calls[1].message).toBe("B"); // not merged with the already-finished A
  });

  it("keeps draining the queue even if a turn throws", async () => {
    const ran: string[] = [];
    let failFirst = true;
    const runTurn = async (_sessionId: string, message: string) => {
      ran.push(message);
      if (failFirst) {
        failFirst = false;
        throw new Error("boom");
      }
    };
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const c = new ChatCoordinator({ runTurn });

    c.submit({ sessionId: "s1", message: "A", sender: "u", reply: noReply });
    c.submit({ sessionId: "s1", message: "B", sender: "u", reply: noReply });
    await tick();
    await tick();

    expect(ran).toEqual(["A", "B"]); // A threw but B still drained
    expect(c.activeSessions).toBe(0);
    errSpy.mockRestore();
  });
});
