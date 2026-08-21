/**
 * `patterns` — the binary-backed tier, and the degradation path that silently
 * passes when it is broken.
 *
 * This is the test that matters most in this file: on a machine with no
 * opengrep and no gitleaks — which is every developer Mac, and every eval arm
 * run at `--sandbox none` — the document must say the scanners were NOT
 * MEASURED. A `findings: []` with `coverage: "full"` would make "clean" and
 * "blind" indistinguishable, and §D2 requires WP8's per-family attribution to
 * be able to tell them apart.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { makeConstantFixture, makeFakeTool, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { fingerprint, normaliseGitleaks, normaliseOpengrep } from "../src/patterns.js";
import type { PatternsDocument } from "../src/schema.js";

const OPENGREP_STUB = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.27.1"; exit 0; fi
cat <<'JSON'
{"results":[{"check_id":"lastlight-eval-on-dynamic-input","path":"src/config.ts","start":{"line":1},"end":{"line":1},"extra":{"message":"Dynamic code execution.","severity":"ERROR"}}],"errors":[]}
JSON
`;

/** A build that could not parse the target — the dependency-cruiser shape. */
const OPENGREP_PARSE_ERROR_STUB = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.0.0"; exit 0; fi
cat <<'JSON'
{"results":[],"errors":[{"type":"SourceParseError","message":"src/config.ts: could not parse"}]}
JSON
`;

const GITLEAKS_STUB = `#!/bin/sh
if [ "$1" = "version" ]; then echo "8.21.2"; exit 0; fi
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--report-path" ]; then out="$2"; fi
  shift
done
printf '%s' '[{"RuleID":"generic-api-key","File":"src/config.ts","StartLine":1,"Description":"Generic API Key detected"}]' > "$out"
exit 0
`;

describe("patterns — degraded when the binaries are absent", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => fixture.cleanup());

  it("says NOT MEASURED rather than reporting an empty finding list as clean", () => {
    const result = runExtractor({
      extractor: "patterns",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      // An empty PATH is the honest way to make the absence deterministic —
      // the machine running this may or may not have the tools installed.
      env: { PATH: "" },
    });
    const document = result.document as unknown as PatternsDocument;

    expect(result.exitCode).toBe(3);
    expect(document.coverage).toBe("degraded");
    expect(document.findings).toEqual([]);
    expect(document.degraded.filter((d) => d.extractor === "patterns").length).toBe(2);
    expect(document.degraded.some((d) => /opengrep is not on PATH/.test(d.reason))).toBe(true);
    expect(document.degraded.some((d) => /gitleaks is not on PATH/.test(d.reason))).toBe(true);
    expect(document.toolchain.binaries.opengrep.status).toBe("missing");
    expect(document.toolchain.binaries.gitleaks.status).toBe("missing");
    // The manifest pin is stamped even when nothing resolved, so a scorecard
    // records what SHOULD have been there.
    expect(document.toolchain.binaries.opengrep.expected).toBe("1.27.1");
  });
});

describe("patterns — with the binaries present", () => {
  let fixture: Fixture;
  let opengrep: { dir: string; bin: string };
  let gitleaks: { dir: string; bin: string };

  beforeAll(() => {
    fixture = makeConstantFixture();
    opengrep = makeFakeTool("opengrep", OPENGREP_STUB);
    gitleaks = makeFakeTool("gitleaks", GITLEAKS_STUB);
  });
  afterAll(() => {
    fixture.cleanup();
    rmSync(opengrep.dir, { recursive: true, force: true });
    rmSync(gitleaks.dir, { recursive: true, force: true });
  });

  it("normalises both scanners into the security-review finding shape and stamps `ok`", () => {
    const result = runExtractor({
      extractor: "patterns",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      env: {
        PATH: "",
        LASTLIGHT_OPENGREP_BIN: opengrep.bin,
        LASTLIGHT_GITLEAKS_BIN: gitleaks.bin,
      },
    });
    const document = result.document as unknown as PatternsDocument;

    expect(document.coverage).toBe("full");
    expect(result.exitCode).toBe(0);
    expect(document.findings).toHaveLength(2);

    const scanner = document.findings.find((f) => f.tool === "opengrep");
    expect(scanner?.rule).toBe("lastlight-eval-on-dynamic-input");
    expect(scanner?.severity).toBe("p1-high"); // ERROR → p1
    expect(scanner?.fingerprint).toMatch(/^[0-9a-f]{40}$/);

    const secret = document.findings.find((f) => f.tool === "gitleaks");
    expect(secret?.severity).toBe("p1-high"); // gitleaks (all) → p1-high
    expect(secret?.title).toBe("Generic API Key detected");

    expect(document.toolchain.binaries.opengrep.status).toBe("ok");
    expect(document.toolchain.binaries.opengrep.resolved).toBe("1.27.1");
    expect(document.toolchain.binaries.gitleaks.status).toBe("ok");
  });

  /**
   * §D3's whole reason for existing: measure a rung on one Opengrep and ship an
   * image with another, and the production reviewer generates a different
   * obligation set with NOTHING ERRORING. The stamp is what makes it visible.
   */
  it("records a version that does not match the manifest as `mismatch`, not as failure", () => {
    const drifted = makeFakeTool("opengrep", OPENGREP_PARSE_ERROR_STUB);
    try {
      const result = runExtractor({
        extractor: "patterns",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
        env: { PATH: "", LASTLIGHT_OPENGREP_BIN: drifted.bin, LASTLIGHT_GITLEAKS_BIN: gitleaks.bin },
      });
      const document = result.document as unknown as PatternsDocument;
      expect(document.toolchain.binaries.opengrep.status).toBe("mismatch");
      expect(document.toolchain.binaries.opengrep.resolved).toBe("1.0.0");
      expect(document.toolchain.binaries.opengrep.expected).toBe("1.27.1");
      // And a scanner that could not parse the file reports that, rather than
      // contributing an empty result the reader would take for clean.
      expect(document.coverage).toBe("degraded");
      expect(
        document.degraded.some((d) => /could not parse/.test(d.reason)),
        "an opengrep parse error must reach degraded[]",
      ).toBe(true);
    } finally {
      rmSync(drifted.dir, { recursive: true, force: true });
    }
  });
});

describe("patterns — normalisation", () => {
  const context = (): string => "ctx";

  it("treats unparseable scanner output as an ERROR, never as zero findings", () => {
    expect(normaliseOpengrep("not json", context)).toEqual({
      findings: [],
      errors: ["opengrep produced output that is not JSON"],
    });
    expect(normaliseGitleaks("{oops", context)).toEqual({
      findings: [],
      errors: ["gitleaks produced output that is not JSON"],
    });
  });

  it("treats an empty gitleaks report as a genuine zero — it writes nothing when clean", () => {
    expect(normaliseGitleaks("", context)).toEqual({ findings: [], errors: [] });
  });

  it("uses security-review's fingerprint recipe verbatim", () => {
    // sha1("opengrep:rule:file:ctx") — the shape SKILL.md §4 defines.
    expect(fingerprint("opengrep", "rule", "file", "ctx")).toBe(
      "7139b8ee78f359303c1b9eb03cf95de324af5ce7",
    );
  });

  it("maps opengrep severities the way security-review does", () => {
    const of = (severity: string): string =>
      normaliseOpengrep(
        JSON.stringify({
          results: [{ check_id: "r", path: "f", start: { line: 1 }, extra: { severity } }],
        }),
        context,
      ).findings[0].severity;
    expect(of("ERROR")).toBe("p1-high");
    expect(of("WARNING")).toBe("p2-medium");
    expect(of("INFO")).toBe("p3-low");
  });
});
