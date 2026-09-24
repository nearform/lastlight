/**
 * The internal-recall grader's CONFIRM pass — the correction the 2026-09-21
 * judge audit bought (`docs/plans/probe-oracle.md`, journal §"Rung 5": 11 of 30
 * credited pairs wrong, `internal`-tier credits 1 correct in 10).
 *
 * These stub the model. What is worth pinning is not the judge's taste — that
 * is measured by re-running the audit — but the ARITHMETIC around it, every
 * line of which the audit showed is load-bearing:
 *
 *  - a rejected pair must null its slot in `goldToFinding`, not merely
 *    decrement a count, because every paired statistic indexes that vector;
 *  - silence about a pair is a rejection, since a CONFIRM that may reject
 *    everything cannot treat "unmentioned" as assent;
 *  - a CONFIRM that never ran must leave a stamp rather than pass MATCH's raw
 *    count off as a confirmed one;
 *  - `confirm: false` must reproduce the old grader exactly, which is what
 *    re-judging the archive for comparison depends on.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const judge = vi.fn<(model: string, system: string, user: string) => Promise<string>>();
vi.mock("./judge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./judge.js")>();
  return { ...actual, judge: (...args: Parameters<typeof actual.judge>) => judge(...args) };
});

const { gradeInternalRecall } = await import("./grade.js");

/** Two gold issues, two findings — indices are what the assertions are about. */
const gold = [
  { description: "the nonce age is never checked against the max-age constant" },
  { description: "the archived-status populations differ between session types" },
] as Parameters<typeof gradeInternalRecall>[0]["gold"];
const findings = [
  { description: "nonce expiry is enforced only by the browser cookie maxAge" },
  { description: "nonce max-age constant is verified correctly enforced" },
];

/** MATCH credits both golds: finding 0 → gold 0, finding 1 → gold 1. */
const bothMatched = JSON.stringify({
  matches: [
    { finding: 0, gold: 0 },
    { finding: 1, gold: 1 },
  ],
});

beforeEach(() => judge.mockReset());

describe("gradeInternalRecall CONFIRM", () => {
  it("drops a rejected pair from the vector, not just from the count", async () => {
    judge
      .mockResolvedValueOnce(bothMatched)
      .mockResolvedValueOnce(JSON.stringify({ pairs: [{ pair: 0, asserts: true }, { pair: 1, asserts: false }] }));

    const g = await gradeInternalRecall({ gold, findings, judgeModel: "anthropic/x" });

    expect(g?.matched).toBe(1);
    expect(g?.matchedPreConfirm).toBe(2);
    // Gold 1's slot is cleared — a paired statistic reading `internalGold[1]`
    // must see the miss, which a count alone would hide.
    expect(g?.goldToFinding).toEqual([0, null]);
    expect(g?.confirmRejected).toEqual([{ gold: 1, finding: 1 }]);
    expect(g?.confirmUngraded).toBeUndefined();
  });

  it("treats a pair the reply never mentions as unconfirmed", async () => {
    judge
      .mockResolvedValueOnce(bothMatched)
      .mockResolvedValueOnce(JSON.stringify({ pairs: [{ pair: 0, asserts: true }] }));

    const g = await gradeInternalRecall({ gold, findings, judgeModel: "anthropic/x" });

    expect(g?.matched).toBe(1);
    expect(g?.goldToFinding).toEqual([0, null]);
  });

  it("rejects everything when the confirm pass says so", async () => {
    judge
      .mockResolvedValueOnce(bothMatched)
      .mockResolvedValueOnce(JSON.stringify({ pairs: [] }));

    const g = await gradeInternalRecall({ gold, findings, judgeModel: "anthropic/x" });

    expect(g?.matched).toBe(0);
    expect(g?.matchedPreConfirm).toBe(2);
    expect(g?.goldToFinding).toEqual([null, null]);
    // Distinct from a judge failure: measured zero, not ungraded.
    expect(g?.error).toBeUndefined();
    expect(g?.confirmUngraded).toBeUndefined();
  });

  it("stamps an unparseable confirm reply and keeps MATCH's raw count", async () => {
    judge.mockResolvedValueOnce(bothMatched).mockResolvedValue("not json");

    const g = await gradeInternalRecall({ gold, findings, judgeModel: "anthropic/x" });

    expect(g?.matched).toBe(2);
    expect(g?.goldToFinding).toEqual([0, 1]);
    expect(g?.confirmUngraded).toMatch(/confirm/);
    // No pre-confirm field: nothing was confirmed, so nothing may read as it.
    expect(g?.matchedPreConfirm).toBeUndefined();
  });

  it("reproduces the pre-confirm grader under `confirm: false`", async () => {
    judge.mockResolvedValueOnce(bothMatched);

    const g = await gradeInternalRecall({ gold, findings, judgeModel: "anthropic/x", confirm: false });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(g).toEqual({ goldToFinding: [0, 1], matched: 2 });
  });

  it("spends nothing on a confirm pass when MATCH credited nothing", async () => {
    judge.mockResolvedValueOnce(JSON.stringify({ matches: [] }));

    const g = await gradeInternalRecall({ gold, findings, judgeModel: "anthropic/x" });

    expect(judge).toHaveBeenCalledTimes(1);
    expect(g?.matched).toBe(0);
  });
});
