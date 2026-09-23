import { useSyncExternalStore, useCallback } from "react";

/**
 * Dead-simple hash router: the URL is `#/<tierKey>/<runId>/<view>` (all
 * optional). No dependency, works under a plain static file server (no history
 * rewrites).
 *
 * The third segment names an alternate view of the SAME run rather than a new
 * kind of entity, so a repeat-group link stays a deep link into the run it is
 * anchored on and every existing two-segment URL keeps working unchanged.
 */
export type RunViewName = "repeats";

/**
 * The reserved first segment for the micro-survey views — `#/micro-survey` for
 * the list, `#/micro-survey/<report-id>` for one report.
 *
 * It sits in the tier-key position holding something that is not a tier, which
 * is safe because it is also the literal directory name
 * `eval-results/micro-survey/`, and that directory holds loose report files
 * rather than run subdirs — so `buildIndex` never emits a tier with this key and
 * the two can never collide. Reusing the grammar rather than growing a fourth
 * segment keeps every existing link unchanged.
 */
export const MICRO_TIER_KEY = "micro-survey";

export interface Route {
  tierKey?: string;
  runId?: string;
  view?: RunViewName;
}

function parse(): Route {
  const hash = window.location.hash.replace(/^#\/?/, "");
  const [tierKey, runId, view] = hash.split("/").map((s) => (s ? decodeURIComponent(s) : undefined));
  return {
    tierKey: tierKey || undefined,
    runId: runId || undefined,
    view: view === "repeats" ? "repeats" : undefined,
  };
}

/** The parser, exposed for `router.test.ts` — the hash grammar is the one thing
 * here worth asserting, and it is not reachable through `useRoute` in a test. */
export const parseHashForTest = parse;

function subscribe(cb: () => void): () => void {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
}

let snapshot: Route = parse();
let snapshotHash = window.location.hash;
function getSnapshot(): Route {
  // useSyncExternalStore needs a stable reference between unchanged reads.
  if (window.location.hash !== snapshotHash) {
    snapshotHash = window.location.hash;
    snapshot = parse();
  }
  return snapshot;
}

export function navigate(tierKey?: string, runId?: string, view?: RunViewName): void {
  const parts = [tierKey, runId, view].filter(Boolean).map((s) => encodeURIComponent(s as string));
  window.location.hash = parts.length ? `/${parts.join("/")}` : "/";
}

export function useRoute(): Route {
  return useSyncExternalStore(subscribe, getSnapshot);
}

export function useNavigate(): (tierKey?: string, runId?: string, view?: RunViewName) => void {
  return useCallback(navigate, []);
}
