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
 *
 * **Whether to RENDER the control is a different question from whether it can
 * narrow anything**, and conflating the two hid the one affordance that fixes
 * the common case. The control used to appear only once real grants resolved,
 * so somebody who had just created a team and granted it repos saw nothing —
 * no state, no explanation, and no way to re-ask short of waiting out the 60
 * minute TTL (and even then twice, since `visibleRepos` is
 * stale-while-revalidate: the first load after expiry still serves the stale
 * answer).
 *
 * So the gate is `offered` — the operator's `teamVisibility` switch — and the
 * unresolved states render explanatory and retryable instead of vanishing.
 * That gate is deliberately the same condition the server already applies:
 * `resync()` short-circuits on `config.enabled` before touching GitHub, so the
 * only state where the control could not possibly work is the one state where
 * it is not drawn.
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
   * Whether the control is worth rendering at all — i.e. the operator turned
   * `teamVisibility` ON. This, and not "did we resolve grants", is the gate:
   * the operator's switch is the one authority, and it is the only condition a
   * resync can never change (`resync()` checks `config.enabled` first and
   * returns fail-open without touching GitHub, so a control offered here would
   * be a guaranteed no-op).
   */
  offered: boolean;
  /**
   * Whether a real filter exists — the server resolved team grants covering at
   * least one managed repo, so switching to `mine` actually narrows something.
   */
  canScope: boolean;
  /**
   * Offered, but with nothing to filter to: the teams resolved empty, errored,
   * or blew the budget. The control renders in an explanatory, retryable state
   * rather than vanishing — see the toggle in `StatsHeader`.
   *
   * This used to be `scope === "mine" && allowed === null`, which was
   * unreachable: opting in requires the toggle, and the toggle was hidden in
   * exactly this state. So the branch written to explain a failed resolution
   * could only ever be reached by a resolution that succeeded and later broke.
   */
  degraded: boolean;
  /** Force a re-resolution server-side, then refresh every subscriber. */
  resync: () => Promise<void>;
}

export type RepoScope = "mine" | "all";

/**
 * What the scope control should be, given the server's answer.
 *
 *  - `hidden`     — the operator's `teamVisibility` switch is off (or we have
 *                   no answer yet). The ONLY state a re-sync cannot change:
 *                   `resync()` returns fail-open on `config.enabled` without
 *                   touching GitHub, so a control here is a guaranteed no-op.
 *  - `unresolved` — the feature is on but nothing resolved. Renders explanatory
 *                   and retryable; this is the state somebody lands in right
 *                   after creating a team, and the cached answer they need to
 *                   invalidate lives for an hour.
 *  - `available`  — real grants; the filter can narrow something.
 *
 * Pure and exported so the mapping is testable without React — it is the part
 * that rots, and `reason` has nine values.
 */
export type ScopeControlState = "hidden" | "unresolved" | "available";

export function scopeControlState(meta: MeRepos | null): ScopeControlState {
  // No answer yet: draw nothing rather than flashing "none" before the first
  // resolve lands.
  if (!meta) return "hidden";
  if (meta.reason === "disabled") return "hidden";
  // `repos` is never `[]` from the server — an empty result is a fail-open
  // `null` — but treating a stray empty array as "available" would render a
  // filter that blanks every view, so it is handled as unresolved either way.
  return meta.repos && meta.repos.length > 0 ? "available" : "unresolved";
}

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
  const control = scopeControlState(meta);

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
    offered: control !== "hidden",
    canScope: control === "available",
    degraded: control === "unresolved",
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
