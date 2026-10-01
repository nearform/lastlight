/**
 * Multi-round re-review cases (issue #429) — the AI-free mechanism: the case
 * contract, the snapshot a round is dispatched with, what the fake records
 * across rounds, the run store the ledger rides in, and the late-discovery
 * instrument. No model, no network; the one code-facts integration test runs
 * the built `lastlight-facts` CLI over a two-commit temp repo ($0).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";
import { LINE_HASH_CHARS, lineHash } from "lastlight-code-facts";
import { reviewLedgerContext, coerceLedger, foldReviewLedger, resolveReviewGitHubClient, type ReviewLedger } from "lastlight-core/evals";

import { startFakeGitHub } from "./fake-github.js";
import { buildPrState, caseHeadSha, PLACEHOLDER_HEAD_SHA, prContextPatch } from "./pr-context.js";
import { promptContext } from "./phase-replay-node.js";
import { readStoredRunContext, writeStoredRunContext } from "./phase-replay-context.js";
import {
  coverageSummary,
  deltaCounts,
  dispositionCounts,
  goldMatchedOf,
  ledgerCounts,
  planRounds,
  reviewStateOf,
  rollupRereview,
  summarizeRereview,
} from "./rereview.js";
import {
  carryForward,
  createRoundStore,
  cutUnits,
  judgeComments,
  outdatedResolver,
  priorReviewFromUnits,
  readFreshJson,
  roundScratch,
  snapshotMtimes,
  UnitsOracle,
  type RoundUnit,
} from "./rereview-node.js";
import { checkoutRound, injectRepoContext } from "./seed.js";
import { resolveFactsBin } from "./paths.js";
import type { InstanceResult, RereviewRound } from "./schema.js";

const tmp: string[] = [];
afterAll(() => {
  for (const d of tmp) rmSync(d, { recursive: true, force: true });
});
function tempDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmp.push(d);
  return d;
}
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" };
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
}
/** A repo with one commit per entry of `commits` (path → content, cumulative). */
function repoWith(commits: Record<string, string>[]): { dir: string; shas: string[] } {
  const dir = tempDir("rereview-repo-");
  git(dir, ["init", "-q", "-b", "main"]);
  const shas: string[] = [];
  for (const files of commits) {
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(join(dir, p, ".."), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
    git(dir, ["add", "-A"]);
    git(dir, ["commit", "-q", "-m", `c${shas.length}`]);
    shas.push(git(dir, ["rev-parse", "HEAD"]));
  }
  return { dir, shas };
}

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const pr = { number: 7, title: "t", body: "", base_ref: "main", head_ref: "feat", base_commit: A, head_commit: C };

function sampleLedger(head = "h1"): ReviewLedger {
  return foldReviewLedger({
    prior: null,
    head,
    units: [{ key: "src/a.ts::f", contentSha: "x" }],
    lines: { "src/a.ts": lineHash("const value = compute(input);") },
    dispositions: [
      { tier: "inline", reason: null, finding: { path: "src/a.ts", line: 2, existingCode: "const value = compute(input);", title: "Unchecked compute", importance: "must-fix" } },
    ],
    excerptPresent: () => true,
    threads: null,
    bot: "last-light",
  });
}

// ── the case contract ───────────────────────────────────────────────────────

describe("planRounds", () => {
  it("is null for a case that runs once — no rounds, or one round on the PR head", () => {
    expect(planRounds({ instance_id: "x", pr })).toBeNull();
    expect(planRounds({ instance_id: "x", pr, rounds: [{ head_commit: C }] })).toBeNull();
  });
  it("returns the ordered chain when the last round is the PR's head", () => {
    expect(planRounds({ instance_id: "x", pr, rounds: [{ head_commit: B }, { head_commit: C }] })?.map((r) => r.head_commit)).toEqual([B, C]);
  });
  it("refuses a chain whose last round is not the scored head, a short SHA, or no PR", () => {
    expect(() => planRounds({ instance_id: "x", pr, rounds: [{ head_commit: C }, { head_commit: B }] })).toThrow(/must equal pr.head_commit/);
    expect(() => planRounds({ instance_id: "x", pr, rounds: [{ head_commit: "1d60d667" }, { head_commit: C }] })).toThrow(/40-hex/);
    expect(() => planRounds({ instance_id: "x", rounds: [{ head_commit: B }, { head_commit: C }] })).toThrow(/needs `pr`/);
    expect(() => planRounds({ instance_id: "x", pr, rounds: [{ head_commit: B }] })).toThrow(/must equal pr.head_commit/);
  });
});

// ── the snapshot ────────────────────────────────────────────────────────────

describe("PR snapshot — head SHA and the re-review fields", () => {
  const args = { repo: "acme/widget", prNumber: 7, title: "t", body: "b", branch: "feat" };

  it("carries the PR's real head instead of the placeholder", () => {
    expect(buildPrState({ ...args, headSha: C }).headSha).toBe(C);
    expect(buildPrState({ ...args, headSha: C, seed: { head_sha: B } }).headSha).toBe(B);
    expect(buildPrState(args).headSha).toBe(PLACEHOLDER_HEAD_SHA);
    expect(caseHeadSha({ pr: { head_commit: C } })).toBe(C);
    expect(caseHeadSha({ pr: { head_commit: "0".repeat(40) } })).toBe(PLACEHOLDER_HEAD_SHA);
    expect(caseHeadSha({ pr: { head_commit: C }, pr_state: { head_sha: B } })).toBe(B);
  });

  it("defaults every re-review field to the value that cannot suppress a review", () => {
    const s = buildPrState(args);
    expect([s.botReviewAtHead, s.lastBotReview, s.pathsSinceLastBotReview, s.prDiffUnchangedSinceLastReview, s.reviewLedger]).toEqual([null, null, null, null, null]);
  });

  it("maps the seeded re-review fields onto core's camelCase snapshot", () => {
    const ledger = sampleLedger();
    const s = buildPrState({
      ...args,
      seed: {
        last_bot_review: { state: "COMMENTED", sha: B, body: "earlier" },
        bot_review_at_head: { state: "APPROVED", submitted_at: "2026-01-01T01:00:00Z" },
        paths_since_last_bot_review: ["src/a.ts"],
        pr_diff_unchanged_since_last_review: false,
        review_ledger: JSON.parse(JSON.stringify(ledger)),
      },
    });
    expect(s.lastBotReview).toEqual({ state: "COMMENTED", sha: B, body: "earlier" });
    expect(s.botReviewAtHead).toEqual({ state: "APPROVED", submittedAt: "2026-01-01T01:00:00Z" });
    expect(s.pathsSinceLastBotReview).toEqual(["src/a.ts"]);
    expect(s.prDiffUnchangedSinceLastReview).toBe(false);
    expect(s.reviewLedger).toEqual(coerceLedger(ledger));
    // Through core's coercion: anything that is not a ledger reads as none.
    expect(buildPrState({ ...args, seed: { review_ledger: { version: 99 } } }).reviewLedger).toBeNull();
  });

  it("projects the ledger for select + units only with analysis on, and the snapshot only when asked", async () => {
    const seed = { review_ledger: sampleLedger() };
    const off = await prContextPatch({ ...args, seed });
    expect(off.prState).toBeUndefined();
    expect(off.priorLedger ?? "").toBe("");
    const on = await prContextPatch({ ...args, seed, review: { analysis: { enabled: true } }, snapshot: true, headSha: C });
    // The two keys are derived by core's runner from the snapshot, at run time.
    const derived = reviewLedgerContext(on.prState);
    expect(derived.priorLedger).toContain("Unchecked compute");
    expect(derived.priorReviewJson).toContain("src/a.ts::f");
    expect((on.prState as { reviewLedger: unknown; headSha: string }).headSha).toBe(C);
    expect((on.prState as { reviewLedger: ReviewLedger }).reviewLedger.findings[0]!.title).toBe("Unchecked compute");
  });
});

// ── the fake across rounds ──────────────────────────────────────────────────

describe("fake GitHub — rounds", () => {
  it("links inline comments to their review and commit, scopes grading to the round, and orders reviews in time", async () => {
    const fake = await startFakeGitHub({ owner: "acme", repo: "widgets", pulls: [{ ...pr, head_commit: B }] });
    try {
      const post = (body: unknown) =>
        fetch(`${fake.url}/repos/acme/widgets/pulls/7/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      await post({ event: "COMMENT", body: "r1", comments: [{ path: "src/a.ts", line: 4, start_line: 2, side: "RIGHT", body: "range" }] });
      const r1 = fake.submittedReviews(7);
      expect(r1).toHaveLength(1);
      expect(r1[0]!.commitId).toBe(B);
      expect(r1[0]!.comments[0]).toMatchObject({ path: "src/a.ts", line: 4, start_line: 2 });
      const t1 = r1[0]!.submittedAt!;

      fake.setHead(7, C);
      fake.advanceClock(60 * 60 * 1000);
      fake.startRound();
      expect(fake.submittedReviews(7)).toEqual([]);
      await post({ event: "APPROVE", body: "r2" });
      const r2 = fake.submittedReviews(7);
      expect(r2).toHaveLength(1);
      expect(r2[0]!.commitId).toBe(C);
      expect(Date.parse(r2[0]!.submittedAt!)).toBeGreaterThan(Date.parse(t1));
      expect(fake.submittedReviews(7, { all: true })).toHaveLength(2);
      expect(fake.submittedCount(7)).toBe(2);

      const comments = (await (await fetch(`${fake.url}/repos/acme/widgets/pulls/7/comments`)).json()) as Record<string, unknown>[];
      expect(comments[0]).toMatchObject({ commit_id: B, original_commit_id: B });
      expect(typeof comments[0]!.pull_request_review_id).toBe("number");
    } finally {
      await fake.close();
    }
  });

  it("computes isOutdated through the resolver, honours a seeded flag, and is never outdated by default", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widgets",
      pulls: [
        {
          ...pr,
          review_comments: [
            { user: "last-light[bot]", path: "src/a.ts", line: 2, body: "old", commit_id: B },
            { user: "human", path: "src/b.ts", line: 1, body: "forced", outdated: true },
          ],
        },
      ],
    });
    try {
      const gh = resolveReviewGitHubClient({ githubApiBaseUrl: fake.url });
      const outdated = async () => (await gh.getPullRequestDiscussion("acme", "widgets", 7)).threads.map((t) => t.isOutdated);
      expect(await outdated()).toEqual([false, true]);
      fake.setOutdatedResolver((a) => a.commitId === B && a.path === "src/a.ts");
      expect(await outdated()).toEqual([true, true]);
    } finally {
      await fake.close();
    }
  });
});

// ── the next round's dispatch ───────────────────────────────────────────────

describe("carryForward / outdatedResolver", () => {
  const { dir, shas } = repoWith([
    { "src/a.ts": "export function f(input: number) {\n  const value = compute(input);\n  return value;\n}\n" },
    { "src/a.ts": "export function f(input: number) {\n  const value = compute(input);\n  return value + 1;\n}\n" },
    { "src/b.ts": "export const g = 2;\n" },
  ]);
  const [base, h1, h2] = shas as [string, string, string];

  it("builds lastBotReview, the compare paths, the diff gate and the ledger from what round k left", () => {
    const ledger = sampleLedger(h1);
    const next = carryForward({
      repoDir: dir,
      baseCommit: base,
      prevHead: h1,
      nextHead: h2,
      reviews: [{ event: "REQUEST_CHANGES", body: "fix it", comments: [], commitId: h1, submittedAt: "2026-01-01T00:00:00Z" }],
      prev: { head_sha: h1 },
      scratch: { reviewLedger: ledger },
    });
    expect(next.head_sha).toBe(h2);
    expect(next.last_bot_review).toEqual({ state: "CHANGES_REQUESTED", sha: h1, body: "fix it" });
    expect(next.bot_review_at_head).toBeUndefined();
    expect(next.paths_since_last_bot_review).toEqual(["src/b.ts"]);
    expect(next.pr_diff_unchanged_since_last_review).toBe(false);
    expect(next.review_ledger).toEqual(coerceLedger(ledger));
  });

  it("carries the dispatched ledger and last review when the round posted nothing (core's fallback)", () => {
    const ledger = sampleLedger(h1);
    const next = carryForward({
      repoDir: dir,
      baseCommit: base,
      prevHead: h1,
      nextHead: h2,
      reviews: [],
      prev: { head_sha: h1, last_bot_review: { state: "COMMENTED", sha: base }, review_ledger: ledger },
      scratch: {},
    });
    expect(next.last_bot_review?.sha).toBe(base);
    expect(next.review_ledger).toEqual(coerceLedger(ledger));
  });

  it("marks a thread outdated when its anchored line is gone at the current head", () => {
    let head = h1;
    const isOutdated = outdatedResolver(dir, () => head);
    // `return value;` (line 3 at base) is rewritten at h1.
    expect(isOutdated({ path: "src/a.ts", line: 3, commitId: base })).toBe(true);
    expect(isOutdated({ path: "src/a.ts", line: 2, commitId: base })).toBe(false);
    expect(isOutdated({ path: "src/a.ts", line: 3, commitId: h1 })).toBe(false);
    head = h2;
    expect(isOutdated({ path: "src/a.ts", line: 3, commitId: h1 })).toBe(false);
    expect(isOutdated({ path: "src/a.ts", line: 3 })).toBe(false);
  });
});

describe("the run store a chained case dispatches through", () => {
  it("keeps each round's scratch apart, as post-review's mergeScratch writes it", async () => {
    const store = createRoundStore();
    await store.runs.mergeScratch("t:round-1", { reviewLedger: { a: 1 } });
    await store.runs.mergeScratch("t:round-1", { reviewCoverage: { b: 2 } });
    expect(await roundScratch(store, "t:round-1")).toEqual({ reviewLedger: { a: 1 }, reviewCoverage: { b: 2 } });
    expect(await roundScratch(store, "t:round-2")).toEqual({});
    // A fresh workflow id runs every phase (no dedup hit across rounds).
    expect(await store.executions.shouldRunPhase("pr-review:units", "acme/widgets#7", "t:round-2")).toBe("run");
  });
});

describe("artifact freshness in a reused workspace", () => {
  it("reads a file only when the round rewrote it", () => {
    const dir = tempDir("rereview-fresh-");
    writeFileSync(join(dir, "units.json"), '{"units":[1]}');
    utimesSync(join(dir, "units.json"), new Date(1_000_000), new Date(1_000_000));
    const before = snapshotMtimes(dir, ["units.json", "disposition.json"]);
    expect(readFreshJson(dir, "units.json", before)).toBeUndefined();
    expect(readFreshJson(dir, "disposition.json", before)).toBeUndefined();
    writeFileSync(join(dir, "units.json"), '{"units":[2]}');
    writeFileSync(join(dir, "disposition.json"), '{"findings":[]}');
    expect(readFreshJson(dir, "units.json", before)).toEqual({ units: [2] });
    expect(readFreshJson(dir, "disposition.json", before)).toEqual({ findings: [] });
  });
});

describe("checkoutRound + re-injected repo context", () => {
  function withOrigin(commits: Record<string, string>[]) {
    const r = repoWith(commits);
    const origin = tempDir("rereview-origin-");
    git(origin, ["init", "--bare", "-q"]);
    git(r.dir, ["remote", "add", "origin", `file://${origin}`]);
    git(r.dir, ["checkout", "-q", "-B", "feat", r.shas[0]!]);
    return { ...r, origin };
  }
  const count = (text: string) => text.split("lastlight-evals: injected repo context").length - 1;

  it("moves the head (and origin's branch), keeps untracked review state, and injects exactly one block", () => {
    const { dir, shas, origin } = withOrigin([{ "AGENTS.md": "# repo\n", "a.ts": "1\n" }, { "a.ts": "2\n" }]);
    mkdirSync(join(dir, ".lastlight", "pr-review"), { recursive: true });
    writeFileSync(join(dir, ".lastlight", "pr-review", "units.json"), "{}");
    injectRepoContext(dir, "be careful");
    checkoutRound(dir, "feat", shas[1]!);
    expect(git(dir, ["rev-parse", "HEAD"])).toBe(shas[1]);
    expect(git(origin, ["rev-parse", "refs/heads/feat"])).toBe(shas[1]);
    expect(readFileSync(join(dir, ".lastlight", "pr-review", "units.json"), "utf8")).toBe("{}");
    expect(count(readFileSync(join(dir, "AGENTS.md"), "utf8"))).toBe(0);
    injectRepoContext(dir, "be careful");
    expect(count(readFileSync(join(dir, "AGENTS.md"), "utf8"))).toBe(1);
  });

  it("does not stack blocks in a harness-created (untracked) AGENTS.md", () => {
    const { dir, shas } = withOrigin([{ "a.ts": "1\n" }, { "a.ts": "2\n" }]);
    injectRepoContext(dir, "be careful");
    checkoutRound(dir, "feat", shas[1]!);
    injectRepoContext(dir, "be careful");
    const text = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(count(text)).toBe(1);
    expect(text).toContain("be careful");
  });
});

// ── the instrument ──────────────────────────────────────────────────────────

describe("late discovery — the convergence gate's own test, per posted comment", () => {
  const unit = (over: Partial<RoundUnit>): RoundUnit => ({ id: "u1", kind: "symbol", file: "src/a.ts", symbol: "f", lines: [1, 4], key: "src/a.ts::f", contentSha: "x", ...over });
  const oldLines = ["export function f(input: number) {", "  const value = compute(input);", "  return value;", "}"];

  it("projects a head's units into the prior review the next round is judged against", () => {
    const prior = priorReviewFromUnits(
      [unit({ lineHashes: lineHash(oldLines[1]!) + lineHash(oldLines[2]!) }), unit({ id: "u1b", splitOf: "u1", lineHashes: lineHash(oldLines[2]!) })],
      "h1",
    );
    expect(prior.units).toEqual([{ key: "src/a.ts::f", contentSha: "x" }]);
    expect(prior.files!["src/a.ts"]).toHaveLength(2 * LINE_HASH_CHARS);
  });

  it("is `unchanged` only when every anchored line was already there", () => {
    const prior = priorReviewFromUnits([unit({ lineHashes: oldLines.map(lineHash).join("") })], "h1");
    const head = [...oldLines.slice(0, 2), "  if (value < 0) throw new Error('negative');", ...oldLines.slice(2)].join("\n");
    const v = judgeComments({
      comments: [{ path: "src/a.ts", line: 2 }, { path: "src/a.ts", line: 3 }, { path: "src/a.ts", start_line: 2, line: 3 }, { path: "src/a.ts" }],
      prior,
      units: [unit({ lines: [1, 5], delta: "changed" })],
      fileText: () => head,
    });
    expect(v.map((x) => x.verdict)).toEqual(["unchanged", "new", "new", null]);
    expect(v[0]!.unit).toEqual({ key: "src/a.ts::f", delta: "changed" });
    // A first review has nothing to be late against.
    expect(judgeComments({ comments: [{ path: "src/a.ts", line: 2 }], prior: null, units: [], fileText: () => head })[0]!.verdict).toBeNull();
  });
});

describe("round counts and roll-ups", () => {
  const round = (over: Partial<RereviewRound>): RereviewRound => ({
    round: 1,
    headSha: A,
    workflowSucceeded: true,
    inlinePosted: 0,
    costUsd: 0.5,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    ...over,
  });

  it("counts dispositions, deltas, ledger statuses and coverage", () => {
    expect(
      dispositionCounts([
        { tier: "inline", reason: null, finding: { lateDiscovery: true } },
        { tier: "internal", reason: "converged" },
        { tier: "internal", reason: "already-raised" },
        { tier: "body", reason: "cap" },
      ]),
    ).toEqual({ tiers: { inline: 1, internal: 2, body: 1 }, converged: 1, alreadyRaised: 1, lateLabelled: 1 });
    expect(deltaCounts([{ delta: "new" }, { delta: "unchanged" }, { delta: "unchanged" }, {}])).toEqual({ new: 1, unchanged: 2 });
    expect(deltaCounts([{}])).toBeUndefined();
    expect(ledgerCounts({ findings: [{ status: "open" }, { status: "withheld" }, { status: "open" }] })).toEqual({ open: 2, withheld: 1 });
    expect(coverageSummary({ version: 1, rereview: true, inScope: { units: 4, surveyedWeighted: 80, investigatedWeighted: 40.5 }, carried: { units: 3 }, notInvestigated: ["a", "b"] })).toEqual({
      rereview: true,
      units: 4,
      surveyedWeighted: 80,
      investigatedWeighted: 40.5,
      carriedUnits: 3,
      notInvestigated: 2,
    });
    expect(coverageSummary({ version: 2 })).toBeUndefined();
    expect(goldMatchedOf({ gold: [{ matchedFinding: 0 }, { matchedFinding: null }, { matchedFinding: 3 }] })).toEqual([0, 2]);
    expect(goldMatchedOf(undefined)).toBeNull();
    expect(reviewStateOf("APPROVE")).toBe("APPROVED");
  });

  it("sums late discoveries over rounds ≥ 2 and credits each gold once across rounds", () => {
    const rr = rollupRereview(
      [
        round({ round: 1, inlinePosted: 4, goldMatched: [0], converged: 0 }),
        round({ round: 2, inlinePosted: 3, lateDiscovery: 2, lateDiscoveryOf: 3, converged: 4, alreadyRaised: 1, goldMatched: [0, 2] }),
        round({ round: 3, inlinePosted: 1, lateDiscovery: 0, lateDiscoveryOf: 1, converged: 1, alreadyRaised: 0 }),
      ],
      4,
    );
    expect(rr).toMatchObject({ lateDiscovery: 2, lateDiscoveryOf: 4, converged: 5, alreadyRaised: 1, laterInlinePosted: 4, cumulativeMatched: 2, gold: 4, cumulativeRecall: 0.5, costUsd: 1.5 });
  });

  it("leaves unmeasured totals absent rather than zero", () => {
    const rr = rollupRereview([round({ round: 1 }), round({ round: 2, inlinePosted: 2 })], undefined);
    expect(rr.lateDiscovery).toBeUndefined();
    expect(rr.converged).toBeUndefined();
    expect(rr.cumulativeMatched).toBeUndefined();
  });

  it("totals an arm's chained cases for the dashboard, skipping single-round ones", () => {
    const res = (model: string, rereview?: InstanceResult["rereview"]): InstanceResult => ({
      instance_id: "x",
      model,
      workflowSucceeded: true,
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      phases: [],
      ...(rereview ? { rereview } : {}),
    });
    const rr = rollupRereview([round({ round: 1, goldMatched: [1] }), round({ round: 2, lateDiscovery: 1, lateDiscoveryOf: 2, converged: 0, goldMatched: [] })], 3);
    const out = summarizeRereview([res("arm-a", rr), res("arm-a", rr), res("arm-b")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ model: "arm-a", cases: 2, rounds: 4, lateDiscovery: 2, lateDiscoveryOf: 4, converged: 0, cumulativeMatched: 2, gold: 6, costUsd: 2 });
  });
});

// ── micro-select's stored context ───────────────────────────────────────────

describe("phase-replay stored run context", () => {
  it("round-trips the replayable keys beside the artifacts and feeds promptContext", () => {
    const trial = tempDir("rereview-trial-");
    writeStoredRunContext(trial, { priorDiscussion: "earlier talk", priorLedger: "- `a.ts:2` [must-fix] X", headSha: C, owner: "acme", empty: "" });
    const stored = readStoredRunContext(join(trial, "pr-review"));
    expect(stored).toEqual({ priorDiscussion: "earlier talk", priorLedger: "- `a.ts:2` [must-fix] X", headSha: C });
    const ctx = promptContext({ instance_id: "x", repo: "acme/widgets", pr: { ...pr, head_commit: B } } as never, stored);
    expect(ctx).toMatchObject({ priorDiscussion: "earlier talk", priorLedger: "- `a.ts:2` [must-fix] X", headSha: C });
    // A run recorded before the file existed renders exactly as before.
    expect(readStoredRunContext(join(tempDir("rereview-none-"), "pr-review"))).toEqual({});
    expect(promptContext({ instance_id: "x", repo: "acme/widgets", pr } as never)).not.toHaveProperty("priorLedger");
  });
});

// ── the oracle, end to end over the real CLI ($0) ──────────────────────────

const factsBin = resolveFactsBin();
describe.skipIf(!factsBin)("units oracle — code-facts over two heads", () => {
  it("cuts units at each head, deltas the second against the first, and flags a comment on old lines as late", () => {
    const { dir, shas } = repoWith([
      { "package.json": '{"name":"t","version":"1.0.0"}\n', "src/base.ts": "export const base = 1;\n" },
      {
        "src/a.ts":
          "export function alpha(input: number): number {\n  const doubled = input * 2;\n  const shifted = doubled + 10;\n  return shifted;\n}\n",
      },
      {
        "src/b.ts": "export function beta(name: string): string {\n  const greeting = `hello ${name}`;\n  return greeting.toUpperCase();\n}\n",
      },
    ]);
    const heads = [shas[1]!, shas[2]!];
    const oracle = new UnitsOracle({ repoDir: dir, base: shas[0]!, factsBin: factsBin! });
    const r1 = oracle.at(heads, 0);
    expect(r1.units.some((u) => u.key === "src/a.ts::alpha")).toBe(true);
    expect(r1.units.every((u) => u.delta === undefined)).toBe(true);
    const r2 = oracle.at(heads, 1);
    const byKey = new Map(r2.units.map((u) => [u.key, u]));
    expect(byKey.get("src/a.ts::alpha")?.delta).toBe("unchanged");
    expect(byKey.get("src/b.ts::beta")?.delta).toBe("new");
    const verdicts = judgeComments({
      comments: [{ path: "src/a.ts", line: 3 }, { path: "src/b.ts", line: 2 }],
      prior: oracle.priorFor(heads, 1),
      units: r2.units,
      fileText: (p) => git(dir, ["show", `${heads[1]}:${p}`]),
    });
    expect(verdicts.map((v) => v.verdict)).toEqual(["unchanged", "new"]);
    // The worktrees are gone; the checkout is untouched.
    expect(git(dir, ["worktree", "list"]).split("\n")).toHaveLength(1);
    // A single cut with no prior carries no delta at all.
    expect(cutUnits({ repoDir: dir, base: shas[0]!, head: heads[0]!, factsBin: factsBin! }).units.every((u) => u.delta === undefined)).toBe(true);
  }, 180_000);
});
