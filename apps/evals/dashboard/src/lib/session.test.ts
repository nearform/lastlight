import { describe, expect, it } from "vitest";

import { branchVocabulary, deriveLaneLabel, prettyPhase } from "./session";

/** The lane-naming rules, pinned on both sides of the 2026-08-22 stamp.
 *
 * `deriveLaneLabel` is pure and takes the opening prompt text + the session's
 * `phase` stamp, so the whole decision table is testable without a jsonl. The
 * fallback half matters as much as the stamped half: an archived run predates
 * the stamp and must keep rendering exactly as it did. */
describe("prettyPhase", () => {
  it("reduces a fan-out branch to its family and a loop to its phase", () => {
    expect(prettyPhase("survey_branch_contract")).toBe("contract");
    expect(prettyPhase("survey_branch_spec_retry")).toBe("spec");
    expect(prettyPhase("falsify_iter_1")).toBe("falsify");
    expect(prettyPhase("adjudicate_iter_2")).toBe("adjudicate");
  });

  it("passes a plain phase through untouched", () => {
    for (const p of ["facts", "seed", "prepare", "review"]) expect(prettyPhase(p)).toBe(p);
  });
});

describe("deriveLaneLabel with a phase stamp", () => {
  const vocab = new Map<string, string>();

  it("names an agent lane from the stamp and keeps the raw label for the tooltip", () => {
    expect(deriveLaneLabel("Review this PR.", 5, vocab, "falsify_iter_1")).toEqual({
      label: "falsify",
      named: true,
      full: "falsify_iter_1",
      kind: "agent",
    });
  });

  it("labels a command lane with its phase but keeps kind + command", () => {
    const lane = deriveLaneLabel("$ set -u\n# a comment\nlastlight-facts", 0, vocab, "facts");
    expect(lane.kind).toBe("command");
    expect(lane.label).toBe("facts");
    expect(lane.full).toBe("facts");
    expect(lane.command).toBe("set -u");
  });

  it("prefers the stamp over the mined family marker", () => {
    const text = "## Your family: `contract`\n\nreview it";
    expect(deriveLaneLabel(text, 0, vocab, "survey_branch_security").label).toBe("security");
  });
});

describe("deriveLaneLabel without a stamp (an archived run)", () => {
  it("mines the family marker and confirms it against the vocabulary", () => {
    const vocab = branchVocabulary([{ phase: "survey_branch_contract" }]);
    expect(deriveLaneLabel("## Your family: `contract`\n", 3, vocab)).toEqual({
      label: "contract",
      named: true,
      full: "survey_branch_contract",
      kind: "agent",
    });
  });

  it("falls back to a positional placeholder", () => {
    expect(deriveLaneLabel("Review this PR.", 5, new Map())).toEqual({
      label: "session 6",
      named: false,
      kind: "agent",
    });
  });

  it("still calls a bare command lane `command`", () => {
    expect(deriveLaneLabel("$ npm test", 0, new Map())).toEqual({
      label: "command",
      named: true,
      kind: "command",
      command: "npm test",
    });
  });
});
