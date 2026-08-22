/**
 * SELECTIVE RESOLUTION — the flag, the allow-list, and the one invariant that
 * decides whether any of it is safe.
 *
 * `--resolution` is a PROTOTYPE and `full` is the default; the first `describe`
 * pins that, because a memory experiment that silently becomes the shipped
 * behaviour is how a document starts lying about types without anybody choosing
 * it.
 *
 * The rest is the invariant: **the allow-list is the UNION of base and head,
 * and the same one is handed to both programs.** Per side it is a phantom-delta
 * generator — see `makeAsymmetricImportFixture` for the exact shape — so, in
 * this package's usual pattern, the ceiling is paired with a FLOOR: the same
 * fixture is run with two per-side lists and the phantom is counted, so the
 * union's contribution is a number and not a paragraph.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ASYMMETRIC_ADDED_EXPORT,
  ASYMMETRIC_STABLE_EXPORT,
  makeAsymmetricImportFixture,
  makeContractFixture,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { extractContracts } from "../src/contracts.js";
import { changedPaths, withWorktree } from "../src/git.js";
import { loadProject } from "../src/project.js";
import {
  computeResolutionPolicy,
  isResolutionTier,
  isUnderNodeModules,
  resolutionHostFor,
  specifierPackage,
  DEFAULT_RESOLUTION_TIER,
  RESOLUTION_TIERS,
} from "../src/resolution.js";
import { scanImportSpecifiers } from "../src/syntactic.js";
import { runCli } from "../src/cli.js";
import type { ContractsDocument } from "../src/schema.js";

describe("the specifier scan — an allow-list needs no program", () => {
  it("reads every spelling of a module specifier out of TypeScript", () => {
    const source = [
      `import { z } from "zod";`,
      `import type { A } from "@scope/pkg/deep/path";`,
      `import "./side-effect.js";`,
      `export { thing } from "lodash";`,
      `const a = require("cjs-only");`,
      `const b = import("dynamic-dep");`,
      `import legacy = require("node:fs");`,
    ].join("\n");
    expect(scanImportSpecifiers("src/x.ts", source)).toEqual([
      "zod",
      "@scope/pkg/deep/path",
      "./side-effect.js",
      "lodash",
      "cjs-only",
      "dynamic-dep",
      "node:fs",
    ]);
  });

  it("runs on the JavaScript grammar too, which has no import_require_clause", () => {
    // `supportedKinds` drops the TS-only kind rather than letting ast-grep
    // refuse the whole rule — the bug that once made `.js` files contribute
    // nothing to set B.
    expect(scanImportSpecifiers("src/x.js", `const r = require("r1");\nimport d from "r2";`)).toEqual(
      ["r1", "r2"],
    );
  });

  it("returns null — never [] — for a language it cannot parse", () => {
    // `[]` would read as "this file imports nothing", which is an allow-list
    // with a hole in it. `null` is the caller's cue to degrade.
    expect(scanImportSpecifiers("main.go", `import "fmt"`)).toBeNull();
  });

  it("names the package a specifier resolves through", () => {
    expect(specifierPackage("zod")).toBe("zod");
    expect(specifierPackage("@scope/pkg/deep")).toBe("@scope/pkg");
    expect(specifierPackage("./rel")).toBeNull();
    expect(specifierPackage("/abs/path")).toBeNull();
    // A builtin IS a resolution — it lands on `@types/node`, one of the largest
    // `.d.ts` trees any repo pulls in — and the two spellings share one entry.
    expect(specifierPackage("node:fs")).toBe("fs");
    expect(specifierPackage("fs")).toBe("fs");
  });

  it("recognises a node_modules path on either separator", () => {
    expect(isUnderNodeModules("/repo/node_modules/zod/index.d.ts")).toBe(true);
    expect(isUnderNodeModules("/repo/packages/shared/dist/index.d.ts")).toBe(false);
  });
});

describe("the flag — `changed` is the default", () => {
  let fixture: Fixture;
  afterAll(() => fixture?.cleanup());
  beforeAll(() => {
    fixture = makeContractFixture();
  });

  // Flipped 2026-08-21. A 50-run sweep made `changed` strictly dominant: on an
  // INSTALLED tree it costs 1022/1274/1600/1387/2157 MB where `full` costs
  // 3699/3902/4347-OOM/3481/4430, and it does so at ZERO fidelity cost — same
  // entry count, identical key set, no entry gaining an `any`, across 499
  // contract entries on the two largest commits. That is lossless BY
  // CONSTRUCTION, not by luck: the allow-list is computed from the same changed
  // files whose contracts are extracted, and a contract signature can only name
  // types reachable from its own file's imports.
  it("defaults to `changed`, which installs a host", () => {
    expect(DEFAULT_RESOLUTION_TIER).toBe("changed");
    const { policy } = computeResolutionPolicy({
      repo: fixture.dir,
      tier: DEFAULT_RESOLUTION_TIER,
      baseSha: fixture.base,
      headSha: fixture.head,
      changed: changedPaths(fixture.dir, fixture.base, fixture.head),
    });
    expect(policy.tier).toBe("changed");
    expect(resolutionHostFor(policy)).toBeDefined();
  });

  // The regression this exists for: `run.ts` skipped computing a policy when
  // the tier equalled DEFAULT_RESOLUTION_TIER — correct while the default was
  // `full` (which installs no host), and a silent no-op the moment it became
  // `changed`. Asserting the constant, or `computeResolutionPolicy` directly,
  // does NOT catch it; only the emitted document does.
  it("a DEFAULT run actually restricts — and STAMPS it on the envelope", () => {
    const doc = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ContractsDocument;
    expect(doc.resolution.tier).toBe("changed");
    expect(doc.resolution.allowed).toBeGreaterThanOrEqual(0);
  });

  // The stamp is on the envelope and NOT in `degraded[]`, because `changed` is
  // measurably lossless. A run that degraded on every invocation would make
  // `coverage: "degraded"` the permanent state and cost `degraded[]` all of its
  // signal — which is this package's founding failure mode reached politely.
  it("does NOT degrade on the default, because nothing was lost", () => {
    const doc = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ContractsDocument;
    expect(doc.degraded.filter((e) => e.reason.includes("RESTRICTED"))).toHaveLength(0);
  });

  it("`full` stamps its own tier, so the two are distinguishable", () => {
    const doc = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      resolution: "full",
    }).document as unknown as ContractsDocument;
    expect(doc.resolution).toEqual({ tier: "full", allowed: null });
  });

  it("keeps `full` as an escape hatch that installs NO host at all", () => {
    const { policy } = computeResolutionPolicy({
      repo: fixture.dir,
      tier: "full",
      baseSha: fixture.base,
      headSha: fixture.head,
      changed: changedPaths(fixture.dir, fixture.base, fixture.head),
    });
    // `undefined` is not "a host that allows everything": ts-morph takes a
    // different code path entirely, so `full` stays byte-identical to what
    // shipped before the flag existed.
    expect(resolutionHostFor(policy)).toBeUndefined();
  });

  it("produces the same document with the flag omitted and with the default", () => {
    const omitted = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ContractsDocument;
    const explicit = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      resolution: DEFAULT_RESOLUTION_TIER,
    }).document as unknown as ContractsDocument;
    expect(explicit.contracts).toEqual(omitted.contracts);
    expect(explicit.degraded).toEqual(omitted.degraded);
  });

  it("REFUSES an unknown tier instead of falling back to the default", () => {
    // `--resolution non` quietly meaning `full` would report today's memory
    // profile under a flag the operator believes changed it.
    const errors: string[] = [];
    const code = runCli(
      ["contracts", "--repo", fixture.dir, "--base", fixture.base, "--resolution", "non"],
      { out: () => {}, err: (s) => errors.push(s) },
    );
    expect(code).toBe(2);
    expect(errors.join(" ")).toContain("--resolution must be one of");
    expect(RESOLUTION_TIERS.every(isResolutionTier)).toBe(true);
  });

  // Rewritten 2026-08-21 with the default flip. The old rule was "every tier
  // but `full` degrades", which was right while every restricted tier could
  // lose type text. It is wrong for `changed`, which is measurably lossless
  // (499 contract entries, zero gaining an `any`) — and since `changed` is now
  // the default, keeping that rule would have made `coverage: "degraded"` the
  // permanent state of every document the tool emits.
  //
  // The rule now: DEGRADE WHEN FIDELITY WAS ACTUALLY LOST, not when a policy
  // applied cleanly. `none` masks, so it degrades. `changed` is stamped.
  it("degrades on `none`, which masks — and not on `changed`, which does not", () => {
    const argsFor = (tier: (typeof RESOLUTION_TIERS)[number]) => ({
      repo: fixture.dir,
      tier,
      baseSha: fixture.base,
      headSha: fixture.head,
      changed: changedPaths(fixture.dir, fixture.base, fixture.head),
    });

    expect(computeResolutionPolicy(argsFor("full")).degraded).toEqual([]);

    // `none` renders an external type as `any` on BOTH sides, which suppresses
    // a phantom delta and MASKS a real one. That is a loss, and it must be said.
    const none = computeResolutionPolicy(argsFor("none")).degraded;
    expect(none.map((d) => d.reason).join(" ")).toMatch(/resolution/i);

    // `changed` loses nothing, so it claims nothing.
    expect(computeResolutionPolicy(argsFor("changed")).degraded).toEqual([]);
  });
});

describe("THE UNION INVARIANT — one allow-list, both programs", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeAsymmetricImportFixture();
  });
  afterAll(() => fixture?.cleanup());

  /** The head-only import must be in the list computed for BOTH sides. */
  it("puts a head-only specifier in the list, from the base side too", () => {
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const { policy } = computeResolutionPolicy({
      repo: fixture.dir,
      tier: "changed",
      baseSha: fixture.base,
      headSha: fixture.head,
      changed,
    });
    expect(policy.allow.has("@fixture/rex")).toBe(true);
    // And it is genuinely head-only: the base blob of the one changed file
    // names no package at all.
    const baseOnly = computeResolutionPolicy({
      repo: fixture.dir,
      tier: "changed",
      baseSha: fixture.base,
      headSha: fixture.base,
      changed,
    });
    expect(baseOnly.policy.allow.has("@fixture/rex")).toBe(false);
  });

  /**
   * THE CEILING. The head commit adds an import the base does not have, and the
   * only delta is the export the head commit genuinely added.
   */
  it("reports ZERO deltas attributable to the new import's resolution", () => {
    for (const tier of ["changed", "workspace", "hop"] as const) {
      const document = runExtractor({
        extractor: "contracts",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
        resolution: tier,
      }).document as unknown as ContractsDocument;

      const symbols = document.contracts.map((c) => `${c.change} ${c.symbol}`).sort();
      expect(symbols, `tier ${tier}`).toEqual([`added ${ASYMMETRIC_ADDED_EXPORT}`]);
      // The export nobody touched is not in the list, and the reason is that it
      // resolved on BOTH sides: `Rex`, not `any`.
      expect(
        document.contracts.find((c) => c.symbol === ASYMMETRIC_STABLE_EXPORT),
        `tier ${tier}: a delta on an untouched export is a phantom`,
      ).toBeUndefined();
      const added = document.contracts[0];
      expect(added.after?.returns ?? added.after?.signature, `tier ${tier}`).toContain("Rex");
    }
  });

  it("matches T0 exactly on this fixture", () => {
    const at = (resolution: "full" | "changed") =>
      (
        runExtractor({
          extractor: "contracts",
          repo: fixture.dir,
          base: fixture.base,
          head: fixture.head,
          resolution,
        }).document as unknown as ContractsDocument
      ).contracts;
    expect(at("changed")).toEqual(at("full"));
  });

  /**
   * THE FLOOR — and the whole reason the union is written down as an invariant.
   *
   * Same fixture, same programs, ONE variable changed: each side gets an
   * allow-list computed from its own blobs. `toBeGreaterThan(0)`, never an exact
   * count: an exact number is a snapshot that breaks when the fixture grows.
   */
  it("WITHOUT the union, the untouched export moves — a phantom delta", () => {
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const paths = changed.map((c) => c.path);
    const perSide = (baseSha: string, headSha: string) =>
      resolutionHostFor(
        computeResolutionPolicy({
          repo: fixture.dir,
          tier: "changed",
          baseSha,
          headSha,
          changed,
        }).policy,
      );

    const head = loadProject({
      repo: fixture.dir,
      changedPaths: paths,
      // The head side sees only what HEAD imports.
      resolutionHost: perSide(fixture.head, fixture.head),
    });
    expect(head.projects.length, "the head project must load, or this measures nothing").toBe(1);

    const phantoms = withWorktree(fixture.dir, fixture.base, (baseDir) => {
      const base = loadProject({
        repo: baseDir,
        changedPaths: paths,
        // …and the base side only what BASE imports, which is nothing.
        resolutionHost: perSide(fixture.base, fixture.base),
      });
      expect(base.projects.length).toBe(1);
      const result = extractContracts({
        repo: fixture.dir,
        headProject: head.projects,
        baseProject: base.projects,
        baseDir,
        changed,
        hunkIndex: new Map(),
      });
      return result.payload.contracts.filter((c) => c.symbol === ASYMMETRIC_STABLE_EXPORT);
    });

    expect(
      phantoms.length,
      "a per-side allow-list must move an export the PR did not touch",
    ).toBeGreaterThan(0);
    // The signature of the failure: `any` on the side that could not resolve.
    expect(JSON.stringify(phantoms[0].before)).toContain("any");
  });
});

describe("partial resolution can be worse than none — the asymmetry hunt", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeAsymmetricImportFixture();
  });
  afterAll(() => fixture?.cleanup());

  /**
   * `none` is SYMMETRIC — both sides go blind together — and that is the whole
   * argument for it. It is also why it MASKS: `out` renders `any` on both sides
   * and compares equal, so a real change between two external types would be
   * invisible. The test asserts the masking, because a document that hides a
   * delta must do it on purpose and in writing.
   */
  it("`none` degrades both sides together, and says the delta may be masked", () => {
    const document = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      resolution: "none",
    }).document as unknown as ContractsDocument;

    expect(document.contracts.map((c) => c.symbol)).toEqual([ASYMMETRIC_ADDED_EXPORT]);
    // The added export's inferred type is gone — that is the price.
    expect(JSON.stringify(document.contracts[0].after)).toContain("any");
    expect(document.degraded.map((d) => d.reason).join(" ")).toMatch(/masked|BLOCKED/i);
  });

  /**
   * The generic-argument hazard named in the brief: a type whose ARGUMENT
   * resolves while its constraint does not, or vice versa. Under an allow-list
   * gated on the SPECIFIER this cannot happen within one type — a package is
   * either admitted or refused for every containing file and both worktrees —
   * so the two sides can only differ if the package differs, which is what
   * `mirrorNodeModules` is for. Pinned as a property, not as an anecdote.
   */
  it("admits a package for every containing file, or for none", () => {
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const { policy } = computeResolutionPolicy({
      repo: fixture.dir,
      tier: "changed",
      baseSha: fixture.base,
      headSha: fixture.head,
      changed,
    });
    // The decision function reads a specifier and nothing else — no containing
    // file, no side, no worktree. That is the property; the type below is what
    // enforces it.
    const decide: (specifier: string) => boolean = (specifier) => {
      const name = specifierPackage(specifier);
      return name === null || policy.allow.has(name);
    };
    expect(decide("@fixture/rex")).toBe(true);
    expect(decide("@fixture/rex/deep/inner.js")).toBe(true);
    expect(decide("./relative.js")).toBe(true);
    expect(decide("never-imported-anywhere")).toBe(false);
  });
});
