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
import { dirname, join, relative, resolve } from "node:path";
import type { Project } from "ts-morph";
import {
  EXIT_DEGRADED,
  EXIT_OK,
  EXIT_UNAVAILABLE,
  FactsError,
  type ExitCode,
  reasonOf,
} from "./errors.js";
import {
  changedPaths,
  diffHunks,
  isGitRepo,
  repoSlug,
  resolveDiffBase,
  resolveSha,
  withWorktree,
} from "./git.js";
import type { ChangedPath } from "./git.js";
import { extractFacts, indexHunks } from "./facts.js";
import { extractFactsByName } from "./syntactic.js";
import { extractContracts } from "./contracts.js";
import { extractConstants, parseSides } from "./constants.js";
import { extractDeps } from "./deps.js";
import { extractPatterns } from "./patterns.js";
import { extractCoverage } from "./coverage.js";
import { languageBreakdown, loadProject } from "./project.js";
import {
  computeResolutionPolicy,
  DEFAULT_RESOLUTION_TIER,
  resolutionHostFor,
  type ResolutionTier,
} from "./resolution.js";
import { toolchainStamp } from "./toolchain.js";
import {
  AllDocumentSchema,
  DOCUMENT_SCHEMAS,
  type DegradedEntry,
  type Engine,
  type Envelope,
  type ExtractorName,
  type LanguageStat,
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
  /** How many programs one diff may open — see `DEFAULT_MAX_PROJECTS`. */
  maxProjects?: number;
  sides?: string;
  rulesPath?: string;
  stage?: boolean;
  stageDir?: string;
  reportPath?: string;
  maxReferences?: number;
  /**
   * Defaults to true. `false` runs the base worktree WITHOUT the head tree's
   * `node_modules` symlinked in — the un-mirrored comparison whose cost
   * `tests/noise-floor.test.ts` measures. Not a CLI flag: nothing in production
   * wants it.
   */
  mirrorNodeModules?: boolean;
  /**
   * PROTOTYPE, defaults to `"full"` — which is today's behaviour exactly.
   *
   * Anything else installs a `resolutionHost` that refuses bare specifiers
   * outside an allow-list computed from the changed files' imports at BOTH base
   * and head. It is the memory axis `--max-files` cannot reach, and it is not
   * free: an unresolved external type renders `any`. See `resolution.ts`.
   */
  resolution?: ResolutionTier;
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
  /** Defaults to `"none"` — the honest answer when no parser ran. */
  engine?: Engine;
  languages?: LanguageStat[];
  coverage: Envelope["coverage"];
  degraded: DegradedEntry[];
  tools: string[];
  env?: NodeJS.ProcessEnv;
  /** Defaults to `full` with a null count — the shape when no policy ran. */
  resolution?: Envelope["resolution"];
}): Envelope {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    extractor: input.extractor,
    repo: input.repo,
    baseSha: input.baseSha,
    headSha: input.headSha,
    tier: input.tier,
    engine: input.engine ?? "none",
    languages: input.languages ?? [],
    resolution: input.resolution ?? { tier: "full", allowed: null },
    coverage: input.coverage,
    degraded: input.degraded,
    toolchain: toolchainStamp(input.tools, input.env ?? process.env),
  };
}

interface Prepared {
  repoName: string;
  /**
   * The MERGE BASE of `--base` and `--head`, not the base branch's tip.
   * Everything downstream — the diff, `git show <base>:<path>`, the `contracts`
   * base worktree and the envelope's own `baseSha` — uses this one commit, so
   * the document names what was actually compared.
   */
  baseSha: string;
  headSha: string;
  changed: ChangedPath[];
  hunks: ReturnType<typeof diffHunks>;
  hunkIndex: Map<string, import("./facts.js").ChangedFileIndex>;
  /** Non-empty only when there is no merge base. Never a silent fallback. */
  degraded: DegradedEntry[];
}

/**
 * Resolve the two commits and the diff between them.
 *
 * The base is resolved to the FORK POINT once, here, rather than at each call
 * site. Production hands this `pull_request.base.sha` — the base branch's tip at
 * event time — and a `base..head` diff against a busy branch reports thousands
 * of files the PR never touched (`git.mergeBase` carries the corpus numbers).
 */
function prepare(options: RunOptions): Prepared {
  if (!isGitRepo(options.repo)) {
    throw new FactsError("git", `${options.repo} is not a git repository`);
  }
  const headSha = resolveSha(options.repo, options.head);
  const diffBase = resolveDiffBase(options.repo, resolveSha(options.repo, options.base), headSha);
  const changed = changedPaths(options.repo, diffBase.sha, headSha);
  const hunks = diffHunks(options.repo, diffBase.sha, headSha);
  return {
    repoName: repoSlug(options.repo),
    baseSha: diffBase.sha,
    headSha,
    changed,
    hunks,
    hunkIndex: indexHunks(hunks),
    degraded: diffBase.reason ? [{ extractor: "git", reason: diffBase.reason }] : [],
  };
}

/** Extractors that need a compiled project, and therefore a tier-1 repo. */
const NEEDS_PROJECT: ExtractorName[] = ["facts", "contracts"];

/**
 * `--repo .` must mean what it looks like it means.
 *
 * A RELATIVE `repo` silently disabled tsconfig discovery: `nearestUp` walks up
 * from a changed file to the repo root and stops on
 * `dir.startsWith(repo) && dir.length >= repo.length`, and
 * `"apps/server/src".startsWith(".")` is false — so the walk never ran, EVERY
 * changed file was filed under "no tsconfig", and the whole diff fell through
 * to the glob fallback. Measured on this monorepo at `c8530b83`: `--repo .`
 * reported *"31 changed file(s) are covered by no tsconfig, so they were
 * analysed by GLOBBING their package instead"* while `--repo <absolute>`
 * compiled four programs from three tsconfigs. Glob-tier output is not
 * tsconfig-tier output — no `strict`, no `jsx`, no `paths` — and the spelling
 * that produced it is the one in this package's own README example.
 *
 * It was named in `degraded[]` either way, so this is a coverage bug and not a
 * loudness one: the package was honest, and it was reading a different program
 * than the caller asked for. Normalised ONCE here, so every extractor below and
 * every `repoRelative` downstream is talking about the same root.
 */
function normalise(options: RunOptions): RunOptions {
  return {
    ...options,
    repo: resolve(options.repo),
    ...(options.tsConfigPath ? { tsConfigPath: resolve(options.tsConfigPath) } : {}),
  };
}

/**
 * Run one extractor (or `all`) and return the document plus the exit code the
 * CLI should use. Throws `FactsError` when the analysis could not run at all —
 * `runWrapped` is what turns that into a `coverage: "none"` envelope.
 */
export function runExtractor(raw: RunOptions): RunResult {
  const options = normalise(raw);
  const log = options.log ?? noopLogger;
  const env = options.env ?? process.env;
  const context = prepare(options);
  // Seeded, not empty: a run with no merge base already has something to say,
  // and `coverage` is derived from this list.
  const degraded: DegradedEntry[] = [...context.degraded];
  const tools: string[] = [];

  const wants = (name: ExtractorName): boolean =>
    options.extractor === "all" || options.extractor === name;

  /**
   * ONE PROGRAM PER TSCONFIG the diff touches, not one for the diff. Every
   * extractor below reads the ARRAY, so a PR spanning two packages is analysed
   * in both — the single-project version analysed 0.7% of the changed files
   * across a 50-PR corpus while still reporting tier 1 (`loadProject`).
   */
  let projects: Project[] = [];
  let tier: Tier = 1;
  /**
   * ONE allow-list, computed ONCE, handed to BOTH programs.
   *
   * Not once per `loadProject` call: the base worktree and the head tree would
   * each derive their own, `foo` would resolve on the side that imports it and
   * collapse to `any` on the side that does not, and the delta between them
   * would be an artefact of the allow-list rather than of the PR. That is the
   * 227-deltas-of-which-one-was-real shape, arrived at from a new direction.
   */
  const resolutionTier = options.resolution ?? DEFAULT_RESOLUTION_TIER;
  // Compare against `"full"` — the tier that means "install no host" — and NOT
  // against `DEFAULT_RESOLUTION_TIER`. Those were the same string until the
  // default flipped to `"changed"` on 2026-08-21, and the difference is a whole
  // feature: keyed on the default, the DEFAULT path computes no policy, so the
  // flip is a silent no-op and every run keeps `full`'s memory profile. 394
  // tests passed while that was true, because they asserted the CONSTANT and
  // `computeResolutionPolicy` directly rather than the document a real run
  // emits. `tests/resolution.test.ts` now pins the restriction notice on the
  // default path, which is the assertion that would have caught it.
  const resolution =
    resolutionTier === "full"
      ? null
      : computeResolutionPolicy({
          repo: options.repo,
          tier: resolutionTier,
          baseSha: context.baseSha,
          headSha: context.headSha,
          changed: context.changed,
          log,
        });
  const resolutionHost = resolution ? resolutionHostFor(resolution.policy) : undefined;
  if (resolution) degraded.push(...resolution.degraded);
  // `"none"` until something proves otherwise. A `deps`-only run loads no
  // project at all, and reporting `"ts-morph"` for it because the tier defaulted
  // to 1 would be the document claiming a parse that never happened.
  let engine: Engine = "none";
  if (wants("facts") || wants("contracts") || wants("constants")) {
    const loaded = loadProject({
      repo: options.repo,
      changedPaths: context.changed.map((c) => c.path),
      tsConfigPath: options.tsConfigPath,
      maxFiles: options.maxFiles,
      maxProjects: options.maxProjects,
      resolutionHost,
      log,
    });
    projects = loaded.projects;
    tier = loaded.tier;
    engine = projects.length > 0 ? "ts-morph" : loaded.tier === 2 ? "ast-grep" : "none";
    degraded.push(...loaded.degraded);
  }
  const project = projects.length > 0 ? projects : null;

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
    } else if (tier === 2) {
      // TIER 2 IS A REAL TIER HERE NOW, the way it already was for `constants`.
      // The project would not load, so there is no type-resolved reference set
      // — but the syntactic engine still finds the changed declarations and
      // every MENTION of their names, and labels the result for what it is.
      const result = extractFactsByName({
        repo: options.repo,
        headSha: context.headSha,
        hunks: context.hunks,
        changed: context.changed,
        maxFiles: options.maxFiles,
        maxReferences: options.maxReferences,
        log,
      });
      extractors.facts = result.payload;
      degraded.push(...result.degraded);
      degraded.push({
        extractor: "facts",
        reason: `no compiled project (tier 2) — the impact cone was computed by NAME MATCHING (\`resolution: "name-match"\`), not by a type-checker. Every reference site is a HYPOTHESIS: an identifier with the same spelling, in a file that may bind an entirely different symbol. \`nameAmbiguity\` on each symbol says how many distinct declaration sites in the repository bind that name — 1 is nearly a symbol match, and a large number is barely evidence. Nothing here is filtered on it; a consumer that reads these as tier-1 references is over-trusting them by exactly that amount`,
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
        const result = withWorktree(
          options.repo,
          context.baseSha,
          (baseDir) => {
            const baseLoaded = loadProject({
              repo: baseDir,
              changedPaths: context.changed.map((c) => c.path),
              // A FORCED tsconfig is translated into the base worktree, because
              // the caller asked for one specific program and letting the base
              // side discover a different one is how a comparison ends up
              // comparing different programs. Left to itself, each side groups
              // its own tree — which it must, since a PR that ADDS a package
              // tsconfig has one at head and none at base. The FILE SET is what
              // has to match, and `extractContracts`'s one-sided guard is what
              // enforces that, per file.
              tsConfigPath: options.tsConfigPath
                ? join(baseDir, relative(options.repo, options.tsConfigPath))
                : undefined,
              maxFiles: options.maxFiles,
              maxProjects: options.maxProjects,
              // THE SAME host object, not an equivalent one. See above.
              resolutionHost,
              log,
            });
            if (baseLoaded.projects.length === 0) {
              degraded.push({
                extractor: "contracts",
                reason: `the base tree loaded but its project did not: ${baseLoaded.degraded.map((d) => d.reason).join("; ")}`,
              });
              return null;
            }
            return extractContracts({
              repo: options.repo,
              headProject: project,
              baseProject: baseLoaded.projects,
              baseDir,
              changed: context.changed,
              hunkIndex: context.hunkIndex,
            });
          },
          { mirrorNodeModules: options.mirrorNodeModules },
        );
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
    const result = extractConstants({
      repo: options.repo,
      project,
      hunkIndex: context.hunkIndex,
      sides: parseSides(options.sides),
      maxFiles: options.maxFiles,
      // Set B is enumerated at the SAME commit the envelope stamps. Reading the
      // working directory instead made every `hardCodedDuplicates` citation a
      // claim about the checkout, silently wrong whenever the two differ.
      headSha: context.headSha,
    });
    extractors.constants = result.payload;
    degraded.push(...result.degraded);
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
    engine,
    resolution: { tier: resolutionTier, allowed: resolution?.policy.allow.size ?? null },
    // Deletions are excluded: a file that does not exist at head cannot be
    // parsed, and counting it as unparsed manufactures the exact signal this
    // field exists to make trustworthy.
    languages: languageBreakdown({
      repo: options.repo,
      paths: context.changed.filter((c) => c.status !== "deleted").map((c) => c.path),
      project,
      engine,
    }),
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
export function runWrapped(raw: RunOptions): RunResult {
  const options = normalise(raw);
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
      baseSha: safeBaseSha(options.repo, options.base, options.head),
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
 * `baseSha` means the same thing on a failed run as on a clean one — the merge
 * base — so a consumer never has to ask which shape of document it is holding.
 * Degrades to the base ref itself when even that cannot be resolved.
 */
function safeBaseSha(repo: string, base: string, head: string): string {
  const baseSha = safeSha(repo, base);
  return resolveDiffBase(repo, baseSha, safeSha(repo, head)).sha;
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
    deps: { manifests: [], changes: [] },
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
