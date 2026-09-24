import { describe, expect, it } from "vitest";

import {
  buildFamilyDrilldown,
  citationResolver,
  dischargeOf,
  failureScenarioState,
  findingKey,
  isCleanDischarge,
  parseHypotheses,
  parseJsonlRows,
  splitDropped,
} from "./pipelineArtifacts";

/**
 * These are the rules that can be wrong SILENTLY.
 *
 * Every assertion here mirrors one the harness's own reader
 * (`../../src/review-pipeline-stats.ts`) makes over the same documents, because
 * this module is a second implementation of it for the browser. A drift
 * between the two does not throw: it renders a join to the wrong claims, or a
 * zero where the truth is "unknown", and reads exactly like a result.
 *
 * The fixtures are cut down from real preserved artifacts
 * (`~/lastlight-run-artifacts/…/prreview__skillspro-1587-r2/pr-review/`) —
 * including the `spec` pass's invented `verdict`/`rationale` row shape and the
 * `tests` family's one-line `notMeasured` tombstone.
 */

const jsonl = (...rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

describe("hypothesis identity is positional", () => {
  it("names rows <family>-NNN from the filename and append order", () => {
    const rows = parseHypotheses("contract", jsonl({ claim: "a" }, { claim: "b" }, { claim: "c" }));
    expect(rows.map((r) => r.id)).toEqual(["contract-001", "contract-002", "contract-003"]);
  });

  it("ignores the model-declared id and keeps it only as an alias", () => {
    // A row declaring `contract-001` from THIRD position must not capture
    // citations meant for the real first row.
    const rows = parseHypotheses("contract", jsonl({ id: "x" }, { id: "y" }, { id: "contract-001" }));
    expect(rows.map((r) => r.id)).toEqual(["contract-001", "contract-002", "contract-003"]);
    expect(rows[2].declaredId).toBe("contract-001");
    const resolve = citationResolver(rows);
    expect(resolve("contract-001")).toBe("contract-001"); // canonical wins outright
    expect(resolve("x")).toBe("contract-001"); // unambiguous alias
    expect(resolve("nope")).toBeUndefined();
  });

  it("refuses an alias two rows both declare", () => {
    const rows = parseHypotheses("state", jsonl({ id: "dup" }, { id: "dup" }));
    expect(citationResolver(rows)("dup")).toBeUndefined();
  });

  it("a torn line consumes no ordinal; a scalar line does", () => {
    // Exactly code-facts' `readJsonlRows`: getting this backwards shifts every
    // later row's id and mis-resolves every citation after it.
    const text = '{"claim":"a"}\n\n{"claim":"b"\n42\n{"claim":"c"}\n';
    expect(parseJsonlRows(text)).toEqual([{ claim: "a" }, 42, { claim: "c" }]);
    const rows = parseHypotheses("state", text);
    expect(rows.map((r) => r.id)).toEqual(["state-001", "state-002", "state-003"]);
    expect(rows[2].claim).toBe("c");
  });
});

describe("discharge codes", () => {
  it("reads discharge or status, case-insensitively", () => {
    expect(dischargeOf({ discharge: "quote" })).toBe("QUOTE");
    expect(dischargeOf({ status: "PARTIAL" })).toBe("PARTIAL");
  });

  it("puts an off-vocabulary code in bad-code and an absent one in none", () => {
    expect(dischargeOf({ discharge: "N/A" })).toBe("bad-code");
    expect(dischargeOf({})).toBe("none");
    expect(dischargeOf({ discharge: "   " })).toBe("none");
  });

  it("does NOT read the spec pass's `verdict` — the harness does not either", () => {
    expect(dischargeOf({ verdict: "QUOTE" })).toBe("none");
  });

  it("files the dead-family tombstone's status as bad-code", () => {
    expect(dischargeOf({ status: "notMeasured" })).toBe("bad-code");
  });
});

describe("failureScenario is three-state", () => {
  it("separates explicit null from an absent key", () => {
    expect(failureScenarioState({ failureScenario: null })).toBe("null");
    expect(failureScenarioState({ failureScenario: "boom" })).toBe("present");
    expect(failureScenarioState({})).toBe("absent");
  });

  it("a clean discharge needs QUOTE and an explicitly null scenario", () => {
    expect(isCleanDischarge({ discharge: "QUOTE", failureScenario: null })).toBe(true);
    expect(isCleanDischarge({ discharge: "QUOTE" })).toBe(false); // absent carries no information
    expect(isCleanDischarge({ discharge: "QUOTE", failureScenario: "boom" })).toBe(false);
    expect(isCleanDischarge({ discharge: "ABSENT", failureScenario: null })).toBe(false);
  });
});

describe("findings ↔ disposition join", () => {
  it("keys on path + title and deliberately not on line", () => {
    // The boundary re-anchors a finding to a line GitHub can hang a comment on;
    // keying on the line lost 10 of 32 findings on a measured case.
    expect(findingKey({ path: "a.ts", title: "T", line: 1042 } as never)).toBe(
      findingKey({ path: "a.ts", title: "T", line: 1063 } as never),
    );
    expect(findingKey({ path: "a.ts", title: "T" })).not.toBe(findingKey({ path: "b.ts", title: "T" }));
  });

  it("joins a re-anchored finding and carries its tier + reason", () => {
    const d = buildFamilyDrilldown({
      family: "contract",
      hypothesesText: jsonl({ claim: "c1", discharge: "PARTIAL", failureScenario: "boom" }),
      findings: {
        findings: [
          { title: "T", path: "APIContext.tsx", line: 1042, family: "contract", hypotheses: ["contract-001"] },
        ],
      },
      disposition: {
        findings: [
          {
            tier: "internal",
            reason: "below-floor",
            finding: { title: "T", path: "APIContext.tsx", line: 1063 },
          },
        ],
      },
    });
    expect(d.findings[0].joined).toBe(true);
    expect(d.findings[0].tier).toBe("internal");
    expect(d.findings[0].reason).toBe("below-floor");
    expect(d.hypotheses[0].findings).toEqual([0]);
    expect(d.orphanHypotheses).toEqual([]);
  });

  it("leaves tier absent — not internal — when disposition.json is missing", () => {
    const d = buildFamilyDrilldown({
      family: "contract",
      hypothesesText: jsonl({ claim: "c1" }),
      findings: { findings: [{ title: "T", path: "a.ts", family: "contract", hypotheses: ["contract-001"] }] },
    });
    expect(d.dispositionPresent).toBe(false);
    expect(d.findings[0].tier).toBeUndefined();
    expect(d.findings[0]).not.toHaveProperty("reason");
    expect(d.findings[0].joined).toBe(false);
  });

  it("an inline row never demoted keeps reason null, distinct from unjoined", () => {
    const d = buildFamilyDrilldown({
      family: "contract",
      hypothesesText: jsonl({ claim: "c1" }),
      findings: { findings: [{ title: "T", path: "a.ts", family: "contract", hypotheses: ["contract-001"] }] },
      disposition: { findings: [{ tier: "inline", reason: null, finding: { title: "T", path: "a.ts" } }] },
    });
    expect(d.findings[0].reason).toBeNull();
    expect(d.findings[0].joined).toBe(true);
  });
});

describe("what became of each hypothesis", () => {
  const input = {
    family: "enforcement",
    hypothesesText: jsonl(
      { id: "enforcement-001", claim: "cited", discharge: "ABSENT", failureScenario: "boom" },
      { id: "enforcement-002", claim: "orphan", discharge: "QUOTE", failureScenario: null },
    ),
    findings: {
      findings: [
        { title: "F1", path: "a.ts", family: "enforcement", hypotheses: ["enforcement-001"] },
        { title: "F2", path: "b.ts", family: "enforcement", hypotheses: [] },
        { title: "F3", path: "c.ts", family: "state", hypotheses: ["state-004"] },
      ],
    },
    disposition: {
      findings: [{ tier: "body", reason: "adjudicated", finding: { title: "F1", path: "a.ts" } }],
    },
  };

  it("reports the hypotheses that reached no finding at all", () => {
    const d = buildFamilyDrilldown(input);
    expect(d.orphanHypotheses).toEqual(["enforcement-002"]);
  });

  it("counts a family finding citing nothing as unprovenanced", () => {
    expect(buildFamilyDrilldown(input).unprovenanced).toBe(1);
  });

  it("excludes another family's finding that cites none of these rows", () => {
    expect(buildFamilyDrilldown(input).findings.map((f) => f.title)).toEqual(["F1", "F2"]);
  });

  it("INCLUDES another family's finding when it was built from this family's row", () => {
    // The adjudicator can merge across families; a finding filed elsewhere that
    // cites our row is still what became of our hypothesis.
    const d = buildFamilyDrilldown({
      ...input,
      findings: { findings: [{ title: "X", path: "x.ts", family: "state", hypotheses: ["enforcement-002"] }] },
    });
    expect(d.findings.map((f) => f.title)).toEqual(["X"]);
    expect(d.orphanHypotheses).toEqual(["enforcement-001"]);
    expect(d.unprovenanced).toBe(0);
  });

  it("keeps a citation this family's file cannot resolve, labelled", () => {
    const d = buildFamilyDrilldown({
      ...input,
      findings: {
        findings: [
          { title: "F1", path: "a.ts", family: "enforcement", hypotheses: ["enforcement-001", "security-003"] },
        ],
      },
    });
    expect(d.findings[0].resolved).toEqual(["enforcement-001"]);
    expect(d.findings[0].unresolved).toEqual(["security-003"]);
  });
});

describe("absent is not zero", () => {
  it("leaves obligationCount undefined when the document carries no count", () => {
    const d = buildFamilyDrilldown({
      family: "spec",
      obligations: { families: [{ family: "spec", measured: false, notMeasuredReason: "cannot see the PR body" }] },
    });
    expect(d.obligationCount).toBeUndefined();
  });

  it("spec: measured:false with live rows is NOT notMeasured", () => {
    // `spec`'s axis is built harness-side under its own cap, so code-facts says
    // it cannot COUNT the obligations while the survey plainly ran. Marking it
    // notMeasured reported a working instrument as a dead one on every run.
    const d = buildFamilyDrilldown({
      family: "spec",
      obligations: {
        families: [
          { family: "spec", obligations: 0, minted: 0, cap: null, measured: false, notMeasuredReason: "harness-side" },
        ],
      },
      hypothesesText: jsonl(
        { obligation: "S-1", verdict: "QUOTE", path: "a.ts", line: 37, rationale: "implements the thing" },
        { obligation: "S-2", verdict: "QUOTE", path: "b.ts", line: 12, rationale: "and the other" },
      ),
    });
    expect(d.notMeasured).toBe(false);
    expect(d.declaredMeasured).toBe(false);
    expect(d.obligationCount).toBe(0);
    expect(d.hypotheses).toHaveLength(2);
    expect(d.hypotheses[0].claim).toBe("implements the thing"); // `rationale` is the claim here
    expect(d.hypotheses[0].anchors).toEqual(["a.ts:37"]);
    expect(d.hypotheses[0].discharge).toBe("none"); // `verdict` is not a discharge
  });

  it("tests: measured:false with only the tombstone IS notMeasured", () => {
    const d = buildFamilyDrilldown({
      family: "tests",
      obligations: {
        families: [
          {
            family: "tests",
            obligations: 0,
            minted: 0,
            cap: 8,
            measured: false,
            notMeasuredReason: "no coverage artifact was read",
          },
        ],
      },
      hypothesesText: jsonl({ claim: "no tests hypothesis", status: "notMeasured", reason: "no coverage artifact" }),
    });
    expect(d.notMeasured).toBe(true);
    expect(d.notMeasuredReason).toBe("no coverage artifact was read");
    expect(d.hypotheses[0].notMeasuredMarker).toBe(true);
    expect(d.hypotheses[0].id).toBe("tests-001"); // the tombstone still holds its ordinal
    expect(d.orphanHypotheses).toEqual([]); // a tombstone is not an unreached hypothesis
  });

  it("a run that died before adjudication has no findings.json, not zero findings", () => {
    // The interrupted 2026-09-21 keeper is exactly this: 12 contract
    // hypotheses, no findings.json. Every row is trivially "unreached", and
    // reporting that as the conservation alarm would invent a result.
    const d = buildFamilyDrilldown({
      family: "contract",
      hypothesesText: jsonl({ claim: "c1" }, { claim: "c2" }),
    });
    expect(d.findingsPresent).toBe(false);
    expect(d.findings).toEqual([]);
    expect(d.orphanHypotheses).toEqual(["contract-001", "contract-002"]);
  });

  it("distinguishes a missing hypotheses file from an empty one", () => {
    expect(buildFamilyDrilldown({ family: "state" }).hypothesesFilePresent).toBe(false);
    const empty = buildFamilyDrilldown({ family: "state", hypothesesText: "" });
    expect(empty.hypothesesFilePresent).toBe(true);
    expect(empty.hypotheses).toEqual([]);
  });
});

describe("dropped obligations", () => {
  const dropped = [
    { reason: "enforcedAt names no candidates — one-ended, dropped", count: 3 },
    { reason: "over the per-family ceiling of 12 for contract — that family's own obligations", count: 31 },
    { reason: "over the per-family ceiling of 8 for state", count: 3 },
  ];
  const families = ["contract", "enforcement", "security", "state", "tests", "spec"];

  it("splits the run-wide reasons into ones naming this family and ones naming none", () => {
    const { naming, runWide } = splitDropped(dropped, "contract", families);
    expect(naming.map((d) => d.count)).toEqual([31]);
    expect(runWide.map((d) => d.count)).toEqual([3]); // the one-ended drop names no family
  });

  it("does not hand one family another family's ceiling reason", () => {
    const { naming } = splitDropped(dropped, "state", families);
    expect(naming.map((d) => d.count)).toEqual([3]);
  });

  it("derives the per-family dropped count from minted − obligations, not from prose", () => {
    const d = buildFamilyDrilldown({
      family: "contract",
      obligations: {
        dropped,
        families: [{ family: "contract", obligations: 12, minted: 43, cap: 12, measured: true }],
        obligations: [
          { id: "O-001", family: "contract", question: "Quote the line at each consumer." },
          { id: "O-002", family: "enforcement", question: "Not ours." },
        ],
      },
    });
    expect(d.cappedOut).toBe(31);
    expect(d.cap).toBe(12);
    expect(d.obligations.map((o) => o.id)).toEqual(["O-001"]);
    expect(d.droppedNamingFamily).toHaveLength(1);
  });

  it("leaves cappedOut absent when the run did not record `minted`", () => {
    // Runs measured before code-facts recorded it must not gain a fabricated
    // "nothing was truncated".
    const d = buildFamilyDrilldown({
      family: "contract",
      obligations: { families: [{ family: "contract", obligations: 12, measured: true }] },
    });
    expect(d.cappedOut).toBeUndefined();
  });
});

describe("parseJsonlRows — the code-facts copy", () => {
  // Mirrors packages/code-facts/tests/jsonl.test.ts — this is a copy of that
  // reader, and ordinals are identity, so the two must accept the same rows.
  it("reads one value per line, recovering pretty-printed and run-together rows", () => {
    const pretty = JSON.stringify({ claim: "if (x) { \"}\" }", n: 2 }, null, 2);
    expect(parseJsonlRows(`{"n":1}\n${pretty}\n42\n{"n":3}{"n":4}\n`)).toEqual([
      { n: 1 },
      { claim: "if (x) { \"}\" }", n: 2 },
      42,
      { n: 3 },
      { n: 4 },
    ]);
  });

  it("never lets a broken or torn line swallow the rows after it", () => {
    expect(parseJsonlRows(`{"n": 1, "bad": }\n{"n":2}\n\`\`\`\n{\n  "claim": "cut off`)).toEqual([{ n: 2 }]);
  });
});
