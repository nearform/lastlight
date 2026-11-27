import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JiraClient, JiraApiError, JiraRateLimitError } from "#src/engine/jira/client.js";

const myselfFixture = JSON.parse(
  readFileSync(resolve("tests/engine/jira/fixtures/myself.json"), "utf-8"),
) as { accountId: string };

const CREDS = { siteUrl: "https://acme.atlassian.net", email: "bot@acme.com", apiToken: "tok-123" };
const EXPECTED_AUTH = "Basic " + Buffer.from("bot@acme.com:tok-123").toString("base64");

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body?: unknown;
}

// A fetch stub that records each call and replays programmed responses.
function stubFetch(responses: Array<{ status?: number; json?: unknown; headers?: Record<string, string> }>) {
  const calls: Call[] = [];
  let i = 0;
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({
      url: String(url),
      method: init.method,
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    // null, not "", so a 204 (no-body status) is a valid Response.
    const body = r.json !== undefined ? JSON.stringify(r.json) : null;
    return new Response(body, { status: r.status ?? 200, headers: r.headers });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe("JiraClient base URL + auth", () => {
  it("uses the site URL and basic auth for a classic token (no cloudId)", async () => {
    const f = stubFetch([{ json: myselfFixture }]);
    const me = await new JiraClient(CREDS, { fetch: f.impl }).myself();
    expect(me.accountId).toBe(myselfFixture.accountId);
    expect(f.calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(f.calls[0].method).toBe("GET");
    expect(f.calls[0].headers.Authorization).toBe(EXPECTED_AUTH);
  });

  it("uses the gateway base when a cloudId is set (scoped token)", async () => {
    const f = stubFetch([{ json: myselfFixture }]);
    await new JiraClient({ ...CREDS, cloudId: "cid-7" }, { fetch: f.impl }).myself();
    expect(f.calls[0].url).toBe("https://api.atlassian.com/ex/jira/cid-7/rest/api/3/myself");
  });
});

describe("JiraClient issue reads/writes", () => {
  it("parses getIssue into the structured shape", async () => {
    const raw = {
      key: "PROJ-1",
      fields: {
        summary: "A ticket",
        description: { type: "doc", version: 1, content: [] },
        labels: ["lastlight"],
        components: [{ name: "Backend" }, {}],
        status: { name: "To Do" },
        comment: { comments: [{ id: "100", author: { accountId: "acc-1" }, body: { type: "doc", version: 1, content: [] }, created: "t" }] },
      },
    };
    const f = stubFetch([{ json: raw }]);
    const issue = await new JiraClient(CREDS, { fetch: f.impl }).getIssue("PROJ-1");
    expect(issue).toEqual({
      key: "PROJ-1",
      summary: "A ticket",
      description: { type: "doc", version: 1, content: [] },
      labels: ["lastlight"],
      components: ["Backend"],
      status: "To Do",
      comments: [{ id: "100", authorAccountId: "acc-1", body: { type: "doc", version: 1, content: [] }, created: "t" }],
    });
    expect(f.calls[0].url).toContain("/rest/api/3/issue/PROJ-1?fields=summary,description,labels,components,status,comment");
  });

  it("addComment posts an ADF body and returns the new id", async () => {
    const f = stubFetch([{ status: 201, json: { id: "555" } }]);
    const body = { type: "doc" as const, version: 1, content: [] };
    const id = await new JiraClient(CREDS, { fetch: f.impl }).addComment("PROJ-1", body);
    expect(id).toBe("555");
    expect(f.calls[0].method).toBe("POST");
    expect(f.calls[0].url).toBe("https://acme.atlassian.net/rest/api/3/issue/PROJ-1/comment");
    expect(f.calls[0].body).toEqual({ body });
    expect(f.calls[0].headers["Content-Type"]).toBe("application/json");
  });

  it("transition posts the transition id", async () => {
    const f = stubFetch([{ status: 204 }]);
    await new JiraClient(CREDS, { fetch: f.impl }).transition("PROJ-1", "21");
    expect(f.calls[0].body).toEqual({ transition: { id: "21" } });
  });

  it("addRemoteLink carries a globalId so repeats upsert", async () => {
    const f = stubFetch([{ status: 201, json: {} }]);
    await new JiraClient(CREDS, { fetch: f.impl }).addRemoteLink("PROJ-1", {
      globalId: "lastlight:pr",
      url: "https://github.com/o/r/pull/1",
      title: "PR",
    });
    expect(f.calls[0].body).toEqual({
      globalId: "lastlight:pr",
      object: { url: "https://github.com/o/r/pull/1", title: "PR" },
    });
  });

  it("addLabels sends an add-only update", async () => {
    const f = stubFetch([{ status: 204 }]);
    await new JiraClient(CREDS, { fetch: f.impl }).addLabels("PROJ-1", ["a", "b"]);
    expect(f.calls[0].method).toBe("PUT");
    expect(f.calls[0].body).toEqual({ update: { labels: [{ add: "a" }, { add: "b" }] } });
  });
});

describe("JiraClient admin webhooks", () => {
  it("createWebhook posts name/url/events with jql filter and secret", async () => {
    const f = stubFetch([{ status: 201, json: { self: "x" } }]);
    await new JiraClient(CREDS, { fetch: f.impl }).createWebhook({
      name: "lastlight:test",
      url: "https://ll/webhooks/jira",
      events: ["jira:issue_created", "comment_created"],
      jql: "project in (KAN)",
      secret: "sh",
    });
    expect(f.calls[0].url).toBe("https://acme.atlassian.net/rest/webhooks/1.0/webhook");
    expect(f.calls[0].body).toEqual({
      name: "lastlight:test",
      url: "https://ll/webhooks/jira",
      events: ["jira:issue_created", "comment_created"],
      excludeBody: false,
      filters: { "issue-related-events-section": "project in (KAN)" },
      secret: "sh",
    });
  });
});

describe("JiraClient error + rate-limit handling", () => {
  it("throws JiraApiError on a non-2xx", async () => {
    const f = stubFetch([{ status: 404, json: { message: "no" } }]);
    await expect(new JiraClient(CREDS, { fetch: f.impl }).getIssue("X-9")).rejects.toMatchObject({
      name: "JiraApiError",
      status: 404,
    });
  });

  it("retries a 429 within the wait bound, then succeeds", async () => {
    const sleep = vi.fn(async () => {});
    const f = stubFetch([
      { status: 429, headers: { "retry-after": "0" } },
      { json: myselfFixture },
    ]);
    const me = await new JiraClient(CREDS, { fetch: f.impl, sleep }).myself();
    expect(me.accountId).toBe(myselfFixture.accountId);
    expect(f.calls).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("terminates instead of spinning when 429 Retry-After is 0", async () => {
    // Regression: wait=0 left `waited` at 0, so the bound never tripped.
    const sleep = vi.fn(async () => {});
    const f = stubFetch([{ status: 429, headers: { "retry-after": "0" } }]);
    await expect(
      new JiraClient(CREDS, { fetch: f.impl, sleep, maxRetryWaitMs: 1500 }).myself(),
    ).rejects.toBeInstanceOf(JiraRateLimitError);
    expect(sleep).toHaveBeenCalledTimes(1); // floored to 1s, so the 1.5s bound trips on the 2nd 429
  });

  it("terminates when 429 Retry-After is a past HTTP date", async () => {
    // The other half of the reviewer's finding: a past date gives a negative
    // `at - now`, which must still floor to a positive wait so `waited` advances.
    const sleep = vi.fn(async () => {});
    const pastDate = new Date(Date.now() - 60_000).toUTCString();
    const f = stubFetch([{ status: 429, headers: { "retry-after": pastDate } }]);
    await expect(
      new JiraClient(CREDS, { fetch: f.impl, sleep, maxRetryWaitMs: 1500 }).myself(),
    ).rejects.toBeInstanceOf(JiraRateLimitError);
    expect(sleep).toHaveBeenCalledTimes(1); // floored to 1s, so the 1.5s bound trips on the 2nd 429
  });

  it("backs off exponentially rather than hammering when 429 persists", async () => {
    // With a flat 1s wait a persistent 429 would mean ~300 requests over the
    // 5-min bound; exponential backoff (1s, 2s, 4s… capped) keeps it to ~10.
    const sleep = vi.fn(async () => {});
    const f = stubFetch([{ status: 429, headers: { "retry-after": "0" } }]);
    await expect(
      new JiraClient(CREDS, { fetch: f.impl, sleep }).myself(), // default 5-min bound
    ).rejects.toBeInstanceOf(JiraRateLimitError);
    expect(f.calls.length).toBeLessThanOrEqual(12);
  });

  it("honours a genuine Retry-After over the backoff floor", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const f = stubFetch([{ status: 429, headers: { "retry-after": "30" } }, { json: myselfFixture }]);
    await new JiraClient(CREDS, { fetch: f.impl, sleep }).myself();
    expect(sleep).toHaveBeenCalledWith(30_000); // the 30s hint wins over the 1s first backoff
  });

  it("gives up with JiraRateLimitError when 429 exceeds the wait bound", async () => {
    const sleep = vi.fn(async () => {});
    const f = stubFetch([{ status: 429, headers: { "retry-after": "600" } }]);
    await expect(
      new JiraClient(CREDS, { fetch: f.impl, sleep, maxRetryWaitMs: 1000 }).myself(),
    ).rejects.toBeInstanceOf(JiraRateLimitError);
    expect(sleep).not.toHaveBeenCalled();
  });
});
