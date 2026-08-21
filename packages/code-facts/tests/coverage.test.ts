/**
 * `coverage` — the replacement for the cut `mutants` extractor (§D13).
 *
 * The rule with money on it, restated from WP1's mutation section and carried
 * over intact: **never report "nothing uncovered" from a measurement that did
 * not happen.** It would read as *"well tested"*, which is the most expensive
 * false reassurance in the document.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeConstantFixture, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { parseIstanbul, parseLcov } from "../src/coverage.js";
import type { CoverageDocument } from "../src/schema.js";

describe("coverage — changed lines executed by zero tests", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => fixture.cleanup());

  it("degrades loudly when there is no coverage artifact at all", () => {
    const result = runExtractor({
      extractor: "coverage",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    const document = result.document as unknown as CoverageDocument;
    expect(result.exitCode).toBe(3);
    expect(document.coverage).toBe("degraded");
    expect(document.report).toBeNull();
    expect(document.files).toEqual([]);
    expect(document.degraded.some((d) => /NOT MEASURED/.test(d.reason))).toBe(true);
    expect(document.degraded.some((d) => /well tested/.test(d.reason))).toBe(true);
  });

  it("intersects an lcov report with the diff and names the uncovered changed lines", () => {
    mkdirSync(join(fixture.dir, "coverage"), { recursive: true });
    writeFileSync(
      join(fixture.dir, "coverage", "lcov.info"),
      [
        "SF:src/config.ts",
        "DA:1,0",
        "DA:2,4",
        "end_of_record",
        "SF:src/legacy/auth.ts",
        "DA:1,1",
        "DA:2,0",
        "end_of_record",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runExtractor({
      extractor: "coverage",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    const document = result.document as unknown as CoverageDocument;
    expect(document.reportFormat).toBe("lcov");
    expect(document.coverage).toBe("full");

    const config = document.files.find((f) => f.path === "src/config.ts");
    expect(config?.uncoveredChangedLines).toEqual([1]);
    const legacy = document.files.find((f) => f.path === "src/legacy/auth.ts");
    expect(legacy?.uncoveredChangedLines).toEqual([2]);
    expect(document.totals.uncoveredChangedLines).toBe(2);
  });
});

describe("coverage — report parsing", () => {
  it("reads istanbul statement maps and keeps the highest hit count per line", () => {
    const raw = JSON.stringify({
      "/repo/src/a.ts": {
        path: "/repo/src/a.ts",
        statementMap: { "0": { start: { line: 3 }, end: { line: 3 } }, "1": { start: { line: 4 }, end: { line: 5 } } },
        s: { "0": 0, "1": 7 },
      },
    });
    const parsed = parseIstanbul(raw, "/repo");
    expect(parsed.get("src/a.ts")?.hits.get(3)).toBe(0);
    expect(parsed.get("src/a.ts")?.hits.get(5)).toBe(7);
    // A line the report never mentions is UNINSTRUMENTED, not covered.
    expect(parsed.get("src/a.ts")?.hits.has(9)).toBe(false);
  });

  it("reads lcov and normalises absolute paths to repo-relative", () => {
    const parsed = parseLcov("SF:/repo/src/b.ts\nDA:1,0\nDA:2,3\nend_of_record\n", "/repo");
    expect([...parsed.keys()]).toEqual(["src/b.ts"]);
    expect(parsed.get("src/b.ts")?.hits.get(1)).toBe(0);
  });

  it("flags a changed file the report never mentions as UNKNOWN, not complete", () => {
    const fixture = makeConstantFixture();
    try {
      mkdirSync(join(fixture.dir, "coverage"), { recursive: true });
      writeFileSync(
        join(fixture.dir, "coverage", "lcov.info"),
        "SF:src/config.ts\nDA:1,1\nend_of_record\n",
        "utf8",
      );
      const document = runExtractor({
        extractor: "coverage",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
      }).document as unknown as CoverageDocument;
      expect(document.coverage).toBe("degraded");
      expect(
        document.degraded.some((d) => /do not appear in .* at all/.test(d.reason)),
        "a changed file missing from the report must not read as fully covered",
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});
