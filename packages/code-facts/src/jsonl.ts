/**
 * The ONE reader of the pipeline's `.jsonl` artifacts.
 *
 * A survey pass is told to write one JSON object per line, and some models
 * pretty-print anyway. Measured 2026-09-24: GLM 5.3 Flash, DeepSeek V4 Flash
 * and a full Haiku arm (33 lines on one `1680-r1` family). The line-by-line
 * reader counted every line of such a row as malformed and dropped the claim,
 * so real findings never reached adjudication, in prod as well as in evals.
 *
 * So: a line that parses on its own is a row, exactly as before. Only a line
 * that does not parse on its own gets a second attempt: if it opens an object
 * or array, scan forward (brace-balanced, string-aware) to where that value
 * closes and parse the span. A success is a row, counted in `recovered` so a
 * model that ignores the format stays visible. A failure counts ONE malformed
 * line and resumes at the next line, so a torn or broken line can never swallow
 * the good rows after it.
 *
 * Ordinals are positional identity (`hypotheses.ts`), which is why a
 * well-formed file reads exactly as it did: every row that line-by-line parsing
 * accepted is still accepted, at the same ordinal relative to its neighbours.
 * `apps/server/src/workflows/handlers/post-review.ts` and the evals dashboard's
 * `pipelineArtifacts.ts` carry copies of this (neither can depend on this
 * package). Keep them in step.
 */

export interface JsonlParse {
  /** Every value read, in file order. Non-objects are kept — they hold an ordinal. */
  rows: unknown[];
  /** Rows that only parsed as a multi-line or run-together span. */
  recovered: number;
  /** Lines that could not be read as JSON at all. */
  malformed: number;
  /**
   * Where each of {@link rows} sits in the text, index-aligned: `[start, end)`
   * of the JSON value itself, surrounding whitespace excluded. What lets a
   * writer replace one row's text and leave every other byte — malformed lines
   * included — exactly where it was (`normalizeFamilyIds`).
   */
  spans: { start: number; end: number }[];
}

/**
 * Where the value opening at `start` closes (the index after its final
 * bracket), or -1 when the text ends first.
 */
function closingIndex(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

export function parseJsonl(text: string): JsonlParse {
  const rows: unknown[] = [];
  const spans: { start: number; end: number }[] = [];
  let recovered = 0;
  let malformed = 0;
  let pos = 0;
  while (pos < text.length) {
    const newline = text.indexOf("\n", pos);
    const lineEnd = newline === -1 ? text.length : newline;
    const line = text.slice(pos, lineEnd).trim();
    const nextLine = lineEnd + 1;
    if (!line) {
      pos = nextLine;
      continue;
    }
    try {
      rows.push(JSON.parse(line) as unknown);
      const rawLine = text.slice(pos, lineEnd);
      spans.push({
        start: pos + (rawLine.length - rawLine.trimStart().length),
        end: lineEnd - (rawLine.length - rawLine.trimEnd().length),
      });
      pos = nextLine;
      continue;
    } catch {
      /* not a row on its own — try it as the start of a span */
    }
    const raw = text.slice(pos, lineEnd);
    const start = pos + raw.length - raw.trimStart().length;
    const opener = text[start];
    const end = opener === "{" || opener === "[" ? closingIndex(text, start) : -1;
    if (end !== -1) {
      try {
        rows.push(JSON.parse(text.slice(start, end)) as unknown);
        spans.push({ start, end });
        recovered += 1;
        // Whatever follows the close on its line is read as a line of its own.
        pos = end;
        continue;
      } catch {
        /* balanced but not JSON — fall through */
      }
    }
    malformed += 1;
    pos = nextLine;
  }
  return { rows, recovered, malformed, spans };
}
