import { randomUUID } from "node:crypto";
import { runDashboardUrl } from "../model.js";
import { qualifyRepo } from "../../state/repo-ref.js";
import type { WorkflowRun } from "../../state/workflow-run-store.js";
import type { WebhookEventType, WebhookPayload } from "./types.js";

/** Cap on any untrusted string a payload carries (approval summary, failure reason). */
export const SUMMARY_MAX_CHARS = 2000;

function truncate(s: string): string {
  return s.length > SUMMARY_MAX_CHARS ? s.slice(0, SUMMARY_MAX_CHARS) + "…" : s;
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
