import { describe, it, expect } from "vitest";
import { normalizeRepoRef, qualifyRepo } from "#src/state/repo-ref.js";

/**
 * The PURE half of `repo-ref.ts`. Its SQL half, `qualifiedRepoSql`, needs a
 * real database and is dialect-sensitive (`instr` has no Postgres equivalent),
 * so it lives in the parameterized suite at `suites/repo-ref-suite.ts`.
 */
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
