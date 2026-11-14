import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deliverWebhook, signBody } from "#src/notify/webhook/deliver.js";
import type { WebhookEndpointConfig, WebhookPayload } from "#src/notify/webhook/types.js";

const endpoint: WebhookEndpointConfig = {
  url: "http://127.0.0.1:9999/hook",
  secretEnv: "HOOK_SECRET",
  events: ["run.started"],
  repos: [],
};
const payload: WebhookPayload = {
  type: "run.started",
  deliveryId: "11111111-2222-3333-4444-555555555555",
  timestamp: "2026-11-07T10:00:00.000Z",
  text: "run.started",
};

type Call = { url: string; init: RequestInit };
function fakeFetch(answers: Array<number | "network" | "hang">) {
  const calls: Call[] = [];
  const fn = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    const a = answers[Math.min(calls.length - 1, answers.length - 1)];
    if (a === "network") return Promise.reject(new TypeError("fetch failed"));
    if (a === "hang")
      return new Promise<Response>((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    return Promise.resolve(new Response(null, { status: a }));
  });
  return { fn, calls };
}
const noSleep = () => Promise.resolve();

describe("signBody", () => {
  it("is GitHub's sha256= HMAC over the raw body", () => {
    const body = '{"a":1}';
    expect(signBody("k", body)).toBe("sha256=" + createHmac("sha256", "k").update(body).digest("hex"));
  });
});

describe("deliverWebhook", () => {
  it("POSTs the JSON body with the signature and event headers", async () => {
    const { fn, calls } = fakeFetch([200]);
    const r = await deliverWebhook(endpoint, "k", payload, { fetch: fn as never, sleep: noSleep });
    expect(r).toEqual({ ok: true, attempts: 1, status: 200 });
    const h = calls[0].init.headers as Record<string, string>;
    const body = calls[0].init.body as string;
    expect(calls[0].url).toBe(endpoint.url);
    expect(calls[0].init.method).toBe("POST");
    expect(JSON.parse(body)).toEqual(payload);
    expect(h["Content-Type"]).toBe("application/json");
    expect(h["X-Hub-Signature-256"]).toBe(signBody("k", body));
    expect(h["X-Lastlight-Event"]).toBe("run.started");
    expect(h["X-Request-ID"]).toBe(payload.deliveryId);
  });

  it("retries a 5xx with the same delivery id", async () => {
    const { fn, calls } = fakeFetch([500, 200]);
    const sleep = vi.fn(noSleep);
    const r = await deliverWebhook(endpoint, "k", payload, { fetch: fn as never, sleep });
    expect(r).toEqual({ ok: true, attempts: 2, status: 200 });
    const ids = calls.map((c) => (c.init.headers as Record<string, string>)["X-Request-ID"]);
    expect(new Set(ids).size).toBe(1);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it("retries a 429", async () => {
    const { fn } = fakeFetch([429, 204]);
    expect((await deliverWebhook(endpoint, "k", payload, { fetch: fn as never, sleep: noSleep })).attempts).toBe(2);
  });

  it("does not retry a 4xx", async () => {
    const { fn } = fakeFetch([400, 200]);
    const r = await deliverWebhook(endpoint, "k", payload, { fetch: fn as never, sleep: noSleep });
    expect(r).toEqual({ ok: false, attempts: 1, status: 400 });
  });

  it("gives up after three retries of a network error, backing off 1 s, 4 s, 16 s", async () => {
    const { fn } = fakeFetch(["network"]);
    const sleep = vi.fn(noSleep);
    const r = await deliverWebhook(endpoint, "k", payload, { fetch: fn as never, sleep });
    expect(r).toEqual({ ok: false, attempts: 4 });
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([1000, 4000, 16000]);
  });

  it("aborts a hanging receiver at the timeout on every attempt and still resolves", async () => {
    const { fn } = fakeFetch(["hang"]);
    const started = Date.now();
    const r = await deliverWebhook(endpoint, "k", payload, { fetch: fn as never, sleep: noSleep, timeoutMs: 20 });
    expect(r).toEqual({ ok: false, attempts: 4 });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("the per-attempt timeout timer never keeps the process alive", async () => {
    const real = globalThis.setTimeout;
    const timers: Array<{ hasRef(): boolean }> = [];
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      const t = real(fn, ms);
      timers.push(t);
      return t;
    }) as typeof setTimeout);
    try {
      await deliverWebhook(endpoint, "k", payload, { fetch: (async () => new Response("", { status: 200 })) as typeof fetch });
    } finally {
      spy.mockRestore();
    }
    expect(timers.length).toBeGreaterThan(0);
    expect(timers.every((t) => !t.hasRef())).toBe(true);
  });

  it("never throws, even when fetch throws synchronously", async () => {
    const fn = vi.fn(() => {
      throw new Error("boom");
    });
    await expect(deliverWebhook(endpoint, "k", payload, { fetch: fn as never, sleep: noSleep })).resolves.toEqual({
      ok: false,
      attempts: 4,
    });
  });
});
