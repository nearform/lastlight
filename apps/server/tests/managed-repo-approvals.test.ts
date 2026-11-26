import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { approveRepos, removeRepos, setRepoAutonomy, setRequireApproval } from "#src/managed-repo-approvals.js";
import { AUTONOMY_REPOS_SETTING_KEY, resetAutonomyReposForTests } from "#src/autonomy-repos.js";
import {
  getManagedRepos,
  getRepoApprovalState,
  setInstallationRepos,
  resetInstallationReposForTests,
  REPO_APPROVAL_SETTING_KEY,
  setInstallationDiscoveryError,
} from "#src/managed-repos.js";
import {
  defaultAutonomyConfig,
  getAutonomyRepos,
  isAutonomousRepo,
  setRuntimeConfig,
  resetRuntimeConfigForTests,
  type LastLightConfig,
} from "#src/config/config.js";
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

  it("approve outside the grant names accounts whose repo list failed to load", async () => {
    yaml([]);
    setInstallationDiscoveryError("9", "other-org");
    const res = await approveRepos(db, ["other-org/x"]);
    expect(res).toMatchObject({ ok: false, status: 400 });
    expect(!res.ok && res.error).toContain("other-org");
    expect(!res.ok && res.error).toContain("failed to load");
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

  it("setRequireApproval to the value already in effect writes nothing", async () => {
    yaml(["a/one"]);
    const res = await setRequireApproval(db, false);
    expect(res).toEqual({ ok: true, state: { requireApproval: false, approved: ["a/one"] } });
    expect(await db.getSetting(REPO_APPROVAL_SETTING_KEY)).toBeNull();
    expect(getRepoApprovalState().stored).toBe(false);
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

describe("managed-repo approvals — autonomy toggle", () => {
  let db: StateDb;

  function config(approved: string[], autonomy: string[]): void {
    setRuntimeConfig({
      managedRepos: approved,
      requireRepoApproval: false,
      autonomy: { ...defaultAutonomyConfig(), repos: autonomy },
    } as unknown as LastLightConfig);
  }

  beforeEach(async () => {
    db = await makeTestDb();
    setInstallationRepos("1", ["a/one", "a/two", "a/three"]);
  });

  afterEach(() => {
    resetAutonomyReposForTests();
    resetRuntimeConfigForTests();
    resetInstallationReposForTests();
  });

  it("enable seeds from YAML and adds", async () => {
    config(["a/one", "a/two"], ["a/one"]);
    const res = await setRepoAutonomy(db, "a/two", true, "octocat");
    expect(res).toEqual({ ok: true, repos: ["a/one", "a/two"] });
    const row = await db.getSetting(AUTONOMY_REPOS_SETTING_KEY);
    expect(row?.value).toEqual({ repos: ["a/one", "a/two"] });
    expect(row?.updatedBy).toBe("octocat");
    expect(isAutonomousRepo("a/two")).toBe(true);
  });

  it("enable stores the approved spelling", async () => {
    config(["a/one"], []);
    const res = await setRepoAutonomy(db, "A/One", true);
    expect(res).toEqual({ ok: true, repos: ["a/one"] });
    expect(isAutonomousRepo("a/one")).toBe(true);
  });

  it("enable of a repo that is not managed is 400 and writes nothing", async () => {
    config(["a/one"], []);
    const res = await setRepoAutonomy(db, "a/three", true);
    expect(res).toEqual({ ok: false, status: 400, error: "not a managed repo: a/three" });
    expect(await db.getSetting(AUTONOMY_REPOS_SETTING_KEY)).toBeNull();
  });

  it("disable removes it; disabling an absent repo writes nothing", async () => {
    config(["a/one", "a/two"], []);
    expect(await setRepoAutonomy(db, "a/two", false)).toEqual({ ok: true, repos: [] });
    expect(await db.getSetting(AUTONOMY_REPOS_SETTING_KEY)).toBeNull();
    await setRepoAutonomy(db, "a/one", true);
    await setRepoAutonomy(db, "a/two", true);
    expect(await setRepoAutonomy(db, "A/Two", false)).toEqual({ ok: true, repos: ["a/one"] });
    expect(isAutonomousRepo("a/two")).toBe(false);
  });

  it("remove drops repo from autonomy", async () => {
    config(["a/one", "a/two"], ["a/one", "a/two"]);
    const res = await removeRepos(db, ["a/two"], {});
    expect(res.ok).toBe(true);
    expect(getAutonomyRepos()).toEqual(["a/one"]);
    expect((await db.getSetting(AUTONOMY_REPOS_SETTING_KEY))?.value).toEqual({ repos: ["a/one"] });
  });

  it("remove drops repo from autonomy even when it empties approved", async () => {
    config(["a/one"], ["a/one"]);
    const res = await removeRepos(db, ["a/one"], { whenEmpty: "follow-app" });
    expect(res.ok).toBe(true);
    expect(getAutonomyRepos()).toEqual([]);
  });

  it("remove of a repo not in autonomy writes no autonomy row", async () => {
    config(["a/one", "a/two"], ["a/one"]);
    await removeRepos(db, ["a/two"], {});
    expect(await db.getSetting(AUTONOMY_REPOS_SETTING_KEY)).toBeNull();
    expect(getAutonomyRepos()).toEqual(["a/one"]);
  });

  it("enable over a case-variant YAML entry rewrites it to the managed spelling", async () => {
    config(["a/one"], ["A/One"]);
    expect(isAutonomousRepo("a/one")).toBe(false);
    const res = await setRepoAutonomy(db, "a/one", true);
    expect(res).toEqual({ ok: true, repos: ["a/one"] });
    expect(isAutonomousRepo("a/one")).toBe(true);
  });

  it("enable stores the App grant's spelling over an approved spelling typed differently", async () => {
    config(["a/One"], []);
    const res = await setRepoAutonomy(db, "a/One", true);
    expect(res).toEqual({ ok: true, repos: ["a/one"] });
    expect(isAutonomousRepo("a/one")).toBe(true);
  });

  it("turning approval on drops autonomy for repos that are no longer managed", async () => {
    config([], ["a/two"]);
    expect(isAutonomousRepo("a/two")).toBe(true);
    const res = await setRequireApproval(db, true);
    expect(res.ok).toBe(true);
    expect(getAutonomyRepos()).toEqual([]);
    await approveRepos(db, ["a/two"]);
    expect(isAutonomousRepo("a/two")).toBe(false);
  });

  it("concurrent toggles do not lose updates", async () => {
    config(["a/one", "a/two"], []);
    await Promise.all([setRepoAutonomy(db, "a/one", true), setRepoAutonomy(db, "a/two", true)]);
    expect((await db.getSetting(AUTONOMY_REPOS_SETTING_KEY))?.value).toEqual({ repos: ["a/one", "a/two"] });
  });
});
