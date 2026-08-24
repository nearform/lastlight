/**
 * `seed` — turn an `all` envelope into **mechanism-complete obligations**.
 *
 * A pure transform over a document this package already emits. No repo access,
 * no compiler, no network: hand it `facts.json`, get `obligations.json`. That is
 * what makes it testable against real envelopes rather than through a harness,
 * and it is why the seeder lives here rather than in `apps/server`.
 *
 * ## The one rule that governs the format
 *
 * > **A seed naming one end of a defect mechanism is worse than no seed.**
 *
 * IRIS's ablation: CodeQL sources + LLM sinks = +9; **LLM sources + CodeQL
 * sinks = −3, actively worse than seeding nothing**; both ends = +28, roughly
 * 2× recall. So `introducedAt` and `enforcedAt` are both REQUIRED, a one-ended
 * obligation fails validation, and every drop is counted with a reason in the
 * document. Never silently — a truncated list that looks complete is the
 * dependency-cruiser failure mode locked decision 6 exists to prevent.
 *
 * `enforcedAt.found: false` with a `candidates` list is a *valid* second end.
 * "We looked here and found nothing" is a mechanism, and it is the one that
 * converted. What is invalid is omitting the field.
 *
 * ## And the rule that governs the QUESTION
 *
 * v3's lesson 1: seeding works at **question granularity**. *"Check this area"*
 * earns an honest CLEAN, because an obligation one abstraction level too high is
 * discharged AT THAT LEVEL and the defect lives below it. *"Quote the line that
 * enforces THIS constant"* produced the only gold match the investigation has.
 * So every `question` is answerable by quoting one line, or by stating that no
 * such line exists.
 *
 * ## What the families are built FROM, and why not from what you would guess
 *
 * Measured 2026-08-22 on the eight `skillspro` cases the gates are read on
 * (`03-seed-and-survey.md` §"Measured 2026-08-22"):
 *
 * - **`enforcement` is built from the SUBTRACTION, never from `sides`.** `sides`
 *   is a heuristic path partition and it is **inert** on the gate repo — all 14
 *   constants of `1587-r2` partition to `shared`, with `client: 0, server: 0`,
 *   because nobody configured `--sides` for it. The `1587-r2` mechanism *is*
 *   "referenced client-side, never compared server-side", so the one field that
 *   would have expressed it is the one that is empty. `references` and
 *   `hardCodedDuplicates` are populated, and their relationship is the
 *   mechanism: a value referenced twice and hard-coded sixteen times elsewhere
 *   is a boundary nobody is enforcing.
 * - **`security` does not treat scanners as a discovery axis.** With both
 *   binaries installed the corpus produced 13 real `patterns` findings and
 *   **+0 EC-loose** — not one pointed at a place any gold finding was about. So
 *   the sink half comes from the impact cone and a scanner hit is *corroboration
 *   on an obligation that already exists*, never the reason one exists.
 * - **`tests` is inert until [WP4]'s `prepare`.** `coverage` READS a report and
 *   nothing produces one: 0 artifacts across 50 corpus cases and 8 gate cases.
 *   It is reported `notMeasured`, never "did not convert".
 * - **`spec` is not produced here at all.** It is seeded from the PR body and
 *   the linked issue, which this package cannot see; it is WP0's
 *   `review-spec.ts`, harness-side, and already shipped.
 *
 * ## The coverage set is SEALED
 *
 * Taken from `alibaba/open-code-review`. Every obligation is registered before
 * any model call and the denominator is then frozen, so a run cannot grow its
 * denominator to match what it achieved — which is the only way it can lie. The
 * terminal state is derived from coverage alone, never from a finding count:
 * `selected == 0` is **skipped**, not success, and anything short of full is
 * **partial**. That is the state §D12 lacked — loud in the artifact about work
 * never done, without failing the run and re-arming the 30-minute re-dispatch
 * loop.
 */
import type { AllDocument, ConstantFact, ContractDelta, SymbolFact } from "./schema.js";
import { type LoggerPort, noopLogger } from "./log.js";

/** The five families this package can seed. `spec` is WP0's and is not here. */
export const SEEDABLE_FAMILIES = ["contract", "enforcement", "security", "state", "tests"] as const;
export type SeedFamily = (typeof SEEDABLE_FAMILIES)[number];

/** One end of a mechanism, at a quotable site. */
export interface MechanismEnd {
  path: string;
  line: number;
  /** The source text at `line`, so the obligation is checkable without the repo. */
  quote: string;
}

/**
 * The second end. `found: false` is the claim, not a placeholder — we have
 * verified nothing. Typed as the literal so no caller can emit a half-verified
 * obligation by flipping it.
 */
export interface EnforcementEnd {
  candidates: string[];
  found: false;
}

export interface Obligation {
  /** `O-001`, … — stable within one document, referenced by the hypothesis. */
  id: string;
  family: SeedFamily;
  /** The defect shape, in one clause. Not a finding; a question's premise. */
  mechanism: string;
  introducedAt: MechanismEnd;
  enforcedAt: EnforcementEnd;
  /** Answerable by quoting ONE line, or by stating no such line exists. */
  question: string;
  /** Where in the envelope this came from, so a hypothesis can be traced back. */
  evidence: { type: string; ref: string }[];
  discharge: "quote" | "probe" | "either";
  /** Ranking score, retained so a truncation is auditable rather than opaque. */
  rank: number;
}

/** Why an obligation was not emitted. Counted, never silent. */
export interface DroppedReason {
  reason: string;
  count: number;
}

export interface CoverageSet {
  /** Registered before dispatch, then frozen. */
  selected: string[];
  sealed: true;
  /** Nothing has run yet — the survey phases transition these. */
  reviewed: string[];
  failed: string[];
  waived: string[];
  terminalState: "pending";
}

/**
 * Which obligation block the seeder rendered — the CONTROL for the 2026-08-23
 * result, and it is deliberately a document field rather than a render-time
 * argument.
 *
 * `full` is `5fa06da1`'s block: a mandatory discharge contract, an un-truncated
 * id checklist, and one worked exemplar. `minimal` is the block as it stood
 * BEFORE that commit — the same obligations, delivered just as reliably (the
 * `context_file` half of the fix is not part of this switch), asking the OLD
 * question, with no field to record a discharge code in and nothing to tick off.
 *
 * It is stamped into `obligations.json` because THREE readers have to agree
 * about it and only one of them renders: `seed-render.ts` (what the survey is
 * asked), `discharge.ts` (what the gate demands back) and whoever reads the
 * artifact months later asking which arm produced this run. A render-time flag
 * would let the block and the gate disagree, which is exactly the separability
 * this pipeline keeps paying for.
 */
export const OBLIGATION_CONTRACTS = ["full", "minimal"] as const;
export type ObligationContract = (typeof OBLIGATION_CONTRACTS)[number];

export function isObligationContract(value: unknown): value is ObligationContract {
  return typeof value === "string" && (OBLIGATION_CONTRACTS as readonly string[]).includes(value);
}

/**
 * Which of the two D2 minting arms were asked for — the `--mint` toggle,
 * `review.analysis.mint` operator-side.
 *
 * Both default FALSE: the baseline document is byte-identical with the flag
 * absent, which is what makes an arm's number attributable to the arm.
 */
export interface MintOptions {
  /** D2a — `seedAllInDiff`: contract obligations for all-in-diff symbols. */
  allInDiff: boolean;
  /** D2b — `seedRegistrations`: security obligations for route/hook order. */
  registrations: boolean;
}

export interface ObligationsDocument {
  version: 1;
  generatedAt: string;
  /**
   * PROVENANCE — which block the five family files carry, and which contract the
   * `discharge` gate is entitled to grade against. Absent on a document written
   * before the switch existed, which reads as `full` (see {@link ObligationContract}).
   */
  contract: ObligationContract;
  /**
   * PROVENANCE, exactly as `contract` above — which D2 minting arms produced
   * this document, stamped so the artifact answers "which arm produced this"
   * months later. Absent on a document written before the toggle existed,
   * which reads as both false.
   */
  minting: MintOptions;
  repo: string;
  baseSha: string;
  headSha: string;
  /** Inherited from the facts envelope — never recomputed, never upgraded. */
  coverage: "full" | "degraded" | "none";
  degraded: { extractor: string; reason: string }[];
  /** Every family, including the ones that produced nothing and WHY. */
  families: {
    family: SeedFamily | "spec";
    obligations: number;
    /** `false` ⇒ the seeding surface was absent, not empty. Never confuse them. */
    measured: boolean;
    notMeasuredReason: string | null;
  }[];
  obligations: Obligation[];
  dropped: DroppedReason[];
  coverageSet: CoverageSet;
}

export interface SeedOptions {
  /** `review.analysis.maxObligations`. A BUDGET, so the seeder ranks. */
  maxObligations?: number;
  /**
   * `review.analysis.obligationContract`. Default `full` — today's block,
   * byte-identical. See {@link ObligationContract}.
   */
  contract?: ObligationContract;
  /**
   * `review.analysis.mint` → `--mint`. Default both false, so the baseline
   * document is untouched unless an arm is asked for by name. See
   * {@link MintOptions}.
   */
  mint?: MintOptions;
  log?: LoggerPort;
}

const DEFAULT_MAX_OBLIGATIONS = 40;

/**
 * Mechanism class, strongest first. `contract` and `enforcement` are the two
 * that have ever converted, so they win a tie against a bigger impact cone.
 */
const FAMILY_WEIGHT: Record<SeedFamily, number> = {
  enforcement: 100,
  contract: 90,
  state: 50,
  security: 40,
  tests: 10,
};

/**
 * Is this constant's VALUE distinctive enough that a second occurrence of it is
 * evidence rather than coincidence?
 *
 * **Numbers and booleans never are.** `10`, `300`, `true` recur across any
 * repository for unrelated reasons, so "the literal appears at 16 other sites"
 * is a statement about arithmetic, not about a boundary. Their mechanism is not
 * duplication at all — it is *enforcement*: a max-age that nothing compares, a
 * page size that nothing bounds. That is the `1587-r2` shape and it is the one
 * that converted.
 *
 * A string qualifies at six characters or more. `"sn"` (a cookie name) collides
 * with prose and identifiers everywhere; `"redirectSignInPending"` and
 * `"nearform.com"` do not, and a second write of one really is a site that will
 * not follow a change to the constant.
 */
function isDiscriminating(c: ConstantFact): boolean {
  if (c.valueKind !== "string") return false;
  const raw = c.value.replace(/^(["'`])(.*)\1$/, "$2");
  return raw.length >= 6;
}

/**
 * A test path, by the same spellings `langs/tsjs.ts` recognises.
 *
 * Used as a **rank penalty, never a filter**. A mechanism whose both ends are
 * inside the test suite is a statement about the tests, not about the product,
 * and it should not outrank one that crosses a real boundary — which it did:
 * `COOKIES_SECRET`, declared at `auth.test.ts:13` and referenced once at
 * `auth.test.ts:19`, ranked ABOVE `SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS`, the
 * constant whose obligation produced the only gold match this investigation has.
 *
 * Penalised rather than dropped because a test-only constant genuinely can be a
 * finding (a fixture that no longer matches production is a real defect), and
 * this layer generates hypotheses rather than filtering them. It goes to the
 * back of the budget, not off the list.
 */
function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__|spec)\//.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path);
}

/** Every site is a test file — so both ends of the mechanism are in the suite. */
function whollyInTests(introduced: string, candidates: string[]): boolean {
  return (
    isTestPath(introduced) &&
    candidates.length > 0 &&
    candidates.every((c) => isTestPath(splitSite(c)?.path ?? c))
  );
}

/** How much a wholly-in-tests mechanism gives up. Enough to lose every tie. */
const TEST_ONLY_PENALTY = 60;

/** `path:line` → the pair, or `null` for anything that is not one. */
function splitSite(site: string): { path: string; line: number } | null {
  const i = site.lastIndexOf(":");
  if (i <= 0) return null;
  const line = Number(site.slice(i + 1));
  return Number.isInteger(line) && line > 0 ? { path: site.slice(0, i), line } : null;
}

/**
 * An obligation is only emitted when BOTH ends exist. This is the validation the
 * module header is about, and it returns a REASON rather than a boolean so the
 * drop can be counted in the document.
 */
export function validateObligation(o: Obligation): string | null {
  if (!o.introducedAt.path || o.introducedAt.line <= 0) {
    return "introducedAt is missing a quotable site — one-ended, dropped (IRIS: a half mechanism scores -3, worse than no seed)";
  }
  if (!o.introducedAt.quote.trim()) {
    return "introducedAt has no quote — an obligation the model cannot check without re-deriving it is one-ended in practice";
  }
  if (o.enforcedAt.candidates.length === 0) {
    return "enforcedAt names no candidates — one-ended, dropped (IRIS: a half mechanism scores -3, worse than no seed)";
  }
  if (!o.question.trim()) return "question is empty";
  return null;
}

// ---------------------------------------------------------------------------
// the families
// ---------------------------------------------------------------------------

/**
 * `enforcement` — a value is defined on one side of a boundary; who checks it on
 * the other?
 *
 * The both-ends shape is **the subtraction**, for the reason in the module
 * header: `sides` is frequently `null` or all-`shared`, and the subtraction is
 * always populated on tier 1. Two mechanisms, in priority order:
 *
 * 1. The value is **hard-coded elsewhere** — every duplicate is a site that does
 *    not go through the constant, so a change to the constant does not reach it.
 * 2. The value is referenced but **never compared** — the `1587-r2` shape, where
 *    a max-age exists and nothing enforces it. The candidates are the reference
 *    sites themselves, and `found: false` says we have checked none of them.
 */
function seedEnforcement(constants: ConstantFact[]): Obligation[] {
  const out: Obligation[] = [];
  for (const [index, c] of constants.entries()) {
    const site = splitSite(c.declaredAt);
    if (!site) continue;

    // `references: null` means tier 2 had no compiler — NOBODY LOOKED. An
    // obligation built on it would assert an absence the document does not
    // claim, which is the exact over-reach this package refuses.
    const references = c.references;
    const duplicates = c.hardCodedDuplicates;

    // Only a DISCRIMINATING value makes duplication a mechanism. Caught by
    // reading the first real output: `MAX_PENDING_SILENT_SIGN_IN_NONCES = 10`
    // reported "16 other sites hard-code 10" and named
    // `lengthAnalysis.test.ts:281`, `sessionManager.test.ts:91` — occurrences of
    // the bare number 10, which is coincidence, not a boundary. That obligation
    // then RANKED FIRST (16 duplicates) and pushed real mechanisms down the
    // budget.
    //
    // The extractor is right to report every occurrence — it emits evidence,
    // not findings, and filtering there would delete something nothing
    // downstream could recover. Ranking is the seeder's job, and this is it.
    const viaDuplicates = duplicates.length > 0 && isDiscriminating(c);
    const candidates = viaDuplicates ? duplicates : (references ?? []);
    if (candidates.length === 0) continue;
    out.push({
      id: "",
      family: "enforcement",
      mechanism: viaDuplicates
        ? `the value ${c.value} is declared as ${c.constant} and ALSO written literally at ${duplicates.length} other site(s), so a change to the constant does not reach them`
        : `${c.constant} is referenced ${references?.length ?? 0} time(s) and may never be compared or enforced on the other side of its boundary`,
      introducedAt: { path: site.path, line: site.line, quote: `const ${c.constant} = ${c.value}` },
      enforcedAt: { candidates: candidates.slice(0, 8), found: false },
      question: viaDuplicates
        ? `Quote the line at each candidate that reads ${c.constant}, or state that the site hard-codes ${c.value} and would not follow a change to the constant.`
        : `Quote the line that compares or enforces ${c.constant}, or state that no such line exists.`,
      evidence: [{ type: "constant", ref: `constants.constants[${index}]` }],
      discharge: "quote",
      // A constant with many duplicates and few references is the strongest
      // shape there is: the value is load-bearing and the constant is not.
      // A DISCRIMINATING value duplicated widely is the strongest shape there
      // is. An enforcement question ranks on how FEW references there are — one
      // or two references to a bound is what "nothing compares this" looks like,
      // and forty is a value that is plainly in use.
      rank:
        FAMILY_WEIGHT.enforcement +
        (viaDuplicates
          ? Math.min(duplicates.length, 20)
          : Math.max(0, 12 - (references?.length ?? 0))) -
        (whollyInTests(site.path, candidates) ? TEST_ONLY_PENALTY : 0),
    });
  }
  return out;
}

/**
 * `contract` — a producer's shape moved; does every consumer OUTSIDE the diff
 * still satisfy it?
 *
 * `consumersOutsideDiff` is the second end and the whole point: a consumer the
 * diff did not touch is the one that reads correctly in isolation and is wrong
 * in composition, which is precisely what a file-by-file review cannot see.
 */
function seedContract(contracts: ContractDelta[]): Obligation[] {
  const out: Obligation[] = [];
  for (const [index, d] of contracts.entries()) {
    if (d.consumersOutsideDiff.length === 0) continue;
    // An `added` export has no prior shape for a consumer to have depended on,
    // so there is no contract mechanism — only a new API.
    if (d.change === "added") continue;

    const before = d.before?.signature ?? "(absent)";
    const after = d.after?.signature ?? "(removed)";
    out.push({
      id: "",
      family: "contract",
      mechanism: `${d.symbol}'s exported shape ${d.change} from \`${before}\` to \`${after}\`, and ${d.consumersOutsideDiff.length} consumer(s) outside this diff were not updated with it`,
      introducedAt: { path: d.file, line: 1, quote: `export ${d.symbol}: ${after}` },
      enforcedAt: { candidates: d.consumersOutsideDiff.slice(0, 8), found: false },
      question: `Quote the line at each consumer that still satisfies ${d.symbol}'s NEW shape, or state which one does not.`,
      evidence: [{ type: "contract", ref: `contracts.contracts[${index}]` }],
      discharge: "quote",
      rank:
        FAMILY_WEIGHT.contract +
        Math.min(d.consumersOutsideDiff.length, 20) +
        (d.change === "removed" ? 5 : 0) -
        (whollyInTests(d.file, d.consumersOutsideDiff) ? TEST_ONLY_PENALTY : 0),
    });
  }
  return out;
}

/**
 * `state` — the impact cone. A symbol whose shape changed and whose references
 * are MOSTLY OUTSIDE the diff.
 *
 * `referencesInDiff / referenceCount` is the ranking axis the plan names as the
 * single most productive field, and the ratio is what carries it: forty callers
 * of which two were touched is a different risk from two callers of which two
 * were touched, and the raw count cannot tell them apart.
 */
function seedState(symbols: SymbolFact[]): Obligation[] {
  const out: Obligation[] = [];
  for (const [index, s] of symbols.entries()) {
    const outside = s.references.filter((r) => !r.inDiff);
    if (outside.length === 0) continue;
    if (s.changedHunks.length === 0) continue;

    const site = splitSite(s.declaredAt);
    if (!site) continue;

    const ratio = s.referenceCount > 0 ? outside.length / s.referenceCount : 0;
    out.push({
      id: "",
      family: "state",
      mechanism: `${s.name} changed in this diff and is used at ${outside.length} site(s) the diff did not touch — ordering, lifecycle or invalidation there is not visible file-by-file`,
      introducedAt: { path: site.path, line: site.line, quote: `${s.kind} ${s.name}` },
      enforcedAt: { candidates: outside.slice(0, 8).map((r) => r.at), found: false },
      question: `Quote the line at each untouched call site that still holds after ${s.name}'s change, or name the one whose assumption it breaks.`,
      evidence: [{ type: "symbol", ref: `facts.symbols[${index}]` }],
      // `name-match` sites are HYPOTHESES, not a resolved reference set, so they
      // are worth asking about and not worth asserting from.
      discharge: s.resolution === "name-match" ? "either" : "quote",
      rank:
        FAMILY_WEIGHT.state +
        Math.round(ratio * 20) +
        (s.exported ? 5 : 0) -
        (whollyInTests(site.path, outside.map((r) => r.at)) ? TEST_ONLY_PENALTY : 0),
    });
  }
  return out;
}

/**
 * `security` — attacker-controlled input reaching a changed sink.
 *
 * **The scanners are corroboration, not discovery.** Measured on the corpus:
 * 13 real `patterns` findings, +0 EC-loose — not one pointed at a place a gold
 * finding was about. So this walks the impact cone for the sink half exactly as
 * `state` does, and a scanner hit in the same FILE is attached as extra evidence
 * on an obligation that already exists. A `patterns` hit never creates one.
 */
function seedSecurity(symbols: SymbolFact[], patternFiles: Map<string, number[]>): Obligation[] {
  const out: Obligation[] = [];
  for (const [index, s] of symbols.entries()) {
    const site = splitSite(s.declaredAt);
    if (!site) continue;
    const hits = patternFiles.get(site.path);
    if (!hits || hits.length === 0) continue;
    if (s.references.length === 0) continue;

    out.push({
      id: "",
      family: "security",
      mechanism: `${s.name} changed in a file a scanner also flagged (${hits.length} hit(s)), and it is reachable from ${s.references.length} site(s) — the question is whether any of them carries attacker-controlled input`,
      introducedAt: { path: site.path, line: site.line, quote: `${s.kind} ${s.name}` },
      enforcedAt: { candidates: s.references.slice(0, 8).map((r) => r.at), found: false },
      question: `Quote the line that validates or escapes the input reaching ${s.name}, or state that the path from each caller is unvalidated.`,
      evidence: [
        { type: "symbol", ref: `facts.symbols[${index}]` },
        ...hits.map((h) => ({ type: "pattern", ref: `patterns.findings[${h}]` })),
      ],
      discharge: "either",
      rank:
        FAMILY_WEIGHT.security +
        Math.min(hits.length, 10) -
        (whollyInTests(site.path, s.references.map((r) => r.at)) ? TEST_ONLY_PENALTY : 0),
    });
  }
  return out;
}

/**
 * D2a's rank base. Between security (40) and state (50), far below contract
 * (90): an all-in-diff symbol has NO consumer outside the change constraining
 * it, which is a weaker mechanism class than a contract a known outside
 * consumer depends on, and weaker than a state cone reaching outside the diff.
 */
const ALL_IN_DIFF_WEIGHT = 45;

/**
 * The kinds a caller can be SURPRISED by at runtime. Pure types, interfaces
 * and enums have no runtime line a caller cannot see — a retry policy, a
 * timeout, a swallowed error class lives in a function body, a method body, a
 * class or a variable initialiser, nowhere else.
 */
const RUNTIME_KINDS = new Set(["function", "method", "variable", "class"]);

/**
 * D2a — `contract` obligations for symbols whose EVERY reference is inside the
 * diff.
 *
 * NOT an extension of {@link seedContract}, which reads ContractDelta exports
 * and needs a consumer OUTSIDE the diff; and NOT {@link seedState}, whose
 * predicate (`outside.length > 0` — at least one reference site outside the
 * diff) is the exact COMPLEMENT of this one: a symbol whose uncapped counts
 * say every reference is in-diff cannot show an outside site in the capped
 * array, so the two seeders structurally cannot double-mint on one symbol.
 *
 * The predicate reads the UNCAPPED counts (`referencesInDiff === referenceCount`),
 * never the capped `references[]` array: on a capped array
 * `.every(r => r.inDiff)` can be vacuously true while uncounted references sit
 * outside the diff, which would mint a "no consumer outside the change" claim
 * over references nobody recorded. `tests/seed.test.ts` pins that regression.
 *
 * A zero-reference symbol builds an obligation with no candidates and is
 * dropped — COUNTED, never silent — by `validateObligation`'s ≥1-candidate
 * gate: "no consumer constrains this" with nowhere to look is one-ended.
 */
function seedAllInDiff(symbols: SymbolFact[]): Obligation[] {
  const out: Obligation[] = [];
  for (const [index, s] of symbols.entries()) {
    if (s.changedHunks.length === 0) continue;
    // The UNCAPPED counts — see the doc comment. `referenceCount > 0` is NOT
    // an early filter here: a zero-reference symbol falls through to the
    // validation gate, whose drop is counted in `dropped[]`.
    if (s.referencesInDiff !== s.referenceCount) continue;
    if (!RUNTIME_KINDS.has(s.kind)) continue;
    const site = splitSite(s.declaredAt);
    if (!site) continue;

    const candidates = s.references.map((r) => r.at).slice(0, 8);
    out.push({
      id: "",
      family: "contract",
      mechanism: `${s.name} is changed in this diff and every one of its ${s.referenceCount} reference(s) is also inside the diff — no consumer outside the change constrains it, and a caller-side surprise is invisible file-by-file`,
      introducedAt: { path: site.path, line: site.line, quote: `${s.kind} ${s.name}` },
      enforcedAt: { candidates, found: false },
      // The last sentence is load-bearing: the 8-case D2 confirm measured this
      // question's escape hatch being answered with FUTURE hypotheticals
      // ("nothing prevents a maintainer from…") — 7 and 5 of them posted on the
      // zero-gold canary at precision 0. A hazard that needs a future edit is
      // a clean discharge, not a finding, and the question must say so itself.
      question: `Every consumer of ${s.name} is inside this diff. Quote the line inside ${s.name} a caller cannot see and would be surprised by — a retry policy, a timeout, a swallowed error class, a partial result returned as success — or state that no such line exists. Only what the code as written does TODAY counts: a hazard that requires a future edit ("nothing prevents someone from…", "if this is later renamed…") is NOT a finding — record the clean discharge instead.`,
      evidence: [{ type: "symbol", ref: `facts.symbols[${index}]` }],
      // `name-match` sites are HYPOTHESES, not a resolved reference set — the
      // same rule seedState applies.
      discharge: s.resolution === "name-match" ? "either" : "quote",
      rank:
        ALL_IN_DIFF_WEIGHT +
        (s.exported ? 5 : 0) +
        Math.min(s.referenceCount, 5) -
        (whollyInTests(site.path, candidates) ? TEST_ONLY_PENALTY : 0),
    });
  }
  return out;
}

/**
 * D2b — `security` obligations for a changed symbol that REGISTERS routes,
 * hooks or middleware: whether a caller is rejected before the handler body
 * runs depends on the registration ORDER, and no single file shows it.
 *
 * `family: "security"` on purpose — no new family: SEEDABLE_FAMILIES, the
 * survey branch list and the pr-review.yaml family loop all stay untouched,
 * and an ordering-of-rejection question is the security family's question.
 *
 * Co-firing with {@link seedState} and {@link seedSecurity} on one symbol is
 * DELIBERATE, not a dedupe bug: they ask different questions of the same
 * symbol (untouched call sites; scanner-corroborated input paths; registration
 * order), and deleting one because another fired would delete a question
 * nothing downstream could recover.
 *
 * KNOWN LIMITATION, by construction of the extractor: a module-level
 * `app.get(...)` outside any named declaration attaches to no symbol, so a
 * file that registers its routes at the top level mints nothing here. The
 * registration walk is tier-1 only — tier 2 carries `registrations: null`
 * (nobody looked), which this predicate distinguishes from `[]` (looked,
 * found none): neither mints, for opposite reasons.
 */
function seedRegistrations(symbols: SymbolFact[]): Obligation[] {
  const out: Obligation[] = [];
  for (const [index, s] of symbols.entries()) {
    // `?? null` — a pre-D2 document has no field at all, which reads as
    // "nobody looked", exactly as tier 2's explicit `null` does.
    const regs = s.registrations ?? null;
    if (regs === null || regs.length === 0) continue;
    if (s.changedHunks.length === 0) continue;
    if (!splitSite(s.declaredAt)) continue;
    const first = splitSite(regs[0].at);
    if (!first) continue;

    const ordered = [...regs].sort((a, b) => a.ordinal - b.ordinal);
    const candidates = ordered.map((r) => r.at).slice(0, 8);
    const phases = ordered.map((r) => r.phase ?? "unnamed").join(" → ");
    out.push({
      id: "",
      family: "security",
      mechanism: `${s.name} registers ${ordered.length} handler(s)/hook(s) in a fixed order (${phases}) — whether a caller is rejected before the handler runs depends on that order, and no single file shows it`,
      introducedAt: {
        path: first.path,
        line: first.line,
        quote: `${ordered[0].call}(${ordered[0].phase ?? "…"})`,
      },
      enforcedAt: { candidates, found: false },
      question: `Order the phases ${s.name} registers. Quote the EARLIEST registered line that rejects an unauthenticated or malformed caller, and name every registration that runs before it — or state that no registration rejects one before the handler body runs.`,
      evidence: [{ type: "symbol", ref: `facts.symbols[${index}]` }],
      // Ordering may be readable (quote the earliest rejecting line) or need a
      // run to settle — the same `either` the security family already uses.
      discharge: "either",
      rank:
        FAMILY_WEIGHT.security +
        Math.min(ordered.length, 8) +
        (s.exported ? 2 : 0) -
        (whollyInTests(first.path, candidates) ? TEST_ONLY_PENALTY : 0),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// the seeder
// ---------------------------------------------------------------------------

/**
 * Build the obligation document from an `all` envelope.
 *
 * Ordering is by rank descending, then by id for stability, and the budget
 * truncates the TAIL — so what survives is what the ranking says converts, and
 * what was dropped is counted rather than vanished.
 */
export function seedObligations(doc: AllDocument, options: SeedOptions = {}): ObligationsDocument {
  const log = options.log ?? noopLogger;
  const max = options.maxObligations ?? DEFAULT_MAX_OBLIGATIONS;
  const x = doc.extractors;

  const patternFiles = new Map<string, number[]>();
  (x.patterns?.findings ?? []).forEach((f, i) => {
    const list = patternFiles.get(f.file) ?? [];
    list.push(i);
    patternFiles.set(f.file, list);
  });

  // The D2 arms run ONLY when asked for by name: with the toggle absent the
  // candidate list — and therefore the document — is byte-identical baseline.
  const mint: MintOptions = {
    allInDiff: options.mint?.allInDiff ?? false,
    registrations: options.mint?.registrations ?? false,
  };

  const candidates: Obligation[] = [
    ...seedEnforcement(x.constants?.constants ?? []),
    ...seedContract(x.contracts?.contracts ?? []),
    ...seedState(x.facts?.symbols ?? []),
    ...seedSecurity(x.facts?.symbols ?? [], patternFiles),
    ...(mint.allInDiff ? seedAllInDiff(x.facts?.symbols ?? []) : []),
    ...(mint.registrations ? seedRegistrations(x.facts?.symbols ?? []) : []),
  ];

  const dropCounts = new Map<string, number>();
  const drop = (reason: string): void => {
    dropCounts.set(reason, (dropCounts.get(reason) ?? 0) + 1);
  };

  const valid = candidates.filter((o) => {
    const problem = validateObligation(o);
    if (problem) drop(problem);
    return problem === null;
  });

  valid.sort((a, b) => b.rank - a.rank || a.family.localeCompare(b.family));
  const kept = valid.slice(0, max);
  if (valid.length > max) {
    drop(
      `over the per-PR budget of ${max} (review.analysis.maxObligations) — ranked by mechanism class then by how much of the impact cone lies outside the diff. These are NOT "checked"`,
    );
    // Count the truncation once per dropped obligation so the number is the
    // number, not the number of reasons.
    dropCounts.set(
      `over the per-PR budget of ${max} (review.analysis.maxObligations) — ranked by mechanism class then by how much of the impact cone lies outside the diff. These are NOT "checked"`,
      valid.length - max,
    );
  }

  kept.forEach((o, i) => {
    o.id = `O-${String(i + 1).padStart(3, "0")}`;
  });

  const counts = new Map<SeedFamily, number>();
  for (const o of kept) counts.set(o.family, (counts.get(o.family) ?? 0) + 1);

  const coverageRead = x.coverage?.report != null;
  const families: ObligationsDocument["families"] = [
    ...SEEDABLE_FAMILIES.map((family) => ({
      family: family as SeedFamily | "spec",
      obligations: counts.get(family) ?? 0,
      measured: family === "tests" ? coverageRead : true,
      notMeasuredReason:
        family === "tests" && !coverageRead
          ? "no coverage artifact was read, so uncovered changed lines are UNKNOWN rather than none — nothing produces one until WP4's prepare"
          : null,
    })),
    {
      family: "spec" as const,
      obligations: 0,
      measured: false,
      notMeasuredReason:
        "seeded from the PR body and the linked issue, which this package cannot see — built harness-side by review-spec.ts (WP0)",
    },
  ];

  const contract = options.contract ?? "full";

  log.info?.("seeded obligations", {
    candidates: candidates.length,
    valid: valid.length,
    kept: kept.length,
    coverage: doc.coverage,
    contract,
    minting: mint,
  });

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    contract,
    minting: mint,
    repo: doc.repo,
    baseSha: doc.baseSha,
    headSha: doc.headSha,
    // INHERITED, never recomputed. A seeder that recomputed coverage could
    // report `full` over a `none` envelope, which is the one thing locked
    // decision 6 forbids.
    coverage: doc.coverage,
    degraded: doc.degraded,
    families,
    obligations: kept,
    dropped: [...dropCounts.entries()].map(([reason, count]) => ({ reason, count })),
    coverageSet: {
      selected: kept.map((o) => o.id),
      sealed: true,
      reviewed: [],
      failed: [],
      waived: [],
      terminalState: "pending",
    },
  };
}
