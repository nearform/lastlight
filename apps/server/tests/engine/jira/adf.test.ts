import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { adfToMarkdown, markdownToAdf, type AdfDoc } from "#src/engine/jira/adf.js";

// Real ADF captured from the nearform-test board (bodies only, mention values
// anonymized). See scratchpad/jira-notes.md for the capture provenance.
const samples = JSON.parse(
  readFileSync(resolve("tests/engine/jira/fixtures/adf-samples.json"), "utf-8"),
) as { description: AdfDoc; comment_formatted: AdfDoc; comment_mention: AdfDoc };

describe("adfToMarkdown", () => {
  it("renders a full description with headings, lists, blockquote, code and inline marks", () => {
    const expected = [
      "# Heading one",
      "",
      "## Heading two",
      "",
      "A paragraph with **bold**, *italic*, `inline code`, and a [link](https://example.com).",
      "",
      "- bullet one",
      "- bullet two",
      "",
      "1. first",
      "2. second",
      "",
      "> a blockquote",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(adfToMarkdown(samples.description)).toBe(expected);
  });

  it("renders an inlineCard smart link as its url (not dropped)", () => {
    // The real comment has a bare/smart link stored as an inlineCard node — the
    // case guidemode's text extractor silently loses.
    const md = adfToMarkdown(samples.comment_formatted);
    expect(md).toContain("https://nearform.com");
    expect(md).toContain("**comment**");
  });

  it("renders a mention node as its display text", () => {
    expect(adfToMarkdown(samples.comment_mention)).toContain("@Last Light");
  });

  it("returns empty string for an empty or missing doc", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown({ type: "doc", version: 1, content: [] })).toBe("");
  });
});

describe("markdownToAdf", () => {
  it("wraps a bare paragraph", () => {
    expect(markdownToAdf("Hello world")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello world" }] }],
    });
  });

  it("marks bold, italic, inline code and links", () => {
    expect(markdownToAdf("a **b** *c* `d` [e](https://x.io)").content[0]).toEqual({
      type: "paragraph",
      content: [
        { type: "text", text: "a " },
        { type: "text", text: "b", marks: [{ type: "strong" }] },
        { type: "text", text: " " },
        { type: "text", text: "c", marks: [{ type: "em" }] },
        { type: "text", text: " " },
        { type: "text", text: "d", marks: [{ type: "code" }] },
        { type: "text", text: " " },
        { type: "text", text: "e", marks: [{ type: "link", attrs: { href: "https://x.io" } }] },
      ],
    });
  });

  it("builds headings, bullet and ordered lists, and fenced code", () => {
    const doc = markdownToAdf("## Title\n\n- a\n- b\n\n1. one\n2. two\n\n```js\nconst x = 1;\n```");
    expect(doc.content.map((b) => b.type)).toEqual([
      "heading",
      "bulletList",
      "orderedList",
      "codeBlock",
    ]);
    expect(doc.content[0]).toEqual({ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Title" }] });
    expect(doc.content[3]).toEqual({
      type: "codeBlock",
      attrs: { language: "js" },
      content: [{ type: "text", text: "const x = 1;" }],
    });
  });

  it("does not treat underscores as emphasis", () => {
    const para = markdownToAdf("call some_snake_case()").content[0];
    expect(para).toEqual({ type: "paragraph", content: [{ type: "text", text: "call some_snake_case()" }] });
  });
});

describe("markdown → ADF → markdown round-trips", () => {
  it("preserves a representative mix of constructs", () => {
    const md = [
      "## Title",
      "",
      "A line with **bold**, *italic*, `code`, and a [link](https://x.io).",
      "",
      "- a",
      "- b",
      "",
      "1. one",
      "2. two",
      "",
      "```js",
      "const x = 1;",
      "```",
    ].join("\n");
    expect(adfToMarkdown(markdownToAdf(md))).toBe(md);
  });
});
