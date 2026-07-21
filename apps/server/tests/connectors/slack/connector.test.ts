import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import { Hono } from "hono";
import Database from "better-sqlite3";
import { SlackConnector, verifySlackSignature } from "#src/connectors/slack/connector.js";
import { SessionManager } from "#src/connectors/messaging/session-manager.js";
import { StateDb } from "#src/state/db.js";
import type { EventEnvelope } from "#src/connectors/types.js";

function sign(secret: string, ts: string, body: string): string {
  return "v0=" + createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex");
}

describe("verifySlackSignature", () => {
  const secret = "shhh-signing-secret";
  const body = JSON.stringify({ type: "event_callback", event: { type: "message" } });
  const now = 1_700_000_000_000; // fixed clock (ms)
  const ts = String(Math.floor(now / 1000));

  it("accepts a correctly signed, fresh request", () => {
    expect(verifySlackSignature(body, ts, sign(secret, ts, body), secret, now)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    expect(verifySlackSignature(body, ts, sign("other-secret", ts, body), secret, now)).toBe(false);
  });

  it("rejects a tampered body", () => {
    expect(verifySlackSignature(body + "x", ts, sign(secret, ts, body), secret, now)).toBe(false);
  });

  it("rejects a stale timestamp (replay protection)", () => {
    const stale = String(Math.floor(now / 1000) - 600); // 10 minutes old
    expect(verifySlackSignature(body, stale, sign(secret, stale, body), secret, now)).toBe(false);
  });

  it("rejects missing signature or timestamp", () => {
    expect(verifySlackSignature(body, "", "", secret, now)).toBe(false);
    expect(verifySlackSignature(body, ts, "", secret, now)).toBe(false);
  });
});

describe("SlackConnector webhook receiver", () => {
  const secret = "shhh-signing-secret";
  let app: Hono;
  let conn: SlackConnector;
  let db: Database.Database;
  let events: EventEnvelope[];

  function headers(body: string): Record<string, string> {
    const ts = String(Math.floor(Date.now() / 1000));
    return {
      "content-type": "application/json",
      "x-slack-request-timestamp": ts,
      "x-slack-signature": sign(secret, ts, body),
    };
  }

  const post = (body: string, hdrs?: Record<string, string>) =>
    app.request("/webhooks/slack", { method: "POST", headers: hdrs ?? headers(body), body });

  beforeEach(() => {
    app = new Hono();
    db = new Database(":memory:");
    const sm = new SessionManager(db);
    conn = new SlackConnector(
      {
        botToken: "xoxb-test",
        mode: "webhook",
        signingSecret: secret,
        honoApp: app,
        allowedUsers: [],
        botIdentifier: "",
      },
      sm,
    );
    // Stub the Web API client so nothing hits the network during processing.
    (conn as any).web = {
      users: { info: async () => ({ user: { name: "alice" } }) },
      assistant: { threads: { setStatus: async () => {} } },
      reactions: { add: async () => {} },
      chat: { postMessage: async () => ({ ts: "x" }), update: async () => {} },
    };
    events = [];
    conn.on("event", (e: EventEnvelope) => events.push(e));
  });

  afterEach(() => db.close());

  it("answers the url_verification handshake", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "abc123" });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ challenge: "abc123" });
  });

  it("rejects a request with a bad signature", async () => {
    const body = JSON.stringify({ type: "url_verification", challenge: "x" });
    const res = await post(body, {
      "content-type": "application/json",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=deadbeef",
    });
    expect(res.status).toBe(401);
  });

  it("acks and emits an EventEnvelope for a DM message event", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev1",
      event: { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "1.1", text: "hello" },
    });
    const res = await post(body);
    expect(res.status).toBe(200);

    // Processing is async (setImmediate) — let it run.
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    expect(events).toHaveLength(1);
    expect(events[0].source).toBe("slack");
    expect(events[0].body).toBe("hello");
  });

  it("dedupes Slack retries by event_id", async () => {
    const body = JSON.stringify({
      type: "event_callback",
      event_id: "Ev-dup",
      event: { type: "message", channel: "D1", channel_type: "im", user: "U1", ts: "2.2", text: "once" },
    });

    expect((await post(body)).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);

    // Same event_id again (a Slack retry) → acked but NOT reprocessed.
    expect((await post(body)).status).toBe(200);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(1);
  });

  it("ignores message subtypes and bot messages", async () => {
    const edited = JSON.stringify({
      type: "event_callback",
      event_id: "Ev2",
      event: { type: "message", subtype: "message_changed", channel: "D1", channel_type: "im", user: "U1", ts: "3.3", text: "edit" },
    });
    const bot = JSON.stringify({
      type: "event_callback",
      event_id: "Ev3",
      event: { type: "message", channel: "D1", channel_type: "im", bot_id: "B1", ts: "4.4", text: "from a bot" },
    });
    await post(edited);
    await post(bot);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    expect(events).toHaveLength(0);
  });

  it("sends both text fallback and blocks when blocks are provided", async () => {
    let payload: any;
    (conn as any).web.chat.postMessage = async (p: any) => {
      payload = p;
      return { ts: "9.9" };
    };
    const blocks = [{ type: "header", text: { type: "plain_text", text: "hi" } }] as any;
    await conn.sendMessage("C1", "T1", "**bold** fallback", blocks);
    expect(payload.text).toBe("*bold* fallback"); // converted mrkdwn fallback
    expect(payload.blocks).toEqual(blocks);
    expect(payload.thread_ts).toBe("T1");
  });

  it("omits blocks (text only) when none are provided", async () => {
    let payload: any;
    (conn as any).web.chat.postMessage = async (p: any) => {
      payload = p;
      return { ts: "9.9" };
    };
    await conn.sendMessage("C1", null, "plain");
    expect(payload.blocks).toBeUndefined();
    expect(payload.text).toBe("plain");
  });

  it("auto-promotes a markdown image to an image block", async () => {
    let payload: any;
    (conn as any).web.chat.postMessage = async (p: any) => {
      payload = p;
      return { ts: "9.9" };
    };
    await conn.sendMessage("C1", null, "look: ![logo](https://ex.com/l.png)");
    const image = payload.blocks?.find((b: any) => b.type === "image");
    expect(image?.image_url).toBe("https://ex.com/l.png");
    // Notification fallback still carries the (link-downgraded) text.
    expect(payload.text).toContain("<https://ex.com/l.png|logo>");
  });

  it("falls back to plain text when Slack rejects the auto image blocks", async () => {
    const calls: any[] = [];
    (conn as any).web.chat.postMessage = async (p: any) => {
      calls.push(p);
      if (p.blocks) throw new Error("invalid_blocks");
      return { ts: "9.9" };
    };
    const ts = await conn.sendMessage("C1", null, "![x](https://bad/img.png)");
    expect(ts).toBe("9.9");
    expect(calls).toHaveLength(2); // first with blocks (threw), retry text-only
    expect(calls[1].blocks).toBeUndefined();
  });

  // ── Interactivity (approval buttons) ──────────────────────────────────────
  const approvePayload = (overrides: Record<string, unknown> = {}) => ({
    type: "block_actions",
    trigger_id: "trig-1",
    user: { id: "U1" },
    channel: { id: "C1" },
    message: {
      ts: "100.1",
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: "approve?" } },
        { type: "actions", elements: [] },
      ],
    },
    actions: [{ action_id: "approval_approve", value: "run-xyz" }],
    ...overrides,
  });

  const postInteraction = (obj: unknown, hdrs?: Record<string, string>) => {
    const body = "payload=" + encodeURIComponent(JSON.stringify(obj));
    return app.request("/webhooks/slack/interactions", {
      method: "POST",
      headers: hdrs ?? headers(body),
      body,
    });
  };

  const settle = async () => {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
  };

  it("routes a valid approval button click to the approval handler", async () => {
    const actions: any[] = [];
    conn.onApprovalAction(async (a) => { actions.push(a); });
    const res = await postInteraction(approvePayload());
    expect(res.status).toBe(200);
    await settle();
    expect(actions).toHaveLength(1);
    expect(actions[0].decision).toBe("approved");
    expect(actions[0].workflowRunId).toBe("run-xyz");
  });

  it("routes a reject click with the rejected decision", async () => {
    const actions: any[] = [];
    conn.onApprovalAction(async (a) => { actions.push(a); });
    await postInteraction(
      approvePayload({ actions: [{ action_id: "approval_reject", value: "run-9" }], trigger_id: "t2" }),
    );
    await settle();
    expect(actions[0].decision).toBe("rejected");
    expect(actions[0].workflowRunId).toBe("run-9");
  });

  it("rejects an interaction with a bad signature", async () => {
    conn.onApprovalAction(async () => {});
    const res = await postInteraction(approvePayload(), {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
      "x-slack-signature": "v0=bad",
    });
    expect(res.status).toBe(401);
  });

  it("dedupes a retried interaction (same trigger_id) — routes once", async () => {
    const actions: any[] = [];
    conn.onApprovalAction(async (a) => { actions.push(a); });
    await postInteraction(approvePayload());
    await settle();
    await postInteraction(approvePayload()); // Slack retry, identical trigger_id
    await settle();
    expect(actions).toHaveLength(1);
  });
});

// Slack → user identity matching (issue #205). resolveUsername prefers the
// matched GitHub login so a Slack-initiated run attributes to the same person.
describe("SlackConnector user identity matching", () => {
  let db: Database.Database;
  let store: StateDb;
  let conn: SlackConnector;

  function makeConn(profileEmail?: string): SlackConnector {
    const sm = new SessionManager(db);
    const c = new SlackConnector(
      { botToken: "xoxb-test", mode: "socket", appToken: "xapp-test", botIdentifier: "", users: store.users } as never,
      sm,
    );
    (c as any).web = {
      users: {
        info: async () => ({ user: { name: "slackname", real_name: "Real Name", profile: profileEmail ? { email: profileEmail } : {} } }),
      },
    };
    return c;
  }

  beforeEach(() => {
    db = new Database(":memory:");
    store = new StateDb(":memory:");
  });
  afterEach(() => {
    db.close();
    store.close();
  });

  it("returns the GitHub login when the Slack email matches a users row + links the slack id", async () => {
    store.users.getOrCreateUserByGithub({ githubId: 5, login: "ghdev", email: "dev@corp.com" });
    conn = makeConn("dev@corp.com");
    const resolved = await (conn as any).resolveUsername("U555");
    expect(resolved).toBe("ghdev");
    expect(store.users.findBySlackUserId("U555")?.login).toBe("ghdev");
  });

  it("fast-paths an already-linked slack id without needing the email again", async () => {
    const u = store.users.getOrCreateUserByGithub({ githubId: 6, login: "linked", email: "l@corp.com" });
    store.users.linkSlackUser(u.id, "U666");
    conn = makeConn(undefined); // no email scope
    expect(await (conn as any).resolveUsername("U666")).toBe("linked");
  });

  it("falls back to the Slack username when there's no match", async () => {
    conn = makeConn("stranger@corp.com");
    expect(await (conn as any).resolveUsername("U000")).toBe("slackname");
  });

  it("falls back to the Slack username when the email scope is missing", async () => {
    store.users.getOrCreateUserByGithub({ githubId: 7, login: "hidden", email: "h@corp.com" });
    conn = makeConn(undefined); // users:read.email not granted → no email
    expect(await (conn as any).resolveUsername("U111")).toBe("slackname");
  });
});
