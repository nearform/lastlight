import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clearWorkflowCache,
  configureWorkflowAssets,
  validateAssets,
} from "#src/workflows/loader.js";
import {
  LEGACY_PR_SCOPED_NAMES,
  isPrScoped,
  prScopedWorkflows,
  __resetPrScopeCacheForTest,
} from "#src/workflows/pr-scope.js";

/**
 * Which workflows cross the PR-scoped dispatch gate.
 *
 * The set used to be four hardcoded names while the handlers are
 * operator-configurable through `routes.github.*`, so remapping a route to a
 * forked workflow silently dropped the run lock, the per-head-SHA dedup and
 * escalation for it (issue #256). Everything the gate does is a REFUSAL, so
 * nothing looked wrong until two agents pushed the same branch — which is why
 * these tests care as much about the WARNING as about the set.
 */
function wf(name: string, prScoped?: boolean): string {
  return [
    `name: ${name}`,
    ...(prScoped === undefined ? [] : [`pr_scoped: ${prScoped}`]),
    "phases:",
    "  - name: p",
    "    type: context",
    "",
  ].join("\n");
}

describe("prScopedWorkflows", () => {
  let builtIn: string;
  let overlay: string;

  function write(root: string, file: string, body: string): void {
    mkdirSync(join(root, "workflows"), { recursive: true });
    writeFileSync(join(root, "workflows", file), body);
  }

  beforeEach(() => {
    builtIn = mkdtempSync(join(tmpdir(), "pr-scope-builtin-"));
    overlay = mkdtempSync(join(tmpdir(), "pr-scope-overlay-"));
    configureWorkflowAssets({ builtInRoot: builtIn, overlayRoot: overlay });
    clearWorkflowCache();
    __resetPrScopeCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configureWorkflowAssets();
    clearWorkflowCache();
    __resetPrScopeCacheForTest();
  });

  it("is derived from each workflow's own `pr_scoped` metadata", () => {
    write(builtIn, "a.yaml", wf("scoped-one", true));
    write(builtIn, "b.yaml", wf("scoped-two", true));
    write(builtIn, "c.yaml", wf("not-scoped", false));
    write(builtIn, "d.yaml", wf("silent"));

    expect([...prScopedWorkflows()].sort()).toEqual(["scoped-one", "scoped-two"]);
    expect(isPrScoped("not-scoped")).toBe(false);
    expect(isPrScoped("silent")).toBe(false);
  });

  it("keeps the gate for an overlay fork of a built-in that predates the key", () => {
    // The migration hazard: an overlay forked `pr-fix` before `pr_scoped`
    // existed, so its copy has no key. Losing the run lock is far worse than
    // carrying a name we no longer strictly derive.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write(builtIn, "pr-fix.yaml", wf("pr-fix", true));
    write(overlay, "pr-fix.yaml", wf("pr-fix")); // the fork, no key

    expect(isPrScoped("pr-fix")).toBe(true);
    expect(warn.mock.calls.flat().join(" ")).toContain("pr-fix");
    expect(warn.mock.calls.flat().join(" ")).toContain("pr_scoped: true");
  });

  it("warns once, not once per re-derivation", () => {
    // The set is re-derived on every asset-version bump, and every dispatch
    // reads it. A warning per read (or per admin reload) would be noise the
    // operator learns to scroll past — which is the state this replaced.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write(builtIn, "pr-fix.yaml", wf("pr-fix"));

    prScopedWorkflows();
    prScopedWorkflows();
    clearWorkflowCache(); // bumps the version, forcing a re-derivation
    prScopedWorkflows();

    expect(warn.mock.calls.filter((c) => String(c[0]).includes("pr-fix"))).toHaveLength(1);
  });

  it("drops a legacy name the loader no longer has", () => {
    // Deleting or disabling a built-in still removes it, exactly as before —
    // the legacy list is a compatibility floor, not a second source of truth.
    write(builtIn, "a.yaml", wf("scoped-one", true));

    const set = prScopedWorkflows();
    for (const legacy of LEGACY_PR_SCOPED_NAMES) expect(set.has(legacy)).toBe(false);
  });

  it("re-derives when the asset layers change", () => {
    write(builtIn, "a.yaml", wf("scoped-one", true));
    expect([...prScopedWorkflows()]).toEqual(["scoped-one"]);

    write(overlay, "b.yaml", wf("scoped-two", true));
    clearWorkflowCache(); // bumps the asset version, as an admin reload does

    expect([...prScopedWorkflows()].sort()).toEqual(["scoped-one", "scoped-two"]);
  });

  it("never throws on a workflow root that does not exist", () => {
    // Called from `resolvePrStateForDispatch` on every PR event, so a throw here
    // would take out dispatch itself. (The `catch` inside also falls back to the
    // built-in names — erring towards MORE gating, since a lock we cannot
    // justify costs a dropped dispatch a cron re-picks up, while a lock we
    // wrongly drop costs two agents pushing the same branch.)
    vi.spyOn(console, "warn").mockImplementation(() => {});
    configureWorkflowAssets({ builtInRoot: join(builtIn, "does-not-exist") });
    clearWorkflowCache();
    __resetPrScopeCacheForTest();

    expect(() => prScopedWorkflows()).not.toThrow();
    expect(prScopedWorkflows().size).toBe(0);
  });
});

describe("validateAssets warns when a PR route loses the gate", () => {
  let builtIn: string;

  beforeEach(() => {
    builtIn = mkdtempSync(join(tmpdir(), "pr-scope-routes-"));
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    __resetPrScopeCacheForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    configureWorkflowAssets();
    clearWorkflowCache();
    __resetPrScopeCacheForTest();
  });

  function write(file: string, body: string): void {
    writeFileSync(join(builtIn, "workflows", file), body);
  }

  it("names the route, the target and the fix", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("my-review.yaml", wf("my-review")); // an operator's fork, no key

    validateAssets({ github: { pr_review: "my-review" } } as never);

    const said = warn.mock.calls.flat().join(" ");
    expect(said).toContain("github.pr_review");
    expect(said).toContain("my-review");
    expect(said).toContain("pr_scoped: true");
  });

  it("stays quiet when the remapped target declares the key", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("my-review.yaml", wf("my-review", true));

    validateAssets({ github: { pr_review: "my-review" } } as never);

    expect(warn.mock.calls.flat().join(" ")).not.toContain("github.pr_review");
  });

  it("does not warn for routes that are not PR-scoped by design", () => {
    // `pr_comment` dispatches a conversational workflow; demanding the gate
    // there would train operators to ignore the warning.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    write("pr-comment.yaml", wf("pr-comment"));

    validateAssets({ github: { pr_comment: "pr-comment" } } as never);

    expect(warn.mock.calls.flat().join(" ")).not.toContain("github.pr_comment");
  });

  it("warns rather than throwing, so a deliberate remap still boots", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    write("my-review.yaml", wf("my-review"));

    expect(() => validateAssets({ github: { pr_review: "my-review" } } as never)).not.toThrow();
  });
});
