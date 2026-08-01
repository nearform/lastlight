import { test } from "node:test";
import assert from "node:assert/strict";
import { pollUntil } from "../src/poll.js";

test("resolves once the condition holds", async () => {
  let n = 0;
  assert.equal(await pollUntil(() => ++n > 2), true);
});
