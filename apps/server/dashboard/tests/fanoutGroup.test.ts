/**
 * The compact fan-out block's chip model (`lib/fanout-group.ts`), and the
 * derived-name grammar it moved out of `WorkflowPipeline` with.
 *
 * The block exists for pr-review's `site-review`: up to sixteen investigators,
 * drawn as sixteen cards side by side before it. What is pinned is what a
 * reader of the block relies on — every planned branch has a chip from the
 * moment the fan-out starts, gate rows never become chips of their own, and a
 * chip's label is short without losing the pair suffix.
 */
import { describe, it, expect } from "vitest";
import {
  fanoutPlanOf,
  foldGateStatus,
  gateOwnerOf,
  parseDerived,
  shortChipLabels,
  summarizeFanout,
} from "../src/lib/fanout-group";
import type { WorkflowRunExecution } from "../src/api";

const exec = (over: Partial<WorkflowRunExecution>): WorkflowRunExecution =>
  ({ phase: "x", startedAt: "2026-09-30T00:00:00Z", ...over }) as WorkflowRunExecution;

describe("shortChipLabels", () => {
  it("drops the shared `-`-delimited prefix, keeping the pair suffix", () => {
    expect(shortChipLabels(["site-001", "site-002", "site-001-b"])).toEqual(["001", "002", "001-b"]);
  });
  it("never cuts inside a word, and leaves unrelated names alone", () => {
    expect(shortChipLabels(["contract", "enforcement", "security"])).toEqual(["contract", "enforcement", "security"]);
    expect(shortChipLabels(["survey", "surveyor"])).toEqual(["survey", "surveyor"]);
  });
  it("keeps a lone name whole", () => {
    expect(shortChipLabels(["site-001"])).toEqual(["site-001"]);
  });
});

describe("summarizeFanout", () => {
  const plan = {
    dynamic: true,
    planned: [
      { name: "site-001", model: "a/primary" },
      { name: "site-002", model: "a/primary" },
      { name: "site-001-b", model: "b/pair" },
    ],
  };

  it("draws a pending chip for every planned branch that has not started, in plan order", () => {
    const { chips, counts } = summarizeFanout(
      "site-review",
      [{ id: "site-review_branch_site-002", status: "active" }],
      plan,
    );
    expect(chips.map((c) => [c.label, c.status])).toEqual([
      ["001", "pending"],
      ["002", "active"],
      ["001-b", "pending"],
    ]);
    expect(counts).toMatchObject({ pending: 2, active: 1, done: 0 });
    // The chip's id is the ledger name — what the detail panel opens.
    expect(chips[2]).toMatchObject({ id: "site-review_branch_site-001-b", model: "b/pair" });
  });

  it("with no plan (a static fan-out), chips are the rows, by name", () => {
    const { chips, counts } = summarizeFanout(
      "survey",
      [
        { id: "survey_branch_tests", status: "done", duration: 12 },
        { id: "survey_branch_contract", status: "failed" },
      ],
      null,
    );
    expect(chips.map((c) => [c.label, c.status, c.duration ?? null])).toEqual([
      ["contract", "failed", null],
      ["tests", "done", 12],
    ]);
    expect(counts).toMatchObject({ done: 1, failed: 1 });
  });

  it("marks the selected branch", () => {
    const { chips } = summarizeFanout("site-review", [], plan, "site-review_branch_site-002");
    expect(chips.filter((c) => c.selected).map((c) => c.label)).toEqual(["002"]);
  });
});

describe("gate rows fold into their branch, never a chip of their own", () => {
  it("names the owner of `_check` / `_retry` / `_regate` rows", () => {
    for (const s of ["check", "retry", "regate"]) {
      expect(gateOwnerOf(`site-review_branch_site-001-b_${s}`)).toBe("site-review_branch_site-001-b");
    }
    expect(gateOwnerOf("site-review_branch_site-001-b")).toBeNull();
  });
  it("parses a hyphenated pair branch against an underscored base", () => {
    expect(parseDerived("site_review_branch_site-001-b")).toEqual({ kind: "branch", base: "site_review", branch: "site-001-b" });
  });
  it("an unmet gate turns a done branch `unmet`; a red gate turns it `failed`", () => {
    expect(foldGateStatus("done", exec({ success: true, stopReason: "condition_not_met" }))).toBe("unmet");
    expect(foldGateStatus("done", exec({ success: false }))).toBe("failed");
    expect(foldGateStatus("failed", exec({ success: true, stopReason: "condition_not_met" }))).toBe("failed");
  });
});

describe("fanoutPlanOf", () => {
  it("reads scratch.fanout[<phase>], and tolerates a run with none", () => {
    const run = { scratch: { fanout: { "site-review": { dynamic: true, planned: [{ name: "a" }], truncated: 0 } } } };
    expect(fanoutPlanOf(run, "site-review")?.planned).toEqual([{ name: "a" }]);
    expect(fanoutPlanOf(run, "other")).toBeNull();
    expect(fanoutPlanOf({}, "site-review")).toBeNull();
    expect(fanoutPlanOf({ scratch: { fanout: { "site-review": { planned: "junk" } } } }, "site-review")).toBeNull();
  });
});
