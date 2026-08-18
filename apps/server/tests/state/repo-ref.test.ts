import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { normalizeRepoRef, qualifyRepo, qualifiedRepoSql } from "../../src/state/repo-ref.js";

describe("normalizeRepoRef", () => {
  it("leaves the stored shape alone", () => {
    expect(normalizeRepoRef("nearform", "lastlight")).toEqual({
      owner: "nearform",
      repo: "lastlight",
    });
  });

  it("splits a legacy qualified repo", () => {
    expect(normalizeRepoRef(undefined, "nearform/lastlight")).toEqual({
      owner: "nearform",
      repo: "lastlight",
    });
  });

  it("prefers an explicit owner over the one embedded in repo", () => {
    // The column was populated from the authoritative dispatch-time split; a
    // qualified `repo` is the legacy shape. They should agree, but if they
    // don't, the column wins.
    expect(normalizeRepoRef("nearform", "acme/lastlight")).toEqual({
      owner: "nearform",
      repo: "lastlight",
    });
  });

  it("normalizes empty and whitespace to undefined", () => {
    expect(normalizeRepoRef("", "")).toEqual({ owner: undefined, repo: undefined });
    expect(normalizeRepoRef("  ", " lastlight ")).toEqual({
      owner: undefined,
      repo: "lastlight",
    });
  });

  it("keeps an owner with no repo", () => {
    expect(normalizeRepoRef("nearform", undefined)).toEqual({
      owner: "nearform",
      repo: undefined,
    });
  });

  it("is idempotent", () => {
    const once = normalizeRepoRef(undefined, "nearform/lastlight");
    expect(normalizeRepoRef(once.owner, once.repo)).toEqual(once);
  });
});

describe("qualifyRepo", () => {
  it("joins the stored pair", () => {
    expect(qualifyRepo("nearform", "lastlight")).toBe("nearform/lastlight");
  });

  it("does NOT double-qualify a legacy qualified repo", () => {
    // dispatcher.ts used to join unconditionally and produce
    // `acme/acme/widgets`, which the dispatch split then read as the repo
    // `acme` — a different real repository.
    expect(qualifyRepo("acme", "acme/widgets")).toBe("acme/widgets");
  });

  it("falls back to the bare name when there is no owner", () => {
    expect(qualifyRepo(undefined, "lastlight")).toBe("lastlight");
    expect(qualifyRepo("", "lastlight")).toBe("lastlight");
  });

  it("returns undefined with no repo", () => {
    expect(qualifyRepo("nearform", undefined)).toBeUndefined();
    expect(qualifyRepo("nearform", "")).toBeUndefined();
  });

  it("round-trips with normalizeRepoRef", () => {
    const { owner, repo } = normalizeRepoRef(undefined, "nearform/lastlight");
    expect(qualifyRepo(owner, repo)).toBe("nearform/lastlight");
  });
});

describe("qualifiedRepoSql", () => {
  // Exercised against real SQLite rather than string-matched, because the whole
  // point of the helper is that the SQL and the JS agree.
  const rows = [
    { id: "a", owner: "nearform", repo: "lastlight" }, // the stored shape
    { id: "b", owner: null, repo: "nearform/lastlight" }, // legacy qualified
    { id: "c", owner: null, repo: "orphan" }, // un-backfillable
    { id: "d", owner: "nearform", repo: null }, // no repo
    { id: "e", owner: "", repo: "orphan" }, // empty-string owner
  ];

  function evaluate(unqualifiable: "bare" | "null"): Record<string, string | null> {
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE t (id TEXT, owner TEXT, repo TEXT)`);
    const ins = db.prepare(`INSERT INTO t (id, owner, repo) VALUES (?, ?, ?)`);
    for (const r of rows) ins.run(r.id, r.owner, r.repo);
    const out = db
      .prepare(`SELECT id, ${qualifiedRepoSql("owner", "repo", unqualifiable)} AS repo FROM t`)
      .all() as { id: string; repo: string | null }[];
    db.close();
    return Object.fromEntries(out.map((r) => [r.id, r.repo]));
  }

  it("agrees with qualifyRepo in `bare` mode", () => {
    const got = evaluate("bare");
    for (const r of rows) {
      expect(got[r.id]).toBe(qualifyRepo(r.owner, r.repo) ?? null);
    }
    expect(got).toEqual({
      a: "nearform/lastlight",
      b: "nearform/lastlight",
      c: "orphan",
      d: null,
      e: "orphan",
    });
  });

  it("answers NULL for an un-qualifiable row in `null` mode", () => {
    // NULL is "no repo, always visible". A bare name here would match nothing
    // in a qualified allow-list and so HIDE the row — the #278 bug.
    expect(evaluate("null")).toEqual({
      a: "nearform/lastlight",
      b: "nearform/lastlight",
      c: null,
      d: null,
      e: null,
    });
  });
});
