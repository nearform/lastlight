/**
 * Table tests over literal marker lines.
 *
 * These two grammars are the only thing that survives a fix run: the `class=`
 * token decides whether an attempt was spent, and the rendered line is replayed
 * into every later attempt's prompt. The input is agent output — untrusted text
 * written by a language model under time pressure — so the cases below are
 * mostly about the ways it goes WRONG: a `cause=` that is a sentence containing
 * `=`, a truncated line, a hallucinated class, an empty output.
 */

import { describe, it, expect } from "vitest";
import {
  boundAttemptLines,
  lastMarkerLine,
  MAX_ATTEMPT_LINE_CHARS,
  MAX_PRIOR_ATTEMPT_LINES,
  parseAttemptMarkers,
  parseDiagnosisMarker,
  parseFixOutcomeMarker,
  renderAttemptLine,
} from "#src/engine/fix-markers.js";

const WELL_FORMED_DIAGNOSIS =
  "DIAGNOSIS_COMPLETE: pr=190 attempt=2 class=env-mismatch " +
  "cause=the lockfile is stale vs package.json " +
  "ci_vs_local=CI runs node 22, sandbox node 20 " +
  "unreproducible=e2e (chrome), deploy-preview";

const WELL_FORMED_FIX =
  "CI_FIX_COMPLETE: pr=190 attempt=2 outcome=pushed " +
  "tried=regenerated the lockfile with pnpm install --lockfile-only gate=green";

describe("parseDiagnosisMarker", () => {
  it("parses a well-formed marker, field by field", () => {
    const m = parseDiagnosisMarker(WELL_FORMED_DIAGNOSIS);
    expect(m).not.toBeNull();
    expect(m?.pr).toBe(190);
    expect(m?.attempt).toBe(2);
    expect(m?.class).toBe("env-mismatch");
    // The whole clause, not its first word — the single most likely defect in a
    // naive `split(" ")` implementation.
    expect(m?.cause).toBe("the lockfile is stale vs package.json");
    expect(m?.ciVsLocal).toBe("CI runs node 22, sandbox node 20");
    expect(m?.unreproducible).toEqual(["e2e (chrome)", "deploy-preview"]);
  });

  it("keeps a cause containing `=` and spaces intact", () => {
    // `NODE_ENV=production` inside the value must not end the field, and
    // `class=` appearing as a substring of a longer word must not either.
    const m = parseDiagnosisMarker(
      "DIAGNOSIS_COMPLETE: pr=7 attempt=1 class=reproducible " +
        "cause=the suite only fails when NODE_ENV=production is set, see subclass=Foo " +
        "ci_vs_local=none",
    );
    expect(m?.class).toBe("reproducible");
    expect(m?.cause).toBe(
      "the suite only fails when NODE_ENV=production is set, see subclass=Foo",
    );
    expect(m?.ciVsLocal).toBe("none");
  });

  it("degrades field by field on a truncated marker", () => {
    const m = parseDiagnosisMarker("DIAGNOSIS_COMPLETE: pr=190 attempt=2 class=flaky");
    expect(m?.class).toBe("flaky");
    expect(m?.cause).toBe("");
    expect(m?.ciVsLocal).toBe("");
    expect(m?.unreproducible).toEqual([]);
  });

  it("does not coerce an unrecognised class", () => {
    // `probably-flaky` becoming `flaky` would defer the PR for free, forever.
    const m = parseDiagnosisMarker("DIAGNOSIS_COMPLETE: pr=1 attempt=1 class=probably-flaky cause=x");
    expect(m?.class).toBeNull();
    expect(m?.rawClass).toBe("probably-flaky");
    expect(m?.cause).toBe("x");
  });

  it("takes the LAST marker when the output replays an earlier one", () => {
    // A `generic_loop` iteration sees `{{previousOutput}}`, so iteration 1's
    // marker is genuinely present earlier in iteration 2's text.
    const m = parseDiagnosisMarker(
      [
        "Previous output:",
        "DIAGNOSIS_COMPLETE: pr=1 attempt=1 class=flaky cause=timeout",
        "",
        "Re-ran the job three times; it fails every time.",
        "DIAGNOSIS_COMPLETE: pr=1 attempt=2 class=reproducible cause=assertion fails",
      ].join("\n"),
    );
    expect(m?.class).toBe("reproducible");
    expect(m?.attempt).toBe(2);
  });

  it("tolerates a fenced / prefixed marker rather than insisting on a bare last line", () => {
    const m = parseDiagnosisMarker(
      "Here is my verdict:\n\n`DIAGNOSIS_COMPLETE: pr=3 attempt=1 class=infra-dependent cause=needs postgres`\n",
    );
    expect(m?.class).toBe("infra-dependent");
    expect(m?.cause).toBe("needs postgres");
  });

  const junk: Array<[string, string]> = [
    ["no marker at all", "I looked at the failure and it seems bad."],
    ["empty output", ""],
    ["the tag with no fields", "DIAGNOSIS_COMPLETE:"],
    ["a garbage line", "DIAGNOSIS COMPLETE ~~~ ??? class flaky"],
  ];
  for (const [name, output] of junk) {
    it(`never throws on ${name}`, () => {
      expect(() => parseDiagnosisMarker(output)).not.toThrow();
    });
  }

  it("returns null when there is no marker — a meaningful answer, not an error", () => {
    // "No DIAGNOSIS_COMPLETE" is how a crashed run is told from a run that
    // spent an attempt, so it must be distinguishable from a parsed marker.
    expect(parseDiagnosisMarker("I looked at the failure and it seems bad.")).toBeNull();
    expect(parseDiagnosisMarker("")).toBeNull();
  });

  it("parses the tag with no fields into an all-empty marker, not null", () => {
    const m = parseDiagnosisMarker("DIAGNOSIS_COMPLETE:");
    expect(m).not.toBeNull();
    expect(m?.class).toBeNull();
    expect(m?.cause).toBe("");
  });
});

describe("parseFixOutcomeMarker", () => {
  it("parses a well-formed marker", () => {
    const m = parseFixOutcomeMarker(WELL_FORMED_FIX);
    expect(m?.outcome).toBe("pushed");
    expect(m?.tried).toBe("regenerated the lockfile with pnpm install --lockfile-only");
    expect(m?.gate).toBe("green");
  });

  it("does not coerce an unrecognised outcome or gate", () => {
    const m = parseFixOutcomeMarker(
      "CI_FIX_COMPLETE: pr=1 attempt=1 outcome=maybe tried=stuff gate=probably-green",
    );
    expect(m?.outcome).toBeNull();
    expect(m?.rawOutcome).toBe("maybe");
    expect(m?.gate).toBeNull();
    expect(m?.rawGate).toBe("probably-green");
  });

  it("keeps `gate=skipped` as its own value", () => {
    // 09 → S1: `skipped` never authorises a push, so folding it into `red`
    // would lose the distinction the push gate is built on.
    expect(parseFixOutcomeMarker("CI_FIX_COMPLETE: gate=skipped")?.gate).toBe("skipped");
  });

  it("returns null when the output carries only the OTHER marker", () => {
    expect(parseFixOutcomeMarker(WELL_FORMED_DIAGNOSIS)).toBeNull();
    expect(parseDiagnosisMarker(WELL_FORMED_FIX)).toBeNull();
  });
});

describe("lastMarkerLine", () => {
  it("returns null for a tag that is absent", () => {
    expect(lastMarkerLine("nothing here", "DIAGNOSIS_COMPLETE")).toBeNull();
  });
});

describe("renderAttemptLine", () => {
  it("renders the one bounded line 04-retry.md §4.2 specifies", () => {
    const line = renderAttemptLine(2, parseAttemptMarkers(`${WELL_FORMED_DIAGNOSIS}\n${WELL_FORMED_FIX}`));
    expect(line).toBe(
      "attempt 2: class=env-mismatch cause=the lockfile is stale vs package.json | outcome=pushed gate=green",
    );
  });

  it("renders a diagnosis-only attempt (a `flaky` deferral runs no fix phase)", () => {
    const line = renderAttemptLine(
      1,
      parseAttemptMarkers("DIAGNOSIS_COMPLETE: pr=1 attempt=1 class=flaky cause=network timeout on install"),
    );
    expect(line).toBe("attempt 1: class=flaky cause=network timeout on install");
  });

  it("renders an unknown class as `unknown` rather than echoing the invention back", () => {
    const line = renderAttemptLine(
      1,
      parseAttemptMarkers("DIAGNOSIS_COMPLETE: class=probably-flaky cause=who knows"),
    );
    expect(line).toBe("attempt 1: class=unknown cause=who knows");
  });

  it("returns null when the attempt produced no marker at all", () => {
    expect(renderAttemptLine(1, null)).toBeNull();
    expect(renderAttemptLine(1, { diagnosis: null, fix: null })).toBeNull();
  });

  it("bounds the line hard — it is replayed into EVERY later prompt", () => {
    const line = renderAttemptLine(
      3,
      parseAttemptMarkers(
        `DIAGNOSIS_COMPLETE: pr=1 attempt=3 class=reproducible cause=${"x".repeat(4000)}`,
      ),
    );
    expect(line).not.toBeNull();
    expect(line!.length).toBeLessThanOrEqual(MAX_ATTEMPT_LINE_CHARS);
    expect(line).toMatch(/^attempt 3: class=reproducible cause=x+…$/);
  });

  it("keeps the outcome clause even when the cause is enormous", () => {
    const line = renderAttemptLine(
      3,
      parseAttemptMarkers(
        `DIAGNOSIS_COMPLETE: class=reproducible cause=${"y".repeat(500)}\n` +
          "CI_FIX_COMPLETE: outcome=gave-up tried=lots gate=red",
      ),
    );
    expect(line!.length).toBeLessThanOrEqual(MAX_ATTEMPT_LINE_CHARS);
    expect(line).toContain("outcome=gave-up gate=red");
  });
});

describe("boundAttemptLines", () => {
  it("keeps the newest lines and drops the oldest", () => {
    const lines = Array.from({ length: MAX_PRIOR_ATTEMPT_LINES + 3 }, (_, i) => `attempt ${i + 1}: class=flaky`);
    const bounded = boundAttemptLines(lines);
    expect(bounded).toHaveLength(MAX_PRIOR_ATTEMPT_LINES);
    expect(bounded[0]).toBe("attempt 4: class=flaky");
    expect(bounded[bounded.length - 1]).toBe(`attempt ${lines.length}: class=flaky`);
  });

  it("drops non-strings a hand-edited row could carry", () => {
    expect(boundAttemptLines(["a", "", null as unknown as string, "b"])).toEqual(["a", "b"]);
  });
});
