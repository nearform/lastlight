import type { StateDb } from "../../state/db.js";
import { qualifyRepo } from "../../state/repo-ref.js";
import type { WorkflowRun } from "../../state/workflow-run-store.js";
import { deliverWebhook, type DeliveryResult } from "./deliver.js";
import { buildRunPayload, redactEnvValues, type PayloadExtra } from "./payload.js";
import type { WebhookEndpointConfig, WebhookEventType, WebhookPayload } from "./types.js";

interface EmitterLog {
  warn(msg: string, meta?: Record<string, unknown>): void;
  debug?(msg: string, meta?: Record<string, unknown>): void;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "[invalid url]";
  }
}

/**
 * Sends each payload to the endpoints that want it: the event is in the
 * endpoint's `events`, and its `repos` is empty or names the payload's repo
 * (case-insensitive, as GitHub treats names). Fire-and-forget: `emit` returns
 * at once and never throws; a failure is logged with the endpoint's host only,
 * since the rest of a hook URL is often its credential.
 */
export class WebhookEmitter {
  private readonly endpoints: WebhookEndpointConfig[];
  private readonly env: NodeJS.ProcessEnv;
  private readonly deliver: (
    endpoint: WebhookEndpointConfig,
    secret: string,
    payload: WebhookPayload,
  ) => Promise<DeliveryResult>;
  private readonly log: EmitterLog;

  constructor(deps: {
    endpoints: WebhookEndpointConfig[];
    env: NodeJS.ProcessEnv;
    deliver?: (endpoint: WebhookEndpointConfig, secret: string, payload: WebhookPayload) => Promise<DeliveryResult>;
    log: EmitterLog;
  }) {
    this.endpoints = deps.endpoints;
    this.env = deps.env;
    this.deliver = deps.deliver ?? ((e, s, p) => deliverWebhook(e, s, p));
    this.log = deps.log;
  }

  emit(raw: WebhookPayload, repo?: string): void {
    const want = repo?.toLowerCase();
    const payload = redactEnvValues(raw, this.env, this.endpoints.map((e) => e.secretEnv));
    for (const endpoint of this.endpoints) {
      if (!endpoint.events.includes(payload.type)) continue;
      if (endpoint.repos.length > 0 && (!want || !endpoint.repos.some((r) => r.toLowerCase() === want))) continue;
      const host = hostOf(endpoint.url);
      const secret = this.env[endpoint.secretEnv];
      if (!secret) {
        this.log.warn("Webhook skipped: its secret env var is not set", {
          host,
          secretEnv: endpoint.secretEnv,
          event: payload.type,
        });
        continue;
      }
      void Promise.resolve()
        .then(() => this.deliver(endpoint, secret, payload))
        .then(
          (r) => {
            if (!r.ok) {
              this.log.warn("Webhook delivery failed", {
                host,
                event: payload.type,
                deliveryId: payload.deliveryId,
                attempts: r.attempts,
                status: r.status,
              });
            }
          },
          (err: unknown) => {
            this.log.warn("Webhook delivery threw", {
              host,
              event: payload.type,
              deliveryId: payload.deliveryId,
              err: err instanceof Error ? err.message : String(err),
            });
          },
        );
    }
  }
}

export interface WebhookObserverContext {
  botName: string;
  /** Public base URL; payloads carry a dashboard link only when set. */
  dashboardBase?: string;
}

type ObservableRuns = Pick<StateDb["runs"], "addStartObserver" | "addApprovalObserver" | "addTerminalObserver">;

/**
 * Wire run transitions to webhook events: first start → `run.started`, a
 * pause on an `approve` gate → `run.approval_requested` (reply gates are a
 * conversation, not a decision, and are left out), and every terminal status
 * → `run.finished`. Each observer keeps the store's contract: synchronous,
 * never throws.
 */
export function installWebhookObservers(
  db: { runs: ObservableRuns },
  emitter: Pick<WebhookEmitter, "emit">,
  ctx: WebhookObserverContext,
): void {
  const send = (type: WebhookEventType, run: WorkflowRun, extra: PayloadExtra) => {
    try {
      const payload = buildRunPayload(type, run, extra, { ...ctx, now: new Date() });
      emitter.emit(payload, qualifyRepo(run.owner, run.repo));
    } catch {
      // Observer contract: never throw into the store.
    }
  };

  db.runs.addStartObserver((run) => send("run.started", run, {}));
  db.runs.addApprovalObserver((run, approval) => {
    if (approval.kind !== "approve") return;
    send("run.approval_requested", run, { approval: { gate: approval.gate, summary: approval.summary } });
  });
  // The engine finishes a run when its last phase ends and the workflow
  // wrapper finishes it again, and the store fires its observers for both
  // writes. One report per (run, status, phases run): a retry that finishes
  // again has run more phases, so it is reported.
  const reported = new Map<string, string>();
  db.runs.addTerminalObserver((run, status) => {
    const key = `${status}|${run.phaseHistory?.length ?? 0}`;
    if (reported.get(run.id) === key) return;
    reported.delete(run.id);
    reported.set(run.id, key);
    if (reported.size > 500) reported.delete(reported.keys().next().value as string);
    const repo = qualifyRepo(run.owner, run.repo);
    const prNumber = numberField(run.context?.prNumber) ?? numberField(run.scratch?.prNumber);
    const error = typeof run.context?.error === "string" ? run.context.error : undefined;
    send("run.finished", run, {
      result: {
        status,
        ...(prNumber && repo?.includes("/") ? { prUrl: `https://github.com/${repo}/pull/${prNumber}` } : {}),
        ...(error ? { error } : {}),
      },
    });
  });
}

function numberField(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * Boot wiring: with no `webhooks:` configured nothing is installed and `null`
 * comes back; otherwise the emitter (which the build gate also uses for
 * `autonomy.held`) is returned with the run observers wired.
 */
export function installWebhooks(
  db: { runs: ObservableRuns },
  config: { webhooks: WebhookEndpointConfig[]; botName: string; publicUrl?: string },
  env: NodeJS.ProcessEnv,
  log: EmitterLog,
): WebhookEmitter | null {
  if (config.webhooks.length === 0) return null;
  const emitter = new WebhookEmitter({ endpoints: config.webhooks, env, log });
  installWebhookObservers(db, emitter, { botName: config.botName, dashboardBase: config.publicUrl });
  return emitter;
}
