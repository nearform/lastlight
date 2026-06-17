/**
 * The single shared renderer. Turns a {@link ProgressModel} into markdown.
 * GitHub posts the output as-is; the Slack transport converts it via
 * `markdownToSlackMrkdwn` first. There is exactly one renderer so the two
 * platforms can never drift in content.
 */
import type { ProgressModel, StepStatus } from "./types.js";

/** Status → leading emoji. Ported from the Mastra rebuild's EMOJI map. */
export const STATUS_EMOJI: Record<StepStatus, string> = {
  pending: "⬜",
  running: "🔄",
  done: "✅",
  blocked: "⛔",
  awaiting: "⏸️",
  failed: "❌",
  skipped: "➖",
};

/** Render the model to a single markdown body. */
export function renderProgress(model: ProgressModel): string {
  const lines: string[] = [];

  lines.push(`### 🤖 ${model.title}`);
  if (model.subtitle) {
    lines.push("");
    lines.push(`**${model.subtitle}**`);
  }
  if (model.meta && model.meta.length > 0) {
    lines.push("");
    for (const m of model.meta) if (m.trim()) lines.push(m);
  }

  lines.push("");
  for (const step of model.steps) {
    const emoji = STATUS_EMOJI[step.status] ?? STATUS_EMOJI.pending;
    const detail = step.detail ? ` — ${step.detail}` : "";
    lines.push(`- ${emoji} **${step.label}**${detail}`);
  }

  if (model.footer && model.footer.trim()) {
    lines.push("");
    lines.push(model.footer);
  }

  return lines.join("\n");
}

/** Markdown link `[text](url)` → its visible text, for length measurement. */
const visibleText = (s: string): string => s.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");

/**
 * Collapse a rendered multi-line message into a compact one-line checklist
 * detail: the first non-empty line, capped on *visible* length. The cap
 * measures the rendered length (a markdown link counts as just its link
 * text, not its URL) so a short label backed by a long URL is kept whole —
 * truncating the raw string would slice through the URL and break the link.
 * When a detail is genuinely too long, the link-stripped form is truncated,
 * which can never produce a broken link.
 */
export function collapseDetail(s: string): string | undefined {
  const first = s
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!first) return undefined;
  if (visibleText(first).length <= 160) return first;
  return `${visibleText(first).slice(0, 159)}…`;
}
