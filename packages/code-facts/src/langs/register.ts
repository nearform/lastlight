/**
 * The registry: a literal array, resolved at build time.
 *
 * **Not a plugin system, on purpose.** A registration API would be a public
 * surface with no second implementor, and a dynamically-discovered language is
 * a language that can silently fail to load — which is the one failure mode
 * this package is engineered against (see CLAUDE.md, "the two loudness
 * surfaces"). Adding a language is an import and an array entry, in a diff a
 * reviewer can read.
 *
 * Today the array holds exactly the grammars `@ast-grep/napi` already bundles,
 * so it costs nothing. Whether it ever holds more is the question
 * `scripts/name-match-gate.ts` exists to answer.
 */
import type { LanguageDescriptor } from "./descriptor.js";
import { TSJS_DESCRIPTORS } from "./tsjs.js";

export const LANGUAGE_DESCRIPTORS: LanguageDescriptor[] = [...TSJS_DESCRIPTORS];

/**
 * Extension → descriptor, LONGEST EXTENSION FIRST.
 *
 * Length order is not decoration: `.d.ts` and `.ts` would otherwise resolve by
 * array position, which is exactly the class of bug that put `.es6` in one
 * extension table and not the other.
 */
const BY_EXTENSION = new Map<string, LanguageDescriptor>();
for (const descriptor of LANGUAGE_DESCRIPTORS) {
  for (const extension of descriptor.extensions) {
    if (!BY_EXTENSION.has(extension)) BY_EXTENSION.set(extension, descriptor);
  }
}
const EXTENSIONS = [...BY_EXTENSION.keys()].sort((a, b) => b.length - a.length);

/** The descriptor for a path, or `null` when no registered language claims it. */
export function descriptorForPath(path: string): LanguageDescriptor | null {
  const lower = path.toLowerCase();
  for (const extension of EXTENSIONS) {
    if (lower.endsWith(extension)) return BY_EXTENSION.get(extension) ?? null;
  }
  return null;
}

export function descriptorById(id: string): LanguageDescriptor | null {
  return LANGUAGE_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

/** Every extension any registered language claims. */
export function registeredExtensions(): string[] {
  return [...EXTENSIONS];
}
