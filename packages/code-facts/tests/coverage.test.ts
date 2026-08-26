/**
 * `coverage` — the replacement for the cut `mutants` extractor (§D13).
 *
 * The rule with money on it, restated from WP1's mutation section and carried
 * over intact: **never report "nothing uncovered" from a measurement that did
 * not happen.** It would read as *"well tested"*, which is the most expensive
 * false reassurance in the document.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  makeConstantFixture,
  makeGoFixture,
  makeJavaFixture,
  makePythonFixture,
  makeRubyFixture,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import {
  formatOf,
  parseCobertura,
  parseGoCoverProfile,
  parseIstanbul,
  parseJaCoCo,
  parseLcov,
  parseSimpleCov,
  resolveReportKey,
} from "../src/coverage.js";
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

/**
 * ISTANBUL, END TO END. The default candidate list leads with it, every JS
 * runner in the workspace writes it, and only the PARSER had a test — the
 * report and the diff had never been made to meet through `runExtractor` on
 * that format, which is where the statement map's multi-line ranges and the
 * absolute-path keys actually have to line up with `git diff`'s line numbers.
 */
describe("coverage — istanbul, through the extractor", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => fixture.cleanup());

  function writeIstanbul(contents: string): void {
    mkdirSync(join(fixture.dir, "coverage"), { recursive: true });
    writeFileSync(join(fixture.dir, "coverage", "coverage-final.json"), contents, "utf8");
  }

  function run(): CoverageDocument {
    return runExtractor({
      extractor: "coverage",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as CoverageDocument;
  }

  it("intersects an istanbul report with the diff, keyed by ABSOLUTE path", () => {
    writeIstanbul(
      JSON.stringify({
        // Istanbul writes the absolute path of the machine that ran the suite.
        [join(fixture.dir, "src/config.ts")]: {
          path: join(fixture.dir, "src/config.ts"),
          statementMap: { "0": { start: { line: 1 }, end: { line: 1 } } },
          s: { "0": 0 },
        },
        [join(fixture.dir, "src/legacy/auth.ts")]: {
          path: join(fixture.dir, "src/legacy/auth.ts"),
          // One statement SPANNING two lines: the diff touches line 2, and only
          // a parser that expands start..end can answer for it.
          statementMap: { "0": { start: { line: 1 }, end: { line: 3 } } },
          s: { "0": 4 },
        },
      }),
    );
    const document = run();
    expect(document.reportFormat).toBe("istanbul");
    expect(document.report).toBe("coverage/coverage-final.json");
    expect(document.coverage).toBe("full");

    const config = document.files.find((f) => f.path === "src/config.ts");
    expect(config?.changedLines).toEqual([1]);
    expect(config?.uncoveredChangedLines).toEqual([1]);

    const legacy = document.files.find((f) => f.path === "src/legacy/auth.ts");
    expect(legacy?.changedLines).toEqual([2]);
    expect(legacy?.uncoveredChangedLines).toEqual([]);
    expect(document.totals.uncoveredChangedLines).toBe(1);
    expect(document.totals.changedLines).toBe(2);
  });

  /**
   * A truncated or half-written artifact is the "well tested" trap in its most
   * literal form: the file EXISTS, so nothing is missing, and a parser that
   * swallowed the error would emit `files: []` with `coverage: "full"`.
   */
  it("degrades with the parser's own error when the artifact will not parse", () => {
    writeIstanbul('{"src/config.ts": {"statementMap": {');
    const document = run();
    expect(document.report).toBe("coverage/coverage-final.json");
    expect(document.files).toEqual([]);
    expect(document.coverage).toBe("degraded");
    const entry = document.degraded.find((d) => /could not be parsed/.test(d.reason));
    expect(entry, "an unreadable report must never read as full coverage").toBeDefined();
    expect(entry?.reason).toContain("coverage/coverage-final.json");
    // The changed-line total is still true — it comes from the diff, not the
    // report — so the document says "2 changed lines, coverage unknown".
    expect(document.totals.changedLines).toBe(2);
    expect(document.totals.uncoveredChangedLines).toBe(0);
    rmSync(join(fixture.dir, "coverage"), { recursive: true, force: true });
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

/**
 * WS6 stage 0 — the four formats the corpus's non-JS ecosystems actually emit.
 *
 * The gap this closes is not "we support fewer formats than we could". It is
 * that on a Java, Go, Python or Ruby PR — where 59% of the gold findings live —
 * `coverage` had no artifact it could read, so it reported an empty
 * uncovered-line list, and **an empty uncovered-line list reads as "well
 * tested"**. Each of these runs END TO END through `runExtractor` against a real
 * git fixture, because a unit test on the parser alone would not catch the
 * report and the diff failing to meet.
 */
describe("coverage — the non-JS report formats", () => {
  function write(fixture: Fixture, path: string, contents: string): void {
    mkdirSync(dirname(join(fixture.dir, path)), { recursive: true });
    writeFileSync(join(fixture.dir, path), contents, "utf8");
  }

  function run(fixture: Fixture): CoverageDocument {
    return runExtractor({
      extractor: "coverage",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as CoverageDocument;
  }

  it("reads JaCoCo XML, keyed by java package rather than by repo path", () => {
    const fixture = makeJavaFixture();
    try {
      // `<package name>` is the JAVA package — `src/main/java/` is NOT in it,
      // which is the whole reason `resolveReportKey` exists.
      write(
        fixture,
        "target/site/jacoco/jacoco.xml",
        `<?xml version="1.0" encoding="UTF-8"?>
<report name="services">
  <package name="org/fixture">
    <sourcefile name="TokenService.java">
      <line nr="4" mi="2" ci="3"/>
      <line nr="6" mi="0" ci="9"/>
      <line nr="7" mi="3" ci="0"/>
    </sourcefile>
  </package>
</report>
`,
      );
      const document = run(fixture);
      expect(document.reportFormat).toBe("jacoco");
      const file = document.files.find(
        (f) => f.path === "src/main/java/org/fixture/TokenService.java",
      );
      expect(file, "the java-package key must reconcile with the repo path").toBeDefined();
      // The diff touches lines 4 and 7 of this file.
      expect(file?.changedLines).toEqual([4, 7]);
      expect(file?.uncoveredChangedLines).toEqual([7]);
      // Line 4 is `mi=2 ci=3` — a PARTIALLY covered branch, which is executed.
      // Calling it uncovered would be a false obligation.
      expect(file?.uncoveredChangedLines).not.toContain(4);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads a Go coverprofile, whose keys are IMPORT paths (longer than the repo path)", () => {
    const fixture = makeGoFixture();
    try {
      write(
        fixture,
        "coverage.out",
        [
          "mode: set",
          "github.com/fixture/svc/pkg/api/handler.go:3.30,4.13 1 1",
          "github.com/fixture/svc/pkg/api/handler.go:5.3,5.19 1 0",
          "github.com/fixture/svc/pkg/api/handler.go:7.2,7.17 1 1",
          "",
        ].join("\n"),
      );
      const document = run(fixture);
      expect(document.reportFormat).toBe("go-coverprofile");
      const file = document.files.find((f) => f.path === "pkg/api/handler.go");
      expect(file).toBeDefined();
      expect(file?.uncoveredChangedLines).toContain(5);
      expect(file?.uncoveredChangedLines).not.toContain(7);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads Cobertura XML", () => {
    const fixture = makePythonFixture();
    try {
      write(
        fixture,
        "coverage.xml",
        `<?xml version="1.0" ?>
<coverage version="7.4.0">
  <sources><source>.</source></sources>
  <packages>
    <package name="src">
      <classes>
        <class name="auth" filename="src/auth.py">
          <lines>
            <line number="1" hits="1"/>
            <line number="5" hits="0"/>
          </lines>
        </class>
      </classes>
    </package>
  </packages>
</coverage>
`,
      );
      const document = run(fixture);
      expect(document.reportFormat).toBe("cobertura");
      const file = document.files.find((f) => f.path === "src/auth.py");
      expect(file?.changedLines).toEqual([1, 5]);
      expect(file?.uncoveredChangedLines).toEqual([5]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reads a SimpleCov resultset, where index 0 is line 1 and null is UNINSTRUMENTED", () => {
    const fixture = makeRubyFixture();
    try {
      write(
        fixture,
        "coverage/.resultset.json",
        JSON.stringify({
          RSpec: {
            coverage: {
              // Absolute, the way SimpleCov writes it.
              [join(fixture.dir, "app/models/session.rb")]: {
                //     1     2      3     4     5      6     7
                lines: [1, 0, null, 1, 0, null, null],
              },
            },
            timestamp: 1,
          },
        }),
      );
      const document = run(fixture);
      expect(document.reportFormat).toBe("simplecov");
      const file = document.files.find((f) => f.path === "app/models/session.rb");
      // Index 0 IS line 1 — an off-by-one here silently shifts every obligation
      // in the document by a line.
      expect(file?.changedLines).toEqual([2, 5]);
      expect(file?.uncoveredChangedLines).toEqual([2, 5]);

      // And the `.es6` file changed in the same PR is simply absent from the
      // Ruby report, which must read as UNKNOWN rather than as covered.
      expect(
        document.degraded.some((d) => /do not appear in .* at all/.test(d.reason)),
      ).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("coverage — format detection and the parsers in isolation", () => {
  it("tells JaCoCo and Cobertura apart by root element, not by filename", () => {
    expect(formatOf("whatever.xml", '<?xml version="1.0"?><report name="x">')).toBe("jacoco");
    expect(formatOf("whatever.xml", '<?xml version="1.0"?><coverage version="7">')).toBe(
      "cobertura",
    );
    expect(formatOf("coverage/lcov.info", "SF:a")).toBe("lcov");
    expect(formatOf("coverage/.resultset.json", "{}")).toBe("simplecov");
    expect(formatOf("coverage.out", "mode: set\n")).toBe("go-coverprofile");
    // A coverprofile under a name nobody expects is still recognisable.
    expect(formatOf("profile.txt", "mode: atomic\na.go:1.1,2.2 1 1\n")).toBe("go-coverprofile");
    expect(formatOf("coverage/coverage-final.json", "{}")).toBe("istanbul");
  });

  it("takes the MAXIMUM across overlapping Go blocks, never the last one", () => {
    // Two blocks cover line 4; one ran and one did not. A loop that let the last
    // block win would report an executed line as uncovered.
    const parsed = parseGoCoverProfile(
      "mode: set\nx/y/a.go:3.1,5.2 2 1\nx/y/a.go:4.1,4.9 1 0\n",
      "/repo",
    );
    expect(parsed.get("x/y/a.go")?.hits.get(4)).toBe(1);
  });

  it("treats a JaCoCo line as covered when ci > 0, whatever mi says", () => {
    const parsed = parseJaCoCo(
      `<report><package name="a/b"><sourcefile name="C.java">` +
        `<line nr="1" mi="0" ci="5"/><line nr="2" mi="4" ci="0"/><line nr="3" mi="2" ci="1"/>` +
        `</sourcefile></package></report>`,
      "/repo",
    );
    const hits = parsed.get("a/b/C.java")?.hits;
    expect(hits?.get(1)).toBe(5);
    expect(hits?.get(2)).toBe(0);
    expect(hits?.get(3)).toBe(1);
  });

  it("skips a self-closing <class/> instead of swallowing the next one's lines", () => {
    const parsed = parseCobertura(
      `<coverage><class name="empty" filename="a.py"/>` +
        `<class name="real" filename="b.py"><lines><line number="2" hits="0"/></lines></class>` +
        `</coverage>`,
      "/repo",
    );
    expect([...parsed.keys()]).toEqual(["b.py"]);
    expect(parsed.get("b.py")?.hits.get(2)).toBe(0);
  });

  it("accepts SimpleCov's older bare-array form as well as { lines: [...] }", () => {
    const modern = parseSimpleCov(
      JSON.stringify({ RSpec: { coverage: { "lib/a.rb": { lines: [1, null, 0] } } } }),
      "/repo",
    );
    const legacy = parseSimpleCov(
      JSON.stringify({ RSpec: { coverage: { "lib/a.rb": [1, null, 0] } } }),
      "/repo",
    );
    for (const parsed of [modern, legacy]) {
      expect(parsed.get("lib/a.rb")?.hits.get(1)).toBe(1);
      expect(parsed.get("lib/a.rb")?.hits.has(2)).toBe(false);
      expect(parsed.get("lib/a.rb")?.hits.get(3)).toBe(0);
    }
  });

  it("merges several SimpleCov suites with max — one green suite means executed", () => {
    const parsed = parseSimpleCov(
      JSON.stringify({
        RSpec: { coverage: { "lib/a.rb": [0, 0] } },
        Cucumber: { coverage: { "lib/a.rb": [3, 0] } },
      }),
      "/repo",
    );
    expect(parsed.get("lib/a.rb")?.hits.get(1)).toBe(3);
  });

  it("refuses an AMBIGUOUS suffix match rather than attributing coverage to the wrong file", () => {
    const byFile = new Map([
      ["a/util.go", { hits: new Map([[1, 1]]) }],
      ["b/util.go", { hits: new Map([[1, 0]]) }],
    ]);
    // Two candidates: a wrong uncovered line is a false obligation, so this must
    // read as "not in the report" — which `degraded[]` already names.
    expect(resolveReportKey(byFile, "util.go")).toBeNull();
    expect(resolveReportKey(byFile, "a/util.go")).toBe("a/util.go");
    expect(resolveReportKey(new Map([["x/y/a.go", { hits: new Map() }]]), "y/a.go")).toBe("x/y/a.go");
  });
});
