// Atlassian Document Format (ADF) ↔ markdown (issue #501). Jira REST v3 comment
// bodies and issue descriptions are ADF, not markdown, so the connector converts
// both ways: ADF→markdown to feed a ticket into the agent's context, markdown→ADF
// to post note()/reply() text back. Pure — no logging, no IO.
//
// The ProgressModel→ADF checklist renderer lives with the notifier transport
// (Phase 3), not here, the same way the Slack transport owns its Block Kit.

/** A minimal ADF node — enough of the shape for the nodes we read and emit. */
export interface AdfNode {
  type: string;
  content?: AdfNode[];
  text?: string;
  marks?: AdfMark[];
  attrs?: Record<string, unknown>;
}
export interface AdfMark {
  type: string;
  attrs?: Record<string, unknown>;
}
export interface AdfDoc {
  type: "doc";
  version: number;
  content: AdfNode[];
}

// ---------------------------------------------------------------------------
// ADF → markdown
// ---------------------------------------------------------------------------

/** Render an ADF document (or a loose node array) to markdown. */
export function adfToMarkdown(doc: AdfDoc | AdfNode | null | undefined): string {
  if (!doc || !Array.isArray(doc.content)) return "";
  return renderBlocks(doc.content).trim();
}

function renderBlocks(nodes: AdfNode[]): string {
  return nodes.map(renderBlock).join("\n\n");
}

function renderBlock(node: AdfNode): string {
  switch (node.type) {
    case "paragraph":
      return renderInline(node.content);
    case "heading": {
      const level = clamp(Number(node.attrs?.level) || 1, 1, 6);
      return "#".repeat(level) + " " + renderInline(node.content);
    }
    case "bulletList":
      return (node.content ?? []).map((li) => renderListItem(li, "- ")).join("\n");
    case "orderedList":
      return (node.content ?? []).map((li, i) => renderListItem(li, `${i + 1}. `)).join("\n");
    case "blockquote":
      return renderBlocks(node.content ?? [])
        .split("\n")
        .map((line) => (line ? `> ${line}` : ">"))
        .join("\n");
    case "codeBlock": {
      const lang = typeof node.attrs?.language === "string" ? node.attrs.language : "";
      const code = (node.content ?? []).map((n) => n.text ?? "").join("");
      return "```" + lang + "\n" + code + "\n```";
    }
    case "rule":
      return "---";
    default:
      // Unknown block: recurse if it has children, else treat as inline.
      return node.content ? renderBlocks(node.content) : renderInline([node]);
  }
}

function renderListItem(item: AdfNode, marker: string): string {
  const inner = renderBlocks(item.content ?? []);
  const pad = " ".repeat(marker.length);
  return inner
    .split("\n")
    .map((line, i) => (i === 0 ? marker + line : pad + line))
    .join("\n");
}

function renderInline(nodes?: AdfNode[]): string {
  if (!nodes) return "";
  return nodes.map(renderInlineNode).join("");
}

function renderInlineNode(node: AdfNode): string {
  switch (node.type) {
    case "text":
      return applyMarks(node.text ?? "", node.marks);
    case "hardBreak":
      return "\n";
    // A smart link stores its href on `attrs.url` with no child text — render the
    // url, or markdown links silently vanish from the ticket's enriched context.
    case "inlineCard":
      return typeof node.attrs?.url === "string" ? node.attrs.url : "";
    case "mention":
      return typeof node.attrs?.text === "string"
        ? node.attrs.text
        : `@${node.attrs?.id ?? ""}`;
    case "emoji":
      return typeof node.attrs?.text === "string"
        ? node.attrs.text
        : node.attrs?.shortName
          ? `:${node.attrs.shortName}:`
          : "";
    default:
      return node.content ? renderInline(node.content) : "";
  }
}

function applyMarks(text: string, marks?: AdfMark[]): string {
  if (!marks?.length) return text;
  const has = (t: string) => marks.find((m) => m.type === t);
  let out = text;
  // Inline code can't carry other formatting in markdown, so it wins over
  // strong/em; a link still wraps the outside.
  if (has("code")) {
    out = "`" + out + "`";
  } else {
    if (has("em")) out = "*" + out + "*";
    if (has("strong")) out = "**" + out + "**";
    if (has("strike")) out = "~~" + out + "~~";
  }
  const link = has("link");
  if (link) out = `[${out}](${String(link.attrs?.href ?? "")})`;
  return out;
}

// ---------------------------------------------------------------------------
// markdown → ADF
// ---------------------------------------------------------------------------

/**
 * Convert markdown to an ADF document. Covers the constructs the harness emits
 * in note()/reply() text: paragraphs, ATX headings, bullet/numbered lists,
 * fenced code blocks, and inline links/bold/italic/code. Only the asterisk
 * emphasis forms are honoured (`**bold**`, `*italic*`) so identifiers and URLs
 * with underscores are not mangled.
 */
export function markdownToAdf(markdown: string): AdfDoc {
  return { type: "doc", version: 1, content: blocksFromMarkdown(markdown) };
}

function blocksFromMarkdown(markdown: string): AdfNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: AdfNode[] = [];
  let i = 0;
  const isBlockStart = (l: string) => /^(```|#{1,6}\s|[-*]\s|\d+\.\s)/.test(l);

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }

    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++; // closing fence
      const attrs = fence[1] ? { attrs: { language: fence[1] } } : {};
      blocks.push({ type: "codeBlock", ...attrs, content: [{ type: "text", text: code.join("\n") }] });
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      blocks.push({ type: "heading", attrs: { level: heading[1].length }, content: parseInline(heading[2]) });
      i++;
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(listItem(lines[i].replace(/^[-*]\s+/, "")));
        i++;
      }
      blocks.push({ type: "bulletList", content: items });
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      const items: AdfNode[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        items.push(listItem(lines[i].replace(/^\d+\.\s+/, "")));
        i++;
      }
      blocks.push({ type: "orderedList", attrs: { order: 1 }, content: items });
      continue;
    }

    // Paragraph: consecutive non-blank lines that don't start a new block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) para.push(lines[i++]);
    blocks.push({ type: "paragraph", content: parseInline(para.join(" ")) });
  }
  return blocks;
}

function listItem(text: string): AdfNode {
  return { type: "listItem", content: [{ type: "paragraph", content: parseInline(text) }] };
}

const INLINE_PATTERNS: Array<{ re: RegExp; kind: "code" | "link" | "strong" | "em" }> = [
  { re: /`([^`]+)`/, kind: "code" },
  { re: /\[([^\]]+)\]\(([^)]+)\)/, kind: "link" },
  { re: /\*\*([^*]+)\*\*/, kind: "strong" },
  { re: /\*([^*]+)\*/, kind: "em" },
];

function parseInline(text: string, marks: AdfMark[] = []): AdfNode[] {
  if (text === "") return [];
  let best: { index: number; match: RegExpMatchArray; kind: string } | null = null;
  for (const { re, kind } of INLINE_PATTERNS) {
    const m = text.match(re);
    if (m && m.index !== undefined && (best === null || m.index < best.index)) {
      best = { index: m.index, match: m, kind };
    }
  }
  if (!best) return [textNode(text, marks)];

  const nodes: AdfNode[] = [];
  const before = text.slice(0, best.index);
  if (before) nodes.push(textNode(before, marks));

  const m = best.match;
  if (best.kind === "code") {
    nodes.push(textNode(m[1], [...marks, { type: "code" }]));
  } else if (best.kind === "link") {
    nodes.push(...parseInline(m[1], [...marks, { type: "link", attrs: { href: m[2] } }]));
  } else {
    nodes.push(...parseInline(m[1], [...marks, { type: best.kind }]));
  }
  nodes.push(...parseInline(text.slice(best.index + m[0].length), marks));
  return nodes;
}

function textNode(text: string, marks: AdfMark[]): AdfNode {
  return marks.length ? { type: "text", text, marks } : { type: "text", text };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
