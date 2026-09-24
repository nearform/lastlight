/**
 * `jev.json`'s shape and its I/O, split out from `jev-classify.ts` so
 * `adjudicate-render.ts` (whose `buildEntries` `jev-classify.ts` itself
 * consumes) can read it without a circular import between the two.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface JevResult {
  id: string;
  category: string | null;
  confidence: number | null;
  probabilities: Record<string, number> | null;
  error: string | null;
  /**
   * A DETERMINISTIC cross-check against the falsify pass's own EXECUTED
   * probe for this same hypothesis — no second model call, computed once at
   * classify time from data already in hand. `verification` means "no
   * defect"; a `reproduced` probe means an executed check found one. `defect`
   * / `correctness-risk` mean "something is wrong"; a `refuted` probe means
   * an executed check found nothing. Either pairing contradicts an
   * independent, cheaper-to-trust signal, and it targets exactly where jev is
   * measured weakest: `verification` is its dominant call (201 of 260 in the
   * 8-case arm), so a false negative there is the likeliest failure, and a
   * probe result is not a second opinion — it is evidence. `null` when no
   * probe verdict exists to check against.
   */
  probeContradiction: string | null;
}

export interface JevClassifyDocument {
  model: string;
  generatedAt: string;
  /** Set when NOTHING could be classified — no key, client construction
   * failed. Individual per-hypothesis failures still live in `results[].error`. */
  error: string | null;
  results: JevResult[];
}

/** Where `classifyHypotheses` writes its document — a sibling of `dossier.md`,
 * inside the same `.lastlight/pr-review` directory every other pipeline
 * artifact lives in. */
export function jevClassifyPath(dir: string): string {
  return join(dir, "jev.json");
}

/** Read a written `jev.json`, or `null` if none exists / it does not parse —
 * absence and a parse failure are both "no annotation", never a crash for
 * the dossier renderer that reads this. */
export function readJevClassifyDocument(dir: string): JevClassifyDocument | null {
  const path = jevClassifyPath(dir);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JevClassifyDocument;
  } catch {
    return null;
  }
}

export function writeJevClassifyDocument(dir: string, doc: JevClassifyDocument): void {
  writeFileSync(jevClassifyPath(dir), JSON.stringify(doc, null, 2));
}
