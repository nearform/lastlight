import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { htmlToText, extractTitle } from "../../../src/extensions/web-search/extract.js";

describe("htmlToText", () => {
  test("strips script, style, noscript, iframe, and comments", () => {
    const html = `
      <!-- secret -->
      <html><head><title>T</title>
      <style>body{color:red}</style>
      <script>alert(1)</script>
      </head><body>
      <p>Hello <b>world</b>.</p>
      <noscript>fallback</noscript>
      <iframe src="bad">payload</iframe>
      <p>Bye.</p>
      </body></html>
    `;
    const text = htmlToText(html);
    assert.ok(text.includes("Hello world."));
    assert.ok(text.includes("Bye."));
    assert.ok(!text.includes("alert(1)"));
    assert.ok(!text.includes("color:red"));
    assert.ok(!text.includes("fallback"));
    assert.ok(!text.includes("payload"));
    assert.ok(!text.includes("secret"));
  });

  test("decodes named, decimal, and hex entities", () => {
    const html = "<p>A &amp; B &#9786; &#x2603; &nbsp; &mdash;</p>";
    const text = htmlToText(html);
    assert.ok(text.includes("A & B"));
    assert.ok(text.includes("☺"));
    assert.ok(text.includes("☃"));
    assert.ok(text.includes("—"));
  });

  test("collapses whitespace and inserts newlines at block boundaries", () => {
    const html = "<div><p>One</p><p>Two</p></div><p>Three</p>";
    const text = htmlToText(html);
    const lines = text.split("\n").filter(Boolean);
    assert.deepEqual(lines, ["One", "Two", "Three"]);
  });

  test("byte cap truncates large output", () => {
    const html = `<p>${"abc ".repeat(10_000)}</p>`;
    const out = htmlToText(html, 100);
    assert.ok(new TextEncoder().encode(out).byteLength <= 100);
  });

  test("inline tags are dropped without inserting whitespace", () => {
    const text = htmlToText("<p>foo<b>bar</b>baz</p>");
    assert.equal(text, "foobarbaz");
  });
});

describe("extractTitle", () => {
  test("returns the title element content, decoded", () => {
    assert.equal(extractTitle("<title>Hello &amp; World</title>"), "Hello & World");
  });
  test("returns undefined when missing or empty", () => {
    assert.equal(extractTitle("<html></html>"), undefined);
    assert.equal(extractTitle("<title>   </title>"), undefined);
  });
});
