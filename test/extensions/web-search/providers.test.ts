/**
 * Provider normalization tests. Each test stubs `fetchImpl` with a fixed
 * JSON response and asserts the provider produces the right
 * NormalizedSearchResult / NormalizedFetchResult shape — including its
 * `provider` name, that fields are mapped correctly, and that errors are
 * raised on non-OK responses.
 */

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { createTavilyProvider } from "../../../src/extensions/web-search/providers/tavily.js";
import { createBraveProvider } from "../../../src/extensions/web-search/providers/brave.js";
import { createExaProvider } from "../../../src/extensions/web-search/providers/exa.js";

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

describe("Tavily provider", () => {
  test("search maps results and answer", async () => {
    const p = createTavilyProvider({
      apiKey: "tvly-x",
      fetchImpl: async () =>
        jsonResponse({
          query: "q",
          answer: "the answer",
          results: [
            {
              title: "One",
              url: "https://one.example",
              content: "snippet1",
              raw_content: "full body 1",
              score: 0.9,
              published_date: "2025-01-01",
            },
          ],
        }),
    });
    const r = await p.search({ query: "q", maxResults: 3 });
    assert.equal(r.provider, "tavily");
    assert.equal(r.answer, "the answer");
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].title, "One");
    assert.equal(r.results[0].snippet, "snippet1");
    assert.equal(r.results[0].content, "full body 1");
    assert.equal(r.results[0].score, 0.9);
  });

  test("search throws on non-OK", async () => {
    const p = createTavilyProvider({
      apiKey: "tvly-x",
      fetchImpl: async () =>
        new Response("nope", { status: 500, headers: { "content-type": "text/plain" } }),
    });
    await assert.rejects(() => p.search({ query: "q", maxResults: 1 }), /tavily search failed/);
  });

  test("fetch maps the extract endpoint", async () => {
    const p = createTavilyProvider({
      apiKey: "tvly-x",
      fetchImpl: async () =>
        jsonResponse({
          results: [{ url: "https://x.example", raw_content: "extracted body", title: "X" }],
        }),
    });
    const r = await p.fetch!({ url: "https://x.example" });
    assert.equal(r.provider, "tavily");
    assert.equal(r.text, "extracted body");
    assert.equal(r.title, "X");
  });
});

describe("Brave provider", () => {
  test("search maps web results", async () => {
    const p = createBraveProvider({
      apiKey: "brv",
      fetchImpl: async () =>
        jsonResponse({
          web: {
            results: [
              { title: "A", url: "https://a.example", description: "desc-a", age: "2024" },
              { title: "B", url: "https://b.example", description: "desc-b" },
            ],
          },
        }),
    });
    const r = await p.search({ query: "q", maxResults: 2 });
    assert.equal(r.provider, "brave");
    assert.equal(r.results.length, 2);
    assert.equal(r.results[0].snippet, "desc-a");
    assert.equal(r.results[0].publishedDate, "2024");
    assert.equal(r.answer, undefined);
  });

  test("include_domains post-filters by host", async () => {
    const p = createBraveProvider({
      apiKey: "brv",
      fetchImpl: async () =>
        jsonResponse({
          web: {
            results: [
              { title: "A", url: "https://docs.foo.com/x", description: "a" },
              { title: "B", url: "https://other.com/y", description: "b" },
              { title: "C", url: "https://blog.foo.com/z", description: "c" },
            ],
          },
        }),
    });
    const r = await p.search({
      query: "q",
      maxResults: 5,
      includeDomains: ["foo.com"],
    });
    assert.deepEqual(
      r.results.map((it) => it.title),
      ["A", "C"],
    );
  });

  test("exclude_domains post-filters by host", async () => {
    const p = createBraveProvider({
      apiKey: "brv",
      fetchImpl: async () =>
        jsonResponse({
          web: {
            results: [
              { title: "A", url: "https://a.example/" },
              { title: "B", url: "https://b.example/" },
            ],
          },
        }),
    });
    const r = await p.search({
      query: "q",
      maxResults: 5,
      excludeDomains: ["a.example"],
    });
    assert.deepEqual(
      r.results.map((it) => it.title),
      ["B"],
    );
  });

  test("does not expose a fetch() method", () => {
    const p = createBraveProvider({ apiKey: "brv", fetchImpl: async () => jsonResponse({}) });
    assert.equal(p.fetch, undefined);
    assert.equal(p.supportsExtractedContent, false);
  });
});

describe("Exa provider", () => {
  test("search maps numResults to maxResults", async () => {
    let captured: { url: string; body: { numResults?: number } } | null = null;
    const p = createExaProvider({
      apiKey: "exa",
      fetchImpl: async (url, init) => {
        captured = {
          url: url.toString(),
          body: JSON.parse((init?.body as string) ?? "{}"),
        };
        return jsonResponse({
          results: [
            {
              title: "T",
              url: "https://t.example",
              text: "page text",
              score: 0.5,
              publishedDate: "2024-12-31",
            },
          ],
        });
      },
    });
    const r = await p.search({ query: "q", maxResults: 4, includeContent: true });
    assert.equal(r.provider, "exa");
    assert.equal(r.results[0].content, "page text");
    const c = captured as { url: string; body: { numResults?: number } } | null;
    assert.ok(c);
    assert.equal(c!.body.numResults, 4);
    assert.ok(c!.url.endsWith("/search"));
  });

  test("fetch hits /contents and maps text", async () => {
    const p = createExaProvider({
      apiKey: "exa",
      fetchImpl: async () =>
        jsonResponse({
          results: [{ url: "https://x.example", title: "X", text: "body of x" }],
        }),
    });
    const r = await p.fetch!({ url: "https://x.example" });
    assert.equal(r.provider, "exa");
    assert.equal(r.text, "body of x");
    assert.equal(r.title, "X");
  });
});
