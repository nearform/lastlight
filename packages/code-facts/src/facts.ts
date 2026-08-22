/**
 * The DIFF index — the git half of `facts`, and the only half that is not about
 * a compiler.
 *
 * The extractor itself lives in `tsgo-extractors.ts` with the rest of the
 * type-aware layer (`extractFactsTsgo`); what stays here is what both the
 * type-aware and the name-match (`syntactic.ts`) engines have to agree on:
 * which lines the diff touched, and which hunks touch a declaration. Those are
 * claims about GIT, not about a compiler, so a second copy of them would let
 * two engines' symbol sets diverge for a reason that has nothing to do with the
 * engines.
 *
 * What `facts` is FOR, and it has not changed: for every symbol the diff
 * touched, which hunks changed it, every reference site (cross-file,
 * cross-barrel, cross-workspace), its callees, and which test files reference
 * it. The field that earns the extractor its place is `referencesInDiff` beside
 * `referenceCount` — a symbol whose shape changed and whose references are
 * MOSTLY OUTSIDE the diff is the cross-file contract bug the reviewer most
 * needs to find, and it is invisible in the diff because each file reads
 * correctly on its own.
 */
import type { FileHunks } from "./git.js";

export interface ChangedFileIndex {
  path: string;
  changedLines: Set<number>;
  hunks: string[];
}

export function indexHunks(hunks: FileHunks[]): Map<string, ChangedFileIndex> {
  const index = new Map<string, ChangedFileIndex>();
  for (const file of hunks) {
    index.set(file.path, {
      path: file.path,
      changedLines: new Set(file.changedLines),
      hunks: file.hunks,
    });
  }
  return index;
}

/** `path:start-end` → does it overlap [from, to]? */
export function hunksTouching(entry: ChangedFileIndex, from: number, to: number): string[] {
  return entry.hunks.filter((hunk) => {
    const match = /:(\d+)-(\d+)$/.exec(hunk);
    if (!match) return false;
    const start = Number(match[1]);
    const end = Number(match[2]);
    return start <= to && end >= from;
  });
}

/**
 * Cap on reference sites RECORDED per symbol. `0` = unbounded.
 *
 * It bounds the document, never the count: `referenceCount` and
 * `referencesInDiff` are totals over every site the query returned, so a capped
 * symbol still reports honestly how many consumers it has — only the citation
 * list is a prefix.
 */
export const DEFAULT_MAX_REFERENCES = 200;
