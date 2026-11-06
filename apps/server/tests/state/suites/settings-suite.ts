/**
 * `harness_settings` — the generic key → JSON row the dashboard writes live
 * operator settings to (first user: the managed-repos approval state).
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runSettingsSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("harness settings", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    it("getSetting returns null for an unknown key", async () => {
      expect(await db.getSetting("managed-repos")).toBeNull();
    });

    it("setSetting then getSetting round-trips a JSON value", async () => {
      await db.setSetting("managed-repos", { requireApproval: true, approved: ["a/b"] }, "alice");
      const row = await db.getSetting<{ requireApproval: boolean; approved: string[] }>("managed-repos");
      expect(row?.value).toEqual({ requireApproval: true, approved: ["a/b"] });
      expect(row?.updatedBy).toBe("alice");
      expect(typeof row?.updatedAt).toBe("string");
    });

    it("setSetting twice keeps one row with the latest value and updatedBy", async () => {
      await db.setSetting("managed-repos", { approved: ["a/b"] }, "alice");
      await db.setSetting("managed-repos", { approved: [] });
      const row = await db.getSetting<{ approved: string[] }>("managed-repos");
      expect(row?.value).toEqual({ approved: [] });
      expect(row?.updatedBy).toBeNull();
    });
  });
}
