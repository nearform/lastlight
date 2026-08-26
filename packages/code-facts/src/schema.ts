/**
 * Zod schemas for every document this package emits.
 *
 * Two properties matter more than the field list:
 *
 *  1. **The envelope is mandatory and identical on every extractor.** A
 *     consumer that sees `coverage: "none"` must say so in the obligations file
 *     rather than emitting an empty list — an empty obligation list and an
 *     unavailable analyser must never be indistinguishable (locked decision 6).
 *  2. **The envelope stamps the resolved toolchain** (design review §D3) beside
 *     `coverage` and `degraded[]`, so every scorecard records which toolchain
 *     produced it. Silent version drift — measure a rung on host Opengrep 1.27,
 *     ship an image with 1.0 — would change the obligation set with nothing
 *     erroring.
 *
 * Every subcommand validates its own output against these before writing, so a
 * shape change breaks a test rather than a downstream seeder.
 */
import { z } from "zod";

// ── the envelope ─────────────────────────────────────────────────────────────

/** Why an extractor produced less than it should have. Never a bare stack. */
export const DegradedEntrySchema = z.object({
  extractor: z.string(),
  reason: z.string(),
});
export type DegradedEntry = z.infer<typeof DegradedEntrySchema>;

/**
 * `ok` — resolved and the version matches `toolchain.json`.
 * `mismatch` — resolved, but a DIFFERENT version than the manifest pins. The
 *   run is still usable; the stamp is what makes the deviation readable later.
 * `missing` — not on `PATH` and not at the baked path. §D2's degraded tier.
 * `unprobed` — this extractor never needed it.
 */
export const ToolStampSchema = z.object({
  expected: z.string().nullable(),
  resolved: z.string().nullable(),
  path: z.string().nullable(),
  /**
   * `${platform}-${arch}` — WHICH BUILD this host wants (`darwin-arm64`, …), or
   * `null` on a platform the manifest has no source for. A scorecard measured
   * on a Mac and one measured in the linux image are different measurements,
   * and until now nothing in the document said which one you were reading.
   */
  platform: z.string().nullable(),
  status: z.enum(["ok", "mismatch", "missing", "unprobed"]),
});
export type ToolStamp = z.infer<typeof ToolStampSchema>;

export const ToolchainStampSchema = z.object({
  /** Manifest schema version, from `toolchain.json`. */
  manifest: z.number().int(),
  /**
   * npm-resolved engines, read off the INSTALLED package.json at run time —
   * never copied into `toolchain.json`, because the lockfile is the stronger
   * pin and a second copy is drift waiting to happen.
   */
  bundled: z.record(z.string(), z.string()),
  /** External binaries, probed. Keyed by the name in `toolchain.json`. */
  binaries: z.record(z.string(), ToolStampSchema),
});
export type ToolchainStamp = z.infer<typeof ToolchainStampSchema>;

/**
 * Language tier (WP1 "Language tiers"):
 *   1 — TS/JS with a resolvable project: all extractors.
 *   2 — TS/JS, project load failed: `deps`, `patterns`, `constants` (ast-grep
 *       only, no reference set).
 *   3 — any other language: `deps`, `patterns`.
 */
export const TierSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
export type Tier = z.infer<typeof TierSchema>;

/**
 * Which parser actually produced this document's syntax trees, if any.
 *
 * `tsgo` is the TypeScript 7 compiler API (`src/tsgo.ts`) and the only
 * type-aware engine there is; `ast-grep` is the tier-2 name-match engine
 * (`src/syntactic.ts`). `"ts-morph"` was removed with the engine it named — the
 * document must never be able to claim a compiler this package cannot run.
 *
 * The document says WHICH compiler printed it because a compiler is a type
 * printer and `contracts` compares type TEXT: a stamp is how a delta produced
 * by an engine swap stays distinguishable from a delta produced by a PR.
 */
export const EngineSchema = z.enum(["tsgo", "ast-grep", "none"]);
export type Engine = z.infer<typeof EngineSchema>;

/**
 * One row per language in the diff — THE DIRECT ANSWER TO "silence is the
 * failure mode we are engineering against".
 *
 * A Java PR used to produce an envelope with eight degraded reasons and zero
 * facts, which is a shape a *clean* TypeScript run could in principle also
 * take. It now additionally says
 * `[{ id: "java", changedFiles: 48, parsedFiles: 0, engine: "none" }]`, and no
 * clean run can ever look like that: a language was recognised, forty-eight
 * files of it changed, and nothing parsed one of them.
 *
 * `changedFiles` excludes deletions — a file that does not exist at head cannot
 * be parsed, and counting it as unparsed would manufacture the very signal this
 * field exists to make trustworthy.
 */
export const LanguageStatSchema = z.object({
  /** From the extension: `typescript`, `java`, `go`, … See `languageIdOf`. */
  id: z.string(),
  changedFiles: z.number().int(),
  /** Files this run actually obtained a syntax tree for. */
  parsedFiles: z.number().int(),
  engine: EngineSchema,
});
export type LanguageStat = z.infer<typeof LanguageStatSchema>;

// ── the staged diff — the range, written down once ───────────────────────────

/**
 * One changed file, as it was staged under `.lastlight/pr-review/diff/`.
 *
 * `patch` is a FILENAME inside that directory, never a path — the consumer
 * joins it onto `dir`, and a document that carried a host path would leak the
 * workspace root into a model's prompt (`selfcheck.ts`, `no-absolute-paths`).
 * `null` means the row is an INVENTORY entry with no body on disk: the ceiling
 * bound, the patch was too large, or git produced no hunk for it. The row is
 * still here, because the alternative is a file silently missing from an index
 * that claims to be complete.
 */
export const StagedDiffFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "other"]),
  /** The path this file had at BASE when `status` is `renamed`; `null` otherwise. */
  renamedFrom: z.string().nullable(),
  /** `start-end`, 1-based and inclusive, in HEAD coordinates. Empty for a pure deletion. */
  hunks: z.array(z.string()),
  /** The patch's filename inside `dir`, or `null` when no body was written. */
  patch: z.string().nullable(),
  /** Bytes actually written. `0` beside a `null` patch. */
  bytes: z.number().int(),
});
export type StagedDiffFile = z.infer<typeof StagedDiffFileSchema>;

/**
 * What the run staged, so a consumer can point a model at it without guessing
 * whether it is there.
 *
 * `files: null` is *staging could not run* — never `[]`, which is the honest
 * answer for a range that genuinely changed nothing and would otherwise be
 * indistinguishable from a git call that died. The field's ABSENCE from an
 * envelope is a third fact again: this run was never asked to stage.
 */
export const StagedDiffSchema = z.object({
  /** Repo-relative, always: `.lastlight/pr-review/diff`. */
  dir: z.string(),
  /** Repo-relative path of the index a model reads first. */
  index: z.string(),
  /** `null` when staging failed outright. `[]` only when the diff is empty. */
  files: z.array(StagedDiffFileSchema).nullable(),
  /** Anything git emitted that could not be attributed to a changed path. */
  skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
});
export type StagedDiff = z.infer<typeof StagedDiffSchema>;

export const EnvelopeSchema = z.object({
  /**
   * **2** since the TS 7 migration (`docs/plans/fact-engine/`): `engine` lost
   * `"ts-morph"` and the envelope lost `resolution`, which described a ts-morph
   * `resolutionHost` that no longer exists. Bumped rather than tolerated
   * because a v1 reader handed a v2 document would find the field missing and
   * have no way to tell that from a run that never computed it.
   */
  version: z.literal(2),
  generatedAt: z.iso.datetime(),
  extractor: z.string(),
  /** `owner/name` when derivable from the remote, else the directory name. */
  repo: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  tier: TierSchema,
  /** The parser that ran. `"none"` beside a populated `languages` is the tell. */
  engine: EngineSchema,
  languages: z.array(LanguageStatSchema),
  // `resolution: { tier, allowed }` was here until envelope v2. It described how
  // much of `node_modules` a ts-morph `resolutionHost` was allowed to follow —
  // the memory axis `--max-files` could not reach. tsgo resolves every specifier
  // and the closure lives in the Go child rather than in the node heap, so there
  // is no policy to stamp; a field that always read `{ tier: "full" }` would be
  // an answer to a question nobody asks any more.
  coverage: z.enum(["full", "degraded", "none"]),
  degraded: z.array(DegradedEntrySchema),
  toolchain: ToolchainStampSchema,
  /**
   * OPTIONAL, and the optionality is the point: absent means this run was never
   * asked to stage the diff, which is a different fact from asking and failing
   * (`files: null`) and from asking and finding nothing (`files: []`).
   *
   * It sits on the envelope rather than under `extractors` because it describes
   * the RANGE, not an extractor's answer about it — every extractor in the
   * document is about the same two commits, and this is where they were written
   * down for a reader.
   */
  stagedDiff: StagedDiffSchema.optional(),
});
export type Envelope = z.infer<typeof EnvelopeSchema>;

// ── `facts` — the impact cone ────────────────────────────────────────────────

export const ReferenceSchema = z.object({
  at: z.string(),
  /** True when the reference site is itself inside the diff. */
  inDiff: z.boolean(),
  /** The nearest enclosing named declaration, when there is one. */
  inSymbol: z.string().nullable(),
  isTest: z.boolean(),
});

/**
 * HOW the reference set was obtained — the epistemic status of everything else
 * in the `SymbolFact`.
 *
 * `type-aware` — a type-checker resolved it. `references` is THE reference set:
 *   two sites are in it because the compiler says they bind the same symbol.
 * `name-match` — a parser matched an identifier STRING (`syntactic.ts`). Every
 *   site is a HYPOTHESIS, and the number that says how good a hypothesis is
 *   `nameAmbiguity`.
 *
 * The field exists because the two are the same JSON otherwise, and a consumer
 * that read a name-matched set as a type-resolved one would be making exactly
 * the over-claim this package refuses to make about absence.
 */
export const ResolutionSchema = z.enum(["type-aware", "name-match"]);
export type Resolution = z.infer<typeof ResolutionSchema>;

/**
 * One route/hook registration observed INSIDE a symbol's body (D2b).
 *
 * Deterministic and conservative: only a property-access callee (`recv.m`)
 * whose method name is in the extractor's HOOK / ROUTE / MOUNT sets, with the
 * argument constraints that kill `map.get("key")`, `headers.delete("id")`,
 * `emitter.on(handler)` and `http.get(url)`. `phase` is the string-literal
 * first argument (the hook name or the route path) or `null` when the
 * registration has none (`app.use(auth)`); `ordinal` is the 0-based index in
 * source-position order within the symbol — the order IS the fact this exists
 * to record.
 */
export const RegistrationSchema = z.object({
  /** `path:line` of the call expression. */
  at: z.string(),
  /** The callee text, e.g. `app.get` — calleesOf's hygiene rules apply. */
  call: z.string(),
  /** The string-literal hook name / route path, or `null` (an `app.use(auth)`). */
  phase: z.string().nullable(),
  /** 0-based index in source-position order within the symbol. */
  ordinal: z.number().int(),
});
export type Registration = z.infer<typeof RegistrationSchema>;

export const SymbolFactSchema = z.object({
  name: z.string(),
  kind: z.string(),
  exported: z.boolean(),
  declaredAt: z.string(),
  changedHunks: z.array(z.string()),
  references: z.array(ReferenceSchema),
  /**
   * `null` = NOBODY LOOKED; `[]` = looked, found none.
   *
   * The distinction this package is founded on, and it was being collapsed:
   * implementations are only meaningful for an interface / abstract member, and
   * every other kind — plus every query the language service threw on — used to
   * report `[]`, i.e. "this interface has no implementers". Under tier 2 that
   * reading is wrong for ~80% of the corpus.
   */
  implementations: z.array(z.string()).nullable(),
  callees: z.array(z.string()),
  tests: z.array(z.string()),
  referenceCount: z.number().int(),
  /**
   * The single most productive field in the document: a symbol whose shape
   * changed in the diff and whose references are MOSTLY OUTSIDE it is the
   * cross-file contract bug the reviewer most needs to find, and it is
   * invisible in the diff because each file reads correctly alone.
   */
  referencesInDiff: z.number().int(),
  /**
   * Route/hook registrations inside the symbol's body (D2b).
   *
   * `null` = NOBODY LOOKED — the tier-2 name-match engine has no reliable
   * callee/argument view and says so explicitly; `[]` = the tier-1 extractor
   * looked and found none. The field is `.optional()` ONLY so that a document
   * written before D2 still parses: absent (a pre-D2 document) reads as `null`
   * — nobody looked — never as `[]`. Consumers normalise with
   * `s.registrations ?? null` and must never collapse the two. No envelope
   * version bump: an old reader that ignores the field loses nothing, and a
   * new reader of an old document gets the honest "nobody looked".
   */
  registrations: z.array(RegistrationSchema).nullable().optional(),
  /** How `references` was obtained. See `ResolutionSchema`. */
  resolution: ResolutionSchema,
  /**
   * How many distinct declaration sites in the repository bind this same NAME.
   *
   * **Data, never a filter.** This layer generates hypotheses and the seeder
   * ranks them; deleting a reference set here because its name is common would
   * throw away evidence nothing downstream could recover. `1` is the case where
   * a name match is very nearly a symbol match; a large number is the case
   * where it is barely evidence at all.
   *
   * `null` = NOBODY LOOKED, and on tier 1 nobody does: building it means a
   * repo-wide parse, which a type-resolved run has no other use for and should
   * not pay for. The question is moot there anyway — the reference set does not
   * come from the name.
   */
  nameAmbiguity: z.number().int().nullable(),
});
export type SymbolFact = z.infer<typeof SymbolFactSchema>;

export const ChangedFileSchema = z.object({
  path: z.string(),
  status: z.enum(["added", "modified", "deleted", "renamed", "other"]),
  hunks: z.array(z.string()),
  changedLines: z.array(z.number().int()),
  analysed: z.boolean(),
});

export const FactsPayloadSchema = z.object({
  files: z.array(ChangedFileSchema),
  symbols: z.array(SymbolFactSchema),
});
export type FactsPayload = z.infer<typeof FactsPayloadSchema>;

export const FactsDocumentSchema = EnvelopeSchema.extend(FactsPayloadSchema.shape);
export type FactsDocument = z.infer<typeof FactsDocumentSchema>;

// ── `contracts` — the semantic delta ─────────────────────────────────────────

export const ContractShapeSchema = z.object({
  kind: z.string(),
  signature: z.string(),
  parameters: z.array(z.object({ name: z.string(), type: z.string(), optional: z.boolean() })),
  returns: z.string().nullable(),
  nullableReturn: z.boolean(),
  throws: z.array(z.string()),
});

export const ContractDeltaSchema = z.object({
  symbol: z.string(),
  file: z.string(),
  change: z.enum(["added", "removed", "changed"]),
  before: ContractShapeSchema.nullable(),
  after: ContractShapeSchema.nullable(),
  /** Reference sites the diff did NOT touch — the ones that silently rot. */
  consumersOutsideDiff: z.array(z.string()),
});
export type ContractDelta = z.infer<typeof ContractDeltaSchema>;

export const ContractsPayloadSchema = z.object({
  contracts: z.array(ContractDeltaSchema),
});
export type ContractsPayload = z.infer<typeof ContractsPayloadSchema>;

export const ContractsDocumentSchema = EnvelopeSchema.extend(ContractsPayloadSchema.shape);
export type ContractsDocument = z.infer<typeof ContractsDocumentSchema>;

// ── `constants` — references MINUS literals ──────────────────────────────────

export const ConstantFactSchema = z.object({
  constant: z.string(),
  declaredAt: z.string(),
  value: z.string(),
  valueKind: z.enum(["string", "number", "boolean"]),
  /**
   * A — every reference to the identifier (the tsgo checker). **Nullable, and the
   * nullability is the point**: `null` means there is no set A because tier 2
   * had no compiler to ask, and `[]` means the compiler looked and found none.
   *
   * `constants` is the extractor that makes ABSENCE claims — "referenced only
   * client-side, zero server references" is the one gold finding this whole
   * investigation ever converted — so an empty array standing in for a missing
   * query is the most expensive lie in the document.
   */
  references: z.array(z.string()).nullable(),
  /**
   * B \ A — every occurrence of the literal VALUE that does NOT go through the
   * constant (ast-grep). The subtraction is the insight.
   */
  hardCodedDuplicates: z.array(z.string()),
  /**
   * A heuristic path-prefix partition of `references`. A constant defined in
   * config, read by the client and never compared server-side is exactly the
   * `1587-r2` Critical. It is A HINT FOR THE SEEDER, never a finding on its own.
   *
   * **Nullable for the same reason `references` is, and it is the same bug**:
   * this is a partition OF `references`, so with no set A there is nothing to
   * partition. It used to emit an all-zeros record on tier 2 — `{server: 0}`
   * derived from a reference set that does not exist is indistinguishable from
   * `{server: 0}` measured, and "zero server-side references" is precisely the
   * shape of the one gold finding this investigation ever converted. A false one
   * is expensive.
   *
   * `sideDefinitions` ships either way, so the partition stays auditable even
   * when this is `null`.
   */
  sides: z.record(z.string(), z.number().int()).nullable(),
});
export type ConstantFact = z.infer<typeof ConstantFactSchema>;

export const ConstantsPayloadSchema = z.object({
  sideDefinitions: z.record(z.string(), z.array(z.string())),
  constants: z.array(ConstantFactSchema),
});
export type ConstantsPayload = z.infer<typeof ConstantsPayloadSchema>;

export const ConstantsDocumentSchema = EnvelopeSchema.extend(ConstantsPayloadSchema.shape);
export type ConstantsDocument = z.infer<typeof ConstantsDocumentSchema>;

// ── `deps` — manifest delta + staged source ──────────────────────────────────

/**
 * The ecosystems `deps` can read a DECLARED DIRECT dependency out of.
 *
 * Measured, and the reason this list is not just `npm`: keycloak's root manifest
 * is Maven and discourse's is a Gemfile — **neither repo has a root
 * `package.json`** — so `deps` degraded outright on ~19 of the 50 corpus cases,
 * and on the mixed repos (grafana: npm + go.mod; sentry: npm + pyproject.toml)
 * it silently covered only the JS half.
 */
export const EcosystemSchema = z.enum(["npm", "go", "maven", "gradle", "bundler", "pypi"]);
export type Ecosystem = z.infer<typeof EcosystemSchema>;

export const ManifestRefSchema = z.object({
  path: z.string(),
  ecosystem: EcosystemSchema,
});
export type ManifestRef = z.infer<typeof ManifestRefSchema>;

export const DepChangeSchema = z.object({
  name: z.string(),
  /**
   * Every ecosystem's own vocabulary mapped onto npm's four, so the field is
   * comparable across a PR that touches `package.json` AND `go.mod` (grafana
   * does exactly that). Maven `test`/`provided` and Gradle `test*` → dev;
   * Bundler's `:development`/`:test` groups → dev; a python extra →
   * optional. The un-mapped raw scope is not preserved: "is this a build-time
   * dependency" is the question, and the raw string answers it differently in
   * every ecosystem.
   */
  scope: z.enum(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]),
  change: z.enum(["added", "removed", "bumped"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** Which manifest this change was read out of — a PR can touch several. */
  manifest: z.string(),
  ecosystem: EcosystemSchema,
  /** Tooling packages are noise UNLESS the config IS the diff — see `deps.ts`. */
  tooling: z.boolean(),
  /** Import sites in the changed files, including `createRequire(...)("pkg")`. */
  importedAt: z.array(z.string()),
  /** Where `npm pack` unpacked it, relative to the repo. `null` = not staged. */
  stagedAt: z.string().nullable(),
});
export type DepChange = z.infer<typeof DepChangeSchema>;

export const DepsPayloadSchema = z.object({
  /**
   * Every manifest this run READ, not just the one it defaulted to. Was a
   * single `manifest: string` hardcoded to `package.json`; cal.com has 140 of
   * them and grafana changes `package.json` and `go.mod` in one PR.
   */
  manifests: z.array(ManifestRefSchema),
  changes: z.array(DepChangeSchema),
});
export type DepsPayload = z.infer<typeof DepsPayloadSchema>;

export const DepsDocumentSchema = EnvelopeSchema.extend(DepsPayloadSchema.shape);
export type DepsDocument = z.infer<typeof DepsDocumentSchema>;

// ── `patterns` — the cheap scanners ──────────────────────────────────────────

/**
 * The common finding shape `skills/security-review/SKILL.md` §4 already
 * defines. Reused rather than reinvented, down to the fingerprint recipe.
 *
 * THESE ARE EVIDENCE, NOT FINDINGS. They seed the survey and are never posted
 * directly — a static-analyser hit rewritten prettily by an LLM and posted is
 * the anti-pattern.
 */
export const ScannerFindingSchema = z.object({
  fingerprint: z.string(),
  severity: z.enum(["p0-critical", "p1-high", "p2-medium", "p3-low"]),
  tool: z.enum(["opengrep", "gitleaks"]),
  rule: z.string(),
  file: z.string(),
  line: z.number().int(),
  title: z.string(),
});
export type ScannerFinding = z.infer<typeof ScannerFindingSchema>;

export const PatternsPayloadSchema = z.object({
  findings: z.array(ScannerFindingSchema),
});
export type PatternsPayload = z.infer<typeof PatternsPayloadSchema>;

export const PatternsDocumentSchema = EnvelopeSchema.extend(PatternsPayloadSchema.shape);
export type PatternsDocument = z.infer<typeof PatternsDocumentSchema>;

// ── `coverage` — changed lines executed by zero tests ────────────────────────

export const CoverageFormatSchema = z.enum([
  "istanbul",
  "lcov",
  "jacoco",
  "cobertura",
  "go-coverprofile",
  "simplecov",
]);
export type CoverageFormat = z.infer<typeof CoverageFormatSchema>;

export const CoveredFileSchema = z.object({
  path: z.string(),
  changedLines: z.array(z.number().int()),
  /** Changed lines the report shows as instrumented and never executed. */
  uncoveredChangedLines: z.array(z.number().int()),
  /** Changed lines the report does not instrument at all (blank, type-only…). */
  uninstrumentedChangedLines: z.array(z.number().int()),
});

export const CoveragePayloadSchema = z.object({
  /** Which artifact was read. `null` when none was found — see `degraded[]`. */
  report: z.string().nullable(),
  /**
   * istanbul + lcov were the only two, and **none of the corpus's four
   * non-JS ecosystems emits either** — so `coverage` was structurally unable to
   * answer its own question on a Java, Go, Python or Ruby PR, and answered it
   * with an empty file list, which reads as "well tested".
   */
  reportFormat: CoverageFormatSchema.nullable(),
  files: z.array(CoveredFileSchema),
  totals: z.object({
    changedLines: z.number().int(),
    uncoveredChangedLines: z.number().int(),
  }),
});
export type CoveragePayload = z.infer<typeof CoveragePayloadSchema>;

export const CoverageDocumentSchema = EnvelopeSchema.extend(CoveragePayloadSchema.shape);
export type CoverageDocument = z.infer<typeof CoverageDocumentSchema>;

// ── `all` — one envelope, every payload ──────────────────────────────────────

/**
 * The shape a workflow phase writes. One envelope (so `coverage` / `degraded[]`
 * / the toolchain stamp are read once), one file, every extractor's payload
 * under its own key. `degraded[]` is the union across extractors, and the
 * top-level `coverage` is the worst tier any of them reached.
 *
 * The payload schemas are shared with the single-extractor documents by
 * construction — `extend(shape)` above — so a field can never exist in one
 * shape and not the other.
 */
export const AllDocumentSchema = EnvelopeSchema.extend({
  extractors: z.object({
    facts: FactsPayloadSchema.optional(),
    contracts: ContractsPayloadSchema.optional(),
    constants: ConstantsPayloadSchema.optional(),
    deps: DepsPayloadSchema.optional(),
    patterns: PatternsPayloadSchema.optional(),
    coverage: CoveragePayloadSchema.optional(),
  }),
});
export type AllDocument = z.infer<typeof AllDocumentSchema>;

// ── `prepare` — the probe environment ────────────────────────────────────────

/**
 * `.lastlight/pr-review/probes/env.json` — what WP4's `prepare` phase did to the
 * tree, as a FACT rather than a substring of stdout
 * (`docs/plans/deterministic-pr-levers.md` §"Probes (WP4)").
 *
 * It is not an {@link EnvelopeSchema} document and deliberately so: `prepare`
 * makes no claim about `baseSha..headSha`, resolves no tier and runs no parser,
 * so every one of the envelope's fields would be a fabricated answer. What it
 * DOES share is the half that carries the loudness — `degraded[]` in the same
 * shape, for the same reason: an install that quietly did nothing and an install
 * that was never asked for must not be the same JSON.
 */
export const ProbeEnvSchema = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  /** `owner/name` when derivable from the remote, else the directory name. */
  repo: z.string(),
  /**
   * What resolved, in the order corepack does it: `package.json`'s
   * `packageManager` field, then the lockfile, then npm as the default for a
   * package.json with neither. `null` = no npm project at the repo root, which
   * on a Java or Go PR is the correct answer and not a failure.
   */
  packageManager: z.enum(["pnpm", "npm", "yarn", "bun"]).nullable(),
  /**
   * `installed` — this run installed them.
   * `already-present` — `node_modules` was there (the warm per-PR reuse path,
   *   which is the common case: `git clean -fdx -e node_modules`).
   * `failed` — the package manager exited non-zero or timed out.
   * `no-project` — nothing to install.
   * `skipped` — the caller did not ask.
   */
  install: z.enum(["installed", "already-present", "failed", "no-project", "skipped"]),
  /**
   * THE AFFORDANCE QUESTION, and the one field downstream phases branch on:
   * does `node_modules` exist at the end? Deliberately separate from `install`,
   * because `already-present` and `installed` are the same answer to it and
   * `failed` may still leave a partially-populated tree that resolves nothing.
   */
  installed: z.boolean(),
  /**
   * Whether the install was allowed to run the package's own lifecycle scripts.
   *
   * **Defaults to false**, which is a security decision rather than a
   * performance one: `prepare` runs against a PULL REQUEST HEAD, and a
   * `postinstall` in that tree is arbitrary code the PR author wrote executing
   * on the operator's infrastructure. The review workspace has never installed
   * anything, so this phase is the first thing in `pr-review` that could. What
   * `prepare` is actually FOR — making a package-extending `tsconfig` resolve,
   * and putting library source on disk to be read — needs the files, not their
   * scripts.
   */
  lifecycleScripts: z.boolean(),
  /**
   * `clean` / `errors` — the repo's own `tsc --noEmit` ran and said so.
   * `unavailable` — no `typescript` in the tree, or no root tsconfig; NOT a
   *   clean typecheck, and the distinction is the whole point of the field.
   * `failed` — the compiler could not be run (timeout, crash).
   * `skipped` — the caller did not ask.
   */
  typecheck: z.enum(["clean", "errors", "unavailable", "failed", "skipped"]),
  /**
   * Per-file, per-line diagnostics — which is the ONLY reason to typecheck
   * locally at all. CI already reports pass/fail and re-deriving that would be
   * duplication (locked decision 11); a diagnostic that can be attached to a
   * specific hypothesis is a different thing. Truncated to a budget, and the
   * truncation is named in `degraded[]` rather than silently applied.
   */
  typecheckDiagnostics: z.array(
    z.object({ file: z.string(), line: z.number().int(), code: z.string(), message: z.string() }),
  ),
  /**
   * `produced` — a report the `coverage` extractor can read now exists.
   * `absent` — the command ran and produced no artifact in any known format.
   *   This is the loud one: it is what stands between the `tests` family and
   *   *"well tested"*.
   * `unavailable` — no coverage command could be resolved.
   * `failed` / `skipped` — as above.
   */
  coverage: z.enum(["produced", "absent", "unavailable", "failed", "skipped"]),
  /** Repo-relative path of the artifact, when one was produced. */
  coverageReport: z.string().nullable(),
  /** Milliseconds per step, and the total the phase actually cost. */
  durationMs: z.object({
    install: z.number().int(),
    typecheck: z.number().int(),
    coverage: z.number().int(),
    total: z.number().int(),
  }),
  degraded: z.array(DegradedEntrySchema),
});
export type ProbeEnv = z.infer<typeof ProbeEnvSchema>;

// ── `findings` — the conservation gate's view of `findings.json` ─────────────

/**
 * `.lastlight/pr-review/findings.json`, as far as the WP6c **conservation
 * gate** cares — and no further
 * (`docs/plans/deterministic-pr-levers.md` §"Adjudication and the attention
 * boundary (WP6)").
 *
 * Two properties are deliberate and both are load-bearing.
 *
 * **It is LOOSE, everywhere.** The document's real contract lives in
 * `apps/server/skills/pr-review/references/findings-schema.md` and the
 * adjudicator writes a superset of it — `mechanism`, `bothEnds`, `evidence`,
 * `suggestion`, whatever WP7 adds next. `post-review` passes unknown fields
 * through untouched, so a schema here that STRIPPED them would turn the §D12
 * floor's rewrite into silent data loss: the gate would delete the evidence
 * packet in the act of preserving the finding. Hence `looseObject` at every
 * level, and hence `--repair` mutating the object it parsed from disk rather
 * than the one zod handed back.
 *
 * **It is thin.** Everything the gate does not use is optional, because a
 * second, weaker copy of `findings-schema.md` living in this package is drift
 * waiting to happen — and because a validator that rejects a document for a
 * missing `summary` would fail the loop for a reason that has nothing to do
 * with conservation. What it DOES pin is the shape the gate reads: `findings`
 * and `dropped` are arrays if they are present at all.
 */
export const ReviewFindingSchema = z.looseObject({
  // Advisory fields are `.nullish()`, not `.optional()`: models write literal
  // `null` for "nobody looked" (the package's own convention), and `.optional()`
  // rejects it — measured 2026-08-25, six of sixteen real adjudications were
  // "unreadable" to the gate on `"obligation": null` alone, each buying a
  // forced extra loop iteration AND a silently dead repair (`--repair` refuses
  // an unreadable document). Same principle as the DroppedHypothesisSchema
  // comment below: a floor that can crash on advisory data is not a floor.
  path: z.string().nullish(),
  /** The verbatim excerpt; the anchor of record. `line` is derived, advisory. */
  existingCode: z.string().nullish(),
  severity: z.string().nullish(),
  title: z.string().nullish(),
  body: z.string().nullish(),
  family: z.string().nullish(),
  obligation: z.string().nullish(),
  confidence: z.number().nullish(),
  /**
   * Where it goes. `internal` is *recorded and never posted* — the auditable
   * tier, not a dark drop. Absent means the adjudicator did not tier it, which
   * `post-review` reads as today's behaviour.
   */
  tier: z.enum(["inline", "body", "internal"]).optional(),
  /**
   * The hypothesis ids this finding discharges. **Optional on purpose**: a
   * finding with none is the shipped reviewer's own, which was never
   * hypothesis-derived, and requiring the field would delete the reviewer we
   * already have.
   */
  hypotheses: z.array(z.string()).optional(),
});
export type ReviewFinding = z.infer<typeof ReviewFindingSchema>;

/**
 * A deletion, and the only sanctioned kind. `refutedBy` names a probe
 * transcript, and the gate checks that the file EXISTS — a refutation by
 * argument is the intervention that raised precision 54.5 → 67.1 and cut recall
 * 45.5 → 39.8 in the measurement this pipeline is a reaction to.
 */
export const DroppedHypothesisSchema = z.looseObject({
  /**
   * Optional **here** and required by the gate, which is not the same thing.
   * A drop with no id is a deletion of something unnameable and it fails
   * `checkFindings` with a message that says so — but if this schema rejected
   * it, two things would go wrong at once: the whole document would read as
   * *"unparseable"* (a zod dump instead of the actionable line the next loop
   * iteration needs), and the §D12 floor's pre-write validation would THROW on
   * a document it was in the middle of rescuing. A floor that can crash is not
   * a floor.
   */
  hypothesis: z.string().nullish(),
  refutedBy: z.string().nullish(),
  reason: z.string().nullish(),
});
export type DroppedHypothesis = z.infer<typeof DroppedHypothesisSchema>;

export const FindingsDocumentSchema = z.looseObject({
  findings: z.array(ReviewFindingSchema).optional(),
  dropped: z.array(DroppedHypothesisSchema).optional(),
  /**
   * The internal-tier id-list shorthand: hypotheses filed at `internal` by
   * canonical id alone, instead of a full finding row each. Measured
   * 2026-08-25, internal rows were 57% of findings.json bytes (up to 92% on
   * one case) while their prose degenerates to verification boilerplate the
   * deterministic materializer reproduces from the hypothesis record anyway.
   * The conservation gate credits each id exactly like a finding's
   * `hypotheses[]` entry; reconcile's `--repair` expands the list into full
   * rows, so every reader downstream of reconcile sees the classic shape.
   */
  internal: z.array(z.string()).nullish(),
});
export type FindingsDocument = z.infer<typeof FindingsDocumentSchema>;

export const DOCUMENT_SCHEMAS = {
  facts: FactsDocumentSchema,
  contracts: ContractsDocumentSchema,
  constants: ConstantsDocumentSchema,
  deps: DepsDocumentSchema,
  patterns: PatternsDocumentSchema,
  coverage: CoverageDocumentSchema,
  all: AllDocumentSchema,
} as const;

export type ExtractorName = keyof typeof DOCUMENT_SCHEMAS;
