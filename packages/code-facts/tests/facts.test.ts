/**
 * WP1 acceptance criterion 1 — THE HEADLINE TEST.
 *
 * `lastlight-facts facts` on a fixture repo must produce the `1587-r2`-shaped
 * obligation input MECHANICALLY: `MAX_TOKEN_AGE` declared once, referenced only
 * on the client side, zero server references. That is the one shape the whole
 * investigation ever converted into a posted Critical, and v3 got there by
 * GUESSING it with regexes. This file is the regression guard for making it
 * true.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeBarrelFixture,
  makeConstantFixture,
  makeContractFixture,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import type { FactsDocument } from "../src/schema.js";

function facts(fixture: Fixture): FactsDocument {
  return runExtractor({
    extractor: "facts",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
  }).document as unknown as FactsDocument;
}

describe("facts — the impact cone", () => {
  let constant: Fixture;
  let barrel: Fixture;
  let contract: Fixture;

  beforeAll(() => {
    constant = makeConstantFixture();
    barrel = makeBarrelFixture();
    contract = makeContractFixture();
  });
  afterAll(() => {
    constant.cleanup();
    barrel.cleanup();
    contract.cleanup();
  });

  it("finds the changed symbol and its cross-file references, and never exits 0 empty", () => {
    const document = facts(constant);
    expect(document.coverage).toBe("full");
    expect(document.tier).toBe(1);

    const symbol = document.symbols.find((s) => s.name === "MAX_TOKEN_AGE");
    expect(symbol, "the changed constant must be in the symbol list").toBeDefined();
    expect(symbol?.declaredAt).toBe("src/config.ts:1");
    expect(symbol?.changedHunks).toEqual(["src/config.ts:1-1"]);
    expect(symbol?.exported).toBe(true);

    // The reference is in a file the diff never touched — invisible in the diff
    // itself, which is the whole reason this extractor exists.
    expect(symbol?.references.map((r) => r.at)).toContain("src/client/session.ts:4");
    expect(symbol?.references.every((r) => !r.at.startsWith("src/server/"))).toBe(true);
    expect(symbol?.referencesInDiff).toBe(0);
    expect(symbol?.referenceCount).toBeGreaterThan(0);
  });

  it("records the enclosing symbol at each reference site", () => {
    const symbol = facts(constant).symbols.find((s) => s.name === "MAX_TOKEN_AGE");
    const usage = symbol?.references.find((r) => r.at === "src/client/session.ts:4");
    expect(usage?.inSymbol).toBe("cookieMaxAge");
  });

  it("follows a barrel re-export, so the consumer two files away is still a reference", () => {
    const document = facts(barrel);
    const symbol = document.symbols.find((s) => s.name === "rateLimit");
    const sites = symbol?.references.map((r) => r.at) ?? [];
    expect(sites).toContain("src/index.ts:1"); // the barrel
    expect(sites).toContain("src/consumer.ts:3"); // the consumer beyond it
  });

  it("marks test files as tests, so the `tests` field is not guessed from the path in the prompt", () => {
    const document = facts(contract);
    const symbol = document.symbols.find((s) => s.name === "getUser");
    expect(symbol?.tests).toContain("test/user.test.ts");
    expect(symbol?.references.some((r) => r.isTest)).toBe(true);
  });

  it("records callees, so a changed function's outward edges are available too", () => {
    const document = facts(contract);
    const symbol = document.symbols.find((s) => s.name === "getUser");
    expect(symbol?.callees).toEqual([]);
    const changedFile = document.files.find((f) => f.path === "src/user.ts");
    expect(changedFile?.analysed).toBe(true);
    expect(changedFile?.status).toBe("modified");
  });

  it("lists every changed file, including ones with no symbol in them", () => {
    const document = facts(constant);
    expect(document.files.map((f) => f.path).sort()).toEqual([
      "src/config.ts",
      "src/legacy/auth.ts",
    ]);
  });
});
