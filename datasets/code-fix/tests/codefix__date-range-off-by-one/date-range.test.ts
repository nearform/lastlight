import { test } from "node:test";
import assert from "node:assert/strict";

import { inclusiveDayCount } from "./src/date-range.ts";

const d = (s: string): Date => new Date(`${s}T00:00:00Z`);

// HELD-OUT, bug-revealing tests (FAIL_TO_PASS) — kept out of the seeded repo so
// the agent can't see or edit what it's graded on. Copied in by the grader
// AFTER the agent runs: red before the fix, green after. The PASS_TO_PASS
// "eachDay …" test ships in the repo itself (see repos/<id>/test/).
test("inclusive single day counts as one", () => {
  assert.equal(inclusiveDayCount(d("2026-01-01"), d("2026-01-01")), 1);
});

test("inclusive three day span counts as three", () => {
  assert.equal(inclusiveDayCount(d("2026-01-01"), d("2026-01-03")), 3);
});
