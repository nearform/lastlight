import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMoney } from "../src/format.js";

test("formats dollars", () => {
  assert.equal(formatMoney(12345), "$123.45");
});
