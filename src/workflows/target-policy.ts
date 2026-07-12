/**
 * Per-target sandbox-workspace provisioning policy — which workflows key their
 * workspace by (repo, issue/PR) and how a re-run treats an existing checkout.
 *
 * This is a leaf module (no imports of the runner or the simple entrypoint) so
 * both `simple.ts` (taskId keying) and `runner.ts` (`gitSandboxAccessForWorkflow`)
 * can read the same source of truth without an import cycle. `simple.ts`
 * re-exports these for existing callers (e.g. `src/index.ts`).
 */

/**
 * Workflows whose workspace is keyed by **(repo, PR)** rather than per-run.
 * For these the taskId drops the run-id suffix so re-reviews of the same PR
 * (push → `synchronize`, cron PR-review fanout) reuse one sandbox dir — a
 * warm `node_modules` + an incremental `git fetch` instead of a fresh
 * 1.3G clone + full install each time, and N dirs/PR collapse to 1 (issue
 * #107, cutting the #106 churn at its source). Concurrency is held off by
 * the dispatcher's `isRunning(skill, triggerId)` guard plus
 * `runs.getByTrigger` reuse — two runs never share the dir live; the
 * cross-run refresh in `prePopulateWorkspace` resets it cleanly between them.
 * `build` is handled by `PER_TARGET_RECREATE_WORKFLOWS` instead — it must not
 * *refresh* a stale checkout (that would reset onto the old feature branch);
 * it recreates the workspace from the default branch.
 */
export const PER_TARGET_REUSE_WORKFLOWS = new Set(["pr-review", "pr-fix"]);

/**
 * Workflows whose per-target workspace is **recreated from the default branch**
 * on a fresh run rather than refreshed onto an existing feature branch. Like
 * `PER_TARGET_REUSE_WORKFLOWS`, these key the taskId by (repo, issue) only (no
 * run-id suffix) so a re-run lands on the same dir — but a *different*-run
 * marker triggers a delete + fresh clone off the default branch, not a
 * `git fetch`/reset of the (stale) feature branch. This makes an incomplete
 * `build` disposable: re-triggering it starts again from current `main`
 * (issue #153). A genuine *resume* of the same run (approval gate) still
 * preserves the workspace via the same-run marker — the architect's `plan.md`
 * survives. Concurrency is held off by the dispatcher's
 * `isRunning(skill, triggerId)` guard, so the delete only ever hits a leftover
 * from a finished/abandoned run.
 */
export const PER_TARGET_RECREATE_WORKFLOWS = new Set(["build"]);

/**
 * Workflows that synthesize their own `lastlight/N-slug` branch (which doesn't
 * exist on the remote at dispatch time) yet should still pre-populate the
 * sandbox: the agent's cwd becomes the repo root (no `git clone`/`cd`), and —
 * for the read-only `verify`/`qa-test` runs — server-mode artifacts the agent
 * writes to `.lastlight/<key>/` (e.g. browser-QA screenshots) land where
 * `serverArtifacts()` harvests them instead of being orphaned a level up.
 * `build` was the original member; verify/qa-test were added for the harvest
 * fix, and `demo` for the same reason (its `demo.mp4` is written under
 * `.lastlight/<key>/` and harvested into the Artifacts store). For a fresh
 * (issue-scoped) dispatch the dispatcher leaves `prePopulateBranch` unset and
 * the missing-branch fallback in `prePopulateWorkspace` clones the default
 * branch — correct for `build`/`demo`, which *create* the synth branch off the
 * default. But when the *same* workflow runs against an existing PR, the synth
 * `lastlight/<prNumber>-<title-slug>` name won't match the PR's real head ref
 * (named after the originating issue), so the fallback would clone the default
 * branch and test/demo code that lacks the PR — see
 * `PR_HEADREF_PREPOPULATE_WORKFLOWS`.
 */
export const PREPOPULATE_SYNTH_WORKFLOWS = new Set(["build", "verify", "qa-test", "demo"]);

/**
 * The subset of PR-scoped read workflows the dispatcher pins to the PR's *real*
 * head ref (via `getPullRequest(...).head.ref`) before pre-populating, instead
 * of letting them fall back to the synthesized `lastlight/N-<title-slug>` name.
 * Each of these is meaningful only against an existing PR, and the synth name
 * never matches the PR's actual branch (which is named after the originating
 * issue, e.g. `lastlight/14-…` for a PR #15). Without this pinning:
 *   - `qa-test` / `verify` QA the *base* branch and report the PR's feature
 *     missing — a false-negative result.
 *   - `demo`'s "after" collapses onto the default branch, matching "before".
 * `pr-fix` is handled separately (it plumbs `branch` through context for the
 * architect/executor to push to). See the resolution block in
 * `dispatchWorkflow` (src/index.ts).
 */
export const PR_HEADREF_PREPOPULATE_WORKFLOWS = new Set([
  "pr-review",
  "demo",
  "qa-test",
  "verify",
]);
