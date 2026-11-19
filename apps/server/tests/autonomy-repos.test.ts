import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  AUTONOMY_REPOS_SETTING_KEY,
  getAutonomyReposState,
  refreshAutonomyRepos,
  setStoredAutonomyRepos,
  resetAutonomyReposForTests,
} from "#src/autonomy-repos.js";
import {
  defaultAutonomyConfig,
  getAutonomyRepos,
  isAutonomousRepo,
  resetRuntimeConfigForTests,
  setRuntimeConfig,
  type LastLightConfig,
} from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "./helpers/state-db.js";

function yaml(repos: string[]): void {
  setRuntimeConfig({ autonomy: { ...defaultAutonomyConfig(), repos } } as unknown as LastLightConfig);
}

describe("autonomy repos — live setting", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
  });

  afterEach(() => {
    resetAutonomyReposForTests();
    resetRuntimeConfigForTests();
  });

  it("no row: isAutonomousRepo follows YAML", async () => {
    yaml(["a/one"]);
    await refreshAutonomyRepos(db);
    expect(isAutonomousRepo("a/one")).toBe(true);
    expect(isAutonomousRepo("a/two")).toBe(false);
    expect(getAutonomyReposState().stored).toBe(false);
  });

  it("stored row wins over YAML", async () => {
    yaml(["a/one"]);
    await db.setSetting(AUTONOMY_REPOS_SETTING_KEY, { repos: ["a/two"] });
    await refreshAutonomyRepos(db);
    expect(isAutonomousRepo("a/two")).toBe(true);
    expect(isAutonomousRepo("a/one")).toBe(false);
    expect(getAutonomyReposState()).toEqual({ state: { repos: ["a/two"] }, stored: true });
  });

  it("malformed row keeps only valid entries", async () => {
    yaml(["a/one"]);
    await db.setSetting(AUTONOMY_REPOS_SETTING_KEY, { repos: ["a/two", 7, ""] });
    await refreshAutonomyRepos(db);
    expect(getAutonomyRepos()).toEqual(["a/two"]);
    await db.setSetting(AUTONOMY_REPOS_SETTING_KEY, "junk");
    await refreshAutonomyRepos(db);
    expect(getAutonomyRepos()).toEqual([]);
  });

  it("refresh that started before a write is dropped", async () => {
    yaml([]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slowDb = {
      async getSetting<T>(): Promise<{ value: T } | null> {
        await gate;
        return { value: { repos: ["a/old"] } as T };
      },
    };
    const pending = refreshAutonomyRepos(slowDb);
    setStoredAutonomyRepos({ repos: ["a/three"] });
    release();
    await pending;
    expect(getAutonomyRepos()).toEqual(["a/three"]);
  });

  it("isAutonomousRepo is exact match", () => {
    yaml([]);
    setStoredAutonomyRepos({ repos: ["a/one"] });
    expect(isAutonomousRepo("a/one")).toBe(true);
    expect(isAutonomousRepo("A/One")).toBe(false);
  });
});
