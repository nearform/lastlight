/**
 * `lastlight-code-facts` — the deterministic layer of the PR-review pipeline.
 *
 * The barrel the `lastlight` CLI imports (lazily — the compiler spawns a child
 * process and must not be on the startup path of `lastlight login`).
 * Everything here is pino-free and takes an injected `LoggerPort`, because the
 * CLI depends on it.
 */
export { runCli, parseArgv } from "./cli.js";
export {
  runExtractor,
  runWrapped,
  writeDocument,
  buildEnvelope,
  emptyDocumentFor,
} from "./run.js";
export type { RunOptions, RunResult } from "./run.js";

export { hunksTouching, indexHunks, DEFAULT_MAX_REFERENCES } from "./facts.js";
export type { ChangedFileIndex } from "./facts.js";

/** The type-aware extractors — `facts`, `contracts`, and `constants`' set A. */
export {
  abandonedByBrokenTsConfig,
  buildBaseOverlay,
  collectBaseContracts,
  discoverTsgoTargets,
  exportedDeclarations,
  extractContractsTsgo,
  extractFactsTsgo,
  lineOf,
  referenceNodes,
  refusing,
  repoRelativeOf,
  shapeOfTsgo,
  tsgoViews,
} from "./tsgo-extractors.js";
export type {
  BaseContractView,
  ExtractContractsTsgoOptions,
  ExtractContractsTsgoResult,
  ExtractFactsTsgoOptions,
  ExtractFactsTsgoResult,
  NamedDeclaration,
  TsgoTargets,
  TsgoViewOptions,
  TsgoViews,
} from "./tsgo-extractors.js";
export {
  compilerPaths,
  compilerVersion,
  openSnapshot,
  resolveTsgoBinary,
  TsgoError,
  TSGO_BIN_ENV,
} from "./tsgo.js";
export type {
  CompilerPaths,
  EngineFile,
  EngineProject,
  EngineSnapshot,
  OpenSnapshotOptions,
  Overlay,
  TsgoFailureReason,
  TsgoProjectFailure,
} from "./tsgo.js";

export {
  buildSyntacticIndex,
  extractFactsByName,
  isIndexablePath,
  nameAmbiguityOf,
  scanChangedFiles,
  scanImportSpecifiers,
  scanSource,
  unquote,
  DEFAULT_MAX_SCANNED_FILES,
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
export { canonicalType, finaliseShape, sameShape } from "./contracts.js";
export type { Shape } from "./contracts.js";
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
  astGrepLangFor,
  compilerInfo,
  hasAnalysableExtension,
  isIgnoredPath,
  isScannablePath,
  isTestPath,
  languageBreakdown,
  languageIdOf,
  looksMinified,
  repoRelative,
  JS_EXTENSIONS,
  TS_EXTENSIONS,
  ANALYSABLE_EXTENSIONS,
  MAX_SCANNED_FILE_BYTES,
} from "./project.js";
export type { LanguageBreakdownOptions } from "./project.js";

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

export {
  MAX_TYPECHECK_DIAGNOSTICS,
  PACKAGE_MANAGERS,
  detectPackageManager,
  envFor,
  parseTscDiagnostics,
  prepareTree,
  realExec,
  resolveCoverageCommand,
} from "./prepare.js";
export type { ExecFn, ExecResult, PackageManagerId, PrepareOptions } from "./prepare.js";

export { hypothesisId, readHypothesisSet, resolveHypothesis } from "./hypotheses.js";
export type {
  HypothesisRecord,
  HypothesisResolution,
  HypothesisRow,
  HypothesisSet,
} from "./hypotheses.js";
export { checkProbes, readJsonl, renderProbeCheck, requiresProbe } from "./probes.js";
export type { CheckProbesOptions, CheckProbesResult, ProbeGapKind } from "./probes.js";

export {
  buildFindingsLedger,
  checkFindings,
  renderFindingsCheck,
  renderFindingsLedger,
  titleFrom,
} from "./findings.js";
export type {
  CheckFindingsOptions,
  CheckFindingsResult,
  FindingsGap,
  FindingsGapKind,
  FindingsLedger,
  LedgerEntry,
  RepairAction,
} from "./findings.js";

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
