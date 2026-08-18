import { test } from "node:test";
import assert from "node:assert/strict";
import { retry } from "../src/retry.js";

test("retries until it succeeds", async () => {
  let n = 0;
  assert.equal(await retry(() => (++n < 3 ? Promise.reject(new Error("no")) : "ok")), "ok");
});
