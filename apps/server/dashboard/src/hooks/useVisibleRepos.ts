import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type MeRepos } from "../api";

/**
 * Which repos to show the logged-in user (issue #169).
 *
 * `allowed === null` means **no filter** — show everything. That is the answer
 * for a password/Slack login, a deployment with the feature off, and every
 * failure mode including "the request blew up". Filtering here is declutter, not
 * access control: the server keeps returning global data on every list endpoint,
 * so the safe direction to fail is *more visible*, never less.
 */
export interface VisibleRepos {
  allowed: Set<string> | null;
  /** The raw server answer, for a "why am I seeing this?" hint. Null until loaded. */
  meta: MeRepos | null;
  loading: boolean;
  /** Force a re-resolution server-side, then refresh every subscriber. */
  resync: () => Promise<void>;
}

/**
 * One fetch for the whole app. The three filtered views (workflow runs,
 * sessions, repo-keyed stats) all mount independently, and this answer changes
 * about as often as somebody's GitHub team membership — so it is cached at
 * module scope and shared, rather than refetched per component.
 */
let cached: MeRepos | null = null;
let inFlight: Promise<MeRepos | null> | null = null;
const subscribers = new Set<(value: MeRepos | null) => void>();

const REFRESH_MS = 5 * 60_000;

function publish(value: MeRepos | null): void {
  cached = value;
  for (const notify of subscribers) notify(value);
}

async function load(force = false): Promise<MeRepos | null> {
  if (!force && inFlight) return inFlight;
  const pending = (force ? api.meReposResync() : api.meRepos())
    .then((value) => {
      publish(value);
      return value;
    })
    .catch(() => {
      // Can't ask ⇒ no filter. Synthesizing the sentinel here (rather than
      // leaving `cached` null and letting callers guess) keeps "unknown" and
      // "unfiltered" the same thing everywhere downstream.
      const fallback: MeRepos = {
        repos: null,
        synced: false,
        reason: "unavailable",
        teams: [],
        syncedAt: null,
      };
      publish(fallback);
      return fallback;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = pending;
  return pending;
}

export function useVisibleRepos(): VisibleRepos {
  const [meta, setMeta] = useState<MeRepos | null>(cached);

  useEffect(() => {
    subscribers.add(setMeta);
    if (cached === null) void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      subscribers.delete(setMeta);
      clearInterval(timer);
    };
  }, []);

  // Memoized on the resolved answer, not rebuilt per render. Callers put
  // `allowed` in `useEffect` / `useMemo` dependency arrays, and a fresh Set
  // identity every render would turn a 15s poll into a render loop.
  const allowed = useMemo(() => (meta?.repos ? new Set(meta.repos) : null), [meta]);
  const resync = useCallback(async () => {
    await load(true);
  }, []);

  return { allowed, meta, loading: meta === null, resync };
}

/**
 * Should a row naming `repo` be shown?
 *
 * Two things always pass: no filter at all, and a row with no repo. The second
 * matters more than it looks — a repo-less Slack chat thread or a cron run has
 * nothing to match against, and hiding those would silently drop whole
 * categories of work from the list.
 */
export function isRepoVisible(
  repo: string | null | undefined,
  allowed: Set<string> | null,
): boolean {
  if (!allowed) return true;
  if (!repo) return true;
  return allowed.has(repo);
}
