import { Hono } from "hono";
import path from "node:path";
import { timingSafeEqual, randomBytes } from "node:crypto";
import { streamSSE } from "hono/streaming";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Slack, GitHub } from "arctic";
import type { SessionSource, SessionMeta } from "./sessions.js";
import type { StateDb, WorkflowRun } from "../state/db.js";
import { tailJsonl } from "./tail.js";
import {
  listRunningContainers,
  killContainer,
  getContainerStats,
  listServerContainers,
  resolveServerContainer,
  getContainerLogs,
  streamContainerLogs,
} from "./docker.js";
import { authMiddleware, createToken, verifyTokenForRefresh, decodeToken } from "./auth.js";
import { Cron } from "croner";
import type { CronScheduler } from "../cron/scheduler.js";
import { enumerateOverlayAssets } from "../config/overlay-assets.js";
import {
  getCronWorkflows,
  getWorkflow,
  listAgentWorkflows,
  loadWorkflowYamlRaw,
  loadPromptTemplate,
  loadSkillRaw,
} from "../workflows/loader.js";
import {
  getWorkflowTriggers,
  getWorkflowTriggerKinds,
} from "../workflows/triggers.js";
import {
  getManagedRepos,
  getInstallationRepos,
  getInstallationReposRefreshedAt,
} from "../managed-repos.js";
import { getRuntimeConfig } from "../config/config.js";
import { getServerVersion } from "./version.js";
import { BuildAssetStore, buildAssetIssueKey } from "../state/build-assets.js";
import type { WorkflowApproval } from "../state/approval-store.js";
import type { PublicConfigBundle, BuildAssetsLocation } from "../config/config.js";

/**
 * Map a build-asset filename extension to a binary MIME type, or null when the
 * file should be served as text/plain (markdown handoff docs). Binary artifacts
 * — PNG screenshot evidence from browser QA, and `/demo`'s mp4/webm video — must
 * be served as raw bytes, not utf-8 text, so the dashboard can render them in an
 * <img>/<video> and GitHub can embed them.
 */
export function binaryMimeForArtifact(name: string): string | null {
  const ext = name.slice(name.lastIndexOf(".")).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".mp4":
      return "video/mp4";
    case ".webm":
      return "video/webm";
    default:
      return null;
  }
}

/**
 * Build an HTTP response for a binary artifact buffer, honoring a `Range`
 * request so <video> elements can seek/stream (GitHub's inline player and
 * browsers send `Range: bytes=…`; without 206 support, seeking — and some
 * players — break). Artifacts are small (≤ a few MB), so we slice the in-memory
 * buffer rather than streaming from disk. Returns 206 for a satisfiable range,
 * 416 for an unsatisfiable one, else 200 with the full body. `Accept-Ranges:
 * bytes` is always advertised.
 */
export function rangeResponse(
  rangeHeader: string | undefined,
  buf: Buffer,
  mime: string,
  cacheControl: string,
): Response {
  const total = buf.length;
  const baseHeaders: Record<string, string> = {
    "Content-Type": mime,
    "Accept-Ranges": "bytes",
    "Cache-Control": cacheControl,
  };
  const m = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (m) {
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end = m[2] ? parseInt(m[2], 10) : total - 1;
    if (Number.isNaN(start)) start = 0;
    if (Number.isNaN(end) || end >= total) end = total - 1;
    if (start > end || start >= total) {
      return new Response(null, {
        status: 416,
        headers: { ...baseHeaders, "Content-Range": `bytes */${total}` },
      });
    }
    const chunk = buf.subarray(start, end + 1);
    return new Response(new Uint8Array(chunk), {
      status: 206,
      headers: {
        ...baseHeaders,
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Content-Length": String(chunk.length),
      },
    });
  }
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: { ...baseHeaders, "Content-Length": String(total) },
  });
}

/**
 * Parse a JSON status column (`extension_status` / `skills_status`) into the
 * object the dashboard renders. Tolerates null / malformed JSON (returns
 * undefined) so a bad row never breaks the executions endpoint.
 */
function parseJsonColumn(raw: string | undefined): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export interface AdminConfig {
  stateDir: string;
  sessionsDir: string;
  /**
   * Filesystem root for server-mode build assets (when `buildAssets.location:
   * server`). The Artifacts endpoints read handoff docs from here. Absent when
   * unconfigured — the endpoints then report the store as empty.
   */
  buildAssetsDir?: string;
  /**
   * Where build handoff docs live: "repo" (committed to the target repo) |
   * "server" (externalized to the store). Drives the focused approval view's
   * artifact ref: server mode → editable doc in the store; repo mode → a link
   * to the file on GitHub. Defaults to "repo" when absent.
   */
  buildAssets?: BuildAssetsLocation;
  adminPassword: string;
  adminSecret: string;
  publicConfig?: PublicConfigBundle;
  /** Built-in asset root (the lastlight checkout). Used to compute which
   *  overlay assets shadow a default vs add a new one (Config → Overrides). */
  builtInRoot?: string;
  /** Active deployment overlay root (`$LASTLIGHT_OVERLAY_DIR`), if any. */
  overlayDir?: string;
  /** Optional callback to actively resume a paused workflow after dashboard approval */
  resumeWorkflow?: (workflowRun: WorkflowRun, sender: string) => Promise<void>;
  /**
   * Optional callback to retry a FAILED workflow run, resuming from the phase
   * that failed with the same context (ledger-driven). Wired in `src/index.ts`;
   * absent in environments without the runner (tests, CLI-only), in which case
   * the retry endpoint reports 503.
   */
  retryWorkflow?: (workflowRun: WorkflowRun, sender: string) => Promise<void>;
  /**
   * Cron scheduler. When supplied, the admin Crons tab can list/toggle/edit
   * registered cron jobs. Optional so the admin routes still mount in
   * environments where the scheduler isn't running (tests, CLI).
   */
  cronScheduler?: CronScheduler;
  /** Slack OAuth config (optional — enables "Login with Slack" on dashboard) */
  slackOAuthClientId?: string;
  slackOAuthClientSecret?: string;
  slackOAuthRedirectUri?: string;
  /** Restrict login to this Slack workspace team_id or team domain */
  slackAllowedWorkspace?: string;
  /** GitHub OAuth config (optional — enables "Login with GitHub" on dashboard) */
  githubOAuthClientId?: string;
  githubOAuthClientSecret?: string;
  githubOAuthRedirectUri?: string;
  /**
   * Required when GitHub OAuth is configured. Either a GitHub org slug
   * (restricts login to confirmed members — needs read:org scope) or the
   * literal "*" to explicitly allow any authenticated GitHub user. If
   * client id/secret are set but this is empty, GitHub OAuth is disabled.
   */
  githubAllowedOrg?: string;
}

/**
 * Check if a session is live by matching against running container taskIds.
 * Sessions are live if they were recently active (within 5 min) and a container
 * with a matching pattern is running.
 */
/**
 * A session is worth listing only if it actually produced something. A
 * zero-message session is a run that died before writing any conversation
 * (e.g. an aborted/duplicate task that left an empty jsonl behind) — it has
 * nothing to render and previously surfaced as a phantom "live" row at the
 * top of the list. Error-only runs still write an assistant error line, so
 * they keep a non-zero count and remain visible.
 */
function hasContent(meta: SessionMeta): boolean {
  return meta.message_count > 0;
}

function isSessionLive(meta: SessionMeta, liveTaskIds: Set<string | null>): boolean {
  // Stale sessions are never live, regardless of containers.
  const lastActivity = meta.last_message_at ?? meta.started_at;
  const fiveMinAgo = Date.now() / 1000 - 300;
  if (lastActivity < fiveMinAgo) return false;

  // Fallback-named sessions encode their taskId as `exec-<taskId>`, and that
  // taskId is exactly what listRunningContainers parses from the sandbox
  // container name — so we can match them precisely instead of guessing.
  if (meta.id.startsWith("exec-")) {
    return liveTaskIds.has(meta.id.slice("exec-".length));
  }

  // UUID-named sessions don't carry their taskId in the meta, so we can't map
  // them to a specific container. Recent activity + at least one sandbox
  // running (the caller gates on liveTaskIds being non-empty) is the best
  // signal available — keeps live agent logs flowing for in-flight phases.
  return true;
}

/**
 * Mount the read/list/stream endpoints for a SessionSource under a given
 * route prefix on `app`. The same handler shape is reused for the workflow
 * "Sessions" tab (sandbox-scoped reader at `/sessions`) and the chat tab
 * (in-process Agent SDK runs at `/chat-sessions`).
 */
function mountSessionRoutes(app: Hono, sessions: SessionSource, prefix: string): void {
  // Session list — enriched with live container status
  app.get(`${prefix}`, async (c) => {
    const limit = Number(c.req.query("limit") ?? 200);
    const allIds = sessions.listSessionIds();
    const [metas, containers] = await Promise.all([
      Promise.all(allIds.slice(0, limit * 2).map((id) => sessions.getSessionMeta(id))),
      listRunningContainers(),
    ]);
    const liveTaskIds = new Set(containers.map((c) => c.taskId).filter(Boolean));
    const valid = metas
      .filter((m): m is SessionMeta => m !== null)
      .filter(hasContent)
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limit)
      .map((m) => ({ ...m, live: liveTaskIds.size > 0 && isSessionLive(m, liveTaskIds) }));
    return c.json({ sessions: valid, liveCount: containers.length });
  });

  // Session list SSE stream
  app.get(`${prefix}/stream`, (c) => {
    const limit = Number(c.req.query("limit") ?? 200);

    return streamSSE(c, async (stream) => {
      let prevSig: string | null = null; // null = nothing sent yet (covers empty-list initial push)
      let stopped = false;

      stream.onAbort(() => { stopped = true; });

      const push = async () => {
        const [allIds, containers] = await Promise.all([
          Promise.resolve(sessions.listSessionIds()),
          listRunningContainers(),
        ]);
        const liveTaskIds = new Set(containers.map((c) => c.taskId).filter(Boolean));
        const metas = await Promise.all(
          allIds.slice(0, limit * 2).map((id) => sessions.getSessionMeta(id)),
        );
        const valid = metas
          .filter((m): m is SessionMeta => m !== null)
          .filter(hasContent)
          .sort((a, b) => b.started_at - a.started_at)
          .slice(0, limit)
          .map((m) => ({ ...m, live: liveTaskIds.size > 0 && isSessionLive(m, liveTaskIds) }));

        const sig = valid
          .map((s) => `${s.id}:${s.last_message_at ?? s.started_at}:${s.message_count}:${s.live}`)
          .join("|");
        if (sig !== prevSig) {
          prevSig = sig;
          await stream.writeSSE({ event: "sessions", data: JSON.stringify({ sessions: valid, liveCount: containers.length }) });
        }
      };

      await push();
      while (!stopped) {
        await stream.sleep(3000);
        if (stopped) break;
        await push();
      }
    });
  });

  // Single session
  app.get(`${prefix}/:id`, async (c) => {
    const id = c.req.param("id");
    if (sessions.exists(id)) {
      const meta = await sessions.getSessionMeta(id);
      if (meta) return c.json({ session: meta });
    }
    return c.json({ error: "session not found" }, 404);
  });

  // Messages for a session
  app.get(`${prefix}/:id/messages`, async (c) => {
    const id = c.req.param("id");
    const sinceIndex = Number(c.req.query("since") ?? -1);

    if (sessions.exists(id)) {
      const all = await sessions.read(id);
      const next = all.filter((x) => x.index > sinceIndex);
      return c.json({
        source: "jsonl",
        messages: next.map((x) => ({ id: x.index, ...x.msg })),
        last_id: all.length ? all[all.length - 1]!.index : sinceIndex,
      });
    }
    return c.json({ source: "none", messages: [], last_id: sinceIndex });
  });

  // Live message stream for a session
  app.get(`${prefix}/:id/stream`, async (c) => {
    const id = c.req.param("id");
    const sinceIndex = Number(c.req.query("since") ?? -1);

    if (!sessions.exists(id)) {
      return c.json({ error: "session not found" }, 404);
    }

    const filePath = sessions.getFilePath(id);
    if (!filePath) {
      return c.json({ error: "session file not found" }, 404);
    }

    return streamSSE(c, async (stream) => {
      let sentReady = false;
      let lastId = sinceIndex;
      let stopped = false;

      stream.onAbort(() => { stopped = true; });

      let msgIndex = sinceIndex;
      const tailer = await tailJsonl(
        filePath,
        (lines) => {
          for (const { msg } of lines) {
            const unwrapped = sessions.normalizeRawLine(msg as Record<string, unknown>);
            for (const m of unwrapped) {
              msgIndex++;
              stream.writeSSE({ event: "message", data: JSON.stringify({ id: msgIndex, ...m }) });
              lastId = msgIndex;
            }
          }
          if (!sentReady) {
            sentReady = true;
            stream.writeSSE({ event: "ready", data: JSON.stringify({ last_id: lastId, source: "jsonl" }) });
          }
        },
        { sinceIndex },
      );

      if (!sentReady) {
        sentReady = true;
        await stream.writeSSE({ event: "ready", data: JSON.stringify({ last_id: sinceIndex, source: "jsonl" }) });
      }

      // Keep connection alive until client disconnects
      while (!stopped) {
        await stream.sleep(15000);
      }
      tailer.stop();
    });
  });
}

export function createAdminRoutes(
  db: StateDb,
  sessions: SessionSource,
  chatSessions: SessionSource,
  config: AdminConfig,
): Hono {
  const app = new Hono();

  const slackOAuthEnabled = Boolean(config.slackOAuthClientId && config.slackOAuthClientSecret);
  const githubCredsSet = Boolean(config.githubOAuthClientId && config.githubOAuthClientSecret);
  const githubOAuthEnabled = githubCredsSet && Boolean(config.githubAllowedOrg);
  if (githubCredsSet && !config.githubAllowedOrg) {
    console.error(
      "[oauth] GitHub OAuth client id/secret are set but GITHUB_ALLOWED_ORG is empty. " +
      "Set it to a GitHub org slug to restrict login to that org, or to \"*\" to " +
      "explicitly allow any GitHub user. GitHub OAuth is disabled until this is set.",
    );
  }
  const githubAllowAnyUser = config.githubAllowedOrg === "*";

  // Auth is required when ANY login method is configured — a password OR a
  // working OAuth provider. Gating on the password alone left the dashboard
  // fully open whenever ADMIN_PASSWORD was cleared, even with OAuth set up.
  const authEnabled = Boolean(config.adminPassword) || slackOAuthEnabled || githubOAuthEnabled;

  // Auth middleware
  app.use("/*", authMiddleware(authEnabled, config.adminSecret));

  app.get("/config", (c) => c.json(config.publicConfig || { default: {}, overlay: null, merged: {}, sources: {} }));

  // Effective managed-repo list — runtime/derived state, so a dedicated endpoint
  // rather than a field in the static config bundle. `configured` is the overlay
  // list; `installation` is what the GitHub App can access (discovered at boot +
  // kept live by installation webhooks); `effective` is what actually gates
  // events (config wins when set, else installation). See src/managed-repos.ts.
  app.get("/managed-repos", (c) => {
    const configured = getRuntimeConfig()?.managedRepos ?? [];
    return c.json({
      configured,
      installation: getInstallationRepos(),
      effective: getManagedRepos(),
      source: configured.length > 0 ? "config" : "installation",
      refreshedAt: getInstallationReposRefreshedAt(),
    });
  });

  // Forked/overridden assets the deployment overlay supplies — workflows,
  // prompts, skills, agent-context — each tagged as shadowing a built-in or a
  // fresh addition. Powers the Config → Overrides pane. Shares the enumerator
  // with `lastlight server status`.
  app.get("/overrides", (c) =>
    c.json({
      overlayDir: config.overlayDir ?? null,
      overrides: enumerateOverlayAssets({ coreRoot: config.builtInRoot, overlayRoot: config.overlayDir }),
    }),
  );

  // Auth endpoints
  app.get("/auth-required", (c) => {
    return c.json({
      required: authEnabled,
      password: Boolean(config.adminPassword),
      slackOAuth: slackOAuthEnabled,
      githubOAuth: githubOAuthEnabled,
    });
  });

  app.post("/login", async (c) => {
    if (!config.adminPassword) {
      // No password set. If OAuth is the active gate, password login is simply
      // unavailable — never hand out a token here, or anyone could bypass OAuth.
      // Only mint the open-access token when NO auth method is configured.
      if (authEnabled) {
        return c.json({ error: "password login is not configured; use OAuth" }, 400);
      }
      return c.json({ token: createToken(config.adminSecret), authDisabled: true });
    }
    const body = await c.req.json<{ password?: string }>();
    if (typeof body.password !== "string") {
      return c.json({ error: "password required" }, 400);
    }
    const a = Buffer.from(body.password);
    const b = Buffer.from(config.adminPassword);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    if (!ok) {
      return c.json({ error: "invalid password" }, 401);
    }
    return c.json({ token: createToken(config.adminSecret, "password") });
  });

  // Slide an active session forward: mint a fresh full-TTL token. Runs OUTSIDE
  // the strict authMiddleware (it's on the pass-through list) so a token that
  // lapsed within REFRESH_GRACE_SECONDS can still renew — we re-check the
  // signature + grace here via verifyTokenForRefresh. The login `method` is
  // carried across so refreshed tokens keep their provenance.
  app.post("/token/refresh", (c) => {
    if (!authEnabled) {
      // No auth configured — hand back the same open-access token login issues.
      return c.json({ token: createToken(config.adminSecret), authDisabled: true });
    }
    const header = c.req.header("Authorization");
    const current = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    if (!current || !verifyTokenForRefresh(current, config.adminSecret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return c.json({ token: createToken(config.adminSecret, decodeToken(current)?.method) });
  });

  // Slack OAuth routes (only active when Slack OAuth env vars are configured)
  app.get("/oauth/slack/authorize", (c) => {
    if (!slackOAuthEnabled) {
      return c.json({ error: "Slack OAuth not configured" }, 404);
    }
    const slack = new Slack(
      config.slackOAuthClientId!,
      config.slackOAuthClientSecret!,
      config.slackOAuthRedirectUri ?? "",
    );
    const state = randomBytes(16).toString("hex");
    setCookie(c, "slack_oauth_state", state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600, // 10 minutes
    });
    const url = slack.createAuthorizationURL(state, ["openid", "profile"]);
    return c.redirect(url.toString());
  });

  app.get("/oauth/slack/callback", async (c) => {
    if (!slackOAuthEnabled) {
      return c.json({ error: "Slack OAuth not configured" }, 404);
    }
    const storedState = getCookie(c, "slack_oauth_state");
    deleteCookie(c, "slack_oauth_state", { path: "/" });
    const { code, state } = c.req.query() as { code?: string; state?: string };

    if (!storedState || !state || storedState !== state) {
      return c.json({ error: "invalid state parameter" }, 400);
    }
    if (!code) {
      return c.json({ error: "missing authorization code" }, 400);
    }

    try {
      const slack = new Slack(
        config.slackOAuthClientId!,
        config.slackOAuthClientSecret!,
        config.slackOAuthRedirectUri ?? "",
      );
      // "Sign in with Slack" issues OIDC-scoped tokens (openid + profile),
      // which Slack's classic auth.test endpoint rejects with invalid_auth.
      // Use the OIDC userInfo endpoint instead — it returns a JWT-style
      // payload with claims under namespaced URLs.
      const tokens = await slack.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();
      const res = await fetch("https://slack.com/api/openid.connect.userInfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userInfo = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sub?: string;
        "https://slack.com/team_id"?: string;
        "https://slack.com/team_domain"?: string;
        "https://slack.com/user_id"?: string;
      };
      if (userInfo.ok === false) {
        console.error("Slack openid.connect.userInfo failed:", userInfo.error);
        return c.json({ error: "Slack userInfo failed" }, 502);
      }

      const teamId = userInfo["https://slack.com/team_id"];
      const teamDomain = userInfo["https://slack.com/team_domain"];

      // Workspace restriction check
      if (config.slackAllowedWorkspace) {
        const allowed = config.slackAllowedWorkspace;
        const matchesId = teamId === allowed;
        const matchesDomain = teamDomain === allowed;
        if (!matchesId && !matchesDomain) {
          console.warn(
            `[oauth] Slack login rejected: workspace ${teamDomain ?? teamId ?? "unknown"} not in allowlist (${allowed})`,
          );
          return c.json({ error: "workspace not allowed" }, 403);
        }
      }

      const token = createToken(config.adminSecret, "slack");
      // Redirect to dashboard with token in URL; App.tsx strips it immediately.
      // Trailing slash matters: Vite serves the SPA with base "/admin/" so a
      // bare "/admin" 404s in dev. Production static serving accepts both.
      return c.redirect(`/admin/?token=${encodeURIComponent(token)}`);
    } catch (err: unknown) {
      console.error("OAuth exchange failed:", err);
      return c.json({ error: "OAuth exchange failed" }, 502);
    }
  });

  // GitHub OAuth routes (only active when GitHub OAuth env vars are configured)
  app.get("/oauth/github/authorize", (c) => {
    if (!githubOAuthEnabled) {
      return c.json({ error: "GitHub OAuth not configured" }, 404);
    }
    const github = new GitHub(
      config.githubOAuthClientId!,
      config.githubOAuthClientSecret!,
      config.githubOAuthRedirectUri ?? "",
    );
    const state = randomBytes(16).toString("hex");
    setCookie(c, "github_oauth_state", state, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 600, // 10 minutes
    });
    // `login` on GET /user needs no scope; read:org is only needed for the
    // org-membership check, so skip it when the allowlist is "*".
    const scopes = githubAllowAnyUser ? [] : ["read:org"];
    const url = github.createAuthorizationURL(state, scopes);
    return c.redirect(url.toString());
  });

  app.get("/oauth/github/callback", async (c) => {
    if (!githubOAuthEnabled) {
      return c.json({ error: "GitHub OAuth not configured" }, 404);
    }
    // Redirect the user back to the dashboard login screen with a short,
    // URL-safe error code. The SPA maps this code to a human-readable
    // message so the user sees the login card with an inline error instead
    // of a raw JSON body.
    const fail = (code: string) => c.redirect(`/admin/?error=${encodeURIComponent(code)}`);

    const storedState = getCookie(c, "github_oauth_state");
    deleteCookie(c, "github_oauth_state", { path: "/" });
    const { code, state } = c.req.query() as { code?: string; state?: string };

    if (!storedState || !state || storedState !== state) {
      return fail("oauth_state");
    }
    if (!code) {
      return fail("oauth_code");
    }

    try {
      const github = new GitHub(
        config.githubOAuthClientId!,
        config.githubOAuthClientSecret!,
        config.githubOAuthRedirectUri ?? "",
      );
      const tokens = await github.validateAuthorizationCode(code);
      const accessToken = tokens.accessToken();
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "lastlight-admin",
          Accept: "application/vnd.github+json",
        },
      });
      const userInfo = (await res.json()) as { login?: string };

      let memberStatus: number | undefined;
      if (userInfo.login && !githubAllowAnyUser) {
        const org = config.githubAllowedOrg!;
        const memberRes = await fetch(
          `https://api.github.com/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(userInfo.login)}`,
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": "lastlight-admin",
              Accept: "application/vnd.github+json",
            },
            redirect: "manual",
          },
        );
        memberStatus = memberRes.status;
      }
      if (!userInfo.login) {
        console.error("GitHub /user failed: missing login field");
        return fail("github_userinfo");
      }
      const login = userInfo.login;

      // Only 204 No Content means confirmed member. 302 means caller lacks
      // read:org visibility; 404 means not a member. Both cases are rejected.
      if (!githubAllowAnyUser && memberStatus !== 204) {
        console.warn(
          `[oauth] GitHub login rejected: ${login} not a confirmed member of ${config.githubAllowedOrg!} (status ${memberStatus})`,
        );
        return fail("github_org");
      }

      const token = createToken(config.adminSecret, "github");
      return c.redirect(`/admin/?token=${encodeURIComponent(token)}`);
    } catch (err: unknown) {
      console.error("GitHub OAuth exchange failed:", err);
      return fail("oauth_exchange");
    }
  });

  // Health
  app.get("/health", (c) => {
    return c.json({ status: "ok", stateDir: config.stateDir });
  });

  // Workflow / sandbox sessions and chat (in-process Agent SDK) sessions both
  // expose the same five endpoints, just under different prefixes and backed
  // by different on-disk slices.
  mountSessionRoutes(app, sessions, "/sessions");
  mountSessionRoutes(app, chatSessions, "/chat-sessions");

  // Stats — running count uses live Docker containers, not stale DB records
  app.get("/stats", async (c) => {
    const [stats, containers] = await Promise.all([
      Promise.resolve(db.executions.executionStats()),
      listRunningContainers(),
    ]);
    stats.running = containers.length;
    return c.json(stats);
  });

  // Daily aggregated stats (last N days)
  app.get("/stats/daily", (c) => {
    const daysParam = c.req.query("days");
    const days = Math.min(Math.max(1, parseInt(daysParam ?? "30", 10) || 30), 90);
    return c.json({ daily: db.executions.dailyStats(days) });
  });

  // Hourly aggregated stats (rolling last N hours, default 24)
  app.get("/stats/hourly", (c) => {
    const hoursParam = c.req.query("hours");
    const hours = Math.min(Math.max(1, parseInt(hoursParam ?? "24", 10) || 24), 168);
    return c.json({ hourly: db.executions.hourlyStats(hours) });
  });

  // Running Docker containers
  app.get("/containers", async (c) => {
    const containers = await listRunningContainers();
    return c.json({ containers });
  });

  // CPU/memory stats for the agent and any sandbox containers
  app.get("/containers/stats", async (c) => {
    const stats = await getContainerStats();
    return c.json({ stats });
  });

  // ── Server logs ───────────────────────────────────────────────────────────
  // Raw `docker logs` for the lastlight-* containers (the agent harness + the
  // egress sidecars + otel-collector). Lets an operator read the actual
  // server/process logs over the admin API instead of SSHing to the host. The
  // requested container is resolved against the live container list, so an
  // arbitrary name can never reach `docker logs`.

  app.get("/server/containers", async (c) => {
    return c.json({ containers: await listServerContainers() });
  });

  // Version + drift (core/overlay) for the dashboard "update available" banner.
  // Best-effort: an unreachable remote yields latest=null (behind=false), never
  // a false positive. The authoritative view is `lastlight server status`.
  app.get("/server/info", async (c) => {
    try {
      return c.json(await getServerVersion());
    } catch (err) {
      return c.json({ error: `version lookup failed: ${(err as Error).message}` }, 500);
    }
  });

  app.get("/server/logs", async (c) => {
    const name = await resolveServerContainer(c.req.query("container"));
    if (!name) return c.json({ error: "no matching lastlight container" }, 404);
    const tail = Math.min(Math.max(parseInt(c.req.query("tail") ?? "200", 10) || 200, 1), 5000);
    const since = c.req.query("since") || undefined;
    try {
      const lines = await getContainerLogs(name, { tail, since });
      return c.json({ container: name, lines });
    } catch (err) {
      return c.json({ error: `docker logs failed: ${(err as Error).message}` }, 500);
    }
  });

  app.get("/server/logs/stream", (c) => {
    return streamSSE(c, async (stream) => {
      const name = await resolveServerContainer(c.req.query("container"));
      if (!name) {
        await stream.writeSSE({ data: JSON.stringify({ error: "no matching lastlight container" }) });
        return;
      }
      const tail = Math.min(Math.max(parseInt(c.req.query("tail") ?? "100", 10) || 100, 1), 5000);
      let stopped = false;
      const stop = streamContainerLogs(name, { tail }, (line) => {
        if (!stopped) void stream.writeSSE({ data: line });
      });
      stream.onAbort(() => { stopped = true; stop(); });
      // Hold the SSE open until the client disconnects.
      while (!stopped) {
        await stream.sleep(15000);
      }
      stop();
    });
  });

  // Kill a sandbox container and mark related DB executions as failed
  app.delete("/containers/:name", async (c) => {
    const name = c.req.param("name");
    if (!name.startsWith("lastlight-sandbox-")) {
      return c.json({ error: "can only kill sandbox containers" }, 400);
    }
    try {
      await killContainer(name);
      // Parse taskId from container name: lastlight-sandbox-{taskId}-{uuid}
      const match = name.match(/^lastlight-sandbox-(.+?)-[a-f0-9]{8}$/);
      if (match) {
        const taskId = match[1];
        // Mark any running executions with matching skill as failed. Phase
        // skill keys are `<workflowName>:<phaseName>` — match on the colon.
        const skills = db.executions.runningExecutions()
          .filter((e) => e.skill.includes(":") || e.skill === "pr-fix")
          .filter((e) => taskId.includes(e.triggerId?.replace(/[^a-z0-9]/gi, "") || "---"));
        for (const e of skills) {
          db.executions.recordFinish(e.id, { success: false, error: "terminated via admin dashboard" });
        }
      }
      return c.json({ killed: name });
    } catch (err: any) {
      return c.json({ error: err.message }, 500);
    }
  });

  // Execution records from DB
  app.get("/executions", (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const executions = db.executions.allExecutions(limit, offset);
    return c.json({ executions });
  });

  // Free-text log search — the backbone of remote debugging via the CLI
  // (`lastlight logs search`). Two scopes:
  //   - errors   (default): substring match over the executions ledger
  //                         (error / skill / repo) — fast, indexed-ish.
  //   - messages: grep the most-recent session transcripts for matching
  //               conversation content, returning a snippet. Bounded by
  //               `maxSessions` so a deep history can't make this unbounded.
  //   - all:      both, errors first.
  app.get("/log-search", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ error: "missing 'q' query parameter" }, 400);
    const scope = (c.req.query("scope") ?? "errors") as "errors" | "messages" | "all";
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);

    const results: Array<Record<string, unknown>> = [];

    if (scope === "errors" || scope === "all") {
      for (const r of db.executions.searchErrors(q, limit)) {
        results.push({
          source: "error",
          executionId: r.id,
          sessionId: r.sessionId,
          workflowRunId: r.workflowRunId,
          skill: r.skill,
          repo: r.repo,
          startedAt: r.startedAt,
          success: r.success,
          snippet: r.error ?? r.skill,
        });
      }
    }

    if (scope === "messages" || scope === "all") {
      const needle = q.toLowerCase();
      const maxSessions = 200; // newest-first cap on transcripts scanned
      const ids = sessions.listSessionIds().slice(0, maxSessions);
      outer: for (const id of ids) {
        let msgs: Array<{ index: number; msg: Record<string, unknown> }>;
        try {
          msgs = (await sessions.read(id)) as Array<{ index: number; msg: Record<string, unknown> }>;
        } catch {
          continue;
        }
        for (const { index, msg } of msgs) {
          const text = JSON.stringify(msg.content ?? "");
          const at = text.toLowerCase().indexOf(needle);
          if (at === -1) continue;
          const start = Math.max(0, at - 60);
          results.push({
            source: "message",
            sessionId: id,
            messageIndex: index,
            role: msg.role,
            snippet: text.slice(start, at + needle.length + 120),
          });
          if (results.length >= limit) break outer;
        }
      }
    }

    return c.json({ results: results.slice(0, limit) });
  });

  // Workflow runs — paginated, optional filters by date, workflow name, and
  // status. Returns `total` so the dashboard can drive a "load more" pager.
  // `status=active` is shorthand for ('running','paused') — used by the
  // header's "live" filter on the workflows tab.
  app.get("/workflow-runs", (c) => {
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const since = c.req.query("since") || undefined;
    const workflowName = c.req.query("workflow") || undefined;
    const statusParam = c.req.query("status");
    const limit = Math.min(Math.max(parseInt(rawLimit ?? "20", 10) || 20, 1), 200);
    const offset = Math.max(parseInt(rawOffset ?? "0", 10) || 0, 0);

    let statuses: string[] | undefined;
    if (statusParam === "active") {
      statuses = ["running", "paused"];
    } else if (statusParam) {
      statuses = statusParam.split(",").filter(Boolean);
    }

    const { runs, total } = db.runs.list({
      limit,
      offset,
      sinceIso: since,
      workflowName,
      statuses,
    });
    return c.json({ workflowRuns: runs, total });
  });

  // Distinct workflow names — used to populate the dashboard's filter row.
  app.get("/workflow-names", (c) => {
    return c.json({ names: db.runs.distinctNames() });
  });

  app.get("/workflow-runs/:id", (c) => {
    const id = c.req.param("id");
    const run = db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    return c.json({ workflowRun: run });
  });

  // List the executions belonging to a workflow run, ordered by start time.
  // Used by the dashboard's pipeline-detail view to look up the session id
  // (and usage metrics) for any phase the user clicks.
  app.get("/workflow-runs/:id/executions", (c) => {
    const id = c.req.param("id");
    const run = db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    const rows = db.executions.getExecutionsForWorkflowRun(run.id, run.triggerId, run.workflowName);
    const prefix = `${run.workflowName}:`;
    const executions = rows.map((r) => ({
      id: r.id,
      skill: r.skill,
      // <workflowName>:<phaseName> → phaseName
      phase: r.skill.startsWith(prefix) ? r.skill.slice(prefix.length) : r.skill,
      sessionId: r.sessionId,
      success: r.success,
      error: r.error,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      durationMs: r.durationMs,
      turns: r.turns,
      costUsd: r.costUsd,
      inputTokens: r.inputTokens,
      cacheCreationInputTokens: r.cacheCreationInputTokens,
      cacheReadInputTokens: r.cacheReadInputTokens,
      outputTokens: r.outputTokens,
      apiDurationMs: r.apiDurationMs,
      stopReason: r.stopReason,
      extensions: parseJsonColumn(r.extensionStatus),
      skills: parseJsonColumn(r.skillsStatus),
    }));
    return c.json({ executions });
  });

  // All approvals (pending + resolved) for a workflow run, oldest first. Powers
  // the pipeline's approval-gate nodes + the detail panel's read-only approval
  // history (status, who responded, when, and any comment). The global
  // /approvals endpoint only lists pending ones, so it can't show history.
  app.get("/workflow-runs/:id/approvals", (c) => {
    const id = c.req.param("id");
    const run = db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    const approvals = db.approvals.listForWorkflow(run.id);
    return c.json({ approvals });
  });

  app.post("/workflow-runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const run = db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    if (run.status !== "running" && run.status !== "paused") {
      return c.json({ error: `cannot cancel a run with status '${run.status}'` }, 400);
    }
    db.runs.cancelRun(id);
    // Flipping the DB row alone only stops the runner before the NEXT phase.
    // Kill any sandbox container currently executing a phase of this run so
    // the in-flight phase stops too. Container names are
    //   lastlight-sandbox-<taskId>-<uuid>
    // where taskId is the linear run's taskId or the DAG's phase-scoped
    // `<taskId>-<phaseName>`, both of which start with the stored taskId.
    const storedTaskId = (run.context as Record<string, unknown> | undefined)?.taskId;
    let killed: string[] = [];
    if (typeof storedTaskId === "string" && storedTaskId) {
      try {
        const containers = await listRunningContainers();
        const matches = containers.filter(
          (ctr) => ctr.taskId && ctr.taskId.startsWith(storedTaskId),
        );
        await Promise.all(
          matches.map(async (ctr) => {
            try {
              await killContainer(ctr.name);
              killed.push(ctr.name);
            } catch (err) {
              console.warn(`[cancel] failed to kill ${ctr.name}:`, err);
            }
          }),
        );
        // Mark execution rows belonging to THIS cancelled run as failed.
        // Matching by workflowRunId (the run's id) instead of triggerId
        // avoids clobbering a sibling run that happens to share the same
        // trigger — e.g. two webhook deliveries for the same PR that
        // raced before dedup closed.
        for (const e of db.executions.runningExecutions()) {
          if (e.workflowRunId === id) {
            db.executions.recordFinish(e.id, { success: false, error: "cancelled via admin dashboard" });
          }
        }
      } catch (err) {
        console.warn(`[cancel] container enumeration failed:`, err);
      }
    }
    return c.json({ cancelled: id, killedContainers: killed });
  });

  // Retry a FAILED workflow run — resume from the phase that failed with the
  // same context. Only `failed` runs are retryable; the callback flips the row
  // failed→running (compare-and-set) and re-dispatches via the same
  // ledger-driven resume path the boot-recovery sweep uses. Sits under the
  // `authMiddleware` guard above, like cancel/respond.
  app.post("/workflow-runs/:id/retry", async (c) => {
    const id = c.req.param("id");
    const run = db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    if (run.status !== "failed") {
      return c.json({ error: `cannot retry a run with status '${run.status}'` }, 400);
    }
    if (!config.retryWorkflow) {
      return c.json({ error: "retry not available (runner not wired)" }, 503);
    }
    // Fire-and-forget: restartRun (inside the callback) flips status→running
    // atomically, so a second immediate retry click 400s on the status guard.
    config.retryWorkflow(run, "admin").catch((err) =>
      console.error(`[admin] retry ${id} failed:`, err));
    return c.json({ retrying: id });
  });

  // ── Workflow definitions ─────────────────────────────────────────
  //
  // The dashboard's pipeline visualisation fetches definitions from here so
  // it can render exactly the phases the YAML file declares — including
  // user-defined custom workflows. No hardcoded phase list, no fallback.

  // List all agent workflows for the dashboard's Workflows browser.
  app.get("/workflows", (c) => {
    const defs = listAgentWorkflows();
    const overrides = db.getAllWorkflowOverrides();
    const workflows = defs.map((def) => ({
      name: def.name,
      kind: def.kind,
      description: def.description,
      trigger: def.trigger,
      phaseCount: def.phases.length,
      hasDag: def.phases.some((p) => Array.isArray(p.depends_on) && p.depends_on.length > 0),
      triggerKinds: getWorkflowTriggerKinds(def.name),
      enabled: overrides.get(def.name)?.enabled ?? true,
    }));
    workflows.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ workflows });
  });

  app.get("/workflows/:name", (c) => {
    const name = c.req.param("name");
    try {
      const def = getWorkflow(name);
      // Return only the dashboard-relevant subset (no prompt template paths,
      // no model overrides) — keeps the surface small and stable for the
      // run-detail pipeline. Use /workflows/:name/full for the editor.
      return c.json({
        workflow: {
          name: def.name,
          kind: def.kind,
          description: def.description,
          phases: def.phases.map((p) => ({
            name: p.name,
            label: p.label ?? p.name,
            type: p.type,
            hasLoop: !!p.loop || !!p.generic_loop,
            approvalGate: p.approval_gate,
          })),
        },
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `workflow definition not found: ${name}`, detail: msg }, 404);
    }
  });

  // Full structured definition: every phase field, used by the definition
  // browser to render phase details and the diagram.
  app.get("/workflows/:name/full", (c) => {
    const name = c.req.param("name");
    try {
      const def = getWorkflow(name);
      return c.json({
        workflow: def,
        triggers: getWorkflowTriggers(name),
        enabled: db.isWorkflowEnabled(name),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `workflow definition not found: ${name}`, detail: msg }, 404);
    }
  });

  // Toggle the kill switch. Mirrors POST /crons/:name/toggle. Persisted to
  // `workflow_overrides`; reads happen on every dispatch in
  // `runSimpleWorkflow`, so the change applies to in-flight cron ticks and
  // webhook dispatches without needing a restart.
  app.post("/workflows/:name/toggle", async (c) => {
    const name = c.req.param("name");
    try {
      // Validate the name actually exists before persisting an override.
      getWorkflow(name);
    } catch {
      return c.json({ error: `unknown workflow: ${name}` }, 404);
    }
    const current = db.isWorkflowEnabled(name);
    const next = !current;
    db.setWorkflowEnabled(name, next, "admin");
    return c.json({ name, enabled: next });
  });

  // Raw YAML file content — preserves comments and formatting for the
  // dashboard's syntax-highlighted YAML view.
  app.get("/workflows/:name/yaml", (c) => {
    const name = c.req.param("name");
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return c.json({ error: "invalid workflow name" }, 400);
    }
    try {
      const yaml = loadWorkflowYamlRaw(name);
      return c.text(yaml, 200, { "Content-Type": "text/plain; charset=utf-8" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `workflow yaml not found: ${name}`, detail: msg }, 404);
    }
  });

  // Read a prompt template referenced by a phase (e.g. ?path=prompts/architect.md).
  // Path is validated by `loadPromptTemplate` to live within workflowDir.
  app.get("/workflows/:name/prompt", (c) => {
    const name = c.req.param("name");
    const promptPath = c.req.query("path");
    if (!promptPath) return c.json({ error: "missing ?path query" }, 400);
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return c.json({ error: "invalid workflow name" }, 400);
    }
    // Restrict to the prompts/ subdirectory — workflows reference templates
    // via `prompts/foo.md` (loader.ts:resolvePromptPath also catches escapes).
    if (!promptPath.startsWith("prompts/") || promptPath.includes("..")) {
      return c.json({ error: "prompt path must be under prompts/" }, 400);
    }
    try {
      const text = loadPromptTemplate(promptPath);
      return c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `prompt not found`, detail: msg }, 404);
    }
  });

  // Read a skill's SKILL.md file. Used by the phase detail drawer when a
  // phase declares `skill: <name>`.
  app.get("/skills/:name", (c) => {
    const name = c.req.param("name");
    try {
      const text = loadSkillRaw(name);
      return c.text(text, 200, { "Content-Type": "text/plain; charset=utf-8" });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `skill not found: ${name}`, detail: msg }, 404);
    }
  });

  // ── Build assets (server mode) ─────────────────────────────────
  // Read-only views of the externalized handoff docs (architect-plan.md, …)
  // that live in the server store when `buildAssets.location: server`. The
  // store itself rejects path traversal on every segment. With no store dir
  // configured (repo mode) the list endpoints report empty rather than 404 so
  // the dashboard tab degrades gracefully.
  const buildAssetStore = config.buildAssetsDir ? new BuildAssetStore(config.buildAssetsDir) : null;

  type ArtifactLockReason = "no_matching_approval" | "unverified_owner" | "approval_resolved" | "approval_rejected";

  interface ArtifactApprovalSummary {
    id: string;
    workflowRunId: string;
    status: WorkflowApproval["status"];
    gate: string;
    summary: string;
    respondedBy?: string;
    respondedAt?: string;
    createdAt: string;
  }

  interface ArtifactLock {
    reason: ArtifactLockReason;
    approval?: ArtifactApprovalSummary;
    message?: string;
  }

  interface ArtifactMetadata {
    editable: boolean;
    lock: ArtifactLock | null;
  }

  function summarizeApproval(approval: WorkflowApproval): ArtifactApprovalSummary {
    return {
      id: approval.id,
      workflowRunId: approval.workflowRunId,
      status: approval.status,
      gate: approval.gate,
      summary: approval.summary,
      respondedBy: approval.respondedBy,
      respondedAt: approval.respondedAt,
      createdAt: approval.createdAt,
    };
  }

  function ownerRepoForRun(run: WorkflowRun | null): { owner?: string; repo?: string; issueKey?: string; branch?: string } {
    if (!run) return {};
    const ctx = run.context ?? {};
    const ctxOwner = typeof ctx.owner === "string" ? ctx.owner : undefined;
    const branch = typeof ctx.branch === "string" ? ctx.branch : undefined;
    const repoField = typeof run.repo === "string" ? run.repo : undefined;
    let owner: string | undefined;
    let repo: string | undefined;
    if (repoField) {
      if (repoField.includes("/")) {
        const [maybeOwner, maybeRepo] = repoField.split("/", 2);
        owner = ctxOwner ?? maybeOwner;
        repo = maybeRepo;
      } else {
        owner = ctxOwner;
        repo = repoField;
      }
    }
    const issueKey = buildAssetIssueKey(run.workflowName, run.issueNumber, run.id);
    return { owner, repo, issueKey, branch };
  }

  function runMatchesArtifactTarget(run: WorkflowRun | null, owner: string, repo: string, key: string): boolean {
    if (!run) return false;
    const { owner: runOwner, repo: runRepo, issueKey } = ownerRepoForRun(run);
    if (!runOwner || !runRepo || !issueKey) return false;
    return runOwner === owner && runRepo === repo && issueKey === key;
  }

  function computeArtifactMetadata(owner: string, repo: string, key: string, doc: string): ArtifactMetadata {
    const approvals = db.approvals.listByArtifact(doc);
    if (approvals.length === 0) {
      // No approval references this artifact. Docs that aren't guarded by an
      // approval remain editable (status.md, executor-summary.md, etc.).
      return { editable: true, lock: null };
    }

    const enriched = approvals.map((approval) => ({
      approval,
      run: db.runs.getRun(approval.workflowRunId),
    }));

    const matching = enriched.filter(({ run }) => runMatchesArtifactTarget(run, owner, repo, key));
    const latestMatching = matching[0];

    if (latestMatching && latestMatching.approval.status === "pending") {
      return { editable: true, lock: null };
    }

    if (!latestMatching) {
      const latest = enriched[0];
      return {
        editable: false,
        lock: {
          reason: "unverified_owner",
          message: "Could not verify owner/repo/issue for the approval",
          approval: summarizeApproval(latest.approval),
        },
      };
    }

    const reason: ArtifactLockReason = latestMatching.approval.status === "rejected"
      ? "approval_rejected"
      : "approval_resolved";
    return {
      editable: false,
      lock: {
        reason,
        approval: summarizeApproval(latestMatching.approval),
      },
    };
  }

  // List the run keys (issue-N / <workflow>-<id>) stored for ?repo=owner/repo.
  app.get("/artifacts", (c) => {
    const repoParam = c.req.query("repo");
    if (!repoParam || !repoParam.includes("/")) {
      return c.json({ error: "missing or invalid ?repo=owner/repo" }, 400);
    }
    if (!buildAssetStore) return c.json({ keys: [] });
    const [owner, repo] = repoParam.split("/", 2);
    try {
      return c.json({ keys: buildAssetStore.listKeys(owner, repo) });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // List the doc filenames stored for one run.
  app.get("/artifacts/:owner/:repo/:key", (c) => {
    if (!buildAssetStore) return c.json({ files: [] });
    const { owner, repo, key } = c.req.param();
    try {
      return c.json({ files: buildAssetStore.listFiles({ owner, repo, issueKey: key }) });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Read one doc. Binary artifacts (PNG screenshot evidence, /demo mp4/webm) are
  // served as raw bytes with the right Content-Type and Range support (so the
  // dashboard <video> can seek); everything else is text/plain (the dashboard
  // renders it with marked/DOMPurify).
  app.get("/artifacts/:owner/:repo/:key/:doc", (c) => {
    if (!buildAssetStore) return c.json({ error: "build-assets store not configured" }, 404);
    const { owner, repo, key, doc } = c.req.param();
    try {
      const binMime = binaryMimeForArtifact(doc);
      if (binMime) {
        const buf = buildAssetStore.readBuffer({ owner, repo, issueKey: key }, doc);
        if (buf === undefined) return c.json({ error: `doc not found: ${doc}` }, 404);
        return rangeResponse(c.req.header("range"), buf, binMime, "no-store");
      }
      const content = buildAssetStore.read({ owner, repo, issueKey: key }, doc);
      if (content === undefined) return c.json({ error: `doc not found: ${doc}` }, 404);
      return c.text(content, 200, { "Content-Type": "text/plain; charset=utf-8" });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  app.get("/artifacts/:owner/:repo/:key/:doc/metadata", (c) => {
    if (!buildAssetStore) return c.json({ error: "build-assets store not configured" }, 404);
    const { owner, repo, key, doc } = c.req.param();
    try {
      // Validate the doc path upfront so traversal attempts surface as 400s.
      buildAssetStore.fileFor({ owner, repo, issueKey: key }, doc);
      const metadata = computeArtifactMetadata(owner, repo, key, doc);
      return c.json(metadata);
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // Overwrite one doc with the raw markdown request body. The store creates
  // the run dir on demand and rejects path traversal on every segment.
  app.put("/artifacts/:owner/:repo/:key/:doc", async (c) => {
    if (!buildAssetStore) return c.json({ error: "build-assets store not configured" }, 404);
    const { owner, repo, key, doc } = c.req.param();
    try {
      // Validate the doc path before hitting the approval gate.
      buildAssetStore.fileFor({ owner, repo, issueKey: key }, doc);
      const metadata = computeArtifactMetadata(owner, repo, key, doc);
      if (!metadata.editable) {
        return c.json({ error: "artifact_locked", lock: metadata.lock }, 403);
      }
      const body = await c.req.text();
      buildAssetStore.write({ owner, repo, issueKey: key }, doc, body);
      return c.json({ ok: true });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Approval Gates ─────────────────────────────────────────────

  app.get("/approvals", (c) => {
    const approvals = db.approvals.listPending();
    return c.json({ approvals });
  });

  // Single approval, enriched with an `artifactRef` the focused approval view
  // uses to open the right doc. `artifactRef` is null when the gate carries no
  // artifact. In server mode the ref points at the editable store doc; in repo
  // mode it carries a GitHub blob URL (the doc is committed on the branch).
  app.get("/approvals/:id", (c) => {
    const approval = db.approvals.getById(c.req.param("id"));
    if (!approval) return c.json({ error: "approval not found" }, 404);
    const run = db.runs.getRun(approval.workflowRunId);

    let artifactRef: {
      mode: BuildAssetsLocation;
      owner: string;
      repo: string;
      issueKey: string;
      doc: string;
      githubUrl?: string;
    } | null = null;

    if (approval.artifact && run && run.repo) {
      // `workflow_runs.repo` is the BARE repo name and `owner` lives in
      // run.context (set by simple.ts) — except in tests / legacy rows that
      // may store "owner/repo". Handle both: prefer context.owner, else split.
      const ctx = run.context ?? {};
      const ctxOwner = typeof ctx.owner === "string" ? ctx.owner : undefined;
      const repo = run.repo.includes("/") ? run.repo.split("/")[1] : run.repo;
      const owner = ctxOwner ?? (run.repo.includes("/") ? run.repo.split("/")[0] : "");
      if (owner && repo) {
        const mode: BuildAssetsLocation = config.buildAssets ?? "repo";
        const issueKey = buildAssetIssueKey(run.workflowName, run.issueNumber, run.id);
        const issueDir =
          typeof ctx.issueDir === "string" ? ctx.issueDir : `.lastlight/${issueKey}`;
        const branch = typeof ctx.branch === "string" ? ctx.branch : undefined;
        const githubUrl =
          mode === "repo" && branch
            ? `https://github.com/${owner}/${repo}/blob/${encodeURIComponent(branch)}/${issueDir}/${approval.artifact}`
            : undefined;
        artifactRef = { mode, owner, repo, issueKey, doc: approval.artifact, githubUrl };
      }
    }

    return c.json({ approval, artifactRef, run: run ?? null });
  });

  app.post("/approvals/:id/respond", async (c) => {
    const id = c.req.param("id");
    const body = await c.req.json<{ decision: "approved" | "rejected"; reason?: string }>();
    const approval = db.approvals.getById(id);
    if (!approval) return c.json({ error: "approval not found" }, 404);
    if (approval.status !== "pending") return c.json({ error: `already ${approval.status}` }, 400);
    if (body.decision === "rejected") {
      // One transaction: respond 'rejected' + fail the run.
      db.runs.resolveGateAndFail(id, "admin", body.reason);
    } else {
      // Record the approval, then let resumeWorkflow flip the run back to
      // `running` — but only as part of an actual dispatch. resumeWorkflow
      // validates the target (GitHub App present, triggerId is an owner/repo#N
      // issue) and calls setRunning right before dispatching, so a
      // non-resumable approval (no resumeWorkflow wired, App down, or a
      // non-issue trigger) leaves the run paused rather than flipping it to
      // `running` with no worker. We deliberately do NOT use the atomic
      // resolveGateAndResume here: unlike the GitHub/Slack path, the dashboard
      // can't prove a dispatch will follow before responding.
      //
      // respond() is a compare-and-set on the still-pending row, so a racing
      // responder (the status check above is a TOCTOU read) changes 0 rows.
      // Only the winner resumes — the loser must not dispatch a second time.
      const changed = db.approvals.respond(id, "approved", "admin", body.reason);
      if (changed !== 1) {
        return c.json({ error: "already resolved" }, 409);
      }
      const workflowRun = db.runs.getRun(approval.workflowRunId);
      if (workflowRun && config.resumeWorkflow) {
        config.resumeWorkflow(workflowRun, "admin").catch((err) => {
          console.error(`[admin] Failed to resume workflow ${workflowRun.id}:`, err);
        });
      }
    }
    return c.json({ status: body.decision });
  });

  // ── Crons ──────────────────────────────────────────────────────

  // List every cron defined in workflows/cron-*.yaml, merged with the
  // override row (if any) and the live scheduler state.
  app.get("/crons", (c) => {
    const overrides = db.getAllCronOverrides();
    const liveByName = new Map(
      (config.cronScheduler?.list() ?? []).map((j) => [j.name, j]),
    );
    const defs = getCronWorkflows();
    const crons = defs.map((def) => {
      const override = overrides.get(def.name) ?? null;
      const enabled = override ? override.enabled : true;
      const live = liveByName.get(def.name) ?? null;
      const recentFailures = db.executions.consecutiveFailures(def.workflow);
      // Find the most recent workflow_run for this cron's workflow
      const recent = db.runs.listRecent(50).find((r) => r.workflowName === def.workflow);
      return {
        name: def.name,
        workflow: def.workflow,
        schedule: override?.schedule ?? def.schedule,
        originalSchedule: def.schedule,
        enabled,
        registered: !!live,
        nextRun: live?.nextRun?.toISOString() ?? null,
        lastRun: recent?.startedAt ?? null,
        lastStatus: recent?.status ?? null,
        recentFailures,
        context: { repos: getManagedRepos(), ...def.context },
        override: override
          ? {
              updatedAt: override.updatedAt,
              updatedBy: override.updatedBy,
              hasScheduleOverride: override.schedule != null,
            }
          : null,
      };
    });
    return c.json({ crons });
  });

  // Toggle the enabled bit for a cron. Updates the scheduler in lockstep so
  // the change takes effect immediately (no restart).
  app.post("/crons/:name/toggle", async (c) => {
    if (!config.cronScheduler) {
      return c.json({ error: "cron scheduler not configured" }, 503);
    }
    const name = c.req.param("name");
    const def = getCronWorkflows().find((d) => d.name === name);
    if (!def) return c.json({ error: `cron not found: ${name}` }, 404);
    const override = db.getCronOverride(name);
    const currentlyEnabled = override ? override.enabled : true;
    const nextEnabled = !currentlyEnabled;
    db.setCronOverride(name, { enabled: nextEnabled, updatedBy: "admin" });
    if (nextEnabled) {
      // Re-register with the (possibly overridden) schedule
      const schedule = override?.schedule || def.schedule;
      if (config.cronScheduler.has(name)) {
        config.cronScheduler.update({
          name,
          schedule,
          workflow: def.workflow,
          context: { repos: getManagedRepos(), ...def.context },
        });
      } else {
        config.cronScheduler.register({
          name,
          schedule,
          workflow: def.workflow,
          context: { repos: getManagedRepos(), ...def.context },
        });
      }
    } else {
      config.cronScheduler.unregister(name);
    }
    return c.json({ name, enabled: nextEnabled });
  });

  // Persist a schedule override and apply it to the scheduler. Validates the
  // expression with croner before saving so a bad expression returns 400 and
  // the live cron isn't disturbed.
  app.post("/crons/:name/schedule", async (c) => {
    if (!config.cronScheduler) {
      return c.json({ error: "cron scheduler not configured" }, 503);
    }
    const name = c.req.param("name");
    const def = getCronWorkflows().find((d) => d.name === name);
    if (!def) return c.json({ error: `cron not found: ${name}` }, 404);
    const body = await c.req.json<{ schedule: string }>();
    const schedule = (body.schedule ?? "").trim();
    if (!schedule) return c.json({ error: "schedule is required" }, 400);
    try {
      // Construct a paused Cron purely to validate the pattern, then dispose.
      const probe = new Cron(schedule, { paused: true }, () => {});
      probe.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.json({ error: `invalid schedule: ${msg}` }, 400);
    }
    db.setCronOverride(name, { schedule, updatedBy: "admin" });
    const override = db.getCronOverride(name);
    if (override?.enabled !== false) {
      config.cronScheduler.update({
        name,
        schedule,
        workflow: def.workflow,
        context: { repos: getManagedRepos(), ...def.context },
      });
    }
    return c.json({ name, schedule });
  });

  // Drop the override row and re-register the cron at its YAML default.
  app.delete("/crons/:name/override", (c) => {
    if (!config.cronScheduler) {
      return c.json({ error: "cron scheduler not configured" }, 503);
    }
    const name = c.req.param("name");
    const def = getCronWorkflows().find((d) => d.name === name);
    if (!def) return c.json({ error: `cron not found: ${name}` }, 404);
    db.clearCronOverride(name);
    if (config.cronScheduler.has(name)) {
      config.cronScheduler.update({
        name,
        schedule: def.schedule,
        workflow: def.workflow,
        context: { repos: getManagedRepos(), ...def.context },
      });
    } else {
      config.cronScheduler.register({
        name,
        schedule: def.schedule,
        workflow: def.workflow,
        context: { repos: getManagedRepos(), ...def.context },
      });
    }
    return c.json({ name, schedule: def.schedule, enabled: true });
  });

  return app;
}
