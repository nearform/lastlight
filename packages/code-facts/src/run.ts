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
 *
 * ## ONE ENGINE
 *
 * `facts`, `contracts` and `constants` all run on the tsgo snapshot
 * (`tsgo.ts` + `tsgo-extractors.ts`). There is no `--engine`, no dual path and
 * no fallback to a second compiler, and that is a correctness decision rather
 * than a tidiness one: **two engines means two type PRINTERS**, and a signature
 * that prints differently on one side is the asymmetry that produced WP1's 227
 * contract deltas of which exactly one was real.
 *
 * ## ONE SNAPSHOT, TWO VIEWS, AND THE BASE ONE GOES FIRST
 *
 * The base side is an OVERLAY over the same tree rather than a
 * `git worktree add` into `$TMPDIR`. Two of the three phantom-delta causes die
 * with that: the two sides cannot disagree about the project layout (one
 * argument list, used twice) and they cannot disagree about `node_modules`
 * (one tree). What is left is the printer, which `contracts.ts` canonicalises.
 *
 * The two views are two `tsgo` children of ~600 MB each on this repo, and they
 * are never alive at the same time: a `Shape` is strings, so the base view is
 * drained to plain data and DISPOSED before the head view opens.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
} from "./git.js";
import type { ChangedPath } from "./git.js";
import { indexHunks } from "./facts.js";
import type { ChangedFileIndex } from "./facts.js";
import { extractFactsByName } from "./syntactic.js";
import { extractConstants, parseSides } from "./constants.js";
import { extractDeps } from "./deps.js";
import { extractPatterns } from "./patterns.js";
import { extractCoverage } from "./coverage.js";
import { hasAnalysableExtension, languageBreakdown } from "./project.js";
import { stageDiff } from "./stage-diff.js";
import {
  abandonedByBrokenTsConfig,
  collectBaseContracts,
  extractContractsTsgo,
  extractFactsTsgo,
  refusing,
  tsgoViews,
  type BaseContractView,
} from "./tsgo-extractors.js";
import type { EngineSnapshot } from "./tsgo.js";
import { toolchainStamp } from "./toolchain.js";
import {
  AllDocumentSchema,
  DOCUMENT_SCHEMAS,
  type DegradedEntry,
  type Engine,
  type Envelope,
  type ExtractorName,
  type LanguageStat,
  type StagedDiff,
  type Tier,
} from "./schema.js";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";

export interface RunOptions {
  extractor: ExtractorName;
  repo: string;
  base: string;
  head: string;
  /**
   * Force ONE tsconfig for the whole diff. It also disables the orphan
   * fallback: a caller that named one program did not ask for a second to be
   * opened around the files it does not cover.
   */
  tsConfigPath?: string;
  /**
   * A ceiling on how many FILES a repository-wide SCAN reads — set B's literal
   * sweep and the tier-2 name index (`DEFAULT_MAX_SCANNED_FILES`).
   *
   * **Not a compiler budget.** `--max-files` used to bound a ts-morph program's
   * root list and was deleted with it; what survives is the ast-grep sweep it
   * was sharing a name with, which bounds blob reads rather than a heap.
   * Hitting it makes `constants`' absence claim unsound, so it is always named
   * in `degraded[]` with the ceiling, the eligible count and the read count.
   */
  maxFiles?: number;
  sides?: string;
  rulesPath?: string;
  stage?: boolean;
  stageDir?: string;
  /**
   * The f1 lever: ALSO write the diff to disk, once, as an index plus one patch
   * per changed file (`stage-diff.ts`). Opt-in for the same reason `--stage` is
   * — this is the only thing in a run that touches the repository under review,
   * and a tool that writes into a tree nobody asked it to write into is a
   * surprise the `deps` staging precedent already settled.
   *
   * A staging failure never fails the run and never changes the exit-code
   * contract beyond `degraded`.
   */
  stageDiff?: boolean;
  /** Where the staged patches go. Repo-relative; defaults to `.lastlight/pr-review/diff`. */
  diffStageDir?: string;
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
  /** Defaults to `"none"` — the honest answer when no parser ran. */
  engine?: Engine;
  languages?: LanguageStat[];
  coverage: Envelope["coverage"];
  degraded: DegradedEntry[];
  tools: string[];
  env?: NodeJS.ProcessEnv;
  /**
   * ABSENT means this run was never asked to stage the diff. A run that WAS
   * asked and failed carries the record with `files: null` — the two must not
   * collapse onto one shape (`null` ≠ `[]`, one layer up).
   */
  stagedDiff?: StagedDiff;
}): Envelope {
  return {
    version: 2,
    generatedAt: new Date().toISOString(),
    extractor: input.extractor,
    repo: input.repo,
    baseSha: input.baseSha,
    headSha: input.headSha,
    tier: input.tier,
    engine: input.engine ?? "none",
    languages: input.languages ?? [],
    coverage: input.coverage,
    degraded: input.degraded,
    toolchain: toolchainStamp(input.tools, input.env ?? process.env),
    ...(input.stagedDiff ? { stagedDiff: input.stagedDiff } : {}),
  };
}

interface Prepared {
  repoName: string;
  /**
   * The MERGE BASE of `--base` and `--head`, not the base branch's tip.
   * Everything downstream — the diff, `git show <base>:<path>`, the `contracts`
   * base overlay and the envelope's own `baseSha` — uses this one commit, so
   * the document names what was actually compared.
   */
  baseSha: string;
  headSha: string;
  changed: ChangedPath[];
  hunks: ReturnType<typeof diffHunks>;
  hunkIndex: Map<string, ChangedFileIndex>;
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

/** Extractors that need a compiled program, and therefore a tier-1 repo. */
const NEEDS_PROJECT: ExtractorName[] = ["facts", "contracts"];

/** Extractors that open a compiler snapshot at all. */
const NEEDS_SNAPSHOT: ExtractorName[] = ["facts", "contracts", "constants"];

/**
 * `--repo .` must mean what it looks like it means.
 *
 * A RELATIVE `repo` silently disabled tsconfig discovery: the walk up from a
 * changed file to the repo root is guarded on
 * `dir.startsWith(repo) && dir.length >= repo.length`, and
 * `"apps/server/src".startsWith(".")` is false — so the walk never ran, EVERY
 * changed file was filed under "no tsconfig", and the whole diff fell through
 * to a fallback with none of the repository's compiler options behind it.
 * Measured on this monorepo at `c8530b83`: `--repo .` reported *"31 changed
 * file(s) are covered by no tsconfig"* while `--repo <absolute>` compiled four
 * programs from three tsconfigs. It was named in `degraded[]` either way, so
 * this is a coverage bug and not a loudness one: the package was honest, and it
 * was reading a different program than the caller asked for.
 *
 * Normalised ONCE here, so every extractor below and every `repoRelative`
 * downstream is talking about the same root.
 */
function normalise(options: RunOptions): RunOptions {
  return {
    ...options,
    repo: resolve(options.repo),
    ...(options.tsConfigPath ? { tsConfigPath: resolve(options.tsConfigPath) } : {}),
  };
}

/**
 * The compiler views a run needs, opened and (for the base side) already
 * drained to plain data.
 */
interface Views {
  /** `null` when nothing type-aware could be opened — tier 2 or tier 3. */
  head: EngineSnapshot | null;
  base: BaseContractView | null;
  dispose(): void;
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

  /**
   * The f1 lever, and it runs FIRST on purpose.
   *
   * Staging needs nothing but the range `prepare()` just resolved, so doing it
   * before the compiler opens means the patches are on disk even when an
   * extractor later throws and `runWrapped` writes a `coverage: "none"`
   * envelope. The affordance survives the analysis failing, which is exactly
   * when a survey most needs the diff without re-deriving it.
   *
   * `stageDiff` never throws; see its module header.
   */
  let staged: StagedDiff | undefined;
  if (options.stageDiff) {
    const result = stageDiff({
      repo: options.repo,
      baseSha: context.baseSha,
      headSha: context.headSha,
      changed: context.changed,
      hunks: context.hunks,
      ...(options.diffStageDir ? { dir: options.diffStageDir } : {}),
      log,
    });
    staged = result.payload;
    degraded.push(...result.degraded);
  }

  const wants = (name: ExtractorName): boolean =>
    options.extractor === "all" || options.extractor === name;

  const analysable = context.changed.filter((c) => hasAnalysableExtension(c.path));
  const extractors: Record<string, unknown> = {};
  let tier: Tier = 1;
  /**
   * `"none"` until something proves otherwise. A `deps`-only run opens no
   * compiler at all, and reporting an engine for it because the tier defaulted
   * to 1 would be the document claiming a parse that never happened.
   */
  let engine: Engine = "none";
  let head: EngineSnapshot | null = null;
  let views: Views = { head: null, base: null, dispose: () => {} };

  try {
    if (NEEDS_SNAPSHOT.some(wants)) {
      if (analysable.length === 0) {
        tier = 3;
        degraded.push({
          extractor: "project",
          reason:
            "no TypeScript or JavaScript file in the diff — tier 3, only `deps`, `patterns` and `coverage` apply",
        });
      } else {
        views = openViews(options, context, wants("contracts"), degraded, log);
        head = views.head;
        if (!head) {
          tier = 2;
          engine = "ast-grep";
        } else {
          engine = "tsgo";
        }
      }
    }

    if (wants("facts")) {
      if (head) {
        const result = extractFactsTsgo({
          repo: options.repo,
          snapshot: head,
          hunks: context.hunks,
          changed: context.changed,
          maxReferences: options.maxReferences,
        });
        extractors.facts = result.payload;
        degraded.push(...result.degraded);
      } else if (tier === 2) {
        // TIER 2 IS A REAL TIER, the way it already was for `constants`. No
        // compiled program, so no type-resolved reference set — but the
        // syntactic engine still finds the changed declarations and every
        // MENTION of their names, and labels the result for what it is.
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
        // The tier reason is already in `degraded`; this second line is what
        // makes the FACTS document itself readable in isolation.
        degraded.push({
          extractor: "facts",
          reason: `no compiled project (tier ${tier}) — the impact cone was not computed, so an empty symbol list here means UNKNOWN, not clean`,
        });
      }
    }

    if (wants("contracts")) {
      if (head && views.base) {
        const result = extractContractsTsgo({
          repo: options.repo,
          head,
          base: views.base,
          changed: context.changed,
          hunkIndex: context.hunkIndex,
        });
        extractors.contracts = result.payload;
        degraded.push(...result.degraded);
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
      if (!head) {
        degraded.push({
          extractor: "constants",
          reason: `no compiled project (tier ${tier}) — reference sets (A) are missing, so hardCodedDuplicates is every literal occurrence rather than the subtraction B \\ A`,
        });
      }
      const result = extractConstants({
        repo: options.repo,
        snapshot: head,
        hunkIndex: context.hunkIndex,
        sides: parseSides(options.sides),
        maxFiles: options.maxFiles,
        // Set B is enumerated at the SAME commit the envelope stamps. Reading
        // the working directory instead made every `hardCodedDuplicates`
        // citation a claim about the checkout, silently wrong whenever the two
        // differ.
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

    // An extractor that needs a project but is running on a tier-3 repo is not
    // a crash — it is a documented tier. The envelope says which.
    if (tier !== 1 && NEEDS_PROJECT.includes(options.extractor) && degraded.length === 0) {
      degraded.push({
        extractor: options.extractor,
        reason: `tier ${tier}: this extractor requires a compiled project`,
      });
    }

    const coverage = coverageOf(degraded);
    const snapshot = head;
    const envelope = buildEnvelope({
      extractor: options.extractor,
      repo: context.repoName,
      baseSha: context.baseSha,
      headSha: context.headSha,
      tier,
      engine,
      // Deletions are excluded: a file that does not exist at head cannot be
      // parsed, and counting it as unparsed manufactures the exact signal this
      // field exists to make trustworthy.
      languages: NEEDS_SNAPSHOT.some(wants)
        ? languageBreakdown({
            repo: options.repo,
            paths: context.changed.filter((c) => c.status !== "deleted").map((c) => c.path),
            engine,
            ...(snapshot ? { parsed: (path: string) => snapshot.lookup(path) !== null } : {}),
          })
        : [],
      coverage,
      degraded,
      tools,
      env,
      ...(staged ? { stagedDiff: staged } : {}),
    });

    const document =
      options.extractor === "all"
        ? { ...envelope, extractors }
        : { ...envelope, ...(extractors[options.extractor] as Record<string, unknown>) };

    const schema =
      options.extractor === "all" ? AllDocumentSchema : DOCUMENT_SCHEMAS[options.extractor];
    const parsed = schema.safeParse(document);
    if (!parsed.success) {
      // A document that does not match its own schema is a bug in this package,
      // and shipping it downstream would put a malformed obligation set in
      // front of the model. Fail here, where the wrapper turns it into
      // `coverage: none`.
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
      engine,
      tier,
      coverage,
      degraded: degraded.length,
    });

    return { document: document as Record<string, unknown>, exitCode: exitOf(coverage) };
  } finally {
    // `openSnapshot` spawns a child process per view. A leaked one keeps this
    // process alive; a `finally` is the only place this belongs.
    views.dispose();
  }
}

/**
 * Open the compiler views this run needs — BASE FIRST, and gone before HEAD
 * opens.
 *
 * Measured on this repo: each snapshot is a `tsgo` child holding ~600 MB and
 * the node process holds ~200 MB. Two alive at once is 1.4 GB, which is worse
 * than the engine this replaced. A `Shape` is strings, so the base side is
 * drained to plain data and disposed first; the peak becomes one child.
 *
 * Two failure modes are handled here rather than left to the extractors:
 *
 *  - **A tsconfig that will not PARSE is not one that is absent.** Its files
 *    are ABANDONED — refused by `lookup` — rather than routed to tsgo's
 *    inferred project, or a repository whose build config is broken is silently
 *    promoted to tier 1 under default compiler options.
 *  - **Tier 2 is "no analysable changed file is in any program"**, not "no
 *    project loaded". `openFiles` means there is nearly always an inferred
 *    project, so counting projects would report tier 1 for a run that saw
 *    nothing.
 */
function openViews(
  options: RunOptions,
  context: Prepared,
  wantsContracts: boolean,
  degraded: DegradedEntry[],
  log: LoggerPort,
): Views {
  const factory = tsgoViews({
    repo: options.repo,
    baseSha: context.baseSha,
    changed: context.changed,
    ...(options.tsConfigPath ? { tsConfigPath: options.tsConfigPath } : {}),
    log,
  });
  const analysable = context.changed.filter((c) => hasAnalysableExtension(c.path));
  if (factory.targets.compilerHostile.length > 0) {
    // MEASURED: handing tsgo a `.es6` path panics the Go child and takes the
    // whole snapshot with it — every project, not just that file. Excluding it
    // costs the type-aware answer for those files and is named here; NOT
    // excluding it costs the entire document, uncatchably.
    degraded.push({
      extractor: "project",
      reason: `${factory.targets.compilerHostile.length} changed file(s) have an extension the compiler cannot be handed at all — it panics the child process and kills the whole snapshot — so they were NOT type-analysed; ast-grep still reads them, so they are counted in \`languages[]\` and reachable to \`constants\`' literal sweep (${factory.targets.compilerHostile.slice(0, 10).join(", ")})`,
    });
  }

  let base: BaseContractView | null = null;
  if (wantsContracts) {
    const raw = factory.open("base");
    try {
      // Prefixed, not merged: an entry true of the base view and not of the
      // head view is exactly the asymmetry a reader needs to be able to see.
      degraded.push(
        ...raw.degraded.map((entry) => ({
          extractor: entry.extractor,
          reason: `base view: ${entry.reason}`,
        })),
      );
      base = collectBaseContracts(
        refusing(raw, abandonedByBrokenTsConfig(options.repo, factory.targets, raw)),
        context.changed,
      );
    } finally {
      raw.dispose();
    }
  }

  const raw = factory.open("head");
  let head: EngineSnapshot | null = null;
  try {
    degraded.push(...raw.degraded);
    const abandoned = abandonedByBrokenTsConfig(options.repo, factory.targets, raw);
    if (abandoned.size > 0) {
      degraded.push({
        extractor: "project",
        reason: `${abandoned.size} changed file(s) sit under a tsconfig that would not parse, so they were ABANDONED rather than analysed under guessed compiler options — a repository whose build config is broken must not read as tier 1 (${[...abandoned].slice(0, 10).join(", ")})`,
      });
    }
    const snapshot = refusing(raw, abandoned);

    const analysed = analysable.filter(
      (c) => c.status !== "deleted" && snapshot.lookup(c.path) !== null,
    );
    if (analysed.length === 0) {
      // Every project failed, or every changed file fell outside all of them.
      // Either way nothing type-aware was computed and an empty result here
      // means UNKNOWN, not clean.
      degraded.push({
        extractor: "project",
        reason:
          "no changed file is in a compiled program — tier 2, so no type-aware answer was computed. An empty result here means UNKNOWN, not clean",
      });
      raw.dispose();
      return { head: null, base, dispose: () => {} };
    }

    // A changed file no program holds cannot be reasoned about, and saying so
    // is the difference between "clean" and "blind". Deletions get their own
    // line: absent at head, so no program COULD hold them.
    const hostile = new Set(factory.targets.compilerHostile);
    const missing = analysable
      .filter((c) => c.status !== "deleted" && !abandoned.has(c.path) && !hostile.has(c.path))
      .filter((c) => snapshot.lookup(c.path) === null)
      .map((c) => c.path);
    if (missing.length > 0) {
      degraded.push({
        extractor: "project",
        reason: `${missing.length} changed file(s) are not in any compiled program and were not analysed: ${missing.slice(0, 10).join(", ")}`,
      });
    }
    const deleted = analysable.filter((c) => c.status === "deleted").map((c) => c.path);
    if (deleted.length > 0) {
      degraded.push({
        extractor: "project",
        reason: `${deleted.length} changed file(s) are absent at head — deleted by this diff — so nothing was extracted FROM them at head; on the base side they are served by the overlay into tsgo's INFERRED project (default compiler options), because a tsconfig's file list comes from the real directory listing and no longer contains them (${deleted.slice(0, 10).join(", ")})`,
      });
    }
    // The census `scripts/selfcheck.ts` prints, and the only place the numbers
    // exist: WHICH programs opened, and how much of the diff they covered
    // between them. A tier-1 envelope over one file of forty reads far better
    // than it deserves to, and this is the line that says which it was.
    log.debug("code-facts project loaded", {
      tsConfigPaths: raw.projects.map((p) => p.tsConfigPath ?? "(inferred)"),
      groups: raw.projects.length,
      fileCount: raw.projects.reduce((total, p) => total + p.fileCount, 0),
      changedAnalysed: analysed.length,
      changedNotInProject:
        analysable.filter((c) => c.status !== "deleted").length - analysed.length,
    });

    head = snapshot;
    return { head, base, dispose: () => raw.dispose() };
  } catch (err) {
    raw.dispose();
    throw err;
  }
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

export function writeDocument(
  out: string,
  document: unknown,
  opts: { raw?: boolean } = {},
): void {
  mkdirSync(dirname(out), { recursive: true });
  // `raw` is for the rendered obligation BLOCKS, which are markdown a model
  // reads rather than JSON a consumer parses. Same atomic-ish write, same
  // mkdir, so a block and a document cannot end up in different directories.
  const body = opts.raw ? String(document) : `${JSON.stringify(document, null, 2)}`;
  writeFileSync(out, `${body}\n`, "utf8");
}
