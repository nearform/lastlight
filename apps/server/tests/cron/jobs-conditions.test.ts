import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `condition.unless` as a PREDICATE MAP (07-review-triggers.md §7.4b).
 *
 * `jobs.ts` used to compare the field against the literal string
 * `"webhooksEnabled"`, so a cron YAML could express exactly one condition and
 * any other value was silently ignored — a typo turned a conditional cron into
 * an unconditional one with no error and no log line. Phase 8 briefly made the
 * generalisation moot by deleting the only consumer; 09 → S5 keeps the crons,
 * and `check-prs-awaiting-review` must now run *with* webhooks enabled, so the
 * mechanism is live again and needs to be more than one `if`.
 */

type CronDef = {
  name: string;
  workflow: string;
  schedule: string;
  context?: Record<string, unknown>;
  condition?: { unless?: string };
};

const cronDefs = vi.fn<() => CronDef[]>(() => []);
vi.mock("#src/workflows/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/workflows/loader.js")>();
  return { ...actual, getCronWorkflows: () => cronDefs() };
});
vi.mock("#src/managed-repos.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/managed-repos.js")>();
  return { ...actual, getAccessibleManagedRepos: () => ["acme/a"] };
});

const { getJobs } = await import("#src/cron/jobs.js");

const def = (name: string, unless?: string): CronDef => ({
  name,
  workflow: name,
  schedule: "0 9 * * *",
  ...(unless ? { condition: { unless } } : {}),
});

const names = (opts: Parameters<typeof getJobs>[0]) => getJobs(opts).map((j) => j.name);

beforeEach(() => {
  cronDefs.mockReset();
});

describe("getJobs — condition.unless predicate map", () => {
  it("still filters `unless: webhooksEnabled` when webhooks are on", () => {
    cronDefs.mockReturnValue([def("legacy", "webhooksEnabled"), def("always")]);
    expect(names({ webhooksEnabled: true, crons: { enable: [], disable: [] } })).toEqual(["always"]);
  });

  it("registers it when webhooks are off", () => {
    cronDefs.mockReturnValue([def("legacy", "webhooksEnabled"), def("always")]);
    expect(names({ webhooksEnabled: false, crons: { enable: [], disable: [] } })).toEqual([
      "legacy",
      "always",
    ]);
  });

  it("REGISTERS a cron whose condition it does not recognise, and says so", () => {
    // Registration is the safe direction. A silently dropped cron produces no
    // ticks, no rows and no error — which is the failure the literal comparison
    // already had; a spurious tick is a cheap no-op.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cronDefs.mockReturnValue([def("typo", "webhooksEnbaled")]);
    expect(names({ webhooksEnabled: true, crons: { enable: [], disable: [] } })).toEqual(["typo"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("webhooksEnbaled"));
    warn.mockRestore();
  });

  it("a cron with NO condition is registered whatever the context says", () => {
    // This is what `check-prs-awaiting-review` became: it must run *with*
    // webhooks enabled, because it is the release mechanism for every PR whose
    // fix chain ended without pushing, and the re-pickup that makes the PR-
    // scoped lock's drop-on-conflict safe (09 → S2/S5).
    cronDefs.mockReturnValue([def("check-prs-awaiting-review")]);
    expect(names({ webhooksEnabled: true, crons: { enable: [], disable: [] } })).toEqual([
      "check-prs-awaiting-review",
    ]);
  });
});
