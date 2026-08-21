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

export const EnvelopeSchema = z.object({
  version: z.literal(1),
  generatedAt: z.iso.datetime(),
  extractor: z.string(),
  /** `owner/name` when derivable from the remote, else the directory name. */
  repo: z.string(),
  baseSha: z.string(),
  headSha: z.string(),
  tier: TierSchema,
  coverage: z.enum(["full", "degraded", "none"]),
  degraded: z.array(DegradedEntrySchema),
  toolchain: ToolchainStampSchema,
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

export const SymbolFactSchema = z.object({
  name: z.string(),
  kind: z.string(),
  exported: z.boolean(),
  declaredAt: z.string(),
  changedHunks: z.array(z.string()),
  references: z.array(ReferenceSchema),
  implementations: z.array(z.string()),
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
  /** A — every reference to the identifier (ts-morph). */
  references: z.array(z.string()),
  /**
   * B \ A — every occurrence of the literal VALUE that does NOT go through the
   * constant (ast-grep). The subtraction is the insight.
   */
  hardCodedDuplicates: z.array(z.string()),
  /**
   * A heuristic path-prefix partition of `references`. A constant defined in
   * config, read by the client and never compared server-side is exactly the
   * `1587-r2` Critical. It is A HINT FOR THE SEEDER, never a finding on its own.
   */
  sides: z.record(z.string(), z.number().int()),
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

export const DepChangeSchema = z.object({
  name: z.string(),
  scope: z.enum(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]),
  change: z.enum(["added", "removed", "bumped"]),
  before: z.string().nullable(),
  after: z.string().nullable(),
  /** Tooling packages are noise UNLESS the config IS the diff — see `deps.ts`. */
  tooling: z.boolean(),
  /** Import sites in the changed files, including `createRequire(...)("pkg")`. */
  importedAt: z.array(z.string()),
  /** Where `npm pack` unpacked it, relative to the repo. `null` = not staged. */
  stagedAt: z.string().nullable(),
});
export type DepChange = z.infer<typeof DepChangeSchema>;

export const DepsPayloadSchema = z.object({
  manifest: z.string(),
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
  reportFormat: z.enum(["istanbul", "lcov"]).nullable(),
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
