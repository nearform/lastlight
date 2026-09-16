import { Hono } from "hono";
import type { Context } from "hono";
import path from "node:path";
import { timingSafeEqual, randomBytes, randomUUID } from "node:crypto";
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
  getHostStats,
  listServerContainers,
  resolveServerContainer,
  getContainerLogs,
  streamContainerLogs,
} from "./docker.js";
import { authMiddleware, createToken, verifyTokenForRefresh, decodeToken, actorFromContext, actorTypeFromContext } from "./auth.js";
import { Cron } from "croner";
import type { CronScheduler } from "../cron/scheduler.js";
import {
  CRON_GLOBALLY_ENABLED_KEY,
  CRON_NAME_KEY,
  cronVote,
  repoCronPrefs,
  repoLayerMayVote,
} from "../cron/repo-crons.js";
import { enumerateOverlayAssets } from "lastlight-shared/overlay-assets";
import {
  getCronWorkflows,
  getWorkflow,
  getWorkflowByIntent,
  listAgentWorkflows,
  loadWorkflowYamlRaw,
  loadPromptTemplate,
  loadSkillRaw,
} from "../workflows/loader.js";
import { routeEvent, type Route } from "../engine/router.js";
import { applyPrDispatchGate, prPolicyConfig } from "../engine/dispatcher.js";
import { resolvePrState, prTriggerId } from "../engine/pr-state.js";
import { holdReply, type PrPolicyConfig } from "../engine/pr-decisions.js";
import { advanceStage } from "../engine/stage-advance.js";
import { prFixShapedWorkflows } from "../workflows/target-policy.js";
import type { GitHubClient } from "../engine/github/github.js";
import { classifyComment, type ClassificationResult } from "../engine/screen/classifier.js";
import type { EventEnvelope, EventType } from "../connectors/types.js";
import {
  getWorkflowTriggers,
  getWorkflowTriggerKinds,
  resolveIntentHandler,
} from "../workflows/triggers.js";
import {
  getManagedRepos,
  getInstallationRepoBreakdown,
  getInstallationRepos,
  getInstallationReposRefreshedAt,
  isManagedRepo,
} from "../managed-repos.js";
import {
  getInstallationDirectory,
  installationSettingsUrl,
} from "../engine/github/installations.js";
import { TeamVisibilityResolver } from "../engine/github/team-visibility.js";

/**
 * Most repos a `?repos=` scope may name (issue #169). Past this the client is
 * told to stop filtering rather than have the server build a WHERE clause with
 * thousands of OR branches — and since the scope is declutter, dropping it just
 * shows more.
 */
const MAX_REPO_SCOPE = 200;

/**
 * Most repos ONE board may cover — deliberately not {@link MAX_REPO_SCOPE}.
 *
 * That cap bounds a WHERE clause; this one bounds live GitHub reads, and the
 * two are three orders of magnitude apart in what they cost. Twenty repos is
 * two GraphQL documents per TTL window (see `listOpenBoardItems`); two hundred
 * would be twenty, on the same budget the harness spends reviewing pull
 * requests. Over the cap the scope is TRUNCATED and says so — never a 400 — so
 * the UI can report "showing 20 of 57" instead of silently showing a subset.
 */
const MAX_BOARD_REPOS = 20;

/**
 * The ONLY route keys a board dispatch may resolve a workflow through.
 *
 * The board posts an issue number, not a workflow name. That is the whole
 * point: a free-form workflow name accepted from a browser would turn one card
 * action into a generic "run anything against any managed repo" surface, which
 * is a much larger thing than the button says it is — and it already exists,
 * deliberately, as `POST /api/run` for operators who want it.
 *
 * So the workflow is resolved from `routes.github` — the operator's own route
 * map — and then CHECKED to be one of these three keys' values. An operator who
 * repoints `issue_build` at a different workflow moves this surface with it,
 * which is right; an operator who never configured the stage at all gets a
 * refusal rather than a dispatch, which is also right.
 */
const ISSUE_DISPATCH_ROUTE_KEYS = ["issue_opened", "issue_labeled", "issue_build"] as const;

/** The four label slots a stage declares, in pipeline order. */
type StageSlot = "enter" | "running" | "on_success" | "on_failure";
const STAGE_SLOTS: readonly StageSlot[] = ["enter", "running", "on_success", "on_failure"];

/**
 * Which stage — and which of its four slots — a configured label names.
 *
 * The flat allow-list the stage route builds answers "may this label be
 * written", which is the SECURITY question and stays exactly as it was. This
 * answers the different question a dispatch needs: WHICH stage the human just
 * asked for, and which column of it they dropped on. Only `enter` and `running`
 * mean "build this"; the two terminal slots are where a run has already ended.
 *
 * Fails CLOSED on a label two stages both claim. That is a real config, and a
 * SPEND decision taken on an undecidable one is the wrong direction to guess in
 * — the same reason `build-gate.ts` refuses an unknown stage rather than
 * picking a default.
 */
function stageSlotForLabel(
  label: string,
):
  | { kind: "match"; stage: string; slot: StageSlot }
  | { kind: "ambiguous"; stages: string[] }
  | null {
  if (!label) return null;
  const hits: Array<{ stage: string; slot: StageSlot }> = [];
  for (const [name, stage] of Object.entries(getAutonomyConfig().stages)) {
    for (const slot of STAGE_SLOTS) {
      if (stage[slot] && stage[slot] === label) {
        hits.push({ stage: name, slot });
        break;
      }
    }
  }
  if (hits.length === 0) return null;
  const names = [...new Set(hits.map((h) => h.stage))];
  if (names.length > 1) return { kind: "ambiguous", stages: names };
  return { kind: "match", stage: hits[0]!.stage, slot: hits[0]!.slot };
}

/**
 * Is `workflow` one the operator's own route map already points an issue
 * trigger at? See {@link ISSUE_DISPATCH_ROUTE_KEYS} for why that check exists.
 *
 * Shared by BOTH board surfaces — the dispatch button and the drag — because
 * two copies of this check are two things free to drift, and the one that
 * drifts open is a "run anything against any managed repo" hole.
 */
function isIssueRoutableWorkflow(workflow: string): boolean {
  const routable = new Set(
    ISSUE_DISPATCH_ROUTE_KEYS.map((key) => getRoutes().github?.[key]).filter(Boolean),
  );
  return routable.has(workflow);
}
import {
  getRuntimeConfig,
  getRoutes,
  getBotName,
  resolveKubernetesConfig,
  // The redaction rule for every surface that echoes YAML back to the
  // dashboard. IMPORTED, never mirrored: `GET /repos/:owner/:repo/config`
  // returns a repo's UNTRUSTED `.lastlight/lastlight.yml` raw and
  // pre-validation, so a copy that drifted behind config.ts's would leak a
  // pasted credential. It must stay single-source (see config.ts).
  redactPublic,
  getAutonomyConfig,
  getHoldLabel,
  type RepoConfigPolicy,
} from "../config/config.js";
import {
  fetchRepoLayer,
  refreshRepoLayer,
  getCachedRepoLayer,
  repoConfigPolicy,
  repoConfigBaseFromRuntime,
  resolveRepoConfig,
} from "../config/repo-config.js";
import { issueTriggerId } from "../engine/build-decisions.js";
import { applyBuildDispatchGate } from "../engine/build-gate.js";
import { buildBoard, type BoardStage, type BoardDegradation } from "./board.js";
import { getBoardItems, invalidateBoard, BOARD_TTL_MS } from "./board-cache.js";
import { boardSignature, BOARD_TICK_MS, BOARD_HEARTBEAT_MS } from "./board-stream.js";
import { reapSandboxWorkspace } from "../sandbox/reap.js";
import { artifactStore } from "../sandbox/artifact-store.js";
import { reclaimSandbox } from "../sandbox/k8s/reclaim.js";
import { makeK8sApis } from "../sandbox/k8s/client.js";
import { RunId } from "../sandbox/k8s/run-id.js";
import { getServerVersion } from "./version.js";
import { BuildAssetStore, buildAssetIssueKey } from "../state/build-assets.js";
import type { WorkflowApproval } from "../state/approval-store.js";
import type { PublicConfigBundle, BuildAssetsLocation } from "../config/config.js";
import { logger } from "../logging/logger.js";
import { recordActivity } from "../activity.js";
import { recordActivityFor } from "./activity.js";

const log = logger("admin");
const oauthLog = logger("oauth");

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
  /**
   * Fire a cron's workflow now (manual trigger — the "Run now" button + `lastlight
   * cron trigger`). Wired in `src/index.ts` to the same runner the scheduler uses,
   * so it drives the cron's real discovery + fan-out. Absent in environments
   * without the runner (tests, CLI-only) → the trigger endpoint reports 503.
   */
  triggerCron?: (workflow: string, context: Record<string, unknown>) => Promise<void>;
  /**
   * Run a HOST-SIDE cron handler now — the `handler:` half of the same "Run
   * now" button (`src/cron/handlers.ts`). Wired in `src/index.ts` to the same
   * registry the scheduler resolves against, so a manual fire and a scheduled
   * tick execute identical code. Absent without the registry → 503, exactly
   * like `triggerCron`.
   */
  runCronHandler?: (handler: string, context: Record<string, unknown>) => Promise<void>;
  /**
   * The harness GitHub client — `null` in chat-only mode, absent in tests that
   * don't need it. The three collaborators below exist for ONE endpoint,
   * `POST /prs/:owner/:repo/:number/retry`, which has to resolve a live `PrState`
   * snapshot, cross the same dispatch gate every other route crosses, and then
   * dispatch. Without a client there is nothing to resolve, so the route reports
   * 503 rather than acting on a snapshot made of defaults.
   */
  github?: GitHubClient | null;
  /**
   * Dispatch a workflow now. Wired in `src/index.ts` to the same
   * `dispatchWorkflow` every route uses, so a retry's run is indistinguishable
   * from a webhook's. Absent without the runner (tests, CLI-only) → 503.
   */
  dispatchWorkflow?: (
    workflow: string,
    context: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string }>;
  /**
   * The run's repo-clamped `fix`/`dependencies`/`review` blocks — the SAME
   * resolution `dispatchWorkflow` performs (`resolveRepoRunConfig`), handed in
   * for the same reason the dispatcher is handed it: a second, operator-only
   * view of policy would read a repo's budgets LOOSER than the repo set them,
   * which is the one direction a budget must not err in. Absent → the
   * operator's own config (`prPolicyConfig(undefined)`).
   */
  resolveRepoPolicy?: (
    workflowName: string,
    context: Record<string, unknown>,
  ) => Promise<Partial<PrPolicyConfig> | undefined>;
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
    const allIds = await sessions.listSessionIds();
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
          sessions.listSessionIds(),
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
    if (await sessions.exists(id)) {
      const meta = await sessions.getSessionMeta(id);
      if (meta) return c.json({ session: meta });
    }
    return c.json({ error: "session not found" }, 404);
  });

  // Messages for a session
  app.get(`${prefix}/:id/messages`, async (c) => {
    const id = c.req.param("id");
    const sinceIndex = Number(c.req.query("since") ?? -1);

    if (await sessions.exists(id)) {
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

    if (!(await sessions.exists(id))) {
      return c.json({ error: "session not found" }, 404);
    }

    const filePath = await sessions.getFilePath(id);
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

/** Token endpoints for the confidential-client OAuth2 code exchange. */
export const GITHUB_TOKEN_ENDPOINT = "https://github.com/login/oauth/access_token";
export const SLACK_TOKEN_ENDPOINT = "https://slack.com/api/openid.connect.token";

/**
 * Exchange an OAuth2 authorization code for an access token — our own tiny
 * confidential-client (Basic-auth) exchange, used instead of arctic's
 * `validateAuthorizationCode` for the dashboard's GitHub + Slack logins.
 *
 * Why not arctic: arctic's `createOAuth2Request` **pre-sets a `Content-Length`
 * header** on the token POST. That's fine on Node's built-in fetch, but an
 * in-process agent run (agentic-pi / pi-ai) replaces Node's global undici
 * dispatcher with a non-default undici build ("poisons" the global fetch — see
 * `sandbox.ts` + `chat-skills.ts`), and that dispatcher **rejects a manually-set
 * Content-Length** with `UND_ERR_INVALID_ARG: invalid content-length header`.
 * Result: once any in-process run has happened, every GitHub/Slack OAuth login
 * throws `ArcticFetchError` and users can't sign in. The follow-up userInfo GETs
 * work because they carry no body / no Content-Length.
 *
 * The fix is simply to not set Content-Length ourselves — undici computes it
 * internally, which never trips the header validation. Semantics match arctic's
 * confidential-client path exactly (grant_type=authorization_code, Basic auth,
 * form body), so GitHub and Slack differ only by `tokenEndpoint`.
 */
export async function exchangeOAuth2Code(opts: {
  tokenEndpoint: string;
  code: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
  });
  if (opts.redirectUri) body.set("redirect_uri", opts.redirectUri);
  const credentials = Buffer.from(`${opts.clientId}:${opts.clientSecret}`).toString("base64");

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(opts.tokenEndpoint, {
    method: "POST",
    // Deliberately NO Content-Length header — see the doc comment above.
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${credentials}`,
      "User-Agent": "lastlight-admin",
    },
    body: body.toString(),
  });

  const data = (await res.json().catch(() => null)) as
    | { access_token?: string; error?: string; error_description?: string; ok?: boolean }
    | null;
  const accessToken = data?.access_token;
  if (res.status !== 200 || !accessToken) {
    const detail = data?.error_description ?? data?.error ?? `status ${res.status}`;
    throw new Error(`OAuth token exchange failed: ${detail}`);
  }
  return accessToken;
}

// ── Event Router Playground ──────────────────────────────────────────────────
// Powers the admin "Event Router Playground" page (`/route-graph` +
// `/route-test`): a visual, hermetic dry-run of the classifier + router. See
// src/engine/router.ts — routeEvent performs NO side effects, so threading a
// synthetic event through it (with empty deps) never starts a workflow.

/** An event type a connector emits, tagged by how the router decides its handler. */
interface PlaygroundEventType {
  input: "github" | "slack";
  type: EventType;
  routing: "deterministic" | "classifier";
  label: string;
}

/**
 * The event-type taxonomy for the playground graph — GitHub + Slack only (cron
 * and CLI bypass the router). `routing` mirrors the branches in router.ts:
 * `deterministic` = a fixed code branch; `classifier` = a real LLM intent call.
 */
const PLAYGROUND_EVENT_TYPES: PlaygroundEventType[] = [
  // `issue.opened` runs `classifyIssueIntent` (question vs work) to pick between
  // the `answer` workflow and `issue-triage` — an LLM decides the handler, so it
  // is classifier-routed, not deterministic (even though it needs no @mention).
  { input: "github", type: "issue.opened", routing: "classifier", label: "Issue opened" },
  { input: "github", type: "issue.reopened", routing: "deterministic", label: "Issue reopened" },
  { input: "github", type: "pr.opened", routing: "deterministic", label: "PR opened" },
  { input: "github", type: "pr.synchronize", routing: "deterministic", label: "PR synchronized" },
  { input: "github", type: "pr.reopened", routing: "deterministic", label: "PR reopened" },
  { input: "github", type: "pr.checks_passed", routing: "deterministic", label: "PR checks passed" },
  { input: "github", type: "pr.checks_failed", routing: "classifier", label: "PR checks failed" },
  { input: "github", type: "comment.created", routing: "classifier", label: "Comment created" },
  { input: "github", type: "pr_review.submitted", routing: "classifier", label: "PR review submitted" },
  { input: "slack", type: "message", routing: "classifier", label: "Message" },
];

/**
 * Event types whose intent comes from `classifyComment` on free-form text — the
 * ones the playground re-classifies (with `explain`) to surface the model's
 * reasoning. `pr.checks_failed` is classifier-routed too, but via a check-state
 * branch inside routeEvent, not comment text — so it isn't re-classified here.
 */
const COMMENT_CLASSIFIER_TYPES = new Set<EventType>([
  "comment.created",
  "message",
  "pr_review.submitted",
]);

function playgroundRouting(type: EventType): "deterministic" | "classifier" {
  return PLAYGROUND_EVENT_TYPES.find((e) => e.type === type)?.routing ?? "deterministic";
}

/** Request body for POST /route-test — a synthetic event to dry-run. */
interface RouteTestBody {
  source?: string;
  type: string;
  body?: string;
  title?: string;
  sender?: string;
  repo?: string;
  issueNumber?: number;
  prNumber?: number;
  isPullRequest?: boolean;
  prAuthor?: string;
  checksState?: string;
  labels?: string[];
  authorAssociation?: string;
  /** Original issue/PR author. Falls back to `prAuthor` for PR events (the
   *  `pr.checks_failed` branch classifies "…by <issueAuthor>…"). */
  issueAuthor?: string;
}

interface RouteExplanation {
  routingKind: "deterministic" | "classifier";
  branchLabel: string;
  handler?: string;
  routeKey?: string;
  reason?: string;
  notes: string[];
}

/** Compose a human-readable "why" from the event type, classifier result, and route. */
function buildExplanation(
  type: EventType,
  classification: ClassificationResult | undefined,
  route: Route,
): RouteExplanation {
  const routingKind = playgroundRouting(type);
  const notes: string[] = [];
  let handler: string | undefined;
  let routeKey: string | undefined;

  if (route.action === "handler") {
    handler = route.handler;
    const rk = (route.context as Record<string, unknown> | undefined)?._routeKey;
    routeKey = typeof rk === "string" ? rk : undefined;
  } else if (route.action === "reply") {
    notes.push(`Replied directly: ${route.message}`);
  } else {
    notes.push(`Ignored: ${route.reason}`);
  }

  let branchLabel: string;
  if (classification) {
    branchLabel = `classified as '${classification.intent}'` + (handler ? ` → ${handler}` : "");
  } else if (route.action === "handler") {
    branchLabel = `${type} → ${handler}`;
  } else {
    branchLabel = `${type} → ${route.action}`;
  }

  return { routingKind, branchLabel, handler, routeKey, reason: classification?.reason, notes };
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
    oauthLog.error(
      "GitHub OAuth client id/secret are set but GITHUB_ALLOWED_ORG is empty. " +
      "Set it to a GitHub org slug to restrict login to that org, or to \"*\" to " +
      "explicitly allow any GitHub user. GitHub OAuth is disabled until this is set.",
    );
  }
  const githubAllowAnyUser = config.githubAllowedOrg === "*";

  // Per-repo dashboard visibility (issue #169). Constructed unconditionally —
  // it is inert (and answers the fail-open sentinel) when `teamVisibility` is
  // off or there is no GitHub client, which is what tests and chat-only mode see.
  const teamVisibility = new TeamVisibilityResolver({
    store: db.teams,
    github: config.github ?? null,
  });

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
    const effective = getManagedRepos();
    // Every ACCOUNT the App is installed on, with its repo grant. A GitHub App
    // is installed per account and each installation mints its own tokens, so a
    // `managedRepos` entry whose owner has no installation cannot be acted on —
    // `uninstalledOwners` names them here, where an operator can see it, rather
    // than letting it surface as a 422 mid-run.
    const repoCounts = new Map(
      getInstallationRepoBreakdown().map((g) => [g.installationId, g.repos.length]),
    );
    const installations = getInstallationDirectory()?.list() ?? [];
    const installedOwners = new Set(installations.map((i) => i.account.toLowerCase()));
    const uninstalledOwners = [
      ...new Set(
        effective
          .map((r) => r.split("/")[0] ?? "")
          .filter((owner) => owner && !installedOwners.has(owner.toLowerCase())),
      ),
    ];
    return c.json({
      configured,
      installation: getInstallationRepos(),
      effective,
      source: configured.length > 0 ? "config" : "installation",
      refreshedAt: getInstallationReposRefreshedAt(),
      installations: installations.map((i) => ({
        id: i.id,
        account: i.account,
        accountType: i.accountType,
        repositorySelection: i.repositorySelection,
        suspended: i.suspended,
        repoCount: repoCounts.get(i.id) ?? 0,
        // Deep link to GitHub's settings page for this install — where the repo
        // grant, suspension and uninstall actually live. Built server-side
        // because the path shape depends on the account type.
        htmlUrl: installationSettingsUrl(i) ?? null,
      })),
      uninstalledOwners,
      // Where to go and fix an uninstalled owner. `botName` IS the App slug
      // (see the bot-identity contract), so this resolves without storing the
      // App's URL anywhere.
      appInstallUrl: `https://github.com/apps/${getBotName()}/installations/new`,
      // Which of the effective repos have committed a `.lastlight/` layer.
      // Read from the in-memory cache ONLY (`getCachedRepoLayer`) so this stays
      // a cheap no-network list route — a repo not yet fetched simply reports
      // false, and the per-repo endpoint below is what actually goes to GitHub.
      repoConfig: effective.map((repo) => {
        const layer = getCachedRepoLayer(repo);
        return { repo, hasRepoConfig: Boolean(layer), fetchedAt: layer?.fetchedAt ?? null };
      }),
    });
  });

  // The managed repos THIS user should see by default, from their GitHub team
  // grants (issue #169).
  //
  // Read `repos: null` as "no filter" — it is the sentinel, and it is what every
  // non-happy path returns: a password/Slack login (no GitHub identity), an
  // `allowedOrg: "*"` deployment, the feature switched off, a team too large to
  // enumerate, or GitHub refusing the query. This is UI declutter, NOT access
  // control: `/workflow-runs`, `/sessions` and `/stats` all keep returning
  // global data and the filtering happens in the browser, so failing open costs
  // nothing but a noisier list.
  //
  // Cheap by design — served from the SQLite cache, with a stale answer returned
  // immediately while it refreshes behind the request. Only a genuine first
  // resolution touches GitHub, and even that is a handful of GraphQL calls
  // scoped to this one person's teams (see engine/github/team-visibility.ts).
  app.get("/me/repos", async (c) => {
    const result = await teamVisibility.visibleRepos(actorFromContext(c));
    return c.json({
      repos: result.repos,
      synced: result.synced,
      reason: result.reason,
      teams: result.teams,
      syncedAt: result.syncedAt,
    });
  });

  // Force a re-resolution for the CALLER. The fallback for orgs where the
  // `team`/`membership`/`organization` webhooks aren't wired up yet — those
  // events normally invalidate the cache for us.
  //
  // Always self, never an arbitrary `?login=`. The response carries `teams`,
  // which names the GitHub org teams a person belongs to — including secret
  // ones — and the admin dashboard's authenticated population is not the same
  // as "people entitled to enumerate org membership". A password-only session
  // has no GitHub identity at all, so an override param would have let it read
  // any login's teams with nothing to check it against.
  app.post("/me/repos/resync", async (c) => {
    const login = actorFromContext(c);
    if (!login) return c.json({ error: "no GitHub identity on this session" }, 400);
    const result = await teamVisibility.resync(login);
    return c.json({
      repos: result.repos,
      synced: result.synced,
      reason: result.reason,
      teams: result.teams,
      syncedAt: result.syncedAt,
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

  // ── Event Router Playground ────────────────────────────────────────────────
  // Static graph description: inputs → event types → router → handlers. Built
  // from the same sources the router uses (getRoutes + listAgentWorkflows) so the
  // taxonomy isn't duplicated in the frontend.
  app.get("/route-graph", (c) => {
    const routes = getRoutes();
    const defs = listAgentWorkflows();

    const inputs = [
      { id: "github" as const, label: "GitHub" },
      { id: "slack" as const, label: "Slack" },
    ];

    const eventTypes = PLAYGROUND_EVENT_TYPES.map((e) => ({
      input: e.input,
      type: e.type,
      routing: e.routing,
      label: e.label,
    }));

    const handlers: { name: string; claimedIntent?: string; kind: "workflow" | "in-process" }[] =
      defs.map((def) => ({
        name: def.name,
        claimedIntent: def.classification?.intent,
        kind: "workflow" as const,
      }));
    // In-process handlers the router can dispatch to (not YAML workflows).
    for (const name of ["chat", "chat-reset", "status-report", "approval-response", "explore-reply"]) {
      handlers.push({ name, kind: "in-process" });
    }

    // Classifier intent → handler fan-out edges: each workflow's claimed intent,
    // then any remaining slack-route intents (reserved controls, question, …).
    const intentEdges: { intent: string; to: string }[] = [];
    const seenIntent = new Set<string>();
    for (const def of defs) {
      const intent = def.classification?.intent;
      if (!intent || seenIntent.has(intent)) continue;
      seenIntent.add(intent);
      intentEdges.push({ intent, to: resolveIntentHandler(intent) });
    }
    for (const [key, to] of Object.entries(routes.slack)) {
      const intent = key.replace(/_/g, "-");
      if (seenIntent.has(intent)) continue;
      seenIntent.add(intent);
      intentEdges.push({ intent, to });
    }

    // Deterministic event-type → handler edges, straight from the github routes.
    const gh = routes.github;
    const deterministicEdges = [
      { from: "issue.opened", to: gh.issue_opened, via: "issue_opened" },
      { from: "issue.reopened", to: gh.issue_reopened, via: "issue_reopened" },
      { from: "pr.opened", to: gh.pr_opened, via: "pr_opened" },
      { from: "pr.synchronize", to: gh.pr_synchronize, via: "pr_synchronize" },
      { from: "pr.reopened", to: gh.pr_reopened, via: "pr_reopened" },
      { from: "pr.checks_passed", to: getWorkflowByIntent("dependabot-pr-merge")?.name, via: "checks_passed" },
    ].filter((e): e is { from: string; to: string; via: string } => Boolean(e.to));

    // Ensure every edge target has a handler node (a route may point at a
    // workflow not in the def list, e.g. a bare fallback name).
    const handlerNames = new Set(handlers.map((h) => h.name));
    for (const to of [...intentEdges.map((e) => e.to), ...deterministicEdges.map((e) => e.to)]) {
      if (to && !handlerNames.has(to)) {
        handlerNames.add(to);
        handlers.push({ name: to, kind: "workflow" });
      }
    }

    return c.json({ botName: getBotName(), inputs, eventTypes, handlers, deterministicEdges, intentEdges });
  });

  // Hermetic dry-run: thread a synthetic event through the REAL classifier +
  // router and return the decision — WITHOUT starting any workflow. Calls
  // routeEvent({}) (no db, no github → zero external reads/writes) and, for
  // comment-text types, classifyComment(..., {explain:true}) for the reasoning.
  // NEVER touches dispatch/dispatchWorkflow (structurally out of scope here).
  app.post("/route-test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as RouteTestBody | null;
    if (!body || typeof body.type !== "string") {
      return c.json({ error: "type is required" }, 400);
    }
    const type = body.type as EventType;
    const isPr = body.isPullRequest ?? type.startsWith("pr");

    const envelope: EventEnvelope = {
      id: `route-test-${randomUUID()}`,
      source: body.source ?? "github",
      type,
      repo: body.repo,
      issueNumber: body.issueNumber,
      prNumber: isPr ? body.prNumber ?? 1 : body.prNumber,
      sender: body.sender || "playground-user",
      // The PR/issue author — for PR events (e.g. pr.checks_failed) the router
      // classifies "…by <issueAuthor>…", so a dependency PR needs the bot author.
      issueAuthor: body.issueAuthor ?? (isPr ? body.prAuthor : undefined),
      senderIsBot: false,
      body: body.body ?? "",
      title: body.title,
      labels: body.labels ?? [],
      authorAssociation: body.authorAssociation ?? "OWNER",
      raw: {}, // empty → no Slack thread lookup
      reply: async () => {}, // inert no-op — nothing is ever posted
      timestamp: new Date(),
    };

    let classification: ClassificationResult | undefined;
    if (COMMENT_CLASSIFIER_TYPES.has(type)) {
      classification = await classifyComment(
        envelope.body,
        {
          issueTitle: body.title,
          isPullRequest: isPr,
          prAuthor: body.prAuthor,
          checksState: body.checksState,
        },
        { explain: true },
      );
    } else if (type === "pr.checks_failed") {
      // The router classifies a SYNTHESIZED description for this event (not the
      // body) — replicate it so the playground surfaces the same intent/reason
      // (or a classifier error) the router's internal call would produce.
      const text =
        `Pull request #${envelope.prNumber} "${envelope.title || ""}" ` +
        `by ${envelope.issueAuthor || "unknown"} — its CI checks have failed.`;
      classification = await classifyComment(
        text,
        { issueTitle: envelope.title, isPullRequest: true },
        { explain: true },
      );
    } else if (type === "issue.opened") {
      // `classifyIssueIntent` classifies the combined title + body (question vs
      // work) to choose `answer` vs `issue-triage` — mirror it so the why-panel
      // shows the same intent/reason the router's internal call produced.
      const combined = `${envelope.title || ""}\n\n${envelope.body || ""}`.trim();
      classification = await classifyComment(
        combined,
        { issueTitle: envelope.title },
        { explain: true },
      );
    }

    const route = await routeEvent(envelope, {});
    const explanation = buildExplanation(type, classification, route);
    return c.json({ route, classification, explanation });
  });

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
    // A failed password attempt is one of the few things an audit stream is
    // unambiguously for. `actorType` is passed explicitly because there is no
    // token yet — the context this route runs in carries no actor at all, and
    // password login never learns a login.
    await recordActivity(db, {
      action: "login",
      actorType: "admin",
      outcome: ok ? "ok" : "denied",
      detail: { method: "password" },
    });
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
    const decoded = decodeToken(current);
    return c.json({ token: createToken(config.adminSecret, decoded?.method, decoded?.login) });
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
    // `email` is requested (issue #205) so the OIDC userInfo carries the
    // address we match Slack logins to a `users` row on (and store as the
    // future email hook).
    const url = slack.createAuthorizationURL(state, ["openid", "profile", "email"]);
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
      // "Sign in with Slack" issues OIDC-scoped tokens (openid + profile),
      // which Slack's classic auth.test endpoint rejects with invalid_auth.
      // Use the OIDC userInfo endpoint instead — it returns a JWT-style
      // payload with claims under namespaced URLs.
      const accessToken = await exchangeOAuth2Code({
        tokenEndpoint: SLACK_TOKEN_ENDPOINT,
        code,
        clientId: config.slackOAuthClientId!,
        clientSecret: config.slackOAuthClientSecret!,
        redirectUri: config.slackOAuthRedirectUri ?? "",
      });
      const res = await fetch("https://slack.com/api/openid.connect.userInfo", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const userInfo = (await res.json()) as {
        ok?: boolean;
        error?: string;
        sub?: string;
        name?: string;
        email?: string;
        "https://slack.com/team_id"?: string;
        "https://slack.com/team_domain"?: string;
        "https://slack.com/user_id"?: string;
      };
      if (userInfo.ok === false) {
        oauthLog.error("Slack openid.connect.userInfo failed", { error: userInfo.error });
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
          oauthLog.warn("Slack login rejected: workspace not in allowlist", {
            workspace: teamDomain ?? teamId ?? "unknown",
            allowed,
          });
          return c.json({ error: "workspace not allowed" }, 403);
        }
      }

      // Capture / match a first-class user identity (issue #205): match the
      // Slack email to an existing (GitHub) `users` row and link the Slack id
      // onto it, else create a Slack-only row. When matched, the person's
      // GitHub login rides the token so a Slack dashboard session attributes to
      // the same user. Best-effort — never block a valid login on it.
      let matchedLogin: string | undefined;
      const slackUserId = userInfo["https://slack.com/user_id"];
      if (slackUserId) {
        try {
          const user = await db.users.upsertSlackUser({
            slackUserId,
            name: userInfo.name ?? null,
            email: userInfo.email ?? null,
          });
          matchedLogin = user.login;
        } catch (err: unknown) {
          oauthLog.warn("Failed to persist Slack user", { slackUserId, err });
        }
      }

      const token = createToken(config.adminSecret, "slack", matchedLogin);
      // `actorLogin` is the MATCHED GitHub login, or null when the email did not
      // resolve to a `users` row — the same degradation #205 documents for the
      // Slack connector, and the reason this column is nullable.
      await recordActivity(db, {
        action: "login",
        actorLogin: matchedLogin ?? null,
        actorType: "slack",
        detail: { method: "slack", matched: !!matchedLogin },
      });
      // Redirect to dashboard with token in URL; App.tsx strips it immediately.
      // Trailing slash matters: Vite serves the SPA with base "/admin/" so a
      // bare "/admin" 404s in dev. Production static serving accepts both.
      return c.redirect(`/admin/?token=${encodeURIComponent(token)}`);
    } catch (err: unknown) {
      oauthLog.error("Slack OAuth exchange failed", { err });
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
      const accessToken = await exchangeOAuth2Code({
        tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
        code,
        clientId: config.githubOAuthClientId!,
        clientSecret: config.githubOAuthClientSecret!,
        redirectUri: config.githubOAuthRedirectUri ?? "",
      });
      const res = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "User-Agent": "lastlight-admin",
          Accept: "application/vnd.github+json",
        },
      });
      const userInfo = (await res.json()) as {
        id?: number;
        login?: string;
        name?: string | null;
        email?: string | null;
        avatar_url?: string | null;
      };

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
        oauthLog.error("GitHub /user failed: missing login field");
        return fail("github_userinfo");
      }
      const login = userInfo.login;

      // Only 204 No Content means confirmed member. 302 means caller lacks
      // read:org visibility; 404 means not a member. Both cases are rejected.
      if (!githubAllowAnyUser && memberStatus !== 204) {
        oauthLog.warn("GitHub login rejected: not a confirmed org member", {
          login,
          org: config.githubAllowedOrg!,
          memberStatus,
        });
        // A rejected login names a real, verified GitHub identity — the one
        // denial in here where we know exactly who was turned away.
        await recordActivity(db, {
          action: "login",
          actorLogin: login,
          actorType: "github",
          outcome: "denied",
          detail: { method: "github", reason: "not_org_member", org: config.githubAllowedOrg! },
        });
        return fail("github_org");
      }

      // Capture a first-class user identity (issue #205). A public GitHub
      // profile often hides the email on GET /user, so fall back to the
      // authenticated /user/emails list and pick the primary+verified one —
      // this is the future outbound-email hook (nothing sends yet). Persisting
      // is orthogonal to the org gate above, so it runs even for
      // githubAllowAnyUser logins.
      let email = userInfo.email ?? null;
      if (!email) {
        try {
          const emailsRes = await fetch("https://api.github.com/user/emails", {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "User-Agent": "lastlight-admin",
              Accept: "application/vnd.github+json",
            },
          });
          if (emailsRes.ok) {
            const emails = (await emailsRes.json()) as Array<{
              email?: string;
              primary?: boolean;
              verified?: boolean;
            }>;
            email = emails.find((e) => e.primary && e.verified)?.email ?? null;
          }
        } catch (err: unknown) {
          oauthLog.warn("GitHub /user/emails lookup failed", { login, err });
        }
      }
      if (typeof userInfo.id === "number") {
        try {
          await db.users.getOrCreateUserByGithub({
            githubId: userInfo.id,
            login,
            name: userInfo.name ?? null,
            email,
            avatarUrl: userInfo.avatar_url ?? null,
          });
        } catch (err: unknown) {
          // Identity capture is best-effort — never block a valid login on it.
          oauthLog.warn("Failed to persist user", { login, err });
        }
      }

      // Carry the verified login in the token so actor-hardcoded routes
      // attribute to this person.
      const token = createToken(config.adminSecret, "github", login);
      await recordActivity(db, {
        action: "login",
        actorLogin: login,
        actorType: "github",
        detail: { method: "github" },
      });
      return c.redirect(`/admin/?token=${encodeURIComponent(token)}`);
    } catch (err: unknown) {
      oauthLog.error("GitHub OAuth exchange failed", { err });
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
      db.executions.executionStats(),
      listRunningContainers(),
    ]);
    stats.running = containers.length;
    return c.json(stats);
  });

  // Daily aggregated stats (last N days)
  app.get("/stats/daily", async (c) => {
    const daysParam = c.req.query("days");
    const days = Math.min(Math.max(1, parseInt(daysParam ?? "30", 10) || 30), 90);
    return c.json({ daily: await db.executions.dailyStats(days) });
  });

  // Hourly aggregated stats (rolling last N hours, default 24)
  app.get("/stats/hourly", async (c) => {
    const hoursParam = c.req.query("hours");
    const hours = Math.min(Math.max(1, parseInt(hoursParam ?? "24", 10) || 24), 168);
    return c.json({ hourly: await db.executions.hourlyStats(hours) });
  });

  // ── Feedback signals (issue #255) ─────────────────────────────────────────
  // A 👍/👎 on something the bot wrote, scored against the run that wrote it.
  // Read-only: signals are written by the Slack reaction handler and the GitHub
  // poller, never by an operator — the whole point is that the data is what
  // people actually did.

  // The raw feed, newest first. Retracted signals are excluded unless asked for.
  app.get("/feedback/signals", async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    const source = c.req.query("source");
    const { signals, total } = await db.feedback.list({
      limit,
      offset,
      workflowName: c.req.query("workflow") || undefined,
      repo: c.req.query("repo") || undefined,
      source: source === "slack" || source === "github" ? source : undefined,
      includeRemoved: c.req.query("includeRemoved") === "1",
    });
    return c.json({ signals, total });
  });

  // Per-workflow standing — the leaderboard. `averageScore` covers scored
  // signals only, so a run everybody merely glanced at (👀) isn't reported as
  // mediocre.
  app.get("/feedback/summary", async (c) => {
    const days = Math.min(Math.max(1, parseInt(c.req.query("days") ?? "30", 10) || 30), 365);
    return c.json({ summary: await db.feedback.summaryByWorkflow(days), days });
  });

  // Zero-filled daily series for the chart, optionally for one workflow.
  app.get("/feedback/daily", async (c) => {
    const days = Math.min(Math.max(1, parseInt(c.req.query("days") ?? "30", 10) || 30), 90);
    const workflow = c.req.query("workflow") || undefined;
    return c.json({ daily: await db.feedback.dailyScores(days, workflow) });
  });

  // Everything said about one run — the run-detail badge.
  app.get("/workflow-runs/:id/feedback", async (c) => {
    const run = await db.runs.getRun(c.req.param("id"));
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    return c.json({ signals: await db.feedback.forRun(run.id) });
  });

  // Running Docker containers
  app.get("/containers", async (c) => {
    const containers = await listRunningContainers();
    return c.json({ containers });
  });

  // Host-level CPU/memory plus per-container stats for the agent and sandboxes
  app.get("/containers/stats", async (c) => {
    const [stats, host] = await Promise.all([getContainerStats(), getHostStats()]);
    return c.json({ stats, host });
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
        const skills = (await db.executions.runningExecutions())
          .filter((e) => e.skill.includes(":") || e.skill === "pr-fix")
          .filter((e) => taskId.includes(e.triggerId?.replace(/[^a-z0-9]/gi, "") || "---"));
        for (const e of skills) {
          await db.executions.recordFinish(e.id, { success: false, error: "terminated via admin dashboard" });
        }
      }
      await recordActivityFor(c, db, {
        action: "container.kill",
        targetType: "container",
        targetId: name,
      });
      return c.json({ killed: name });
    } catch (err: any) {
      // The kill itself failed — record the attempt, since "someone tried to
      // kill this and could not" is exactly the kind of thing an audit stream
      // is read for.
      await recordActivityFor(c, db, {
        action: "container.kill",
        targetType: "container",
        targetId: name,
        outcome: "error",
        detail: { error: String(err?.message ?? err).slice(0, 200) },
      });
      return c.json({ error: err.message }, 500);
    }
  });

  // Execution records from DB
  app.get("/executions", async (c) => {
    const limit = Number(c.req.query("limit") ?? 100);
    const offset = Number(c.req.query("offset") ?? 0);
    const executions = await db.executions.allExecutions(limit, offset);
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
      for (const r of await db.executions.searchErrors(q, limit)) {
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
      const ids = (await sessions.listSessionIds()).slice(0, maxSessions);
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
  app.get("/workflow-runs", async (c) => {
    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const since = c.req.query("since") || undefined;
    const workflowName = c.req.query("workflow") || undefined;
    const repo = c.req.query("repo") || undefined;
    // Per-repo visibility scope (issue #169) — the caller's allowed repo set,
    // so the dashboard's panels ask for exactly the rows they show instead of
    // over-fetching and narrowing in the browser.
    //
    // This is a QUERY FILTER, not enforcement: the caller supplies it, omitting
    // it still returns global data, and it is the plural sibling of the `repo`
    // param the Repos tab has always used. Capped so a pathological query
    // string can't build a WHERE clause with thousands of OR branches.
    const repos = (c.req.query("repos") || "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean)
      .slice(0, MAX_REPO_SCOPE);
    const statusParam = c.req.query("status");
    const limit = Math.min(Math.max(parseInt(rawLimit ?? "20", 10) || 20, 1), 200);
    const offset = Math.max(parseInt(rawOffset ?? "0", 10) || 0, 0);

    let statuses: string[] | undefined;
    if (statusParam === "active") {
      // `active` includes queued runs so the live filter shows them alongside
      // running/paused ones in the dashboard header.
      statuses = ["queued", "running", "paused"];
    } else if (statusParam) {
      statuses = statusParam.split(",").filter(Boolean);
    }

    const { runs, total } = await db.runs.list({
      limit,
      offset,
      sinceIso: since,
      workflowName,
      repo,
      repos: repos.length > 0 ? repos : undefined,
      statuses,
    });
    return c.json({ workflowRuns: runs, total });
  });

  // Distinct workflow names — used to populate the dashboard's filter row.
  app.get("/workflow-names", async (c) => {
    return c.json({ names: await db.runs.distinctNames() });
  });

  // ── Activity log — the audit feed (issue #206) ────────────────────────────
  //
  // Deliberately NOT repo-scoped, unlike `/workflow-runs` and `/sessions`.
  // Their `?repos=` is UI declutter rather than authorization (see the note at
  // the top of `/me/repos`), and an audit stream silently filtered by which
  // teams you happen to belong to would be misleading in a way a run list is
  // not. Narrowing this one is a real authorization decision, not a copied
  // query param.
  app.get("/activity", async (c) => {
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    // `<type>:<id>`, split on the FIRST colon — a target id can contain one
    // (`repo:acme/widgets#7` does not, but `container:lastlight-sandbox-a:b`
    // could), and the type never does.
    const rawTarget = c.req.query("target") || undefined;
    const sep = rawTarget?.indexOf(":") ?? -1;
    const targetType = rawTarget ? (sep >= 0 ? rawTarget.slice(0, sep) : rawTarget) : undefined;
    const targetId = rawTarget && sep >= 0 ? rawTarget.slice(sep + 1) : undefined;

    const { activity, total } = await db.activity.list({
      limit,
      offset,
      actor: c.req.query("actor") || undefined,
      action: c.req.query("action") || undefined,
      targetType,
      targetId,
      sinceIso: c.req.query("since") || undefined,
    });

    // Enrich from `users` for name + avatar, the way `GET /workflow-runs/:id`
    // does for `triggered_by` (issue #205). Resolved ONCE per distinct login
    // rather than per row: a page of 50 is routinely two or three people.
    const logins = [...new Set(activity.map((a) => a.actorLogin).filter(Boolean))] as string[];
    const users: Record<string, { login?: string; name?: string; avatarUrl?: string }> = {};
    for (const login of logins) {
      const user = await db.users.findByLogin(login);
      if (user) users[login] = { login: user.login, name: user.name, avatarUrl: user.avatarUrl };
    }

    return c.json({ activity, total, users });
  });

  // The distinct verbs actually present, for the dashboard's filter dropdown —
  // mirrors `/workflow-names` above.
  app.get("/activity/actions", async (c) => {
    return c.json({ actions: await db.activity.actions() });
  });

  app.get("/workflow-runs/:id", async (c) => {
    const id = c.req.param("id");
    const run = await db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    // Enrich the actor with the `users` identity (issue #205) so the run
    // detail panel can show a real name + avatar, not just the raw login.
    // Best-effort: absent (password/cron/system actors, or a login with no
    // row) → the panel falls back to the login string + actor-type badge.
    const triggeredByUser = run.triggeredBy ? await db.users.findByLogin(run.triggeredBy) : null;
    return c.json({
      workflowRun: run,
      triggeredByUser: triggeredByUser
        ? {
            login: triggeredByUser.login,
            name: triggeredByUser.name,
            avatarUrl: triggeredByUser.avatarUrl,
          }
        : null,
    });
  });

  // List the executions belonging to a workflow run, ordered by start time.
  // Used by the dashboard's pipeline-detail view to look up the session id
  // (and usage metrics) for any phase the user clicks.
  app.get("/workflow-runs/:id/executions", async (c) => {
    const id = c.req.param("id");
    const run = await db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    const rows = await db.executions.getExecutionsForWorkflowRun(run.id, run.triggerId, run.workflowName);
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
      // Already parsed objects on the way out of the store — passed through as
      // they are. Re-parsing them would throw, and the old helper's `catch`
      // swallowed that into `undefined`, silently emptying the panel.
      extensions: r.extensionStatus,
      skills: r.skillsStatus,
    }));
    return c.json({ executions });
  });

  // All approvals (pending + resolved) for a workflow run, oldest first. Powers
  // the pipeline's approval-gate nodes + the detail panel's read-only approval
  // history (status, who responded, when, and any comment). The global
  // /approvals endpoint only lists pending ones, so it can't show history.
  app.get("/workflow-runs/:id/approvals", async (c) => {
    const id = c.req.param("id");
    const run = await db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    const approvals = await db.approvals.listForWorkflow(run.id);
    return c.json({ approvals });
  });

  app.post("/workflow-runs/:id/cancel", async (c) => {
    const id = c.req.param("id");
    const run = await db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    if (run.status !== "running" && run.status !== "paused" && run.status !== "queued") {
      return c.json({ error: `cannot cancel a run with status '${run.status}'` }, 400);
    }
    // Actor logging (issue #205): the canceller lands on the append-only
    // executions ledger (via the finish error below), never overwriting the
    // run's original `triggered_by`.
    const actor = actorFromContext(c) ?? "admin";
    await db.runs.cancelRun(id);
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
              log.warn("Cancel: failed to kill container", { container: ctr.name, err });
            }
          }),
        );
        // Mark execution rows belonging to THIS cancelled run as failed.
        // Matching by workflowRunId (the run's id) instead of triggerId
        // avoids clobbering a sibling run that happens to share the same
        // trigger — e.g. two webhook deliveries for the same PR that
        // raced before dedup closed.
        for (const e of await db.executions.runningExecutions()) {
          if (e.workflowRunId === id) {
            await db.executions.recordFinish(e.id, { success: false, error: `cancelled via admin dashboard by ${actor}` });
          }
        }
      } catch (err) {
        log.warn("Cancel: container enumeration failed", { err });
      }
    }
    // Reap the workspace too (issue #106) — the kills above stop the in-flight
    // phase but leave the clone (or, on the `kubernetes` backend, the Pod +
    // PVC) behind. Cancel is explicit and leaves a dirty checkout, so on the
    // host backend reap regardless of workflow class (a reusable per-PR dir
    // just re-clones next time). The live-container guard defaults on, so a
    // container still dying from the kills above is not raced.
    let reaped = false;
    if (typeof storedTaskId === "string" && storedTaskId) {
      if (getRuntimeConfig()?.sandbox === "kubernetes") {
        // On k8s, reclaim the run's pod + PVC by run-id label. An EPHEMERAL
        // (per-run) PVC matches and is deleted. A REUSED per-(repo,PR) PVC
        // keeps its first run's label, so it is intentionally left as a warm
        // cache (issue #107) and reclaimed later by the age/LRU sweep —
        // unlike the host reap above, which removes reused dirs on cancel.
        // `RunId.from(run.id)` sanitizes identically to the label Task 1
        // stamped on those objects (F7 — stamp/select symmetry is now
        // type-enforced), so the selector always matches. Best-effort: an
        // unreachable cluster / transport error must never fail the cancel
        // response.
        try {
          await reclaimSandbox(makeK8sApis(), resolveKubernetesConfig().namespace, {
            kind: "run",
            runId: RunId.from(run.id),
          });
        } catch (err) {
          log.warn("Cancel: k8s reclaim failed", { runId: run.id, err });
        }
        // The pod's uploaded `.lastlight/` artifacts live host-side under
        // `<sandboxDir>/<taskId>` even on k8s (the artifact store is host-local
        // on every backend). `reclaimSandbox` above only touches the cluster pod
        // + PVC, and the k8s backstop sweep only reclaims PVCs — so nothing else
        // reaps those bytes. gc them directly here, mirroring the host `else`
        // branch. No `reaped` gate: k8s has no host clone, so the artifact dir is
        // the only thing to reclaim. Best-effort — a gc failure must not fail the
        // cancel response.
        try {
          await artifactStore.gc(storedTaskId);
        } catch (err) {
          log.warn("Cancel: artifact gc failed", { taskId: storedTaskId, err });
        }
      } else {
        reaped = reapSandboxWorkspace({
          taskId: storedTaskId,
          stateDir: config.stateDir,
          sandboxDir: getRuntimeConfig()?.sandboxDir,
        }).removed;
        // GC the artifact-store namespace too (Plan 8), same "only when the
        // workspace dir actually went away" rule as reapOnSuccess (simple.ts)
        // — redundant with the rmSync above for the local backend, but the
        // hook a future S3 backend needs. Cancel is a full-run abort (not a
        // per-phase dispose), so this can never race a still-in-flight
        // post-review the way an eager dispose-time gc would.
        if (reaped) {
          try {
            await artifactStore.gc(storedTaskId);
          } catch (err) {
            log.warn("Cancel: artifact gc failed", { taskId: storedTaskId, err });
          }
        }
      }
    }
    await recordActivityFor(c, db, {
      action: "workflow.cancel",
      targetType: "workflow_run",
      targetId: id,
      // The COUNT, not the names — `detail` is a summary, not a payload.
      detail: { workflow: run.workflowName, killedContainers: killed.length },
    });
    return c.json({ cancelled: id, killedContainers: killed, reapedWorkspace: reaped });
  });

  // Retry a FAILED or CANCELLED workflow run — resume from where it stopped with
  // the same context. `cancelled` covers a queue-drop after a server death and a
  // manual cancel, both recoverable; the callback flips the row →running
  // (compare-and-set) and re-dispatches via the same ledger-driven resume path
  // the boot-recovery sweep uses. Sits under the `authMiddleware` guard above,
  // like cancel/respond.
  app.post("/workflow-runs/:id/retry", async (c) => {
    const id = c.req.param("id");
    const run = await db.runs.getRun(id);
    if (!run) return c.json({ error: "workflow run not found" }, 404);
    if (run.status !== "failed" && run.status !== "cancelled") {
      return c.json({ error: `cannot retry a run with status '${run.status}'` }, 400);
    }
    if (!config.retryWorkflow) {
      return c.json({ error: "retry not available (runner not wired)" }, 503);
    }
    // Fire-and-forget: restartRun (inside the callback) flips status→running
    // atomically, so a second immediate retry click 400s on the status guard.
    config.retryWorkflow(run, actorFromContext(c) ?? "admin").catch((err) =>
      log.error("Retry failed", { id, err }));
    await recordActivityFor(c, db, {
      action: "workflow.retry",
      targetType: "workflow_run",
      targetId: id,
      detail: { workflow: run.workflowName, from: run.status },
    });
    return c.json({ retrying: id });
  });

  // ── Workflow definitions ─────────────────────────────────────────
  //
  // The dashboard's pipeline visualisation fetches definitions from here so
  // it can render exactly the phases the YAML file declares — including
  // user-defined custom workflows. No hardcoded phase list, no fallback.

  // List all agent workflows for the dashboard's Workflows browser.
  app.get("/workflows", async (c) => {
    const defs = listAgentWorkflows();
    const overrides = await db.getAllWorkflowOverrides();
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
  app.get("/workflows/:name/full", async (c) => {
    const name = c.req.param("name");
    try {
      const def = getWorkflow(name);
      return c.json({
        workflow: def,
        triggers: getWorkflowTriggers(name),
        enabled: await db.isWorkflowEnabled(name),
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
    const current = await db.isWorkflowEnabled(name);
    const next = !current;
    // `?? "admin"` matches cancel/retry/respond: the column is an existing wire
    // contract the dashboard renders, so it keeps its literal fallback. The
    // activity row does NOT — see recordActivityFor.
    await db.setWorkflowEnabled(name, next, actorFromContext(c) ?? "admin");
    await recordActivityFor(c, db, {
      action: "workflow.toggle",
      targetType: "workflow",
      targetId: name,
      detail: { enabled: next },
    });
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
    // The row IS the pair (issue #279) — `owner` plus a bare `repo`, normalized
    // by the store on the way in and on the way out. `context.owner` stays as
    // the fallback for a row whose owner column was never captured.
    const repo = run.repo;
    const owner = repo ? run.owner ?? ctxOwner : undefined;
    const issueKey = buildAssetIssueKey(run.workflowName, run.issueNumber, run.id);
    return { owner, repo, issueKey, branch };
  }

  function runMatchesArtifactTarget(run: WorkflowRun | null, owner: string, repo: string, key: string): boolean {
    if (!run) return false;
    const { owner: runOwner, repo: runRepo, issueKey } = ownerRepoForRun(run);
    if (!runOwner || !runRepo || !issueKey) return false;
    return runOwner === owner && runRepo === repo && issueKey === key;
  }

  async function computeArtifactMetadata(owner: string, repo: string, key: string, doc: string): Promise<ArtifactMetadata> {
    const approvals = await db.approvals.listByArtifact(doc);
    if (approvals.length === 0) {
      // No approval references this artifact. Docs that aren't guarded by an
      // approval remain editable (status.md, executor-summary.md, etc.).
      return { editable: true, lock: null };
    }

    // Sequential on purpose: one run lookup per approval, in the store's order,
    // rather than fanning N reads at the DB at once.
    const enriched: { approval: WorkflowApproval; run: WorkflowRun | null }[] = [];
    for (const approval of approvals) {
      enriched.push({ approval, run: await db.runs.getRun(approval.workflowRunId) });
    }

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

  // Repo-centric index for the dashboard's Repos tab: the union of the
  // effective managed repos and every repo that has workflow-run activity (or
  // stored artifacts), each annotated with its run count / last-activity /
  // artifact-key count. Managed repos with no activity are included so the tab
  // shows the full fleet; ordered newest-activity first, then name. Read-only —
  // the server keeps returning global data (see issue #169).
  /**
   * The pipeline board — every open issue and pull request in scope, filed
   * under the stage label it carries.
   *
   * Read-only, and thin on purpose: scope resolution here, the GitHub read in
   * `board-cache.ts`, the projection in `board.ts`. It therefore records no
   * activity — `recordActivityFor` is for USER-INITIATED mutations, and a
   * dashboard polling every twenty seconds would drown the audit stream.
   *
   * **Three queries, whatever the card count — plus two CONDITIONAL ledger
   * reads**: one when a card has failed (the reason a FAILED band owes the
   * reader) and one when a card is live (the phase it is actually running,
   * which `current_phase` lags by one). Both are O(1) in cards and both are
   * skipped entirely when no card needs them. The cached items, ONE
   * `latestForTriggers` over every card's trigger id, and ONE `listPending()`.
   * A per-card run lookup would be fifty statements to render one screen.
   */
  app.get("/board", async (c) => {
    const autonomy = getAutonomyConfig();
    const stages: BoardStage[] = Object.entries(autonomy.stages).map(([id, stage]) => ({
      id,
      enter: stage.enter,
      running: stage.running,
      on_success: stage.on_success,
      on_failure: stage.on_failure,
    }));

    const managedSet = new Set(getManagedRepos());

    // ── The board's universe is the AUTONOMY ALLOW-LIST, not the managed list ──
    //
    // This board is a view of ONE pipeline, and `autonomy.repos` is what decides
    // which repos have one. A managed repo that is not on the list has no stage
    // labels anybody writes, no `build` the gate would admit, and every action
    // offered on its cards answers `409 not-autonomous` — because the card
    // actions cross the real dispatch gate, which checks exactly this list. So
    // showing those repos renders columns and menus for work that structurally
    // cannot run, and pays a live GitHub read per repo to do it.
    //
    // Intersected with the managed set rather than trusted outright: the two are
    // configured independently, and a repo named in `autonomy.repos` that the
    // App cannot see is a typo, not a target.
    const eligible = new Set(autonomy.repos.filter((r) => managedSet.has(r)));

    // Scope, in precedence order. Each step narrows to `eligible`.
    const requested = (c.req.query("repos") || "")
      .split(",")
      .map((r) => r.trim())
      .filter(Boolean);

    let candidates: string[];
    let reason: string;
    if (requested.length > 0) {
      candidates = requested.filter((r) => eligible.has(r));
      reason = "the repos you asked for";
    } else {
      // The same call `/me/repos` makes. `repos: null` is its fail-open
      // sentinel — no GitHub identity, the feature off, a team too large — and
      // it means "no filter", never "no access".
      const visible = await teamVisibility.visibleRepos(actorFromContext(c));
      if (visible.repos) {
        candidates = visible.repos.filter((r) => eligible.has(r));
        reason = "the autonomous repos your GitHub teams can see";
      } else {
        // EVERY eligible repo, ordered by activity — not `distinctRepos()`
        // filtered down to the eligible ones. Those are different answers: a
        // repo added to `autonomy.repos` this morning has no runs yet, so the
        // filtered form would hide it on the one day somebody most wants to
        // watch it start. Activity ORDERS the list so the truncation below
        // keeps the repos somebody is working in; the tail is the rest of the
        // allow-list, which is small by construction.
        const active = await db.runs.distinctRepos();
        const ordered: string[] = [];
        const seen = new Set<string>();
        for (const { repo } of active) {
          if (eligible.has(repo) && !seen.has(repo)) {
            seen.add(repo);
            ordered.push(repo);
          }
        }
        for (const repo of eligible) if (!seen.has(repo)) ordered.push(repo);
        candidates = ordered;
        reason = "the repos on the autonomy allow-list";
      }
    }

    // Said plainly, because an empty board with no explanation reads as broken
    // rather than as un-opted-in — and `autonomy.repos: []` is the shipped
    // default, so this is what a fresh install sees.
    if (eligible.size === 0) reason = "no repos are on the autonomy allow-list";

    const truncated = candidates.length > MAX_BOARD_REPOS;
    const scope = {
      repos: candidates.slice(0, MAX_BOARD_REPOS),
      // Everything the board COULD show, so the UI's scope picker offers only
      // repos that can actually appear. Sorted for a stable dropdown.
      eligible: [...eligible].sort(),
      truncated,
      reason: truncated
        ? `showing ${MAX_BOARD_REPOS} of ${candidates.length} — ${reason}`
        : reason,
    };

    const base = { generatedAt: new Date().toISOString(), ttlSeconds: BOARD_TTL_MS / 1000, scope };

    // Not configured: no columns, and — the point of checking here — no GitHub
    // reads at all. A deployment that has not opted into the pipeline pays
    // nothing for the tab existing.
    if (stages.length === 0) {
      return c.json({ ...base, configured: false, degraded: [], columns: [] });
    }

    // No eligible repos: render the (empty) columns and touch GitHub not at all.
    // Same argument as the `configured: false` early return above — a deployment
    // that has not opted a repo in pays nothing for the tab existing.
    if (scope.repos.length === 0) {
      return c.json(
        buildBoard(
          {
            items: [],
            runs: new Map(),
            approvals: [],
            stages,
            holdLabel: getHoldLabel(),
            scope,
            degraded: [],
            generatedAt: base.generatedAt,
            ttlSeconds: base.ttlSeconds,
          },
          { unstaged: c.req.query("unstaged") === "1" },
        ),
      );
    }

    if (!config.github) {
      return c.json({
        ...base,
        configured: true,
        degraded: scope.repos.map((repo) => ({ repo, error: "No GitHub client is configured." })),
        columns: [],
      });
    }

    const { items, degraded } = await getBoardItems(scope.repos, {
      github: config.github,
      force: c.req.query("refresh") === "1",
    });

    const runs = await db.runs.latestForTriggers(
      items.map((item) => issueTriggerId(item.repo, item.number)),
    );
    const pending = await db.approvals.listPending();

    // The fourth statement, and only when something failed. `workflow_runs` has
    // no error column, so a FAILED card's reason comes from the ledger row of
    // the phase that stopped it. Batched, so it stays O(1) in cards — the
    // property the header's claim is really about — and a board with nothing
    // failing pays nothing for it.
    const failedRunIds = [...runs.values()]
      .filter((run) => run.status === "failed")
      .map((run) => run.id);
    const failures =
      failedRunIds.length > 0
        ? await db.executions.failureReasonsForRuns(failedRunIds)
        : undefined;

    // And the fifth, on the same terms: what each LIVE run is running right
    // now. `workflow_runs.current_phase` is written on phase COMPLETION, so it
    // lags by one — a run on `executor` reads `architect`. The ledger knows,
    // because an in-flight phase is the row with no `finished_at`.
    const activeRunIds = [...runs.values()]
      .filter((run) => run.status === "queued" || run.status === "running" || run.status === "paused")
      .map((run) => run.id);
    const inFlight =
      activeRunIds.length > 0
        ? await db.executions.inFlightPhasesForRuns(activeRunIds)
        : undefined;

    return c.json(
      buildBoard(
        {
          items,
          runs,
          approvals: pending,
          ...(failures ? { failures } : {}),
          ...(inFlight ? { inFlight } : {}),
          stages,
          holdLabel: getHoldLabel(),
          scope,
          degraded: degraded as BoardDegradation[],
          generatedAt: base.generatedAt,
          ttlSeconds: base.ttlSeconds,
        },
        { unstaged: c.req.query("unstaged") === "1" },
      ),
    );
  });

  /**
   * `GET /board/stream` — the board's change stream.
   *
   * Push-only-on-change, modelled line for line on the session-list stream
   * above. What it pushes is a SIGNAL and never the board: see
   * `admin/board-stream.ts` for why that distinction is load-bearing rather
   * than an optimisation.
   *
   * Auth needs nothing special — `authMiddleware` is mounted at `/*` and
   * already accepts `?token=`, because `EventSource` cannot set headers.
   */
  app.get("/board/stream", (c) => {
    return streamSSE(c, async (stream) => {
      let prev: string | null = null; // null = nothing sent yet
      let lastBeat = Date.now();
      let stopped = false;

      stream.onAbort(() => {
        stopped = true;
      });

      const push = async () => {
        const revision = await boardSignature(db);
        const now = Date.now();
        const changed = revision !== prev;
        // The heartbeat is not decoration here — see BOARD_HEARTBEAT_MS.
        if (!changed && now - lastBeat < BOARD_HEARTBEAT_MS) return;
        prev = revision;
        lastBeat = now;
        await stream.writeSSE({
          event: "board",
          data: JSON.stringify({ revision, changed, at: new Date(now).toISOString() }),
        });
      };

      // The handshake frame: `prev` is null, so this always sends. It is what
      // tells the client the stream is live, and the client skips it rather
      // than treating it as news.
      await push();
      while (!stopped) {
        await stream.sleep(BOARD_TICK_MS);
        if (stopped) break;
        await push();
      }
    });
  });

  app.get("/repos", async (c) => {
    const managed = new Set(getManagedRepos());
    const activity = new Map(
      (await db.runs.distinctRepos()).map((r) => [r.repo, r]),
    );

    // Fold in artifact-key counts (bounded scan — the tab is a browse view, not
    // a report). A repo may have artifacts but no runs, so union it in too.
    const artifactCounts = new Map<string, number>();
    if (buildAssetStore) {
      try {
        const { repos } = await buildAssetStore.listRepos({ limit: 200 });
        for (const r of repos) artifactCounts.set(r.slug, r.keyCount);
      } catch {
        /* store optional — degrade to run activity only */
      }
    }

    const names = new Set<string>([
      ...managed,
      ...activity.keys(),
      ...artifactCounts.keys(),
    ]);

    const repos = [...names]
      .map((repo) => ({
        repo,
        managed: managed.has(repo),
        runCount: activity.get(repo)?.runCount ?? 0,
        lastRunAt: activity.get(repo)?.lastRunAt ?? null,
        artifactKeyCount: artifactCounts.get(repo) ?? 0,
        // Cache-only (no network) so the index stays cheap — it just makes the
        // per-repo Config tab discoverable. False here means "nothing cached
        // yet", not "no .lastlight/"; opening the tab settles it.
        hasRepoConfig: Boolean(getCachedRepoLayer(repo)),
      }))
      .sort((a, b) => {
        // Newest activity first; repos with no runs sink below active ones,
        // then break ties alphabetically for a stable order.
        if (a.lastRunAt && b.lastRunAt) return a.lastRunAt < b.lastRunAt ? 1 : -1;
        if (a.lastRunAt) return -1;
        if (b.lastRunAt) return 1;
        return a.repo < b.repo ? -1 : 1;
      });

    return c.json({ repos });
  });

  /**
   * The prompts / skills / agent-context a repo's `.lastlight/` contributes,
   * each tagged with whether it shadows something the instance already has.
   *
   * A repo layer's unpacked root mirrors an overlay root exactly, so this is
   * the same enumerator `GET /overrides`, `lastlight fork` and `server status`
   * use — pointed at the repo's tree instead. It's run twice because a repo
   * asset can shadow either a built-in OR an overlay fork, and "shadows" should
   * mean "replaces something that was already in force".
   */
  function repoLayerAssets(root: string) {
    const assets = enumerateOverlayAssets({ coreRoot: config.builtInRoot, overlayRoot: root });
    const shadowsOverlay = new Set(
      enumerateOverlayAssets({ coreRoot: config.overlayDir, overlayRoot: root })
        .filter((a) => a.shadowsDefault)
        .map((a) => `${a.type}:${a.name}`),
    );
    return assets.map((a) => ({
      ...a,
      shadowsDefault: a.shadowsDefault || shadowsOverlay.has(`${a.type}:${a.name}`),
    }));
  }

  // The effective config for ONE repo — the instance layers with that repo's
  // committed `.lastlight/` applied on top, within the operator's `repoConfig`
  // bounds (issue #180). Powers the Repos → Config tab and `lastlight repo
  // config show`.
  //
  // A repo with no `.lastlight/` is a perfectly normal 200: `repoLayer` is
  // absent and `merged`/`sources` are simply the inherited instance config.
  // That's the whole point of the view — "what does Last Light actually do for
  // this repo", not "does this repo have a config file".
  //
  // `?refresh=1` bypasses the 60s TTL (the operator has just merged a
  // `.lastlight/` change and doesn't want to wait it out).
  app.get("/repos/:owner/:repo/config", async (c) => {
    const { owner, repo: name } = c.req.param();
    const repo = `${owner}/${name}`;
    // Same allowlist that gates every other repo-touching path. Without it this
    // endpoint would be an unauthenticated-by-proxy way to make the harness
    // fetch from an arbitrary repo.
    if (!isManagedRepo(repo)) {
      return c.json({ error: `${repo} is not a managed repository` }, 404);
    }
    const runtime = getRuntimeConfig();
    if (!runtime) return c.json({ error: "Runtime config is not loaded" }, 503);

    const policy = repoConfigPolicy();
    const refresh = c.req.query("refresh");
    const force = refresh === "1" || refresh === "true";
    // Both calls degrade to `undefined` rather than throwing — a GitHub failure
    // must not turn this read-only view into a 500.
    const layer = force
      ? await refreshRepoLayer(repo, { policy })
      : await fetchRepoLayer(repo, { policy });

    const { merged, sources, warnings } = resolveRepoConfig(
      repoConfigBaseFromRuntime(runtime),
      policy,
      layer,
    );

    return c.json({
      repo,
      merged: redactPublic(merged),
      sources,
      // RAW and pre-validation on purpose: the repo needs to see what it wrote
      // next to the warnings explaining what was dropped. Redacted, since this
      // is untrusted YAML.
      repoLayer: layer?.config ? redactPublic(layer.config) : undefined,
      warnings,
      assets: layer ? repoLayerAssets(layer.root) : [],
      policy,
      fetchedAt: layer?.fetchedAt ?? null,
      treeSha: layer?.treeSha ?? null,
      defaultBranch: layer?.defaultBranch ?? null,
    });
  });

  // List the repos that actually have stored artifacts (search + paginate).
  // This replaces the old config-driven repo picker, which showed nothing when
  // `managedRepos` was empty even though the store held artifacts.
  app.get("/artifact-repos", async (c) => {
    if (!buildAssetStore) return c.json({ repos: [], total: 0 });
    const q = c.req.query("q") || undefined;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    try {
      return c.json(await buildAssetStore.listRepos({ q, limit, offset }));
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // List the run keys (issue-N / <workflow>-<id>) stored for ?repo=owner/repo,
  // newest first, with per-run age. Filterable by `?since=` (ISO, mirrors
  // /workflow-runs) and `?q=`, paginated by `?limit=`/`?offset=`.
  app.get("/artifacts", async (c) => {
    const repoParam = c.req.query("repo");
    if (!repoParam || !repoParam.includes("/")) {
      return c.json({ error: "missing or invalid ?repo=owner/repo" }, 400);
    }
    if (!buildAssetStore) return c.json({ keys: [], total: 0 });
    const [owner, repo] = repoParam.split("/", 2);
    const q = c.req.query("q") || undefined;
    const sinceRaw = c.req.query("since");
    const sinceMs = sinceRaw ? Date.parse(sinceRaw) : NaN;
    const limit = Math.min(Math.max(parseInt(c.req.query("limit") ?? "50", 10) || 50, 1), 200);
    const offset = Math.max(parseInt(c.req.query("offset") ?? "0", 10) || 0, 0);
    try {
      return c.json(
        await buildAssetStore.listKeysDetailed(owner, repo, {
          q,
          sinceMs: Number.isNaN(sinceMs) ? undefined : sinceMs,
          limit,
          offset,
        }),
      );
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

  app.get("/artifacts/:owner/:repo/:key/:doc/metadata", async (c) => {
    if (!buildAssetStore) return c.json({ error: "build-assets store not configured" }, 404);
    const { owner, repo, key, doc } = c.req.param();
    try {
      // Validate the doc path upfront so traversal attempts surface as 400s.
      buildAssetStore.fileFor({ owner, repo, issueKey: key }, doc);
      const metadata = await computeArtifactMetadata(owner, repo, key, doc);
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
      const metadata = await computeArtifactMetadata(owner, repo, key, doc);
      if (!metadata.editable) {
        // A refused edit is worth a row: the approval lock is exactly the kind
        // of guard someone later asks "did anyone try to get around this?".
        await recordActivityFor(c, db, {
          action: "artifact.edit",
          targetType: "repo",
          targetId: `${owner}/${repo}`,
          outcome: "denied",
          detail: { key, doc, reason: "artifact_locked" },
        });
        return c.json({ error: "artifact_locked", lock: metadata.lock }, 403);
      }
      const body = await c.req.text();
      buildAssetStore.write({ owner, repo, issueKey: key }, doc, body);
      await recordActivityFor(c, db, {
        action: "artifact.edit",
        targetType: "repo",
        targetId: `${owner}/${repo}`,
        detail: { key, doc, bytes: body.length },
      });
      return c.json({ ok: true });
    } catch (err: unknown) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── Approval Gates ─────────────────────────────────────────────

  app.get("/approvals", async (c) => {
    const approvals = await db.approvals.listPending();
    return c.json({ approvals });
  });

  // Single approval, enriched with an `artifactRef` the focused approval view
  // uses to open the right doc. `artifactRef` is null when the gate carries no
  // artifact. In server mode the ref points at the editable store doc; in repo
  // mode it carries a GitHub blob URL (the doc is committed on the branch).
  app.get("/approvals/:id", async (c) => {
    const approval = await db.approvals.getById(c.req.param("id"));
    if (!approval) return c.json({ error: "approval not found" }, 404);
    const run = await db.runs.getRun(approval.workflowRunId);

    let artifactRef: {
      mode: BuildAssetsLocation;
      owner: string;
      repo: string;
      issueKey: string;
      doc: string;
      githubUrl?: string;
    } | null = null;

    if (approval.artifact && run && run.repo) {
      // The row is the (owner, BARE repo) pair (issue #279); `context.owner` is
      // the fallback for a row whose owner column was never captured.
      const ctx = run.context ?? {};
      const ctxOwner = typeof ctx.owner === "string" ? ctx.owner : undefined;
      const repo = run.repo;
      const owner = run.owner ?? ctxOwner ?? "";
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
    const approval = await db.approvals.getById(id);
    if (!approval) return c.json({ error: "approval not found" }, 404);
    if (approval.status !== "pending") return c.json({ error: `already ${approval.status}` }, 400);
    // Actor logging (issue #205): attribute the approval to the authenticated
    // user, falling back to `admin` for password/anonymous sessions.
    const actor = actorFromContext(c) ?? "admin";
    if (body.decision === "rejected") {
      // One transaction: respond 'rejected' + fail the run.
      await db.runs.resolveGateAndFail(id, actor, body.reason);
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
      const changed = await db.approvals.respond(id, "approved", actor, body.reason);
      if (changed !== 1) {
        return c.json({ error: "already resolved" }, 409);
      }
      const workflowRun = await db.runs.getRun(approval.workflowRunId);
      if (workflowRun && config.resumeWorkflow) {
        config.resumeWorkflow(workflowRun, actor).catch((err) => {
          log.error("Failed to resume workflow", { workflowRunId: workflowRun.id, err });
        });
      }
    }
    await recordActivityFor(c, db, {
      action: body.decision === "rejected" ? "approval.reject" : "approval.approve",
      targetType: "approval",
      targetId: id,
      detail: {
        gate: approval.gate,
        workflowRunId: approval.workflowRunId,
        ...(body.reason ? { reason: body.reason } : {}),
      },
    });
    return c.json({ status: body.decision });
  });

  // ── Crons ──────────────────────────────────────────────────────

  /**
   * The context a cron tick carries, built exactly as `src/cron/jobs.ts` builds
   * it at boot — including the two control keys the fan-out consumes
   * (`_cronName`, `_cronGloballyEnabled`) and strips before dispatch.
   *
   * They are not optional decoration. `_cronName` is the ONLY channel by which
   * the tick learns which cron it is (several crons can share one workflow), so
   * a context without it makes `resolveCronRepos` a no-op and the tick ignores
   * every repo's `.lastlight/` cron opt-out. These routes re-register jobs at
   * runtime, so a context built here that omitted them would silently drop
   * per-repo participation until the next restart re-registered from `jobs.ts` —
   * the worst kind of bug, one that fixes itself while you're looking at it.
   */
  const cronContext = (
    def: { name: string; context?: Record<string, unknown> },
    globallyEnabled: boolean,
  ): Record<string, unknown> => ({
    repos: getManagedRepos(),
    // Spread ahead of the control keys, deliberately: a cron YAML MAY pin its
    // own `context.repos`. It may NOT pin the control keys — those are injected
    // after it, so operator YAML can't spoof the cron's identity or its
    // globally-enabled state (same ordering as `jobs.ts`).
    ...def.context,
    [CRON_NAME_KEY]: def.name,
    [CRON_GLOBALLY_ENABLED_KEY]: globallyEnabled,
  });

  /**
   * The managed repos that have opted INTO one cron from their own
   * `.lastlight/lastlight.yml` (`crons: { enable: [...] }`).
   *
   * Why the list endpoint needs this at all: a globally-OFF cron still keeps its
   * scheduler tick (see the toggle route below), so it reports a real
   * `registered`/`nextRun`. Without naming the repos that opted in, the dashboard
   * shows "next run in 20m" beside an off switch and the operator can't tell
   * whether that's a real firing or a leftover timer. With them, the two
   * disabled cases are distinguishable: nobody opted in → the tick is a no-op and
   * the UI can honestly say "—"; somebody did → the cron genuinely runs, for
   * exactly these repos.
   *
   * CACHE-ONLY, deliberately. `GET /crons` is a list endpoint polled every 10s by
   * the dashboard; resolving this the way a tick does (`resolveCronRepos`, which
   * falls through to `fetchRepoLayer`) would turn one page load into
   * crons × repos conditional GitHub requests. A repo with no cached layer is
   * simply not counted — the display is then merely conservative (it under-reports
   * an opt-in until the next tick warms the cache), never wrong about a repo it
   * does name.
   */
  const optedInRepos = (
    cron: string,
    repos: readonly string[],
    policy: RepoConfigPolicy,
  ): string[] =>
    repos.filter(
      (repo) => cronVote(cron, repoCronPrefs(getCachedRepoLayer(repo)?.config, policy)) === "enable",
    );

  // List every cron defined in workflows/cron-*.yaml, merged with the
  // override row (if any) and the live scheduler state.
  app.get("/crons", async (c) => {
    const overrides = await db.getAllCronOverrides();
    const liveByName = new Map(
      (config.cronScheduler?.list() ?? []).map((j) => [j.name, j]),
    );
    const defs = getCronWorkflows();
    const managedRepos = getManagedRepos();
    // The operator's kill switch (repo-config off, or `crons` dropped from
    // `allowKeys`) means no repo can opt into anything — short-circuit to zero
    // cache lookups rather than asking each repo a question with one answer.
    const policy = repoConfigPolicy();
    const mayVote = repoLayerMayVote(policy);
    // One query for the whole list rather than one per cron, under the
    // dashboard's 10s poll.
    const latestCronRuns = await db.cronRuns.latestByCron();
    // Same rule for the failure counts, hoisted out of the map below for the
    // same reason: the store exposes no batch form of `recentFailures`, so this
    // is a sequential walk rather than N reads fanned at the DB at once from
    // inside the render loop.
    const failuresByCron = new Map<string, number>();
    for (const def of defs) {
      failuresByCron.set(def.name, await db.cronRuns.recentFailures(def.name));
    }
    const crons = defs.map((def) => {
      const override = overrides.get(def.name) ?? null;
      const enabled = override ? override.enabled : true;
      const live = liveByName.get(def.name) ?? null;
      // Both kinds of cron answer from the `executions` ledger, keyed
      // differently: a workflow cron's rows are written per phase under the
      // WORKFLOW name, a handler cron's per tick under the CRON name (by
      // `withLedger` in `cron/handlers.ts`). This used to report a hardcoded
      // `0 / null` for handler crons, so the dashboard showed a healthy-looking
      // zero beside a cron that could have been failing for weeks.
      // ONE ledger, keyed on the cron's own name, for both kinds of cron —
      // which is why there is no longer a branch here. The old workflow-cron
      // path read `db.runs.listRecent(50)` and showed whichever of the tick's
      // dispatched children sorted first: an arbitrary run, not the tick. A
      // zero-discovery fire dispatched no children at all, so it showed nothing.
      const last = latestCronRuns.get(def.name) ?? null;
      const recentFailures = failuresByCron.get(def.name) ?? 0;
      return {
        name: def.name,
        workflow: def.workflow ?? null,
        handler: def.handler ?? null,
        schedule: override?.schedule ?? def.schedule,
        originalSchedule: def.schedule,
        enabled,
        registered: !!live,
        nextRun: live?.nextRun?.toISOString() ?? null,
        lastRun: last?.startedAt ?? null,
        lastStatus: last?.status ?? null,
        recentFailures,
        reposEligible: last?.reposEligible ?? null,
        reposScanned: last?.reposScanned ?? null,
        discovered: last?.discovered ?? null,
        dispatched: last?.dispatched ?? null,
        optedInRepos: mayVote ? optedInRepos(def.name, managedRepos, policy) : [],
        context: { repos: managedRepos, ...def.context },
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
    const override = await db.getCronOverride(name);
    const currentlyEnabled = override ? override.enabled : true;
    const nextEnabled = !currentlyEnabled;
    await db.setCronOverride(name, {
      enabled: nextEnabled,
      updatedBy: actorFromContext(c) ?? "admin",
    });
    await recordActivityFor(c, db, {
      action: "cron.toggle",
      targetType: "cron",
      targetId: name,
      detail: { enabled: nextEnabled },
    });
    // Off is "off BY DEFAULT", not "unregistered" (issue #180): a managed repo
    // may opt itself back into a globally-off cron from its `.lastlight/`, and
    // that is resolved at TICK time — so the tick has to keep running. It just
    // carries `_cronGloballyEnabled: false`, which narrows the fan-out to the
    // repos that opted in (usually none, making it a cheap no-op tick). This
    // mirrors `jobs.ts`, which registers a globally-off cron the same way at
    // boot; unregistering here instead would make an opt-in do nothing until
    // the next restart, and then quietly start working.
    const schedule = override?.schedule || def.schedule;
    const job = {
      name,
      schedule,
      workflow: def.workflow,
      context: cronContext(def, nextEnabled),
    };
    if (config.cronScheduler.has(name)) {
      config.cronScheduler.update(job);
    } else {
      config.cronScheduler.register(job);
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
    await db.setCronOverride(name, { schedule, updatedBy: actorFromContext(c) ?? "admin" });
    await recordActivityFor(c, db, {
      action: "config.edit",
      targetType: "cron",
      targetId: name,
      detail: { schedule },
    });
    const override = await db.getCronOverride(name);
    if (override?.enabled !== false) {
      config.cronScheduler.update({
        name,
        schedule,
        workflow: def.workflow,
        context: cronContext(def, true),
      });
    }
    return c.json({ name, schedule });
  });

  // Drop the override row and re-register the cron at its YAML default.
  app.delete("/crons/:name/override", async (c) => {
    if (!config.cronScheduler) {
      return c.json({ error: "cron scheduler not configured" }, 503);
    }
    const name = c.req.param("name");
    const def = getCronWorkflows().find((d) => d.name === name);
    if (!def) return c.json({ error: `cron not found: ${name}` }, 404);
    await db.clearCronOverride(name);
    await recordActivityFor(c, db, {
      action: "config.edit",
      targetType: "cron",
      targetId: name,
      detail: { cleared: true, schedule: def.schedule },
    });
    const job = {
      name,
      schedule: def.schedule,
      workflow: def.workflow,
      // Dropping the override returns the cron to its YAML default, which is
      // globally on.
      context: cronContext(def, true),
    };
    if (config.cronScheduler.has(name)) {
      config.cronScheduler.update(job);
    } else {
      config.cronScheduler.register(job);
    }
    return c.json({ name, schedule: def.schedule, enabled: true });
  });

  // Fire a cron now, on demand (dashboard "Run now" / `lastlight cron trigger`).
  // Fire-and-forget: a cron fans out one bounded workflow run per repo/PR, which
  // can take minutes, so we return immediately and let it run in the background.
  // Goes through the runner (not the scheduler's registered-job map), so it works
  // even for crons that aren't registered — disabled ones, or the polling crons
  // dropped when webhooks are live — which is exactly what manual testing needs.
  // Bypasses the scheduler's per-job overlap guard (acceptable for a manual fire).
  app.post("/crons/:name/trigger", async (c) => {
    const name = c.req.param("name");
    const def = getCronWorkflows().find((d) => d.name === name);
    if (!def) return c.json({ error: `cron not found: ${name}` }, 404);
    // A `handler:` cron runs host-side code rather than dispatching a workflow,
    // so it needs the other collaborator. Both are absent in the CLI-only /
    // test harnesses, hence the per-path 503.
    if (def.handler ? !config.runCronHandler : !config.triggerCron) {
      return c.json({ error: "cron trigger not configured" }, 503);
    }
    // Same context shape the scheduler + toggle handler build, plus the
    // acting user (issue #205) so a manually-fired cron attributes to the
    // person who clicked "Run now" rather than the anonymous scheduler.
    // `dispatchWorkflow` destructures `sender` for free.
    //
    // `_cronName` is carried so a manual fire honours the same per-repo
    // participation a scheduled tick does — a repo that opted out of this cron
    // in its `.lastlight/` stays out, however the tick was started. What is
    // deliberately NOT carried is `_cronGloballyEnabled`: absent means "on", so
    // "Run now" keeps working for a cron that is globally disabled, which is
    // exactly what the button is for.
    //
    // Which is why the YAML's own context is spread ahead of `_cronName` AND has
    // `_cronGloballyEnabled` stripped out of it first: here absence is the
    // signal, so simply re-injecting the key after the spread would defeat the
    // button. A cron YAML pinning `context.repos` still overrides the managed
    // list, as everywhere else.
    const { [CRON_GLOBALLY_ENABLED_KEY]: _yamlEnabled, ...defContext } = def.context ?? {};
    const actor = actorFromContext(c);
    const context = {
      repos: getManagedRepos(),
      ...defContext,
      // Injected LAST, same rule as `jobs.ts` and for the same reason: operator
      // YAML must not be able to spoof any of these. `_cronSource` decides
      // whether the ledger records this fire as a human pressing "Run now" or
      // as the scheduler, and `_cronActor` is who to attribute it to.
      [CRON_NAME_KEY]: def.name,
      _cronSource: "manual",
      _cronActor: actor ?? null,
      // …and HOW they authenticated. Without this the fire's own activity row
      // could only guess, and guessed `admin` — so a GitHub-authenticated
      // "Run now" wrote `cron.trigger` as `github` and its paired `cron.fire`
      // as `admin`, two rows for one action disagreeing about the same person.
      _cronActorType: actorTypeFromContext(c) ?? null,
      sender: actor,
    };
    const fire = def.handler
      ? config.runCronHandler!(def.handler, context)
      : config.triggerCron!(def.workflow!, context);
    fire.catch((err) => {
      log.error("Cron trigger failed", { name, err });
    });
    // The REQUEST, not the fire — `fire` is deliberately not awaited, and the
    // fire itself writes its own `cron.fire` row from the runner. The pair is
    // the point: a trigger that never produced a fire is the interesting case.
    await recordActivityFor(c, db, {
      action: "cron.trigger",
      targetType: "cron",
      targetId: name,
      detail: def.handler ? { handler: def.handler } : { workflow: def.workflow ?? "" },
    });
    return c.json({ name, workflow: def.workflow, handler: def.handler, triggered: true });
  });

  // ── Un-stick a pull request — the third retry surface ─────────────────────
  //
  // EXTRACTED from the route below so the pipeline board's card actions reach
  // this exact path rather than growing a second one. The board offers "Retry
  // run" on a PR card; had that posted somewhere new, `resolvePrState` +
  // `applyPrDispatchGate` would have acquired a second caller free to resolve a
  // different snapshot or skip a branch — which is the drift the PR gate's
  // copies already caused once. One function, one decision point, two callers.
  //
  // `lastlight pr retry <owner/repo#N> [reason]` and (eventually) the dashboard.
  // The other two surfaces are a `@<bot> retry` comment and taking
  // `requires-human` off by hand; all three write the SAME record
  // (`PrState.intervention`) and re-arm through the one `sameProblem` boundary —
  // see `docs/plans/stuck-pr-recovery/03-retry-intervention.md` and
  // `spec/05-router.md` → "Un-sticking an escalated PR".
  //
  // Modelled on `cron trigger` above: the route owns the guards and the shape,
  // an injected callback owns the runner. Authorisation is the admin session
  // (the `authMiddleware` at the top of this file); `by` is that session's
  // identity, recorded for display only — per locked decision 5 no decision
  // function reads WHO asked.
  //
  // ## Why it dispatches, and why it can't just record
  //
  // `resolvePrState` + `recordIntervention` alone would persist the ask and
  // leave the next event to act on it. That is right for the comment/label
  // surfaces, which arrive ON an event that is already dispatching. It is wrong
  // here: an escalated PR is by definition one no further `check_suite` will
  // fire for, so "the next event" is the daily sweep at best and nothing at all
  // for a PR no cron covers — `lastlight pr retry` would report success and
  // change nothing anyone could see. The RECORD does survive being parked
  // (`applyDerivedState` keeps the head un-assessed until a run has served the
  // ask), which is what makes the standalone row worth writing at all; what
  // dispatching buys is the asker an answer.
  //
  // Which is why this crosses `applyPrDispatchGate` itself rather than letting
  // `dispatchWorkflow` do it: the snapshot travels down on `_prState` (it must —
  // it carries the intervention), and an inherited snapshot is exactly the signal
  // `dispatchWorkflow` reads as "this route already decided". The route that
  // resolves is the route that gates; the dispatcher does the same thing for the
  // same reason. The gate is what makes a retry NOT override the hold label, the
  // fork guard, the run lock, `upstream-broken` or a degraded read — and, on the
  // skips that are none of those, what records the standalone `retry-requested`
  // row so the ask survives to the next event.
  async function retryPullRequest(
    c: Context,
    args: { owner: string; name: string; prNumber: number; reason?: string },
  ): Promise<Response> {
    const { owner, name, prNumber, reason } = args;
    const repo = `${owner}/${name}`;
    // The same allowlist that gates every other repo-touching path. A retry must
    // not be a way to make the harness act on a repo the operator never
    // enrolled — `dispatchWorkflow` refuses it too, but that refusal happens
    // after this route has already resolved (and could have recorded) state
    // against it.
    if (!isManagedRepo(repo)) {
      return c.json({ error: `${repo} is not a managed repository` }, 403);
    }
    const github = config.github ?? null;
    if (!github || !config.dispatchWorkflow) {
      return c.json({ error: "pull-request retry is not configured" }, 503);
    }

    const by = actorFromContext(c) ?? "admin";

    // Which workflow is "go again"? The one that last worked this PR — the same
    // row `escalatePr` recorded against and the same row `resolvePrState` reads
    // its history off, so the retry lands on the workflow that actually got
    // stuck (`dependabot-ci-fix` for a dependency PR, `pr-fix` otherwise)
    // without a second GitHub read to re-derive what the router already decided
    // once. A PR we have never fixed falls back to the configured `pr_fix` route.
    const prior = await db.runs.latestForTrigger([...prFixShapedWorkflows()], prTriggerId(repo, prNumber));
    const workflowName = prior?.workflowName ?? getRoutes().github?.pr_fix ?? "pr-fix";

    const state = await resolvePrState(owner, name, prNumber, {
      github,
      db,
      botLogin: getRuntimeConfig()?.botLogin ?? "",
      botName: getBotName(),
      // Handed to the RESOLVER, never patched on afterwards: `sameProblem` reads
      // the record, so an intervention stamped onto an already-derived snapshot
      // would re-arm nothing. `at`/`atSha` are stamped in there too, so this
      // route cannot date a retry itself or key one to a head it never read.
      intervention: { via: "api", by, ...(reason ? { note: reason } : {}) },
    });

    const context = { repo, prNumber, title: state.title, _triggerType: "api" as const };
    const policy = prPolicyConfig(await config.resolveRepoPolicy?.(workflowName, context));
    const disposition = await applyPrDispatchGate(
      { workflowName, state, policy, route: "attention", logPrefix: "[admin]" },
      { db, github, botLogin: getRuntimeConfig()?.botLogin, botMention: `@${getBotName()}` },
    );

    const retry = state.intervention;
    if (disposition.decision === "skip") {
      // Three of the gate's skips deliberately record NOTHING — the hold (a
      // maintainer said stay off), a degraded read (we know nothing), and a run
      // already owning the PR (a row there would displace that run's own
      // snapshot). Those are refusals: the ask did not land, and the caller is
      // told so with a non-2xx. Every other skip already wrote the standalone
      // `retry-requested` row inside the gate, so the ask is parked and will be
      // honoured by the next event — a 200 with `dispatched: false`.
      const refused = !!(disposition.onHold || disposition.runInFlight || disposition.readDegraded);
      await recordActivityFor(c, db, {
        action: "pr.retry",
        targetType: "pr",
        targetId: `${repo}#${prNumber}`,
        // A refusal is `denied`; a parked ask that a later event will honour
        // still happened, so it is `ok` with `dispatched: false` in the detail.
        outcome: refused ? "denied" : "ok",
        detail: {
          workflow: workflowName,
          dispatched: false,
          reason: String(disposition.reason ?? "").slice(0, 200),
          ...(reason ? { note: reason } : {}),
        },
      });
      return c.json(
        {
          repo,
          prNumber,
          workflow: workflowName,
          dispatched: false,
          recorded: !refused,
          ...(refused ? {} : { retry }),
          // The hold is the one skip that owes a human a sentence rather than a
          // reason string, and it is the SAME sentence the comment route gives.
          reason: disposition.onHold ? holdReply(disposition.onHold.label) : disposition.reason,
          ...(disposition.onHold ? { held: disposition.onHold.label } : {}),
        },
        refused ? 409 : 200,
      );
    }

    // Fire-and-forget, exactly like `cron trigger` and `/api/run`: a fix run
    // takes minutes. `_prState` carries the armed snapshot down so the run
    // persists the intervention on its own `context.prState` — which is where
    // the record normally lives, and why no standalone row is written here.
    log.info("retry", { workflow: workflowName, repo, prNumber, by, reason: disposition.reason });
    config.dispatchWorkflow(workflowName, {
      ...context,
      body: state.body,
      _prState: state,
      sender: by,
      triggeredBy: by,
    }).catch((err: unknown) => {
      log.error("retry failed", { workflow: workflowName, repo, prNumber, err });
    });

    // The ASK. The run it starts writes its own `workflow.trigger` row from
    // `dispatchWorkflow` — the same request/execution pair as cron.trigger and
    // cron.fire, and worth keeping distinct because the two can disagree.
    await recordActivityFor(c, db, {
      action: "pr.retry",
      targetType: "pr",
      targetId: `${repo}#${prNumber}`,
      detail: {
        workflow: workflowName,
        dispatched: true,
        ...(reason ? { note: reason } : {}),
      },
    });
    return c.json({
      repo,
      prNumber,
      workflow: workflowName,
      dispatched: true,
      recorded: false,
      retry,
      reason: disposition.reason,
    });
  }

  app.post("/prs/:owner/:repo/:number/retry", async (c) => {
    const { owner, repo: name } = c.req.param();
    const prNumber = Number.parseInt(c.req.param("number"), 10);
    if (!Number.isInteger(prNumber) || prNumber <= 0) {
      return c.json({ error: `invalid pull request number: ${c.req.param("number")}` }, 400);
    }
    // Free text from `lastlight pr retry <ref> "<reason>"`. Untrusted, and
    // deliberately NOT sanitized here: `resolvePrState` runs it through
    // `pr-notes.ts`'s sanitizer where the record is built, so no surface can
    // skip that step.
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;
    return retryPullRequest(c, { owner, name, prNumber, reason });
  });

  // ── Start a build from the pipeline board ─────────────────────────────────
  //
  // The board's one mutating action on an ISSUE card. Everything else it offers
  // already had an endpoint — approve/reject resolve through
  // `POST /approvals/:id/respond`, cancel/retry through the workflow-run
  // routes, and a PR card's retry through `retryPullRequest` above — so this is
  // the only new surface Phase 7 adds.
  //
  // ## It crosses a gate; it does not dispatch blind
  //
  // `dispatchWorkflow` already guards the managed-repo allowlist, the repo's
  // own `disabled.workflows`, and the PR gate. What nothing guarded was the
  // ISSUE hold on a dashboard-initiated dispatch: a card whose issue carries
  // the hold label would have dispatched, because the hold is checked inside
  // `applyBuildDispatchGate` and nothing on this path had reached it. So this
  // route crosses that gate itself, for the same reason the PR retry above
  // crosses `applyPrDispatchGate` itself: the route that answers a human is the
  // route that has to be able to TELL them why not, and a fire-and-forget
  // dispatch can only ever answer "accepted".
  //
  // `dispatchWorkflow` then crosses the build gate a SECOND time, and that is
  // deliberate rather than tolerated. The context carries `_stage`, which is
  // what `engine/stage-observer.ts` reads to move the issue off the `running`
  // label when the run ends — drop it to dodge the second gate and every
  // board-started build strands on `agent-building` forever, which is precisely
  // the bug that module exists to prevent. The second crossing is harmless
  // because the consequence it applies is idempotent: `addLabels` re-adding a
  // label the issue already carries is a no-op, and `removeLabel` swallows the
  // 404 that means "already gone" (`stage-observer.ts` makes the same argument
  // about its own re-firing). The choke point stays the choke point; this route
  // just gets to answer first.
  app.post("/issues/:owner/:repo/:number/dispatch", async (c) => {
    const { owner, repo: name } = c.req.param();
    const repo = `${owner}/${name}`;
    const issueNumber = Number.parseInt(c.req.param("number"), 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return c.json({ error: `invalid issue number: ${c.req.param("number")}` }, 400);
    }
    // The same allowlist every other repo-touching path is gated on, checked
    // before anything is read or recorded against the repo.
    if (!isManagedRepo(repo)) {
      return c.json({ error: `${repo} is not a managed repository` }, 403);
    }
    const github = config.github ?? null;
    if (!github || !config.dispatchWorkflow) {
      return c.json({ error: "issue dispatch is not configured" }, 503);
    }

    const body = (await c.req.json().catch(() => ({}))) as { stage?: unknown; reason?: unknown };
    const reason =
      typeof body?.reason === "string" && body.reason.trim() ? body.reason.trim() : undefined;

    // The stage names the workflow, the labels and the gates. Defaulting to the
    // first configured stage is what lets the board post a bare issue number;
    // an unknown name fails CLOSED, exactly as the gate itself does, because
    // everything downstream is keyed on names only the stage carries.
    const stages = getAutonomyConfig().stages;
    const stageName =
      typeof body?.stage === "string" && body.stage.trim()
        ? body.stage.trim()
        : Object.keys(stages)[0];
    const stage = stageName ? stages[stageName] : undefined;
    if (!stageName || !stage) {
      return c.json(
        { error: `unknown stage: \`${stageName ?? ""}\` is not in \`autonomy.stages\`` },
        400,
      );
    }

    // THE ALLOW-LIST. See `ISSUE_DISPATCH_ROUTE_KEYS` — the workflow has to be
    // one the operator's own route map already points an issue trigger at.
    if (!isIssueRoutableWorkflow(stage.workflow)) {
      return c.json(
        {
          error:
            `workflow \`${stage.workflow}\` is not reachable from an issue route ` +
            `(${ISSUE_DISPATCH_ROUTE_KEYS.join(", ")}), so the board may not dispatch it`,
        },
        400,
      );
    }

    // ── THE LIVE RE-READ ────────────────────────────────────────────────────
    //
    // Never the cached board snapshot. The board is stale by design — up to
    // `BOARD_TTL_MS` (two minutes) — which is the right trade for RENDERING a
    // card and the wrong one entirely for DECIDING on it. Two minutes is ample
    // for a maintainer to apply the hold label and watch a build start anyway,
    // and the hold is the one instruction that must never lose a race. So the
    // labels the gate reads are the labels GitHub reports right now.
    let live: Awaited<ReturnType<GitHubClient["getIssue"]>>;
    try {
      live = await github.getIssue(owner, name, issueNumber);
    } catch (err: unknown) {
      log.warn("Board dispatch could not read the issue", { repo, issueNumber, err });
      return c.json(
        { error: `could not read ${repo}#${issueNumber} from GitHub`, dispatched: false },
        502,
      );
    }
    // The pipeline builds ISSUES. A pull request reached through the issues API
    // would cross a gate keyed on issue facts and dispatch a build against a
    // branch nobody asked to rebuild.
    if (live.pull_request) {
      return c.json({ error: `${repo}#${issueNumber} is a pull request, not an issue` }, 400);
    }
    const labels = ((live.labels ?? []) as Array<string | { name?: string }>)
      .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
      .filter(Boolean);

    const gate = await applyBuildDispatchGate(
      {
        repo,
        issueNumber,
        labels,
        // A person clicked a button in the dashboard. Not `labeled` (no label
        // was applied) and not `sweep` (nothing discovered this).
        route: "api",
        // A browser session is a human by construction. The flag exists to make
        // `already-built` a HARD skip for machines and a permitted retry for
        // people, and this surface is unambiguously the latter.
        senderIsBot: false,
        stage: stageName,
      },
      { db, github },
    );

    const holdLabel = getHoldLabel();
    const held = labels.includes(holdLabel) ? holdLabel : null;
    const targetId = issueTriggerId(repo, issueNumber);
    const by = actorFromContext(c) ?? "admin";

    if (gate.decision === "skip") {
      // Recorded as loudly as a success, per the `pr.retry` precedent: a
      // refusal nobody can find afterwards is indistinguishable from the
      // feature quietly not working. Every skip on THIS surface is a refusal —
      // unlike the PR retry, no branch here parks an ask for a later event to
      // honour — so the outcome is always `denied`.
      await recordActivityFor(c, db, {
        action: "issue.dispatch",
        targetType: "issue",
        targetId,
        outcome: "denied",
        detail: {
          stage: stageName,
          workflow: stage.workflow,
          dispatched: false,
          reason: String(gate.reason ?? "").slice(0, 200),
          ...(reason ? { note: reason } : {}),
        },
      });
      return c.json(
        {
          repo,
          issueNumber,
          stage: stageName,
          workflow: stage.workflow,
          dispatched: false,
          // The hold is the one skip that owes a human a sentence rather than a
          // reason string, and it is the SAME sentence every other surface
          // gives them.
          reason: held ? holdReply(held) : gate.reason,
          ...(held ? { held } : {}),
        },
        409,
      );
    }

    // Fire-and-forget, exactly like `cron trigger` and the PR retry above: a
    // build takes minutes and the dashboard is waiting on this response.
    log.info("board dispatch", { workflow: stage.workflow, repo, issueNumber, stage: stageName, by });
    config.dispatchWorkflow(stage.workflow, {
      repo,
      issueNumber,
      title: live.title,
      body: live.body ?? "",
      labels,
      _triggerType: "api" as const,
      // `_stage` names the stage for `stage-observer.ts`; `_autonomous` is what
      // `build-gate.ts` counts for `maxConcurrentBuilds` and what `simple.ts`
      // reads for the stage's `on_merge` policy. Both are stamped here because
      // both are properties of THIS dispatch.
      _stage: stageName,
      _autonomous: true,
      ...(gate.gates ? { _autonomyGates: gate.gates } : {}),
      sender: by,
      triggeredBy: by,
    }).catch((err: unknown) => {
      log.error("board dispatch failed", { workflow: stage.workflow, repo, issueNumber, err });
    });

    // The freshness lever that matters. Without this the card keeps rendering
    // its pre-dispatch stage for up to the full TTL, so the button appears to
    // have done nothing and the obvious next move is to press it again.
    invalidateBoard(repo);

    await recordActivityFor(c, db, {
      action: "issue.dispatch",
      targetType: "issue",
      targetId,
      detail: {
        stage: stageName,
        workflow: stage.workflow,
        dispatched: true,
        ...(reason ? { note: reason } : {}),
      },
    });
    return c.json({
      repo,
      issueNumber,
      stage: stageName,
      workflow: stage.workflow,
      dispatched: true,
      reason: gate.reason,
    });
  });

  // ── Move an issue between pipeline columns ────────────────────────────────
  //
  // `POST /issues/:owner/:repo/:number/stage`, body `{ to, from? }`. The drag
  // gesture on the board, and the second — last — mutating action it offers on
  // an issue card.
  //
  // ## There is no pipeline table, so a "move" is a label write
  //
  // The stage LABEL is the source of truth for where an issue has got to
  // (`stage-labels.ts`, `stage-advance.ts`). Nothing else records a column: the
  // board (`board.ts`) is a projection of the open issues GitHub reports and the
  // stage label each one carries. So moving a card cannot be a row update — it
  // is `advanceStage`, the same add-then-remove the harness performs host-side
  // at every dispatch, driven from a browser instead of from a run. We go
  // through that module rather than calling `addLabels`/`removeLabel` here
  // because its ORDERING is load-bearing: add first, and a half-failure leaves
  // the issue carrying both labels (visible, reconcilable); remove first, and a
  // half-failure drops it out of the pipeline entirely with nothing on it to
  // see. Its header makes the full argument.
  //
  // ## THE SECURITY PROPERTY: `to` is checked against the CONFIGURED labels
  //
  // This route lets an authenticated browser session write a label to a managed
  // repository. Unchecked, that is not "move a card" — it is "apply an
  // arbitrary label to any issue in any managed repo", which is a different and
  // much larger capability than the gesture implies (`good first issue`,
  // `security`, a label some other automation gates on). So `to` must be one of
  // the labels the OPERATOR configured under `autonomy.stages` — every
  // `enter` / `running` / `on_success` / `on_failure` across every stage — and
  // anything else is a 400, before a single GitHub call. `from` is checked the
  // same way, since it names a label we would REMOVE. The one extra value is
  // the empty string, meaning "off the board": remove `from`, add nothing.
  //
  // ## It writes a label AND, on the two build columns, dispatches
  //
  // A drag onto a stage's `enter` or `running` column is the same instruction
  // as the Dispatch button above, made with a different gesture, so it crosses
  // the SAME gate with the same standing: `route: "api"`, `senderIsBot: false`,
  // because a browser session is a human by construction. The two TERMINAL
  // columns (`on_success` / `on_failure`) and `""` move the card and start
  // nothing — "done" is not a request to build, and `on_failure` is also the
  // budget-exhausted comment's de-dup key, which a dispatch here would fight.
  //
  // **The bot skip is NOT relaxed, and this is the paragraph to read before
  // changing any of it.** `resolveBuildTrigger`'s `already-built` branch still
  // hard-skips a BOT re-label, which is what stops label ping-pong — a stage
  // observer's own write re-triggering the stage it just left. What changed is
  // that this route no longer *relies* on that webhook chain to start a build:
  // it asks the gate directly, as the person who dragged. Previously it did
  // rely on it, and the cost was invisible from the UI — our own label write
  // arrives with `senderIsBot: true`, so re-dragging an already-built issue
  // (every guardrails failure, every `agent-blocked` card) wrote the label and
  // started NOTHING, silently, with no affordance on the card saying why.
  //
  // ## The ORDER differs by column, and the reason is a race
  //
  // Only `stage.enter` is matched by the router's `stageForLabel`, so only an
  // `enter` write echoes back to us as a dispatchable webhook. Writing it and
  // THEN dispatching opens a real window: between our `addLabels` and
  // `createRun` the echo arrives, reads `alreadyBuilt: false` and
  // `runInFlight: false` — so the bot skip never even applies — and dispatches
  // a second time. `simple.ts` then reuses the run row (it dedups only a
  // QUEUED one), which is two agents in one workspace on one branch.
  //
  // So on the `enter` column we cross the gate FIRST. On a dispatch verdict the
  // gate's own guard 2 has already advanced the issue to `running`, so no
  // `enter` label is ever written, no echo is ever emitted, and there is
  // exactly one gate crossing per gesture — closed structurally, with no lock
  // and no new state. The card lands in the `running` column rather than the
  // one it was dropped on; `landedLabel` says so, and that is the truth of it.
  // On a SKIP verdict the label is written as dragged, so the drag still moves
  // the card and the reason travels back to render on it.
  //
  // The `running` column keeps the simpler write-then-gate order: it has no
  // echo, so it has no race. Dispatching there is not a convenience — the sweep
  // excludes the `running` label by design (`issue-discovery.ts`), so a card
  // dropped there with no run behind it is stranded permanently.
  app.post("/issues/:owner/:repo/:number/stage", async (c) => {
    const { owner, repo: name } = c.req.param();
    const repo = `${owner}/${name}`;
    const issueNumber = Number.parseInt(c.req.param("number"), 10);
    if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
      return c.json({ error: `invalid issue number: ${c.req.param("number")}` }, 400);
    }
    // The same allowlist every other repo-touching path is gated on, checked
    // before anything is read or written against the repo.
    if (!isManagedRepo(repo)) {
      return c.json({ error: `${repo} is not a managed repository` }, 403);
    }
    const github = config.github ?? null;
    if (!github) {
      return c.json({ error: "stage moves are not configured" }, 503);
    }

    const body = (await c.req.json().catch(() => ({}))) as { to?: unknown; from?: unknown };
    const to = typeof body?.to === "string" ? body.to.trim() : undefined;
    const from = typeof body?.from === "string" && body.from.trim() ? body.from.trim() : undefined;
    if (to === undefined) {
      return c.json({ error: "`to` is required (a configured stage label, or \"\" to unstage)" }, 400);
    }

    // THE ALLOW-LIST. Every label any configured stage names, in any position.
    // Built from `autonomy.stages` rather than from `stage-labels.ts`'s
    // constants so an operator who renamed a stage's labels moves this surface
    // with them — and an operator who configured no stages at all gets a
    // refusal rather than a write, which is the right failure for a feature
    // that is inert out of the box.
    const configuredLabels = new Set<string>();
    for (const stage of Object.values(getAutonomyConfig().stages)) {
      for (const label of [stage.enter, stage.running, stage.on_success, stage.on_failure]) {
        if (label) configuredLabels.add(label);
      }
    }
    // `""` is legal for `to` only — it means "off the board". As a `from` it
    // would be meaningless (there is nothing to take off), and `from` is
    // already absent in that case.
    if (to !== "" && !configuredLabels.has(to)) {
      return c.json(
        { error: `\`${to}\` is not a configured stage label, so it may not be applied here` },
        400,
      );
    }
    if (from !== undefined && !configuredLabels.has(from)) {
      return c.json(
        { error: `\`${from}\` is not a configured stage label, so it may not be removed here` },
        400,
      );
    }

    // ── THE LIVE RE-READ ────────────────────────────────────────────────────
    //
    // Never the cached board snapshot, for the reason the dispatch route above
    // spells out: the board is stale by up to `BOARD_TTL_MS` (two minutes) by
    // design, which is the right trade for RENDERING a card and the wrong one
    // for acting on it. A failed read is a 502 rather than a write made blind —
    // the decision below turns on labels, and guessing at them is how the hold
    // loses a race it must never lose.
    let live: Awaited<ReturnType<GitHubClient["getIssue"]>>;
    try {
      live = await github.getIssue(owner, name, issueNumber);
    } catch (err: unknown) {
      log.warn("Board stage move could not read the issue", { repo, issueNumber, from, to, err });
      return c.json(
        { error: `could not read ${repo}#${issueNumber} from GitHub`, moved: false },
        502,
      );
    }
    const labels = ((live.labels ?? []) as Array<string | { name?: string }>)
      .map((l) => (typeof l === "string" ? l : l?.name ?? ""))
      .filter(Boolean);

    const targetId = issueTriggerId(repo, issueNumber);
    const by = actorFromContext(c) ?? "admin";

    // THE HOLD OUTRANKS A DRAG, exactly as it outranks every other surface. A
    // maintainer who applied it has said "stay off this subject", and a drag is
    // not an exception to that — it is the same request as the dispatch button,
    // made with a different gesture. Recorded as loudly as a success, per the
    // `pr.retry` precedent, and answered with the same sentence every other
    // surface gives: `holdReply` names the label, because the fix is to remove
    // it and a reason code would not say so.
    const holdLabel = getHoldLabel();
    const held = labels.includes(holdLabel) ? holdLabel : null;
    if (held) {
      await recordActivityFor(c, db, {
        action: "issue.stage",
        targetType: "issue",
        targetId,
        outcome: "denied",
        detail: {
          ...(from ? { from } : {}),
          to,
          advanced: false,
          removed: false,
          reason: "on-hold",
        },
      });
      return c.json({ moved: false, reason: holdReply(held), held, dispatched: false }, 409);
    }

    // ── "Off the board" — the one move `advanceStage` cannot express ─────────
    //
    // Its whole contract is built around the ADD (add first, and only then the
    // remove), so it answers `no-target-label` for an empty `to` rather than
    // performing a bare removal. That is right for the dispatch path, which
    // never wants one. Here it is a real gesture: dragging a card out of the
    // pipeline. So this branch removes directly — the single site in this file
    // that touches a label without going through that module, and it is safe
    // to do so precisely because there is no ordering to get wrong.
    if (to === "") {
      if (!from) {
        // Nothing named, nothing to take off. A no-op, not an error: the card
        // is already where the caller asked for it to be.
        await recordActivityFor(c, db, {
          action: "issue.stage",
          targetType: "issue",
          targetId,
          detail: { to, advanced: false, removed: false, reason: "already-unstaged" },
        });
        return c.json({ moved: true, advanced: false, removed: false, dispatched: false });
      }
      let removed = true;
      let reason: string | undefined;
      try {
        await github.removeLabel(owner, name, issueNumber, from);
      } catch (err: unknown) {
        // Unlike a failed remove AFTER a successful add, nothing at all moved
        // here — but it is still not an error the caller can act on differently,
        // so it reports the same granular shape rather than a status code. The
        // card redraws where it was, which is the truth.
        removed = false;
        reason = "remove-failed";
        log.warn("Board stage move could not unstage the issue", {
          repo,
          issueNumber,
          from,
          err,
        });
      }
      await recordActivityFor(c, db, {
        action: "issue.stage",
        targetType: "issue",
        targetId,
        outcome: removed ? "ok" : "error",
        detail: { from, to, advanced: false, removed, ...(reason ? { reason } : {}) },
      });
      invalidateBoard(repo);
      return c.json({ moved: removed, advanced: false, removed, dispatched: false });
    }

    log.info("board stage move", { repo, issueNumber, from, to, by });

    // ── IS THIS GESTURE A REQUEST TO BUILD? ─────────────────────────────────
    const slotMatch = stageSlotForLabel(to);
    const stages = getAutonomyConfig().stages;
    const matchedStage = slotMatch?.kind === "match" ? stages[slotMatch.stage] : undefined;

    // Every reason this gesture MOVES the card but starts nothing. Each is a
    // sentence a card can render, not a bare code, and the order is
    // most-specific-first so the answer names the real obstacle.
    const dispatchRefusal = ((): string | undefined => {
      if (slotMatch === null) return `unconfigured-label: \`${to}\` names no autonomy stage`;
      if (slotMatch.kind === "ambiguous") {
        return (
          `ambiguous-stage: \`${to}\` is claimed by ${slotMatch.stages.join(", ")}, ` +
          `so which build to start is undecidable`
        );
      }
      if (slotMatch.slot !== "enter" && slotMatch.slot !== "running") {
        return (
          `terminal-column: \`${to}\` is the \`${slotMatch.slot}\` label of ` +
          `\`${slotMatch.stage}\`, which ends a build rather than starting one`
        );
      }
      if (!matchedStage) return `unknown-stage: \`${slotMatch.stage}\` is not in \`autonomy.stages\``;
      if (!config.dispatchWorkflow) return "dispatch-not-configured: this deployment has no runner wired";
      // The pipeline builds ISSUES. A pull request reached through the issues
      // API would cross a gate keyed on issue facts and dispatch a build
      // against a branch nobody asked to rebuild — the same refusal the
      // dispatch button makes. The MOVE still stands; PR cards live on the
      // board and dragging one between columns is legitimate.
      if (live.pull_request) return "not-an-issue: the pipeline builds issues, and this is a pull request";
      // A drop that changes no label is not an instruction. The client has a
      // same-column no-op, but it is computed from a board snapshot up to
      // BOARD_TTL_MS stale, so `from` is often wrong and the same column gets
      // re-dropped. This one reads the LIVE labels, and it is what keeps a
      // gesture with no menu and no confirm step from being drop-spam that
      // bills.
      if (labels.includes(to)) return `already-in-stage: ${repo}#${issueNumber} already carries \`${to}\``;
      if (!isIssueRoutableWorkflow(matchedStage.workflow)) {
        return (
          `unroutable-workflow: \`${matchedStage.workflow}\` is not reachable from an ` +
          `issue route (${ISSUE_DISPATCH_ROUTE_KEYS.join(", ")})`
        );
      }
      return undefined;
    })();

    // The PROJECTED label set — what is true of the issue AFTER this move, not
    // before it. The gate reads labels for the hold and for the
    // budget-exhausted comment de-dup, and both are questions about the issue
    // as it will be.
    const projected = [...new Set(labels.filter((l) => l !== from).concat(to ? [to] : []))];

    let dispatched = false;
    let dispatchReason: string | undefined = dispatchRefusal;
    let dispatchStage: string | undefined;

    const crossGate = async (stageName: string) => {
      const gate = await applyBuildDispatchGate(
        { repo, issueNumber, labels: projected, route: "api", senderIsBot: false, stage: stageName },
        { db, github },
      );
      dispatchReason = gate.reason;
      return gate;
    };

    // Fire-and-forget, exactly like the dispatch button: a build takes minutes
    // and the dashboard is waiting on this response.
    const fireDispatch = (
      stageName: string,
      workflow: string,
      gates?: Record<string, boolean>,
    ): void => {
      dispatched = true;
      dispatchStage = stageName;
      config.dispatchWorkflow!(workflow, {
        repo,
        issueNumber,
        title: live.title,
        body: live.body ?? "",
        labels: projected,
        _triggerType: "api" as const,
        // `_stage` names the stage for `stage-observer.ts` — drop it and every
        // board-started build strands on the running label forever.
        // `_autonomous` is what `build-gate.ts` counts for
        // `maxConcurrentBuilds` and what `simple.ts` reads for `on_merge`.
        _stage: stageName,
        _autonomous: true,
        ...(gates ? { _autonomyGates: gates } : {}),
        sender: by,
        triggeredBy: by,
      }).catch((err: unknown) => {
        log.error("board stage dispatch failed", { repo, issueNumber, stage: stageName, err });
      });
    };

    // ── GATE FIRST ON THE ENTRY COLUMN ──────────────────────────────────────
    //
    // See the route header. Crossing before the write is what stops our own
    // `enter` label echoing back as a second dispatch; on a dispatch verdict
    // guard 2 has already moved the issue to `running`, so we never write
    // `enter` at all.
    const gateFirst =
      dispatchRefusal === undefined && slotMatch?.kind === "match" && slotMatch.slot === "enter";

    if (gateFirst && slotMatch?.kind === "match" && matchedStage) {
      const gate = await crossGate(slotMatch.stage);
      if (gate.decision === "dispatch") {
        // Guard 2 wrote `running` and 404-swallowed the `enter` removal. All
        // that is left is the label the card was dragged OFF — best-effort, on
        // the same argument `advanceStage` makes: the run row is the fact and
        // the labels are its projection, so a GitHub blip must not undo a
        // dispatch that has already been decided.
        let removed = false;
        const stale = from && from !== matchedStage.running ? from : undefined;
        if (stale) {
          try {
            await github.removeLabel(owner, name, issueNumber, stale);
            removed = true;
          } catch (err: unknown) {
            log.warn("board stage move could not remove the previous label", {
              repo,
              issueNumber,
              from: stale,
              err,
            });
          }
        }
        fireDispatch(slotMatch.stage, matchedStage.workflow, gate.gates);
        invalidateBoard(repo);
        await recordActivityFor(c, db, {
          action: "issue.stage",
          targetType: "issue",
          targetId,
          detail: {
            ...(from ? { from } : {}),
            to,
            advanced: true,
            removed,
            dispatched: true,
            ...(dispatchReason ? { dispatchReason: String(dispatchReason).slice(0, 200) } : {}),
          },
        });
        return c.json({
          moved: true,
          advanced: true,
          removed,
          dispatched: true,
          stage: slotMatch.stage,
          // Where the card ACTUALLY landed. Guard 2 advanced it to the running
          // column, so the SPA must place it there rather than springing back.
          landedLabel: matchedStage.running,
          ...(dispatchReason ? { dispatchReason } : {}),
        });
      }
      // The gate said no. Fall through: the label is written as dragged, the
      // card moves, and the reason travels back to render on it.
    }

    const result = await advanceStage({ owner, repo: name, issueNumber, from, to }, { github });

    // A failed ADD means NOTHING happened — `advanceStage` deliberately does not
    // attempt the remove in that case, so the issue is still wearing `from` and
    // still in its previous stage. That is a true statement about it, and the
    // honest answer to the caller is that the move did not happen.
    if (!result.added) {
      await recordActivityFor(c, db, {
        action: "issue.stage",
        targetType: "issue",
        targetId,
        outcome: "error",
        detail: {
          ...(from ? { from } : {}),
          to,
          advanced: false,
          removed: false,
          reason: String(result.reason ?? "add-failed").slice(0, 200),
        },
      });
      return c.json(
        {
          error: `could not apply \`${to}\` to ${repo}#${issueNumber}`,
          moved: false,
          reason: result.reason,
        },
        502,
      );
    }

    // The `running` column dispatches AFTER the write — it has no webhook echo
    // and therefore no race. `gateFirst` guards against crossing twice when the
    // entry path already asked and was refused.
    if (!gateFirst && dispatchRefusal === undefined && slotMatch?.kind === "match" && matchedStage) {
      const gate = await crossGate(slotMatch.stage);
      if (gate.decision === "dispatch") {
        fireDispatch(slotMatch.stage, matchedStage.workflow, gate.gates);
      }
    }

    // A failed REMOVE is not an error. The issue now carries BOTH labels, which
    // is the tolerable half of that module's asymmetry: visible, reconcilable by
    // hand or by the next advance, and a later stage wins wherever the pair is
    // read. So the move stands and the granular result travels back — the card
    // will redraw in its new column with the stale label still attached, which
    // is exactly what is true of it.
    await recordActivityFor(c, db, {
      action: "issue.stage",
      targetType: "issue",
      targetId,
      detail: {
        ...(from ? { from } : {}),
        to,
        advanced: result.advanced,
        removed: result.removed,
        dispatched,
        ...(dispatchReason ? { dispatchReason: String(dispatchReason).slice(0, 200) } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      },
    });

    // The freshness lever. Without it the card keeps rendering its pre-move
    // column for up to the full TTL, so the drag springs back and the obvious
    // next move is to drag it again.
    invalidateBoard(repo);

    return c.json({
      moved: true,
      advanced: result.advanced,
      removed: result.removed,
      // Stated rather than omitted, on both answers. `dispatchReason` carries
      // WHY when nothing started — a terminal column, a budget ceiling, a run
      // already in flight — and is deliberately a separate field from `reason`,
      // which belongs to the LABEL outcome (`remove-failed`) and answers a
      // different question.
      dispatched,
      ...(dispatchStage ? { stage: dispatchStage } : {}),
      ...(dispatchReason ? { dispatchReason } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
    });
  });

  return app;
}
