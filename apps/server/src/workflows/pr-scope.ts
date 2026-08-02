/**
 * Which workflows are PR-SCOPED — the span of the run lock (09 → S4), the
 * per-head-SHA dedup, escalation, and the resolved `PrState` snapshot.
 *
 * ## Why this is a workflow's own metadata
 *
 * This used to be a literal `new Set(["pr-fix", "dependabot-ci-fix",
 * "dependabot-pr-merge", "pr-review"])` in `engine/pr-state.ts`, while the
 * handlers those names stand for are operator-configurable through
 * `routes.github.*`. So an operator remapping `routes.github.pr_review` to a
 * forked workflow lost the ENTIRE gate for it — no run lock, no dedup, no
 * escalation, no snapshot — silently, with no warning anywhere (issue #256).
 * The failure is invisible precisely because everything the gate does is a
 * *refusal*: nothing is missing from a run's output when the lock stops
 * applying, right up until two agents push the same branch.
 *
 * Being PR-scoped is a fact about a workflow, not about the harness's opinion
 * of a name, so it is declared on the workflow (`pr_scoped: true`) and read
 * back off the loaded definitions. A forked or renamed workflow keeps its
 * behaviour by carrying its own metadata, and `validateAssets` warns when a
 * configured `routes.github.pr_*` target does not.
 *
 * ## Why the lock's span is EVERY PR-scoped workflow, not per family
 *
 * `db.executions.isRunning(handler, triggerId)` was supposed to be this guard
 * and is not: it keys on the WORKFLOW name while phase ledger rows are keyed
 * `"<workflow>:<phase>"`, and on the bare issue number while the ledger uses
 * `owner/repo#N`. So nothing has ever stopped an `@bot fix this` comment routed
 * to `pr-fix` running concurrently with a `fix-red-dependency-prs` dispatch of
 * `dependabot-ci-fix` — two agents, two clones of the same branch, both
 * pushing. It also closes the case where `dependabot-pr-merge` enables
 * auto-merge against a PR whose fix run is still in flight.
 *
 * ## Resolution
 *
 * Derived from the loader's merged layer stack (built-ins + the deployment
 * overlay) and memoised on `getAssetVersion()`, so an admin asset reload
 * re-derives it without a callback registry. The legacy names are UNIONED in
 * whenever the loader still has a workflow by that name: an overlay that forked
 * one of the four built-ins before this key existed keeps its gate, and gets a
 * one-line warning telling it to add the key. Nothing here throws — a loader
 * that cannot read its workflows falls back to the legacy names outright, which
 * is the direction that errs towards MORE gating.
 */

import { getAssetVersion, listAgentWorkflows } from "./loader.js";
import { logger } from "../logging/logger.js";

const log = logger("pr-scope");

/**
 * The four built-ins that were PR-scoped before `pr_scoped` existed.
 *
 * A compatibility floor, not the source of truth: a name here only counts when
 * the loader actually has a workflow by that name, so deleting or disabling one
 * removes it from the set as it always did.
 */
export const LEGACY_PR_SCOPED_NAMES: readonly string[] = [
  "pr-fix",
  "dependabot-ci-fix",
  "dependabot-pr-merge",
  "pr-review",
];

let cached: ReadonlySet<string> | null = null;
let cachedAtVersion = -1;
/** Names already warned about, so a per-dispatch read doesn't spam the log. */
const warned = new Set<string>();

/**
 * Every PR-scoped workflow, by name.
 *
 * Cheap to call — memoised per asset version, and every caller is on a dispatch
 * path that already resolves config.
 */
export function prScopedWorkflows(): ReadonlySet<string> {
  const version = getAssetVersion();
  if (cached && cachedAtVersion === version) return cached;

  let names: Set<string>;
  try {
    const defs = listAgentWorkflows();
    names = new Set(defs.filter((d) => d.pr_scoped === true).map((d) => d.name));
    for (const legacy of LEGACY_PR_SCOPED_NAMES) {
      const def = defs.find((d) => d.name === legacy);
      if (!def || def.pr_scoped === true) continue;
      // A fork that predates the key. Honour it — losing the run lock is far
      // worse than carrying a name we no longer strictly derive — and say so
      // once, naming the fix.
      names.add(legacy);
      if (!warned.has(legacy)) {
        warned.add(legacy);
        log.warn(
          "Workflow does not declare `pr_scoped: true` — treating it as PR-scoped " +
            "anyway (it always was), but add the key to its YAML; the compatibility " +
            "fallback only covers the four original built-ins",
          { workflow: legacy },
        );
      }
    }
  } catch (err: unknown) {
    log.warn("Could not read the workflow definitions — falling back to the built-in PR-scoped set", {
      err,
    });
    names = new Set(LEGACY_PR_SCOPED_NAMES);
  }

  cached = names;
  cachedAtVersion = version;
  return cached;
}

/** Does this workflow cross the PR-scoped dispatch gate? */
export function isPrScoped(workflowName: string): boolean {
  return prScopedWorkflows().has(workflowName);
}

/** Drop the memo. Tests only — production invalidates on `getAssetVersion()`. */
export function __resetPrScopeCacheForTest(): void {
  cached = null;
  cachedAtVersion = -1;
  warned.clear();
}
