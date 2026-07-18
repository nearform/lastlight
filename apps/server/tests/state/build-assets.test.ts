import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BuildAssetStore,
  buildAssetIssueKey,
  type BuildAssetRef,
} from "#src/state/build-assets.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "lastlight-assets-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const REF = { owner: "acme", repo: "widget", issueKey: "issue-42" };

describe("buildAssetIssueKey", () => {
  it("keys issue-scoped runs by number", () => {
    expect(buildAssetIssueKey("build", 42, "abcdef12-3456")).toBe("issue-42");
  });

  it("keys non-issue runs by workflow + short run id", () => {
    expect(buildAssetIssueKey("explore", undefined, "abcdef1234567890")).toBe("explore-abcdef12");
  });
});

describe("BuildAssetStore read/write/list", () => {
  it("round-trips a doc and lists keys + files", () => {
    const store = new BuildAssetStore(root);
    expect(store.read(REF, "architect-plan.md")).toBeUndefined();

    store.write(REF, "architect-plan.md", "# Plan\n");
    store.write(REF, "status.md", "current_phase: architect\n");

    expect(store.read(REF, "architect-plan.md")).toBe("# Plan\n");
    expect(store.listKeys("acme", "widget")).toEqual(["issue-42"]);
    expect(store.listFiles(REF)).toEqual(["architect-plan.md", "status.md"]);
  });

  it("returns empty lists for an unknown owner/repo/key", () => {
    const store = new BuildAssetStore(root);
    expect(store.listKeys("nobody", "nothing")).toEqual([]);
    expect(store.listFiles({ owner: "nobody", repo: "x", issueKey: "issue-1" })).toEqual([]);
  });

  it("readBuffer returns raw bytes (binary-safe) for harvested screenshots", () => {
    const store = new BuildAssetStore(root);
    expect(store.readBuffer(REF, "shot.png")).toBeUndefined();

    // A PNG signature + a non-UTF8 byte that utf-8 decoding would mangle.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff, 0x00]);
    const dir = store.dirFor(REF);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "shot.png"), png);

    const got = store.readBuffer(REF, "shot.png");
    expect(got).toBeInstanceOf(Buffer);
    expect(got && Buffer.compare(got, png)).toBe(0);
    // The file shows up in listFiles alongside markdown, ready for harvest.
    expect(store.listFiles(REF)).toContain("shot.png");
  });

  it("readBuffer rejects path traversal in the filename", () => {
    const store = new BuildAssetStore(root);
    expect(() => store.readBuffer(REF, "../../secret")).toThrow();
  });
});

describe("BuildAssetStore stageInto / harvestFrom", () => {
  it("stages stored docs into a local dir and harvests changes back", () => {
    const store = new BuildAssetStore(root);
    store.write(REF, "architect-plan.md", "v1");

    const local = join(root, "..", "ws");
    rmSync(local, { recursive: true, force: true });

    store.stageInto(REF, local);
    expect(readFileSync(join(local, "architect-plan.md"), "utf-8")).toBe("v1");

    // A later phase appends a new doc and edits an existing one.
    writeFileSync(join(local, "architect-plan.md"), "v2");
    writeFileSync(join(local, "executor-summary.md"), "done");
    store.harvestFrom(REF, local);

    expect(store.read(REF, "architect-plan.md")).toBe("v2");
    expect(store.read(REF, "executor-summary.md")).toBe("done");

    rmSync(local, { recursive: true, force: true });
  });

  it("stageInto creates an empty dir when nothing is stored (first phase)", () => {
    const store = new BuildAssetStore(root);
    const local = join(root, "..", "ws-empty");
    rmSync(local, { recursive: true, force: true });

    store.stageInto(REF, local);
    expect(existsSync(local)).toBe(true);
    expect(store.listFiles(REF)).toEqual([]);

    rmSync(local, { recursive: true, force: true });
  });

  it("harvest replaces the stored set (deleted docs disappear)", () => {
    const store = new BuildAssetStore(root);
    store.write(REF, "old.md", "stale");

    const local = join(root, "..", "ws2");
    rmSync(local, { recursive: true, force: true });
    mkdirSync(local, { recursive: true });
    writeFileSync(join(local, "new.md"), "fresh");

    store.harvestFrom(REF, local);
    expect(store.listFiles(REF)).toEqual(["new.md"]);
    expect(store.read(REF, "old.md")).toBeUndefined();

    rmSync(local, { recursive: true, force: true });
  });
});

describe("BuildAssetStore listRepos / listKeysDetailed", () => {
  // Seed a run dir and backdate its mtime so recency sorting + since filtering
  // are deterministic (utimesSync takes seconds).
  function seed(store: BuildAssetStore, ref: BuildAssetRef, ageSecs: number, files = ["status.md"]) {
    for (const f of files) store.write(ref, f, "x");
    const when = new Date(Date.now() - ageSecs * 1000);
    utimesSync(store.dirFor(ref), when, when);
  }

  it("lists only repos that have artifacts, newest first, with counts", async () => {
    const store = new BuildAssetStore(root);
    seed(store, { owner: "acme", repo: "old", issueKey: "issue-1" }, 3 * 86400);
    seed(store, { owner: "acme", repo: "fresh", issueKey: "issue-2" }, 60);
    seed(store, { owner: "acme", repo: "fresh", issueKey: "issue-3" }, 120);
    // An empty owner/repo dir (no run dirs) must not appear.
    mkdirSync(join(root, "acme", "empty"), { recursive: true });

    const { repos, total } = await store.listRepos();
    expect(total).toBe(2);
    expect(repos.map((r) => r.slug)).toEqual(["acme/fresh", "acme/old"]);
    expect(repos[0]).toMatchObject({ owner: "acme", repo: "fresh", keyCount: 2 });
    expect(repos[1]).toMatchObject({ slug: "acme/old", keyCount: 1 });
  });

  it("filters repos by substring and paginates", async () => {
    const store = new BuildAssetStore(root);
    seed(store, { owner: "acme", repo: "widget", issueKey: "issue-1" }, 10);
    seed(store, { owner: "acme", repo: "gadget", issueKey: "issue-2" }, 20);
    seed(store, { owner: "other", repo: "thing", issueKey: "issue-3" }, 30);

    expect((await store.listRepos({ q: "get" })).repos.map((r) => r.slug).sort()).toEqual([
      "acme/gadget",
      "acme/widget",
    ]);
    const page1 = await store.listRepos({ limit: 1, offset: 0 });
    const page2 = await store.listRepos({ limit: 1, offset: 1 });
    expect(page1.total).toBe(3);
    expect(page1.repos).toHaveLength(1);
    expect(page1.repos[0].slug).not.toBe(page2.repos[0].slug);
  });

  it("lists run keys newest first with age + file counts, filtered by since", async () => {
    const store = new BuildAssetStore(root);
    seed(store, { owner: "acme", repo: "widget", issueKey: "issue-old" }, 3 * 86400, ["a.md", "b.md"]);
    seed(store, { owner: "acme", repo: "widget", issueKey: "issue-new" }, 60, ["a.md"]);

    const all = await store.listKeysDetailed("acme", "widget");
    expect(all.total).toBe(2);
    expect(all.keys.map((k) => k.key)).toEqual(["issue-new", "issue-old"]);
    expect(all.keys[1]).toMatchObject({ key: "issue-old", fileCount: 2 });
    expect(typeof all.keys[0].updatedAt).toBe("string");

    // A one-day window drops the 3-day-old run.
    const since = Date.now() - 86400 * 1000;
    const recent = await store.listKeysDetailed("acme", "widget", { sinceMs: since });
    expect(recent.keys.map((k) => k.key)).toEqual(["issue-new"]);
    expect(recent.total).toBe(1);

    // Substring filter on the key.
    expect((await store.listKeysDetailed("acme", "widget", { q: "old" })).keys.map((k) => k.key)).toEqual([
      "issue-old",
    ]);
  });

  it("returns empty (not throwing) for a repo with no artifacts", async () => {
    const store = new BuildAssetStore(root);
    expect(await store.listKeysDetailed("nobody", "nothing")).toEqual({ keys: [], total: 0 });
    expect(await store.listRepos()).toEqual({ repos: [], total: 0 });
  });

  it("a write invalidates the cache so a new run shows up immediately", async () => {
    const store = new BuildAssetStore(root);
    seed(store, { owner: "acme", repo: "widget", issueKey: "issue-1" }, 10);
    expect((await store.listKeysDetailed("acme", "widget")).total).toBe(1);
    expect((await store.listRepos()).repos[0].keyCount).toBe(1);

    // Within the TTL window — without invalidation the stale scan would win.
    store.write({ owner: "acme", repo: "widget", issueKey: "issue-2" }, "status.md", "x");
    expect((await store.listKeysDetailed("acme", "widget")).total).toBe(2);
    expect((await store.listRepos()).repos[0].keyCount).toBe(2);
  });

  it("rejects traversal in owner/repo for listKeysDetailed", async () => {
    const store = new BuildAssetStore(root);
    await expect(store.listKeysDetailed("..", "widget")).rejects.toThrow();
  });
});

describe("BuildAssetStore path traversal", () => {
  it("rejects traversal in the issueKey and filename", () => {
    const store = new BuildAssetStore(root);
    expect(() => store.dirFor({ owner: "acme", repo: "widget", issueKey: "#src/etc" })).toThrow();
    expect(() => store.read(REF, "../../secret")).toThrow();
    expect(() => store.read(REF, "sub/dir.md")).toThrow();
  });

  it("rejects traversal in owner/repo for listKeys", () => {
    const store = new BuildAssetStore(root);
    expect(() => store.listKeys("..", "widget")).toThrow();
  });
});
