import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type MeRepos } from "../api";

/**
 * Which repos to show the logged-in user (issue #169).
 *
 * `allowed === null` means **no filter** — show everything. That is the answer
 * for a password/Slack login, a deployment with the feature off, every failure
 * mode including "the request blew up", and whenever the user has chosen the
 * `all` scope. Filtering here is declutter, not access control: the server
 * still returns global data on every list endpoint, so the safe direction to
 * fail is *more visible*, never less.
 */
export interface VisibleRepos {
  allowed: Set<string> | null;
  /** The raw server answer, for a "why am I seeing this?" hint. Null until loaded. */
  meta: MeRepos | null;
  loading: boolean;
  /** Current scope. `all` means the user explicitly opted out of narrowing. */
  scope: RepoScope;
  setScope: (scope: RepoScope) => void;
  /**
   * Whether narrowing is even possible — i.e. the server resolved real team
   * grants for this person. False for a password/Slack login, a deployment
   * with the feature off, and every fail-open case. The scope control is
   * hidden entirely when this is false: offering "my repos / all repos" to
   * somebody we can't scope would be a switch that does nothing.
   */
  canScope: boolean;
  /** Force a re-resolution server-side, then refresh every subscriber. */
  resync: () => Promise<void>;
}

export type RepoScope = "mine" | "all";

const SCOPE_KEY = "lastlight-repo-scope";

/**
 * One fetch for the whole app. The filtered views all mount independently, and
 * this answer changes about as often as somebody's GitHub team membership — so
 * it is cached at module scope and shared, rather than refetched per component.
 * The chosen scope lives here too, so flipping it updates every view at once.
 */
let cached: MeRepos | null = null;
let inFlight: Promise<MeRepos | null> | null = null;
let scope: RepoScope = readStoredScope();
const subscribers = new Set<() => void>();

const REFRESH_MS = 5 * 60_000;

function readStoredScope(): RepoScope {
  try {
    return localStorage.getItem(SCOPE_KEY) === "all" ? "all" : "mine";
  } catch {
    // Private mode / storage disabled — default to the narrowed view.
    return "mine";
  }
}

function notify(): void {
  for (const fn of subscribers) fn();
}

function publish(value: MeRepos | null): void {
  cached = value;
  notify();
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
  const [, forceRender] = useState(0);

  useEffect(() => {
    const rerender = () => forceRender((n) => n + 1);
    subscribers.add(rerender);
    if (cached === null) void load();
    const timer = setInterval(() => void load(), REFRESH_MS);
    return () => {
      subscribers.delete(rerender);
      clearInterval(timer);
    };
  }, []);

  const meta = cached;
  const canScope = Boolean(meta?.repos && meta.repos.length > 0);

  // Memoized on the resolved answer + scope, not rebuilt per render. Callers
  // put `allowed` in `useEffect` / `useMemo` dependency arrays, and a fresh Set
  // identity every render would turn a 15s poll into a render loop.
  const allowed = useMemo(
    () => (scope === "mine" && meta?.repos ? new Set(meta.repos) : null),
    [meta, scope],
  );

  const setScope = useCallback((next: RepoScope) => {
    scope = next;
    try {
      localStorage.setItem(SCOPE_KEY, next);
    } catch {
      // Storage unavailable — the choice just won't survive a reload.
    }
    notify();
  }, []);

  const resync = useCallback(async () => {
    await load(true);
  }, []);

  return { allowed, meta, loading: meta === null, scope, setScope, canScope, resync };
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

/**
 * The `repos` query-param value for a server-side scope, or undefined for "no
 * scope". Used by the run lists so they ask for exactly the rows they render
 * instead of over-fetching and narrowing in the browser.
 */
export function repoScopeParam(allowed: Set<string> | null): string[] | undefined {
  if (!allowed || allowed.size === 0) return undefined;
  return [...allowed];
}
