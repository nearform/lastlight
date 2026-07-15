/**
 * One-off: generate two Slack message payloads that exercise every formatting
 * path Last Light produces, using the REAL renderers so the output matches
 * production. Writes /tmp/msg1.json (Block Kit progress) + /tmp/msg2.json
 * (chat mrkdwn + tables). Run: npx tsx scripts/slack-format-demo.ts <channelId>
 */
import { writeFileSync } from "node:fs";
import { renderProgressBlocks } from "../src/notify/blocks.js";
import {
  hasMarkdownImage,
  markdownToSlackBlocks,
  markdownToSlackMrkdwn,
} from "../src/connectors/slack/mrkdwn.js";
import type { ProgressModel } from "../src/notify/types.js";

const channel = process.argv[2];
if (!channel) throw new Error("usage: slack-format-demo.ts <channelId>");

// ── Message 1: Block Kit progress surface (renderProgressBlocks) ─────────────
const model: ProgressModel = {
  title: "build for #42 — add Slack rich formatting",
  subtitle: "Wire Block Kit progress + interactive approvals",
  meta: [
    "Repo: `nearform/lastlight`",
    "Branch: [lastlight/42-slack-formatting](https://github.com/nearform/lastlight/tree/lastlight/42-slack-formatting)",
    "Model: `anthropic/claude-opus-4-8`",
  ],
  steps: [
    { key: "context", label: "Context", status: "done", detail: "loaded issue + repo" },
    { key: "architect", label: "Architect", status: "done", detail: "[plan.md](https://nearform.lastlight.dev/admin) written" },
    { key: "executor", label: "Executor", status: "running", detail: "editing 6 files" },
    { key: "reviewer", label: "Reviewer", status: "pending" },
    { key: "guardrails", label: "Guardrails", status: "blocked", detail: "waiting on executor" },
    { key: "flaky", label: "Flaky check", status: "failed", detail: "1 test retried" },
    { key: "skipped_qa", label: "Browser QA", status: "skipped", detail: "no QA image" },
    { key: "approval", label: "Approval", status: "awaiting", detail: "needs a human :eyes:" },
    { key: "pr", label: "Open PR", status: "pending" },
  ],
  footer: "Artifacts: [view run](https://nearform.lastlight.dev/admin)",
};

writeFileSync(
  "/tmp/msg1.json",
  JSON.stringify({
    channel,
    text: "Last Light — Block Kit progress surface (all step states)",
    blocks: renderProgressBlocks(model),
  }),
);

// ── Message 2: chat reply mrkdwn + both table renderings ─────────────────────
const doc = `# Chat reply formatting

**Bold**, _italic_, ~~strikethrough~~, and \`inline code\` all convert to Slack mrkdwn.

Here is a [link to the dashboard](https://nearform.lastlight.dev/admin) and an image ![logo](https://nearform.lastlight.dev/logo.png).

> Block quotes pass straight through to Slack.

\`\`\`ts
// fenced code blocks are preserved (language hint stripped)
const answer = 6 * 7;
\`\`\`

## A normal table → aligned monospace block

| Phase | Status | Notes |
|-----------|-----------|--------------------|
| Architect | done | plan written |
| Executor | running | implementing edits |
| Reviewer | pending | queued behind exec |

## A wide 2-column table → \`label: value\` fallback

| Setting | Value |
|---------|-------------------------------------------------------------------------------|
| egress | strict allowlist: github.com, api.anthropic.com, registry.npmjs.org, and more |
| sandbox | gondolin micro-VM with an IP-pinned per-host egress filter resolved at boot |

---

That covers the mrkdwn + table paths.`;

writeFileSync(
  "/tmp/msg2.json",
  JSON.stringify({ channel, text: markdownToSlackMrkdwn(doc) }),
);

// ── Message 3: inline image (markdownToSlackBlocks, as the connector does) ────
const imageDoc =
  "*Inline image demo* — a markdown image now renders as a real Block Kit `image` block:\n\n" +
  "![A random placeholder photo](https://picsum.photos/id/237/480/240.jpg)\n\n" +
  "…text before and after the image is kept as section blocks.";

writeFileSync(
  "/tmp/msg3.json",
  JSON.stringify({
    channel,
    text: markdownToSlackMrkdwn(imageDoc), // notification fallback
    blocks: hasMarkdownImage(imageDoc) ? markdownToSlackBlocks(imageDoc) : undefined,
  }),
);

console.log("wrote /tmp/msg1.json (blocks) + /tmp/msg2.json (mrkdwn) + /tmp/msg3.json (image)");
