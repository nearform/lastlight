import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  DEP_TRIVIAL_LABEL,
  DEP_FUNCTIONAL_LABEL,
  REQUIRES_HUMAN_LABEL,
} from "#src/cron/dependabot-discovery.js";

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
});
