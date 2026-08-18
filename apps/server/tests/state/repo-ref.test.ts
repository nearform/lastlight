import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { StateDb } from "#src/state/db.js";
import { rows as selectRows, run as execSql } from "#src/state/dialect.js";
import { normalizeRepoRef, qualifyRepo, qualifiedRepoSql } from "#src/state/repo-ref.js";
import { makeTestDb } from "../helpers/state-db.js";

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
  // Exercised against a real database rather than string-matched, because the
  // whole point of the helper is that the SQL and the JS agree. The fragment is
  // composable `SQL` now, not a string, so it is evaluated through the same
  // raw-query seam (`dialect.ts`) the stores use.
  const rows = [
    { id: "a", owner: "nearform", repo: "lastlight" }, // the stored shape
    { id: "b", owner: null, repo: "nearform/lastlight" }, // legacy qualified
    { id: "c", owner: null, repo: "orphan" }, // un-backfillable
    { id: "d", owner: "nearform", repo: null }, // no repo
    { id: "e", owner: "", repo: "orphan" }, // empty-string owner
  ];

  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
    await execSql(db.client, sql`CREATE TABLE t (id TEXT, owner TEXT, repo TEXT)`);
    for (const r of rows) {
      await execSql(
        db.client,
        sql`INSERT INTO t (id, owner, repo) VALUES (${r.id}, ${r.owner}, ${r.repo})`,
      );
    }
  });

  async function evaluate(
    unqualifiable: "bare" | "null",
  ): Promise<Record<string, string | null>> {
    const expr = qualifiedRepoSql(sql.identifier("owner"), sql.identifier("repo"), unqualifiable);
    const out = await selectRows<{ id: string; repo: string | null }>(
      db.client,
      sql`SELECT id, ${expr} AS repo FROM t`,
    );
    return Object.fromEntries(out.map((r) => [r.id, r.repo]));
  }

  it("agrees with qualifyRepo in `bare` mode", async () => {
    const got = await evaluate("bare");
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

  it("answers NULL for an un-qualifiable row in `null` mode", async () => {
    // NULL is "no repo, always visible". A bare name here would match nothing
    // in a qualified allow-list and so HIDE the row — the #278 bug.
    expect(await evaluate("null")).toEqual({
      a: "nearform/lastlight",
      b: "nearform/lastlight",
      c: null,
      d: null,
      e: null,
    });
  });
});
