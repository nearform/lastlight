import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { safeFetch, SafeFetchError } from "../../../src/extensions/web-search/safe-fetch.js";

function ok(body: string, contentType = "text/html"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

describe("safeFetch", () => {
  test("rejects non-http schemes", async () => {
    await assert.rejects(
      () => safeFetch("file:///etc/passwd", { fetchImpl: async () => ok("x") }),
      (e) => e instanceof SafeFetchError && e.code === "bad-scheme",
    );
    await assert.rejects(
      () => safeFetch("data:text/plain,hi", { fetchImpl: async () => ok("x") }),
      (e) => e instanceof SafeFetchError && e.code === "bad-scheme",
    );
  });

  test("rejects malformed urls", async () => {
    await assert.rejects(
      () => safeFetch("not a url", { fetchImpl: async () => ok("x") }),
      (e) => e instanceof SafeFetchError && e.code === "bad-url",
    );
  });

  test("rejects disallowed content-type", async () => {
    await assert.rejects(
      () =>
        safeFetch("https://example.com/", {
          fetchImpl: async () => ok("binary", "application/octet-stream"),
        }),
      (e) => e instanceof SafeFetchError && e.code === "bad-content-type",
    );
  });

  test("rejects http error responses", async () => {
    await assert.rejects(
      () =>
        safeFetch("https://example.com/", {
          fetchImpl: async () =>
            new Response("nope", {
              status: 404,
              headers: { "content-type": "text/html" },
            }),
        }),
      (e) => e instanceof SafeFetchError && e.code === "http-error" && e.status === 404,
    );
  });

  test("honors max bytes (streaming path)", async () => {
    const big = "x".repeat(2000);
    await assert.rejects(
      () =>
        safeFetch("https://example.com/", {
          fetchImpl: async () => ok(big, "text/plain"),
          maxBytes: 100,
        }),
      (e) => e instanceof SafeFetchError && e.code === "too-large",
    );
  });

  test("follows redirects with scheme re-check and 3-hop cap", async () => {
    let hop = 0;
    const fetchImpl = async (url: string | URL): Promise<Response> => {
      hop++;
      const s = url.toString();
      if (s === "https://a.example/1") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://a.example/2" },
        });
      }
      if (s === "https://a.example/2") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://a.example/3" },
        });
      }
      if (s === "https://a.example/3") return ok("final", "text/plain");
      throw new Error(`unexpected url: ${s}`);
    };
    const r = await safeFetch("https://a.example/1", { fetchImpl });
    assert.equal(r.body, "final");
    assert.equal(r.finalUrl, "https://a.example/3");
    assert.equal(hop, 3);
  });

  test("blocks redirect to non-http scheme", async () => {
    const fetchImpl = async (): Promise<Response> =>
      new Response(null, {
        status: 302,
        headers: { location: "file:///etc/passwd" },
      });
    await assert.rejects(
      () => safeFetch("https://a.example/", { fetchImpl }),
      (e) => e instanceof SafeFetchError && e.code === "bad-scheme",
    );
  });

  test("caps redirects at maxRedirects", async () => {
    const fetchImpl = async (url: string | URL): Promise<Response> => {
      const s = url.toString();
      const m = /\/(\d+)$/.exec(s);
      const n = m ? Number(m[1]) : 0;
      return new Response(null, {
        status: 302,
        headers: { location: `https://a.example/${n + 1}` },
      });
    };
    await assert.rejects(
      () => safeFetch("https://a.example/1", { fetchImpl, maxRedirects: 2 }),
      (e) => e instanceof SafeFetchError && e.code === "too-many-redirects",
    );
  });

  test("returns body for happy-path GET", async () => {
    const r = await safeFetch("https://example.com/", {
      fetchImpl: async () => ok("<html>ok</html>"),
    });
    assert.equal(r.status, 200);
    assert.equal(r.body, "<html>ok</html>");
    assert.equal(r.finalUrl, "https://example.com/");
  });
});
