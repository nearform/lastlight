/**
 * `qualifiedRepoSql` — the SQL half of the (owner, bare repo) contract.
 *
 * Moved verbatim from the pre-Phase-3 `tests/state/repo-ref.test.ts`. Only this
 * block moved: `normalizeRepoRef` and `qualifyRepo` are pure functions with no
 * database and stayed behind in that file.
 *
 * This is the widest-reaching portability port in the state layer — the
 * fragment fans out to ~13 call sites across `execution-store.ts` and
 * `workflow-run-store.ts`, and its `instr()` has no Postgres equivalent
 * (`strposExpr` in `dialect.ts` is the seam). Which is exactly why it belongs
 * in the parameterized set rather than the sqlite-only pile.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { sql } from "drizzle-orm";
import type { StateDb } from "#src/state/db.js";
import { rows as selectRows, run as execSql } from "#src/state/dialect.js";
import { qualifiedRepoSql, qualifyRepo } from "#src/state/repo-ref.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runRepoRefSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
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
      db = await makeDb();
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
}
