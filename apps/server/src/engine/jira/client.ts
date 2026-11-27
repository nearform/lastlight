// JiraClient — the harness-side Jira Cloud REST v3 client (issue #501). Basic
// auth as the bot account, with a bounded wait on 429. Used only by the harness
// (connector, notifier, lifecycle, the webhook CLI); agents never see it.
//
// Base URL: a SCOPED token authenticates against the gateway
// (api.atlassian.com/ex/jira/{cloudId}); a classic token uses the site URL.
// `cloudId` (config) picks the path — see JiraConfig.

import { logger } from "../../logging/logger.js";
import type { JiraConfig } from "../../config/config.js";
import type { AdfDoc } from "./adf.js";

const log = logger("jira");

/** The longest one call waits out 429s before giving up (same bound as elsewhere). */
const MAX_RETRY_WAIT_MS = 5 * 60 * 1000;

/**
 * Floor for a single 429 wait. A `Retry-After: 0` or a past date would otherwise
 * leave `waited` at 0, so the MAX_RETRY_WAIT_MS bound would never trip and the
 * loop would busy-spin on the rate limiter. The floor guarantees progress.
 */
const MIN_RETRY_WAIT_MS = 1_000;

/** A Jira request that kept getting 429'd past the wait bound. */
export class JiraRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraRateLimitError";
  }
}

/** A non-2xx Jira response. `status` and `body` are carried for the caller's log. */
export class JiraApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = "JiraApiError";
  }
}

export interface JiraMyself {
  accountId: string;
  displayName?: string;
  accountType?: string;
}

export interface JiraComment {
  id: string;
  authorAccountId?: string;
  body: AdfDoc;
  created?: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: AdfDoc | null;
  labels: string[];
  components: string[];
  status: string | null;
  comments: JiraComment[];
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatus: string | null;
}

/** An admin webhook as `/rest/webhooks/1.0/webhook` returns it. */
export interface JiraWebhook {
  name: string;
  url: string;
  events: string[];
  self?: string;
  enabled?: boolean;
  filters?: Record<string, string>;
}

/** The desired admin-webhook state the reconcile CLI creates/updates. */
export interface JiraWebhookSpec {
  name: string;
  url: string;
  events: string[];
  jql?: string;
  secret?: string;
}

export interface JiraClientDeps {
  /** Injected for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxRetryWaitMs?: number;
}

type JiraCreds = Pick<JiraConfig, "siteUrl" | "cloudId" | "email" | "apiToken">;

export class JiraClient {
  private readonly base: string;
  private readonly authHeader: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;

  constructor(creds: JiraCreds, deps: JiraClientDeps = {}) {
    this.base = creds.cloudId
      ? `https://api.atlassian.com/ex/jira/${creds.cloudId}`
      : creds.siteUrl.replace(/\/+$/, "");
    this.authHeader = "Basic " + Buffer.from(`${creds.email}:${creds.apiToken}`).toString("base64");
    this.fetchImpl = deps.fetch ?? fetch;
    this.sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.maxWaitMs = deps.maxRetryWaitMs ?? MAX_RETRY_WAIT_MS;
  }

  // --- REST v3 ---------------------------------------------------------------

  async myself(): Promise<JiraMyself> {
    return this.json<JiraMyself>("GET", "/rest/api/3/myself");
  }

  async getIssue(key: string): Promise<JiraIssue> {
    const raw = await this.json<RawIssue>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}?fields=summary,description,labels,components,status,comment`,
    );
    const f = raw.fields ?? {};
    return {
      key: raw.key,
      summary: f.summary ?? "",
      description: f.description ?? null,
      labels: f.labels ?? [],
      components: (f.components ?? []).map((c) => c.name).filter((n): n is string => !!n),
      status: f.status?.name ?? null,
      comments: (f.comment?.comments ?? []).map((c) => ({
        id: c.id,
        authorAccountId: c.author?.accountId,
        body: c.body,
        created: c.created,
      })),
    };
  }

  /** Create a comment; returns its id. */
  async addComment(key: string, body: AdfDoc): Promise<string> {
    const res = await this.json<{ id: string }>(
      "POST",
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment`,
      { body },
    );
    return res.id;
  }

  async updateComment(key: string, commentId: string, body: AdfDoc): Promise<void> {
    await this.json<void>(
      "PUT",
      `/rest/api/3/issue/${encodeURIComponent(key)}/comment/${encodeURIComponent(commentId)}`,
      { body },
    );
  }

  async getTransitions(key: string): Promise<JiraTransition[]> {
    const res = await this.json<{ transitions?: RawTransition[] }>(
      "GET",
      `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`,
    );
    return (res.transitions ?? []).map((t) => ({ id: t.id, name: t.name, toStatus: t.to?.name ?? null }));
  }

  async transition(key: string, transitionId: string): Promise<void> {
    await this.json<void>("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  /** Upsert a remote link — a repeat with the same `globalId` replaces, never duplicates. */
  async addRemoteLink(key: string, link: { globalId: string; url: string; title: string }): Promise<void> {
    await this.json<void>("POST", `/rest/api/3/issue/${encodeURIComponent(key)}/remotelink`, {
      globalId: link.globalId,
      object: { url: link.url, title: link.title },
    });
  }

  async addLabels(key: string, labels: string[]): Promise<void> {
    await this.json<void>("PUT", `/rest/api/3/issue/${encodeURIComponent(key)}`, {
      update: { labels: labels.map((add) => ({ add })) },
    });
  }

  // --- Admin webhooks (`/rest/webhooks/1.0/`) --------------------------------

  async listWebhooks(): Promise<JiraWebhook[]> {
    return this.json<JiraWebhook[]>("GET", "/rest/webhooks/1.0/webhook");
  }

  async createWebhook(spec: JiraWebhookSpec): Promise<{ self?: string }> {
    return this.json<{ self?: string }>("POST", "/rest/webhooks/1.0/webhook", webhookBody(spec));
  }

  async updateWebhook(id: string, spec: JiraWebhookSpec): Promise<void> {
    await this.json<void>("PUT", `/rest/webhooks/1.0/webhook/${encodeURIComponent(id)}`, webhookBody(spec));
  }

  async deleteWebhook(id: string): Promise<void> {
    await this.json<void>("DELETE", `/rest/webhooks/1.0/webhook/${encodeURIComponent(id)}`);
  }

  // --- transport -------------------------------------------------------------

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new JiraApiError(`Jira ${method} ${path} failed: ${res.status}`, res.status, text);
    }
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = this.base + path;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: this.authHeader,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    };

    // Bounded wait on 429 — see the note on MAX_RETRY_WAIT_MS.
    let waited = 0;
    for (;;) {
      const res = await this.fetchImpl(url, init);
      if (res.status !== 429) return res;
      const wait = retryAfterMs(res.headers.get("retry-after"));
      if (waited + wait > this.maxWaitMs) {
        throw new JiraRateLimitError(
          `Jira rate limited; Retry-After ${Math.round(wait / 1000)}s exceeds the ` +
            `${Math.round(this.maxWaitMs / 1000)}s wait bound`,
        );
      }
      log.warn("rate limited; waiting it out", { url, waitMs: wait, waited });
      await this.sleep(wait);
      waited += wait;
    }
  }
}

/** `Retry-After` in ms. Jira sends seconds or an HTTP date; absent → a minute, never zero. */
function retryAfterMs(header: string | null, now: number = Date.now()): number {
  if (!header) return 60_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(MIN_RETRY_WAIT_MS, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 60_000 : Math.max(MIN_RETRY_WAIT_MS, at - now);
}

function webhookBody(spec: JiraWebhookSpec): Record<string, unknown> {
  return {
    name: spec.name,
    url: spec.url,
    events: spec.events,
    excludeBody: false,
    ...(spec.jql ? { filters: { "issue-related-events-section": spec.jql } } : {}),
    ...(spec.secret ? { secret: spec.secret } : {}),
  };
}

interface RawIssue {
  key: string;
  fields?: {
    summary?: string;
    description?: AdfDoc | null;
    labels?: string[];
    components?: Array<{ name?: string }>;
    status?: { name?: string };
    comment?: { comments?: Array<{ id: string; author?: { accountId?: string }; body: AdfDoc; created?: string }> };
  };
}

interface RawTransition {
  id: string;
  name: string;
  to?: { name?: string };
}
