/**
 * Multi-round re-review cases (issue #429) — the node-free half: the case
 * contract (`planRounds`), the per-round counts read off a round's artifacts,
 * and the roll-ups the scorecard and the dashboard both show.
 *
 * Node-free on purpose (no `node:*`, no `lastlight-code-facts` import), so the
 * dashboard bundles this exact file — the same rule `review-metrics.ts` and
 * `phase-replay.ts` follow. The git/artifact/oracle half is `rereview-node.ts`.
 *
 * What a round measures, and why each is its own number:
 *
 * - `lateDiscovery` — a POSTED inline comment of round k ≥ 2 whose anchored
 *   lines all existed, unchanged, at the previous round's head: a point the
 *   last review could have raised, which restarts the author's loop. The
 *   issue's headline metric (46% of later-round comments on nearform PRs).
 *   Judged per LINE with code-facts' `anchorDelta`, not per unit — a $0 replay
 *   of lastlight#424 put 12/16 later comments in changed/affected units but
 *   15/16 on lines unchanged since the round before.
 * - `converged` / `alreadyRaised` — what the pipeline WITHHELD for those two
 *   reasons (`disposition.json`); the mechanism's own account of itself.
 * - cumulative gold recall — each gold credited once, by whichever round's
 *   posted review first matched it. Withholding late discoveries must not cost
 *   gold a chained review would otherwise have found at some round.
 */
import type { InstanceResult, RereviewResult, RereviewRound, ReviewRoundSeed } from "./schema.js";

const REAL_SHA = /^[0-9a-f]{40}$/i;

/**
 * A case's review rounds, validated — or `null` for a case that runs once
 * (no `rounds`, or a single round, which IS the single-round case and must
 * run byte-identically to it). Throws on a malformed declaration: a chained
 * case that silently ran one round would report a re-review it never did.
 */
export function planRounds(inst: {
  instance_id: string;
  rounds?: ReviewRoundSeed[];
  pr?: {
    head_commit: string;
    reviews?: { from_round?: number }[];
    review_comments?: { from_round?: number }[];
    issue_comments?: { from_round?: number }[];
  };
}): ReviewRoundSeed[] | null {
  const rounds = inst.rounds;
  if (!rounds || rounds.length <= 1) {
    if (rounds?.length === 1 && inst.pr && rounds[0]!.head_commit !== inst.pr.head_commit) {
      throw new Error(`${inst.instance_id}: rounds[0].head_commit must equal pr.head_commit (the last round is the scored head)`);
    }
    return null;
  }
  if (!inst.pr) throw new Error(`${inst.instance_id}: \`rounds\` is a pr-review field and needs \`pr\``);
  rounds.forEach((r, i) => {
    if (!REAL_SHA.test(r.head_commit ?? "")) {
      throw new Error(`${inst.instance_id}: rounds[${i}].head_commit must be a full 40-hex SHA (got ${JSON.stringify(r.head_commit)})`);
    }
  });
  const last = rounds[rounds.length - 1]!;
  if (last.head_commit !== inst.pr.head_commit) {
    throw new Error(
      `${inst.instance_id}: the last round's head_commit (${last.head_commit.slice(0, 12)}) must equal pr.head_commit (${inst.pr.head_commit.slice(0, 12)}) — the last round is the scored head`,
    );
  }
  // A seeded item held for a round the chain never reaches would silently
  // vanish from the scored round's discussion.
  for (const field of ["reviews", "review_comments", "issue_comments"] as const) {
    (inst.pr[field] ?? []).forEach((item, i) => {
      const r = item.from_round;
      if (r !== undefined && !(Number.isInteger(r) && r >= 1 && r <= rounds.length)) {
        throw new Error(`${inst.instance_id}: pr.${field}[${i}].from_round must be an integer in 1..${rounds.length} (got ${JSON.stringify(r)})`);
      }
    });
  }
  return rounds;
}

/** One `disposition.json` row, the fields this module reads. */
export interface DispositionRowLike {
  tier?: string;
  reason?: string | null;
  finding?: { lateDiscovery?: boolean };
}

/** Tier counts and the three #429 reasons, off one round's `disposition.json`. */
export function dispositionCounts(rows: readonly DispositionRowLike[]): Pick<RereviewRound, "tiers" | "converged" | "alreadyRaised" | "lateLabelled"> {
  const tiers: Partial<Record<"inline" | "body" | "internal", number>> = {};
  let converged = 0;
  let alreadyRaised = 0;
  let lateLabelled = 0;
  for (const r of rows) {
    if (r.tier === "inline" || r.tier === "body" || r.tier === "internal") tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
    if (r.reason === "converged") converged++;
    if (r.reason === "already-raised") alreadyRaised++;
    if (r.finding?.lateDiscovery === true && (r.tier === "inline" || r.tier === "body")) lateLabelled++;
  }
  return { tiers, converged, alreadyRaised, lateLabelled };
}

/** Units by `delta` — absent when no unit carries one (a first review). */
export function deltaCounts(units: readonly { delta?: string | null }[]): RereviewRound["delta"] | undefined {
  const out: NonNullable<RereviewRound["delta"]> = {};
  let any = false;
  for (const u of units) {
    if (u.delta === "new" || u.delta === "changed" || u.delta === "affected" || u.delta === "unchanged") {
      out[u.delta] = (out[u.delta] ?? 0) + 1;
      any = true;
    }
  }
  return any ? out : undefined;
}

/** The ledger's findings by status. */
export function ledgerCounts(ledger: { findings?: readonly { status?: string }[] } | null | undefined): RereviewRound["ledger"] | undefined {
  if (!ledger?.findings) return undefined;
  const out: NonNullable<RereviewRound["ledger"]> = {};
  for (const f of ledger.findings) {
    if (f.status === "open" || f.status === "withheld" || f.status === "addressed" || f.status === "resolved") out[f.status] = (out[f.status] ?? 0) + 1;
  }
  return out;
}

/**
 * `review-coverage.json` (or post-review's compacted scratch copy of it),
 * compacted again to what a round row shows. `null` for anything that is not
 * a version-1 coverage record.
 */
export function coverageSummary(raw: unknown): RereviewRound["coverage"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const c = raw as Record<string, unknown>;
  if (c.version !== 1) return undefined;
  const inScope = (c.inScope ?? {}) as Record<string, unknown>;
  const carried = (c.carried ?? {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" ? v : 0);
  const pct = (v: unknown): number | null => (typeof v === "number" ? v : null);
  return {
    rereview: c.rereview === true,
    units: num(inScope.units),
    surveyedWeighted: pct(inScope.surveyedWeighted),
    investigatedWeighted: pct(inScope.investigatedWeighted),
    carriedUnits: num(carried.units),
    notInvestigated: Array.isArray(c.notInvestigated) ? c.notInvestigated.length : 0,
  };
}

/** The gold indices a grade's trace credits — `null` when the round was not graded. */
export function goldMatchedOf(trace: { gold?: { matchedFinding: number | null }[] } | undefined): number[] | null {
  if (!trace?.gold) return null;
  return trace.gold.flatMap((g, i) => (g.matchedFinding !== null && g.matchedFinding !== undefined ? [i] : []));
}

/**
 * Roll a case's rounds up. Late discoveries, convergence and posting are
 * summed over rounds ≥ 2 only — round 1 is a first review and has nothing to
 * be late against. Cumulative recall is the union of every graded round's
 * matched gold, over the case's gold; absent when no round was graded.
 */
export function rollupRereview(rounds: RereviewRound[], goldCount: number | undefined): RereviewResult {
  const later = rounds.filter((r) => r.round >= 2);
  const sumOpt = (xs: (number | undefined)[]): number | undefined =>
    xs.some((x) => x !== undefined) ? xs.reduce<number>((a, b) => a + (b ?? 0), 0) : undefined;
  const graded = rounds.filter((r) => r.goldMatched !== undefined);
  const union = new Set(graded.flatMap((r) => r.goldMatched!));
  const out: RereviewResult = {
    rounds,
    laterInlinePosted: later.reduce((n, r) => n + r.inlinePosted, 0),
    costUsd: rounds.reduce((n, r) => n + r.costUsd, 0),
  };
  const late = sumOpt(later.map((r) => r.lateDiscovery));
  if (late !== undefined) {
    out.lateDiscovery = late;
    out.lateDiscoveryOf = later.reduce((n, r) => n + (r.lateDiscovery !== undefined ? (r.lateDiscoveryOf ?? 0) : 0), 0);
  }
  const conv = sumOpt(later.map((r) => r.converged));
  if (conv !== undefined) out.converged = conv;
  const raised = sumOpt(later.map((r) => r.alreadyRaised));
  if (raised !== undefined) out.alreadyRaised = raised;
  if (graded.length && goldCount !== undefined) {
    out.cumulativeMatched = union.size;
    out.gold = goldCount;
    out.cumulativeRecall = goldCount > 0 ? union.size / goldCount : 1;
  }
  return out;
}

/** One arm's re-review totals across its multi-round cases — the dashboard panel's row. */
export interface RereviewArmSummary {
  model: string;
  cases: number;
  rounds: number;
  /** Σ late discoveries over Σ anchored later-round comments (measured rounds only). */
  lateDiscovery: number | null;
  lateDiscoveryOf: number;
  laterInlinePosted: number;
  converged: number | null;
  alreadyRaised: number | null;
  /** Σ cumulative matched over Σ gold, over graded cases. */
  cumulativeMatched: number | null;
  gold: number;
  costUsd: number;
}

/** Group a tier's results by arm and total their `rereview` blocks; arms with no multi-round case are omitted. */
export function summarizeRereview(results: readonly InstanceResult[]): RereviewArmSummary[] {
  const byArm = new Map<string, RereviewArmSummary>();
  for (const r of results) {
    const rr = r.rereview;
    if (!rr) continue;
    const s =
      byArm.get(r.model) ??
      byArm
        .set(r.model, {
          model: r.model,
          cases: 0,
          rounds: 0,
          lateDiscovery: null,
          lateDiscoveryOf: 0,
          laterInlinePosted: 0,
          converged: null,
          alreadyRaised: null,
          cumulativeMatched: null,
          gold: 0,
          costUsd: 0,
        })
        .get(r.model)!;
    s.cases++;
    s.rounds += rr.rounds.length;
    s.laterInlinePosted += rr.laterInlinePosted;
    s.costUsd += rr.costUsd;
    if (rr.lateDiscovery !== undefined) {
      s.lateDiscovery = (s.lateDiscovery ?? 0) + rr.lateDiscovery;
      s.lateDiscoveryOf += rr.lateDiscoveryOf ?? 0;
    }
    if (rr.converged !== undefined) s.converged = (s.converged ?? 0) + rr.converged;
    if (rr.alreadyRaised !== undefined) s.alreadyRaised = (s.alreadyRaised ?? 0) + rr.alreadyRaised;
    if (rr.cumulativeMatched !== undefined) {
      s.cumulativeMatched = (s.cumulativeMatched ?? 0) + rr.cumulativeMatched;
      s.gold += rr.gold ?? 0;
    }
  }
  return [...byArm.values()];
}

/** GitHub's review `state` for a submitted review's `event` — what `lastBotReview.state` carries. */
export function reviewStateOf(event: string): string {
  switch (event) {
    case "APPROVE":
      return "APPROVED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "COMMENT":
      return "COMMENTED";
    default:
      return "PENDING";
  }
}
