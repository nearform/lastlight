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
 * `docs/plans/review-evidence-pipeline/03-seed-and-survey.md`.
 *
 * **AC3 — each survey pass writes only its own family's file.** The union is
 * append-only and collapse is meant to be impossible *by construction*: six
 * disjoint paths, and no pass ever opening another's. There is no harness code
 * to assert that on — the enforcement lives in the `until_bash` gate and the
 * prompt text — so what is checked here is what is actually enforceable: every
 * survey phase names ITS OWN family path and no other, and the six gates are
 * pairwise distinct.
 *
 * The assertions are on **paths**, never on words, and that distinction is the
 * whole test. Every one of the six prompts contains the word "contract" (the
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

const FAMILIES = ["contract", "enforcement", "security", "state", "tests", "spec"] as const;
type Family = (typeof FAMILIES)[number];

/** The five families whose obligations come from `lastlight-facts seed`. */
const BLOCK_FAMILIES = FAMILIES.filter((f) => f !== "spec");

const def = getWorkflow("pr-review");
const byName = new Map(def.phases.map((p) => [p.name, p]));

/**
 * WP11c moved the six families from six chained PHASES to six BRANCHES of one
 * `type: fanout` phase. Everything AC3 pins is unchanged by that — the six
 * prompts, the six literal gates, the six disjoint paths — so the assertions
 * below read a branch where they used to read a phase, and nothing else moved.
 * That is the property the change is claiming: a latency change, not a
 * behaviour change.
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

describe("AC3 — six survey branches, six disjoint families", () => {
  it("declares exactly one branch per family, in the seeder's family order", () => {
    expect(surveyPhase().branches?.map((b) => b.name)).toEqual([...FAMILIES]);
    // …and the six phases they replaced are gone, so nothing can run twice.
    expect(def.phases.filter((p) => p.name.startsWith("survey_"))).toEqual([]);
  });

  it("points each branch at its own prompt file, and the six are distinct", () => {
    const prompts = FAMILIES.map((f) => surveyBranch(f).prompt);
    expect(prompts).toEqual(FAMILIES.map((f) => `prompts/survey-${f}.md`));
    expect(new Set(prompts).size).toBe(FAMILIES.length);
  });

  it("gates each branch on ITS OWN family, and the six gates are pairwise distinct", () => {
    // This is the literal-gate property §D4 was rewritten for: the previous
    // `generic_loop` design templated `$LL_FAMILY` into the gate, `until_bash`
    // rejects template markers, and the gate silently tested
    // `hypotheses/.jsonl` — a condition that could never be true — while the
    // loop burned every iteration. A literal family per branch is what makes the
    // gate real rather than decorative.
    const gates = FAMILIES.map((f) => surveyBranch(f).until_bash?.trim());
    expect(new Set(gates).size).toBe(FAMILIES.length);
    // No templating anywhere in a gate — the failure mode above, pinned.
    for (const g of gates) expect(g).not.toContain("{{");
    // Each gate names its own family and no other's.
    for (const f of FAMILIES) {
      const gate = surveyBranch(f).until_bash ?? "";
      expect(gate).toContain(f);
      for (const other of FAMILIES) if (other !== f) expect(gate).not.toContain(other);
    }
  });

  it("gates the five SEEDABLE families on `discharge`, not on a file merely existing", () => {
    // `test -s` is passed by ONE LINE OF ANY CONTENT, while the obligations
    // block demands a QUOTE/ABSENT/PARTIAL/PROBE discharge per obligation.
    // Measured across both preserved runs of 2026-08-22, all 8 cases, every
    // family: not one obligation ever carried a discharge code (0/31, 0/34,
    // 0/40). It also lets a branch that LOST its seed and free-styled clear the
    // gate, which is the hole `context_file` cannot close from its end.
    for (const f of ["contract", "enforcement", "security", "state", "tests"]) {
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

  it("keeps the `security` skill set on the branch that needs it, and only there", () => {
    // Five families inherit the phase's two skills; `security` adds a third.
    // A fan-out that flattened the six onto one skill catalogue would hand
    // `security-review` to every family — cheap-looking, and a change to what
    // five of the six models see.
    expect(surveyPhase().skills).toEqual(["pr-review", "code-review"]);
    expect(surveyBranch("security").skills).toEqual(["pr-review", "code-review", "security-review"]);
    for (const f of FAMILIES.filter((x) => x !== "security")) {
      expect(surveyBranch(f).skills, f).toBeUndefined();
    }
  });

  it("names only its own family's files in its prompt — no pass opens another's", () => {
    for (const family of FAMILIES) {
      const reached = familiesReferenced(promptText(family));
      expect([...reached].sort(), `survey-${family}.md`).toEqual([family]);
    }
  });

  it("writes to six pairwise-disjoint hypothesis paths", () => {
    const outputs = FAMILIES.map((f) => `.lastlight/pr-review/hypotheses/${f}.jsonl`);
    expect(new Set(outputs).size).toBe(FAMILIES.length);
    // Each prompt actually instructs the write, and the gate then tests the
    // same path. Gate and instruction disagreeing is the shape that produced a
    // loop with a meaningless exit condition.
    for (const family of FAMILIES) {
      expect(promptText(family), `survey-${family}.md`).toContain(outputs[FAMILIES.indexOf(family)]);
    }
  });

  it("carries the cross-family prohibition in every prompt", () => {
    for (const family of FAMILIES) {
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
    for (const family of FAMILIES) {
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
    const texts = FAMILIES.map((f) => promptText(f));
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

  it("keeps the seeder's per-family manifest, so a missing block is a LOGGED fact", () => {
    // `renderFamilyBlock` always emits a block, so a family with no line here is
    // a seeder failure rather than a family with nothing to say — and the two
    // used to be the same silence.
    const seed = byName.get("seed")!.command!;
    for (const family of BLOCK_FAMILIES) expect(seed, family).toContain(family);
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

/** Render `survey-spec.md` exactly as the phase would, off a PrState. */
function renderSurveySpec(state: PrState): string {
  const ctx = renderContext(state, defaultFixConfig(), defaultDependenciesConfig(), analysisOn);
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
    const rendered = renderSurveySpec(prState());
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
    for (const family of FAMILIES) {
      const rendered = renderTemplate(promptText(family), {
        owner: "acme",
        repo: "widgets",
        ...ctx,
      } as unknown as TemplateContext);
      expect(rendered, `survey-${family}.md`).not.toMatch(/\{\{|\}\}/);
    }
  });
});
