/**
 * Public API barrel for `lastlight-evals` (and any external harness that drives
 * Last Light's real workflows out of process).
 *
 * This is the ENTIRE supported surface for running a workflow against mocked
 * GitHub: the four workflow symbols the eval harness needs, plus the overlay
 * bootstrap helpers it reuses to scaffold a fresh evals/overlay repo.
 *
 * Consumers import from `"lastlight/evals"` (see the `exports` map in
 * package.json) — never deep `lastlight/dist/...` paths — so core's internal
 * file layout can change without breaking them.
 *
 * The mock seam is `ExecutorConfig.githubApiBaseUrl`: point it at an in-process
 * fake GitHub and every `github_*` tool call is redirected there. Approval
 * gates are inert when `runWorkflow` is called without a `db`/`approvalConfig`.
 */

// ── workflow driving ────────────────────────────────────────────────────────
export { getWorkflow, configureWorkflowAssets } from "lastlight-shared/workflow-loader";
export type { WorkflowAssetConfig } from "lastlight-shared/workflow-loader";
export { runWorkflow } from "./workflows/runner.js";
export type { RunnerCallbacks, WorkflowResult } from "./workflows/runner.js";
export type { ExecutorConfig } from "./engine/github/profiles.js";
export type { TemplateContext } from "./workflows/templates.js";

// ── per-repo config layer (issue #180) ──────────────────────────────────────
// A harness that wants to exercise a managed repo's own `.lastlight/` layer
// drives the same entry point `dispatchWorkflow` uses, then hands the result to
// `runWorkflow`'s repo-config parameter. `invalidateRepoLayer` is exported
// because the fetch is cached per repo with a ~60s TTL — an A/B across two
// arms in one process would otherwise reuse the first arm's layer.
export { resolveRepoRunConfig } from "./workflows/simple.js";
export type { RunRepoConfig, RepoRunConfigOptions } from "./workflows/simple.js";
export { invalidateRepoLayer } from "./config/repo-config.js";

// ── the PR state machine (issues #251, #252) ────────────────────────────────
//
// A harness driving a PR-scoped workflow (`pr-fix`, `dependabot-ci-fix`,
// `dependabot-pr-merge`, `pr-review`) has the same problem the repo-config
// block above solves: in production those workflows are dispatched, never
// called directly, and `dispatchWorkflow` resolves ONE `PrState` snapshot and
// projects it into the template context. Every variable the fix and merge
// prompts render — `{{ciSection}}`, `{{attempt}}`, `{{mayMerge}}`,
// `{{priorNotes}}`, `{{verifyScript}}` — comes from that projection.
//
// So a harness that builds its own context by hand runs those workflows blind:
// not a smaller version of production, a DIFFERENT one, with every `{{#if}}`
// guard taking the empty branch. `renderContext` is exported so it can supply
// the snapshot (which it must fabricate — there is no real PR) and let CORE do
// the projection, exactly as `resolveRepoRunConfig` above lets core do the
// per-repo merge. The alternative is a second copy of the projection in the
// harness, free to drift from what ships.
//
// `mayMerge` and the marker parsers ride along because they are the other half
// of the same job: the merge gate's verdict is projected by `renderContext`,
// and what a run CONCLUDED is a marker line in the phase output, which only
// these parsers read correctly (`lastMarkerLine` recognises `<TAG>:`, not a
// bare mention — see `fix-markers.ts`).
export { renderContext, mayMerge } from "./engine/pr-decisions.js";
export type { PrState } from "./engine/pr-state.js";
export type { CiFailureReport, CiJobFailure } from "./engine/github/github.js";
export {
  parseAttemptMarkers,
  parseDiagnosisMarker,
  parseFixOutcomeMarker,
  DIAGNOSIS_CLASSES,
} from "./engine/fix-markers.js";
export type {
  AttemptMarkers,
  DiagnosisMarker,
  FixOutcomeMarker,
  DiagnosisClass,
} from "./engine/fix-markers.js";
// The two policy blocks the same prompts render as `{{fix.maxAttempts}}` /
// `{{dependencies.autoMergeMaxImpact}}`, with their shipped defaults — a
// harness needs the defaults to stand in for boot config it has no other way
// to obtain.
export {
  defaultFixConfig,
  defaultDependenciesConfig,
  defaultReviewConfig,
} from "lastlight-shared/config-types";
export type { FixConfig, DependenciesConfig, ReviewConfig } from "lastlight-shared/config-types";

// ── overlay/evals repo bootstrap (reused by `lastlight-evals init`) ──────────
export {
  detectGh,
  bootstrapOverlayRepo,
  scaffoldOverlayFiles,
  OVERLAY_GITIGNORE,
  OVERLAY_CONFIG_PLACEHOLDER,
  OVERLAY_ENV_EXAMPLE,
  OVERLAY_README,
} from "lastlight-shared/overlay-bootstrap";
export type { GhStatus, ScaffoldResult, BootstrapOpts } from "lastlight-shared/overlay-bootstrap";
