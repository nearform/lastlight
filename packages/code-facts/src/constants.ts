/**
 * `constants` — references MINUS literals.
 *
 * **The subtraction is the insight.** For each changed constant:
 *
 *   A = every reference to the IDENTIFIER            (ts-morph)
 *   B = every occurrence of the literal VALUE        (ast-grep)
 *   report A, and report `B \ A` as HARD-CODED DUPLICATES — sites that use the
 *   value without going through the constant.
 *
 * A constant with references only on one side of a boundary — defined in
 * config, read by the client, never compared server-side — is exactly the
 * `1587-r2` Critical, the single gold finding the investigation ever converted.
 * `sides` is a heuristic path-prefix partition: A HINT FOR THE SEEDER, never a
 * finding on its own.
 *
 * ast-grep rather than a text scan is not fussiness — it is what keeps `900` in
 * a comment, or inside an unrelated string, out of set B. A literal search that
 * matches prose produces obligations about nothing, and an obligation about
 * nothing gets honestly discharged (00-evidence §3, v3 iteration 2).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import type { Project } from "ts-morph";
import { Node as TsNode } from "ts-morph";
import type { ConstantFact, ConstantsPayload } from "./schema.js";
import { hasAnalysableExtension, isIgnoredPath, repoRelative } from "./project.js";
import type { ChangedFileIndex } from "./facts.js";

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

function langFor(path: string): Lang | null {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return Lang.Tsx;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return Lang.TypeScript;
  if (path.endsWith(".js") || path.endsWith(".mjs") || path.endsWith(".cjs")) {
    return Lang.JavaScript;
  }
  return null;
}

function walk(dir: string, root: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const rel = relative(root, full).split(sep).join("/");
    if (isIgnoredPath(`${rel}/`)) continue;
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) walk(full, root, out, limit);
    else if (hasAnalysableExtension(full)) out.push(rel);
    if (out.length >= limit) return;
  }
}

export interface LiteralHit {
  path: string;
  line: number;
}

/**
 * Set B: every occurrence of each literal value across the repo.
 *
 * One pass, with a substring pre-filter so only files that could possibly
 * contain one of the values are parsed. Constants are few and files are many;
 * the alternative (one ast-grep pass per constant) is quadratic and was the
 * obvious way to blow the phase's wall-clock budget.
 */
export function findLiteralOccurrences(
  repo: string,
  values: Map<string, "string" | "number" | "boolean">,
  maxFiles = 6000,
): Map<string, LiteralHit[]> {
  const out = new Map<string, LiteralHit[]>();
  for (const value of values.keys()) out.set(value, []);
  if (values.size === 0) return out;

  const files: string[] = [];
  walk(repo, repo, files, maxFiles);

  for (const path of files) {
    const lang = langFor(path);
    if (!lang) continue;
    let source: string;
    try {
      source = readFileSync(join(repo, path), "utf8");
    } catch {
      continue;
    }
    const present = [...values.keys()].filter((value) => source.includes(value));
    if (present.length === 0) continue;

    let root;
    try {
      root = parse(lang, source).root();
    } catch {
      // A file ast-grep cannot parse contributes nothing to set B. It is not a
      // reason to fail: the reference set (A) is unaffected, and the extractor
      // records the miss through the file never appearing in the hits.
      continue;
    }
    const literals = root.findAll({
      rule: { any: [{ kind: "number" }, { kind: "string" }, { kind: "true" }, { kind: "false" }] },
    });
    for (const node of literals) {
      const text = unquote(node.text());
      const bucket = out.get(text);
      if (!bucket) continue;
      bucket.push({ path, line: node.range().start.line + 1 });
    }
  }
  return out;
}

/** `"hello"` / `'hello'` / `` `hello` `` → `hello`. Numbers pass through. */
export function unquote(text: string): string {
  const first = text[0];
  if ((first === '"' || first === "'" || first === "`") && text.at(-1) === first) {
    return text.slice(1, -1);
  }
  return text;
}

interface ConstantDeclaration {
  name: string;
  path: string;
  line: number;
  value: string;
  valueKind: "string" | "number" | "boolean";
  /** `null` on tier 2 — the ast-grep-only path, where there is no set A. */
  references: string[] | null;
}

/** Tier 1: declarations and references from the compiled project. */
function declarationsFromProject(
  repo: string,
  project: Project,
  hunkIndex: Map<string, ChangedFileIndex>,
): ConstantDeclaration[] {
  const out: ConstantDeclaration[] = [];
  for (const [path, entry] of hunkIndex) {
    const file = project.getSourceFile((f) => repoRelative(repo, f.getFilePath()) === path);
    if (!file) continue;
    for (const statement of file.getVariableStatements()) {
      if (statement.getDeclarationKind() !== "const") continue;
      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        if (!TsNode.isIdentifier(nameNode)) continue;
        const initializer = declaration.getInitializer();
        if (!initializer) continue;
        const literal = literalOf(initializer.getText());
        if (!literal) continue;
        const line = declaration.getStartLineNumber();
        if (!intersects(entry, declaration.getStartLineNumber(), declaration.getEndLineNumber())) {
          continue;
        }
        const references: string[] = [];
        try {
          if (TsNode.isReferenceFindable(nameNode)) {
            for (const node of nameNode.findReferencesAsNodes()) {
              const referencePath = repoRelative(repo, node.getSourceFile().getFilePath());
              const referenceLine = node.getStartLineNumber();
              if (referencePath === path && referenceLine === line) continue;
              references.push(`${referencePath}:${referenceLine}`);
            }
          }
        } catch {
          // Same reasoning as `facts.findReferences` — one unkeyable node must
          // not take the extractor down.
        }
        out.push({
          name: declaration.getName(),
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
 * `references: []` plus a `degraded[]` entry — never by looking clean.
 */
function declarationsFromAstGrep(
  repo: string,
  hunkIndex: Map<string, ChangedFileIndex>,
): ConstantDeclaration[] {
  const out: ConstantDeclaration[] = [];
  for (const [path, entry] of hunkIndex) {
    const lang = langFor(path);
    if (!lang) continue;
    let source: string;
    try {
      source = readFileSync(join(repo, path), "utf8");
    } catch {
      continue;
    }
    let root;
    try {
      root = parse(lang, source).root();
    } catch {
      continue;
    }
    for (const match of root.findAll({ rule: { pattern: "const $NAME = $VALUE" } })) {
      const name = match.getMatch("NAME")?.text();
      const valueNode = match.getMatch("VALUE");
      if (!name || !valueNode) continue;
      const literal = literalOf(valueNode.text());
      if (!literal) continue;
      const line = match.range().start.line + 1;
      if (!intersects(entry, line, match.range().end.line + 1)) continue;
      out.push({ name, path, line, value: literal.value, valueKind: literal.kind, references: null });
    }
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
  /** `null` on tier 2 — ast-grep only, no reference set. */
  project: Project | null;
  hunkIndex: Map<string, ChangedFileIndex>;
  sides?: Record<string, string[]>;
  maxFiles?: number;
}

export function extractConstants(options: ExtractConstantsOptions): ConstantsPayload {
  const sides = options.sides ?? DEFAULT_SIDES;
  const declarations = options.project
    ? declarationsFromProject(options.repo, options.project, options.hunkIndex)
    : declarationsFromAstGrep(options.repo, options.hunkIndex);

  const values = new Map<string, "string" | "number" | "boolean">();
  for (const declaration of declarations) values.set(declaration.value, declaration.valueKind);
  const occurrences = findLiteralOccurrences(options.repo, values, options.maxFiles);

  const constants: ConstantFact[] = declarations.map((declaration) => {
    const references = declaration.references ?? [];
    const referenceSet = new Set(references);
    const hardCodedDuplicates = (occurrences.get(declaration.value) ?? [])
      .map((hit) => `${hit.path}:${hit.line}`)
      // The declaration's own initializer is an occurrence of its value; it is
      // not a duplicate of itself.
      .filter((at) => at !== `${declaration.path}:${declaration.line}`)
      .filter((at) => !referenceSet.has(at));

    const sideCounts: Record<string, number> = {};
    for (const side of Object.keys(sides)) sideCounts[side] = 0;
    sideCounts.other = 0;
    for (const at of references) {
      const side = sideOf(at.split(":")[0], sides) ?? "other";
      sideCounts[side] = (sideCounts[side] ?? 0) + 1;
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
  return { sideDefinitions: sides, constants };
}
