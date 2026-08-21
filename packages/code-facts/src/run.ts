/**
 * Orchestration — one envelope per document, and the tier arithmetic that keeps
 * "clean" and "blind" apart.
 *
 * `coverage` is derived, never asserted by an extractor:
 *
 *   degraded[] empty        → "full"      → exit 0
 *   degraded[] populated    → "degraded"  → exit 3
 *   the run threw           → "none"      → exit 2  (and the wrapper turns that
 *                                                    into an envelope + exit 0)
 *
 * So there is exactly one way to produce an empty result that looks trustworthy
 * — an extractor that genuinely found nothing with every input available — and
 * every other path carries a written reason.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { Project } from "ts-morph";
import {
  EXIT_DEGRADED,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  FactsError,
  type ExitCode,
  reasonOf,
} from "./errors.js";
import { changedPaths, diffHunks, isGitRepo, repoSlug, resolveSha, withWorktree } from "./git.js";
import type { ChangedPath } from "./git.js";
import { extractFacts, indexHunks } from "./facts.js";
import { extractContracts } from "./contracts.js";
import { extractConstants, parseSides } from "./constants.js";
import { extractDeps } from "./deps.js";
import { extractPatterns } from "./patterns.js";
import { extractCoverage } from "./coverage.js";
import { loadProject } from "./project.js";
import { toolchainStamp } from "./toolchain.js";
import {
  AllDocumentSchema,
  DOCUMENT_SCHEMAS,
  type DegradedEntry,
  type Envelope,
  type ExtractorName,
  type Tier,
} from "./schema.js";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";

export interface RunOptions {
  extractor: ExtractorName;
  repo: string;
  base: string;
  head: string;
  tsConfigPath?: string;
  maxFiles?: number;
  sides?: string;
  rulesPath?: string;
  stage?: boolean;
  stageDir?: string;
  reportPath?: string;
  maxReferences?: number;
  env?: NodeJS.ProcessEnv;
  log?: LoggerPort;
}

export interface RunResult {
  document: Record<string, unknown>;
  exitCode: ExitCode;
}

function coverageOf(degraded: DegradedEntry[]): Envelope["coverage"] {
  return degraded.length === 0 ? "full" : "degraded";
}

function exitOf(coverage: Envelope["coverage"]): ExitCode {
  if (coverage === "none") return EXIT_UNAVAILABLE;
  return coverage === "degraded" ? EXIT_DEGRADED : EXIT_OK;
}

/**
 * The envelope every document carries — including the `coverage: "none"` one
 * the wrapper writes when the analysis could not run at all. Assembling it in
 * ONE place is what guarantees a failed run is still a well-formed document a
 * consumer can read the toolchain stamp off.
 */
export function buildEnvelope(input: {
  extractor: string;
  repo: string;
  baseSha: string;
  headSha: string;
  tier: Tier;
  coverage: Envelope["coverage"];
  degraded: DegradedEntry[];
  tools: string[];
  env?: NodeJS.ProcessEnv;
}): Envelope {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    extractor: input.extractor,
    repo: input.repo,
    baseSha: input.baseSha,
    headSha: input.headSha,
    tier: input.tier,
    coverage: input.coverage,
    degraded: input.degraded,
    toolchain: toolchainStamp(input.tools, input.env ?? process.env),
  };
}

interface Prepared {
  repoName: string;
  baseSha: string;
  headSha: string;
  changed: ChangedPath[];
  hunks: ReturnType<typeof diffHunks>;
  hunkIndex: Map<string, import("./facts.js").ChangedFileIndex>;
}

function prepare(options: RunOptions): Prepared {
  if (!isGitRepo(options.repo)) {
    throw new FactsError("git", `${options.repo} is not a git repository`);
  }
  const baseSha = resolveSha(options.repo, options.base);
  const headSha = resolveSha(options.repo, options.head);
  const changed = changedPaths(options.repo, baseSha, headSha);
  const hunks = diffHunks(options.repo, baseSha, headSha);
  return {
    repoName: repoSlug(options.repo),
    baseSha,
    headSha,
    changed,
    hunks,
    hunkIndex: indexHunks(hunks),
  };
}

/** Extractors that need a compiled project, and therefore a tier-1 repo. */
const NEEDS_PROJECT: ExtractorName[] = ["facts", "contracts"];

/**
 * Run one extractor (or `all`) and return the document plus the exit code the
 * CLI should use. Throws `FactsError` when the analysis could not run at all —
 * `runWrapped` is what turns that into a `coverage: "none"` envelope.
 */
export function runExtractor(options: RunOptions): RunResult {
  const log = options.log ?? noopLogger;
  const env = options.env ?? process.env;
  const context = prepare(options);
  const degraded: DegradedEntry[] = [];
  const tools: string[] = [];

  const wants = (name: ExtractorName): boolean =>
    options.extractor === "all" || options.extractor === name;

  let project: Project | null = null;
  let tier: Tier = 1;
  if (wants("facts") || wants("contracts") || wants("constants")) {
    const loaded = loadProject({
      repo: options.repo,
      changedPaths: context.changed.map((c) => c.path),
      tsConfigPath: options.tsConfigPath,
      maxFiles: options.maxFiles,
      log,
    });
    project = loaded.project;
    tier = loaded.tier;
    degraded.push(...loaded.degraded);
  }

  const extractors: Record<string, unknown> = {};

  if (wants("facts")) {
    if (project) {
      extractors.facts = extractFacts({
        repo: options.repo,
        project,
        hunks: context.hunks,
        changed: context.changed,
        maxReferences: options.maxReferences,
      });
    } else {
      extractors.facts = { files: [], symbols: [] };
      // The tier reason is already in `degraded` from loadProject; this second
      // line is what makes the FACTS document itself readable in isolation.
      degraded.push({
        extractor: "facts",
        reason: `no compiled project (tier ${tier}) — the impact cone was not computed, so an empty symbol list here means UNKNOWN, not clean`,
      });
    }
  }

  if (wants("contracts")) {
    if (project) {
      let emitted = false;
      try {
        const result = withWorktree(options.repo, context.baseSha, (baseDir) => {
          const baseLoaded = loadProject({
            repo: baseDir,
            changedPaths: context.changed.map((c) => c.path),
            // The SAME tsconfig, translated into the base worktree. Letting the
            // two sides discover independently is how a comparison ends up
            // comparing different programs.
            tsConfigPath: options.tsConfigPath
              ? join(baseDir, relative(options.repo, options.tsConfigPath))
              : undefined,
            maxFiles: options.maxFiles,
            log,
          });
          if (!baseLoaded.project) {
            degraded.push({
              extractor: "contracts",
              reason: `the base tree loaded but its project did not: ${baseLoaded.degraded.map((d) => d.reason).join("; ")}`,
            });
            return null;
          }
          return extractContracts({
            repo: options.repo,
            headProject: project,
            baseProject: baseLoaded.project,
            baseDir,
            changed: context.changed,
            hunkIndex: context.hunkIndex,
          });
        });
        if (result) {
          extractors.contracts = result.payload;
          degraded.push(...result.degraded);
          emitted = true;
        }
      } catch (err) {
        degraded.push({
          extractor: "contracts",
          reason: `the base worktree could not be materialised: ${reasonOf(err)}`,
        });
      }
      if (!emitted) extractors.contracts = { contracts: [] };
    } else {
      extractors.contracts = { contracts: [] };
      degraded.push({
        extractor: "contracts",
        reason: `no compiled project (tier ${tier}) — the contract delta was not computed`,
      });
    }
  }

  if (wants("constants")) {
    // Tier 2 is a REAL tier here, not a failure: ast-grep still finds the
    // declarations and set B, and the document says set A is missing.
    if (!project) {
      degraded.push({
        extractor: "constants",
        reason: `no compiled project (tier ${tier}) — reference sets (A) are missing, so hardCodedDuplicates is every literal occurrence rather than the subtraction B \\ A`,
      });
    }
    extractors.constants = extractConstants({
      repo: options.repo,
      project,
      hunkIndex: context.hunkIndex,
      sides: parseSides(options.sides),
      maxFiles: options.maxFiles,
    });
  }

  if (wants("deps")) {
    const result = extractDeps({
      repo: options.repo,
      base: context.baseSha,
      head: context.headSha,
      hunkIndex: context.hunkIndex,
      stage: options.stage,
      stageDir: options.stageDir,
      log,
    });
    extractors.deps = result.payload;
    degraded.push(...result.degraded);
  }

  if (wants("patterns")) {
    const result = extractPatterns({
      repo: options.repo,
      base: context.baseSha,
      head: context.headSha,
      changedPaths: context.changed.filter((c) => c.status !== "deleted").map((c) => c.path),
      rulesPath: options.rulesPath,
      env,
    });
    extractors.patterns = result.payload;
    degraded.push(...result.degraded);
    tools.push(...result.tools);
  }

  if (wants("coverage")) {
    const result = extractCoverage({
      repo: options.repo,
      hunkIndex: context.hunkIndex,
      reportPath: options.reportPath,
    });
    extractors.coverage = result.payload;
    degraded.push(...result.degraded);
  }

  // An extractor that needs a project but is running on a tier-3 repo is not a
  // crash — it is a documented tier. The envelope says which.
  if (tier !== 1 && NEEDS_PROJECT.includes(options.extractor) && degraded.length === 0) {
    degraded.push({
      extractor: options.extractor,
      reason: `tier ${tier}: this extractor requires a compiled project`,
    });
  }

  const coverage = coverageOf(degraded);
  const envelope = buildEnvelope({
    extractor: options.extractor,
    repo: context.repoName,
    baseSha: context.baseSha,
    headSha: context.headSha,
    tier,
    coverage,
    degraded,
    tools,
    env,
  });

  const document =
    options.extractor === "all"
      ? { ...envelope, extractors }
      : { ...envelope, ...(extractors[options.extractor] as Record<string, unknown>) };

  const schema = options.extractor === "all" ? AllDocumentSchema : DOCUMENT_SCHEMAS[options.extractor];
  const parsed = schema.safeParse(document);
  if (!parsed.success) {
    // A document that does not match its own schema is a bug in this package,
    // and shipping it downstream would put a malformed obligation set in front
    // of the model. Fail here, where the wrapper turns it into `coverage: none`.
    throw new FactsError(
      options.extractor,
      `the ${options.extractor} document failed its own schema: ${parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  log.info("code-facts extraction complete", {
    extractor: options.extractor,
    tier,
    coverage,
    degraded: degraded.length,
  });

  return { document: document as Record<string, unknown>, exitCode: exitOf(coverage) };
}

/**
 * The §D12 phase wrapper.
 *
 * `cron-review.yaml` re-dispatches every thirty minutes and
 * `assessedHeadShaByWorkflow` is populated from SUCCEEDED runs ONLY, so a phase
 * that exits non-zero fails the
 * run, records nothing, and is re-dispatched forever. This catches the failure,
 * writes the envelope with `coverage: "none"` and a populated `degraded[]`, and
 * reports exit 0 — LOUD IN THE ARTIFACT, never fatal to the run.
 */
export function runWrapped(options: RunOptions): RunResult {
  try {
    return runExtractor(options);
  } catch (err) {
    const log = options.log ?? noopLogger;
    const reason = reasonOf(err);
    const extractor = err instanceof FactsError ? err.extractor : options.extractor;
    log.error("code-facts could not run", { extractor, err: reason });
    const envelope = buildEnvelope({
      extractor: options.extractor,
      repo: safeRepoSlug(options.repo),
      baseSha: safeSha(options.repo, options.base),
      headSha: safeSha(options.repo, options.head),
      tier: 3,
      coverage: "none",
      degraded: [
        {
          extractor,
          reason: `analysis could not run: ${reason}. This document reports NOTHING — it is not a clean result, and a consumer must say so rather than emitting an empty obligation list`,
        },
      ],
      tools: [],
      env: options.env,
    });
    return { document: emptyDocumentFor(options.extractor, envelope), exitCode: EXIT_UNAVAILABLE };
  }
}

function safeRepoSlug(repo: string): string {
  try {
    return repoSlug(repo);
  } catch {
    return repo;
  }
}

function safeSha(repo: string, ref: string): string {
  try {
    return resolveSha(repo, ref);
  } catch {
    return ref;
  }
}

/**
 * The empty-but-well-formed payload for each extractor, so a `coverage: "none"`
 * document still validates against the same schema its successful sibling does.
 * A consumer therefore never needs a second code path for the failure case —
 * it reads `coverage` like it does on every other run.
 */
export function emptyDocumentFor(
  extractor: ExtractorName,
  envelope: Envelope,
): Record<string, unknown> {
  const empty: Record<ExtractorName, Record<string, unknown>> = {
    facts: { files: [], symbols: [] },
    contracts: { contracts: [] },
    constants: { sideDefinitions: {}, constants: [] },
    deps: { manifest: "package.json", changes: [] },
    patterns: { findings: [] },
    coverage: {
      report: null,
      reportFormat: null,
      files: [],
      totals: { changedLines: 0, uncoveredChangedLines: 0 },
    },
    all: { extractors: {} },
  };
  return { ...envelope, ...empty[extractor] };
}

export function writeDocument(out: string, document: unknown): void {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`, "utf8");
}
