/**
 * Multi-round re-review cases (issue #429) — the Node half: the run store a
 * chained case dispatches through, what one round leaves for the next, the
 * artifacts a round is measured on, and the `units` oracle the $0 replay
 * (`scripts/rereview-delta-replay.ts`) and the harness share.
 *
 * ## How round k+1 learns what round k did
 *
 * Exactly as production: through the RUN. `post-review` folds the round's
 * dispositions into the review ledger it was dispatched with
 * (`ctx.prState.reviewLedger`) and writes the result with
 * `store.runs.mergeScratch(workflowId, { reviewLedger, reviewCoverage })`;
 * the next dispatch reads it back through core's `deriveReviewLedger(run,
 * priorState)`. A single-round eval calls `runWorkflow` with no store, so that
 * write is a no-op — a chained case therefore runs every round against the
 * engine's own `InMemoryStateStore` (`lastlight-workflow-engine/test-support`),
 * one workflow id per round, and reads the scratch back off it. Nothing of the
 * fold is re-implemented here.
 *
 * The other three snapshot fields a re-review dispatch resolves from GitHub —
 * `lastBotReview`, `pathsSinceLastBotReview`, `prDiffUnchangedSinceLastReview`
 * — come from the fake's record of what round k posted and from local git, the
 * same reads `resolvePrState` makes against the API.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { InMemoryStateStore } from "lastlight-workflow-engine/test-support";
import { anchorDelta, locateUnit, type PriorReview, type UnitDelta } from "lastlight-code-facts";
import { deriveReviewLedger, REVIEW_COVERAGE_SCRATCH_KEY, REVIEW_LEDGER_SCRATCH_KEY, type ReviewLedger } from "lastlight-core/evals";

import type { SubmittedReview, ThreadAnchor } from "./fake-github.js";
import type { PrStateSeed } from "./pr-context.js";
import { reviewStateOf } from "./rereview.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 * 1024 }).toString();
}

// ── the run store ───────────────────────────────────────────────────────────

/**
 * The store a chained case dispatches every round through. The engine's own
 * in-memory fake, plus `setTraceContext` — the one `StateDb` run method the
 * runner calls outside the engine port (best-effort telemetry bookkeeping).
 */
export function createRoundStore(): InMemoryStateStore {
  const store = new InMemoryStateStore();
  (store.runs as unknown as Record<string, unknown>).setTraceContext = async () => {};
  return store;
}

/** A round's run scratch, as the next dispatch reads it. */
export async function roundScratch(store: InMemoryStateStore, workflowId: string): Promise<Record<string, unknown>> {
  return ((await store.runs.getRun(workflowId))?.scratch ?? {}) as Record<string, unknown>;
}

/** The ledger post-review wrote to a round's scratch, if it wrote one. */
export function scratchLedger(scratch: Record<string, unknown>): unknown {
  return scratch[REVIEW_LEDGER_SCRATCH_KEY];
}

/** The coverage record post-review wrote beside it. */
export function scratchCoverage(scratch: Record<string, unknown>): unknown {
  return scratch[REVIEW_COVERAGE_SCRATCH_KEY];
}

// ── artifact freshness ─────────────────────────────────────────────────────

/**
 * The per-PR workspace is reused across rounds (production's semantics), so
 * `.lastlight/pr-review/` still holds the LAST round's files when a round
 * writes none. A round reads an artifact only if it changed during the round:
 * snapshot the mtimes before, compare after.
 */
export function snapshotMtimes(dir: string, names: readonly string[]): Map<string, number | null> {
  return new Map(names.map((n) => [n, mtimeOf(join(dir, n))]));
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

/** Parsed JSON of `dir/name` when it was (re)written since `before`; else `undefined`. */
export function readFreshJson(dir: string, name: string, before: Map<string, number | null>): unknown {
  const now = mtimeOf(join(dir, name));
  if (now === null || now === before.get(name)) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8"));
  } catch {
    return undefined;
  }
}

/** The artifacts a round is measured on. */
export const ROUND_ARTIFACTS = ["disposition.json", "units.json", "prior-review.json", "review-coverage.json", "findings.json"] as const;

// ── the next round's snapshot ───────────────────────────────────────────────

/** Paths changed between two commits (`git diff --name-only a b`); `null` when git cannot say. */
export function changedPathsBetween(repoDir: string, from: string, to: string): string[] | null {
  try {
    return git(repoDir, ["diff", "--name-only", from, to]).split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

/** sha1 of the PR's own three-dot diff at `head` (`base...head`) — the unchanged-diff gate's fingerprint. */
export function prDiffFingerprint(repoDir: string, base: string, head: string): string | null {
  try {
    return createHash("sha1").update(git(repoDir, ["diff", "--no-color", `${base}...${head}`])).digest("hex");
  } catch {
    return null;
  }
}

/**
 * The `pr_state` fields round k+1 is dispatched with, from what round k left:
 * the review it posted (the fake's record), the ledger its post-review folded
 * (its run's scratch, read through core's `deriveReviewLedger` exactly as a
 * dispatch reads the prior run), and local git for the two compare reads.
 */
export function carryForward(input: {
  repoDir: string;
  baseCommit: string;
  prevHead: string;
  nextHead: string;
  /** Reviews round k submitted, oldest first. */
  reviews: readonly SubmittedReview[];
  /** What round k was itself dispatched with — the fallbacks when it posted nothing. */
  prev: PrStateSeed;
  /** Round k's run scratch. */
  scratch: Record<string, unknown>;
}): PrStateSeed {
  const posted = input.reviews.at(-1);
  const last = posted
    ? { state: reviewStateOf(posted.event), sha: posted.commitId ?? input.prevHead, body: posted.body ?? null }
    : input.prev.last_bot_review;
  // `deriveReviewLedger(priorRun, priorState)`: the ledger round k FOLDED, else
  // the one it was dispatched with (a round that failed before posting changes
  // nothing). The persisted snapshot only needs the one field.
  const ledger: ReviewLedger | null = deriveReviewLedger(
    { scratch: input.scratch } as never,
    (input.prev.review_ledger ? { reviewLedger: input.prev.review_ledger } : null) as never,
  );
  const out: PrStateSeed = { head_sha: input.nextHead };
  if (last) {
    out.last_bot_review = { state: last.state, sha: last.sha, body: last.body ?? null };
    if (last.sha === input.nextHead) {
      out.bot_review_at_head = { state: last.state, submitted_at: posted?.submittedAt ?? null };
    } else {
      const paths = changedPathsBetween(input.repoDir, last.sha, input.nextHead);
      if (paths) out.paths_since_last_bot_review = paths;
      const a = prDiffFingerprint(input.repoDir, input.baseCommit, last.sha);
      const b = prDiffFingerprint(input.repoDir, input.baseCommit, input.nextHead);
      if (a !== null && b !== null) out.pr_diff_unchanged_since_last_review = a === b;
    }
  }
  if (ledger) out.review_ledger = ledger;
  return out;
}

// ── thread outdating ────────────────────────────────────────────────────────

/** A file's text at a commit, or `null`. */
export function fileAt(repoDir: string, sha: string, path: string): string | null {
  try {
    return git(repoDir, ["show", `${sha}:${path}`]);
  } catch {
    return null;
  }
}

/**
 * The fake's `isOutdated` for a chained case, best-effort and text-based: a
 * thread raised on an earlier commit is outdated at `head()` when a
 * non-blank line it was anchored on no longer appears in the file there.
 * GitHub's own rule follows the diff hunk, which a fake cannot reproduce;
 * "the code it quoted is gone" is the reading a re-review actually needs.
 */
export function outdatedResolver(repoDir: string, head: () => string): (anchor: ThreadAnchor) => boolean {
  const cache = new Map<string, string[] | null>();
  const lines = (sha: string, path: string): string[] | null => {
    const key = `${sha}:${path}`;
    if (!cache.has(key)) cache.set(key, fileAt(repoDir, sha, path)?.split("\n") ?? null);
    return cache.get(key)!;
  };
  return (a) => {
    const now = head();
    if (!a.commitId || a.commitId === now || a.line === undefined) return false;
    const then = lines(a.commitId, a.path);
    if (!then) return false;
    const anchored = then.slice((a.start_line ?? a.line) - 1, a.line).map((l) => l.trim()).filter(Boolean);
    if (!anchored.length) return false;
    const at = lines(now, a.path);
    if (!at) return true;
    const present = new Set(at.map((l) => l.trim()));
    return anchored.some((l) => !present.has(l));
  };
}

// ── units: the round's own, or the oracle's ────────────────────────────────

/** The `units.json` fields the re-review metrics read. */
export interface RoundUnit {
  id: string;
  kind: string;
  file: string | null;
  symbol: string | null;
  lines: [number, number] | null;
  splitOf?: string;
  key?: string;
  contentSha?: string | null;
  lineHashes?: string;
  delta?: UnitDelta;
}

/**
 * `prior-review.json` from one head's units — what a ledger written at that
 * head would project (`priorReviewOf`): each unit key once, and per file the
 * union of its units' line hashes. The same projection `post-review`'s
 * `readLedgerUnits` makes off `units.json`; kept here so the $0 replay needs no
 * server import.
 */
export function priorReviewFromUnits(units: readonly RoundUnit[], head: string | null): PriorReview {
  const keys = new Map<string, string | null>();
  const byFile = new Map<string, Set<string>>();
  for (const u of units) {
    if (typeof u.key === "string" && !keys.has(u.key)) keys.set(u.key, u.contentSha ?? null);
    if (typeof u.file === "string" && typeof u.lineHashes === "string") {
      const set = byFile.get(u.file) ?? byFile.set(u.file, new Set()).get(u.file)!;
      for (let i = 0; i + 8 <= u.lineHashes.length; i += 8) set.add(u.lineHashes.slice(i, i + 8));
    }
  }
  return {
    version: 1,
    head,
    units: [...keys].map(([key, contentSha]) => ({ key, contentSha })),
    files: Object.fromEntries([...byFile].map(([f, s]) => [f, [...s].join("")])),
  };
}

/** Where `cutUnits` finds the `lastlight-facts` CLI — `LASTLIGHT_FACTS_BIN`, or the caller's. */
export interface CutUnitsOptions {
  /** A checkout (or bare mirror) holding `base` and `head`. */
  repoDir: string;
  base: string;
  head: string;
  /** The prior review to take each unit's `delta` against; omit for a first review. */
  prior?: PriorReview | null;
  factsBin: string;
  /** Keep the artifacts here instead of a temp dir. */
  outDir?: string;
  timeoutMs?: number;
}

export interface CutUnitsResult {
  units: RoundUnit[];
  /** The document's own `coverage` / `degraded[]`, so a failed cut never reads as "no units". */
  coverage: string | null;
  degraded: string[];
  dir: string;
}

/**
 * The oracle: run code-facts' `all` then `units [--prior]` over `head`, in a
 * throwaway worktree, exactly as pr-review's `facts` and `units` phases do
 * (merge base, never the base tip). No model is called. `seed` is skipped: an
 * obligation never changes a unit's key, content hash, line hashes or delta.
 */
export function cutUnits(opts: CutUnitsOptions): CutUnitsResult {
  const dir = opts.outDir ?? mkdtempSync(join(tmpdir(), "rereview-units-"));
  mkdirSync(dir, { recursive: true });
  const wt = mkdtempSync(join(tmpdir(), "rereview-wt-"));
  rmSync(wt, { recursive: true, force: true });
  const timeout = opts.timeoutMs ?? 600_000;
  try {
    git(opts.repoDir, ["worktree", "add", "--quiet", "--detach", wt, opts.head]);
    const mergeBase = git(wt, ["merge-base", opts.base, "HEAD"]).trim();
    execFileSync(opts.factsBin, ["all", "--repo", wt, "--base", mergeBase, "--head", "HEAD", "--out", join(dir, "facts.json"), "--never-fail"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout,
      maxBuffer: 256 * 1024 * 1024,
    });
    const args = ["units", "--dir", dir, "--repo", wt, "--never-fail"];
    if (opts.prior) {
      writeFileSync(join(dir, "prior-review.json"), `${JSON.stringify(opts.prior)}\n`);
      args.push("--prior", join(dir, "prior-review.json"));
    } else {
      rmSync(join(dir, "prior-review.json"), { force: true });
    }
    execFileSync(opts.factsBin, args, { cwd: wt, stdio: ["ignore", "ignore", "pipe"], timeout, maxBuffer: 256 * 1024 * 1024 });
    const doc = JSON.parse(readFileSync(join(dir, "units.json"), "utf8")) as {
      units?: RoundUnit[];
      coverage?: string;
      degraded?: { extractor?: string; reason?: string }[];
    };
    return {
      units: doc.units ?? [],
      coverage: doc.coverage ?? null,
      degraded: (doc.degraded ?? []).map((d) => `${d.extractor ?? "?"}: ${d.reason ?? "?"}`),
      dir,
    };
  } finally {
    try {
      git(opts.repoDir, ["worktree", "remove", "--force", wt]);
    } catch {
      rmSync(wt, { recursive: true, force: true });
      try {
        git(opts.repoDir, ["worktree", "prune"]);
      } catch {
        /* best-effort */
      }
    }
  }
}

/**
 * A chain of oracle cuts over one case's heads, each against the one before
 * — cached per head, so a case with n rounds pays n cuts at most.
 */
export class UnitsOracle {
  private readonly cuts = new Map<string, CutUnitsResult>();
  constructor(
    private readonly opts: { repoDir: string; base: string; factsBin: string; root?: string },
  ) {}

  /** Units at `heads[i]`, with deltas against `heads[i-1]`'s (none for i = 0). */
  at(heads: readonly string[], i: number): CutUnitsResult {
    const head = heads[i]!;
    const key = `${i}:${head}`;
    const hit = this.cuts.get(key);
    if (hit) return hit;
    const prior = i > 0 ? priorReviewFromUnits(this.at(heads, i - 1).units, heads[i - 1]!) : null;
    const cut = cutUnits({
      repoDir: this.opts.repoDir,
      base: this.opts.base,
      head,
      prior,
      factsBin: this.opts.factsBin,
      ...(this.opts.root ? { outDir: join(this.opts.root, `round-${i + 1}`) } : {}),
    });
    this.cuts.set(key, cut);
    return cut;
  }

  /** The prior review round `i` is judged against: round i-1's units. */
  priorFor(heads: readonly string[], i: number): PriorReview | null {
    return i > 0 ? priorReviewFromUnits(this.at(heads, i - 1).units, heads[i - 1]!) : null;
  }
}

// ── late discovery ──────────────────────────────────────────────────────────

/** One posted (or real) comment to judge. */
export interface AnchoredComment {
  path: string;
  line?: number;
  start_line?: number;
}

export interface CommentVerdict extends AnchoredComment {
  /** `unchanged` ⇒ a late discovery; `new` ⇒ on code new since the prior review; `null` ⇒ no prior review / no anchor. */
  verdict: "new" | "unchanged" | null;
  unit: { key?: string; delta?: UnitDelta } | null;
  /** The anchored lines' text at the head, as judged. */
  anchor: string[];
}

/**
 * Judge each comment the way `sites --finalize`'s convergence gate judges a
 * finding: `anchorDelta(prior, path, <anchored lines at head>, <its unit's
 * delta>)`. `unchanged` = every non-trivial anchored line was already in the
 * prior review's lines for that file — a late discovery.
 */
export function judgeComments(input: {
  comments: readonly AnchoredComment[];
  prior: PriorReview | null;
  units: readonly RoundUnit[];
  /** The file's text at the round's head, or `null`. */
  fileText: (path: string) => string | null;
}): CommentVerdict[] {
  const textCache = new Map<string, string[] | null>();
  return input.comments.map((c) => {
    if (c.line === undefined) return { ...c, verdict: null, unit: null, anchor: [] };
    if (!textCache.has(c.path)) textCache.set(c.path, input.fileText(c.path)?.split("\n") ?? null);
    const lines = textCache.get(c.path);
    const anchor = lines ? lines.slice(Math.max(0, (c.start_line ?? c.line) - 1), c.line) : [];
    const unit = locateUnit(input.units, c.path, c.line);
    const verdict = anchorDelta(input.prior, c.path, anchor, unit?.delta);
    return { ...c, verdict, unit: unit ? { ...(unit.key ? { key: unit.key } : {}), ...(unit.delta ? { delta: unit.delta } : {}) } : null, anchor };
  });
}
