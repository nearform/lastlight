import type { KnownBlock } from "@slack/web-api";

/** A line of dashes/colons separating a GFM table header from its body. */
const TABLE_DELIMITER = /^\s*\|?\s*:?-{1,}:?\s*(?:\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** A candidate table row — contains at least one unescaped pipe. */
function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim() !== "";
}

/** Strip leading/trailing pipes and split a GFM row into trimmed cells. */
function splitTableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());
}

/**
 * Reduce inline markdown inside a table cell to plain text — the table is
 * rendered in a monospace code block where `*`, `_`, backticks and link
 * syntax wouldn't render, so they'd just be noise.
 */
function plainCell(cell: string): string {
  return cell
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") // [text](url) → text (url)
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*(.+?)\*/g, "$1");
}

/** Sizing caps for the monospace table fallback (Slack has no real tables). */
const MAX_COL_WIDTH = 28; // per-column char cap; longer cells are truncated
const MAX_TABLE_WIDTH = 72; // whole-row char budget (mobile-legible width)
const MAX_TABLE_ROWS = 30; // data rows rendered inline before eliding the rest
const MIN_COL_WIDTH = 3; // floor a column can be shrunk to
const GUTTER = "  "; // between-column spacer

/** Truncate a cell to `width`, marking any elision with a trailing ellipsis. */
function truncateCell(cell: string, width: number): string {
  if (cell.length <= width) return cell;
  if (width <= 1) return "…".slice(0, width);
  return cell.slice(0, width - 1) + "…";
}

/**
 * Render a 2-column table as a `*label*: value` mrkdwn list. Used when the
 * table is too wide for a legible monospace block — a stacked key/value list
 * reads better on narrow (mobile) Slack views than a block that overflows the
 * viewport. Emits Slack mrkdwn directly; the result is held as a placeholder so
 * the `*bold*` is not re-processed by later transforms.
 */
function renderTwoColList(rows: string[][]): string {
  // rows[0] is the header; the rest are key/value pairs.
  return rows
    .slice(1)
    .map((r) => `*${r[0] ?? ""}*: ${r[1] ?? ""}`.replace(/\s+$/, ""))
    .join("\n");
}

/**
 * Render a GFM table block (header row, delimiter row, then data rows) as an
 * aligned monospace code block. Slack has no table mrkdwn, so a raw GFM table
 * shows as a wall of pipes; a fixed-width block keeps columns legible. Columns
 * are capped and truncated, the whole row is kept within a mobile-legible
 * budget, and very wide 2-column tables fall back to a stacked key/value list.
 */
function renderSlackTable(block: string[]): string {
  // Drop the delimiter row (index 1); keep header + data.
  const rows = block
    .filter((_, idx) => idx !== 1)
    .map((line) => splitTableCells(line).map(plainCell));
  const colCount = Math.max(...rows.map((r) => r.length));

  // Natural (uncapped) column widths + the row width they'd need.
  const natural: number[] = [];
  for (let c = 0; c < colCount; c++) {
    natural[c] = Math.max(0, ...rows.map((r) => (r[c] ?? "").length));
  }
  const naturalWidth =
    natural.reduce((a, b) => a + b, 0) + GUTTER.length * (colCount - 1);

  // A wide 2-column table reads better stacked as a key/value list on mobile
  // than as a monospace block that overflows the viewport.
  if (colCount === 2 && naturalWidth > MAX_TABLE_WIDTH) {
    return renderTwoColList(rows);
  }

  // Cap each column, then, while the row is still too wide, shrink the widest
  // column one char at a time until it fits the budget (or all hit the floor).
  const widths = natural.map((w) => Math.min(w, MAX_COL_WIDTH));
  const rowWidth = () =>
    widths.reduce((a, b) => a + b, 0) + GUTTER.length * (colCount - 1);
  while (rowWidth() > MAX_TABLE_WIDTH) {
    let widest = -1;
    let widestW = MIN_COL_WIDTH;
    for (let c = 0; c < colCount; c++) {
      if (widths[c] > widestW) {
        widestW = widths[c];
        widest = c;
      }
    }
    if (widest === -1) break; // every column already at the floor
    widths[widest] -= 1;
  }

  const fmtRow = (r: string[]): string =>
    widths
      .map((w, c) => truncateCell(r[c] ?? "", w).padEnd(w))
      .join(GUTTER)
      .replace(/\s+$/, "");

  const dataRows = rows.slice(1);
  const lines: string[] = [
    fmtRow(rows[0]),
    widths.map((w) => "-".repeat(w)).join(GUTTER),
  ];
  for (const r of dataRows.slice(0, MAX_TABLE_ROWS)) lines.push(fmtRow(r));
  if (dataRows.length > MAX_TABLE_ROWS) {
    lines.push(`… (${dataRows.length - MAX_TABLE_ROWS} more rows)`);
  }
  return "```\n" + lines.join("\n") + "\n```";
}

/**
 * Find GFM tables (a row followed by a dash/colon delimiter line, then zero or
 * more rows) and replace each with `render(block)`. Operates line-by-line so
 * non-table content is untouched.
 */
function convertMarkdownTables(text: string, render: (block: string[]) => string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (i + 1 < lines.length && isTableRow(lines[i]) && TABLE_DELIMITER.test(lines[i + 1])) {
      const block = [lines[i], lines[i + 1]];
      let j = i + 2;
      while (j < lines.length && isTableRow(lines[j])) block.push(lines[j++]);
      out.push(render(block));
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join("\n");
}

/**
 * Convert standard Markdown to Slack's mrkdwn format.
 *
 * Uses an extract-then-transform pattern: code blocks and inline code
 * are pulled into placeholders first so their contents are never modified,
 * then restored after all transformations are applied.
 */
export function markdownToSlackMrkdwn(text: string): string {
  const placeholders: string[] = [];

  /** Replace a match with a numbered placeholder */
  function hold(content: string): string {
    const idx = placeholders.length;
    placeholders.push(content);
    return `\x00PH${idx}\x00`;
  }

  let out = text;

  // 1. Extract fenced code blocks (strip language hints)
  out = out.replace(/```[a-zA-Z]*\n([\s\S]*?)```/g, (_m, code) => hold("```\n" + code + "```"));

  // 1b. Convert GFM tables to aligned monospace blocks (Slack has no table
  //     mrkdwn). Runs after fenced-block extraction so pipes inside code are
  //     left alone, and the result is held so later transforms don't touch it.
  out = convertMarkdownTables(out, (block) => hold(renderSlackTable(block)));

  // 2. Extract inline code
  out = out.replace(/`([^`\n]+)`/g, (_m, code) => hold("`" + code + "`"));

  // 3. Headers → bold (Slack has no header mrkdwn)
  out = out.replace(/^#{1,6}\s+(.+)$/gm, "*$1*");

  // 4. Bold: **text** or __text__ → *text*
  out = out.replace(/\*\*(.+?)\*\*/g, "*$1*");
  out = out.replace(/__(.+?)__/g, "*$1*");

  // 5. Italic: remaining *text* (not preceded/followed by *) → _text_
  //    Only match single * that aren't part of ** (already converted to single *)
  //    Skip this — after bold conversion, single * are now bold markers in Slack.
  //    Markdown _italic_ already works in Slack as italic.

  // 6. Strikethrough: ~~text~~ → ~text~
  out = out.replace(/~~(.+?)~~/g, "~$1~");

  // 7. Images: ![alt](url) → <url|alt> (must come before links)
  out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, "<$2|$1>");

  // 8. Links: [text](url) → <url|text>
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>");

  // 9. Horizontal rules → em-dash line
  out = out.replace(/^(?:---+|\*\*\*+|___+)\s*$/gm, "———");

  // 10. Restore placeholders
  out = out.replace(/\x00PH(\d+)\x00/g, (_m, idx) => placeholders[parseInt(idx)]);

  return out;
}

// ── Block Kit conversion (inline images) ─────────────────────────────────────

/** Markdown image `![alt](url)`, optional title ignored. Fresh instance per use. */
const imageRegex = (): RegExp => /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Slack section text limit is 3000; batch under it with headroom. */
const MAX_SECTION_CHARS = 2900;
/** Slack caps a message at 50 blocks. */
const MAX_MESSAGE_BLOCKS = 50;

/** True if the text contains at least one markdown image. */
export function hasMarkdownImage(text: string): boolean {
  return imageRegex().test(text);
}

/** Append `raw` (converted to mrkdwn) as one or more section blocks. */
function pushTextSections(blocks: KnownBlock[], raw: string): void {
  const mrkdwn = markdownToSlackMrkdwn(raw).trim();
  if (!mrkdwn) return;
  let buf = "";
  for (const line of mrkdwn.split("\n")) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > MAX_SECTION_CHARS && buf) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) blocks.push({ type: "section", text: { type: "mrkdwn", text: buf } });
}

/**
 * Convert markdown to Slack Block Kit, promoting markdown images to real
 * `image` blocks — the mrkdwn text path can only downgrade `![alt](url)` to a
 * link. Text between/around images is rendered as `section` mrkdwn blocks via
 * {@link markdownToSlackMrkdwn}. A non-`http(s)` image URL is left as text
 * (Slack rejects image blocks with an unusable URL).
 */
export function markdownToSlackBlocks(markdown: string): KnownBlock[] {
  const blocks: KnownBlock[] = [];
  const re = imageRegex();
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(markdown)) !== null) {
    const [full, alt, url] = m;
    pushTextSections(blocks, markdown.slice(last, m.index));
    last = m.index + full.length;
    if (/^https?:\/\//i.test(url)) {
      blocks.push({ type: "image", image_url: url, alt_text: (alt || url).slice(0, 2000) });
    } else {
      pushTextSections(blocks, full);
    }
  }
  pushTextSections(blocks, markdown.slice(last));
  return blocks.slice(0, MAX_MESSAGE_BLOCKS);
}
