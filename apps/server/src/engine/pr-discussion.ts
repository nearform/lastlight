/**
 * The PR's prior conversation as the bounded block `select` reads
 * (`{{priorDiscussion}}` in `workflows/prompts/review-select.md`).
 *
 * Why `select` and not the investigators: the old whole-diff reviewer read the
 * discussion first (the `pr-review` skill's §2 — don't repeat what was raised,
 * treat a resolved thread as done) and the `sites` engine dropped it. Deduping
 * against it is a selection job; handing it to an investigator would anchor it
 * the way summarised leads did (arm C halved precision,
 * docs/plans/adjudicate-falsify-replay.md).
 *
 * Pure: `resolveSpecContext` reads the discussion, this renders it.
 */
import type { PrDiscussionRead } from "./github/github.js";

/** Each body's budget in the rendered block. */
export const MAX_DISCUSSION_BODY_CHARS = 400;
/** The whole block's budget. */
export const MAX_DISCUSSION_CHARS = 8000;

function oneLine(body: string): string {
  const flat = body
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/\{\{/g, "{ {")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > MAX_DISCUSSION_BODY_CHARS ? `${flat.slice(0, MAX_DISCUSSION_BODY_CHARS)}…` : flat;
}

const who = (a: { author: string; isBot: boolean }) => `@${a.author}${a.isBot ? " (bot)" : ""}`;

/**
 * `""` when there is nothing to show — no read (`null`), or a PR nobody has
 * said anything on — so `{{#if priorDiscussion}}` reads false.
 */
export function renderPriorDiscussion(d: PrDiscussionRead | null): string {
  if (!d) return "";
  const out: string[] = [];

  // A review with neither a verdict nor words carries nothing (a bare COMMENT
  // wrapper around inline comments — those appear under the threads).
  const reviews = d.reviews.filter((r) => r.state === "CHANGES_REQUESTED" || r.state === "APPROVED" || r.body.trim());
  if (reviews.length) {
    out.push("**Reviews** (oldest first):", "");
    for (const r of reviews) out.push(`- ${who(r)} — ${r.state}${r.body.trim() ? `: ${oneLine(r.body)}` : ""}`);
    out.push("");
  }

  const threads = d.threads.filter((t) => t.comments.length);
  if (threads.length) {
    out.push("**Inline threads:**", "");
    for (const t of threads) {
      const status = [t.isResolved ? "RESOLVED" : "open", ...(t.isOutdated ? ["outdated"] : [])].join(", ");
      const [first, ...replies] = t.comments;
      out.push(`- \`${t.path}${t.line ? `:${t.line}` : ""}\` [${status}] ${who(first)}: ${oneLine(first.body)}`);
      for (const r of replies) out.push(`  - ${who(r)}: ${oneLine(r.body)}`);
    }
    out.push("");
  }

  const comments = d.comments.filter((c) => c.body.trim());
  if (comments.length) {
    out.push("**Comments** (oldest first):", "");
    for (const c of comments) out.push(`- ${who(c)}: ${oneLine(c.body)}`);
    out.push("");
  }

  const text = out.join("\n").trimEnd();
  return text.length > MAX_DISCUSSION_CHARS
    ? `${text.slice(0, MAX_DISCUSSION_CHARS).trimEnd()}\n… truncated at ${MAX_DISCUSSION_CHARS} characters`
    : text;
}
