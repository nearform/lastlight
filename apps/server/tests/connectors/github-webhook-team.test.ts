import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { GitHubWebhookConnector } from "#src/connectors/github-webhook.js";
import {
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";

const SECRET = "test-webhook-secret";

function sign(body: string): string {
  return "sha256=" + createHmac("sha256", SECRET).update(body).digest("hex");
}

type Scope = { org: string; teamSlug?: string; login?: string };

function connector(onTeamChanged: (scope: Scope) => void): GitHubWebhookConnector {
  return new GitHubWebhookConnector({
    port: 0,
    webhookSecret: SECRET,
    botLogin: "last-light[bot]",
    onTeamChanged,
  });
}

async function post(
  conn: GitHubWebhookConnector,
  event: string,
  payload: Record<string, unknown>,
): Promise<{ status: number; json: any }> {
  const body = JSON.stringify(payload);
  const res = await conn.honoApp.request("/webhooks/github", {
    method: "POST",
    headers: {
      "x-hub-signature-256": sign(body),
      "x-github-event": event,
      "x-github-delivery": "test-delivery",
      "content-type": "application/json",
    },
    body,
  });
  return { status: res.status, json: await res.json() };
}

beforeEach(() => {
  setRuntimeConfig({ managedRepos: ["nearform/lastlight"] } as unknown as LastLightConfig);
});
afterEach(() => resetRuntimeConfigForTests());

describe("GitHubWebhookConnector — team-visibility invalidation", () => {
  it("invalidates one person on a membership change", async () => {
    const seen: Scope[] = [];
    const { json } = await post(connector((s) => seen.push(s)), "membership", {
      action: "removed",
      scope: "team",
      organization: { login: "nearform" },
      team: { slug: "platform" },
      member: { login: "alice" },
    });
    expect(json).toEqual({ accepted: true, kind: "team-visibility-sync" });
    expect(seen).toEqual([{ org: "nearform", teamSlug: "platform", login: "alice" }]);
  });

  it("invalidates the whole team when its repo grant changes", async () => {
    const seen: Scope[] = [];
    await post(connector((s) => seen.push(s)), "team", {
      action: "added_to_repository",
      organization: { login: "nearform" },
      team: { slug: "platform" },
      repository: { full_name: "nearform/lastlight" },
    });
    expect(seen).toEqual([{ org: "nearform", teamSlug: "platform" }]);
  });

  it("handles `team.deleted`, which IGNORED_ACTIONS would otherwise swallow", async () => {
    // The point of handling these before the action filter: `deleted` and
    // `edited` are both in IGNORED_ACTIONS, and a deleted team is exactly the
    // case where a stale cached grant matters most.
    const seen: Scope[] = [];
    await post(connector((s) => seen.push(s)), "team", {
      action: "deleted",
      organization: { login: "nearform" },
      team: { slug: "platform" },
    });
    expect(seen).toEqual([{ org: "nearform", teamSlug: "platform" }]);
  });

  it("invalidates a person removed from the org entirely", async () => {
    const seen: Scope[] = [];
    await post(connector((s) => seen.push(s)), "organization", {
      action: "member_removed",
      organization: { login: "nearform" },
      membership: { user: { login: "alice" } },
    });
    expect(seen).toEqual([{ org: "nearform", login: "alice" }]);
  });

  it("ignores org events that say nothing about membership", async () => {
    const seen: Scope[] = [];
    await post(connector((s) => seen.push(s)), "organization", {
      action: "member_invited",
      organization: { login: "nearform" },
      invitation: { login: "alice" },
    });
    expect(seen).toEqual([]);
  });

  it("accepts the delivery even with no handler wired (feature off)", async () => {
    const conn = new GitHubWebhookConnector({
      port: 0,
      webhookSecret: SECRET,
      botLogin: "last-light[bot]",
    });
    const { status, json } = await post(conn, "team", {
      action: "created",
      organization: { login: "nearform" },
      team: { slug: "platform" },
    });
    expect(status).toBe(200);
    expect(json.kind).toBe("team-visibility-sync");
  });
});
