/**
 * Minimal HTML → readable text extractor. No dependencies.
 *
 * Approach:
 *   1. Strip <script>, <style>, <noscript>, <iframe>, and HTML comments
 *      so the agent never sees code or hidden trackers.
 *   2. Replace block-level tags with newlines so paragraphs stay separated.
 *   3. Drop all other tags.
 *   4. Decode the common named entities and any &#NN; / &#xHH; numeric
 *      escapes.
 *   5. Collapse runs of whitespace; cap output at MAX_BYTES.
 *
 * Not a Readability-style content-only extractor — for that, use Tavily or
 * Exa's native extraction, which the provider clients invoke directly.
 */

export const EXTRACT_MAX_BYTES = 200 * 1024;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "(c)",
  reg: "(R)",
  trade: "(TM)",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (_m, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code) : _m;
    }
    if (body.startsWith("#")) {
      const code = parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code) : _m;
    }
    const mapped = NAMED_ENTITIES[body];
    return mapped ?? _m;
  });
}

function safeFromCodePoint(code: number): string {
  if (code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

const BLOCK_TAGS = new Set([
  "p",
  "br",
  "div",
  "section",
  "article",
  "header",
  "footer",
  "main",
  "nav",
  "aside",
  "ul",
  "ol",
  "li",
  "table",
  "tr",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "hr",
  "pre",
  "code",
  "dl",
  "dt",
  "dd",
  "figure",
  "figcaption",
]);

export function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  if (!m) return undefined;
  const t = decodeEntities(m[1]).replace(/\s+/g, " ").trim();
  return t.length > 0 ? t : undefined;
}

export function htmlToText(html: string, maxBytes = EXTRACT_MAX_BYTES): string {
  // 1. Strip dangerous / noise sections wholesale.
  let s = html.replace(/<!--[\s\S]*?-->/g, "");
  s = s.replace(/<script\b[\s\S]*?<\/script\s*>/gi, "");
  s = s.replace(/<style\b[\s\S]*?<\/style\s*>/gi, "");
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, "");
  s = s.replace(/<iframe\b[\s\S]*?<\/iframe\s*>/gi, "");

  // 2. Convert block-level open/close tags to newlines so paragraphs survive.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (_match, tag: string) => {
    if (BLOCK_TAGS.has(tag.toLowerCase())) return "\n";
    return "";
  });

  // 3. Decode entities.
  s = decodeEntities(s);

  // 4. Normalize whitespace: collapse runs of spaces/tabs; trim per line;
  //    collapse runs of blank lines.
  s = s.replace(/\r\n?/g, "\n");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter((line, i, arr) => {
      // collapse 2+ blank lines down to 1
      if (line !== "") return true;
      return arr[i - 1] !== "";
    })
    .join("\n")
    .trim();

  // 5. Byte cap. UTF-8 size approximation by encoding; on overflow, slice
  //    on code-point boundary then re-decode.
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  if (bytes.byteLength <= maxBytes) return s;
  // Decode just the prefix.
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
}
