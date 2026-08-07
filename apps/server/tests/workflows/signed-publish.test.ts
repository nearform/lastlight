import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One unsigned commit anywhere in a branch blocks a `required_signatures` PR
 * permanently, and no later run can clear it (issue #268). So no packaged
 * prompt may tell the agent to build the published commit locally — the whole
 * point of `github_publish` is that GitHub builds and signs it.
 */
const PROMPTS_DIR = join(import.meta.dirname, "../../workflows/prompts");

/**
 * `git push` is the load-bearing prohibition. A local `git commit` is NOT —
 * `dependabot-ci-fix.md` completes a base merge with `git add -A && git commit
 * --no-edit`, and that is exactly the scratch working state the design permits.
 * What must never happen is a locally-built commit reaching the branch.
 *
 * This matches an INVOCATION: `git push` carrying an argument (`origin HEAD`,
 * `-u origin HEAD`). It deliberately does NOT match a bare mention inside
 * backticks — ``Do NOT use `git commit` / `git push`.`` — because every such
 * mention in these prompts is a prohibition, and those are the wording we want
 * to keep. `\s+` rather than a literal space so a hard-wrapped `git\npush
 * origin HEAD` cannot slip through the line breaks these files are full of.
 */
const FORBIDDEN_PUSH = /git\s+push\s+\S/;

/**
 * Prompts whose phase publishes the agent's work. Listed explicitly, because
 * this is the closure half of the guard: FORBIDDEN_PUSH stops a prompt
 * regressing to `git push`, and this stops one losing its publish step
 * altogether — or quietly swapping to a tool that does not produce a signed
 * commit (`github_push_files`, `github_create_or_update_file`).
 */
const PUBLISHING_PROMPTS = [
  "architect.md",
  "dependabot-ci-fix.md",
  "executor.md",
  "fix.md",
  "guardrails.md",
  "pr-fix.md",
  "pr.md",
  "re-reviewer.md",
  "reviewer.md",
];

/**
 * The build prompts that commit `.lastlight/` into the target repo when build
 * assets are NOT externalized. That `{{#if !externalizeArtifacts}}` branch is
 * where every one of these prompts used to end in `git push origin HEAD`, so
 * it is the passage most likely to be edited back. Pinned as a BLOCK rather
 * than a string: a rewrite that reintroduces pushing in prose ("commit the
 * docs and push them") fails here even though it names no command — the shape
 * of the defect Task 7's review caught in `dependabot-ci-fix.md`.
 */
const ARTIFACT_COMMIT_PROMPTS = [
  "architect.md",
  "guardrails.md",
  "pr.md",
  "re-reviewer.md",
  "reviewer.md",
];

const read = (file: string) => readFileSync(join(PROMPTS_DIR, file), "utf8");

describe("packaged prompts publish through github_publish", () => {
  const files = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));

  it("finds the prompt set", () => {
    expect(files.length).toBeGreaterThan(5);
  });

  for (const file of files) {
    it(`${file} does not push a locally-built commit`, () => {
      expect(read(file), `${file} still invokes git push`).not.toMatch(FORBIDDEN_PUSH);
    });
  }

  for (const file of PUBLISHING_PROMPTS) {
    it(`${file} still has a publish step`, () => {
      expect(files, `${file} is listed as a publisher but no longer exists`).toContain(file);
      expect(read(file), `${file} lost its github_publish call`).toContain("github_publish");
    });
  }
});

describe("the artifact-commit branch publishes rather than pushes", () => {
  for (const file of ARTIFACT_COMMIT_PROMPTS) {
    it(`${file} keeps its {{#if !externalizeArtifacts}} branch on github_publish`, () => {
      const block = read(file).match(/\{\{#if !externalizeArtifacts\}\}([\s\S]*?)\{\{\/if\}\}/);
      expect(block, `${file} no longer has a !externalizeArtifacts branch`).not.toBeNull();
      const body = block![1]!;
      expect(body, `${file}'s artifact branch does not publish`).toContain("github_publish");
      // No push verb at all — not the command, not the word. The branch is one
      // instruction long, so unlike the prose elsewhere in these files there is
      // no legitimate prohibition or aside here for this to false-positive on.
      expect(body, `${file}'s artifact branch still talks about pushing`).not.toMatch(
        /\bpush(ed|es|ing)?\b/i,
      );
    });
  }
});
