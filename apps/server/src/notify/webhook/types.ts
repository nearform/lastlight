/**
 * Outgoing webhooks: Last Light POSTs a signed JSON payload to operator-listed
 * endpoints when a run starts, waits for an approval, finishes, or when an
 * autonomous dispatch is held. See spec/03-integrations.md ("Outgoing webhooks").
 *
 * Operator config only: the key is top-level `webhooks:`, which is not in
 * `repoConfig.allowKeys`, so a repo's `.lastlight/` can neither add an endpoint
 * nor redirect one.
 */

export const WEBHOOK_EVENT_TYPES = [
  "run.started",
  "run.approval_requested",
  "run.finished",
  "autonomy.held",
] as const;

export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

export interface WebhookEndpointConfig {
  url: string;
  /** Name of the env var holding the HMAC key. The key itself is never in config. */
  secretEnv: string;
  events: WebhookEventType[];
  /** `owner/repo` filter; empty = every repo. */
  repos: string[];
}

export interface WebhookRunInfo {
  id: string;
  workflow: string;
  repo?: string;
  issueNumber?: number;
  issueUrl?: string;
  dashboardUrl?: string;
  autonomous: boolean;
  trigger?: string;
}

export interface WebhookPayload {
  type: WebhookEventType;
  /** Stable across retries, so a receiver can de-duplicate. */
  deliveryId: string;
  timestamp: string;
  /** A ready-made one-line summary built from fixed text and identifiers only. */
  text: string;
  run?: WebhookRunInfo;
  /** `summary` is untrusted (agent-written) text, truncated. */
  approval?: { gate: string; summary: string; approveCommand: string; rejectCommand: string };
  /** `error` is untrusted text, truncated. */
  result?: { status: "succeeded" | "failed" | "cancelled"; prUrl?: string; error?: string };
  hold?: { provider: string; window: string; usedPct: number; maxPercent: number; resetsAt: string | null };
  /** For `autonomy.held`, which has no run yet: the held issue. */
  subject?: { repo: string; issueNumber?: number; issueUrl?: string };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate the raw `webhooks:` value. Throws, naming the entry and field, on
 * anything malformed: an operator who configured a webhook wants to know at
 * boot, not discover later that no event ever arrived.
 */
export function normalizeWebhooks(raw: unknown): WebhookEndpointConfig[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("webhooks must be a list of endpoints");
  return raw.map((entry, i) => {
    const at = `webhooks[${i}]`;
    if (!isPlainObject(entry)) throw new Error(`${at} must be a mapping with url and secretEnv`);

    const url = typeof entry.url === "string" ? entry.url.trim() : "";
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`${at}.url must be an http(s) URL`);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`${at}.url must be an http(s) URL`);
    }
    if (parsed.username || parsed.password) {
      throw new Error(`${at}.url must not carry credentials; put the signing key in the env var named by secretEnv`);
    }

    const secretEnv = typeof entry.secretEnv === "string" ? entry.secretEnv.trim() : "";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(secretEnv)) {
      throw new Error(`${at}.secretEnv must name an environment variable`);
    }

    let events: WebhookEventType[] = [...WEBHOOK_EVENT_TYPES];
    if (entry.events !== undefined) {
      if (!Array.isArray(entry.events) || entry.events.length === 0) {
        throw new Error(`${at}.events must be a non-empty list of ${WEBHOOK_EVENT_TYPES.join(", ")}`);
      }
      for (const e of entry.events) {
        if (!(WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(e)) {
          throw new Error(`${at}.events: unknown event "${String(e)}" (known: ${WEBHOOK_EVENT_TYPES.join(", ")})`);
        }
      }
      events = [...new Set(entry.events as WebhookEventType[])];
    }

    let repos: string[] = [];
    if (entry.repos !== undefined) {
      if (!Array.isArray(entry.repos) || entry.repos.some((r) => typeof r !== "string" || !r.includes("/"))) {
        throw new Error(`${at}.repos must be a list of owner/repo names`);
      }
      repos = (entry.repos as string[]).map((r) => r.trim());
    }

    return { url, secretEnv, events, repos };
  });
}

/** Every endpoint's key must be set at boot. Names the variable, never a value. */
export function assertWebhookSecrets(endpoints: WebhookEndpointConfig[], env: NodeJS.ProcessEnv): void {
  endpoints.forEach((w, i) => {
    if (!env[w.secretEnv]) {
      throw new Error(`webhooks[${i}].secretEnv: environment variable ${w.secretEnv} is not set`);
    }
  });
}

/** A URL for display: no query string or fragment (they may carry a token). */
export function displayWebhookUrl(url: string): string {
  try {
    const u = new URL(url);
    const hidden = u.search || u.hash ? "?[redacted]" : "";
    return `${u.origin}${u.pathname}${hidden}`;
  } catch {
    return "[invalid url]";
  }
}
