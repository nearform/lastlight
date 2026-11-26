import { createHmac } from "node:crypto";
import type { WebhookEndpointConfig, WebhookPayload } from "./types.js";

/** Waits between attempts: up to three retries after the first try. */
const BACKOFF_MS = [1000, 4000, 16000] as const;
const DEFAULT_TIMEOUT_MS = 5000;

/** GitHub's signature format, so existing receivers verify it unchanged. */
export function signBody(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

export interface DeliverOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

export interface DeliveryResult {
  ok: boolean;
  attempts: number;
  status?: number;
}

function retryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * POST one payload. Retries a network error, timeout, 5xx or 429 up to three
 * times (1 s, 4 s, 16 s), with the same body and delivery id; any other answer
 * is final. Every attempt is aborted at `timeoutMs`. Never throws: the caller
 * fires and forgets, and a run must never wait on, or fail because of, a
 * receiver.
 */
export async function deliverWebhook(
  endpoint: WebhookEndpointConfig,
  secret: string,
  payload: WebhookPayload,
  opts: DeliverOptions = {},
): Promise<DeliveryResult> {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const body = JSON.stringify(payload);
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": "lastlight-webhook",
    "X-Hub-Signature-256": signBody(secret, body),
    "X-Lastlight-Event": payload.type,
    "X-Request-ID": payload.deliveryId,
  };

  let attempts = 0;
  let lastStatus: number | undefined;
  for (let i = 0; i <= BACKOFF_MS.length; i++) {
    if (i > 0) await sleep(BACKOFF_MS[i - 1]);
    attempts++;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await doFetch(endpoint.url, { method: "POST", headers, body, signal: ac.signal, redirect: "manual" });
      lastStatus = res.status;
      // Drain so the connection can be reused; the body is not used.
      await res.body?.cancel().catch(() => undefined);
      if (res.status >= 200 && res.status < 300) return { ok: true, attempts, status: res.status };
      if (!retryable(res.status)) return { ok: false, attempts, status: res.status };
    } catch {
      lastStatus = undefined; // network error or timeout: retry
    } finally {
      clearTimeout(timer);
    }
  }
  return lastStatus === undefined ? { ok: false, attempts } : { ok: false, attempts, status: lastStatus };
}
