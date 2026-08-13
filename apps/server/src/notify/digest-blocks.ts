/**
 * Rendering for the weekly repo digest.
 *
 * Kept apart from the digest's data gathering (`cron/repo-digest.ts`) for one
 * reason: this half is pure. Facts in, `{ text, blocks }` out — no clock, no
 * network, no database — so the wording and the arithmetic can be tested
 * independently and neither has to mock the other.
 *
 * `text` is not a fallback afterthought. Slack shows it in notifications and in
 * clients that don't render blocks, so it carries the same content, not a
 * placeholder.
 */

import type { KnownBlock } from "@slack/web-api";
import { markdownToSlackMrkdwn } from "../connectors/slack/mrkdwn.js";

/** The GitHub half of a digest. */
export interface RepoFacts {
  prsOpened: number;
  prsMerged: number;
  /** Closed WITHOUT merging — deliberately not folded into a single "closed". */
  prsClosedUnmerged: number;
  issuesOpened: number;
  issuesClosed: number;
  openPrs: number;
  awaitingReview: number;
  oldestAwaiting?: { number: number; title: string; ageDays: number };
  /** Open PRs carrying the escalation label — the "a human is needed" list. */
  escalated: Array<{ number: number; title: string }>;
}

/** The Last Light half. */
export interface BotFacts {
  runs: number;
  failed: number;
  byWorkflow: Record<string, number>;
  costUsd: number;
  phases: number;
}

export interface DigestFacts {
  /** `owner/repo`. */
  repo: string;
  since: string;
  until: string;
  windowDays: number;
  repoFacts: RepoFacts;
  botFacts: BotFacts;
}

/** How a workflow name reads in a sentence. Unknown names fall through verbatim. */
const WORKFLOW_LABELS: Record<string, string> = {
  "pr-review": "reviewed",
  "pr-fix": "fixed",
  "dependabot-ci-fix": "fixed CI on",
  "dependabot-pr-merge": "merged dependency",
  "issue-triage": "triaged",
  build: "built",
  explore: "explored",
  "security-review": "security-scanned",
};

export function renderDigest(facts: DigestFacts, narrative?: string): { text: string; blocks: KnownBlock[] } {
  const { repo, repoFacts: r, botFacts: b } = facts;
  const title = `${repo} — ${facts.windowDays === 7 ? "week" : `${facts.windowDays} days`} to ${formatDay(facts.until)}`;

  const repoLines: string[] = [];
  repoLines.push(
    `• ${count(r.prsMerged, "PR")} merged, ${r.prsOpened} opened` +
      (r.prsClosedUnmerged > 0 ? `, ${r.prsClosedUnmerged} closed unmerged` : ""),
  );
  repoLines.push(`• ${count(r.issuesClosed, "issue")} closed, ${r.issuesOpened} opened`);
  repoLines.push(
    `• ${count(r.openPrs, "PR")} open` +
      (r.awaitingReview > 0 ? ` (${r.awaitingReview} awaiting review)` : ""),
  );
  if (r.oldestAwaiting) {
    repoLines.push(
      // Plain `#N`, deliberately: `<#…>` is Slack's CHANNEL reference syntax
      // and would render a PR number as a broken channel link.
      `• Oldest unreviewed: #${r.oldestAwaiting.number} ${truncate(r.oldestAwaiting.title)} — open ${count(r.oldestAwaiting.ageDays, "day")}`,
    );
  }

  const botLines: string[] = [];
  if (b.runs === 0) {
    botLines.push("• No runs this period.");
  } else {
    botLines.push(`• ${count(b.runs, "run")} — ${b.runs - b.failed} ok, ${b.failed} failed`);
    const work = describeWork(b.byWorkflow);
    if (work) botLines.push(`• ${work}`);
    if (b.costUsd > 0) botLines.push(`• $${b.costUsd.toFixed(2)} across ${count(b.phases, "phase")}`);
  }
  if (r.escalated.length > 0) {
    botLines.push(
      `• ⚠️ ${count(r.escalated.length, "PR")} waiting on a human: ` +
        r.escalated.map((p) => `#${p.number}`).join(", "),
    );
  }

  // Markdown first, then one conversion — so `text` and the block bodies can
  // never disagree about what the digest said.
  const markdown = [
    `## ${title}`,
    narrative?.trim() ? `\n${narrative.trim()}` : "",
    `\n**Repo**\n${repoLines.join("\n")}`,
    `\n**Last Light**\n${botLines.join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: truncate(title, 150), emoji: true } },
  ];
  if (narrative?.trim()) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: markdownToSlackMrkdwn(narrative.trim()) } });
  }
  blocks.push(sectionBlock("*Repo*", repoLines));
  blocks.push(sectionBlock("*Last Light*", botLines));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${formatDay(facts.since)} → ${formatDay(facts.until)}` }],
  });

  return { text: markdownToSlackMrkdwn(markdown), blocks };
}

function sectionBlock(heading: string, lines: string[]): KnownBlock {
  return {
    type: "section",
    text: { type: "mrkdwn", text: `${heading}\n${markdownToSlackMrkdwn(lines.join("\n"))}` },
  };
}

/**
 * "reviewed 6 PRs · fixed CI on 3" — the bot's week in verbs.
 *
 * Sorted by volume so the headline activity leads, and capped at three so a
 * repo running every workflow doesn't produce a paragraph.
 */
function describeWork(byWorkflow: Record<string, number>): string {
  const parts = Object.entries(byWorkflow)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([name, n]) => `${WORKFLOW_LABELS[name] ?? name} ${n}`);
  return parts.join(" · ");
}

/** Pluralize without a library. `1 PR`, `2 PRs`. */
function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function truncate(text: string, max = 60): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** `9 Aug` — a digest is read at a glance, not parsed. */
function formatDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}
