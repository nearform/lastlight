/**
 * The dashboard's hand-mirrored view of the per-repo config, pinned against
 * the real one.
 *
 * `apps/server/dashboard/` has no import edge to core (it is a separate Vite
 * app), so `RepoMergedConfig` / `RepoConfigSources` exist there as a hand-typed
 * copy and the Config tab renders a hardcoded `SECTIONS` list. Both drifted:
 * `fix` / `dependencies` / `review` shipped with per-leaf provenance on the
 * endpoint and were invisible in the UI for a release, because nothing failed
 * when the copy stopped matching (#256).
 *
 * This is that missing failure. It reads the dashboard sources as TEXT rather
 * than importing them — the SPA is not part of the server's TS program, and
 * the point is to catch a block added to the server type and forgotten in the
 * copy, which is a source-level fact.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  defaultFixConfig,
  defaultDependenciesConfig,
  defaultReviewConfig,
} from "lastlight-shared/config-types";
import type { RepoMergedConfig } from "lastlight-shared/repo-config-schema";

const DASHBOARD = join(import.meta.dirname, "../../dashboard/src");

const read = (rel: string) => readFileSync(join(DASHBOARD, rel), "utf8");

/**
 * Every block a resolved repo config carries. Typed against the real
 * `RepoMergedConfig`, so ADDING a block to that interface makes this object a
 * compile error here until it is listed — which is the point at which someone
 * has to look at the dashboard.
 */
const BLOCKS: Record<keyof RepoMergedConfig, true> = {
  models: true,
  variants: true,
  disabled: true,
  approval: true,
  fix: true,
  dependencies: true,
  review: true,
};

describe("dashboard's per-repo config mirror", () => {
  it("declares every block on both mirrored interfaces", () => {
    const api = read("api.ts");
    const merged = api.slice(
      api.indexOf("export interface RepoMergedConfig"),
      api.indexOf("export interface RepoConfigSources"),
    );
    const sources = api.slice(
      api.indexOf("export interface RepoConfigSources"),
      api.indexOf("export interface RepoConfigBundle"),
    );
    expect(merged).not.toBe("");
    expect(sources).not.toBe("");

    for (const block of Object.keys(BLOCKS)) {
      expect(merged, `RepoMergedConfig is missing "${block}"`).toContain(`${block}:`);
      expect(sources, `RepoConfigSources is missing "${block}"`).toContain(`${block}:`);
    }
  });

  it("renders every block in the Config tab's section list", () => {
    const pane = read("components/RepoConfigPane.tsx");
    const sections = /const SECTIONS = \[([^\]]*)\]/.exec(pane)?.[1] ?? "";
    const listed = [...sections.matchAll(/"([^"]+)"/g)].map((m) => m[1]);

    // A block on the type but not in this list is a value the endpoint returns
    // with provenance and the operator never sees.
    expect(listed.sort()).toEqual(Object.keys(BLOCKS).sort());
  });

  it("covers every leaf of the three policy blocks — the tab renders leaves, not blocks", () => {
    // `toLeaves` walks each section's own keys, so a NEW LEAF needs no
    // dashboard change. This asserts that property holds rather than listing
    // the leaves: if a block ever stops being a flat record of scalars, the
    // renderer's one-row-per-key assumption breaks silently.
    for (const block of [defaultFixConfig(), defaultDependenciesConfig(), defaultReviewConfig()]) {
      for (const [key, value] of Object.entries(block)) {
        expect(
          value === null || typeof value !== "object" || Array.isArray(value),
          `${key} is a nested object — RepoConfigPane renders one row per key`,
        ).toBe(true);
      }
    }
  });
});
