/**
 * WP1 acceptance criterion 5 — every subcommand's output validates against its
 * zod schema, on the SUCCESS path, the DEGRADED path and the `coverage: "none"`
 * path alike.
 *
 * `runExtractor` already validates before returning and throws on a mismatch,
 * so this file's job is to prove the validation is reached for every command
 * and every tier — a schema check that only ever runs on the happy path is a
 * schema check that has never been tested.
 *
 * It also carries the GOLDEN JSON for the constant fixture, which is the
 * regression guard for the one shape we know converts.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeConstantFixture, makeNonTsFixture, type Fixture } from "./helpers.js";
import { runExtractor, runWrapped, writeDocument } from "../src/run.js";
import { DOCUMENT_SCHEMAS, SymbolFactSchema, type ExtractorName } from "../src/schema.js";
import { runCli } from "../src/cli.js";

const EXTRACTORS: ExtractorName[] = [
  "facts",
  "contracts",
  "constants",
  "deps",
  "patterns",
  "coverage",
  "all",
];

describe("schema (WP1 AC5)", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => fixture.cleanup());

  it.each(EXTRACTORS)("%s validates on a healthy repo", (extractor) => {
    const result = runExtractor({
      extractor,
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      env: { PATH: "" },
    });
    expect(DOCUMENT_SCHEMAS[extractor].safeParse(result.document).success).toBe(true);
  });

  it.each(EXTRACTORS)("%s validates on a tier-3 repo", (extractor) => {
    const nonTs = makeNonTsFixture();
    try {
      const result = runExtractor({
        extractor,
        repo: nonTs.dir,
        base: nonTs.base,
        head: nonTs.head,
        env: { PATH: "" },
      });
      expect(DOCUMENT_SCHEMAS[extractor].safeParse(result.document).success).toBe(true);
    } finally {
      nonTs.cleanup();
    }
  });

  it.each(EXTRACTORS)("%s validates on the coverage:none path", (extractor) => {
    const notARepo = mkdtempSync(join(tmpdir(), "ll-facts-notrepo-"));
    try {
      const result = runWrapped({ extractor, repo: notARepo, base: "a", head: "b" });
      expect(DOCUMENT_SCHEMAS[extractor].safeParse(result.document).success).toBe(true);
    } finally {
      rmSync(notARepo, { recursive: true, force: true });
    }
  });

  it("every document carries the full envelope, including the toolchain stamp", () => {
    const document = runExtractor({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      env: { PATH: "" },
    }).document as Record<string, unknown>;
    for (const key of [
      "version",
      "generatedAt",
      "extractor",
      "repo",
      "baseSha",
      "headSha",
      "tier",
      "coverage",
      "degraded",
      "toolchain",
    ]) {
      expect(document, key).toHaveProperty(key);
    }
  });

  /**
   * GOLDEN JSON for the shape we know converts. Compared field-by-field rather
   * than as a blob, because `generatedAt`, the temp-dir repo name and the SHAs
   * change every run — a snapshot of the whole document would be a test that
   * fails for reasons nobody cares about, and gets deleted.
   */
  it("golden: the 1587-r2 constant shape", () => {
    const document = runExtractor({
      extractor: "constants",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      env: { PATH: "" },
    }).document as unknown as { constants: unknown[] };
    expect(document.constants).toEqual([
      {
        constant: "MAX_TOKEN_AGE",
        declaredAt: "src/config.ts:1",
        value: "900",
        valueKind: "number",
        references: ["src/client/session.ts:1", "src/client/session.ts:4"],
        hardCodedDuplicates: ["src/legacy/auth.ts:2"],
        sides: { client: 2, server: 0, shared: 0, test: 0, other: 0 },
      },
    ]);
  });

  it("--out writes the same document the CLI would print", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ll-facts-out-"));
    try {
      const out = join(scratch, "nested", "facts.json");
      const code = runCli(
        ["facts", "--repo", fixture.dir, "--base", fixture.base, "--head", fixture.head, "--out", out],
        { out: () => {}, err: () => {} },
      );
      expect(code).toBe(0);
      const written = JSON.parse(readFileSync(out, "utf8")) as unknown;
      expect(DOCUMENT_SCHEMAS.facts.safeParse(written).success).toBe(true);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  /**
   * D2b is additive: a document written BEFORE the `registrations` field
   * existed must still parse, and its absence reads as `null` — nobody looked
   * — never as `[]`. No envelope version bump, so this is the compatibility
   * contract in executable form.
   */
  it("a symbol without `registrations` (a pre-D2 document) still parses, reading as nobody-looked", () => {
    const preD2 = {
      name: "MAX_TOKEN_AGE",
      kind: "variable",
      exported: true,
      declaredAt: "src/config.ts:1",
      changedHunks: ["src/config.ts:1-1"],
      references: [],
      implementations: null,
      callees: [],
      tests: [],
      referenceCount: 0,
      referencesInDiff: 0,
      resolution: "type-aware",
      nameAmbiguity: null,
    };
    const parsed = SymbolFactSchema.parse(preD2);
    expect(parsed.registrations ?? null).toBeNull();
    // …and both explicit states still parse as themselves.
    expect(SymbolFactSchema.parse({ ...preD2, registrations: null }).registrations).toBeNull();
    expect(
      SymbolFactSchema.parse({
        ...preD2,
        registrations: [{ at: "src/app.ts:6", call: "app.get", phase: "/users", ordinal: 0 }],
      }).registrations,
    ).toHaveLength(1);
  });

  it("writeDocument creates missing directories rather than throwing", () => {
    const scratch = mkdtempSync(join(tmpdir(), "ll-facts-write-"));
    try {
      writeDocument(join(scratch, "a", "b", "c.json"), { ok: true });
      expect(JSON.parse(readFileSync(join(scratch, "a", "b", "c.json"), "utf8"))).toEqual({
        ok: true,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
