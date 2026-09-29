/**
 * `renderPrIntent` — the site investigator's `{{prIntent}}` block — and the
 * prompt's guard around it. Mechanism only (what reaches the prompt, bounded
 * and stripped); whether it helps the investigator is the replay's question.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { renderTemplate } from "lastlight-workflow-engine";
import { MAX_PR_INTENT_BODY_CHARS, MAX_PR_INTENT_ISSUES, renderPrIntent } from "../../src/engine/pr-intent.js";
import { renderContext } from "../../src/engine/pr-decisions.js";
import { defaultReviewConfig } from "../../src/config/config.js";
import type { PrState } from "../../src/engine/pr-state.js";

const SITE_PROMPT = readFileSync(join(__dirname, "../../workflows/prompts/review-site.md"), "utf8");

describe("renderPrIntent", () => {
  it("is empty when the PR says nothing, so the prompt's guard reads false", () => {
    expect(renderPrIntent({ title: "", body: "", closes: [] })).toBe("");
    expect(renderPrIntent({})).toBe("");
  });

  it("strips the PR template's HTML comments — words the author never wrote", () => {
    const out = renderPrIntent({ title: "Fix cache", body: "Closes #1\r\n\r\n<!--- Please read the guide -->\r\nKeeps TTL at 120s." });
    expect(out).toContain("Keeps TTL at 120s.");
    expect(out).not.toContain("Please read the guide");
    expect(out).not.toContain("\r");
  });

  it("bounds the body and the linked issues, and says when it cut", () => {
    const out = renderPrIntent({
      body: "x".repeat(MAX_PR_INTENT_BODY_CHARS + 50),
      closes: [1, 2, 3].map((n) => ({ number: n, title: `issue ${n}`, body: "b" })),
    });
    expect(out).toContain(`truncated at ${MAX_PR_INTENT_BODY_CHARS} characters`);
    expect(out.match(/\*\*Closes #/g)).toHaveLength(MAX_PR_INTENT_ISSUES);
  });

  it("breaks up `{{` so the text can never read as a placeholder", () => {
    expect(renderPrIntent({ body: "use {{name}} here" })).not.toContain("{{");
  });
});

describe("the site prompt's intent block", () => {
  it("renders the block only when there is intent to show", () => {
    const withIntent = renderTemplate(SITE_PROMPT, { prIntent: renderPrIntent({ title: "Fix cache" }) } as never);
    expect(withIntent).toContain("## What the author says this PR does");
    expect(withIntent).toContain("Fix cache");
    const without = renderTemplate(SITE_PROMPT, { prIntent: "" } as never);
    expect(without).not.toContain("## What the author says this PR does");
  });

  it("is projected from the PR snapshot only with the analysis pipeline on", () => {
    const state = { title: "Fix cache", body: "Keeps TTL.", closes: [], changedFiles: [] } as unknown as PrState;
    const on = defaultReviewConfig();
    on.analysis.enabled = true;
    const ctxOn = renderContext(state, undefined, undefined, on) as Record<string, unknown>;
    expect(ctxOn.prIntent).toContain("Keeps TTL.");
    const ctxOff = renderContext(state, undefined, undefined, defaultReviewConfig()) as Record<string, unknown>;
    expect(ctxOff.prIntent).toBeUndefined();
  });
});
