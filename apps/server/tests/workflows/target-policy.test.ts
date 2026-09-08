import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clearWorkflowCache,
  configureWorkflowAssets,
  listAgentWorkflows,
  validateAssets,
} from "#src/workflows/loader.js";
import {
  DEFAULT_POLICY,
  gitAccessFor,
  isPerTargetRecreate,
  isPerTargetReuse,
  isPerTargetWorkspace,
  isPrFixShaped,
  prFixShapedWorkflows,
  prepopulatesPrHeadRef,
  prepopulatesSynthBranch,
  workflowTargetPolicy,
  __resetTargetPolicyCacheForTest,
} from "#src/workflows/target-policy.js";
import { gitAccessProfileForWorkflow } from "#src/workflows/runner.js";

/**
 * The five runtime-policy keys of issue #368 — and, first, the CUTOVER GUARD.
 *
 * Six behaviours used to be keyed on a literal workflow name in compiled core
 * code, so an overlay-only workflow could never register itself into any of
 * them: it silently got a read token (cannot submit a review, cannot push) and
 * no head-ref pinning (reviews the base branch, saying nothing). They are now
 * declared per workflow and derived from the loaded definitions.
 *
 * The cutover was HARD — the tables were deleted, not unioned in — so the
 * safety net is the first describe below: the deleted tables, transcribed
 * verbatim, asserted entry-for-entry against what the built-in YAMLs now
 * derive. A missed key on any built-in fails here rather than shipping.
 */

// ── The deleted tables, verbatim ─────────────────────────────────────────────
// `gitAccessProfileForWorkflow`'s switch (runner.ts) and the four Sets
// (target-policy.ts), as they stood immediately before the refactor. Do NOT
// "fix" a disagreement by editing these — they are the pre-image.

const LEGACY_GIT_ACCESS: Record<string, string> = {
  build: "repo-write",
  "pr-fix": "repo-write",
  "dependabot-ci-fix": "repo-write",
  "dependabot-pr-merge": "repo-write",
  "pr-review": "review-write",
  "issue-triage": "issues-write",
  "issue-comment": "issues-write",
  "pr-comment": "issues-write",
  explore: "issues-write",
  answer: "issues-write",
  "security-review": "issues-write",
  verify: "issues-write",
  "qa-test": "issues-write",
  demo: "issues-write",
  "security-feedback": "repo-write",
};

const LEGACY_PER_TARGET_REUSE = ["pr-review", "pr-fix", "dependabot-ci-fix", "dependabot-pr-merge"];
const LEGACY_PER_TARGET_RECREATE = ["build"];
const LEGACY_PREPOPULATE_SYNTH = ["build", "verify", "qa-test", "demo"];
const LEGACY_PR_HEADREF_PREPOPULATE = ["pr-review", "demo", "qa-test", "verify"];
const LEGACY_PR_FIX_SHAPED = ["pr-fix", "dependabot-ci-fix"];

describe("the built-in workflows derive exactly what the hardcoded tables said", () => {
  // Runs against the REAL packaged workflows/ dir — no fixture — because the
  // claim is about the shipped YAMLs, not about the derivation machinery.
  beforeEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    __resetTargetPolicyCacheForTest();
  });

  const builtInNames = (): string[] => listAgentWorkflows().map((d) => d.name);

  it("git_access matches the deleted switch for every built-in", () => {
    const derived = Object.fromEntries(
      builtInNames().map((name) => [name, gitAccessProfileForWorkflow(name)]),
    );
    const expected = Object.fromEntries(
      builtInNames().map((name) => [name, LEGACY_GIT_ACCESS[name] ?? "read"]),
    );
    expect(derived).toEqual(expected);
  });

  it("workspace matches the deleted reuse + recreate sets", () => {
    for (const name of builtInNames()) {
      expect([name, isPerTargetReuse(name)]).toEqual([name, LEGACY_PER_TARGET_REUSE.includes(name)]);
      expect([name, isPerTargetRecreate(name)]).toEqual([
        name,
        LEGACY_PER_TARGET_RECREATE.includes(name),
      ]);
    }
  });

  it("prepopulate_synth_branch matches the deleted set", () => {
    for (const name of builtInNames()) {
      expect([name, prepopulatesSynthBranch(name)]).toEqual([
        name,
        LEGACY_PREPOPULATE_SYNTH.includes(name),
      ]);
    }
  });

  it("prepopulate_pr_head_ref matches the deleted set", () => {
    for (const name of builtInNames()) {
      expect([name, prepopulatesPrHeadRef(name)]).toEqual([
        name,
        LEGACY_PR_HEADREF_PREPOPULATE.includes(name),
      ]);
    }
  });

  it("pr_fix_shaped matches the deleted set", () => {
    expect([...prFixShapedWorkflows()].sort()).toEqual([...LEGACY_PR_FIX_SHAPED].sort());
  });

  it("every built-in declares at least one key, so none is silently defaulted", () => {
    // Not strictly implied by the tables above — `repo-health` was absent from
    // all five and its correct policy IS the default. Declaring `git_access:
    // read` explicitly is what distinguishes "we decided read" from "nobody
    // ever thought about it", which is the whole point of the refactor.
    const defs = listAgentWorkflows();
    const silent = defs
      .filter(
        (d) =>
          d.git_access === undefined &&
          d.workspace === undefined &&
          d.prepopulate_synth_branch === undefined &&
          d.prepopulate_pr_head_ref === undefined &&
          d.pr_fix_shaped === undefined,
      )
      .map((d) => d.name);
    expect(silent).toEqual([]);
  });

  it("reuse and recreate are mutually exclusive — the enum deleted an illegal state", () => {
    for (const name of builtInNames()) {
      expect(isPerTargetReuse(name) && isPerTargetRecreate(name)).toBe(false);
      expect(isPerTargetWorkspace(name)).toBe(isPerTargetReuse(name) || isPerTargetRecreate(name));
    }
  });
});

// ── Derivation ───────────────────────────────────────────────────────────────

describe("workflowTargetPolicy", () => {
  let builtIn: string;
  let overlay: string;

  function write(root: string, file: string, body: string): void {
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(join(root, "workflows", file), body);
  }

  function wf(name: string, keys: string[] = []): string {
    return [`name: ${name}`, ...keys, "phases:", "  - name: p", "    type: context", ""].join("\n");
  }

  beforeEach(() => {
    builtIn = mkdtempSync(join(tmpdir(), "target-policy-builtin-"));
    overlay = mkdtempSync(join(tmpdir(), "target-policy-overlay-"));
    configureWorkflowAssets({ builtInRoot: builtIn, overlayRoot: overlay });
    clearWorkflowCache();
    __resetTargetPolicyCacheForTest();
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    __resetTargetPolicyCacheForTest();
  });

  it("an OVERLAY-ONLY workflow gets first-class policy with no core edit", () => {
    // The acceptance test of the whole refactor. A deployment that ships its own
    // reviewer arm — a name core has never heard of — used to be minted a `read`
    // token (so it could not submit its review) and pre-cloned at the BASE
    // branch (so it reviewed the wrong code, silently). Both were unfixable
    // without a core patch registering the name.
    write(
      overlay,
      "overlay-review.yaml",
      wf("overlay-review", [
        "pr_scoped: true",
        "git_access: review-write",
        "workspace: per-target-reuse",
        "prepopulate_pr_head_ref: true",
      ]),
    );

    expect(gitAccessProfileForWorkflow("overlay-review")).toBe("review-write");
    expect(isPerTargetReuse("overlay-review")).toBe(true);
    expect(prepopulatesPrHeadRef("overlay-review")).toBe(true);
  });

  it("a workflow declaring nothing gets the default policy", () => {
    write(builtIn, "plain.yaml", wf("plain"));
    expect(workflowTargetPolicy("plain")).toEqual(DEFAULT_POLICY);
  });

  it("a name the loader has never heard of gets the default policy", () => {
    // Every in-process handler — `chat`, `approval-response`, `status-report` —
    // reaches these accessors and has no YAML at all. The old tables' `default:`
    // arm and `Set.has() === false` gave them exactly this.
    write(builtIn, "plain.yaml", wf("plain"));
    expect(workflowTargetPolicy("approval-response")).toEqual(DEFAULT_POLICY);
    expect(gitAccessFor("chat")).toBe("read");
    expect(isPrFixShaped("status-report")).toBe(false);
  });

  it("an overlay fork overrides the built-in's policy by name", () => {
    write(builtIn, "thing.yaml", wf("thing", ["git_access: read"]));
    write(overlay, "thing.yaml", wf("thing", ["git_access: repo-write"]));
    // Overlays already own prompts, skills and the agent persona; they are
    // trusted, so declaring repo-write and minting a push token is allowed.
    expect(gitAccessFor("thing")).toBe("repo-write");
  });

  it("re-derives after an asset reload rather than serving a stale memo", () => {
    write(builtIn, "thing.yaml", wf("thing", ["git_access: read"]));
    expect(gitAccessFor("thing")).toBe("read");

    write(builtIn, "thing.yaml", wf("thing", ["git_access: repo-write"]));
    clearWorkflowCache(); // what an admin asset reload does — bumps the version
    expect(gitAccessFor("thing")).toBe("repo-write");
  });
});

// ── Loader validation ────────────────────────────────────────────────────────

describe("validateAssets — runtime-policy invariants", () => {
  let builtIn: string;

  function write(file: string, body: string): void {
    writeFileSync(join(builtIn, "workflows", file), body);
  }

  function wf(name: string, keys: string[] = []): string {
    return [`name: ${name}`, ...keys, "phases:", "  - name: p", "    type: context", ""].join("\n");
  }

  function captureLogger() {
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: () => log,
    };
    return log;
  }

  /** Only the undeclared-policy warning — the pr_scoped one carries `routeKey`. */
  const policyWarnings = (log: ReturnType<typeof captureLogger>) =>
    log.warn.mock.calls.filter((c) => "workflow" in ((c[1] ?? {}) as object));

  beforeEach(() => {
    builtIn = mkdtempSync(join(tmpdir(), "target-policy-validate-"));
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    __resetTargetPolicyCacheForTest();
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    __resetTargetPolicyCacheForTest();
  });

  it("throws when pr_fix_shaped is declared without pr_scoped", () => {
    write("f.yaml", wf("my-fix", ["pr_fix_shaped: true"]));
    expect(() => validateAssets(undefined, captureLogger())).toThrow(/pr_fix_shaped/);
  });

  it("accepts pr_fix_shaped alongside pr_scoped", () => {
    write("f.yaml", wf("my-fix", ["pr_scoped: true", "pr_fix_shaped: true"]));
    expect(() => validateAssets(undefined, captureLogger())).not.toThrow();
  });

  it("throws when per-target-recreate has no pre-populate source", () => {
    write("b.yaml", wf("my-build", ["workspace: per-target-recreate"]));
    expect(() => validateAssets(undefined, captureLogger())).toThrow(/pre-populate source/);
  });

  it("accepts per-target-recreate with a synth-branch pre-populate", () => {
    write(
      "b.yaml",
      wf("my-build", ["workspace: per-target-recreate", "prepopulate_synth_branch: true"]),
    );
    expect(() => validateAssets(undefined, captureLogger())).not.toThrow();
  });

  it("warns when a ROUTED workflow declares none of the keys", () => {
    // The mitigation chosen over a compatibility floor: an overlay that forked
    // a built-in before these keys existed keeps the name but resolves to the
    // defaults, losing its token profile and its head-ref pinning silently.
    const log = captureLogger();
    write("r.yaml", wf("my-review"));

    validateAssets({ github: { pr_review: "my-review" } } as never, log);

    const warnings = policyWarnings(log);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]![1]).toMatchObject({ workflow: "my-review" });
    expect(warnings[0]![0]).toContain("git_access: read");
  });

  it("stays quiet when the routed workflow declares a key", () => {
    const log = captureLogger();
    write("r.yaml", wf("my-review", ["pr_scoped: true", "git_access: review-write"]));

    validateAssets({ github: { pr_review: "my-review" } } as never, log);

    expect(policyWarnings(log)).toHaveLength(0);
  });

  it("says nothing about an UNROUTED workflow", () => {
    // A workflow nothing dispatches cannot be silently mis-provisioned, and
    // warning on every read-profile workflow would train operators to scroll
    // past the line.
    const log = captureLogger();
    write("r.yaml", wf("my-review"));
    write("o.yaml", wf("orphan"));

    validateAssets({ github: { pr_review: "my-review" } } as never, log);

    expect(policyWarnings(log).map((c) => (c[1] as { workflow: string }).workflow)).toEqual([
      "my-review",
    ]);
  });

  it("warns rather than throwing, so an undeclared fork still boots", () => {
    write("r.yaml", wf("my-review"));
    expect(() =>
      validateAssets({ github: { pr_review: "my-review" } } as never, captureLogger()),
    ).not.toThrow();
  });
});
