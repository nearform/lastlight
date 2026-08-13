/**
 * The weekly repo digest — what happened in a repo, and what Last Light did
 * about it, posted to that repo's Slack channel.
 *
 * ## Why this is code and not a workflow
 *
 * Every other periodic report in the harness is an agent workflow, and both of
 * them (`repo-health`, `security-review`) write an excellent report that
 * reaches nobody: a repo-scoped cron run has no issue and no Slack thread, so
 * the runner's `postComment` callback is undefined and the output dies in an
 * `executions` row. Three structural facts say a digest cannot be fixed by
 * routing that output somewhere:
 *
 *   1. Half the interesting content — runs, failures, escalations, spend —
 *      lives in the harness's own SQLite, which a sandboxed phase cannot reach.
 *   2. There is no Slack tool in the sandbox, and `slack.com` is not on the
 *      egress allowlist, so an agent cannot post even if it knew what to say.
 *   3. A digest is arithmetic. Asking a model to count merged PRs buys
 *      plausible numbers instead of correct ones, at a sandbox per repo.
 *
 * So the facts are gathered here, in the harness process, from the GitHub API
 * and the state DB. The model gets exactly one job — turn those facts into a
 * sentence of English — and if it fails, the digest goes out without it.
 *
 * ## Two invariants
 *
 * **No channel, no post.** A repo with no channel configured is skipped
 * silently. This is what keeps a fresh install quiet: the feature ships on, and
 * does nothing, until somebody names a channel.
 *
 * **One repo's bad day costs only that repo.** Every per-repo step is wrapped;
 * a failure is logged and the loop continues.
 */

import type { StateDb } from "../state/db.js";
import type { GitHubClient, RepoActivityItem } from "../engine/github/github.js";
import type { DigestConfig } from "../config/config.js";
import { resolveRepoRunConfig } from "../workflows/simple.js";
import { resolveRepoChannel, type ChannelRoutingConfig } from "../notify/repo-channel.js";
import { renderDigest, type DigestFacts, type RepoFacts, type BotFacts } from "../notify/digest-blocks.js";
import { resolveCronRepos, CRON_GLOBALLY_ENABLED_KEY, CRON_NAME_KEY } from "./repo-crons.js";
import { callLlm, defaultFastModel } from "../engine/llm.js";
import { logger } from "../logging/logger.js";

const log = logger("repo-digest");

/** The slice of {@link GitHubClient} a digest needs — narrow, so tests need no mock of the rest. */
export interface DigestGitHubClient {
  listRepoActivitySince: GitHubClient["listRepoActivitySince"];
  listOpenPullRequests: GitHubClient["listOpenPullRequests"];
}

/** How a rendered digest reaches Slack. Injected so the tests assert on calls, not on Slack. */
export type DigestPoster = (channel: string, text: string, blocks: unknown[]) => Promise<void>;

export interface RepoDigestDeps {
  db: StateDb;
  github: DigestGitHubClient;
  /** The GitHub client the repo-config layer is fetched through. Null in chat-only mode. */
  configClient: GitHubClient | null;
  routing: ChannelRoutingConfig | undefined;
  config: DigestConfig;
  post: DigestPoster;
  /** Injectable for tests; defaults to the real one-shot LLM helper. */
  summarize?: (facts: DigestFacts) => Promise<string | undefined>;
  /** Injectable for deterministic tests. */
  now?: () => Date;
  /** The label a terminal skip applies. Digest surfaces these as "needs a human". */
  escalationLabel?: string;
}

/**
 * One tick. `context` is what the scheduler built — `repos` plus the two cron
 * control keys.
 */
export async function runRepoDigest(deps: RepoDigestDeps, context: Record<string, unknown>): Promise<void> {
  const rawRepos = context.repos;
  if (!Array.isArray(rawRepos)) {
    log.warn("Tick carried no repo list — nothing to digest");
    return;
  }
  const repos = rawRepos.filter((r): r is string => typeof r === "string" && !!r);

  // Per-repo cron participation. NOTHING upstream does this for a handler cron
  // — `dispatchCronWorkflow` is the workflow path — so a repo's
  // `crons.disable: [repo-digest]` is honoured only because of this call.
  const cron = typeof context[CRON_NAME_KEY] === "string" ? (context[CRON_NAME_KEY] as string) : undefined;
  let targets = repos;
  if (cron) {
    const resolution = await resolveCronRepos({
      cron,
      repos,
      // Absent means "on" — the manual "Run now" deliberately omits the key so
      // a globally-disabled digest can still be fired by hand.
      globallyEnabled: context[CRON_GLOBALLY_ENABLED_KEY] !== false,
    });
    targets = resolution.repos;
  }

  if (targets.length === 0) {
    log.debug("No repos participate in this tick", { cron });
    return;
  }

  const now = deps.now?.() ?? new Date();
  const since = new Date(now.getTime() - deps.config.windowDays * 24 * 60 * 60 * 1000);

  let posted = 0;
  const failed: string[] = [];
  for (const target of targets) {
    try {
      posted += (await digestOneRepo(deps, target, since, now)) ? 1 : 0;
    } catch (err: unknown) {
      failed.push(target);
      log.error("Digest failed for repo", { repo: target, err });
    }
  }
  log.info("Digest tick complete", { considered: targets.length, posted, failed: failed.length });

  // One repo's bad day must not cost the others their digest — hence the
  // per-repo catch above. But a tick that swallowed every failure and returned
  // normally would report SUCCESS, and the failures that matter here are not
  // per-repo accidents: a revoked bot token or a bot removed from its channels
  // fails every repo at once, silently, once a week. So the tick fails if any
  // repo did, AFTER the others have been served.
  //
  // Deliberately not conditioned on `posted === 0`: a repo with no channel is
  // skipped, not failed, so "considered 10, posted 0" is the correct and quiet
  // outcome for a deployment that has configured nothing.
  if (failed.length > 0) {
    throw new Error(
      `Digest failed for ${failed.length} of ${targets.length} repos (${failed.join(", ")}) — ` +
        `see the per-repo errors above. ${posted} posted.`,
    );
  }
}

/** @returns whether a digest was actually posted. */
async function digestOneRepo(
  deps: RepoDigestDeps,
  target: string,
  since: Date,
  now: Date,
): Promise<boolean> {
  const slash = target.indexOf("/");
  if (slash <= 0) {
    log.warn("Skipping malformed repo ref", { repo: target });
    return false;
  }
  const owner = target.slice(0, slash);
  const repo = target.slice(slash + 1);

  // Resolve the channel FIRST. Everything below costs GitHub requests and
  // possibly a model call; there is no point paying for a digest nobody will
  // read. `resolveRepoRunConfig` is the same seam every dispatch uses, so this
  // rides the existing TTL+ETag cache rather than adding a second fetch path.
  const { repoConfig } = await resolveRepoRunConfig("repo-digest", { repo: target }, { client: deps.configClient });
  const { channel, source } = resolveRepoChannel(target, deps.routing, repoConfig);
  if (!channel) {
    log.debug("No Slack channel for repo — skipping", { repo: target });
    return false;
  }

  const sinceIso = since.toISOString();
  const [activity, openPrs] = await Promise.all([
    deps.github.listRepoActivitySince(owner, repo, sinceIso),
    deps.github.listOpenPullRequests(owner, repo),
  ]);

  const facts: DigestFacts = {
    repo: target,
    since: sinceIso,
    until: now.toISOString(),
    windowDays: deps.config.windowDays,
    repoFacts: summarizeRepo(activity, openPrs, since, now, deps.config.maxItems, deps.escalationLabel),
    botFacts: summarizeBot(deps, owner, repo, sinceIso),
  };

  const narrative = deps.config.narrative ? await summarizeSafely(deps, facts) : undefined;
  const { text, blocks } = renderDigest(facts, narrative);

  await deps.post(channel, text, blocks);
  log.info("Posted digest", { repo: target, channel, channelSource: source, narrative: !!narrative });
  return true;
}

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/**
 * Turn the raw dated items into the counts a digest shows.
 *
 * The window arithmetic lives here rather than in the GitHub client because
 * `listRepoActivitySince` filters on `updated_at`: an issue opened months ago
 * and commented on yesterday is in that response, and counting it as "opened
 * this week" is the obvious wrong answer. Every count below therefore tests the
 * event's OWN timestamp against the window.
 */
export function summarizeRepo(
  activity: RepoActivityItem[],
  openPrs: Array<{ number: number; title: string; draft: boolean; labels: string[]; createdAt: string }>,
  since: Date,
  now: Date,
  maxItems: number,
  escalationLabel = "requires-human",
): RepoFacts {
  const inWindow = (iso: string | null): boolean => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return Number.isFinite(t) && t >= since.getTime() && t <= now.getTime();
  };

  const prs = activity.filter((i) => i.isPr);
  const issues = activity.filter((i) => !i.isPr);

  // "Awaiting review" excludes drafts, matching what every other surface in the
  // harness means by it (`skills/repo-health`, the review cron's discoverer).
  const awaiting = openPrs
    .filter((p) => !p.draft)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));

  const escalated = openPrs
    .filter((p) => p.labels.includes(escalationLabel))
    .slice(0, maxItems)
    .map((p) => ({ number: p.number, title: p.title }));

  return {
    prsOpened: prs.filter((p) => inWindow(p.createdAt)).length,
    prsMerged: prs.filter((p) => inWindow(p.mergedAt)).length,
    // Closed-not-merged is its own fact: a digest that folds it into "closed"
    // reads an abandoned PR as delivered work.
    prsClosedUnmerged: prs.filter((p) => !p.mergedAt && inWindow(p.closedAt)).length,
    issuesOpened: issues.filter((i) => inWindow(i.createdAt)).length,
    issuesClosed: issues.filter((i) => inWindow(i.closedAt)).length,
    openPrs: openPrs.length,
    awaitingReview: awaiting.length,
    oldestAwaiting: awaiting[0]
      ? {
          number: awaiting[0].number,
          title: awaiting[0].title,
          ageDays: Math.floor((now.getTime() - Date.parse(awaiting[0].createdAt)) / 86_400_000),
        }
      : undefined,
    escalated,
  };
}

/** The bot half — pure state-DB reads, no network. */
function summarizeBot(deps: RepoDigestDeps, owner: string, repo: string, sinceIso: string): BotFacts {
  const rows = deps.db.runs.summarizeRepoActivity(owner, repo, sinceIso);
  const cost = deps.db.executions.repoCostSince(owner, repo, sinceIso);

  const byWorkflow: Record<string, number> = {};
  let runs = 0;
  let failed = 0;
  for (const row of rows) {
    runs += row.count;
    byWorkflow[row.workflowName] = (byWorkflow[row.workflowName] ?? 0) + row.count;
    if (row.status === "failed") failed += row.count;
  }

  return { runs, failed, byWorkflow, costUsd: cost.costUsd, phases: cost.phases };
}

// ---------------------------------------------------------------------------
// Narrative
// ---------------------------------------------------------------------------

const NARRATIVE_SYSTEM = [
  "You write the one-sentence opening line of a weekly engineering digest for a single repository.",
  "",
  "You are given the week's facts as JSON. They are already correct — do NOT restate the numbers;",
  "the digest prints them directly underneath you. Your job is to say what the week MEANT:",
  "whether it was busy or quiet, whether the review queue is growing or shrinking, and whether",
  "anything needs a human's attention.",
  "",
  "Rules:",
  "- One or two sentences. No greeting, no sign-off, no bullet points, no headings.",
  "- Plain prose. No Slack formatting, no emoji.",
  "- If the week was uneventful, say so plainly in one short sentence.",
  "- Never invent a fact that is not in the JSON.",
].join("\n");

/**
 * The narrative is the ONLY part of a digest that can be wrong, so it is the
 * only part allowed to fail. A model error, a missing API key, a timeout — all
 * of them drop the sentence and keep the digest.
 */
async function summarizeSafely(deps: RepoDigestDeps, facts: DigestFacts): Promise<string | undefined> {
  try {
    if (deps.summarize) return await deps.summarize(facts);
    const model = defaultFastModel("digest");
    const text = await callLlm(model, NARRATIVE_SYSTEM, JSON.stringify(facts), { timeoutMs: 20_000 });
    const trimmed = text.trim();
    return trimmed || undefined;
  } catch (err: unknown) {
    log.warn("Narrative failed — posting the digest without it", { repo: facts.repo, err });
    return undefined;
  }
}
