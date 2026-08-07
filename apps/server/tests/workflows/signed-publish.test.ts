import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
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
 * The discriminator is the CLOSING BACKTICK, not the presence of an argument:
 * every `git push` mention we want to keep is written ``…`git push`.`` — the
 * command name closed immediately by a backtick, inside a prohibition. So a
 * `git push` followed by anything else at all — ` origin HEAD`, ` -u origin
 * HEAD`, a space, or a line break with prose after it — is treated as an
 * invocation and forbidden. `git -C <dir> push` is covered by the optional
 * flag group.
 *
 * What this does NOT distinguish: an unbackticked prohibition written in prose
 * ("never fall back to git push here") matches and would fail the guard. No
 * such wording exists in the corpus, and quoting the command is the house
 * style, so the false positive is theoretical — but it is a false positive,
 * not a catch.
 */
const FORBIDDEN_PUSH = /git(?:\s+-\S+(?:\s+\S+)?)*\s+push(?!`)/;

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
      // Without `include`, the publish widens to the whole working tree and
      // sweeps whatever the phase's test run left in the checkout into the
      // user's branch — the regression the include allowlist exists to fix.
      // Dropping it passes every other assertion here, so pin it explicitly.
      expect(body, `${file}'s artifact branch publishes more than .lastlight/`).toContain(
        'include: [".lastlight"]',
      );
      // No push verb at all — not the command, not the word. The branch is one
      // instruction long, so unlike the prose elsewhere in these files there is
      // no legitimate prohibition or aside here for this to false-positive on.
      expect(body, `${file}'s artifact branch still talks about pushing`).not.toMatch(
        /\bpush(ed|es|ing)?\b/i,
      );
    });
  }
});

/**
 * Both fix loops end on `until: "output.contains('outcome=pushed tried=')"`, so
 * a successful publish the agent does not report as `outcome=pushed` leaves the
 * loop running and replays the attempt into `{{priorAttempts}}` as having
 * changed nothing. AFTER FIXING is the one section every path through these
 * prompts reaches, so the success outcome has to be named there rather than
 * inside a conditional block only one path renders — which is exactly how
 * `dependabot-ci-fix.md` came to name it on the merge-only path alone.
 */
describe("the fix prompts name the success outcome where they publish", () => {
  for (const file of ["pr-fix.md", "dependabot-ci-fix.md"]) {
    it(`${file}'s AFTER FIXING section names outcome=pushed`, () => {
      const section = read(file).match(/AFTER FIXING:([\s\S]*?)PUBLISH DISCIPLINE/);
      expect(section, `${file} no longer has an AFTER FIXING section`).not.toBeNull();
      expect(section![1], `${file} publishes without naming outcome=pushed`).toContain(
        "outcome=pushed",
      );
    });
  }
});

/**
 * The prompts are not the only text an agent reads. The `agent-context/` files
 * are concatenated into the AGENTS.md prepended to EVERY session in every
 * workflow, and each skill's SKILL.md is staged into the phases that publish —
 * `fixing` and `building` are both mapped into the fix phase of `pr-fix.yaml`
 * and `dependabot-ci-fix.yaml`, alongside the prompt. Either can steer an agent to
 * `git push` regardless of what its phase prompt says, so the same rule and the
 * same discriminator apply here.
 *
 * The limitation documented for the prompts holds here too, and matters more
 * because these files are prose rather than instruction lists: this catches the
 * literal invocation, not an instruction to push written without naming the
 * command. It also only sees the PACKAGED files — an operator overlay's or a
 * target repo's own `agent-context/*.md` is resolved at runtime and is out of
 * reach of any test.
 */
const AGENT_CONTEXT_DIR = join(import.meta.dirname, "../../agent-context");
const SKILLS_DIR = join(import.meta.dirname, "../../skills");

const markdownUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return markdownUnder(path);
    return entry.endsWith(".md") ? [path] : [];
  });

/** `skills/fixing/SKILL.md` — enough to tell the many `SKILL.md`s apart. */
const label = (path: string) => path.split("/").slice(-3).join("/");

describe("the staged context agrees with the prompts", () => {
  const files = [...markdownUnder(AGENT_CONTEXT_DIR), ...markdownUnder(SKILLS_DIR)];

  it("finds the agent-context and skill files", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  for (const path of files) {
    it(`${label(path)} does not invoke git push`, () => {
      expect(readFileSync(path, "utf8"), `${path} invokes git push`).not.toMatch(FORBIDDEN_PUSH);
    });
  }

  /**
   * The closure half, and the only cover these files have for the prose case
   * the regex above cannot see. `rules.md` is where an agent that has read
   * nothing else learns how work reaches the branch; `fixing`/`building` are
   * the two skills a publishing phase stages; and `security-feedback` is the
   * one skill that carries its own publish step (it clones, edits SECURITY.md
   * and opens a PR with no prompt of its own) — it read "commit …, push, and
   * open a PR" for exactly as long as nothing pinned it.
   */
  for (const path of [
    join(AGENT_CONTEXT_DIR, "rules.md"),
    join(SKILLS_DIR, "fixing", "SKILL.md"),
    join(SKILLS_DIR, "building", "SKILL.md"),
    join(SKILLS_DIR, "security-feedback", "SKILL.md"),
  ]) {
    it(`${label(path)} still names github_publish`, () => {
      expect(readFileSync(path, "utf8"), `${path} no longer names github_publish`).toContain(
        "github_publish",
      );
    });
  }
});
