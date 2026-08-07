/**
 * The dashboard's client-side copy of the repo-qualification rule, pinned
 * against the server's.
 *
 * `apps/server/dashboard/` has no import edge to core, so `runRepoPath` is a
 * hand-mirror of `state/repo-ref.ts`'s `qualifyRepo` — the same arrangement as
 * the config mirror next door. It had no test at all, which is how a rule
 * expressed in six places ends up with six readings (issue #279).
 *
 * Imported rather than read as text: the module is plain TS with no React and
 * no DOM, so the two implementations can be run against the same table.
 */

import { describe, it, expect } from "vitest";
import { runRepoPath } from "../../dashboard/src/lib/githubLinks.js";
import { qualifyRepo } from "#src/state/repo-ref.js";

describe("runRepoPath mirrors qualifyRepo", () => {
  const rows: { name: string; owner?: string; repo?: string; expected: string | null }[] = [
    { name: "the stored pair", owner: "nearform", repo: "lastlight", expected: "nearform/lastlight" },
    // A row the #279 backfill never reached. Not re-qualified into
    // `nearform/nearform/lastlight`.
    { name: "a legacy qualified repo", repo: "nearform/lastlight", expected: "nearform/lastlight" },
    { name: "a legacy qualified repo with an owner too", owner: "nearform", repo: "nearform/lastlight", expected: "nearform/lastlight" },
    { name: "no repo", owner: "nearform", expected: null },
  ];

  for (const row of rows) {
    it(`agrees on ${row.name}`, () => {
      expect(runRepoPath({ repo: row.repo, owner: row.owner })).toBe(row.expected);
      expect(qualifyRepo(row.owner, row.repo) ?? null).toBe(row.expected);
    });
  }

  it("differs only where the server has no link to emit", () => {
    // An owner-less bare name is a repo somebody can read but not a URL, so the
    // server returns it and the client declines to link. The one deliberate
    // divergence — asserted so it stays deliberate.
    expect(qualifyRepo(undefined, "lastlight")).toBe("lastlight");
    expect(runRepoPath({ repo: "lastlight" })).toBeNull();
  });

  it("falls back to context.owner, then the trigger id", () => {
    expect(runRepoPath({ repo: "lastlight", context: { owner: "nearform" } })).toBe(
      "nearform/lastlight",
    );
    expect(runRepoPath({ triggerId: "nearform/lastlight#7" })).toBe("nearform/lastlight");
    expect(runRepoPath({ triggerId: "nearform/lastlight::repo-health" })).toBe(
      "nearform/lastlight",
    );
  });

  it("prefers the owner column over context.owner", () => {
    expect(
      runRepoPath({ owner: "nearform", repo: "lastlight", context: { owner: "stale" } }),
    ).toBe("nearform/lastlight");
  });
});
