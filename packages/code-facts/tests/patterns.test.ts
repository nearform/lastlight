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
import { join } from "node:path";
import { makeConstantFixture, makeFakeTool, makeFixture, type Fixture } from "./helpers.js";
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

/**
 * The scanner-side failure modes, each with a real script on disk.
 *
 * `exit 1` is opengrep SAYING IT FOUND SOMETHING and `exit 2` is opengrep
 * failing — treating the two the same in either direction is how a scan that
 * could not load its rules comes back as `findings: []`, which is the
 * dependency-cruiser shape with a different binary in it.
 */
const OPENGREP_FINDINGS_EXIT_1 = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.27.1"; exit 0; fi
cat <<'JSON'
{"results":[{"check_id":"lastlight-hardcoded-secret","path":"src/config.ts","start":{"line":1},"extra":{"message":"Hard-coded secret.","severity":"WARNING"}}],"errors":[]}
JSON
exit 1
`;

const OPENGREP_EXIT_2 = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.27.1"; exit 0; fi
echo "opengrep: fatal error: could not load the ruleset" >&2
exit 2
`;

/**
 * gitleaks renamed `detect` to `git` in 8.19. The stub in this file answers
 * BOTH, which is faithful to 8.21.2 — and means the fallback branch has never
 * executed. This one refuses `detect` the way a future release would.
 */
const GITLEAKS_NO_DETECT = `#!/bin/sh
if [ "$1" = "version" ]; then echo "8.21.2"; exit 0; fi
if [ "$1" = "detect" ]; then echo 'unknown command "detect" for "gitleaks"' >&2; exit 1; fi
out=""
while [ $# -gt 0 ]; do
  if [ "$1" = "--report-path" ]; then out="$2"; fi
  shift
done
printf '%s' '[{"RuleID":"aws-access-token","File":"src/config.ts","StartLine":1,"Description":"AWS Access Token detected"}]' > "$out"
exit 0
`;

describe("patterns — the scanner failure modes", () => {
  let fixture: Fixture;
  const tools: { dir: string; bin: string }[] = [];

  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => {
    fixture.cleanup();
    for (const tool of tools) rmSync(tool.dir, { recursive: true, force: true });
  });

  function fake(name: string, script: string): string {
    const tool = makeFakeTool(name, script);
    tools.push(tool);
    return tool.bin;
  }

  function scan(
    env: Record<string, string>,
    repo: Fixture = fixture,
    rulesPath?: string,
  ): PatternsDocument {
    return runExtractor({
      extractor: "patterns",
      repo: repo.dir,
      base: repo.base,
      head: repo.head,
      rulesPath,
      env: { PATH: "", ...env },
    }).document as unknown as PatternsDocument;
  }

  it("treats `exit 1` as FINDINGS, not as failure", () => {
    const document = scan({ LASTLIGHT_OPENGREP_BIN: fake("opengrep", OPENGREP_FINDINGS_EXIT_1) });
    const finding = document.findings.find((f) => f.tool === "opengrep");
    expect(finding?.rule).toBe("lastlight-hardcoded-secret");
    expect(finding?.severity).toBe("p2-medium");
    expect(
      document.degraded.some((d) => /opengrep exited/.test(d.reason)),
      "exit 1 is how opengrep reports a hit",
    ).toBe(false);
  });

  it("treats `exit 2` as a failed scan and quotes the scanner's own stderr", () => {
    const document = scan({ LASTLIGHT_OPENGREP_BIN: fake("opengrep", OPENGREP_EXIT_2) });
    const entry = document.degraded.find((d) => /opengrep exited 2/.test(d.reason));
    expect(entry, "a scanner that failed must not contribute an empty finding list").toBeDefined();
    expect(entry?.reason).toMatch(/could not load the ruleset/);
    expect(document.findings.filter((f) => f.tool === "opengrep")).toEqual([]);
    expect(document.coverage).toBe("degraded");
  });

  it("names a ruleset that does not exist rather than scanning with the registry", () => {
    const missing = join(fixture.dir, "rules", "absent.yaml");
    const document = scan(
      { LASTLIGHT_OPENGREP_BIN: fake("opengrep", OPENGREP_FINDINGS_EXIT_1) },
      fixture,
      missing,
    );
    const entry = document.degraded.find((d) => d.reason.includes(missing));
    expect(entry?.reason).toMatch(/does not exist/);
    // Locked decision 7: the Semgrep registry is deliberately not a fallback.
    expect(entry?.reason).toMatch(/registry is deliberately not used/);
    expect(document.findings.filter((f) => f.tool === "opengrep")).toEqual([]);
  });

  it("says so when the diff leaves NOTHING at head to scan", () => {
    // Every changed path is a deletion, so there is no file to hand opengrep —
    // which is not the same as scanning and finding nothing.
    const deletionOnly = makeFixture(
      "deletion-only",
      { message: "base", files: { "src/a.ts": "export const A = 1;\n", "README.md": "# x\n" } },
      { message: "head", files: { "src/a.ts": null } },
    );
    try {
      const document = scan(
        { LASTLIGHT_OPENGREP_BIN: fake("opengrep", OPENGREP_FINDINGS_EXIT_1) },
        deletionOnly,
      );
      expect(
        document.degraded.some((d) => /no changed file exists at head to scan/.test(d.reason)),
      ).toBe(true);
      expect(document.findings.filter((f) => f.tool === "opengrep")).toEqual([]);
    } finally {
      deletionOnly.cleanup();
    }
  });

  it("falls back from `detect` to `git` when the subcommand was renamed", () => {
    const document = scan({ LASTLIGHT_GITLEAKS_BIN: fake("gitleaks", GITLEAKS_NO_DETECT) });
    const secret = document.findings.find((f) => f.tool === "gitleaks");
    expect(secret?.rule, "the fallback subcommand must produce the same report").toBe(
      "aws-access-token",
    );
    expect(secret?.severity).toBe("p1-high");
    // A bump that silently changed the subcommand would otherwise present as
    // "no secrets found", so the fallback succeeding must leave no failure note.
    expect(document.degraded.some((d) => /gitleaks exited/.test(d.reason))).toBe(false);
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
