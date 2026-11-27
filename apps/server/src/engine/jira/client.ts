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
 * Exponential-backoff base and per-step cap for a 429 wait. The wait is
 * `max(Retry-After, base * 2^(attempt-1))`, capped per step — so a genuine
 * Retry-After is honoured, but a server that keeps answering 429 with a zero or
 * past hint is retried a handful of times (1s, 2s, 4s…) within the total bound,
 * not ~300 times at one request per second. The growing base also guarantees
 * `waited` advances, so the bound always trips.
 */
const RETRY_BACKOFF_BASE_MS = 1_000;
const RETRY_BACKOFF_STEP_CAP_MS = 60_000;

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

    // Exponential backoff on 429, bounded by total wait — see the backoff note.
    let waited = 0;
    let attempt = 0;
    for (;;) {
      const res = await this.fetchImpl(url, init);
      if (res.status !== 429) return res;
      attempt += 1;
      const backoff = Math.min(RETRY_BACKOFF_BASE_MS * 2 ** (attempt - 1), RETRY_BACKOFF_STEP_CAP_MS);
      const wait = Math.max(retryAfterMs(res.headers.get("retry-after")), backoff);
      if (waited + wait > this.maxWaitMs) {
        throw new JiraRateLimitError(
          `Jira rate limited; next wait ${Math.round(wait / 1000)}s would exceed the ` +
            `${Math.round(this.maxWaitMs / 1000)}s bound (attempt ${attempt})`,
        );
      }
      log.warn("rate limited; backing off", { url, waitMs: wait, waited, attempt });
      await this.sleep(wait);
      waited += wait;
    }
  }
}

/**
 * The server's `Retry-After` in ms, or 0 when it gives no usable guidance (a
 * zero, a past HTTP date, or an unparseable value). The caller takes the max of
 * this and its exponential backoff, so 0 means "no hint — use backoff". Absent
 * stays a minute: the server said nothing, so don't retry eagerly.
 */
function retryAfterMs(header: string | null, now: number = Date.now()): number {
  if (!header) return 60_000;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? 60_000 : Math.max(0, at - now);
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
