import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type MeRepos } from "../api";

/**
 * The optional "my teams' repos" filter (issue #169).
 *
 * **Opt-in, and off by default.** Everyone sees every managed repo until they
 * choose otherwise; choosing is remembered per browser. That inversion is the
 * whole design, and it is what makes the underlying rule safe to use: GitHub
 * team grants do NOT describe what a person can access — an org owner reaches
 * every repo with no team grant anywhere — so as a *default* this would hide
 * repos people work in daily. As a filter somebody switched on for themselves,
 * "the repos my teams own" is just a useful narrowing, and it is reversible in
 * one click.
 *
 * `allowed === null` means **no filter**. That is the answer whenever the user
 * hasn't opted in, and also for every failure path once they have — a
 * password/Slack login, the feature off, an over-budget resolution, a GitHub
 * error. The safe direction is always *more visible*, never less.
 */
export interface VisibleRepos {
  allowed: Set<string> | null;
  /** The raw server answer, for a "why am I seeing this?" hint. Null until loaded. */
  meta: MeRepos | null;
  loading: boolean;
  /** Current scope. `all` is the default; `mine` is opted into. */
  scope: RepoScope;
  setScope: (scope: RepoScope) => void;
  /**
   * Whether the filter is offerable — i.e. the server resolved real team grants
   * for this person. False for a password/Slack login, a deployment with the
   * feature off, and every fail-open case. The control is hidden entirely when
   * this is false: offering a filter that would narrow to nothing, or to
   * everything, is worse than not offering it.
   */
  canScope: boolean;
  /**
   * True when the user opted in but there is no filter to apply — the teams
   * couldn't be resolved. The control says so rather than silently behaving
   * like "all", which would look like the opt-in didn't take.
   */
  degraded: boolean;
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
    // Defaults to "all" — the filter is opt-in. Only an explicit, remembered
    // "mine" narrows anything.
    return localStorage.getItem(SCOPE_KEY) === "mine" ? "mine" : "all";
  } catch {
    // Private mode / storage disabled — unfiltered, like any other unset case.
    return "all";
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

  return {
    allowed,
    meta,
    loading: meta === null,
    scope,
    setScope,
    canScope,
    degraded: scope === "mine" && allowed === null,
    resync,
  };
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
