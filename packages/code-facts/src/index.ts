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

export {
  buildSyntacticIndex,
  extractFactsByName,
  isIndexablePath,
  nameAmbiguityOf,
  scanChangedFiles,
  scanImportSpecifiers,
  scanSource,
  unquote,
  DEFAULT_MAX_SITES_PER_NAME,
} from "./syntactic.js";
export type {
  BuildIndexOptions,
  ChangedScan,
  DeclSite,
  ExtractFactsByNameOptions,
  ExtractFactsByNameResult,
  LitSite,
  RefSite,
  ScanSink,
  SyntacticIndex,
  ValueKind,
} from "./syntactic.js";

export {
  ancestorOfKind,
  asSyntaxNode,
  descriptorById,
  descriptorForPath,
  interestingKinds,
  literalKindOf,
  registeredExtensions,
  supportedKinds,
  JAVASCRIPT_DESCRIPTOR,
  LANGUAGE_DESCRIPTORS,
  TSJS_DESCRIPTORS,
  TSX_DESCRIPTOR,
  TYPESCRIPT_DESCRIPTOR,
} from "./langs/index.js";
export type {
  ConstantRule,
  DeclarationRule,
  LanguageDescriptor,
  LiteralKinds,
  SyntaxNode,
} from "./langs/index.js";
export { extractContracts, shapeOf } from "./contracts.js";
export {
  extractConstants,
  findLiteralOccurrences,
  literalOf,
  parseSides,
  DEFAULT_SIDES,
} from "./constants.js";
export {
  extractDeps,
  discoverManifests,
  isToolingPackage,
  packageNameOf,
  scanImports,
  lockedVersion,
} from "./deps.js";
export {
  ecosystemOf,
  parseManifest,
  parseNpm,
  parseGoMod,
  parsePom,
  parseGradle,
  parseGemfile,
  parseGemfileLock,
  parsePyproject,
  parseRequirement,
  parseRequirements,
  ROOT_MANIFEST_NAMES,
} from "./manifests.js";
export type { Declared, DeclaredMap } from "./manifests.js";
export {
  extractPatterns,
  fingerprint,
  normaliseGitleaks,
  normaliseOpengrep,
  defaultRulesPath,
} from "./patterns.js";
export {
  extractCoverage,
  formatOf,
  parseCobertura,
  parseGoCoverProfile,
  parseIstanbul,
  parseJaCoCo,
  parseLcov,
  parseSimpleCov,
  resolveReportKey,
  DEFAULT_REPORT_CANDIDATES,
} from "./coverage.js";

export {
  loadProject,
  compilerInfo,
  isIgnoredPath,
  isScannablePath,
  isTestPath,
  languageBreakdown,
  languageIdOf,
  looksMinified,
  repoRelative,
  sourceFileAt,
  toProjects,
  JS_EXTENSIONS,
  TS_EXTENSIONS,
  ANALYSABLE_EXTENSIONS,
  DEFAULT_MAX_FILES,
  DEFAULT_MAX_PROJECTS,
} from "./project.js";
export type { LoadedProject, LoadProjectOptions, Programs, ProjectGroup } from "./project.js";

/**
 * SELECTIVE RESOLUTION — `--resolution`, default `"changed"` (`resolution.ts`).
 * Exported so a measurement harness can drive the tiers without a subprocess.
 */
export {
  computeResolutionPolicy,
  isResolutionTier,
  isUnderNodeModules,
  resolutionHostFor,
  specifierPackage,
  DEFAULT_RESOLUTION_TIER,
  FULL_RESOLUTION,
  RESOLUTION_TIERS,
} from "./resolution.js";
export type { ComputedPolicy, ResolutionPolicy, ResolutionTier } from "./resolution.js";

export {
  BAKED_BIN_DIR,
  bundledVersions,
  envVarFor,
  loadManifest,
  packageRoot,
  parseVersion,
  platformKey,
  resolveFactsBin,
  resolveToolBin,
  sourceFor,
  stampTool,
  toolchainStamp,
  PLATFORM_KEYS,
} from "./toolchain.js";
export type { PlatformKey, ToolManifest, ToolManifestEntry } from "./toolchain.js";

export {
  changedPaths,
  diffHunks,
  isGitRepo,
  listFiles,
  mergeBase,
  readListedFiles,
  repoSlug,
  resolveDiffBase,
  resolveSha,
  showFile,
  withWorktree,
} from "./git.js";
export type { DiffBase, FileListing, ListedFile, ListFilesOptions, ListingSource } from "./git.js";

export { checkAll } from "./selfcheck.js";
export type { CheckAllOptions, Violation } from "./selfcheck.js";

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
