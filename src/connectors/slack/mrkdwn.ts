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

/**
 * Render a GFM table block (header row, delimiter row, then data rows) as an
 * aligned monospace code block. Slack has no table mrkdwn, so a raw GFM table
 * shows as a wall of pipes; a fixed-width block keeps columns legible.
 */
function renderSlackTable(block: string[]): string {
  // Drop the delimiter row (index 1); keep header + data.
  const rows = block
    .filter((_, idx) => idx !== 1)
    .map((line) => splitTableCells(line).map(plainCell));
  const colCount = Math.max(...rows.map((r) => r.length));
  const widths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    widths[c] = Math.max(...rows.map((r) => (r[c] ?? "").length));
  }
  const fmtRow = (r: string[]): string =>
    widths
      .map((w, c) => (r[c] ?? "").padEnd(w))
      .join("  ")
      .replace(/\s+$/, "");
  const lines: string[] = [fmtRow(rows[0]), widths.map((w) => "-".repeat(w)).join("  ")];
  for (let r = 1; r < rows.length; r++) lines.push(fmtRow(rows[r]));
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
