/**
 * CANDIDATE FINDER for the autonomy backstop cron (`pick-up-ready-issues`).
 *
 * Finds the open issues across `repos` that are sitting at the entry of an
 * `autonomy.stages` stage, in code (no LLM). The caller fans out one bounded
 * single-issue run of the stage's workflow per result, with `issueNumber` +
 * `labels` + `_stage` set (see `src/index.ts`) — the exact shape the
 * `issue.labeled` webhook produces, so the sweep and the webhook reach the
 * dispatch gate carrying the same facts.
 *
 * **It holds no policy.** It filters on exactly three things, all of which are
 * facts about the issue rather than decisions about it: the issue is OPEN, it
 * carries the stage's `enter` label, and it does NOT carry the stage's
 * `running` label. Autonomy allow-listing, the hold label, already-built,
 * run-in-flight and every budget ceiling belong to `resolveBuildTrigger`,
 * decided ONCE at the dispatch choke point that every route crosses
 * (`engine/build-gate.ts`). That split is the same one `review-discovery.ts`
 * documents, and for the same reason: this module, the webhook gate and the
 * `/api` path were otherwise three implementations of one policy, free to
 * disagree, in a feature whose entire safety argument rests on there being one.
 *
 * ── WHY THIS CANNOT BECOME THE 2026 SPEND LOOP ──────────────────────────────
 *
 * There is a recorded production incident behind this file: a cron gated on a
 * signal the work never wrote re-dispatched the same PRs every thirty minutes
 * at roughly $1.30/hour, while every run reported `succeeded`. A sweep that
 * re-offers work already in flight is that exact shape, so it is worth stating
 * plainly what stops it here. Three independent properties, and all three ship:
 *
 *  1. **The stage label is advanced HOST-SIDE, at DISPATCH, before the run
 *     starts** (`engine/build-gate.ts` → guard 2). This module queries
 *     `label:<enter>`, so a dispatched issue structurally leaves the candidate
 *     set — it is not filtered out, it was never a candidate.
 *  2. **`hasRunForTrigger` is checked at the gate regardless** (guard 3). That
 *     is a fact in our own database, written before any sandbox starts, so it
 *     survives a failed label write and even a run that crashed in phase one.
 *  3. **Budget ceilings** (`autonomy.budget`) bound the blast radius if 1 and 2
 *     both fail, and every refusal is visible in the `cron_runs` ledger's
 *     `dispatched` count.
 *
 * ── AND THE `running` EXCLUSION, WHICH IS PART OF PROPERTY 1 ────────────────
 *
 * `advanceStage` is BEST-EFFORT and never throws — deliberately, because the
 * labels are the projection and the run row is the fact, so a GitHub outage
 * must not block a dispatch. The consequence is a real partial state: if the
 * ADD of `running` succeeds and the REMOVE of `enter` fails, the issue carries
 * BOTH labels. A sweep querying only `label:<enter>` would then re-pick an
 * issue that is actively building, and property 1 would have silently degraded
 * to property 2 — still safe, but no longer structural, and the degradation
 * would be invisible.
 *
 * Excluding the `running` label costs nothing (the labels are already on the
 * listing response — no second call) and keeps property 1 intact through a
 * partial advance. It is not a substitute for any of the three above.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * An issue stranded in `running` after a crash is invisible to this sweep, on
 * purpose. A stalled build is exactly the thing a human should see, the
 * terminal observer moves failed runs to the stage's `on_failure` label anyway,
 * and any future stale-reaper needs its own attempt cap and its own cron rather
 * than a quiet widening of this query.
 */

import { getAutonomyConfig } from "../config/config.js";

/** The subset of the harness GitHub client this needs — keeps it fake-able. */
export interface IssueDiscoveryClient {
  listOpenIssuesByLabel(
    owner: string,
    repo: string,
    label: string,
    opts?: { maxPages?: number },
  ): Promise<Array<{ number: number; title: string; labels: string[]; createdAt: string }>>;
}

export interface IssueCandidate {
  /** `owner/repo` full name — the shape `dispatchWorkflow` expects in `context.repo`. */
  repo: string;
  issueNumber: number;
  title: string;
  /**
   * The issue's CURRENT labels. Carried because the dispatch gate reads them —
   * the hold check and the budget-comment de-duplication are both label reads —
   * and re-fetching them there would be a second call answering a question this
   * listing already answered.
   */
  labels: string[];
  /**
   * Which `autonomy.stages` stage this issue is sitting at the entry of.
   *
   * Not policy and not a filter: it is the candidate's IDENTITY. The gate is
   * keyed on the stage (it is what names the workflow, the labels and the
   * gates) and fails CLOSED on a stage it cannot resolve, so a candidate that
   * could not say which stage it entered would be undispatchable. The webhook
   * route carries the same value on `_stage`, resolved by `stageForLabel()`.
   */
  stage: string;
}

export interface IssueDiscoverOptions {
  log?: (msg: string) => void;
  /**
   * Cap the candidates offered per repo per tick, so one busy repo can't spin
   * hundreds of dispatches at once. Oldest-first, so the cap is stable across
   * ticks rather than starving the same tail every time.
   *
   * It caps candidates OFFERED, not runs dispatched — the same distinction
   * `review-discovery.ts` draws. A candidate the gate then refuses (on hold,
   * already built, over quota) is a cheap gate skip rather than a run, and the
   * runs that do start queue against the global admission cap
   * (`concurrency.maxWorkflows`) rather than against anything here. Default 25.
   */
  maxPerRepo?: number;
  /**
   * Page cap threaded to the listing call. Bounds one repo's contribution to a
   * tick's rate-limit spend; 3 × 100 = 300 open issues carrying the entry
   * label, which a repo reaching is a queue somebody should look at rather than
   * a page count to raise.
   */
  maxPages?: number;
}

const DEFAULT_MAX_PER_REPO = 25;

export async function discoverIssuesReadyForAgent(
  repos: string[],
  gh: IssueDiscoveryClient,
  opts: IssueDiscoverOptions = {},
): Promise<IssueCandidate[]> {
  const maxPerRepo = opts.maxPerRepo ?? DEFAULT_MAX_PER_REPO;
  // The label names come from config, never from constants here: an operator
  // may rename any stage label, and a hardcoded `ready-for-agent` would then
  // sweep for a label nothing writes — a backstop that reports success and
  // finds nothing forever.
  const stages = Object.entries(getAutonomyConfig().stages);
  const out: IssueCandidate[] = [];

  if (!stages.length) return out;

  for (const full of repos) {
    const [owner, repo] = full.split("/");
    if (!owner || !repo) {
      opts.log?.(`[issue-discovery] skipping malformed repo "${full}"`);
      continue;
    }

    // Keyed by issue number so an issue carrying two stages' entry labels is
    // offered ONCE, at the first stage in config order. That is a labelling or
    // config accident either way, and of the two possible answers — one
    // dispatch or two concurrent builds on one issue — only one of them is
    // cheap to be wrong about.
    const perRepo = new Map<number, IssueCandidate>();

    for (const [stageName, stage] of stages) {
      if (!stage.enter) continue;

      let open: Awaited<ReturnType<IssueDiscoveryClient["listOpenIssuesByLabel"]>>;
      try {
        open = await gh.listOpenIssuesByLabel(owner, repo, stage.enter, { maxPages: opts.maxPages });
      } catch (err) {
        // Per-repo failure is logged and skipped, never fatal, so one
        // inaccessible repo doesn't sink the sweep.
        opts.log?.(`[issue-discovery] ${full}: listing \`${stage.enter}\` issues failed — ${String(err)}`);
        continue;
      }

      for (const issue of open) {
        // The partial-advance exclusion (see the module header). Both labels
        // present means the dispatch-time advance added `running` and failed to
        // remove `enter`, so this issue is already building.
        if (stage.running && issue.labels.includes(stage.running)) continue;
        if (perRepo.has(issue.number)) continue;
        perRepo.set(issue.number, {
          repo: full,
          issueNumber: issue.number,
          title: issue.title,
          labels: issue.labels,
          stage: stageName,
        });
      }
    }

    const candidates = [...perRepo.values()]
      // Oldest first — deterministic and fair. Issue numbers are monotonic per
      // repo, so they order by creation without re-reading `createdAt`.
      .sort((a, b) => a.issueNumber - b.issueNumber)
      .slice(0, maxPerRepo);
    out.push(...candidates);
  }

  return out;
}
