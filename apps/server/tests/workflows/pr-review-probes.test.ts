import { describe, it, expect } from "vitest";
import { getWorkflow, loadPromptTemplate } from "#src/workflows/loader.js";
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
 * WP4 — `docs/plans/review-evidence-pipeline/04-probe-oracle.md`, the `prepare`
 * half.
 *
 * The branching inside `lastlight-facts prepare` is unit-tested where it lives
 * (`packages/code-facts/tests/prepare.test.ts`, against real trees). What this
 * layer owns is the four things nothing else type-checks:
 *
 *  - the phase's **shell fallback**, whose `env.json` literal is a string in a
 *    YAML file and would otherwise be discovered to be malformed by a workflow
 *    phase in production;
 *  - the **config → context → command** chain, i.e. whether the four switches an
 *    operator sets actually reach the flags the CLI is invoked with;
 *  - **AC2b**, that no phase re-derives what CI already said;
 *  - **§D12**, that no terminal path of this phase can fail the run — because
 *    `cron-review.yaml` re-dispatches anything that did not succeed, every
 *    thirty minutes, forever.
 */

const def = getWorkflow("pr-review");
const byName = new Map(def.phases.map((p) => [p.name, p]));
const prepare = byName.get("prepare");
if (!prepare) throw new Error("pr-review.yaml has no `prepare` phase");

/** A reviewable PR — the same shape `pr-review-survey.test.ts` uses. */
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
    closes: [],
    changedFiles: ["src/server/auth.ts"],
    ...over,
  } as PrState;
}

type AnalysisOverrides = Partial<ReturnType<typeof defaultReviewConfig>["analysis"]>;

function reviewConfig(over: AnalysisOverrides) {
  const base = defaultReviewConfig();
  return { ...base, analysis: { ...base.analysis, ...over } };
}

function contextFor(over: AnalysisOverrides): Record<string, unknown> {
  return renderContext(
    prState(),
    defaultFixConfig(),
    defaultDependenciesConfig(),
    reviewConfig(over),
  ) as unknown as Record<string, unknown>;
}

/** The phase's command, rendered exactly as `buildCommandSpec` renders it. */
function renderedCommand(over: AnalysisOverrides): string {
  return renderTemplate(prepare!.command ?? "", {
    owner: "acme",
    repo: "widgets",
    ...contextFor(over),
  } as unknown as TemplateContext);
}

const ON: AnalysisOverrides = { enabled: true, probes: true };

// ── the projection ───────────────────────────────────────────────────────────

describe("the four switches reach the phase, and absence means off", () => {
  it("projects nothing at all when probes are off", () => {
    const ctx = contextFor({ enabled: true });
    // ABSENT, not `false`. `skip_if` coercion reads absence as off, and any
    // skills-only phase gets `buildPhasePrompt`'s whole-context dump, where a
    // key present-but-empty is a prompt change on a deployment that opted into
    // WP3 and not WP4.
    for (const key of [
      "probesEnabled",
      "probeLifecycleScripts",
      "probeTypecheck",
      "probeCoverage",
      "probeRounds",
      "probePhaseTimeoutSeconds",
    ]) {
      expect(Object.prototype.hasOwnProperty.call(ctx, key), key).toBe(false);
    }
  });

  it("projects nothing when probes are on but the pipeline is not", () => {
    // An unreachable config through the normal path, and the projection is
    // where that has to be true rather than a fact about the YAML.
    const ctx = contextFor({ probes: true });
    expect(ctx.probesEnabled).toBeUndefined();
  });

  it("projects `probesEnabled` as the literal string the YAML compares against", () => {
    expect(contextFor(ON).probesEnabled).toBe("true");
  });

  it("sums the PHASE timeout across the steps that will actually run", () => {
    // Not the install budget: the engine's `timeout_seconds` bounds the whole
    // phase, and a process killed part-way through a coverage run writes no
    // env.json at all — the one outcome this design exists to prevent.
    const bare = contextFor({ ...ON, prepareTimeoutSeconds: 300, coverageTimeoutSeconds: 900 });
    expect(bare.probePhaseTimeoutSeconds).toBe("330");

    const withCoverage = contextFor({
      ...ON,
      probeCoverage: true,
      prepareTimeoutSeconds: 300,
      coverageTimeoutSeconds: 900,
    });
    expect(withCoverage.probePhaseTimeoutSeconds).toBe("1230");

    const withBoth = contextFor({
      ...ON,
      probeTypecheck: true,
      probeCoverage: true,
      prepareTimeoutSeconds: 300,
      coverageTimeoutSeconds: 900,
    });
    expect(withBoth.probePhaseTimeoutSeconds).toBe("1530");
  });

  it("reads that sum from the context rather than a packaged constant", () => {
    // `templated-number`: `{ from: <ctx path>, default: N }`. A plain integer
    // here would silently ignore every operator timeout.
    expect(prepare!.timeout_seconds).toEqual({ from: "probePhaseTimeoutSeconds", default: 300 });
  });
});

// ── the rendered command ─────────────────────────────────────────────────────

describe("the rendered command", () => {
  it("asks for the cheap thing by default: install only", () => {
    const command = renderedCommand(ON);
    expect(command).toContain('"$FACTS" prepare $ARGS --never-fail');
    // The three costly opt-ins are gated on the literal string, so the branch
    // taken when a variable is absent is the one that adds no flag.
    expect(command).toContain('[ "false" = "true" ] && ARGS="$ARGS --lifecycle-scripts"');
    expect(command).toContain('[ "false" = "true" ] && ARGS="$ARGS --typecheck"');
    expect(command).toContain('[ "false" = "true" ] && ARGS="$ARGS --coverage"');
  });

  it("opens each gate only when the operator set that switch", () => {
    expect(renderedCommand({ ...ON, probeTypecheck: true })).toContain(
      '[ "true" = "true" ] && ARGS="$ARGS --typecheck"',
    );
    expect(renderedCommand({ ...ON, probeCoverage: true })).toContain(
      '[ "true" = "true" ] && ARGS="$ARGS --coverage"',
    );
    expect(renderedCommand({ ...ON, probeLifecycleScripts: true })).toContain(
      '[ "true" = "true" ] && ARGS="$ARGS --lifecycle-scripts"',
    );
  });

  it("resolves the binary in §D1's order — env, PATH, then the image path", () => {
    // The eval harness runs `--sandbox none` on the host, where only the first
    // of the three exists; the sandbox image has only the third (WP2). A
    // hardcoded path would make one of the two unmeasurable.
    const command = renderedCommand(ON);
    expect(command).toContain("${LASTLIGHT_FACTS_BIN:-$(command -v lastlight-facts");
    expect(command).toContain("/opt/lastlight/bin/lastlight-facts");
  });

  it("leaves no unrendered template marker — the shell guard rejects one outright", () => {
    // `validateShellCommand` THROWS on a leftover `{{`, which fails the phase,
    // which is the §D12 loop. Every context this phase can legally run in has
    // to render clean.
    for (const over of [ON, { ...ON, probeCoverage: true, probeTypecheck: true }]) {
      expect(renderedCommand(over)).not.toMatch(/\{\{|\}\}/);
    }
  });
});

// ── AC1 + the fallback envelope ──────────────────────────────────────────────

/**
 * `ProbeEnvSchema`'s field list, as a literal.
 *
 * `apps/server` has **no dependency edge to `lastlight-code-facts`** and must
 * not grow one for a test — the CLI is invoked as a process, resolved at run
 * time through `LASTLIGHT_FACTS_BIN`, which is the whole reason the eval harness
 * can measure this on a host that has never seen the sandbox image. So the
 * contract is pinned on both sides instead: `prepare.test.ts` in that package
 * asserts the same list against the schema and names this file when it breaks.
 */
const PROBE_ENV_FIELDS = [
  "version",
  "generatedAt",
  "repo",
  "packageManager",
  "install",
  "installed",
  "lifecycleScripts",
  "typecheck",
  "typecheckDiagnostics",
  "coverage",
  "coverageReport",
  "durationMs",
  "degraded",
];

interface FallbackEnv {
  version: number;
  install: string;
  installed: boolean;
  typecheck: string;
  coverage: string;
  coverageReport: string | null;
  degraded: { extractor: string; reason: string }[];
}

describe("the shell fallback writes a VALID env.json", () => {
  /**
   * Execute the phase's own `fallback()` in a real shell and parse what it
   * wrote. The literal is a string inside a YAML file — nothing type-checks it,
   * and it is only ever reached when something has already gone wrong, which is
   * the worst possible moment to discover it is malformed.
   */
  async function runFallback(hasNodeModules: boolean): Promise<FallbackEnv> {
    const { mkdtempSync, mkdirSync, readFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { execFileSync } = await import("node:child_process");

    const dir = mkdtempSync(join(tmpdir(), "ll-prepare-fallback-"));
    try {
      if (hasNodeModules) mkdirSync(join(dir, "node_modules"), { recursive: true });
      // Take the phase's real command and stop it after defining `fallback`, so
      // what runs is the YAML's own text rather than a copy of it.
      const command = renderedCommand(ON);
      const upTo = command.indexOf("ARGS=");
      expect(upTo).toBeGreaterThan(0);
      execFileSync("sh", ["-c", `${command.slice(0, upTo)}\nfallback "it broke"`], { cwd: dir });
      return JSON.parse(
        readFileSync(join(dir, ".lastlight/pr-review/probes/env.json"), "utf8"),
      ) as FallbackEnv;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("carries every field the CLI's own env.json carries, and no other", async () => {
    const parsed = await runFallback(false);
    expect(Object.keys(parsed).sort()).toEqual([...PROBE_ENV_FIELDS].sort());
    expect(parsed.version).toBe(1);
    expect(parsed.install).toBe("failed");
    expect(parsed.degraded[0].reason).toContain("it broke");
    // Not `clean`, not `absent`, not an empty list: a step that never ran must
    // not be reported as a step that ran and found nothing.
    expect(parsed.typecheck).toBe("failed");
    expect(parsed.coverage).toBe("failed");
    expect(parsed.coverageReport).toBeNull();
  });

  it("reads `installed` off the filesystem even here", async () => {
    // A dead process still leaves whatever it managed to unpack, and `installed`
    // is the only question a later phase asks.
    expect((await runFallback(false)).installed).toBe(false);
    expect((await runFallback(true)).installed).toBe(true);
  });

  it("gives the degraded exit a reason that forbids reading it as `nothing to find`", async () => {
    const reasons = [...(prepare!.command ?? "").matchAll(/fallback "([^"]+)"/g)].map((m) => m[1]);
    expect(reasons.length).toBeGreaterThanOrEqual(1);
    for (const reason of reasons) {
      expect(reason).toContain(
        "NOTHING downstream may read a thin analysis as evidence that there is nothing to find",
      );
    }
  });
});

// ── AC2 / AC2b / §D12 ────────────────────────────────────────────────────────

describe("AC2 — a failed prepare degrades the run, it does not fail it", () => {
  it("catches a dead process at the SHELL, not with --never-fail alone", () => {
    // `--never-fail` is an in-process try/catch and cannot cover a process that
    // DIES (OOM, an unexecutable binary). The `if ! …; then fallback` is the
    // actual guarantee, and it is the same shape `facts` carries.
    const command = renderedCommand(ON);
    expect(command).toMatch(/if ! "\$FACTS" prepare .*; then\n\s*fallback /);
  });

  it("declares no `on_output` action that could fail the phase", () => {
    // `skip_if` downstream, never `on_output.action: fail` — a red run posts
    // `messages.on_failure`, offers a Retry that cannot succeed, pollutes the
    // cost stats and defeats the SHA dedup.
    for (const phase of def.phases) {
      expect((phase as Record<string, unknown>).on_output, phase.name).toBeUndefined();
    }
  });

  it("lets every downstream phase proceed on `all_done`, so a skip never cascades", () => {
    // The failure this guards: `prepare` skips on every deployment that has not
    // enabled probes, and a skipped node is not `succeeded`. With the default
    // `all_success` on `facts`, the whole pipeline — and the review itself —
    // would vanish the moment WP4 shipped off.
    expect(byName.get("facts")?.depends_on).toEqual(["prepare"]);
    expect(byName.get("facts")?.trigger_rule).toBe("all_done");
  });
});

describe("AC2b — nothing here re-derives what CI already said", () => {
  it("runs no test suite unless the operator asked for coverage", () => {
    // Locked decision 11: `checksState` / `ciSection` are already projected into
    // the run context and consumed by `skills/pr-review/SKILL.md` §4.
    // Re-deriving red/green is duplication of a matrix build, on one machine.
    const command = renderedCommand({ ...ON, probeCoverage: false });
    expect(command).not.toMatch(/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b/);
    expect(command).not.toMatch(/\bvitest\b|\bjest\b|\bgo test\b|\bmvn\b/);
  });

  it("keeps the suite behind its own switch even when probes are on", () => {
    // `probeCoverage` is separate from `probes` because it is a separate price:
    // everything else in `prepare` is seconds and this is minutes. It is the
    // wall-clock item §D13 deleted with `mutants` and `suite`, bought back only
    // for the `tests` family, which has never had an input at all.
    expect(renderedCommand(ON)).toContain('[ "false" = "true" ] && ARGS="$ARGS --coverage"');
  });

  it("never asks GitHub for anything — it is a bash phase with no token use", () => {
    const command = renderedCommand(ON);
    expect(command).not.toMatch(/\bgh\b|api\.github\.com|github_/);
  });
});

describe("the phase writes only under .lastlight/, never into the diff", () => {
  it("targets the probes directory and nothing else", () => {
    const command = renderedCommand(ON);
    expect(command).toContain("OUT=.lastlight/pr-review/probes/env.json");
    expect(command).toContain("mkdir -p .lastlight/pr-review/probes");
    // The one exception is `node_modules`, which the install creates and which
    // `.gitignore` already covers in every repo that has one.
    // Every stdout redirect in the phase, `2>/dev/null` excluded — silencing a
    // probe's stderr is not writing to the tree.
    const redirects = [...command.matchAll(/(?<!2)>\s*("?\$?[\w./-]+"?)/g)].map((m) => m[1]);
    expect(redirects).toEqual(['"$OUT"']);
  });
});

/** Non-vacuity: the phase this file is about is the one in the workflow. */
describe("control", () => {
  it("is a bash phase, so none of the above is asserting against an agent prompt", () => {
    expect((prepare as PhaseDefinition).type).toBe("bash");
    expect((prepare as PhaseDefinition).prompt).toBeUndefined();
    expect((prepare as PhaseDefinition).model).toBeUndefined();
  });
});

// ── `falsify` — the oracle ───────────────────────────────────────────────────

const falsify = byName.get("falsify");
if (!falsify) throw new Error("pr-review.yaml has no `falsify` phase");

describe("falsify — the loop, its gate, and the rule with money on it", () => {
  it("runs on the cheap survey model, not the review model", () => {
    // The oracle's value is EXECUTION, not reasoning power. Paying review-model
    // rates to run `eslint` against a four-line probe file buys nothing, and the
    // measured ordering (Haiku beats Sonnet on review recall on two independent
    // evals) says the cheap model is not the compromise it looks like.
    expect(falsify!.model).toBe("{{models.review-survey}}");
  });

  it("reads its round budget from the operator's config", () => {
    // Two. v3's lesson 3: a five-line existence gate earned the only gold match
    // in the investigation, while v2's full quote validator cost 2.4x for a
    // worse result. A packaged integer here would ignore `probeRounds` silently.
    expect(falsify!.generic_loop?.max_iterations).toEqual({ from: "probeRounds", default: 2 });
  });

  it("gates the loop on a LITERAL shell command with no template marker", () => {
    // `validateShellCommand` throws on a leftover `{{`, and a throwing gate
    // fails the phase, which is the §D12 re-dispatch loop. The gate also has to
    // resolve the CLI itself, in §D1's order, because a phase env is the only
    // thing it gets.
    const gate = falsify!.generic_loop?.until_bash ?? "";
    expect(gate).not.toMatch(/\{\{|\}\}/);
    expect(gate).toContain("${LASTLIGHT_FACTS_BIN:-$(command -v lastlight-facts");
    expect(gate).toContain("probes --dir .lastlight/pr-review");
  });

  it("sits between the survey fan-out and the review, on `all_done`", () => {
    // Between, because it consumes what the surveys wrote; `all_done`, because
    // it skips on every deployment without probes and a skipped node is not
    // `succeeded` — with `all_success` the review itself would vanish.
    // WP11c: the six chained survey phases became one `survey` fan-out node,
    // so the edge that used to name the LAST family now names the whole node.
    expect(falsify!.depends_on).toEqual(["survey"]);
    expect(falsify!.trigger_rule).toBe("all_done");
    expect(byName.get("review")?.depends_on).toEqual(["falsify"]);
  });

  it("degrades rather than fails when a probe round goes wrong", () => {
    // INSIDE `generic_loop`, which is where the schema reads it. At phase level
    // zod strips the key and the policy silently reverts to
    // `{ retries: 0, then: "fail" }` — one degenerate turn then hard-fails the
    // whole review, which records no `assessedHeadShaByWorkflow` and hands
    // `cron-review.yaml` something to re-dispatch every thirty minutes forever.
    // All six survey phases had it in the wrong place until this test was
    // written; assert the LOCATION, not just the value.
    expect((falsify as Record<string, unknown>).on_soft_failure).toBeUndefined();
    expect(falsify!.generic_loop?.on_soft_failure).toEqual({ retries: 1, then: "complete" });
  });

  it("…and so does every survey phase, for the same reason", () => {
    for (const phase of def.phases.filter((p) => p.name.startsWith("survey_"))) {
      expect((phase as Record<string, unknown>).on_soft_failure, phase.name).toBeUndefined();
      expect(phase.generic_loop?.on_soft_failure, phase.name).toEqual({
        retries: 1,
        then: "complete",
      });
    }
  });
});

describe("the falsify prompt carries the constraints, not just the task", () => {
  const prompt = loadPromptTemplate(falsify!.prompt!);

  it("states the no-deletion-without-a-transcript rule in those terms", () => {
    // Verification bolted onto a conservative generator raises precision and
    // COSTS RECALL — measured twice, once here (v2, reverted) and once
    // externally (54.5 -> 67.1 precision, 45.5 -> 39.8 recall). The oracle is
    // safe only because generation was re-tuned to over-produce against it, and
    // that safety is gone the moment refutation by argument is allowed.
    // Line-break tolerant: the rule is a wrapped block quote in the prompt.
    expect(prompt.replace(/\s*>?\s*\n\s*>?\s*/g, " ")).toMatch(
      /may NOT drop a hypothesis without a counter-transcript/i,
    );
    expect(prompt).toMatch(/Silence is never a refutation/i);
  });

  it("makes `unprobed` an available, non-fatal answer", () => {
    // The gate is satisfiable only if this is spelled out: a pass with no honest
    // way to close it will find a dishonest one.
    expect(prompt).toContain("unprobed");
    expect(prompt).toMatch(/survives/i);
  });

  it("prefers differential execution, which is what a PR uniquely offers", () => {
    expect(prompt).toMatch(/differential execution/i);
    expect(prompt).toContain("origin/{{baseBranch}}");
  });

  it("tells it to read env.json rather than guess what it can run", () => {
    expect(prompt).toContain(".lastlight/pr-review/probes/env.json");
    expect(prompt).toMatch(/"installed": false/);
  });

  it("forbids the four things that would corrupt a later phase", () => {
    expect(prompt).toMatch(/Do NOT post a review/);
    expect(prompt).toMatch(/Do NOT write `?\.lastlight\/pr-review\/findings\.json/);
    expect(prompt).toMatch(/Do NOT edit any `?hypotheses/);
    expect(prompt).toMatch(/Do NOT commit anything/);
  });

  it("writes only where nothing else owns, and in the shape the gate reads", () => {
    expect(prompt).toContain(".lastlight/pr-review/probes/<hypothesis-id>.txt");
    expect(prompt).toContain(".lastlight/pr-review/probes/verdicts.jsonl");
    // The gate keys on `hypothesis` and `verdict`, and demands `transcript` for
    // the two verdicts that claim execution. A prompt that named different
    // fields would produce an unsatisfiable loop.
    for (const field of ['"hypothesis"', '"verdict"', '"transcript"']) {
      expect(prompt, field).toContain(field);
    }
  });

  it("renders clean against a real context", () => {
    const rendered = renderTemplate(prompt, {
      owner: "acme",
      repo: "widgets",
      ...contextFor(ON),
    } as unknown as TemplateContext);
    expect(rendered).not.toMatch(/\{\{|\}\}/);
  });
});
