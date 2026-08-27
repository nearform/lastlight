import { describe, it, expect } from "vitest";
import { getWorkflow, loadPromptTemplate } from "#src/workflows/loader.js";
import { BRANCH_CONTEXT_HEADING } from "#src/workflows/handlers/fanout.js";
import { renderTemplate } from "lastlight-workflow-engine";
import type { PhaseDefinition, TemplateContext } from "lastlight-workflow-engine";
import type { PrState } from "#src/engine/pr-state.js";
import { renderContext } from "#src/engine/pr-decisions.js";
import {
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultReviewConfig,
} from "lastlight-shared/config-types";

/**
 * WP3 acceptance criteria 3 and 4 of
 * `docs/plans/deterministic-pr-levers.md` §WP3.
 *
 * **AC3 — each survey pass writes only its own family's file.** The union is
 * append-only and collapse is meant to be impossible *by construction*: five
 * disjoint paths, and no pass ever opening another's. There is no harness code
 * to assert that on — the enforcement lives in the `until_bash` gate and the
 * prompt text — so what is checked here is what is actually enforceable: every
 * survey phase names ITS OWN family path and no other, and the five gates are
 * pairwise distinct.
 *
 * The assertions are on **paths**, never on words, and that distinction is the
 * whole test. Every one of the five prompts contains the word "contract" (the
 * *discharge* contract); `survey-enforcement.md` contains the word "state" ("or
 * state that no such line exists"). A word-level scan would pass while proving
 * nothing at all — so a non-vacuity control below pins that fact, and will fail
 * if anyone ever weakens these assertions back to word matching.
 *
 * **AC4 — `coverage: "degraded"` reaches the model.** The facts → obligations →
 * block hop lives in `packages/code-facts` (`renderFamilyBlock`, unit-tested
 * there). What this layer owns is the two ends of that chain: the `coverage:
 * "none"` envelope literal embedded in `pr-review.yaml`'s shell fallback, which
 * nothing type-checks; the path agreement between the seeder's `--blocks`
 * directory and the file each prompt tells the model to open; and — for the
 * `spec` family, whose obligations are built harness-side — the complete
 * in-process propagation from a degraded `PrState` to the rendered prompt.
 */

/**
 * The SEEDER's universe. `lastlight-facts seed` still emits a per-family block
 * and an `obligations.json` row for every one of these — `tests` included, as
 * `measured: false` — so the eval instrument keeps reporting that family as
 * `notMeasured`, never as "did not convert".
 */
const SEEDED_FAMILIES = ["contract", "enforcement", "security", "state", "tests"] as const;

/**
 * The FAN-OUT's universe: the five survey branches. `tests` deliberately has
 * no branch — the family is dead at both ends (no seeder function exists in
 * `code-facts`, and its `coverage` source needs the probes-gated `prepare`
 * artifact), so running it paid a sixth of the fan-out to write NOT MEASURED.
 * Reinstating it is the branch entry in `pr-review.yaml` plus a seeder.
 */
const BRANCH_FAMILIES = ["contract", "enforcement", "security", "state", "spec"] as const;
type Family = (typeof BRANCH_FAMILIES)[number];

/** The four branches seeded from a `lastlight-facts seed` block on disk. */
const BLOCK_FAMILIES = BRANCH_FAMILIES.filter((f) => f !== "spec");

const def = getWorkflow("pr-review");
const byName = new Map(def.phases.map((p) => [p.name, p]));

/**
 * WP11c moved the six families from six chained PHASES to six BRANCHES of one
 * `type: fanout` phase. Everything AC3 pins was unchanged by that — the
 * prompts, the literal gates, the disjoint paths — so the assertions below
 * read a branch where they used to read a phase. That was a latency change,
 * not a behaviour change. The `tests` branch was then REMOVED outright (see
 * `BRANCH_FAMILIES` above), which is why the fan-out's universe here is five
 * while the seeder's is still the five in `SEEDED_FAMILIES`.
 */
const surveyPhase = (): PhaseDefinition => {
  const phase = byName.get("survey");
  if (!phase) throw new Error("pr-review.yaml has no `survey` fanout phase");
  if (phase.type !== "fanout") throw new Error("pr-review.yaml's `survey` phase is not `type: fanout`");
  return phase;
};

const surveyBranch = (family: Family) => {
  const branch = surveyPhase().branches?.find((b) => b.name === family);
  if (!branch) throw new Error(`the survey fan-out has no \`${family}\` branch`);
  return branch;
};

const promptText = (family: Family): string => loadPromptTemplate(surveyBranch(family).prompt!);

/**
 * Every family-scoped path a prompt mentions, as the set of families it reaches
 * for. Covers both the obligations block it READS and the hypothesis file it
 * WRITES — "no pass opens another's" is a claim about both directions.
 */
function familiesReferenced(text: string): Set<string> {
  const found = new Set<string>();
  const re = /\.lastlight\/pr-review\/(?:hypotheses|obligations)\/([a-z_]+)\.(?:jsonl|md)/g;
  for (const m of text.matchAll(re)) found.add(m[1]);
  return found;
}

// ── AC3 ──────────────────────────────────────────────────────────────────────

describe("AC3 — five survey branches, five disjoint families", () => {
  it("declares exactly one branch per surveyed family, and NONE for `tests`", () => {
    // The exact-list assertion is the pin on the removal: `tests` sat between
    // `state` and `spec` until 2026-08-24 and must not quietly come back
    // without its seeder.
    expect(surveyPhase().branches?.map((b) => b.name)).toEqual([...BRANCH_FAMILIES]);
    // …and the six phases they replaced are gone, so nothing can run twice.
    expect(def.phases.filter((p) => p.name.startsWith("survey_"))).toEqual([]);
  });

  it("points each branch at its own prompt file, and the five are distinct", () => {
    const prompts = BRANCH_FAMILIES.map((f) => surveyBranch(f).prompt);
    expect(prompts).toEqual(BRANCH_FAMILIES.map((f) => `prompts/survey-${f}.md`));
    expect(new Set(prompts).size).toBe(BRANCH_FAMILIES.length);
  });

  it("gates each branch on ITS OWN family, and the five gates are pairwise distinct", () => {
    // This is the literal-gate property §D4 was rewritten for: the previous
    // `generic_loop` design templated `$LL_FAMILY` into the gate, `until_bash`
    // rejects template markers, and the gate silently tested
    // `hypotheses/.jsonl` — a condition that could never be true — while the
    // loop burned every iteration. A literal family per branch is what makes the
    // gate real rather than decorative.
    const gates = BRANCH_FAMILIES.map((f) => surveyBranch(f).until_bash?.trim());
    expect(new Set(gates).size).toBe(BRANCH_FAMILIES.length);
    // No templating anywhere in a gate — the failure mode above, pinned.
    for (const g of gates) expect(g).not.toContain("{{");
    // Each gate names its own family and no other's — `tests` included in the
    // "other" set, so no gate can quietly grade the branchless family.
    for (const f of BRANCH_FAMILIES) {
      const gate = surveyBranch(f).until_bash ?? "";
      expect(gate).toContain(f);
      for (const other of [...BRANCH_FAMILIES, "tests"])
        if (other !== f) expect(gate).not.toContain(other);
    }
  });

  it("gates the four block-seeded branches on `discharge`, not on a file merely existing", () => {
    // `test -s` is passed by ONE LINE OF ANY CONTENT, while the obligations
    // block demands a QUOTE/ABSENT/PARTIAL/PROBE discharge per obligation.
    // Measured across both preserved runs of 2026-08-22, all 8 cases, every
    // family: not one obligation ever carried a discharge code (0/31, 0/34,
    // 0/40). It also lets a branch that LOST its seed and free-styled clear the
    // gate, which is the hole `context_file` cannot close from its end.
    // (`tests` was the fifth discharge-gated branch until it was removed —
    // there is nothing left to gate.)
    for (const f of BLOCK_FAMILIES) {
      const gate = surveyBranch(f).until_bash ?? "";
      expect(gate).toContain(`discharge --dir .lastlight/pr-review --family ${f}`);
      expect(gate).not.toContain("test -s");
      // §D1's resolution order, in shell — the binary is reached three ways
      // depending on where this runs and a bare name is not on PATH everywhere.
      expect(gate).toContain("LASTLIGHT_FACTS_BIN");
    }
    // `spec` keeps `test -s`: its obligations are built harness-side and never
    // reach `obligations.json`, so a discharge gate there grades nothing. If
    // that ever changes, this expectation is the reminder to wire it.
    expect(surveyBranch("spec").until_bash?.trim()).toBe(
      "test -s .lastlight/pr-review/hypotheses/spec.jsonl",
    );
  });

  it("stages ONE skill, the same one on every branch", () => {
    // LD9: specialists are separated by QUESTION, not by tool access. The
    // question is the family prompt's; `survey-pass` is what the five share.
    //
    // This used to be `[pr-review, code-review]` on the phase plus a third skill
    // on `security`, and both halves were wrong in the same direction. The two
    // generic skills are 528 lines whose main contracts each family's prompt
    // then countermands — `pr-review` is a procedure for PRODUCING a review and
    // `code-review` is a ten-axis checklist handed whole to five specialists who
    // own one or two axes each. `security-review` was a CRON procedure (clone
    // the repo, file one dated summary issue, keep state across runs) staged on
    // the one branch, and its only relevant part — the SDLC checklist — now
    // lives in `prompts/survey-security.md`.
    expect(surveyPhase().skills).toEqual(["survey-pass"]);
  });

  it("gives NO branch a skills override — the prompt head stays byte-identical", () => {
    // The five requests share a provider-side cached prefix, which is keyed on
    // the prefix and therefore on the skill catalogue. `security` used to void
    // that for itself; nothing does now. It is also the confound that made the
    // one branch with a bespoke skill the same branch with no obligations —
    // freeform-vs-seeded and third-skill-vs-not moved together and no run could
    // separate them.
    for (const f of BRANCH_FAMILIES) {
      expect(surveyBranch(f).skills, f).toBeUndefined();
    }
  });

  it("keeps `code-review` on the phases that are PRODUCING a review", () => {
    // The subtraction is at the fan-out, not in the rubric. `falsify`, `review`
    // and `adjudicate` are the last hands on the work before a human reads it,
    // which is exactly where the precision gate is supposed to fire.
    for (const name of ["falsify", "review", "adjudicate"]) {
      expect(byName.get(name)?.skills, name).toContain("code-review");
    }
  });

  it("names only its own family's files in its prompt — no pass opens another's", () => {
    for (const family of BRANCH_FAMILIES) {
      const reached = familiesReferenced(promptText(family));
      expect([...reached].sort(), `survey-${family}.md`).toEqual([family]);
    }
  });

  it("writes to five pairwise-disjoint hypothesis paths", () => {
    const outputs = BRANCH_FAMILIES.map((f) => `.lastlight/pr-review/hypotheses/${f}.jsonl`);
    expect(new Set(outputs).size).toBe(BRANCH_FAMILIES.length);
    // Each prompt actually instructs the write, and the gate then tests the
    // same path. Gate and instruction disagreeing is the shape that produced a
    // loop with a meaningless exit condition.
    for (const family of BRANCH_FAMILIES) {
      expect(promptText(family), `survey-${family}.md`).toContain(
        outputs[BRANCH_FAMILIES.indexOf(family)],
      );
    }
  });

  it("carries the cross-family prohibition in every prompt", () => {
    for (const family of BRANCH_FAMILIES) {
      const text = promptText(family);
      expect(text, `survey-${family}.md`).toContain(
        "Do NOT read or write any other family's file",
      );
      // …and the reason, because a rule without its reason is the first thing a
      // fork drops: appending to disjoint files makes consensus collapse
      // impossible by construction rather than by instruction.
      expect(text, `survey-${family}.md`).toContain("by construction");
    }
  });

  it("names its own family in the `## Your family:` heading, once", () => {
    for (const family of BRANCH_FAMILIES) {
      const headings = [...promptText(family).matchAll(/^## Your family: `([a-z]+)`$/gm)].map(
        (m) => m[1],
      );
      expect(headings, `survey-${family}.md`).toEqual([family]);
    }
  });

  /**
   * Non-vacuity control. If these assertions are ever weakened from paths to
   * words, this test says so: the family WORDS are shared across prompts and
   * separate nothing.
   */
  it("is asserting on paths because the words do not separate the families", () => {
    const texts = BRANCH_FAMILIES.map((f) => promptText(f));
    for (const word of ["contract", "state"]) {
      // Each family's own WORD appears in more than one family's prompt — so a
      // word-level assertion would be satisfied by prompts that all talk about
      // each other, which is precisely the failure this test set guards.
      const hits = texts.filter((t) => new RegExp(`\\b${word}\\b`).test(t)).length;
      expect(hits, `the word "${word}"`).toBeGreaterThan(1);
    }
  });
});

// ── AC4 ──────────────────────────────────────────────────────────────────────

const FACTS_COMMAND = (() => {
  const command = byName.get("facts")?.command;
  if (!command) throw new Error("pr-review.yaml's `facts` phase has no command");
  return command;
})();

/**
 * The degraded envelope the `facts` phase writes when the analysis cannot be
 * run at all — extracted from the `printf` FORMAT string in its shell fallback,
 * with the `%s` placeholders filled so it can be parsed as the JSON it becomes.
 */
function factsFallbackEnvelope(): Record<string, unknown> {
  const open = FACTS_COMMAND.indexOf("printf '{");
  expect(open, "no `printf '{…}'` fallback envelope in the facts phase").toBeGreaterThan(-1);
  const rest = FACTS_COMMAND.slice(open + "printf '".length);
  // `printf` is handed a literal backslash-n; the JSON body is everything before it.
  const end = rest.indexOf("\\n'");
  expect(end, "the fallback envelope's printf format is unterminated").toBeGreaterThan(-1);
  const format = rest
    .slice(0, end)
    // Runtime substitutions: timestamp, base sha, head sha, the reason string.
    .replaceAll("%s", "SUBSTITUTED")
    // Template markers the phase renders before the shell ever sees them.
    .replaceAll("{{owner}}", "acme")
    .replaceAll("{{repo}}", "widgets");
  return JSON.parse(format) as Record<string, unknown>;
}

describe("AC4 — what was NOT analysed reaches the model", () => {
  it("writes a PARSEABLE `coverage: none` envelope when the analysis cannot run", () => {
    // The literal lives inside a YAML block scalar inside a shell single-quoted
    // printf format. Nothing type-checks it, and a JSON syntax error here would
    // write garbage the seeder then refuses to read — leaving no obligations
    // AND no block saying why, which is exactly the silence the envelope exists
    // to replace.
    const envelope = factsFallbackEnvelope();
    expect(envelope.version).toBe(2);
    expect(envelope.coverage).toBe("none");
    expect(envelope.extractor).toBe("all");

    const degraded = envelope.degraded as { extractor: string; reason: string }[];
    expect(Array.isArray(degraded)).toBe(true);
    expect(degraded).toHaveLength(1);
    expect(degraded[0].extractor).toBe("facts");
    // `extractors: {}` — looked at nothing, rather than an absent key. `null`
    // means nobody looked; `[]` means looked and found none.
    expect(envelope.extractors).toEqual({});
    expect(envelope.languages).toEqual([]);
  });

  it("gives every degraded exit a reason that forbids reading it as `no findings`", () => {
    // Two ways the phase can end up with nothing: no resolvable merge base, and
    // an analyser process that DIED. Both must say so in the words the survey
    // prompts then relay — a `coverage: none` envelope read as "clean" is the
    // precise bug this pipeline was built against.
    const reasons = [...FACTS_COMMAND.matchAll(/fallback "([^"]+)"/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(2);
    for (const reason of reasons) {
      expect(reason).toContain("NOTHING here may be read as 'no findings'");
    }
    expect(reasons.some((r) => r.includes("no merge base"))).toBe(true);
    expect(reasons.some((r) => r.includes("died without writing an envelope"))).toBe(true);
  });

  it("resolves the MERGE BASE, and degrades rather than falling back to a wrong range", () => {
    // Two-dot additionally contains every commit that landed on the base branch
    // since the PR forked. Analysing the wrong range and reporting success is
    // the shape this pipeline exists to stop.
    expect(FACTS_COMMAND).toContain("git merge-base origin/{{baseBranch}} HEAD");
    // …and nowhere in the EXECUTED shell (comments may name it as the thing not
    // to do) does the range silently degrade to a one-commit approximation.
    const code = FACTS_COMMAND.split("\n").filter((l) => !/^\s*#/.test(l));
    expect(code.join("\n")).not.toMatch(/HEAD~/);
    // A resolvable-but-empty merge base is caught too — `git merge-base` prints
    // nothing and exits 0 on some failure modes.
    expect(FACTS_COMMAND).toMatch(/\[ -z "\$BASE" \]/);
  });

  it("exits 0 on every degraded path, so cron-review cannot re-dispatch forever", () => {
    // §D12: fail loud means loud in the ARTIFACT, never fatal to the run. A
    // hard-failing phase is re-dispatched by cron-review.yaml every thirty
    // minutes for as long as the PR is open.
    expect(FACTS_COMMAND).toContain("--never-fail");
    // The shell-level catch, not the flag: `--never-fail` is an in-process
    // try/catch and cannot cover a process that DIES.
    expect(FACTS_COMMAND).toMatch(/if\s+!\s+"\$FACTS"/);
    expect(FACTS_COMMAND).toContain("exit 0");
    // `set -e` would turn any of these degraded paths back into a hard failure.
    expect(FACTS_COMMAND).not.toMatch(/^\s*set -e/m);
    expect(byName.get("seed")!.command).toContain("|| true");
  });

  /**
   * f1 — the diff is staged ONCE, by the phase that already owns the range.
   *
   * Measured: the five branches make ~93 bash calls per case and ~30 of them
   * re-derive this one fixed merge-base range, while surveys are ~75% of a
   * case's spend. The correctness half matters more — every re-derivation is a
   * fresh chance to write two dots, and the same corpus that motivates the
   * `merge-base` assertion above says what that costs (6125 files against 3).
   *
   * Three strings, one location: the flag on the `facts` invocation, the
   * directory `code-facts` writes into, and the path every prompt points at. If
   * they part company the branches look for a diff nobody staged and quietly go
   * back to `git diff`.
   */
  it("stages the diff once, in the phase that resolved the range", () => {
    expect(FACTS_COMMAND).toContain("--stage-diff");
    // On the SAME invocation as the range, not a second command with its own
    // idea of the base — that would be the two-dot bug with extra steps.
    expect(FACTS_COMMAND).toMatch(/"\$FACTS" all --repo \. --base "\$BASE" --head HEAD .*--stage-diff/);
    // Loud either way: a phase that staged nothing must say so, or "the layer
    // wrote no patches" and "the branches never looked" become one silence.
    expect(FACTS_COMMAND).toContain(".lastlight/pr-review/diff/index.md");
    expect(FACTS_COMMAND).toContain("NO staged diff");
  });

  it("points every survey prompt at the staged diff, by RELATIVE path", () => {
    // The relative form is not a style choice: across three stored runs, 98 of
    // 98 relative first-turn reads from a survey branch resolved and 0 of 27
    // workspace-root-absolute ones did, because the only absolute path a branch
    // holds is its skill bundle — one directory ABOVE the checkout.
    for (const family of BRANCH_FAMILIES) {
      const text = promptText(family);
      expect(text, `survey-${family}.md`).toContain(".lastlight/pr-review/diff/index.md");
      expect(text, `survey-${family}.md`).toContain(
        "**Do NOT re-derive this PR's range with `git diff` or `git show`.**",
      );
      // Three dots, in the one escape hatch the prompt still offers.
      expect(text, `survey-${family}.md`).toContain("git diff origin/{{baseBranch}}...HEAD");
      // Non-vacuity for the assertion above: no prompt may hand the branch an
      // absolute path to join onto.
      expect(text, `survey-${family}.md`).not.toContain("/.lastlight/pr-review/diff");
    }
  });

  /**
   * …and the other half of it, which is what a measured arm cost us.
   *
   * The staged diff landed as a prohibition ("do NOT run `git diff` … it is
   * already staged") under `## Hard limits`, and it over-suppressed: total
   * survey bash calls fell 848 → 399 while the eliminated range re-derivation
   * accounts for only ~276 of that. The other ~170 were greps, whole-file reads
   * and reference tracing — and internal recall fell 21/25 → 12/25. Access was
   * never reduced (the staged diff sits INSIDE the full checkout); the framing
   * narrowed the behaviour. So the prompt now forbids exactly one thing and says
   * out loud that the patch is a starting point rather than a scope.
   */
  it("tells every survey branch it has the whole checkout, not just the patch", () => {
    for (const family of BRANCH_FAMILIES) {
      const text = promptText(family);
      expect(text, `survey-${family}.md`).toContain("## What you have: the whole checkout");
      expect(text, `survey-${family}.md`).toContain("STARTING POINT, not your scope");
      // The affordance must not read as an exception to a ban: nothing may
      // survive that forbids reading beyond the patch.
      expect(text, `survey-${family}.md`).not.toContain("to obtain this PR's diff");
    }
  });

  it("agrees with the branches on where the per-family blocks are written", () => {
    // The seeder's `--blocks <dir>` and the file each branch is seeded FROM are
    // two independent strings for one location. If they part company the pass
    // runs unseeded, reports the family clean, and the run says a degraded
    // analysis was a passing one.
    const seed = byName.get("seed")!.command!;
    const blocksDir = /--blocks\s+(\S+)/.exec(seed)?.[1];
    expect(blocksDir).toBe(".lastlight/pr-review/obligations");
    expect(seed).toContain("--out .lastlight/pr-review/obligations.json");

    for (const family of BLOCK_FAMILIES) {
      expect(surveyBranch(family).context_file, family).toBe(`${blocksDir}/${family}.md`);
    }
    // The `spec` family is built harness-side from the PR body and the linked
    // issues, so it has no block on disk and must not claim one.
    expect(surveyBranch("spec").context_file).toBeUndefined();
    expect(promptText("spec")).not.toContain(blocksDir!);
  });

  /**
   * The regression guard for the defect this key exists to close.
   *
   * Across the three stored pr-review runs of 2026-08-22, 27 of 120 non-spec
   * survey branches resolved `obligations/<family>.md` against the SANDBOX ROOT
   * rather than the checkout and hit ENOENT; 23 never recovered. Every failure
   * used the workspace-root absolute form and all 98 relative reads succeeded —
   * the model was joining the prompt's relative path onto the one absolute base
   * it had at that point, the skill bundle, which sits one level above the
   * checkout. The fix is that there is no path in the prompt to resolve: the
   * harness reads the file at `hostAgentCwd` and appends it.
   *
   * So the assertion is an ABSENCE, and it is deliberately about the artifact
   * the pass READS, not the one it writes — the hypotheses path stays in the
   * prompt because the model genuinely has to write it.
   */
  it("hands the block to the pass instead of a path — no obligations path survives in a prompt", () => {
    for (const family of BLOCK_FAMILIES) {
      const text = promptText(family);
      expect(text, `survey-${family}.md`).not.toContain(".lastlight/pr-review/obligations");
      // The pass is told where its obligations actually are — the heading the
      // fan-out handler files them under — and told not to go looking.
      expect(text, `survey-${family}.md`).toContain(BRANCH_CONTEXT_HEADING);
      expect(text, `survey-${family}.md`).toContain("Do not go looking for them on disk");
    }
  });

  /**
   * Backlog item #24, closed: `review.analysis.maxObligations` was DEAD config
   * on the workflow path.
   *
   * It is validated in `config.ts`, clamped by the repo layer and documented in
   * the spec — and the `seed` phase invoked `lastlight-facts seed` without
   * `--max-obligations`, so the CLI's own default (also 40) applied to every
   * run. The wrong value and the right one were the same number, which is why
   * nothing measured it.
   *
   * The key is now the TOTAL BACKSTOP over the seeder's per-family ceilings
   * (contract 12, enforcement 12, state 8, security 8, tests 8), and its
   * default is their sum — so it cannot bind unless an operator raises a
   * ceiling. The two defaults are *still* equal, deliberately, which is why
   * this test pins the number on both sides rather than trusting the accident.
   */
  it("passes the obligation BACKSTOP to the seeder, defaulted in the shell", () => {
    const seed = byName.get("seed")!.command!;
    // Read into a shell variable and defaulted there — never interpolated
    // straight into the arg list, because `renderTemplate` substitutes an
    // ABSENT key with the empty string and `--max-obligations --blocks` would
    // then swallow the next flag. The same rule `CONTRACT` follows.
    expect(seed).toContain('MAX_OBLIGATIONS="{{maxObligations}}"');
    expect(seed).toContain('--max-obligations "${MAX_OBLIGATIONS:-48}"');
    expect(seed).not.toMatch(/--max-obligations\s+\{\{/);
    // The shell default matches `code-facts`' own DEFAULT_MAX_OBLIGATIONS — and
    // that number is the per-family ceilings' sum — so an unprojected key
    // reproduces today's behaviour rather than seeding zero or unbounding it.
    expect(seed).toContain("--contract \"${CONTRACT:-minimal}\"");
  });

  it("keeps the seeder's per-family manifest, so a missing block is a LOGGED fact", () => {
    // `renderFamilyBlock` always emits a block, so a family with no line here is
    // a seeder failure rather than a family with nothing to say — and the two
    // used to be the same silence. This is the SEEDER's universe, not the
    // fan-out's: `tests` still gets a block (and a `measured: false` row) even
    // though no branch reads it, so the manifest keeps logging it.
    const seed = byName.get("seed")!.command!;
    for (const family of SEEDED_FAMILIES) expect(seed, family).toContain(family);
    expect(seed).toContain("block MISSING");
    expect(seed).toContain("will run UNSEEDED");
    // …and it still cannot fail the run: a hard-failing phase is re-dispatched
    // by cron-review.yaml every thirty minutes, forever (§D12).
    expect(seed).toContain("exit 0");
  });

  it("tells each block-reading pass that a missing or unmeasured block is NOT a clean result", () => {
    for (const family of BLOCK_FAMILIES) {
      const text = promptText(family);
      // "we could not look" and "we looked and it is fine" must stay
      // distinguishable at the point the model reads them (locked decision 6).
      expect(text, `survey-${family}.md`).toContain("is **not** a clean result");
      expect(text, `survey-${family}.md`).toContain("NOT MEASURED");
      expect(text, `survey-${family}.md`).toContain("do not substitute a judgement for a measurement");
    }
  });
});

// ── AC4, the one degraded chain that is end-to-end at THIS layer ─────────────

/** A reviewable PR. `changedFiles: null` is the read-failed (degraded) case. */
function prState(over: Partial<PrState> = {}): PrState {
  return {
    repo: "acme/widgets",
    prNumber: 190,
    headSha: "abcdef1234567890",
    headAuthor: "octocat",
    headIsOurs: false,
    headRef: "feature/expiry",
    baseRef: "main",
    isDraft: false,
    isFork: false,
    headRepoFullName: "acme/widgets",
    labels: [],
    title: "Enforce token expiry",
    body: "Fixes #1587.",
    checksState: "passing",
    settledCheckCount: 3,
    baseChecksState: "passing",
    botReviewAtHead: null,
    lastBotReview: null,
    pathsSinceLastBotReview: null,
    ciReport: null,
    closes: [
      {
        number: 1587,
        title: "Session tokens never expire",
        body: "## Acceptance criteria\n- Expiry is enforced server-side on every request",
      },
    ],
    changedFiles: ["src/server/auth.ts", "src/config.ts"],
    ...over,
  } as PrState;
}

const analysisOn = (() => {
  const base = defaultReviewConfig();
  return { ...base, analysis: { ...base.analysis, enabled: true } };
})();

// The shipped default is `obligationContract: minimal`, whose block carries no
// row shape by design — the discharge-contract delivery test below pins the
// `full` contract's mechanism, so it asks for `full` by name.
const analysisOnFull = { ...analysisOn, analysis: { ...analysisOn.analysis, obligationContract: "full" as const } };

/** Render `survey-spec.md` exactly as the phase would, off a PrState. */
function renderSurveySpec(state: PrState, review = analysisOn): string {
  const ctx = renderContext(state, defaultFixConfig(), defaultDependenciesConfig(), review);
  return renderTemplate(loadPromptTemplate("prompts/survey-spec.md"), {
    owner: "acme",
    repo: "widgets",
    ...ctx,
  } as unknown as TemplateContext);
}

describe("AC4 — the `spec` family's degraded state propagates all the way to the prompt", () => {
  it("carries a full obligation set into the rendered prompt", () => {
    const rendered = renderSurveySpec(prState());
    // The family-title line, in `renderFamilyBlock`'s own format
    // (`=== CONTRACT — … ===`) rather than a sixth spelling of it.
    expect(rendered).toContain("=== SPEC — does this change do what was asked? ===");
    expect(rendered).toContain("Expiry is enforced server-side on every request");
    expect(rendered).toContain("src/server/auth.ts");
  });

  it("delivers the discharge contract and the row shape into the PROMPT, not just the block", () => {
    // The `spec` branch is the one family with no `context_file`: its
    // obligations arrive as `{{specObligations}}` template context. So the
    // contract only reaches the model if the substitution carries it — which is
    // the half that had no test, and the half that was empty. Measured on
    // `prreview__skillspro-1587-r2`: `spec.jsonl` rows carried `verdict`, a
    // field no gate reads, because the block prescribed no row at all.
    // Rendered under `full` explicitly: the shipped `minimal` default omits
    // the row shape by design, and what this test pins is the delivery path.
    const rendered = renderSurveySpec(prState(), analysisOnFull);
    expect(rendered).toContain('"discharge": "QUOTE|ABSENT|PARTIAL|PROBE"');
    expect(rendered).toContain("hypotheses/spec.jsonl");
    for (const code of ["QUOTE", "ABSENT", "PARTIAL", "PROBE"]) expect(rendered, code).toContain(code);
    // Its own obligation ids, as the checklist no `discharge --ledger` can print.
    expect(rendered).toContain("S-1");
  });

  it("tells the model what could NOT be looked at when the changed-file read failed", () => {
    // state (degraded) → obligations (`degraded[]`) → rendered prompt. An
    // absent block would read to the model as "the spec axis is clean", which
    // is the one thing locked decision 6 forbids.
    const rendered = renderSurveySpec(prState({ changedFiles: null }));
    expect(rendered).toContain("changed-file list could not be read");
    expect(rendered).toContain("That is NOT a pass");
  });

  it("says so, differently, when the PR genuinely changes no files", () => {
    const rendered = renderSurveySpec(prState({ changedFiles: [] }));
    expect(rendered).toContain("changes no files");
  });
});

/**
 * Regression guard for a bug these tests caught: `survey-spec.md` shipped its
 * fallback branch as `{{#unless specObligations}}…{{/unless}}`, and the template
 * engine does not implement `{{#unless}}`.
 *
 * `renderTemplate` handles `{{#if x}}…{{/if}}` (with a `!` negation) and bare
 * `{{x}}` only — `packages/workflow-engine/src/core/templates.ts`. `{{#unless}}`
 * matches neither production: `#` and `/` are outside the `[\w-]` key class, so
 * BOTH markers survived verbatim into the prompt AND the body between them was
 * emitted unconditionally. The model was therefore told "No spec obligations
 * were built for this PR … That is **not** a pass on this axis" *immediately
 * underneath a fully-populated obligation block* — the exact inversion of AC4,
 * telling the model nothing was analysed when something was.
 *
 * Nothing catches it upstream. `validateAssets` checks that a prompt file
 * RESOLVES, not that it renders; the post-render `{{`-leftover guard
 * (`validateShellCommand`) applies only to `type: bash` commands. So the
 * general assertion — no survey prompt leaves an unrendered marker — is the
 * guard, not a spot-check of the one branch that was wrong.
 */
describe("AC4 — regression: the `spec` prompt must not contradict its own block", () => {
  it("does not emit the no-obligations fallback when obligations WERE built", () => {
    const rendered = renderSurveySpec(prState());
    expect(rendered).not.toContain("No spec obligations were built for this PR");
  });

  it("leaves no unrendered template marker in any survey prompt", () => {
    const ctx = renderContext(
      prState(),
      defaultFixConfig(),
      defaultDependenciesConfig(),
      analysisOn,
    );
    for (const family of BRANCH_FAMILIES) {
      const rendered = renderTemplate(promptText(family), {
        owner: "acme",
        repo: "widgets",
        ...ctx,
      } as unknown as TemplateContext);
      expect(rendered, `survey-${family}.md`).not.toMatch(/\{\{|\}\}/);
    }
  });
});
