import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveRepos, removeRepos, setRequireApproval } from "#src/managed-repo-approvals.js";
import {
  getManagedRepos,
  getRepoApprovalState,
  setInstallationRepos,
  resetInstallationReposForTests,
  REPO_APPROVAL_SETTING_KEY,
} from "#src/managed-repos.js";
import { setRuntimeConfig, resetRuntimeConfigForTests, type LastLightConfig } from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "./helpers/state-db.js";

function yaml(managedRepos: string[], requireRepoApproval = false): void {
  setRuntimeConfig({ managedRepos, requireRepoApproval } as unknown as LastLightConfig);
}

describe("managed-repo approvals", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
    setInstallationRepos("1", ["a/one", "a/two", "a/three"]);
  });

  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it("first approve seeds from YAML then adds", async () => {
    yaml(["a/one"]);
    const res = await approveRepos(db, ["a/two"], "octocat");
    expect(res).toEqual({ ok: true, state: { requireApproval: false, approved: ["a/one", "a/two"] } });
    const row = await db.getSetting(REPO_APPROVAL_SETTING_KEY);
    expect(row?.value).toEqual({ requireApproval: false, approved: ["a/one", "a/two"] });
    expect(row?.updatedBy).toBe("octocat");
    expect(getManagedRepos()).toEqual(["a/one", "a/two"]);
  });

  it("approve dedupes case-insensitively and stores the grant's spelling", async () => {
    yaml(["A/One"]);
    const res = await approveRepos(db, ["a/one", "A/TWO"]);
    expect(res.ok && res.state.approved).toEqual(["A/One", "a/two"]);
  });

  it("approve rejects a repo outside the grant", async () => {
    yaml([]);
    const res = await approveRepos(db, ["a/one", "b/nope"]);
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(!res.ok && res.error).toContain("b/nope");
    expect(await db.getSetting(REPO_APPROVAL_SETTING_KEY)).toBeNull();
  });

  it("approve before discovery is 409", async () => {
    resetInstallationReposForTests();
    yaml([]);
    const res = await approveRepos(db, ["a/one"]);
    expect(res).toMatchObject({ ok: false, status: 409, error: "installation list not loaded yet" });
  });

  it("remove of the last repo with the flag off and no whenEmpty is 409 would-empty", async () => {
    yaml(["a/one"]);
    const res = await removeRepos(db, ["a/one"], {});
    expect(res).toEqual({ ok: false, status: 409, error: "would-empty", installationCount: 3 });
    expect(getManagedRepos()).toEqual(["a/one"]);
  });

  it("remove of two repos that empties the list hits the same guard", async () => {
    yaml(["a/one", "a/two"]);
    const res = await removeRepos(db, ["a/one", "A/TWO"], {});
    expect(res).toMatchObject({ ok: false, status: 409, error: "would-empty" });
  });

  it("remove of one of two needs no whenEmpty", async () => {
    yaml(["a/one", "a/two"]);
    const res = await removeRepos(db, ["a/one"], {});
    expect(res).toEqual({ ok: true, state: { requireApproval: false, approved: ["a/two"] } });
  });

  it("whenEmpty follow-app leaves the flag off and the list empty; effective = grant", async () => {
    yaml(["a/one"]);
    const res = await removeRepos(db, ["a/one"], { whenEmpty: "follow-app" });
    expect(res).toEqual({ ok: true, state: { requireApproval: false, approved: [] } });
    expect(getManagedRepos()).toEqual(["a/one", "a/two", "a/three"]);
    expect(getRepoApprovalState().stored).toBe(true);
  });

  it("whenEmpty require-approval turns the flag on; effective = []", async () => {
    yaml(["a/one"]);
    const res = await removeRepos(db, ["a/one"], { whenEmpty: "require-approval" });
    expect(res).toEqual({ ok: true, state: { requireApproval: true, approved: [] } });
    expect(getManagedRepos()).toEqual([]);
  });

  it("remove with the flag on may empty the list without whenEmpty", async () => {
    yaml(["a/one"], true);
    const res = await removeRepos(db, ["a/one"], {});
    expect(res).toEqual({ ok: true, state: { requireApproval: true, approved: [] } });
  });

  it("setRequireApproval stores the flag and keeps the list", async () => {
    yaml(["a/one"]);
    const res = await setRequireApproval(db, true, "octocat");
    expect(res).toEqual({ ok: true, state: { requireApproval: true, approved: ["a/one"] } });
    expect(getRepoApprovalState()).toEqual({ state: { requireApproval: true, approved: ["a/one"] }, stored: true });
  });
});

describe("managed-repo approvals — no silent widening", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
    setInstallationRepos("1", ["a/one", "a/two", "a/three"]);
  });

  afterEach(() => {
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it("turning approval off with nothing approved needs confirm", async () => {
    yaml([], true);
    const res = await setRequireApproval(db, false, "octocat");
    expect(res).toEqual({ ok: false, status: 409, error: "would-follow-app", installationCount: 3 });
    expect(getManagedRepos()).toEqual([]);
    const ok = await setRequireApproval(db, false, "octocat", { confirm: true });
    expect(ok).toEqual({ ok: true, state: { requireApproval: false, approved: [] } });
  });

  it("writes start from the stored row, not a stale in-memory copy", async () => {
    yaml(["a/one"]);
    // Another process stored a different state; this process's copy is stale.
    await db.setSetting(REPO_APPROVAL_SETTING_KEY, { requireApproval: true, approved: ["a/two"] });
    const res = await approveRepos(db, ["a/three"]);
    expect(res).toEqual({ ok: true, state: { requireApproval: true, approved: ["a/two", "a/three"] } });
  });

  it("concurrent writes do not lose updates", async () => {
    yaml(["a/one", "a/two"]);
    const [a, b] = await Promise.all([approveRepos(db, ["a/three"]), removeRepos(db, ["a/one"], {})]);
    expect(a.ok && b.ok).toBe(true);
    expect(getManagedRepos()).toEqual(["a/two", "a/three"]);
    expect((await db.getSetting(REPO_APPROVAL_SETTING_KEY))?.value).toEqual({
      requireApproval: false,
      approved: ["a/two", "a/three"],
    });
  });
});
