import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";

import {
  ApprovalBroker,
  approvalGate,
  approvalMatcher,
  type ControlCommand,
  parseControlLine,
  pumpControl,
  readControlPrompt,
} from "../src/control.js";
import type { EmitterRecord } from "../src/emitter.js";

function fakeSession() {
  const calls: string[] = [];
  return {
    calls,
    steer: async (t: string) => void calls.push(`steer:${t}`),
    followUp: async (t: string) => void calls.push(`follow_up:${t}`),
    abort: async () => void calls.push("abort"),
  };
}

async function* from(cmds: (ControlCommand | { error: string })[]) {
  for (const c of cmds) yield c;
}

/** Drive the gate extension's tool_call handler without a Pi session. */
function gateHandler(tools: string[], broker: ApprovalBroker, events: EmitterRecord[]) {
  let handler: ((e: unknown) => Promise<unknown>) | undefined;
  const factory = approvalGate(approvalMatcher(tools), broker, (e) => events.push(e));
  assert.ok(factory);
  factory({ on: (_: string, h: (e: unknown) => Promise<unknown>) => (handler = h) } as never);
  assert.ok(handler);
  return handler;
}

describe("parseControlLine", () => {
  test("parses each command and rejects junk", () => {
    assert.deepEqual(parseControlLine('{"type":"steer","message":"stop editing src/"}'), {
      type: "steer",
      message: "stop editing src/",
    });
    assert.deepEqual(parseControlLine('{"type":"decide","id":"appr_1","allow":false,"reason":"no"}'), {
      type: "decide",
      id: "appr_1",
      allow: false,
      reason: "no",
      input: undefined,
    });
    assert.ok("error" in parseControlLine("nope"));
    assert.ok("error" in parseControlLine('{"type":"steer"}'));
    assert.ok("error" in parseControlLine('{"type":"rm -rf"}'));
  });
});

describe("pumpControl", () => {
  test("maps steer / follow_up / abort onto the session and acks each", async () => {
    const s = fakeSession();
    const events: EmitterRecord[] = [];
    await pumpControl(
      from([
        { type: "steer", message: "a" },
        { type: "follow_up", message: "b" },
        { error: "bad line" },
        { type: "abort", reason: "over budget" },
      ]),
      s,
      new ApprovalBroker(1000),
      (e) => events.push(e),
    );
    assert.deepEqual(s.calls, ["steer:a", "follow_up:b", "abort"]);
    assert.deepEqual(
      events.map((e) => `${e.type}:${e.command ?? ""}:${e.ok ?? ""}`),
      ["control_ack:steer:true", "control_ack:follow_up:true", "control_ack::false", "control_abort::", "control_ack:abort:true"],
    );
  });

  test("decide for an unknown approval is nacked", async () => {
    const events: EmitterRecord[] = [];
    await pumpControl(from([{ type: "decide", id: "appr_9", allow: true }]), fakeSession(), new ApprovalBroker(1000), (e) =>
      events.push(e),
    );
    assert.equal(events[0].ok, false);
  });
});

describe("approvalGate", () => {
  test("unmatched tools pass straight through", async () => {
    const events: EmitterRecord[] = [];
    const h = gateHandler(["bash"], new ApprovalBroker(1000), events);
    assert.equal(await h({ toolName: "read", toolCallId: "t1", input: {} }), undefined);
    assert.equal(events.length, 0);
  });

  test("deny blocks with the reviewer's reason", async () => {
    const broker = new ApprovalBroker(5000);
    const events: EmitterRecord[] = [];
    const h = gateHandler(["bash"], broker, events);
    const pending = h({ toolName: "bash", toolCallId: "t1", input: { command: "git push" } });
    assert.equal(events[0].type, "approval_requested");
    broker.decide(events[0].id as string, { allow: false, reason: "pushing is the publish step's job" });
    assert.deepEqual(await pending, { block: true, reason: "pushing is the publish step's job" });
  });

  test("allow with input patches the tool call in place", async () => {
    const broker = new ApprovalBroker(5000);
    const events: EmitterRecord[] = [];
    const h = gateHandler(["*"], broker, events);
    const input: Record<string, unknown> = { command: "npm test", timeout: 5 };
    const pending = h({ toolName: "bash", toolCallId: "t1", input });
    broker.decide(events[0].id as string, { allow: true, input: { command: "npm test -- --bail", timeout: 300 } });
    assert.equal(await pending, undefined);
    assert.deepEqual(input, { command: "npm test -- --bail", timeout: 300 });
  });

  test("fails closed on timeout", async () => {
    const events: EmitterRecord[] = [];
    const h = gateHandler(["bash"], new ApprovalBroker(20), events);
    const r = (await h({ toolName: "bash", toolCallId: "t1", input: { command: "ls" } })) as { block: boolean };
    assert.equal(r.block, true);
  });

  test("fails closed when the channel ends with a decision outstanding", async () => {
    const broker = new ApprovalBroker(60_000);
    const events: EmitterRecord[] = [];
    const h = gateHandler(["bash"], broker, events);
    const pending = h({ toolName: "bash", toolCallId: "t1", input: { command: "ls" } });
    await pumpControl(from([]), fakeSession(), broker, () => undefined);
    assert.deepEqual(await pending, { block: true, reason: "control channel closed" });
    // ...and every later request too.
    const later = (await h({ toolName: "bash", toolCallId: "t2", input: { command: "ls" } })) as { block: boolean };
    assert.equal(later.block, true);
  });
});

describe("readControlPrompt", () => {
  test("first line is the prompt, the rest are commands (split across chunks)", async () => {
    const stream = Readable.from([
      '{"type":"prompt","message":"fix the bug\\nin foo"}\n{"type":"st',
      'eer","message":"x"}\n\n{"type":"prompt","message":"again"}\n',
    ]);
    const { prompt, rest } = await readControlPrompt(stream);
    assert.equal(prompt, "fix the bug\nin foo");
    const cmds = [];
    for await (const c of rest) cmds.push(c);
    assert.deepEqual(cmds, [{ type: "steer", message: "x" }, { error: "prompt already sent" }]);
  });

  test("rejects a non-prompt first line", async () => {
    await assert.rejects(readControlPrompt(Readable.from(['{"type":"steer","message":"x"}\n'])), /first stdin line/);
  });
});
