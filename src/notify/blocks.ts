/**
 * Slack Block Kit renderer for the progress surface.
 *
 * This maps a {@link ProgressModel} to Block Kit blocks so the Slack progress
 * message renders as a real header + divider + sectioned checklist rather than
 * a wall of mrkdwn text. It reads the *model* directly — the same model
 * `renderProgress` turns into markdown for GitHub and for the Slack `text:`
 * fallback — so the two surfaces derive from one content source and can't
 * drift. Each line of content is built as the exact markdown fragment
 * `render.ts` would emit, then run through `markdownToSlackMrkdwn`, so inline
 * formatting (bold, links) matches the text path byte-for-byte.
 */
import type { KnownBlock } from "@slack/web-api";
import { markdownToSlackMrkdwn } from "../connectors/slack/mrkdwn.js";
import { STATUS_EMOJI } from "./render.js";
import type { ProgressModel, ProgressStep } from "./types.js";

/** Slack hard limits we render within. */
const MAX_BLOCKS = 48; // Slack caps a message at 50 blocks; keep headroom
const MAX_SECTION_CHARS = 2800; // Slack section text limit is 3000
const HEADER_MAX = 150; // Slack header plain_text limit
const MAX_CONTEXT_ELEMENTS = 10; // Slack context block element limit

const divider: KnownBlock = { type: "divider" };

function headerBlock(text: string): KnownBlock {
  const t = text.length > HEADER_MAX ? text.slice(0, HEADER_MAX - 1) + "…" : text;
  return { type: "header", text: { type: "plain_text", text: t, emoji: true } };
}

function section(mrkdwn: string): KnownBlock {
  return { type: "section", text: { type: "mrkdwn", text: mrkdwn } };
}

function context(elements: string[]): KnownBlock {
  return {
    type: "context",
    elements: elements
      .slice(0, MAX_CONTEXT_ELEMENTS)
      .map((text) => ({ type: "mrkdwn", text })),
  };
}

/** One checklist line, e.g. "✅ *Architect* — done", matching render.ts content. */
function stepLine(step: ProgressStep): string {
  const emoji = STATUS_EMOJI[step.status] ?? STATUS_EMOJI.pending;
  const detail = step.detail ? ` — ${step.detail}` : "";
  return markdownToSlackMrkdwn(`${emoji} **${step.label}**${detail}`);
}

/** Batch checklist lines into section-sized chunks (Slack's 3000-char limit). */
function batchSteps(lines: string[]): string[] {
  const sections: string[] = [];
  let buf = "";
  for (const line of lines) {
    const next = buf ? `${buf}\n${line}` : line;
    if (next.length > MAX_SECTION_CHARS && buf) {
      sections.push(buf);
      buf = line;
    } else {
      buf = next;
    }
  }
  if (buf) sections.push(buf);
  return sections;
}

/** Render a {@link ProgressModel} to Block Kit blocks (≤ {@link MAX_BLOCKS}). */
export function renderProgressBlocks(model: ProgressModel): KnownBlock[] {
  const blocks: KnownBlock[] = [headerBlock(`🤖 ${model.title}`)];

  if (model.subtitle?.trim()) {
    blocks.push(section(markdownToSlackMrkdwn(`**${model.subtitle}**`)));
  }

  const meta = (model.meta ?? [])
    .map((m) => m.trim())
    .filter(Boolean)
    .map(markdownToSlackMrkdwn);
  if (meta.length) blocks.push(context(meta));

  if (model.steps.length) blocks.push(divider);

  // Reserve a block for the footer so it never gets crowded out of the budget.
  const footerReserve = model.footer?.trim() ? 1 : 0;
  const stepBudget = MAX_BLOCKS - blocks.length - footerReserve;
  const sections = batchSteps(model.steps.map(stepLine));

  if (sections.length <= stepBudget) {
    for (const s of sections) blocks.push(section(s));
  } else {
    // Too many step sections for the block budget — keep the first ones and
    // fold the remainder into a single summary line so we stay under the cap.
    const keep = Math.max(1, stepBudget - 1);
    for (let i = 0; i < keep; i++) blocks.push(section(sections[i]));
    const foldedSteps = sections
      .slice(keep)
      .reduce((n, s) => n + s.split("\n").length, 0);
    blocks.push(section(`… _and ${foldedSteps} more steps_`));
  }

  if (model.footer?.trim()) blocks.push(context([markdownToSlackMrkdwn(model.footer)]));

  return blocks;
}

/**
 * Render an approval prompt with interactive Approve/Reject buttons. Each
 * button carries `workflowRunId` as its `value` so the interaction handler
 * resolves the exact paused gate. The section text is the same rendered prompt
 * a markdown-only surface would post (kept under Slack's section limit).
 */
export function renderApprovalBlocks(prompt: string, workflowRunId: string): KnownBlock[] {
  const text = markdownToSlackMrkdwn(prompt);
  const clamped =
    text.length > MAX_SECTION_CHARS ? text.slice(0, MAX_SECTION_CHARS - 1) + "…" : text;
  return [
    section(clamped),
    {
      type: "actions",
      block_id: "approval_actions",
      elements: [
        {
          type: "button",
          action_id: "approval_approve",
          style: "primary",
          text: { type: "plain_text", text: "Approve", emoji: true },
          value: workflowRunId,
        },
        {
          type: "button",
          action_id: "approval_reject",
          style: "danger",
          text: { type: "plain_text", text: "Reject", emoji: true },
          value: workflowRunId,
        },
      ],
    },
  ];
}
