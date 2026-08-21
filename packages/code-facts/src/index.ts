/**
 * `lastlight-code-facts` — the deterministic layer of the PR-review pipeline.
 *
 * The barrel the `lastlight` CLI imports (lazily — ts-morph is ~14 MB and must
 * not be on the startup path of `lastlight login`). Everything here is
 * pino-free and takes an injected `LoggerPort`, because the CLI depends on it.
 */
export { runCli, parseArgv } from "./cli.js";
export { runExtractor, runWrapped, writeDocument, buildEnvelope, emptyDocumentFor } from "./run.js";
export type { RunOptions, RunResult } from "./run.js";

export { extractFacts, indexHunks } from "./facts.js";
export { extractContracts, shapeOf } from "./contracts.js";
export {
  extractConstants,
  findLiteralOccurrences,
  literalOf,
  parseSides,
  DEFAULT_SIDES,
} from "./constants.js";
export { extractDeps, isToolingPackage, packageNameOf, scanImports, lockedVersion } from "./deps.js";
export {
  extractPatterns,
  fingerprint,
  normaliseGitleaks,
  normaliseOpengrep,
  defaultRulesPath,
} from "./patterns.js";
export { extractCoverage, parseIstanbul, parseLcov } from "./coverage.js";

export { loadProject, compilerInfo, isTestPath, repoRelative } from "./project.js";
export type { LoadedProject, LoadProjectOptions } from "./project.js";

export {
  BAKED_BIN_DIR,
  bundledVersions,
  envVarFor,
  loadManifest,
  packageRoot,
  parseVersion,
  resolveFactsBin,
  resolveToolBin,
  stampTool,
  toolchainStamp,
} from "./toolchain.js";
export type { ToolManifest, ToolManifestEntry } from "./toolchain.js";

export { changedPaths, diffHunks, repoSlug, resolveSha, showFile, withWorktree } from "./git.js";

export {
  EXIT_OK,
  EXIT_UNAVAILABLE,
  EXIT_DEGRADED,
  FactsError,
  reasonOf,
  type ExitCode,
} from "./errors.js";

export { noopLogger } from "./log.js";
export type { LoggerPort } from "./log.js";

export * from "./schema.js";
