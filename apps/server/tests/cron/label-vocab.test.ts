import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEP_TRIVIAL_LABEL,
  DEP_FUNCTIONAL_LABEL,
  REQUIRES_HUMAN_LABEL,
  DEP_MAJOR_LOW_LABEL,
  DEP_MAJOR_LOW_COLOR,
  DEP_MAJOR_MEDIUM_LABEL,
  DEP_MAJOR_MEDIUM_COLOR,
  DEP_MAJOR_HIGH_LABEL,
  DEP_MAJOR_HIGH_COLOR,
  HOLD_LABEL,
  HOLD_LABEL_COLOR,
} from "#src/cron/dependabot-discovery.js";
import { getHoldLabel } from "#src/config/config.js";

/**
 * Sync guard: the dependency-PR lifecycle labels live in code
 * (dependabot-discovery.ts, where the cron's `requires-human` exclusion imports
 * them) but the dependabot PROMPTS hardcode the same strings (markdown can't
 * import). This test asserts the prompts contain the exact strings so the two
 * never drift — if you rename a constant, a prompt must change with it.
 */
const promptPath = (name: string) =>
  fileURLToPath(new URL(`../../workflows/prompts/${name}`, import.meta.url));

const read = (name: string) => readFileSync(promptPath(name), "utf8");

describe("dependency-PR label vocabulary is in sync with the prompts", () => {
  it("dependabot-pr-merge.md applies all three lifecycle labels", () => {
    const md = read("dependabot-pr-merge.md");
    expect(md).toContain(DEP_TRIVIAL_LABEL);
    expect(md).toContain(DEP_FUNCTIONAL_LABEL);
    expect(md).toContain(REQUIRES_HUMAN_LABEL);
  });

  it("dependabot-ci-fix.md flags the give-up path with requires-human", () => {
    const md = read("dependabot-ci-fix.md");
    expect(md).toContain(REQUIRES_HUMAN_LABEL);
  });

  // Issue #252 / 05-impact.md §5.4. The three impact labels are additive — the
  // trivial/functional pair keeps its meaning — but they carry the same drift
  // risk, and one more besides: the COLOUR is part of the contract, because
  // `github_ensure_labels` creates a missing label with whatever hex the prompt
  // names. Code and prompt disagreeing there produces two vocabularies on the
  // same repo, which no amount of name-matching would catch.
  it("dependabot-pr-merge.md carries the three major-impact labels", () => {
    const md = read("dependabot-pr-merge.md");
    for (const label of [DEP_MAJOR_LOW_LABEL, DEP_MAJOR_MEDIUM_LABEL, DEP_MAJOR_HIGH_LABEL]) {
      expect(md).toContain(label);
    }
  });

  it("dependabot-pr-merge.md creates each impact label with the colour in code", () => {
    const md = read("dependabot-pr-merge.md");
    const pairs: Array<[string, string]> = [
      [DEP_MAJOR_LOW_LABEL, DEP_MAJOR_LOW_COLOR],
      [DEP_MAJOR_MEDIUM_LABEL, DEP_MAJOR_MEDIUM_COLOR],
      [DEP_MAJOR_HIGH_LABEL, DEP_MAJOR_HIGH_COLOR],
    ];
    for (const [label, color] of pairs) {
      expect(md).toContain(`\`${label}\` — color \`${color}\``);
    }
  });
});

/**
 * The HOLD label (02-hold-label.md). Same drift risk as the six above and one
 * more besides: this is the ONE label the harness READS, so a prompt that
 * created a differently-spelled label would leave maintainers applying a label
 * that stops nothing — the failure mode with no symptom until it matters.
 */
describe("the hold label is in sync with the prompt and with config", () => {
  it("dependabot-pr-merge.md creates it, with the colour in code", () => {
    const md = read("dependabot-pr-merge.md");
    expect(md).toContain(`\`${HOLD_LABEL}\` — color \`${HOLD_LABEL_COLOR}\``);
  });

  it("the packaged default is what the code gates on out of the box", () => {
    // `hold.label` in `config/default.yaml` is what `getHoldLabel()` returns,
    // and the constant is what the prompt creates. If those two ever disagree,
    // the label the operator's repos get is not the label the gate checks.
    expect(getHoldLabel()).toBe(HOLD_LABEL);
  });

  it("the prompt tells the agent never to touch it", () => {
    // A maintainer-only label the merge agent could remove would be a hold the
    // bot lifts off itself.
    const md = read("dependabot-pr-merge.md");
    expect(md).toMatch(/never applied or removed by you/i);
    expect(md).toMatch(new RegExp(`never \`${HOLD_LABEL}\``));
  });

  it("both dependabot prompts stop claiming requires-human holds anything", () => {
    // It is a NOTIFICATION now — read by nothing. A prompt that still told the
    // agent "the harness reads this label as OURS" would be teaching the model
    // a state machine that no longer exists, and the agent quotes prompts at
    // maintainers in its summaries.
    for (const name of ["dependabot-pr-merge.md", "dependabot-ci-fix.md"]) {
      const md = read(name);
      expect(md).toContain(REQUIRES_HUMAN_LABEL);
      expect(md).not.toMatch(/reads (the label|a label on a PR it has worked) as OURS/);
      expect(md).toMatch(/NOTIFICATION,\s+not\s+a stop/);
    }
  });
});
