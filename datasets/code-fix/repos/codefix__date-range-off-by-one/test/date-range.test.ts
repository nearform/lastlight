import { test } from "node:test";
import assert from "node:assert/strict";

import { eachDay } from "../src/date-range.ts";

const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

// Pre-existing coverage for behaviour UNRELATED to the off-by-one bug being
// fixed — it passes before and after the fix (PASS_TO_PASS in the instance
// definition). It ships in the repo (like a real SWE-bench base test suite) so
// the build workflow's guardrails phase sees a tested, maintained project.
test("eachDay still lists every inclusive day", () => {
  assert.deepEqual(eachDay(d("2026-01-01"), d("2026-01-03")), ["2026-01-01", "2026-01-02", "2026-01-03"]);
});
