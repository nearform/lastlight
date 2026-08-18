import { describe, it, expect, beforeEach } from "vitest";
import { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";

let db: StateDb;

beforeEach(async () => {
  db = await makeTestDb();
});

const team = (slug: string, repos: string[], truncated = false) => ({
  org: "nearform",
  slug,
  name: slug,
  repos,
  truncated,
});

describe("TeamStore.recordResolution", () => {
  it("joins membership → team repos for the resolved login", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"]), team("web", ["nearform/www"])],
      status: "ok",
    });
    const cached = await db.teams.reposForLogin("alice");
    expect(cached.repos).toEqual(["nearform/lastlight", "nearform/www"]);
    expect(cached.truncated).toBe(false);
    expect(cached.teams).toEqual([
      { org: "nearform", slug: "platform" },
      { org: "nearform", slug: "web" },
    ]);
  });

  it("dedupes a repo two of the login's teams both grant", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"]), team("web", ["nearform/lastlight"])],
      status: "ok",
    });
    expect((await db.teams.reposForLogin("alice")).repos).toEqual(["nearform/lastlight"]);
  });

  it("does not leak one login's repos into another's", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"])],
      status: "ok",
    });
    await db.teams.recordResolution({ login: "bob", teams: [team("web", ["nearform/www"])], status: "ok" });
    expect((await db.teams.reposForLogin("alice")).repos).toEqual(["nearform/lastlight"]);
    expect((await db.teams.reposForLogin("bob")).repos).toEqual(["nearform/www"]);
  });

  it("replaces a login's previous membership rather than accumulating", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"])],
      status: "ok",
    });
    // Alice moved teams.
    await db.teams.recordResolution({ login: "alice", teams: [team("web", ["nearform/www"])], status: "ok" });
    expect((await db.teams.reposForLogin("alice")).repos).toEqual(["nearform/www"]);
  });

  it("reports truncated when any of the login's teams was only partly enumerated", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"]), team("everyone", ["nearform/www"], true)],
      status: "ok",
    });
    // The caller must fail OPEN on this — a partial list hides repos Alice can
    // really see, which is worse than not filtering at all.
    expect((await db.teams.reposForLogin("alice")).truncated).toBe(true);
  });

  it("records the outcome status and detail for the admin surface", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [],
      status: "error",
      detail: "Resource not accessible by integration",
    });
    const sync = await db.teams.getSync("alice");
    expect(sync?.status).toBe("error");
    expect(sync?.detail).toContain("not accessible");
  });
});

describe("TeamStore.isFresh", () => {
  it("is false for a login never resolved", async () => {
    expect(await db.teams.isFresh("nobody", 60_000)).toBe(false);
  });

  it("is true inside the TTL and false past it", async () => {
    const at = new Date("2026-08-06T10:00:00.000Z").toISOString();
    await db.teams.recordResolution({ login: "alice", teams: [], status: "empty", at });
    const tenMinutesLater = Date.parse(at) + 10 * 60_000;
    expect(await db.teams.isFresh("alice", 60 * 60_000, tenMinutesLater)).toBe(true);
    expect(await db.teams.isFresh("alice", 5 * 60_000, tenMinutesLater)).toBe(false);
  });

  it("treats an unparseable timestamp as stale rather than trusting it forever", async () => {
    await db.teams.recordResolution({ login: "alice", teams: [], status: "ok", at: "not-a-date" });
    expect(await db.teams.isFresh("alice", 60 * 60_000)).toBe(false);
  });
});

describe("TeamStore invalidation", () => {
  it("invalidateLogin forgets one person's answer only", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"])],
      status: "ok",
    });
    await db.teams.recordResolution({
      login: "bob",
      teams: [team("platform", ["nearform/lastlight"])],
      status: "ok",
    });
    await db.teams.invalidateLogin("alice");
    expect(await db.teams.getSync("alice")).toBeNull();
    expect((await db.teams.reposForLogin("alice")).repos).toEqual([]);
    expect((await db.teams.reposForLogin("bob")).repos).toEqual(["nearform/lastlight"]);
  });

  it("invalidateTeam drops the grant AND every member's cached answer", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"])],
      status: "ok",
    });
    await db.teams.recordResolution({
      login: "bob",
      teams: [team("platform", ["nearform/lastlight"]), team("web", ["nearform/www"])],
      status: "ok",
    });
    const affected = await db.teams.invalidateTeam("nearform", "platform");
    expect(affected.sort()).toEqual(["alice", "bob"]);
    // Both must re-resolve: their visible set was derived from the changed team.
    expect(await db.teams.getSync("alice")).toBeNull();
    expect(await db.teams.getSync("bob")).toBeNull();
    expect((await db.teams.reposForLogin("bob")).repos).toEqual([]);
  });

  it("invalidateAll empties the cache", async () => {
    await db.teams.recordResolution({
      login: "alice",
      teams: [team("platform", ["nearform/lastlight"])],
      status: "ok",
    });
    await db.teams.invalidateAll();
    expect(await db.teams.lastSyncedAt()).toBeNull();
    expect((await db.teams.reposForLogin("alice")).repos).toEqual([]);
  });
});
