import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { surfaceTerminalError, tailAssistantError } from "../src/terminal-error.js";

const user = (text: string) => ({ role: "user", content: [{ type: "text", text }] });
const ok = (text: string) => ({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
const errored = (msg: string) => ({ role: "assistant", stopReason: "error", errorMessage: msg, content: [] });
const toolResult = () => ({ role: "toolResult", content: [{ type: "text", text: "out" }] });

describe("tailAssistantError", () => {
  test("returns the tail assistant message when it errored", () => {
    const m = errored("You exceeded your current quota");
    assert.equal(tailAssistantError([user("hi"), m]), m);
  });

  test("skips trailing tool/user messages to reach the last assistant turn", () => {
    const m = errored("429");
    assert.equal(tailAssistantError([user("hi"), m, toolResult()]), m);
  });

  test("returns undefined when the last assistant turn succeeded", () => {
    assert.equal(tailAssistantError([errored("early blip"), ok("recovered answer")]), undefined);
  });

  test("returns undefined for no assistant messages / empty list", () => {
    assert.equal(tailAssistantError([user("hi")]), undefined);
    assert.equal(tailAssistantError([]), undefined);
  });
});

describe("surfaceTerminalError", () => {
  test("appends a captured error when the run ended without a clean answer", () => {
    const session = [user("bump lodash"), ok("")];
    const captured = errored("You exceeded your current quota");
    const out = surfaceTerminalError(session, captured);
    assert.equal(out.length, 3);
    assert.equal(out[out.length - 1], captured);
    // The tail scan now finds the error — the whole point.
    assert.equal(tailAssistantError(out), captured);
  });

  test("no-op when there's no captured error", () => {
    const session = [user("hi"), ok("done")];
    assert.deepEqual(surfaceTerminalError(session, undefined), session);
  });

  test("does not duplicate a genuine terminal error already at the tail", () => {
    const err = errored("429");
    const session = [user("hi"), err];
    const out = surfaceTerminalError(session, err);
    assert.equal(out.length, 2);
    assert.equal(out[out.length - 1], err);
  });

  test("returns a copy — never mutates the input", () => {
    const session = [user("hi"), ok("")];
    surfaceTerminalError(session, errored("boom"));
    assert.equal(session.length, 2);
  });
});
