/**
 * Slack binding for the progress notifier. Owns a single message `ts` and
 * edits it in place via `chat.update` on every `publish()`; `note()` posts a
 * fresh threaded message for moments that deserve a real ping (approval
 * prompts, terminal summary) — `chat.update` itself is silent.
 */
import type { SlackConnector } from "../../connectors/slack/connector.js";
import { renderApprovalBlocks, renderProgressBlocks } from "../blocks.js";
import type { ApprovalNoteMeta, NotifierTransport, ProgressModel } from "../types.js";

export interface SlackTransportDeps {
  slack: SlackConnector;
  channel: string;
  thread: string;
  /** Existing status-message ts from a resumed run, if any. */
  ts?: string;
  /** Persist the ts the first time it's created (so resume re-attaches). */
  save?: (ts: string) => void;
}

export class SlackTransport implements NotifierTransport {
  /** Slack edits are silent and there's no other signal — so it wants the ping. */
  readonly terminalPing = true;
  private ts?: string;

  constructor(private readonly deps: SlackTransportDeps) {
    this.ts = deps.ts;
  }

  async publish(markdown: string, model?: ProgressModel): Promise<void> {
    const { slack, channel, thread } = this.deps;
    // Render Block Kit from the model when available; `markdown` stays the
    // notification/accessibility fallback carried alongside the blocks.
    const blocks = model ? renderProgressBlocks(model) : undefined;
    if (this.ts !== undefined) {
      await slack.updateMessage(channel, this.ts, markdown, blocks);
    } else {
      const ts = await slack.sendMessage(channel, thread, markdown, blocks);
      if (typeof ts === "string") {
        this.ts = ts;
        this.deps.save?.(ts);
      }
    }
  }

  async note(markdown: string): Promise<void> {
    const { slack, channel, thread } = this.deps;
    await slack.sendMessage(channel, thread, markdown);
  }

  async noteApproval(markdown: string, meta: ApprovalNoteMeta): Promise<void> {
    const { slack, channel, thread } = this.deps;
    const blocks = renderApprovalBlocks(markdown, meta.workflowRunId);
    await slack.sendMessage(channel, thread, markdown, blocks);
  }
}
