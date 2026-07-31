/**
 * Public library API.
 *
 * Two entry points:
 *
 * - `run(options)` — recommended. Runs agentic-pi in-process and returns
 *   a structured `RunResult`. Never touches `process.stdout` or `stderr`.
 *
 * - `runOnce(config, prompt, deps)` — lower-level. Use when you need the
 *   raw exit-code semantics of the CLI but want to supply your own sink
 *   (e.g. a writable stream).
 *
 * @example
 * ```ts
 * import { run } from "agentic-pi";
 *
 * const result = await run({
 *   model: "anthropic/claude-haiku-4-5",
 *   prompt: "list the open PRs on owner/repo",
 *   profile: "read",
 *   noSession: true,
 * });
 *
 * if (!result.ok) throw new Error(result.fatalError?.message ?? "agent failed");
 * console.log(result.finalText);
 * console.log("cost", result.stats?.cost);
 * ```
 */

export { run } from "./run.js";
export type { RunOptions, RunResult, ThinkingLevel } from "./run.js";

export { runOnce } from "./runner.js";
export type { RunOnceDeps, RunOnceExitCode } from "./runner.js";

export { parseArgs } from "./args.js";
export type { RunConfig } from "./args.js";

export {
  Emitter,
  StdoutSink,
  CollectorSink,
  TeeSink,
} from "./emitter.js";
export type { EmitterSink, EmitterRecord, EmitterContext } from "./emitter.js";

export { isGitAccessProfile } from "./extensions/github/index.js";
export type { GitAccessProfile } from "./extensions/github/index.js";
/** Credential shape for `RunOptions.githubAuthEnv` (the per-run GitHub creds). */
export type { GitHubAuthEnv } from "./extensions/github/auth.js";
