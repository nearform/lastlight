import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `router.ts` reads `window.location.hash` at module scope, so the stub has to
 * exist before the import. Node environment + a two-property stub is enough —
 * jsdom would only add weight.
 */
const location = { hash: "" };
vi.stubGlobal("window", {
  location,
  addEventListener: () => {},
  removeEventListener: () => {},
});

const { navigate, parseHashForTest } = await import("./router");

beforeEach(() => {
  location.hash = "";
});

describe("navigate", () => {
  it("still writes the two-segment URLs every existing link uses", () => {
    navigate();
    expect(location.hash).toBe("/");
    navigate("pr-review");
    expect(location.hash).toBe("/pr-review");
    navigate("pr-review", "2026-08-22_184650-00cc469");
    expect(location.hash).toBe("/pr-review/2026-08-22_184650-00cc469");
  });

  it("adds the third segment for an alternate view of the same run", () => {
    navigate("pr-review", "2026-08-22_184650-00cc469", "repeats");
    expect(location.hash).toBe("/pr-review/2026-08-22_184650-00cc469/repeats");
  });

  it("encodes each segment", () => {
    navigate("pr-review+triage", "a/b");
    expect(location.hash).toBe("/pr-review%2Btriage/a%2Fb");
  });
});

describe("parse", () => {
  it("reads two-segment URLs unchanged (no view)", () => {
    location.hash = "#/pr-review/run-1";
    expect(parseHashForTest()).toEqual({ tierKey: "pr-review", runId: "run-1", view: undefined });
  });

  it("reads the repeats view", () => {
    location.hash = "#/pr-review/run-1/repeats";
    expect(parseHashForTest()).toEqual({ tierKey: "pr-review", runId: "run-1", view: "repeats" });
  });

  it("ignores an unknown third segment rather than rendering an unknown view", () => {
    location.hash = "#/pr-review/run-1/nonsense";
    expect(parseHashForTest().view).toBeUndefined();
  });

  it("survives an empty hash", () => {
    location.hash = "";
    expect(parseHashForTest()).toEqual({ tierKey: undefined, runId: undefined, view: undefined });
  });
});
