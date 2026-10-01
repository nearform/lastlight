/**
 * `lastlight-code-facts` — the deterministic layer of the PR-review pipeline.
 *
 * The barrel the `lastlight` CLI imports (lazily — the compiler spawns a child
 * process and must not be on the startup path of `lastlight login`).
 * Everything here is pino-free and takes an injected `LoggerPort`, because the
 * CLI depends on it.
 */
export { runCli, parseArgv } from "./cli.js";
/** The discharge gate's ledger — read by the micro-survey eval so the eval and
 * the pipeline grade a family's obligations with ONE function. */
export { checkDischarge } from "./discharge.js";
export type { CheckDischargeResult } from "./discharge.js";
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
  familyOf,
  grammarDegraded,
  isIndexablePath,
  nameAmbiguityOf,
  parsesOnDisk,
  scanChangedFiles,
  scanDeclarations,
  scanImportLines,
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
  GrammarFailure,
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
  forceGrammarUnavailable,
  grammarAvailable,
  grammarStatus,
  interestingKinds,
  literalKindOf,
  preflightLibrary,
  registeredExtensions,
  supportedKinds,
  DYNAMIC_GRAMMARS,
  GO_DESCRIPTOR,
  JAVA_DESCRIPTOR,
  JAVASCRIPT_DESCRIPTOR,
  LANGUAGE_DESCRIPTORS,
  PYTHON_DESCRIPTOR,
  TSJS_FAMILY,
  TSJS_DESCRIPTORS,
  TSX_DESCRIPTOR,
  TYPESCRIPT_DESCRIPTOR,
} from "./langs/index.js";
export type {
  ConstantRule,
  DeclarationRule,
  DynamicGrammar,
  GrammarStatus,
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
  unifiedDiff,
  withWorktree,
} from "./git.js";
export type { DiffBase, FileListing, ListedFile, ListFilesOptions, ListingSource } from "./git.js";

/** The staged diff — lever f1. `stageDiff` never throws; see its module header. */
export {
  splitPatches,
  stageDiff,
  stagedPatchName,
  DEFAULT_DIFF_STAGE_DIR,
  DIFF_INDEX_NAME,
  MAX_PATCH_BYTES,
  MAX_STAGED_FILES,
} from "./stage-diff.js";
export type { StageDiffOptions, StageDiffResult } from "./stage-diff.js";

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

export { hypothesisId, normalizeFamilyIds, pathOfRow, readHypothesisSet, resolveHypothesis } from "./hypotheses.js";
export type { NormalizeIdsResult } from "./hypotheses.js";
/** The one JSONL reader — recovers pretty-printed rows; evals reads through it too. */
export { parseJsonl } from "./jsonl.js";
export type { JsonlParse } from "./jsonl.js";
export type {
  HypothesisRecord,
  HypothesisResolution,
  HypothesisRow,
  HypothesisSet,
} from "./hypotheses.js";
export {
  checkProbes,
  isReadOnlyCommand,
  PROBE_VERDICTS,
  probeStrength,
  readJsonl,
  readProbeAnswers,
  renderProbeCheck,
  requiresProbe,
  transcriptRecordsCommand,
} from "./probes.js";
export type { CheckProbesOptions, CheckProbesResult, ProbeAnswer, ProbeGapKind, ProbeStrength, ProbeVerdict } from "./probes.js";
/** Which hypotheses `falsify` probes — ranked, capped, and read by the gate, the prompt and the dossier alike. */
export {
  plannedProbe,
  planProbes,
  PROBE_PLAN_VERSION,
  probePlanPath,
  readProbePlan,
  renderProbePlan,
  renderProbePlanSummary,
  writeProbePlan,
  writeProbePlanFiles,
} from "./probe-plan.js";
export type { OwedReason, PlannedProbe, PlanSite, ProbePlan, WriteProbePlanResult } from "./probe-plan.js";
/** Rows grouped into sites by anchor (path + line window, across families), ranked by support. */
export {
  clusterSites,
  DEFAULT_SITE_WINDOW,
  planProbeSites,
  renderSiteBrief,
  SITE_PLAN_VERSION,
  siteLeads,
} from "./site-cluster.js";
export type {
  ClusterOptions,
  ProbeSite,
  ProbeSitePlan,
  Site,
  SiteLead,
  SiteLeads,
  SitePlan,
  SiteVoters,
  VoterUnit,
} from "./site-cluster.js";
/** The `sites` review engine: site plan + briefs, the investigator gate, merge, selection gate, finalize. */
export {
  checkSelection,
  checkSiteFindings,
  checkSiteSlot,
  DEFAULT_SITE_PLAN,
  DUPLICATE_LINE_WINDOW,
  fallbackSelection,
  finalizeSiteFindings,
  IMPORTANCES,
  isExecutionCommand,
  MAX_SITE_FINDINGS,
  mergeSiteFindings,
  nearestCodeLine,
  noneChecksRequired,
  planSiteSlots,
  readSiteFindingLines,
  readSiteMerge,
  readSitePlan,
  readVoterUnits,
  renderFinalize,
  renderSelectionCheck,
  renderSiteAssignment,
  renderSiteCheck,
  renderSiteMerge,
  SITE_MERGE_EMPTY_MARKER,
  renderSitePlanSummary,
  selectedRel,
  SITE_REVIEW_VERSION,
  SITE_SLOTS,
  SITE_STRENGTHS,
  siteBriefRel,
  siteFindingsRel,
  siteIdForRank,
  pairSiteId,
  siteBranchesRel,
  siteScratchRel,
  sitesRelDir,
  writeSiteMerge,
  writeSitePlan,
} from "./site-review.js";
export type {
  FinalizeResult,
  Importance,
  NoneCheck,
  PooledFinding,
  SelectionCheck,
  SelectionDocument,
  SelectionGapKind,
  SelectionItem,
  SiteFinding,
  SiteFindingLine,
  SiteFindingsCheck,
  SiteGap,
  SiteGapKind,
  SiteMerge,
  SitePlanOptions,
  SiteReviewPlan,
  SiteSlot,
  SiteStrength,
} from "./site-review.js";
/** Issue #405 — a posted finding's severity, derived from evidence + probe strength. ONE derivation for the pipeline (reconcile) and the evals. */
export {
  buildSeverityIndex,
  hypothesisSeverity,
  renderStampSeverity,
  stampDerivedSeverity,
  strongestSeverity,
} from "./finding-severity.js";
export type { RankEvidence, SeverityIndex, StampSeverityResult } from "./finding-severity.js";

export { checkFindings, renderFindingsCheck, titleFrom } from "./findings.js";
export type {
  CheckFindingsOptions,
  CheckFindingsResult,
  FindingsGap,
  FindingsGapKind,
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

export { deriveVerdict, effectiveTrigger, hasEvidence, isBehaviouralClaim, severityOf, needsProbeOf, isReassurance, probeReasonOf, type ProbeReason, type SurveyEvidence, type SurveyVerdict, type Discharge, type Severity } from "./survey-verdict.js";

/** The unit survey (docs/plans/pr-review-units-sites.md) — the assembler, the reply schema, the ingest. */
export {
  buildUnits,
  buildUnitsOrEmpty,
  emptyUnitsDocument,
  functionLikes,
  parsePatchLines,
  DEFAULT_MAX_REQUEST_CHARS,
  DEFAULT_MAX_UNITS,
  MAX_NEIGHBOURS,
  SMALL_SYMBOL_LINES,
  UNITS_PROMPT_VERSION,
  UnitKindSchema,
  UnitSchema,
  UnitsDocumentSchema,
  FullUnitsDocumentSchema,
  FallbackUnitsDocumentSchema,
  SpecObligationSchema,
  SpecObligationSetSchema,
  fallbackUnitsDocument,
  parseUnitsDocument,
  NOTHING_TO_SURVEY,
} from "./units.js";
export type { AnyUnitsDocument, BuildUnitsOptions, BuildUnitsResult, FallbackUnitsDocument, Unit, UnitKind, UnitsDocument } from "./units.js";
export { FAMILY_QUESTIONS, lineTag, renderUnitRequest, renderUnitSpecific, requestLineTags, UNIT_SEPARATOR, UNITS_SHARED_PREFIX } from "./units-render.js";
export type { RequestModel, SpecUnitObligation, TaggedLine } from "./units-render.js";
export {
  findUnitObject,
  isUsableUnitReply,
  locateUnitObject,
  UNIT_FAMILIES,
  unitResponseJsonSchema,
  UnitAnswerSchema,
  UnitDefectSchema,
  UnitEvidenceSchema,
  UnitResponseBodySchema,
  UnitResponseFileSchema,
} from "./unit-response.js";
export type { UnitAnswer, UnitDefect, UnitEvidence, UnitFamily, UnitObjectVia, UnitResponseBody, UnitResponseFile } from "./unit-response.js";
export { ingestUnits, renderIngest } from "./units-ingest.js";
export type { DemotedEntry, DemotionReason, IngestDocument, IngestUnitsOptions, IngestUnitsResult, UnitIngestReport, UnitIngestStatus } from "./units-ingest.js";
