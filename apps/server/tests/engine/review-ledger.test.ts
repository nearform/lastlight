/**
 * The PR's review ledger (issue #429): the fold one review makes, the
 * statuses it derives from structured signals, its bounds, and the three
 * projections — `prior-review.json`, the select prompt, the summary lines.
 * Mechanism only: no assertion reads prompt prose beyond the structural line
 * prefixes the summary grammar parses.
 */
import { describe, expect, it } from "vitest";

import {
  carriedOpen,
  coerceLedger,
  findingFingerprint,
  foldReviewLedger,
  MAX_LEDGER_FINDINGS,
  priorReviewOf,
  renderLedgerForSelect,
  renderLedgerStatus,
  type DispositionRow,
  type FoldInput,
  type ReviewLedger,
} from "#src/engine/review-ledger.js";
import { deriveReviewLedger } from "#src/engine/pr-state.js";
import type { WorkflowRun } from "#src/state/db.js";

const row = (tier: DispositionRow["tier"], path: string, code: string, title: string, extra: Partial<DispositionRow["finding"]> = {}, reason: string | null = null): DispositionRow => ({
  tier,
  reason,
  finding: { path, line: 10, existingCode: code, title, severity: "Minor", importance: "worth-mentioning", ...extra },
});

function fold(over: Partial<FoldInput>): ReviewLedger {
  return foldReviewLedger({
    prior: null,
    head: "h1",
    units: null,
    dispositions: [],
    excerptPresent: () => true,
    threads: null,
    bot: "last-light",
    now: "2026-10-01T00:00:00.000Z",
    ...over,
  });
}

describe("the finding fingerprint", () => {
  it("is the file and the quoted code, whitespace-normalised — never the title", () => {
    const a = findingFingerprint("src/a.ts", "  if (x) {\n    return 1;  \n", "Title A");
    expect(findingFingerprint("src/a.ts", "if (x) {\nreturn 1;", "A different title")).toBe(a);
    expect(findingFingerprint("src/b.ts", "if (x) {\nreturn 1;", "Title A")).not.toBe(a);
  });

  it("falls back to the title only when no code was quoted", () => {
    expect(findingFingerprint("src/a.ts", undefined, "Off-diff point")).toBe(findingFingerprint("src/a.ts", "", "  off-diff POINT "));
  });
});

describe("folding a review into the ledger", () => {
  it("opens what posted and records what was withheld, with its reason", () => {
    const l = fold({
      dispositions: [row("inline", "src/a.ts", "a()", "Posted"), row("internal", "src/a.ts", "b()", "Withheld", {}, "converged")],
    });
    expect(l.findings.map((f) => [f.title, f.status, f.tier, f.reason, f.foundAt])).toEqual([
      ["Posted", "open", "inline", null, "h1"],
      ["Withheld", "withheld", "internal", "converged", "h1"],
    ]);
    expect(l.rounds).toBe(1);
  });

  it("closes an open finding whose quoted code is gone, and drops it the round after", () => {
    const first = fold({ dispositions: [row("inline", "src/a.ts", "a()", "Gone soon")] });
    const second = fold({ prior: first, head: "h2", excerptPresent: () => false });
    expect(second.findings[0]).toMatchObject({ status: "addressed", closedAt: "h2" });
    expect(renderLedgerStatus(second)).toMatch(/^\*\*Addressed since the last review:\*\* Gone soon/);
    const third = fold({ prior: second, head: "h3" });
    expect(third.findings).toEqual([]);
  });

  it("keeps status when it cannot tell (no checkout)", () => {
    const first = fold({ dispositions: [row("inline", "src/a.ts", "a()", "Unknown")] });
    expect(fold({ prior: first, head: "h2", excerptPresent: () => null }).findings[0]!.status).toBe("open");
  });

  it("resolves an open finding whose bot thread a maintainer resolved — matched by file and title, never by a reply", () => {
    const first = fold({ dispositions: [row("inline", "src/a.ts", "a()", "Inverted guard")] });
    const thread = (author: string, body: string, isResolved: boolean) => ({
      path: "src/a.ts",
      isResolved,
      isOutdated: false,
      comments: [{ author, isBot: author === "last-light", body }],
    });
    const resolved = fold({ prior: first, head: "h2", threads: [thread("last-light", "**Inverted guard** — …", true)] });
    expect(resolved.findings[0]).toMatchObject({ status: "resolved", closedAt: "h2" });
    // A human's thread with the same words resolves nothing.
    const notOurs = fold({ prior: first, head: "h2", threads: [thread("alice", "Inverted guard", true)] });
    expect(notOurs.findings[0]!.status).toBe("open");
  });

  it("re-finding the same code refreshes the entry; a withheld one that posts is open from then on", () => {
    const first = fold({ dispositions: [row("internal", "src/a.ts", "a()", "Was withheld", {}, "body-budget")] });
    const second = fold({ prior: first, head: "h2", dispositions: [row("body", "src/a.ts", "a()", "Now posted", {}, "overflow")] });
    expect(second.findings).toHaveLength(1);
    expect(second.findings[0]).toMatchObject({ status: "open", tier: "body", reason: "overflow", foundAt: "h1", lastSeenAt: "h2", title: "Was withheld" });
  });

  it("replaces the units with this review's, and carries them when it cut none", () => {
    const first = fold({ units: [{ key: "a::f", contentSha: "1" }] });
    expect(fold({ prior: first, head: "h2", units: null }).units).toEqual([{ key: "a::f", contentSha: "1" }]);
    expect(fold({ prior: first, head: "h2", units: [{ key: "a::g", contentSha: "2" }] }).units).toEqual([{ key: "a::g", contentSha: "2" }]);
  });

  it("is bounded: withheld entries go before open ones, and the ledger says it was cut", () => {
    const many = Array.from({ length: MAX_LEDGER_FINDINGS + 10 }, (_, i) => row("internal", "src/a.ts", `w${i}()`, `w${i}`));
    const l = fold({ dispositions: [row("inline", "src/a.ts", "keep()", "Keep me", { importance: "nit" }), ...many] });
    expect(l.findings).toHaveLength(MAX_LEDGER_FINDINGS);
    expect(l.findings.some((f) => f.title === "Keep me")).toBe(true);
    expect(l.truncated).toBe(true);
  });
});

describe("the ledger's projections", () => {
  const ledger = fold({
    head: "h1",
    units: [{ key: "a::f", contentSha: "1" }],
    dispositions: [row("inline", "src/a.ts", "a()", "Posted"), row("internal", "src/a.ts", "b()", "Withheld", {}, "converged")],
  });
  const next = fold({ prior: ledger, head: "h2" });

  it("names only POSTED findings as still open, and only from earlier rounds", () => {
    expect(renderLedgerStatus(ledger)).toBe("");
    expect(renderLedgerStatus(next)).toBe("**Still open:** Posted (`src/a.ts`)");
    expect(carriedOpen(next).map((f) => f.title)).toEqual(["Posted"]);
  });

  it("lists posted and withheld findings apart for select", () => {
    const text = renderLedgerForSelect(next);
    expect(text.indexOf("Posted")).toBeLessThan(text.indexOf("Withheld"));
    expect(renderLedgerForSelect(null)).toBe("");
    expect(renderLedgerForSelect(fold({}))).toBe("");
  });

  it("writes prior-review.json from the units, and nothing without them", () => {
    expect(priorReviewOf(ledger)).toEqual({ version: 1, head: "h1", units: [{ key: "a::f", contentSha: "1" }] });
    expect(priorReviewOf(fold({}))).toBeNull();
    expect(priorReviewOf(null)).toBeNull();
  });

  it("reads back only a recognisable ledger, dropping malformed entries", () => {
    expect(coerceLedger({ version: 2, findings: [], units: [] })).toBeNull();
    expect(coerceLedger("nope")).toBeNull();
    const round = coerceLedger(JSON.parse(JSON.stringify({ ...next, findings: [...next.findings, { fp: 1 }] })));
    expect(round?.findings).toHaveLength(2);
  });
});

describe("deriveReviewLedger", () => {
  const ledger = fold({ dispositions: [row("inline", "src/a.ts", "a()", "Posted")] });
  const run = (scratch: Record<string, unknown> | null) => ({ scratch }) as unknown as WorkflowRun;

  it("takes the ledger the prior review folded, else the one it was dispatched with", () => {
    const older = fold({ head: "h0" });
    expect(deriveReviewLedger(run({ reviewLedger: ledger }), { reviewLedger: older })?.head).toBe("h1");
    expect(deriveReviewLedger(run(null), { reviewLedger: older })?.head).toBe("h0");
    expect(deriveReviewLedger(null, null)).toBeNull();
  });
});
