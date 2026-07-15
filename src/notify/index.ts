/**
 * Shared progress-notifier module. Renders workflow progress as a single
 * in-place "task list" surface (one GitHub comment + one Slack message edited
 * as phases run) instead of a comment per phase. The content model and
 * renderer are platform-agnostic; GitHub/Slack live behind transports.
 */
export type {
  StepStatus,
  ProgressStep,
  ProgressModel,
  ProgressReporter,
  NotifierTransport,
  NotifierState,
} from "./types.js";
export { ProgressNotifier } from "./notifier.js";
export { renderProgress, STATUS_EMOJI } from "./render.js";
export { renderProgressBlocks, renderApprovalBlocks } from "./blocks.js";
export type { ApprovalNoteMeta } from "./types.js";
export { stepsFromPhases, setStep, upsertBefore, buildProgressModel, runDashboardUrl } from "./model.js";
export type { ProgressModelInput } from "./model.js";
export { GitHubTransport } from "./transports/github.js";
export type { GitHubTransportDeps } from "./transports/github.js";
export { SlackTransport } from "./transports/slack.js";
export type { SlackTransportDeps } from "./transports/slack.js";
