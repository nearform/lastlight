import { test } from "node:test";
import assert from "node:assert/strict";

import { inclusiveDayCount, eachDay } from "./src/date-range.ts";

const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

test("inclusive single day counts as one", () => {
  assert.equal(inclusiveDayCount(d("2026-01-01"), d("2026-01-01")), 1);
});

test("inclusive three day span counts as three", () => {
  assert.equal(inclusiveDayCount(d("2026-01-01"), d("2026-01-03")), 3);
});

test("eachDay still lists every inclusive day", () => {
  assert.deepEqual(eachDay(d("2026-01-01"), d("2026-01-03")), ["2026-01-01", "2026-01-02", "2026-01-03"]);
});
