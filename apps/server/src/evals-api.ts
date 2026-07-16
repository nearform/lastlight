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
export { getWorkflow, configureWorkflowAssets } from "@lastlight/shared/workflow-loader";
export type { WorkflowAssetConfig } from "@lastlight/shared/workflow-loader";
export { runWorkflow } from "./workflows/runner.js";
export type { RunnerCallbacks, WorkflowResult } from "./workflows/runner.js";
export type { ExecutorConfig } from "./engine/github/profiles.js";
export type { TemplateContext } from "./workflows/templates.js";

// ── overlay/evals repo bootstrap (reused by `lastlight-evals init`) ──────────
export {
  detectGh,
  bootstrapOverlayRepo,
  scaffoldOverlayFiles,
  OVERLAY_GITIGNORE,
  OVERLAY_CONFIG_PLACEHOLDER,
  OVERLAY_ENV_EXAMPLE,
  OVERLAY_README,
} from "@lastlight/shared/overlay-bootstrap";
export type { GhStatus, ScaffoldResult, BootstrapOpts } from "@lastlight/shared/overlay-bootstrap";
