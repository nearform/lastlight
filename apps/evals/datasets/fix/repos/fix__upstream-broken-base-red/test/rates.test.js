import { test } from "node:test";
import assert from "node:assert/strict";
import { convert } from "../src/rates.js";

test("converts to whole minor units", () => {
  assert.equal(convert(1000, 1.2345), 1235);
});
