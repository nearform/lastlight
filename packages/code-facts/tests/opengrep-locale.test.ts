import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { opengrepArgs, withUtf8Locale } from "../src/patterns.js";

// Regression for the sandbox image shipping no locale: opengrep decoded its
// --config as ASCII and died on an em dash in a rules-file COMMENT (exit 2,
// empty stdout), so every `patterns` run degraded to zero findings.

describe("withUtf8Locale", () => {
  it("forces a UTF-8 locale and keeps the rest of the environment", () => {
    const env = withUtf8Locale({ PATH: "/usr/bin", LANG: "C", LC_ALL: "POSIX", KEEP: "1" });
    expect(env).toMatchObject({ PATH: "/usr/bin", KEEP: "1", LANG: "C.UTF-8", LC_ALL: "C.UTF-8" });
  });
});

/**
 * The machine's real opengrep, if it has one. Not `resolveToolBin(process.env)`:
 * vitest.config.ts disables scanners for the rest of the suite, and hands the
 * real binary to the suites that exist to run it under this test-only name.
 */
const OPENGREP = process.env.LASTLIGHT_TEST_OPENGREP_BIN || null;

describe.skipIf(!OPENGREP)("opengrep loads a rules file with non-ASCII text", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "ll-facts-locale-"));
    writeFileSync(
      join(dir, "rules.yaml"),
      [
        "# A comment with an em dash — and an arrow → that an ASCII decoder rejects.",
        "rules:",
        "  - id: locale-probe",
        "    pattern: eval($X)",
        "    message: eval call",
        "    languages: [python]",
        "    severity: WARNING",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(join(dir, "probe.py"), "eval(user_input)\n", "utf8");
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("scans cleanly when spawned the way production spawns it, starting from a locale-less env", () => {
    // Only PATH/HOME survive — no LANG/LC_* — which is exactly the sandbox image.
    const bare = { PATH: process.env.PATH, HOME: process.env.HOME };
    const result = spawnSync(OPENGREP as string, opengrepArgs(join(dir, "rules.yaml"), ["probe.py"]), {
      cwd: dir,
      env: withUtf8Locale(bare),
      encoding: "utf8",
      timeout: 120_000,
    });
    // opengrep exits 1 when it FINDS something — success, as in extractPatterns.
    expect([0, 1], result.stderr).toContain(result.status);
    const parsed = JSON.parse(result.stdout) as { results?: Array<{ check_id: string }> };
    expect(parsed.results?.map((r) => r.check_id)).toContain("locale-probe");
  });
});
