/**
 * The orchestrator — the part of this package that decides what "clean" means.
 *
 * `run.ts` derives `coverage` from `degraded[]`, validates every document
 * against its own schema before returning it, and assembles the envelope in ONE
 * place so a failed run is still a well-formed document. Each of those is a
 * branch, and each of them is the branch a consumer trusts when it decides
 * whether an empty obligation list means "nothing to report" or "nobody looked".
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { z } from "zod";
import { makeConstantFixture, makeFakeTool, makeNonTsFixture, type Fixture } from "./helpers.js";
import { buildEnvelope, emptyDocumentFor, runExtractor, runWrapped } from "../src/run.js";
import { FactsError } from "../src/errors.js";
import { DOCUMENT_SCHEMAS, type ExtractorName, type Envelope } from "../src/schema.js";
import type { AllDocument, ContractsDocument, FactsDocument } from "../src/schema.js";

const EXTRACTORS = Object.keys(DOCUMENT_SCHEMAS) as ExtractorName[];

describe("`all` — one envelope, every payload", () => {
  let fixture: Fixture;
  let document: AllDocument;

  beforeAll(() => {
    fixture = makeConstantFixture();
    document = runExtractor({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      // Deterministic: the scanners are absent on a developer Mac and present in
      // the image, and this test is about the payload keys either way.
      env: { PATH: "" },
    }).document as unknown as AllDocument;
  });
  afterAll(() => fixture.cleanup());

  /**
   * A missing KEY is worse than an empty payload: the `all` schema marks every
   * extractor optional (a `coverage: "none"` document has none of them), so a
   * silently absent one validates cleanly and reads downstream as "that
   * extractor found nothing".
   */
  it("carries every extractor key, and not one of them is an empty payload", () => {
    expect(Object.keys(document.extractors).sort()).toEqual([
      "constants",
      "contracts",
      "coverage",
      "deps",
      "facts",
      "patterns",
    ]);
    for (const [name, payload] of Object.entries(document.extractors)) {
      expect(payload, name).toBeDefined();
      expect(Object.keys(payload as object).length, name).toBeGreaterThan(0);
    }
  });

  it("each payload carries the same content its single-extractor sibling would", () => {
    // The four this fixture has something to say about. `patterns` is empty
    // because the binaries are absent — which `degraded[]` names — and
    // `coverage` because there is no artifact, which it also names.
    expect(document.extractors.facts?.symbols.some((s) => s.name === "MAX_TOKEN_AGE")).toBe(true);
    expect(document.extractors.contracts?.contracts.length).toBeGreaterThan(0);
    expect(document.extractors.constants?.constants.length).toBeGreaterThan(0);
    expect(document.extractors.deps?.manifests).toEqual([{ path: "package.json", ecosystem: "npm" }]);
    expect(document.extractors.coverage?.report).toBeNull();
    expect(document.extractors.patterns?.findings).toEqual([]);
  });

  it("the envelope reports the WORST tier any extractor reached", () => {
    // `patterns` and `coverage` both degraded, so the run as a whole did.
    expect(document.coverage).toBe("degraded");
    expect(document.tier).toBe(1);
    expect(document.engine).toBe("ts-morph");
    expect(document.degraded.map((d) => d.extractor).sort()).toEqual([
      "coverage",
      "patterns",
      "patterns",
    ]);
  });
});

/**
 * An extractor that needs a compiled project, on a repo that cannot give it one,
 * is a documented TIER — not a crash. A throw here would fail the phase, and a
 * failed phase records no assessed SHA and is re-dispatched every thirty
 * minutes, forever (§D12).
 */
describe("a project-dependent extractor on a tier-3 repo", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeNonTsFixture();
  });
  afterAll(() => fixture.cleanup());

  it("degrades `contracts` with a written reason instead of throwing", () => {
    const result = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    const document = result.document as unknown as ContractsDocument;
    expect(result.exitCode).toBe(3);
    expect(document.tier).toBe(3);
    expect(document.coverage).toBe("degraded");
    expect(document.contracts).toEqual([]);
    expect(
      document.degraded.some((d) => /the contract delta was not computed/.test(d.reason)),
      "an empty contract list must never be the only thing the document says",
    ).toBe(true);
  });
});

/**
 * THE SELF-VALIDATION BRANCH. `runExtractor` parses every document against its
 * own schema before returning it, because shipping a malformed obligation set
 * downstream is worse than reporting that nothing could be produced.
 *
 * Forcing it needs a schema that cannot match, since a document that genuinely
 * fails is by definition a bug we do not have — so the schema table is swapped
 * for one entry and restored. Nothing about the repo, the diff or the compiler
 * is faked: the extraction really runs and really produces its real document.
 */
describe("a document that fails its own schema", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => fixture.cleanup());

  const table = DOCUMENT_SCHEMAS as unknown as Record<string, z.ZodType>;

  function withImpossibleSchema<T>(extractor: ExtractorName, fn: () => T): T {
    const original = table[extractor];
    table[extractor] = z.object({ aFieldNoDocumentHas: z.string() });
    try {
      return fn();
    } finally {
      table[extractor] = original;
    }
  }

  it("throws a FactsError naming the extractor and the failing field", () => {
    const err = withImpossibleSchema("facts", () => {
      try {
        runExtractor({
          extractor: "facts",
          repo: fixture.dir,
          base: fixture.base,
          head: fixture.head,
        });
        return null;
      } catch (caught) {
        return caught;
      }
    });
    expect(err).toBeInstanceOf(FactsError);
    expect((err as FactsError).extractor).toBe("facts");
    expect((err as FactsError).message).toMatch(/the facts document failed its own schema/);
    expect((err as FactsError).message).toMatch(/aFieldNoDocumentHas/);
  });

  it("`--never-fail` turns it into a well-formed `coverage: \"none\"` envelope", () => {
    const document = withImpossibleSchema(
      "facts",
      () =>
        runWrapped({
          extractor: "facts",
          repo: fixture.dir,
          base: fixture.base,
          head: fixture.head,
        }).document,
    ) as unknown as FactsDocument;

    expect(document.coverage).toBe("none");
    expect(document.degraded).toHaveLength(1);
    expect(document.degraded[0].reason).toMatch(/failed its own schema/);
    expect(document.degraded[0].reason).toMatch(/it is not a clean result/);
    expect(document.symbols).toEqual([]);
    // …and the envelope it wrote instead still validates against the REAL
    // schema, which is what lets a consumer read it with no second code path.
    expect(DOCUMENT_SCHEMAS.facts.safeParse(document).success).toBe(true);
    // The shas are the ones the run resolved, not the refs it was handed.
    expect(document.baseSha).toBe(fixture.base);
    expect(document.headSha).toBe(fixture.head);
  });
});

describe("emptyDocumentFor", () => {
  const envelope: Envelope = buildEnvelope({
    extractor: "facts",
    repo: "owner/name",
    baseSha: "a".repeat(40),
    headSha: "b".repeat(40),
    tier: 3,
    coverage: "none",
    degraded: [{ extractor: "facts", reason: "analysis could not run" }],
    tools: [],
    env: { PATH: "" },
  });

  /**
   * Table-driven over EVERY extractor, `all` included. The failure payload is a
   * hand-written literal per extractor, so a new field on any payload schema
   * makes exactly one of these rows fail — which is the only thing keeping the
   * `coverage: "none"` document readable by the same code path as a clean one.
   */
  it.each(EXTRACTORS)("%s's empty document validates against its own schema", (extractor) => {
    const document = emptyDocumentFor(extractor, { ...envelope, extractor });
    const parsed = DOCUMENT_SCHEMAS[extractor].safeParse(document);
    expect(parsed.success, JSON.stringify(parsed.error?.issues ?? [])).toBe(true);
    expect((document as { coverage: string }).coverage).toBe("none");
  });
});

describe("buildEnvelope", () => {
  let opengrep: { dir: string; bin: string };
  beforeAll(() => {
    opengrep = makeFakeTool("opengrep", `#!/bin/sh\necho "1.27.1"\n`);
  });
  afterAll(() => rmSync(opengrep.dir, { recursive: true, force: true }));

  function envelopeWith(env: NodeJS.ProcessEnv): Envelope {
    return buildEnvelope({
      extractor: "patterns",
      repo: "owner/name",
      baseSha: "a".repeat(40),
      headSha: "b".repeat(40),
      tier: 1,
      coverage: "full",
      degraded: [],
      tools: ["opengrep"],
      env,
    });
  }

  it("stamps the toolchain from the INJECTED env", () => {
    const stamp = envelopeWith({ LASTLIGHT_OPENGREP_BIN: opengrep.bin }).toolchain;
    expect(stamp.binaries.opengrep.status).toBe("ok");
    expect(stamp.binaries.opengrep.resolved).toBe("1.27.1");
    expect(stamp.binaries.opengrep.path).toBe(opengrep.bin);
    // A tool this run never needed is `unprobed`, not `missing` — the manifest
    // pin is still recorded, so the document says what SHOULD have been there.
    expect(stamp.binaries.gitleaks.status).toBe("unprobed");
    expect(stamp.binaries.gitleaks.expected).toBe("8.21.2");
  });

  /**
   * The pin that makes the previous test mean something: with the SAME override
   * in `process.env` and an injected env that does not carry it, the stamp must
   * read `missing`. Reading `process.env` behind the caller's back is how an
   * eval arm measured on a host install would silently stamp itself as though
   * the image's toolchain had produced it.
   */
  it("does NOT fall back to process.env", () => {
    process.env.LASTLIGHT_OPENGREP_BIN = opengrep.bin;
    try {
      const stamp = envelopeWith({ PATH: "" }).toolchain;
      expect(stamp.binaries.opengrep.status).toBe("missing");
      expect(stamp.binaries.opengrep.path).toBeNull();
      expect(stamp.binaries.opengrep.expected).toBe("1.27.1");
    } finally {
      delete process.env.LASTLIGHT_OPENGREP_BIN;
    }
  });

  it("defaults `engine` to `none` and `languages` to empty — the honest answer", () => {
    const envelope = envelopeWith({ PATH: "" });
    expect(envelope.engine).toBe("none");
    expect(envelope.languages).toEqual([]);
    expect(envelope.version).toBe(1);
  });
});
