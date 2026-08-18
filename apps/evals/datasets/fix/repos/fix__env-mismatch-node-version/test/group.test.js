import { test } from "node:test";
import assert from "node:assert/strict";
import { groupBy } from "../src/group.js";

test("groups by first letter", () => {
  const out = groupBy(["apple", "avocado", "beet"], (s) => s[0]);
  assert.deepEqual(out.a, ["apple", "avocado"]);
  assert.deepEqual(out.b, ["beet"]);
});
