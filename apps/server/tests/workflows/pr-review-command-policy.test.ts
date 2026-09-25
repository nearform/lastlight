import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";
import {
  AgentWorkflowSchema,
  phaseConfigFor,
  resolveCommandPolicy,
  type PhaseDefinition,
  type TemplateContext,
} from "lastlight-workflow-engine";
import { StubAssetLoader } from "lastlight-workflow-engine/test-support";
import type { PrState } from "#src/engine/pr-state.js";
import { renderContext } from "#src/engine/pr-decisions.js";
import { defaultDependenciesConfig, defaultFixConfig } from "lastlight-shared/config-types";
import { defaultReviewConfig } from "#src/config/config.js";

/**
 * Issue #403 — which bash command classes each pr-review agent phase may run.
 * The enforcement (pattern table, block/log) is agentic-pi's and is tested
 * there; this layer owns the YAML → config → resolved-policy chain, and the
 * one derivation that depends on config: falsify's modes follow
 * `review.analysis.probes`, review's install mode follows
 * `review.analysis.enabled`.
 */

const def = getWorkflow("pr-review");
const phase = (name: string): PhaseDefinition => {
  const p = def.phases.find((x) => x.name === name);
  if (!p) throw new Error(`pr-review.yaml has no \`${name}\` phase`);
  return p;
};

function prState(): PrState {
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
  } as PrState;
}

type AnalysisOverrides = Partial<ReturnType<typeof defaultReviewConfig>["analysis"]>;

function contextFor(over: AnalysisOverrides): TemplateContext {
  const base = defaultReviewConfig();
  return renderContext(prState(), defaultFixConfig(), defaultDependenciesConfig(), {
    ...base,
    analysis: { ...base.analysis, ...over },
  }) as unknown as TemplateContext;
}

/** The policy agentic-pi would receive for `name`, resolved as the engine resolves it. */
function effective(name: string, over: AnalysisOverrides) {
  return phaseConfigFor({}, phase(name), new StubAssetLoader(), contextFor(over)).commandPolicy;
}

const modes = (p: ReturnType<typeof effective>) => ({
  install: p?.install,
  "install-scratch": p?.["install-scratch"],
  test: p?.test,
});

describe("pr-review command policy (#403)", () => {
  it("survey and adjudicate never install and never run the suite", () => {
    for (const name of ["survey", "adjudicate"]) {
      const p = effective(name, { enabled: true, probes: "full" });
      expect(modes(p), name).toEqual({ install: "block", "install-scratch": undefined, test: "block" });
      expect(p?.reason, name).toBeTruthy();
    }
  });

  it("every survey branch inherits the phase policy — none replaces it", () => {
    const survey = phase("survey");
    expect(survey.branches?.length).toBeGreaterThan(0);
    for (const b of survey.branches ?? []) expect(b.command_policy, b.name).toBeUndefined();
  });

  it("falsify: repo installs blocked in every mode; tests and scratch installs follow the probe mode", () => {
    // static: nothing is installed, so a test run cannot work.
    expect(modes(effective("falsify", { enabled: true, probes: "static" }))).toEqual({
      install: "block",
      "install-scratch": "block",
      test: "block",
    });
    // full: `prepare` installed the tree; a targeted test is the point of the phase.
    expect(modes(effective("falsify", { enabled: true, probes: "full" }))).toEqual({
      install: "block",
      "install-scratch": "log",
      test: "log",
    });
  });

  it("falsify's templated modes have no fallback — a context without them is a wiring bug", () => {
    expect(() => phaseConfigFor({}, phase("falsify"), new StubAssetLoader(), {} as TemplateContext)).toThrow(
      /falsify\.command_policy\.install-scratch: `from: probeScratchInstallPolicy` did not resolve/,
    );
  });

  it("review: the suite is blocked in both modes; an install only when the pipeline owns execution", () => {
    expect(modes(effective("review", { enabled: true, probes: "off" }))).toMatchObject({ install: "block", test: "block" });
    // Pipeline off: the one review pass keeps the pr-review skill's install-to-probe affordance.
    expect(modes(effective("review", { enabled: false }))).toMatchObject({ install: "allow", test: "block" });
  });

  it("the probe-mode keys are seeded only when probes are on", () => {
    const off = contextFor({ enabled: true, probes: "off" }) as Record<string, unknown>;
    expect(off.probeTestPolicy).toBeUndefined();
    expect(off.reviewInstallPolicy).toBe("block");
    expect(contextFor({ enabled: false }) as Record<string, unknown>).not.toHaveProperty("reviewInstallPolicy");
  });
});

describe("command_policy schema", () => {
  const wf = (policy: unknown, branchPolicy?: unknown) => ({
    kind: "review",
    name: "p",
    phases: [
      {
        name: "survey",
        type: "fanout",
        prompt: "x.md",
        command_policy: policy,
        branches: [{ name: "a", ...(branchPolicy ? { command_policy: branchPolicy } : {}) }],
      },
    ],
  });

  it("refuses an unknown class or mode, naming the field", () => {
    expect(AgentWorkflowSchema.safeParse(wf({ tests: "block" })).success).toBe(false);
    expect(AgentWorkflowSchema.safeParse(wf({ test: "deny" })).success).toBe(false);
    expect(AgentWorkflowSchema.safeParse(wf({ test: { form: "x" } })).success).toBe(false);
    expect(AgentWorkflowSchema.safeParse(wf({ install: "block", test: { from: "k", default: "log" } })).success).toBe(
      true,
    );
  });

  it("a fan-out branch may carry its own policy", () => {
    const parsed = AgentWorkflowSchema.parse(wf({ test: "block" }, { test: "log" }));
    expect(parsed.phases[0].branches?.[0].command_policy).toEqual({ test: "log" });
  });

  it("a templated mode: present-but-invalid throws even with a default; absent uses it", () => {
    const spec = { test: { from: "k", default: "block" as const } };
    expect(resolveCommandPolicy(spec, {} as TemplateContext, "p")).toEqual({ test: "block" });
    expect(resolveCommandPolicy(spec, { k: "log" } as TemplateContext, "p")).toEqual({ test: "log" });
    expect(() => resolveCommandPolicy(spec, { k: "blok" } as TemplateContext, "p")).toThrow(/p\.test: .*got "blok"/);
  });
});
