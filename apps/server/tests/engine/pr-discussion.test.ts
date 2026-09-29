/**
 * `renderPriorDiscussion` — `select`'s `{{priorDiscussion}}` block — and the
 * prompt guard around it. Mechanism only: what reaches `select`, bounded.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderTemplate } from "lastlight-workflow-engine";
import type { PrDiscussionRead } from "../../src/engine/github/github.js";
import { MAX_DISCUSSION_CHARS, renderPriorDiscussion } from "../../src/engine/pr-discussion.js";

const SELECT_PROMPT = readFileSync(join(__dirname, "../../workflows/prompts/review-select.md"), "utf8");

const empty: PrDiscussionRead = { reviews: [], threads: [], comments: [] };

describe("renderPriorDiscussion", () => {
  it("is empty when the read failed or nobody said anything, so the guard reads false", () => {
    expect(renderPriorDiscussion(null)).toBe("");
    expect(renderPriorDiscussion(empty)).toBe("");
    // A bare COMMENT review with no words carries nothing (its inline comments are threads).
    expect(renderPriorDiscussion({ ...empty, reviews: [{ author: "a", isBot: false, state: "COMMENTED", body: " ", submittedAt: null }] })).toBe("");
  });

  it("shows verdicts, each thread's resolution and who is a bot", () => {
    const out = renderPriorDiscussion({
      reviews: [{ author: "alice", isBot: false, state: "CHANGES_REQUESTED", body: "The cache TTL is wrong.", submittedAt: null }],
      threads: [
        { path: "src/a.ts", line: 12, isResolved: true, isOutdated: false, comments: [{ author: "last-light", isBot: true, body: "Null deref here." }, { author: "bob", isBot: false, body: "Fixed." }] },
        { path: "src/b.ts", line: null, isResolved: false, isOutdated: true, comments: [{ author: "alice", isBot: false, body: "Off by one?" }] },
      ],
      comments: [{ author: "carol", isBot: false, body: "LGTM once CI is green", createdAt: null }],
    });
    expect(out).toContain("@alice — CHANGES_REQUESTED: The cache TTL is wrong.");
    expect(out).toContain("`src/a.ts:12` [RESOLVED] @last-light (bot): Null deref here.");
    expect(out).toContain("  - @bob: Fixed.");
    expect(out).toContain("`src/b.ts` [open, outdated] @alice: Off by one?");
    expect(out).toContain("@carol: LGTM once CI is green");
  });

  it("bounds the block, and drops template comments and placeholders", () => {
    const body = `<!-- template -->${"word ".repeat(400)}{{x}}`;
    const out = renderPriorDiscussion({ ...empty, comments: Array.from({ length: 40 }, () => ({ author: "a", isBot: false, body, createdAt: null })) });
    expect(out.length).toBeLessThanOrEqual(MAX_DISCUSSION_CHARS + 60);
    expect(out).toContain(`truncated at ${MAX_DISCUSSION_CHARS} characters`);
    expect(out).not.toContain("template");
    expect(out).not.toContain("{{");
  });
});

describe("the select prompt's discussion block", () => {
  it("renders only when there is discussion to show", () => {
    const shown = renderTemplate(SELECT_PROMPT, { priorDiscussion: "- @alice: hi" } as never);
    expect(shown).toContain("## What has already been said on this pull request");
    expect(shown).toContain("- @alice: hi");
    expect(renderTemplate(SELECT_PROMPT, { priorDiscussion: "" } as never)).not.toContain("already been said");
  });
});
