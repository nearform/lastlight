/**
 * `constants` — references MINUS literals.
 *
 * **The subtraction is the insight.** For each changed constant:
 *
 *   A = every reference to the IDENTIFIER            (the tsgo checker)
 *   B = every occurrence of the literal VALUE        (ast-grep)
 *   report A, and report `B \ A` as HARD-CODED DUPLICATES — sites that use the
 *   value without going through the constant.
 *
 * A constant with references only on one side of a boundary — defined in
 * config, read by the client, never compared server-side — is exactly the
 * `1587-r2` Critical, the single gold finding the investigation ever converted.
 * `sides` is a heuristic path-prefix partition: A HINT FOR THE SEEDER, never a
 * finding on its own — and it is `null`, never all-zeros, whenever `references`
 * is `null`, because a partition of a set that was never computed is an absence
 * claim built from no data.
 *
 * ast-grep rather than a text scan is not fussiness — it is what keeps `900` in
 * a comment, or inside an unrelated string, out of set B. A literal search that
 * matches prose produces obligations about nothing, and an obligation about
 * nothing gets honestly discharged (00-evidence §3, v3 iteration 2).
 */
import { NodeFlags, isIdentifier, isVariableStatement } from "typescript/unstable/ast";
import type { Node, VariableStatement } from "typescript/unstable/ast";
import type { ConstantFact, ConstantsPayload, DegradedEntry } from "./schema.js";
import type { ListingSource } from "./git.js";
import {
  buildSyntacticIndex,
  scanChangedFiles,
  unquote,
  DEFAULT_MAX_SCANNED_FILES,
} from "./syntactic.js";
import type { ChangedFileIndex } from "./facts.js";
import { lineOf, referenceNodes, repoRelativeOf } from "./tsgo-extractors.js";
import type { EngineSnapshot } from "./tsgo.js";

/**
 * The default `sides` partition. Deliberately boring and overridable
 * (`--sides name=prefix,...`): the value of the field is that it is *declared*,
 * so a reader can see what "server: 0" was computed from.
 */
export const DEFAULT_SIDES: Record<string, string[]> = {
  client: ["client/", "src/client/", "web/", "app/", "frontend/", "ui/", "browser/"],
  server: ["server/", "src/server/", "api/", "backend/", "src/api/", "lib/server/"],
  shared: ["shared/", "src/shared/", "common/", "src/common/", "packages/"],
  test: ["test/", "tests/", "__tests__/", "spec/", "e2e/"],
};

export function parseSides(spec: string | undefined): Record<string, string[]> {
  if (!spec) return DEFAULT_SIDES;
  const out: Record<string, string[]> = {};
  for (const pair of spec.split(",")) {
    const [name, prefix] = pair.split("=");
    if (!name || !prefix) continue;
    (out[name.trim()] ??= []).push(prefix.trim());
  }
  return Object.keys(out).length > 0 ? out : DEFAULT_SIDES;
}

function sideOf(path: string, sides: Record<string, string[]>): string | null {
  let best: { side: string; length: number } | null = null;
  for (const [side, prefixes] of Object.entries(sides)) {
    for (const prefix of prefixes) {
      // Longest prefix wins, so `src/server/` beats `src/` if both are declared.
      if (path.startsWith(prefix) && (!best || prefix.length > best.length)) {
        best = { side, length: prefix.length };
      }
    }
  }
  return best?.side ?? null;
}

export interface LiteralHit {
  path: string;
  line: number;
}

export interface LiteralScan {
  occurrences: Map<string, LiteralHit[]>;
  /** True when the listing hit `maxFiles` — set B is a PREFIX, not the repo. */
  truncated: boolean;
  /** Files that passed the filters, BEFORE the ceiling. */
  filesEligible: number;
  filesScanned: number;
  filesSkipped: number;
  /** Listed but unreadable — a hole in set B, and never silent. */
  filesUnread: number;
  /** `"walk"` means `.gitignore` was NOT honoured. Always degrade on it. */
  source: ListingSource;
  /** A written reason whenever `source === "walk"`. */
  sourceReason: string | null;
}

export interface LiteralScanOptions {
  /**
   * The commit set B is resolved against — the SAME `headSha` the envelope
   * stamps. `null` falls back to the working directory, which is what a caller
   * outside a git repository gets, and it is reported as such.
   */
  ref?: string | null;
  maxFiles?: number;
}

/**
 * Set B: every occurrence of each literal value across the repository at `ref`.
 *
 * **The file set comes from `git ls-tree`, not from `readdirSync`.** Three
 * things ride on that and each was a bug:
 *
 *  - `.gitignore` is honoured by construction, including nested ones. The old
 *    walk read `apps/evals/dist-site/**` (ignored two directories down) and
 *    `apps/server/data/sandboxes/**` (cloned review workspaces) as if they were
 *    source: **44,633 hard-coded duplicates on this monorepo, 41,079 of them
 *    from `data/sandboxes` alone**.
 *  - The scan resolves against the HEAD COMMIT. Every `hardCodedDuplicates`
 *    entry is a `path:line` citation and the envelope stamps `headSha`; reading
 *    the working directory made those citations a claim about the checkout.
 *  - The ceiling starts meaning something, because it is charged after the
 *    filtering rather than before it.
 *
 * One pass, with a substring pre-filter so only files that could possibly
 * contain one of the values are parsed. Constants are few and files are many;
 * the alternative (one ast-grep pass per constant) is quadratic and was the
 * obvious way to blow the phase's wall-clock budget. Contents are visited one
 * file at a time and dropped, so the scan holds the hits and nothing else.
 *
 * It returns the TRUNCATION FLAG and the LISTING SOURCE alongside the hits, and
 * `extractConstants` turns both into `degraded[]` entries. Without the first
 * this extractor reports an absence claim — "no other site hard-codes this
 * value" — over an arbitrary prefix of the repository; without the second, a
 * walk-tier result is indistinguishable from a tree-tier one.
 */
export function findLiteralOccurrences(
  repo: string,
  values: Map<string, "string" | "number" | "boolean">,
  options: LiteralScanOptions = {},
): LiteralScan {
  // ONE PASS, shared with the name index — see `syntactic.ts`. This function is
  // now a projection of `SyntacticIndex` onto the shape `constants` has always
  // read, which is the whole reason the syntactic engine is cheap: the walk,
  // the blob reads and the parse were already being paid for here.
  const index = buildSyntacticIndex({
    repo,
    ref: options.ref ?? null,
    values,
    maxFiles: options.maxFiles,
  });
  return {
    occurrences: index.literals,
    truncated: index.truncated,
    filesEligible: index.filesEligible,
    filesScanned: index.filesScanned,
    filesSkipped: index.filesSkipped,
    filesUnread: index.filesUnread,
    source: index.source as ListingSource,
    sourceReason: index.sourceReason,
  };
}

export { unquote } from "./syntactic.js";

interface ConstantDeclaration {
  name: string;
  path: string;
  line: number;
  value: string;
  valueKind: "string" | "number" | "boolean";
  /** `null` on tier 2 — the ast-grep-only path, where there is no set A. */
  references: string[] | null;
}

/**
 * Tier 1: declarations and set A from the compiled snapshot.
 *
 * The reference query runs in the program that OWNS the declaration
 * (`EngineSnapshot.lookup` hands back the owner), which is the only program it
 * could resolve in — and is what keeps `references` an under-claim rather than
 * an over-claim in the extractor whose whole output is an absence claim.
 *
 * `const` is read off `declarationList.flags`, not off the text: `NodeFlags`
 * carries `Let`/`Const`/`Using` on the LIST rather than on each declarator, and
 * a `let` whose initializer happens to be a literal is not a constant.
 */
function declarationsFromSnapshot(
  snapshot: EngineSnapshot,
  hunkIndex: Map<string, ChangedFileIndex>,
): ConstantDeclaration[] {
  const out: ConstantDeclaration[] = [];
  for (const [path, entry] of hunkIndex) {
    const found = snapshot.lookup(path);
    if (!found) continue;
    const source = found.sourceFile;
    const project = found.owner.project;
    for (const statement of source.statements as unknown as Node[]) {
      if (!isVariableStatement(statement)) continue;
      const list = (statement as VariableStatement).declarationList;
      if ((list.flags & NodeFlags.Const) === 0) continue;
      for (const declaration of list.declarations) {
        const nameNode = declaration.name as unknown as Node;
        if (!isIdentifier(nameNode)) continue;
        const initializer = (declaration as { initializer?: Node }).initializer;
        if (!initializer) continue;
        const literal = literalOf(initializer.getText());
        if (!literal) continue;
        const node = declaration as unknown as Node;
        const line = lineOf(source, node.getStart());
        if (!intersects(entry, line, lineOf(source, node.getEnd()))) continue;

        const references: string[] = [];
        // `referenceNodes` already degrades one unkeyable declaration to an
        // empty list rather than taking the extractor down.
        for (const reference of referenceNodes(project, nameNode)) {
          const file = reference.getSourceFile();
          const referencePath = repoRelativeOf(snapshot.repo, file.fileName);
          const referenceLine = lineOf(file, reference.getStart());
          // The declaration's own name node is not a reference to itself.
          if (referencePath === path && referenceLine === line) continue;
          references.push(`${referencePath}:${referenceLine}`);
        }
        out.push({
          name: nameNode.getText(),
          path,
          line,
          value: literal.value,
          valueKind: literal.kind,
          references: [...new Set(references)].sort(),
        });
      }
    }
  }
  return out;
}

/**
 * Tier 2: the project would not load, so declarations come from ast-grep over
 * the changed files and there is NO set A. The document says so through
 * `references: null` — and therefore `sides: null` — plus a `degraded[]` entry.
 * Never by looking clean.
 */
function declarationsFromAstGrep(
  repo: string,
  headSha: string | null,
  hunkIndex: Map<string, ChangedFileIndex>,
): ConstantDeclaration[] {
  // The descriptor's `constantDeclarations` rule, not a hand-written ast-grep
  // pattern: the pattern was `const $NAME = $VALUE`, which is the TS/JS spelling
  // of "an immutable binding" and nothing else's. Going through the descriptor
  // is what lets a second language reach this extractor without a second copy
  // of the extractor.
  const scan = scanChangedFiles({ repo, headSha, paths: [...hunkIndex.keys()] });
  const out: ConstantDeclaration[] = [];
  for (const site of scan.declarations) {
    const entry = hunkIndex.get(site.path);
    if (!entry || site.valueText === null) continue;
    // `literalOf` rather than the grammar's own literal kinds, deliberately —
    // it additionally accepts `-5`, which the grammar spells as a
    // `unary_expression`. Narrowing a shipped extractor under a refactor is not
    // a refactor.
    const literal = literalOf(site.valueText);
    if (!literal) continue;
    if (!intersects(entry, site.startLine, site.endLine)) continue;
    out.push({
      name: site.localName,
      path: site.path,
      line: site.line,
      value: literal.value,
      valueKind: literal.kind,
      // Tier 2 has NO set A: there is no compiler to ask. `null`, never `[]`.
      references: null,
    });
  }
  return out;
}

function intersects(entry: ChangedFileIndex, from: number, to: number): boolean {
  for (let line = from; line <= to; line++) if (entry.changedLines.has(line)) return true;
  return false;
}

/** A literal initializer, or `null` for anything computed. */
export function literalOf(
  text: string,
): { value: string; kind: "string" | "number" | "boolean" } | null {
  const trimmed = text.trim();
  if (/^-?\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(trimmed)) {
    return { value: trimmed, kind: "number" };
  }
  if (trimmed === "true" || trimmed === "false") return { value: trimmed, kind: "boolean" };
  if (/^(["'])(?:(?!\1)[^\\])*\1$/.test(trimmed) || /^`[^`$\\]*`$/.test(trimmed)) {
    return { value: unquote(trimmed), kind: "string" };
  }
  return null;
}

export interface ExtractConstantsOptions {
  repo: string;
  /**
   * `null` on tier 2 — ast-grep only, and therefore NO set A. On tier 1 it is
   * the head snapshot, holding every tsconfig the diff touches, and a
   * declaration is read out of whichever program owns its file.
   */
  snapshot: EngineSnapshot | null;
  hunkIndex: Map<string, ChangedFileIndex>;
  sides?: Record<string, string[]>;
  maxFiles?: number;
  /**
   * The commit set B is enumerated at — the same `headSha` the envelope stamps,
   * so a `path:line` citation names the analysed commit rather than whatever the
   * checkout holds. Omitted (library use, or a directory that is not a git
   * repository) it falls back to a directory walk and SAYS SO in `degraded[]`.
   */
  headSha?: string | null;
}

export interface ExtractConstantsResult {
  payload: ConstantsPayload;
  degraded: DegradedEntry[];
}

export function extractConstants(options: ExtractConstantsOptions): ExtractConstantsResult {
  const sides = options.sides ?? DEFAULT_SIDES;
  const degraded: DegradedEntry[] = [];
  const declarations = options.snapshot
    ? declarationsFromSnapshot(options.snapshot, options.hunkIndex)
    : declarationsFromAstGrep(options.repo, options.headSha ?? null, options.hunkIndex);

  const values = new Map<string, "string" | "number" | "boolean">();
  for (const declaration of declarations) values.set(declaration.value, declaration.valueKind);
  const scan = findLiteralOccurrences(options.repo, values, {
    ref: options.headSha ?? null,
    maxFiles: options.maxFiles,
  });
  const { occurrences } = scan;

  if (scan.source === "walk") {
    // Walk-tier output is not tree-tier output, and the difference is not
    // cosmetic: the walk cannot honour `.gitignore`, so build output and
    // vendored checkouts are in set B, and it reads the working DIRECTORY, so
    // every citation is a claim about the checkout rather than about `headSha`.
    degraded.push({
      extractor: "constants",
      reason: `${scan.sourceReason ?? "the file set came from a directory walk"} — \`hardCodedDuplicates\` from this run is walk-tier evidence and must not be read as a complete or commit-accurate set B`,
    });
  }

  if (scan.filesUnread > 0) {
    // A file that was listed and then could not be read is a HOLE in set B, and
    // it looks exactly like a file that contained none of the values. Small,
    // usually zero, and never worth being silent about in the extractor whose
    // output is an absence claim.
    degraded.push({
      extractor: "constants",
      reason: `${scan.filesUnread} of ${scan.filesEligible} listed file(s) could not be read, so set B has a hole in it — a value that appears only in one of them is reported as appearing nowhere`,
    });
  }

  if (scan.truncated) {
    // The severe one. `constants` is the extractor that makes ABSENCE claims —
    // "referenced only client-side, zero server references" is the single gold
    // finding this investigation ever converted — and an absence claim over an
    // arbitrary prefix of the repository is not a weak claim, it is an unsound
    // one. Before this entry existed the document looked identical to a
    // complete scan.
    const ceiling = options.maxFiles ?? DEFAULT_MAX_SCANNED_FILES;
    degraded.push({
      extractor: "constants",
      reason: `the literal scan stopped at the ${ceiling}-file ceiling (--max-files): ${scan.filesEligible} file(s) were eligible and ${scan.filesScanned} were read — set B covers a PREFIX of the repository, not the repository, so \`hardCodedDuplicates\` is incomplete and no "the value appears nowhere else" reading is available from this document`,
    });
  }

  const constants: ConstantFact[] = declarations.map((declaration) => {
    // M6. `?? []` here collapsed "tier 2, there is NO set A" into "the compiler
    // looked and found no references" — the founding distinction of this
    // package, in the one field that carries it.
    const references = declaration.references;
    const referenceSet = new Set(references ?? []);
    const hardCodedDuplicates = (occurrences.get(declaration.value) ?? [])
      .map((hit) => `${hit.path}:${hit.line}`)
      // The declaration's own initializer is an occurrence of its value; it is
      // not a duplicate of itself.
      .filter((at) => at !== `${declaration.path}:${declaration.line}`)
      .filter((at) => !referenceSet.has(at));

    // M6 again, in the field that carries the ABSENCE claim. `sides` is a
    // partition OF `references`, so with no set A there is nothing to partition
    // — and an all-zeros record built from a reference set that does not exist
    // reads exactly like a measured `{server: 0}`, which is the `1587-r2` shape.
    // `sideDefinitions` still ships, so the partition remains auditable.
    let sideCounts: Record<string, number> | null = null;
    if (references !== null) {
      sideCounts = {};
      for (const side of Object.keys(sides)) sideCounts[side] = 0;
      sideCounts.other = 0;
      for (const at of references) {
        const side = sideOf(at.split(":")[0], sides) ?? "other";
        sideCounts[side] = (sideCounts[side] ?? 0) + 1;
      }
    }

    return {
      constant: declaration.name,
      declaredAt: `${declaration.path}:${declaration.line}`,
      value: declaration.value,
      valueKind: declaration.valueKind,
      references,
      hardCodedDuplicates: [...new Set(hardCodedDuplicates)].sort(),
      sides: sideCounts,
    };
  });

  constants.sort((a, b) => a.declaredAt.localeCompare(b.declaredAt));
  return { payload: { sideDefinitions: sides, constants }, degraded };
}
