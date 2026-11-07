import { randomUUID } from "node:crypto";
import { runDashboardUrl } from "../model.js";
import { qualifyRepo } from "../../state/repo-ref.js";
import { SENSITIVE_KEY_RE } from "../../config/config.js";
import type { WorkflowRun } from "../../state/workflow-run-store.js";
import type { WebhookEventType, WebhookPayload } from "./types.js";

/** Cap on any untrusted string a payload carries (approval summary, failure reason). */
export const SUMMARY_MAX_CHARS = 2000;

function truncate(s: string): string {
  return s.length > SUMMARY_MAX_CHARS ? s.slice(0, SUMMARY_MAX_CHARS) + "…" : s;
}

/** Shorter values are too likely to occur by chance to be worth replacing. */
const MIN_REDACT_LENGTH = 8;

/**
 * A copy of `payload` in which every string has the value of each sensitive
 * env var (key matching `SENSITIVE_KEY_RE`, or named in `extraKeys` — the
 * endpoints' own `secretEnv`) replaced by `[redacted]`. Error and summary
 * text comes from exception messages and agents; this is the last stop before
 * it leaves the process.
 */
export function redactEnvValues(payload: WebhookPayload, env: NodeJS.ProcessEnv, extraKeys: string[] = []): WebhookPayload {
  const extra = new Set(extraKeys);
  const values = Object.entries(env)
    .filter(([k, v]) => typeof v === "string" && v.length >= MIN_REDACT_LENGTH && (extra.has(k) || SENSITIVE_KEY_RE.test(k)))
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  if (values.length === 0) return payload;
  const scrub = (x: unknown): unknown => {
    if (typeof x === "string") return values.reduce((s, v) => s.split(v).join("[redacted]"), x);
    if (Array.isArray(x)) return x.map(scrub);
    if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, scrub(v)]));
    return x;
  };
  return scrub(payload) as WebhookPayload;
}

export interface PayloadExtra {
  approval?: { gate: string; summary: string };
  result?: { status: "succeeded" | "failed" | "cancelled"; prUrl?: string; error?: string };
  hold?: { provider: string; window: string; usedPct: number; maxPercent: number; resetsAt: string | null };
  /** `autonomy.held` only: the issue that was held (there is no run yet). */
  repo?: string;
  issueNumber?: number;
}

export interface PayloadContext {
  botName: string;
  /** Public base URL of this deployment; the dashboard link is left out without it. */
  dashboardBase?: string;
  now: Date;
}

/**
 * Build one webhook payload. `text` is assembled from fixed words and
 * identifiers only (event, workflow, repo, issue number, gate name, status,
 * window); agent- or reporter-written text stays in its own named, truncated
 * field so a receiver can treat it as data.
 */
export function buildRunPayload(
  type: WebhookEventType,
  run: WorkflowRun | undefined,
  extra: PayloadExtra,
  ctx: PayloadContext,
): WebhookPayload {
  const payload: WebhookPayload = {
    type,
    deliveryId: randomUUID(),
    timestamp: ctx.now.toISOString(),
    text: "",
  };

  let where = "";
  if (run) {
    const repo = qualifyRepo(run.owner, run.repo);
    const issueUrl =
      repo && repo.includes("/") && run.issueNumber ? `https://github.com/${repo}/issues/${run.issueNumber}` : undefined;
    payload.run = {
      id: run.id,
      workflow: run.workflowName,
      ...(repo ? { repo } : {}),
      ...(run.issueNumber ? { issueNumber: run.issueNumber } : {}),
      ...(issueUrl ? { issueUrl } : {}),
      ...(ctx.dashboardBase ? { dashboardUrl: runDashboardUrl(ctx.dashboardBase, run.id, run.workflowName) } : {}),
      autonomous: run.context?._autonomous === true,
      ...(run.triggerActorType ? { trigger: run.triggerActorType } : {}),
    };
    where = repo ? ` on ${repo}${run.issueNumber ? `#${run.issueNumber}` : ""}` : "";
  } else if (extra.repo) {
    const issueUrl = extra.issueNumber ? `https://github.com/${extra.repo}/issues/${extra.issueNumber}` : undefined;
    payload.subject = {
      repo: extra.repo,
      ...(extra.issueNumber ? { issueNumber: extra.issueNumber } : {}),
      ...(issueUrl ? { issueUrl } : {}),
    };
    where = ` on ${extra.repo}${extra.issueNumber ? `#${extra.issueNumber}` : ""}`;
  }

  const workflow = run ? `${run.workflowName} ` : "";
  switch (type) {
    case "run.started":
      payload.text = `[run.started] ${workflow}run started${where}.`;
      break;
    case "run.approval_requested": {
      const gate = extra.approval?.gate ?? "approval";
      payload.approval = {
        gate,
        summary: truncate(extra.approval?.summary ?? ""),
        approveCommand: `@${ctx.botName} approve`,
        rejectCommand: `@${ctx.botName} reject <reason>`,
      };
      payload.text = `[run.approval_requested] ${workflow}run${where} is waiting for approval at ${gate}. Reply with @${ctx.botName} approve or @${ctx.botName} reject <reason>.`;
      break;
    }
    case "run.finished": {
      const status = extra.result?.status ?? (run?.status as "succeeded" | "failed" | "cancelled") ?? "failed";
      payload.result = {
        status,
        ...(extra.result?.prUrl ? { prUrl: extra.result.prUrl } : {}),
        ...(extra.result?.error ? { error: truncate(extra.result.error) } : {}),
      };
      payload.text = `[run.finished] ${workflow}run${where} ${status}.${payload.result.prUrl ? ` PR: ${payload.result.prUrl}` : ""}`;
      break;
    }
    case "autonomy.held": {
      if (extra.hold) payload.hold = { ...extra.hold };
      const h = extra.hold;
      payload.text = h
        ? `[autonomy.held] Autonomous build${where} held: ${h.provider} ${h.window} at ${Math.round(h.usedPct)}% (limit ${h.maxPercent}%)${h.resetsAt ? `, resets ${h.resetsAt}` : ""}.`
        : `[autonomy.held] Autonomous build${where} held.`;
      break;
    }
  }
  return payload;
}
