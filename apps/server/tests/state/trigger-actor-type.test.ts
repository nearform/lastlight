import { describe, it, expect } from "vitest";
import { isTriggerActorType, TRIGGER_ACTOR_TYPES } from "#src/state/db.js";

/**
 * A pure predicate over untrusted context — no database, so it is neither a
 * factory candidate nor dialect-dependent. It shared a file with the `UserStore`
 * tests until Phase 3 moved those into the parameterized suite.
 */
describe("isTriggerActorType", () => {
  it("accepts every member of the union", () => {
    for (const t of TRIGGER_ACTOR_TYPES) expect(isTriggerActorType(t)).toBe(true);
  });

  it("rejects an unrecognised string, so untrusted context falls through", () => {
    expect(isTriggerActorType("hacker")).toBe(false);
    expect(isTriggerActorType("GITHUB")).toBe(false); // case-sensitive
  });

  it("rejects non-string values", () => {
    expect(isTriggerActorType(undefined)).toBe(false);
    expect(isTriggerActorType(null)).toBe(false);
    expect(isTriggerActorType(42)).toBe(false);
    expect(isTriggerActorType({})).toBe(false);
  });
});
