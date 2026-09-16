/**
 * The board's live-item cache — what stops a browser poll becoming a GitHub
 * bill.
 *
 * Modelled on `src/config/repo-config.ts`: a module-level cache, a TTL, a
 * `force` escape hatch, degrade-to-last-good, and a `resetBoardCacheForTests()`
 * that matches the convention. What it adds over that one is the two properties
 * a per-request dashboard read needs and a per-dispatch config read did not.
 *
 * **Single-flight per OWNER batch.** N dashboards refreshing at once cost ONE
 * GraphQL document, because the second caller awaits the first's in-flight
 * promise instead of starting its own. Keyed on the owner rather than the repo
 * because `GitHubClient.listOpenBoardItems` batches by owner — that is where
 * the installation token, and therefore the request, lives.
 *
 * **Stale-while-revalidate.** A cached answer is served IMMEDIATELY and the
 * refresh runs behind the request. This is the property that matters most: a
 * 20 s poll that blocked on GitHub would turn every slow GitHub minute into a
 * stalled dashboard, and worse, would hold the refresh open long enough for the
 * next poll to start another. Only a repo with NO last-good answer is waited
 * on — there is nothing to serve for it. The same shape
 * `TeamVisibilityResolver.visibleRepos` uses.
 *
 * **Per-owner exponential backoff.** GraphQL `search` is subject to GitHub's
 * SECONDARY rate limits, which are not the documented point budget and carry no
 * warning. A throttled owner is left alone for a growing window rather than
 * retried on the next poll, which is how a rate-limited board stops making
 * things worse for the harness's own work.
 *
 * The highest-value freshness lever is NOT a shorter TTL — it is
 * {@link invalidateBoard}, which a later slice wires to the `issue.labeled`
 * webhook so a human moving a card sees it move.
 */

import type { GitHubClient, BoardItem } from "../engine/github/github.js";
import { logger } from "../logging/logger.js";

const log = logger("board");

/**
 * How long a repo's items are trusted. Two minutes, against a dashboard that
 * polls at twenty seconds: the poll is then served from memory five times out
 * of six, and the GitHub cost is a function of the TTL and the repo count
 * alone — never of how many tabs are open.
 */
export const BOARD_TTL_MS = 120_000;

/**
 * Most often `?refresh=1` may actually force one repo. A refresh button held
 * down, or a client that re-fetches on every render, must not be able to turn
 * the TTL off.
 */
export const BOARD_FORCE_THROTTLE_MS = 10_000;

/**
 * First backoff window after a throttle; doubles per consecutive failure.
 *
 * It starts ABOVE the TTL, deliberately. A backoff shorter than — or equal to —
 * {@link BOARD_TTL_MS} can never bind: the read it would have refused is the
 * read the cache was going to serve anyway, so the first poll past the TTL goes
 * straight back to the throttled owner. Anything at or under the TTL here is a
 * backoff that exists only in the code.
 */
const BACKOFF_BASE_MS = BOARD_TTL_MS * 2;
const BACKOFF_MAX_MS = 15 * 60_000;

interface RepoEntry {
  items: BoardItem[];
  /**
   * Epoch ms of the last ATTEMPT, successful or not — what the TTL is measured
   * against. Split from `fetchedAt` for the reason `repo-config.ts` splits
   * `checkedAt` out: a repo whose fetch FAILED still has to wait out the TTL
   * before being tried again. Measuring the TTL against the last success
   * instead would leave a single 404ing repo re-requesting its owner's whole
   * batch on every poll — six times the intended rate, from the one repo that
   * is never going to answer.
   */
  checkedAt: number;
  /** Epoch ms the items were last known TRUE. Never advanced by a failure. */
  fetchedAt: number;
  /** Set when the last attempt failed; the items (if any) are the last good ones. */
  error?: string;
  /** Epoch ms the items stopped being refreshable — only while `error` is set. */
  staleSince?: number;
  /** Epoch ms of the last honoured `force`. */
  forcedAt?: number;
  /** The items came from the REST fallback, so they are lossy. */
  fallback?: boolean;
}

const cache = new Map<string, RepoEntry>();
const inflight = new Map<string, Promise<void>>();
const backoff = new Map<string, { until: number; failures: number }>();

export interface BoardItemsResult {
  items: BoardItem[];
  degraded: Array<{ repo: string; error: string; staleSince?: string }>;
}

export interface BoardItemsOptions {
  github: GitHubClient;
  /** Bypass the TTL, subject to {@link BOARD_FORCE_THROTTLE_MS}. */
  force?: boolean;
}

/**
 * Every open item across `repos` (qualified `owner/repo`), from cache where it
 * is fresh and from GitHub where it is not.
 *
 * Never throws: a repo the fetch could not answer for contributes a `degraded`
 * entry and whatever last-good items it has.
 */
export async function getBoardItems(
  repos: string[],
  opts: BoardItemsOptions,
): Promise<BoardItemsResult> {
  const now = Date.now();
  const wanted = [...new Set(repos.filter((r) => r.includes("/")))];

  const byOwner = new Map<string, string[]>();
  for (const repo of wanted) {
    const owner = repo.slice(0, repo.indexOf("/"));
    const list = byOwner.get(owner) ?? [];
    list.push(repo);
    byOwner.set(owner, list);
  }

  const waits: Promise<void>[] = [];
  for (const [owner, ownerRepos] of byOwner) {
    const stale = ownerRepos.filter((repo) => needsFetch(repo, now, opts.force === true));
    if (stale.length === 0) continue;

    const blocked = backoff.get(owner);
    if (blocked && now < blocked.until) {
      log.debug("board fetch skipped — owner is backing off", {
        owner,
        untilMs: blocked.until - now,
      });
      continue;
    }

    if (opts.force) for (const repo of stale) markForced(repo, now);
    const refresh = refreshOwner(owner, stale, opts.github);
    // Wait ONLY for repos we have nothing at all to serve for. Everything else
    // gets the cached answer now and the fresh one on the next poll.
    if (stale.some((repo) => !cache.has(repo))) waits.push(refresh);
  }

  if (waits.length > 0) await Promise.all(waits);

  const items: BoardItem[] = [];
  const degraded: BoardItemsResult["degraded"] = [];
  for (const repo of wanted) {
    const entry = cache.get(repo);
    if (!entry) {
      degraded.push({ repo, error: "No data for this repo yet." });
      continue;
    }
    items.push(...entry.items);
    if (entry.error) {
      degraded.push({
        repo,
        error: entry.error,
        staleSince: entry.staleSince ? new Date(entry.staleSince).toISOString() : undefined,
      });
    }
  }
  return { items, degraded };
}

/**
 * How many times the cached GitHub answer has CHANGED.
 *
 * The board's SSE stream folds this into its signature so a dashboard can be
 * told "refetch" without the server rendering a board per client per tick. It
 * means the CONTENT changed — deliberately not "something was invalidated",
 * which is a different and much noisier claim.
 *
 * That distinction is why {@link lastRendered} exists. `invalidateBoard`
 * DELETES the entry, so a refresh afterwards has no cached copy left to compare
 * against and would look like a change every time — and since every
 * board-relevant webhook invalidates, that would push twice per delivery and
 * wake every open tab for a label nothing on the board renders. Keeping the
 * last rendered fingerprint outside the cache, so it survives invalidation, is
 * what makes "push on change" true rather than aspirational.
 */
let revision = 0;

/**
 * The last fingerprint each repo was seen to RENDER as, surviving cache
 * invalidation. See {@link revision} for why it is not held on the entry.
 */
const lastRendered = new Map<string, string>();

/** Record what a repo now renders as, moving {@link revision} only on a change. */
function noteRendered(repo: string, signature: string): void {
  if (lastRendered.get(repo) === signature) return;
  lastRendered.set(repo, signature);
  revision++;
}

/** A repo whose read failed renders as its degraded self, whatever the message. */
const DEGRADED = "!degraded";

/** The current cache revision — see {@link revision}. */
export function boardRevision(): number {
  return revision;
}

/**
 * What the board would RENDER for one repo, as a comparable string.
 *
 * Numbers and labels only: those are what decide which column a card sits in
 * and what it shows. A title edit is not worth waking every dashboard for, and
 * the next TTL read will carry it anyway.
 */
function fingerprint(items: readonly BoardItem[]): string {
  return items
    .map((item) => `${item.number}:${item.labels.map((l) => l.name).sort().join(",")}`)
    .sort()
    .join("|");
}

/**
 * Drop a repo's cached items (or every repo's, with no argument), so the next
 * read goes to GitHub.
 *
 * Exported for the `issue.labeled` webhook: a human moving a card should see it
 * move, and invalidating one repo is far cheaper than shortening the TTL for
 * all of them.
 */
export function invalidateBoard(repo?: string): void {
  // Deliberately does NOT move the revision. Forgetting an answer is not a
  // claim that the board changed — the next read is what discovers whether it
  // did, and `noteRendered` signals then. The webhook hook fires for every
  // board-relevant delivery on every managed repo, the vast majority of which
  // change nothing any dashboard is rendering.
  if (repo) cache.delete(repo);
  else cache.clear();
}

/** Test-only: clear the cache, the in-flight map, the backoff state and the revision. */
export function resetBoardCacheForTests(): void {
  cache.clear();
  inflight.clear();
  backoff.clear();
  lastRendered.clear();
  revision = 0;
}

/** Is this repo's entry missing, expired, or being legitimately forced? */
function needsFetch(repo: string, now: number, force: boolean): boolean {
  const entry = cache.get(repo);
  if (!entry) return true;
  if (force && now - (entry.forcedAt ?? 0) >= BOARD_FORCE_THROTTLE_MS) return true;
  return now - entry.checkedAt >= BOARD_TTL_MS;
}

function markForced(repo: string, now: number): void {
  const entry = cache.get(repo);
  if (entry) entry.forcedAt = now;
}

/**
 * One GitHub round trip for one owner, shared by every concurrent caller.
 *
 * The promise is registered BEFORE the first await, so a second caller in the
 * same tick finds it rather than starting a second document.
 */
function refreshOwner(owner: string, repos: string[], github: GitHubClient): Promise<void> {
  const existing = inflight.get(owner);
  if (existing) return existing;

  const run = (async () => {
    const bare = repos.map((repo) => repo.slice(repo.indexOf("/") + 1));
    try {
      const results = await github.listOpenBoardItems(owner, bare);
      const now = Date.now();
      let throttled = false;
      for (const repo of repos) {
        const result = results.get(repo);
        if (!result) {
          noteFailure(repo, "GitHub returned nothing for this repo.", now);
          continue;
        }
        if (result.throttled) throttled = true;
        if (result.error && result.items.length === 0) {
          noteFailure(repo, result.error, now);
          continue;
        }
        const prior = cache.get(repo);
        // A TTL refresh that returned the same board is the COMMON case, and
        // it is not news. Compared against `lastRendered`, not against `prior`,
        // because an invalidation just deleted the latter.
        noteRendered(repo, fingerprint(result.items));
        cache.set(repo, {
          items: result.items,
          checkedAt: now,
          fetchedAt: now,
          forcedAt: prior?.forcedAt,
          ...(result.error ? { error: result.error, staleSince: now } : {}),
          ...(result.fallback ? { fallback: true } : {}),
        });
      }
      if (throttled) noteThrottle(owner, now);
      else backoff.delete(owner);
    } catch (err: unknown) {
      // `listOpenBoardItems` is written not to throw, so reaching here means
      // something outside it did — no installation for the owner, most likely.
      const message = err instanceof Error ? err.message : String(err);
      const now = Date.now();
      log.warn("board refresh failed", { owner, err });
      for (const repo of repos) noteFailure(repo, message, now);
      noteThrottle(owner, now);
    } finally {
      inflight.delete(owner);
    }
  })();

  inflight.set(owner, run);
  return run;
}

/** Keep the last good items, record why they stopped refreshing. */
function noteFailure(repo: string, error: string, now: number): void {
  const prior = cache.get(repo);
  // Going degraded changes what the board renders (the `degraded` list), so it
  // is news exactly once — not on every failed retry afterwards.
  noteRendered(repo, DEGRADED);
  cache.set(repo, {
    items: prior?.items ?? [],
    // The attempt counts against the TTL even though it failed — see `checkedAt`.
    checkedAt: now,
    // Deliberately NOT advanced: `fetchedAt` is when the items were true, and
    // moving it on a failure would hide a stale board behind a fresh timestamp.
    fetchedAt: prior?.fetchedAt ?? 0,
    forcedAt: prior?.forcedAt,
    error,
    staleSince: prior?.staleSince ?? now,
  });
}

function noteThrottle(owner: string, now: number): void {
  const prior = backoff.get(owner);
  const failures = (prior?.failures ?? 0) + 1;
  const wait = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
  backoff.set(owner, { until: now + wait, failures });
  log.warn("backing off board reads for an owner", { owner, failures, waitMs: wait });
}
