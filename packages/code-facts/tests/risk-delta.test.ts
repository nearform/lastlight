/**
 * Issue #429's pure pieces: risk tiers (`risk.ts`) and the re-review delta's
 * identity and classification (`review-delta.ts`). The units-level behaviour
 * is in `units.test.ts`; the site and gate behaviour in `site-review.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { anchorDelta, classifyDelta, contentShaOf, isTrivialLine, lineHash, numberKeys, type DeltaInput } from "../src/review-delta.js";
import { convergenceVerdict } from "../src/review-coverage.js";
import { bumpTier, matchesGlob, pathRisk, unitRisk } from "../src/risk.js";

describe("risk tiers", () => {
  it("matches globs with isGeneratedPath's semantics: a slash-less glob is a basename anywhere", () => {
    expect(matchesGlob("packages/x/README.md", "*.md")).toBe(true);
    expect(matchesGlob("src/db/migrations/001.ts", "**/migrations/**")).toBe(true);
    expect(matchesGlob("migrations/001.ts", "**/migrations/**")).toBe(true);
    expect(matchesGlob("src/a/b.ts", "src/*.ts")).toBe(false);
  });

  it("takes the first configured rule, then test paths, then the defaults, then medium", () => {
    expect(pathRisk("docs/guide.md").tier).toBe("low");
    expect(pathRisk("src/db/migrations/001.sql").tier).toBe("high");
    expect(pathRisk("src/auth/login.test.ts")).toEqual({ tier: "low", why: "test path" });
    expect(pathRisk("src/service.ts")).toEqual({ tier: "medium", why: "default" });
    // A configured rule beats both a default and the test-path rule.
    const rules = [{ glob: "**/auth/**", tier: "critical" as const }, { glob: "*.md", tier: "medium" as const }];
    expect(pathRisk("src/auth/login.test.ts", rules).tier).toBe("critical");
    expect(pathRisk("docs/guide.md", rules).tier).toBe("medium");
  });

  it("raises a unit at most one tier, and never past critical", () => {
    expect(unitRisk("src/a.ts", { families: ["security", "state"], fanIn: 99 }).tier).toBe("high");
    expect(unitRisk("src/a.ts", { families: [], fanIn: 4 }).tier).toBe("medium");
    expect(unitRisk("src/a.ts", { families: [], fanIn: 5 }).why).toMatch(/fan-in 5/);
    expect(bumpTier("critical")).toBe("critical");
  });
});

describe("the re-review delta", () => {
  const lines = ["// header", "function f() {", "  return 1;", "}"];

  it("hashes a unit's own lines, not their numbers or trailing whitespace", () => {
    const shifted = ["// header", "// a new comment above", "function f() {", "  return 1;   ", "}"];
    expect(contentShaOf(shifted, [[3, 5]])).toBe(contentShaOf(lines, [[2, 4]]));
    expect(contentShaOf(lines, [[2, 3]])).not.toBe(contentShaOf(lines, [[2, 4]]));
  });

  it("numbers colliding keys in order, and leaves unique keys alone", () => {
    expect(numberKeys(["a::f", "a::g", "a::f", "a::f"])).toEqual(["a::f", "a::g", "a::f#2", "a::f#3"]);
  });

  const unit = (key: string, contentSha: string | null, file: string, cores: [number, number][], neighbourSites: string[] = []): DeltaInput => ({
    key,
    contentSha,
    file,
    cores,
    neighbourSites,
  });

  it("classifies new, changed, affected (either direction) and unchanged", () => {
    const prior = {
      version: 1 as const,
      head: null,
      units: [
        { key: "a.ts::fixed", contentSha: "old" },
        { key: "a.ts::caller", contentSha: "s1" },
        { key: "b.ts::callee", contentSha: "s2" },
        { key: "c.ts::far", contentSha: "s3" },
        { key: "(pr)", contentSha: null },
      ],
    };
    const deltas = classifyDelta(
      [
        unit("a.ts::fixed", "new-sha", "a.ts", [[10, 20]]),
        unit("a.ts::added", "x", "a.ts", [[40, 45]]),
        // Calls into the fixed function (its callee is declared at a.ts:12).
        unit("a.ts::caller", "s1", "a.ts", [[30, 35]], ["a.ts:12"]),
        // Called FROM the new function.
        unit("b.ts::callee", "s2", "b.ts", [[1, 5]], ["a.ts:42"]),
        unit("c.ts::far", "s3", "c.ts", [[1, 9]], ["d.ts:3"]),
        unit("(pr)", null, "", []),
      ],
      prior,
    );
    expect(deltas).toEqual(["changed", "new", "affected", "affected", "unchanged", "changed"]);
  });
});

describe("the anchor delta — is a finding's code new since the last review?", () => {
  const prior = (files: Record<string, string[]>) => ({
    version: 1 as const,
    head: null,
    units: [],
    files: Object.fromEntries(Object.entries(files).map(([p, lines]) => [p, lines.map(lineHash).join("")])),
  });

  it("is null on a first review — nothing is gated", () => {
    expect(anchorDelta(null, "a.ts", ["const total = sum(xs);"], "unchanged")).toBeNull();
  });

  it("is unchanged when every non-trivial anchored line was already in the file, wherever it sat", () => {
    const p = prior({ "a.ts": ["const total = sum(xs);", "return total * rate;"] });
    expect(anchorDelta(p, "a.ts", ["  return total * rate;", "}", "const total = sum(xs);"], "changed")).toBe("unchanged");
  });

  it("is new when any anchored line is new, or the file was never recorded", () => {
    const p = prior({ "a.ts": ["const total = sum(xs);"] });
    expect(anchorDelta(p, "a.ts", ["const total = sum(xs);", "return total * newRate;"], "unchanged")).toBe("new");
    expect(anchorDelta(p, "b.ts", ["const total = sum(xs);"], "unchanged")).toBe("new");
  });

  it("falls back to the unit's delta when the anchor holds no line worth hashing", () => {
    const p = prior({ "a.ts": ["const total = sum(xs);"] });
    expect(anchorDelta(p, "a.ts", ["}", ");"], "unchanged")).toBe("unchanged");
    expect(anchorDelta(p, "a.ts", ["}"], "affected")).toBe("new");
    expect(isTrivialLine("  });  ")).toBe(true);
    expect(isTrivialLine("x = 1")).toBe(true);
    expect(isTrivialLine("total = 1")).toBe(false);
  });
});

describe("the convergence gate", () => {
  it.each([
    [null, "medium", "worth-mentioning", "post"],
    ["new", "low", "nit", "post"],
    ["new", "medium", "worth-mentioning", "post"],
    ["unchanged", "medium", "worth-mentioning", "withhold"],
    ["unchanged", "high", "must-fix", "late"],
    ["unchanged", undefined, "must-fix", "late"],
    ["unchanged", "low", "must-fix", "withhold"],
  ] as const)("anchor %s × risk %s × %s → %s", (anchor, risk, importance, verdict) => {
    expect(convergenceVerdict(anchor, risk, importance)).toBe(verdict);
  });
});
