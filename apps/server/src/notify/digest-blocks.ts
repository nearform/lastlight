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
 *
 * ## Everything here is untrusted input
 *
 * Issue titles, pull-request titles and the model's summary are all written by
 * people who are not the operator, and they land in a Slack channel unedited.
 * Slack's control sequences are plain text — `<!channel>` in an issue title
 * notifies the whole channel — so every one of those strings goes through
 * {@link escapeSlack} before it is composed into a line. That escape happens
 * BEFORE any link markdown is added, which is what lets the two coexist: the
 * only angle brackets that survive to `markdownToSlackMrkdwn` are the ones this
 * module put there.
 */

import type { KnownBlock } from "@slack/web-api";
import { markdownToSlackMrkdwn, MAX_SECTION_CHARS } from "../connectors/slack/mrkdwn.js";

/** One line of an enumerated list — a merged PR, an opened issue, a closed issue. */
export interface DigestItem {
  number: number;
  title: string;
  /** GitHub's own URL for the item. Never reconstructed from the number. */
  url: string;
  author: string;
  /** Issues this merged pull request is judged to have closed. */
  closes?: Array<{ number: number; url: string }>;
  /** A qualifier the reader needs — `not planned`, `duplicate`. */
  note?: string;
}

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

  // The week's content. Empty when the enrichment fetch failed — the digest
  // then renders exactly as it did before these lists existed, which is why
  // nothing below treats an empty list as an error.
  /** Human-authored merged pull requests, newest first. */
  merged: DigestItem[];
  /** Merged pull requests folded out of that list because a bot opened them. */
  mergedByBots: number;
  newIssues: DigestItem[];
  /** Closed issues MINUS the ones a listed merged PR closed. */
  closedIssues: DigestItem[];
  /** How many closed issues were folded into the merged list above. */
  closedByMergedPr: number;
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

/**
 * A reference as a markdown link — `[#294](https://github.com/…)`.
 *
 * Markdown, not Slack's own `<url|text>`: `renderDigest` passes every line
 * through `markdownToSlackMrkdwn`, which converts links itself. Emitting
 * `<url|#294>` here would go through that converter a second time and come out
 * escaped. Doing it this way also means the fallback `text` and the block
 * bodies get the same links, because both are built from the same lines.
 */
function ref(number: number, url: string): string {
  return `[#${number}](${url})`;
}

/**
 * The URL of an OPEN PULL REQUEST, by number.
 *
 * Only for the two lists that carry no URL of their own — the oldest unreviewed
 * PR and the escalated ones, both of which come from `listOpenPullRequests`, so
 * `/pull/` is always right. Everything else renders `item.url`, which is
 * GitHub's own answer and correct for issues and pull requests alike.
 */
function prUrl(repo: string, number: number): string {
  return `https://github.com/${repo}/pull/${number}`;
}

/**
 * Neutralize Slack's control sequences in text we did not write.
 *
 * `<!channel>`, `<!here>` and `<@U123>` are not markup a formatter strips —
 * Slack interprets them on the way in, so an issue titled `<!channel> ship it`
 * notifies everyone in the channel every Monday morning. Escaping the three
 * characters Slack reserves is the documented fix and it is enough: the
 * sequences all require a literal `<`.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Turn the model's bare `#123` references into links — but only the ones this
 * digest can vouch for.
 *
 * The summary is asked to cite work by number and forbidden to write URLs, so
 * the URL is built here, from the same fact set the summary was written about.
 * A number the digest has never heard of is left as plain text: a hallucinated
 * reference then reads as an unremarkable `#999` rather than as a confident
 * link to somebody else's pull request.
 *
 * Runs on ALREADY-ESCAPED text and emits markdown, so the angle brackets that
 * `markdownToSlackMrkdwn` later produces are unambiguously ours. The lookbehind
 * keeps it off URL fragments (`…/file.md#12`) and hex colours (`#123456` — the
 * trailing `\b` alone would not save `#123` inside it).
 */
export function linkifyRefs(text: string, urls: Map<number, string>): string {
  return text.replace(/(?<![\w#/&-])#(\d+)\b/g, (whole, digits: string) => {
    const url = urls.get(Number(digits));
    return url ? ref(Number(digits), url) : whole;
  });
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

  const summary = narrative?.trim() ? linkifyRefs(escapeSlack(narrative.trim()), knownUrls(facts)) : "";

  const mergedLines = itemLines(r.merged, r.prsMerged, {
    extra: r.mergedByBots > 0 ? `plus ${count(r.mergedByBots, "bot PR")}` : undefined,
  });
  const newIssueLines = itemLines(r.newIssues, r.issuesOpened);
  const closedLines = itemLines(r.closedIssues, r.issuesClosed, {
    extra: r.closedByMergedPr > 0 ? `${r.closedByMergedPr} by merged PRs above` : undefined,
  });

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
      `• Oldest unreviewed: ${ref(r.oldestAwaiting.number, prUrl(repo, r.oldestAwaiting.number))} ${escapeSlack(truncate(r.oldestAwaiting.title))} — open ${count(r.oldestAwaiting.ageDays, "day")}`,
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
        r.escalated.map((p) => ref(p.number, prUrl(repo, p.number))).join(", "),
    );
  }

  // Every section is built once, as markdown, and converted once — so `text`
  // and the block bodies can never disagree about what the digest said. A
  // section with no lines is dropped entirely rather than printed empty, which
  // is what keeps a quiet week's digest short.
  const sections: Array<{ heading: string; lines: string[] }> = [
    ...(mergedLines ? [{ heading: `Merged${headingCount(r.merged, r.prsMerged)}`, lines: mergedLines }] : []),
    ...(newIssueLines
      ? [{ heading: `New issues${headingCount(r.newIssues, r.issuesOpened)}`, lines: newIssueLines }]
      : []),
    ...(closedLines
      ? [{ heading: `Closed issues${headingCount(r.closedIssues, r.issuesClosed)}`, lines: closedLines }]
      : []),
    { heading: "Repo", lines: repoLines },
    { heading: "Last Light", lines: botLines },
  ];

  const markdown = [
    `## ${escapeSlack(title)}`,
    summary ? `\n${summary}` : "",
    ...sections.map((s) => `\n**${s.heading}**\n${s.lines.join("\n")}`),
  ]
    .filter(Boolean)
    .join("\n");

  const blocks: KnownBlock[] = [
    { type: "header", text: { type: "plain_text", text: truncate(title, 150), emoji: true } },
  ];
  if (summary) blocks.push({ type: "section", text: { type: "mrkdwn", text: markdownToSlackMrkdwn(summary) } });
  for (const s of sections) blocks.push(sectionBlock(`*${s.heading}*`, s.lines));
  blocks.push({
    type: "context",
    elements: [{ type: "mrkdwn", text: `${formatDay(facts.since)} → ${formatDay(facts.until)}` }],
  });

  return { text: markdownToSlackMrkdwn(markdown), blocks };
}

/**
 * The bullet lines for one enumerated list, or `undefined` when there is
 * nothing to print.
 *
 * `total` is the authoritative count from the arithmetic half, not
 * `items.length` — the list is capped for display, so the tail line has to be
 * driven by the real number or a repo with 30 merged PRs would claim to have
 * had 10.
 */
function itemLines(items: DigestItem[], total: number, opts: { extra?: string } = {}): string[] | undefined {
  if (items.length === 0) return undefined;
  const lines = items.map((item) => {
    const closes = item.closes?.length
      ? ` (closes ${item.closes.map((c) => ref(c.number, c.url)).join(", ")})`
      : "";
    const note = item.note ? ` — ${escapeSlack(item.note)}` : "";
    const author = item.author ? ` — @${escapeSlack(item.author)}` : "";
    return `• ${ref(item.number, item.url)} ${escapeSlack(truncate(item.title, 80))}${closes}${note}${author}`;
  });
  const hidden = total - items.length;
  const tail = [hidden > 0 ? `…and ${hidden} more` : "", opts.extra ?? ""].filter(Boolean).join(" · ");
  if (tail) lines.push(`• _${tail}_`);
  return lines;
}

/** `Merged (6)` — the real total, so the heading and the capped list agree. */
function headingCount(items: DigestItem[], total: number): string {
  return ` (${Math.max(total, items.length)})`;
}

/**
 * One section, split if it would exceed Slack's per-section text limit.
 *
 * Slack rejects an over-long section by failing the WHOLE message with
 * `invalid_blocks`, and the digest passes explicit blocks, so the connector's
 * text-only retry does not apply — an unclamped section costs the repo its
 * digest and then fails the tick.
 */
function sectionBlock(heading: string, lines: string[]): KnownBlock {
  const body = markdownToSlackMrkdwn(lines.join("\n"));
  const room = MAX_SECTION_CHARS - heading.length - 1;
  return {
    type: "section",
    text: { type: "mrkdwn", text: `${heading}\n${body.length > room ? `${body.slice(0, room - 1)}…` : body}` },
  };
}

/** Every number this digest can turn into a link, with the URL to use. */
function knownUrls(facts: DigestFacts): Map<number, string> {
  const urls = new Map<number, string>();
  const { repo, repoFacts: r } = facts;
  for (const list of [r.merged, r.newIssues, r.closedIssues]) {
    for (const item of list) {
      if (item.url) urls.set(item.number, item.url);
      for (const closed of item.closes ?? []) if (closed.url) urls.set(closed.number, closed.url);
    }
  }
  for (const p of r.escalated) urls.set(p.number, prUrl(repo, p.number));
  if (r.oldestAwaiting) urls.set(r.oldestAwaiting.number, prUrl(repo, r.oldestAwaiting.number));
  return urls;
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
