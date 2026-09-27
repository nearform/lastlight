/**
 * `units` — the unit assembler — and `units-ingest`, its other half.
 *
 * Mechanism, never wording: every assertion here is about which unit exists,
 * which obligation it carries, which lines are tagged and marked, what fits the
 * budget, and which row reaches `hypotheses/<family>.jsonl`. Nothing asserts on
 * the request's prose beyond its structural markers (line tags, `FILE`
 * headers, obligation ids) — the prose is the thing a later measurement is
 * allowed to rewrite.
 *
 * The fixture is a REAL two-commit git repo (house rule: every claim here is a
 * claim about what `git` says). `facts.json` and `obligations.json` are written
 * by hand for most tests so the attachment rules are exercised exactly; one
 * test runs the real `all` → `seed` → `units` → `units-ingest` → `discharge`
 * chain end to end.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { checkDischarge } from "../src/discharge.js";
import { checkProbes, requiresProbe } from "../src/probes.js";
import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE } from "../src/errors.js";
import { readHypothesisSet } from "../src/hypotheses.js";
import { runExtractor } from "../src/run.js";
import type { AllDocument } from "../src/schema.js";
import { seedObligations, type Obligation } from "../src/seed.js";
import { deriveVerdict, type SurveyEvidence } from "../src/survey-verdict.js";
import { UnitResponseBodySchema, unitResponseJsonSchema } from "../src/unit-response.js";
import { buildUnits, fallbackUnitsDocument, SMALL_SYMBOL_LINES, UnitsDocumentSchema, type Unit, type UnitsDocument } from "../src/units.js";
import { ingestUnits } from "../src/units-ingest.js";
import { FAMILY_QUESTIONS, requestLineTags, UNIT_SEPARATOR, UNITS_SHARED_PREFIX } from "../src/units-render.js";
import { makeFixture, TSCONFIG, type Fixture } from "./helpers.js";

// ── the fixture ──────────────────────────────────────────────────────────────

const LIMITS_BASE = `import { log } from "./log";

export const MAX_UPLOAD = 10;

/** Checks an upload. */
export function checkUpload(size: number): boolean {
  log("checking");
  return size <= MAX_UPLOAD;
}

export class Store {
  private cache = new Map<string, number>();

  get(key: string): number | undefined {
    return this.cache.get(key);
  }

  put(key: string, value: number): void {
    this.cache.set(key, value);
  }
}
`;

// Head line numbers the tests rely on:
//   3  MAX_UPLOAD (changed)        6  checkUpload (changed)   8  new line
//   12 class Store                 15 Store.get (untouched)   19 Store.put, 20 new line
const LIMITS_HEAD = `import { log } from "./log";

export const MAX_UPLOAD = 25;

/** Checks an upload. */
export function checkUpload(size: number, strict = false): boolean {
  log("checking");
  if (strict) return size < MAX_UPLOAD;
  return size <= MAX_UPLOAD;
}

export class Store {
  private cache = new Map<string, number>();

  get(key: string): number | undefined {
    return this.cache.get(key);
  }

  put(key: string, value: number): void {
    if (value < 0) return;
    this.cache.set(key, value);
  }
}
`;

const APP = `import { checkUpload, Store } from "./limits";

const store = new Store();

export function handle(size: number): string {
  if (!checkUpload(size)) return "too big";
  store.put("last", size);
  return "ok";
}
`;

function makeUnitsFixture(): Fixture {
  return makeFixture(
    "units",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-units", version: "1.0.0" }),
        "src/log.ts": `export function log(msg: string): void {\n  void msg;\n}\n`,
        "src/limits.ts": LIMITS_BASE,
        "src/app.ts": APP,
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      },
    },
    {
      message: "head",
      files: {
        "src/limits.ts": LIMITS_HEAD,
        "pnpm-lock.yaml": "lockfileVersion: '9.0'\n# changed\n",
      },
    },
  );
}

const ref = (at: string, inSymbol: string | null = null, over: Record<string, unknown> = {}) => ({
  at,
  inDiff: false,
  inSymbol,
  isTest: false,
  ...over,
});

function symbol(name: string, kind: string, declaredAt: string, over: Record<string, unknown> = {}) {
  return {
    name,
    kind,
    exported: true,
    declaredAt,
    changedHunks: [],
    references: [],
    implementations: null,
    callees: [],
    tests: [],
    referenceCount: 0,
    referencesInDiff: 0,
    resolution: "type-aware",
    nameAmbiguity: null,
    ...over,
  };
}

/** A hand-written `all` document for the fixture — exact, so attachment is exercised exactly. */
function factsFor(fixture: Fixture, extraSymbols: unknown[] = []): AllDocument {
  return {
    version: 2,
    generatedAt: "2026-01-01T00:00:00.000Z",
    extractor: "all",
    repo: "fixture/units",
    baseSha: fixture.base,
    headSha: fixture.head,
    tier: 1,
    engine: "tsgo",
    languages: [],
    coverage: "full",
    degraded: [],
    toolchain: { manifest: 2, bundled: {}, binaries: {} },
    extractors: {
      facts: {
        files: [],
        symbols: [
          symbol("checkUpload", "function", "src/limits.ts:6", {
            changedHunks: ["src/limits.ts:6-6", "src/limits.ts:8-8"],
            references: [ref("src/app.ts:6", "handle")],
            callees: ["log"],
            referenceCount: 1,
          }),
          symbol("Store", "class", "src/limits.ts:12", {
            changedHunks: ["src/limits.ts:20-20"],
            references: [ref("src/app.ts:3")],
            referenceCount: 1,
          }),
          symbol("Store.put", "method", "src/limits.ts:19", {
            changedHunks: ["src/limits.ts:20-20"],
            references: [ref("src/app.ts:7", "handle")],
            callees: ["this.cache.set"],
            referenceCount: 1,
          }),
          symbol("MAX_UPLOAD", "variable", "src/limits.ts:3", {
            changedHunks: ["src/limits.ts:3-3"],
            references: [ref("src/limits.ts:8", "checkUpload", { inDiff: true }), ref("src/limits.ts:9", "checkUpload")],
            referenceCount: 2,
          }),
          ...extraSymbols,
        ],
      },
      contracts: {
        contracts: [
          {
            symbol: "checkUpload",
            file: "src/limits.ts",
            change: "changed",
            before: null,
            after: null,
            consumersOutsideDiff: ["src/app.ts:6"],
          },
        ],
      },
    },
  } as unknown as AllDocument;
}

function obligation(id: string, family: string, path: string, line: number, evidence: { type: string; ref: string }[], candidates: string[] = []): Obligation {
  return {
    id,
    family: family as Obligation["family"],
    mechanism: `${id} mechanism`,
    introducedAt: { path, line, quote: `${id} quote` },
    enforcedAt: { candidates, found: false },
    question: `Answer ${id}.`,
    evidence,
    discharge: "quote",
    rank: 50,
  };
}

const OBLIGATIONS: Obligation[] = [
  obligation("O-001", "enforcement", "src/limits.ts", 3, [{ type: "constant", ref: "constants.constants[0]" }], ["src/limits.ts:8"]),
  obligation("O-002", "contract", "src/limits.ts", 1, [{ type: "contract", ref: "contracts.contracts[0]" }], ["src/app.ts:6"]),
  obligation("O-003", "state", "src/limits.ts", 12, [{ type: "symbol", ref: "facts.symbols[1]" }], ["src/app.ts:3"]),
  // Nowhere in the diff: the `pr` unit's.
  obligation("O-004", "security", "src/app.ts", 6, [], ["src/app.ts:6"]),
];

function obligationsDoc(obligations: Obligation[]) {
  const count = (family: string) => obligations.filter((o) => o.family === family).length;
  return {
    version: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    contract: "full",
    minting: { allInDiff: false, registrations: false },
    repo: "fixture/units",
    baseSha: "",
    headSha: "",
    coverage: "full",
    degraded: [],
    families: [
      ...["contract", "enforcement", "security", "state"].map((family) => ({
        family,
        obligations: count(family),
        minted: count(family),
        cap: 12,
        measured: true,
        notMeasuredReason: null,
      })),
      { family: "tests", obligations: 0, minted: 0, cap: 8, measured: false, notMeasuredReason: "no coverage artifact" },
      { family: "spec", obligations: 0, minted: 0, cap: null, measured: false, notMeasuredReason: "harness-side" },
    ],
    obligations,
    dropped: [],
    coverageSet: { selected: obligations.map((o) => o.id), sealed: true, reviewed: [], failed: [], waived: [], terminalState: "pending" },
  };
}

/** A fresh `.lastlight/pr-review` directory inside the fixture, with the two inputs written. */
function workspace(fixture: Fixture, facts: AllDocument, obligations: Obligation[] | null, name: string): string {
  const dir = join(fixture.dir, ".lastlight", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "facts.json"), JSON.stringify(facts));
  if (obligations) writeFileSync(join(dir, "obligations.json"), JSON.stringify(obligationsDoc(obligations)));
  return dir;
}

const unitOf = (doc: UnitsDocument, pred: (u: Unit) => boolean): Unit => {
  const unit = doc.units.find(pred);
  if (!unit) throw new Error(`no such unit among ${doc.units.map((u) => `${u.id}:${u.kind}:${u.symbol}`).join(", ")}`);
  return unit;
};

const TAG = /^L(\d{4,})\s*?([+ ])\|/;

// ── the assembler ────────────────────────────────────────────────────────────

describe("units — the assembler", () => {
  let fixture: Fixture;
  let dir: string;
  let doc: UnitsDocument;

  beforeAll(() => {
    fixture = makeUnitsFixture();
    dir = workspace(fixture, factsFor(fixture), OBLIGATIONS, "pr-review");
    doc = buildUnits({ dir, repo: fixture.dir }).document;
  });
  afterAll(() => fixture.cleanup());

  it("makes one symbol unit per changed function or method, one module unit per loose region, and one pr unit", () => {
    const shape = doc.units.map((u) => [u.id, u.kind, u.file, u.symbol, u.lines]);
    expect(shape).toEqual([
      ["u-001", "module", "src/limits.ts", null, [3, 3]],
      ["u-002", "symbol", "src/limits.ts", "checkUpload", [6, 10]],
      ["u-003", "symbol", "src/limits.ts", "Store.put", [19, 22]],
      ["u-004", "pr", null, null, null],
    ]);
    // `Store.get` did not change, so it is no unit; the lockfile is skipped by name, and says so.
    expect(doc.units.some((u) => u.symbol === "Store.get")).toBe(false);
    expect(doc.skipped.map((s) => s.file)).toEqual(["pnpm-lock.yaml"]);
  });

  it("carries the envelope the contract names", () => {
    expect(doc.version).toBe(1);
    expect(doc.baseSha).toBe(fixture.base);
    expect(doc.headSha).toBe(fixture.head);
    expect(doc.promptVersion).toMatch(/^units-v\d+$/);
    expect(doc.responseSchema).toMatchObject({ type: "object" });
    // No spec-obligations.json in this workspace, so the spec gap is named.
    expect(doc.coverage).toBe("degraded");
    expect(doc.degraded.some((d) => d.extractor === "units" && /spec/.test(d.reason))).toBe(true);
  });

  it("tags every shown line, marks exactly the changed ones, and shows removed lines untagged", () => {
    const unit = unitOf(doc, (u) => u.symbol === "checkUpload");
    const lines = unit.request.split("\n");
    const tagged = lines.map((l) => TAG.exec(l)).filter((m): m is RegExpExecArray => m !== null);
    const marks = new Map(tagged.map((m) => [Number(m[1]), m[2]]));
    // Source 5..10 (leading comment + body) and the import on line 1.
    expect([...marks.keys()].sort((a, b) => a - b)).toEqual([1, 5, 6, 7, 8, 9, 10]);
    expect([...marks.entries()].filter(([, mark]) => mark === "+").map(([l]) => l)).toEqual([6, 8]);
    // The old signature is shown as removed, immediately before L0006, with no tag.
    const at6 = lines.findIndex((l) => l.startsWith("L0006"));
    expect(lines[at6 - 1]).toMatch(/^\s+-\|export function checkUpload\(size: number\): boolean \{$/);
  });

  it("reads source from the HEAD commit, not the working tree", () => {
    writeFileSync(join(fixture.dir, "src/limits.ts"), "// scribbled over in the working tree\n");
    try {
      const again = buildUnits({ dir, repo: fixture.dir }).document;
      const tags = requestLineTags(unitOf(again, (u) => u.symbol === "checkUpload").request);
      expect(tags.get("src/limits.ts")?.get(8)?.text).toBe("  if (strict) return size < MAX_UPLOAD;");
    } finally {
      writeFileSync(join(fixture.dir, "src/limits.ts"), LIMITS_HEAD);
    }
  });

  it("shows callers with the calling line's text and callees with where they are declared", () => {
    const unit = unitOf(doc, (u) => u.symbol === "checkUpload");
    expect(unit.request).toContain(`src/app.ts:6 (`);
    expect(unit.request).toContain(`if (!checkUpload(size)) return "too big";`);
    expect(unit.request).toMatch(/^ {2}- log$/m);
    // A reference inside the unit's own window is not a caller of it.
    const module = unitOf(doc, (u) => u.kind === "module");
    expect(module.request).toContain("src/limits.ts:8 (");
  });

  it("attaches each obligation to the unit that holds it, and the rest to the pr unit", () => {
    const owner = (id: string) => doc.units.find((u) => u.obligationIds.includes(id))?.id;
    expect(owner("O-001")).toBe("u-001"); // the constant's line → the module region
    expect(owner("O-002")).toBe("u-002"); // a contract delta → the symbol it names
    expect(owner("O-003")).toBe("u-003"); // a class obligation → the method its hunks touch
    expect(owner("O-004")).toBe("u-004"); // not in the diff → the pr unit
    // Every obligation exactly once across the document.
    const all = doc.units.flatMap((u) => u.obligationIds).sort();
    expect(all).toEqual(["O-001", "O-002", "O-003", "O-004"]);
    // `families` is the attached obligations' families.
    expect(unitOf(doc, (u) => u.id === "u-003").families).toEqual(["state"]);
    // The request names every attached id.
    for (const unit of doc.units) for (const id of unit.obligationIds) expect(unit.request).toContain(id);
  });

  it("shows the pr unit an excerpt at each obligation's anchor, under a FILE header", () => {
    const pr = unitOf(doc, (u) => u.kind === "pr");
    const tags = requestLineTags(pr.request);
    expect([...(tags.get("src/app.ts")?.keys() ?? [])]).toEqual([4, 5, 6, 7, 8]);
    expect(pr.language).toBeNull();
  });

  it("is deterministic: same ids, same requests, and requestSha256 is the sha256 of the request", () => {
    const again = buildUnits({ dir, repo: fixture.dir }).document;
    expect(again.units).toEqual(doc.units);
    for (const unit of doc.units) {
      expect(unit.requestSha256).toBe(createHash("sha256").update(unit.request, "utf8").digest("hex"));
    }
  });

  it("the stated response schema parses a reply shaped like the request asks for", () => {
    const unit = unitOf(doc, (u) => u.symbol === "checkUpload");
    const body = replyFor(unit, OBLIGATIONS);
    expect(UnitResponseBodySchema.safeParse(body).success).toBe(true);
    expect(unitResponseJsonSchema()).toEqual(doc.responseSchema);
  });
});

describe("units — the shrink cascade", () => {
  let fixture: Fixture;
  afterAll(() => fixture?.cleanup());

  it("trims, then drops neighbours to fit the budget, marking the unit truncated and naming why", () => {
    fixture = makeUnitsFixture();
    // Twenty callers of checkUpload: more than any budget shows.
    const many = Array.from({ length: 20 }, (_, i) => ref(`src/app.ts:${(i % 9) + 1}`, null, { at: `src/app.ts:${i + 1}` }));
    const facts = factsFor(fixture);
    const symbols = facts.extractors.facts!.symbols;
    symbols[0] = { ...symbols[0]!, references: many as never };
    const dir = workspace(fixture, facts, OBLIGATIONS, "shrink");

    const full = buildUnits({ dir, repo: fixture.dir }).document;
    const fullUnit = unitOf(full, (u) => u.symbol === "checkUpload");
    const callerLines = (request: string) => request.split("\n").filter((l) => /^\s+- src\/app\.ts:\d+ \(/.test(l)).length;
    expect(callerLines(fullUnit.request)).toBe(8);
    expect(fullUnit.truncated).toBe(false);

    // A budget just under the full size forces the first step.
    const trimmed = buildUnits({ dir, repo: fixture.dir, maxRequestChars: fullUnit.request.length - 1 }).document;
    const trimmedUnit = unitOf(trimmed, (u) => u.symbol === "checkUpload");
    expect(trimmedUnit.truncated).toBe(true);
    expect(callerLines(trimmedUnit.request)).toBeLessThan(8);
    expect(trimmedUnit.request.length).toBeLessThanOrEqual(fullUnit.request.length - 1);
    expect(trimmed.degraded.some((d) => d.reason.startsWith(`${trimmedUnit.id} `))).toBe(true);
  });

  it("splits a symbol too long for one request into overlapping passes, each obligation asked once", () => {
    const body = Array.from({ length: 400 }, (_, i) => `  total += ${i}; // line ${i}`).join("\n");
    const long = makeFixture(
      "units-long",
      { message: "base", files: { "src/long.ts": `export function big(): number {\n  let total = 0;\n${body}\n  return total;\n}\n` } },
      {
        message: "head",
        files: {
          "src/long.ts": `export function big(): number {\n  let total = 1;\n${body.replace("total += 350;", "total -= 350;")}\n  return total;\n}\n`,
        },
      },
    );
    try {
      const facts = factsFor(long);
      facts.extractors.facts!.symbols = [];
      facts.extractors.contracts = { contracts: [] };
      const obligations = [
        obligation("O-001", "state", "src/long.ts", 2, []),
        obligation("O-002", "state", "src/long.ts", 353, []),
      ];
      const dir = workspace(long, facts, obligations, "long");
      const doc = buildUnits({ dir, repo: long.dir, maxRequestChars: 12_000 }).document;
      const passes = doc.units.filter((u) => u.symbol === "big");
      expect(passes.length).toBeGreaterThan(1);
      for (const pass of passes) {
        expect(pass.truncated).toBe(true);
        expect(pass.request.length).toBeLessThanOrEqual(12_000);
      }
      // The two changed lines are each in some pass, tagged `+`.
      const changed = passes.flatMap((p) =>
        [...(requestLineTags(p.request).get("src/long.ts")?.entries() ?? [])].filter(([, t]) => t.changed).map(([l]) => l),
      );
      expect(new Set(changed)).toEqual(new Set([2, 353]));
      // Each obligation is asked by exactly one pass — the one holding its anchor.
      expect(doc.units.flatMap((u) => u.obligationIds).sort()).toEqual(["O-001", "O-002"]);
      const home = passes.find((p) => p.obligationIds.includes("O-002"))!;
      expect(requestLineTags(home.request).get("src/long.ts")?.has(353)).toBe(true);
      expect(doc.degraded.some((d) => /overlapping passes/.test(d.reason))).toBe(true);
    } finally {
      long.cleanup();
    }
  });
});

describe("units — inputs and the CLI", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeUnitsFixture();
  });
  afterAll(() => fixture.cleanup());

  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
  };

  it("fails loud on a missing facts.json — exit 2 AND a coverage:none document naming it", () => {
    const dir = join(fixture.dir, ".lastlight", "missing");
    rmSync(dir, { recursive: true, force: true });
    const { io: cli } = io();
    expect(runCli(["units", "--dir", dir, "--repo", fixture.dir], cli)).toBe(EXIT_UNAVAILABLE);
    const doc = JSON.parse(readFileSync(join(dir, "units.json"), "utf8")) as UnitsDocument;
    expect(doc.coverage).toBe("none");
    expect(doc.units).toEqual([]);
    expect(doc.degraded[0]?.reason).toMatch(/facts\.json/);
    // …and under --never-fail the same document, exit 0.
    expect(runCli(["units", "--dir", dir, "--repo", fixture.dir, "--never-fail"], cli)).toBe(EXIT_OK);
  });

  it("writes coverage:none and exits 0 when there is nothing to survey", () => {
    const facts = { ...factsFor(fixture), baseSha: fixture.head };
    const dir = workspace(fixture, facts, [], "nothing");
    const { io: cli } = io();
    expect(runCli(["units", "--dir", dir, "--repo", fixture.dir], cli)).toBe(EXIT_OK);
    const doc = JSON.parse(readFileSync(join(dir, "units.json"), "utf8")) as UnitsDocument;
    expect(doc.coverage).toBe("none");
    expect(doc.units).toEqual([]);
    expect(doc.degraded.some((d) => /nothing to survey/.test(d.reason))).toBe(true);
  });

  it("with no obligations.json, still covers every changed line and names the missing seed", () => {
    const dir = workspace(fixture, factsFor(fixture), null, "unseeded");
    const { io: cli } = io();
    expect(runCli(["units", "--dir", dir, "--repo", fixture.dir], cli)).toBe(EXIT_DEGRADED);
    const doc = JSON.parse(readFileSync(join(dir, "units.json"), "utf8")) as UnitsDocument;
    // With no obligation to hold them apart, both small changed functions fold
    // into the file's one module unit — which still shows every changed line.
    expect(doc.units.map((u) => u.kind)).toEqual(["module"]);
    const tags = requestLineTags(doc.units[0]!.request).get("src/limits.ts")!;
    for (const line of [3, 6, 8, 20]) expect(tags.get(line)?.changed, `L${line}`).toBe(true);
    expect(doc.units.every((u) => u.obligationIds.length === 0)).toBe(true);
    expect(doc.degraded.some((d) => /obligations\.json/.test(d.reason))).toBe(true);
  });
});

// ── the ingest ───────────────────────────────────────────────────────────────

const CLEAN_EVIDENCE = {
  subject: "x",
  control_site: "src/limits.ts:8",
  control_text: "  if (strict) return size < MAX_UPLOAD;",
  authority: "binding",
  order_ok: true,
  cannot_distinguish: "nothing",
  bypass: "none found",
  in_changed_hunk: true,
  consequence: null,
  trigger: "unknown",
  crosses_boundary: false,
  capability_gained: null,
};

const RISK_EVIDENCE = {
  ...CLEAN_EVIDENCE,
  control_site: "none",
  control_text: "",
  authority: "unknown",
  order_ok: "unknown",
  cannot_distinguish: "a strict and a lax caller",
  bypass: "none found",
  consequence: "a caller passing no flag gets the lax check",
  trigger: "input",
};

/** A reply answering every obligation the unit carries, at the unit's first changed tag. */
function replyFor(unit: Unit, obligations: Obligation[]) {
  const tags = requestLineTags(unit.request);
  const [file, lines] = [...tags.entries()].find(([, l]) => l.size > 0)!;
  const line = [...lines.entries()].find(([, t]) => t.changed)?.[0] ?? [...lines.keys()][0]!;
  return {
    unitId: unit.id,
    answers: unit.obligationIds.map((id) => ({
      obligation: id,
      family: obligations.find((o) => o.id === id)?.family ?? "spec",
      claim: `answer to ${id}`,
      ...(unit.kind === "pr" ? { file } : {}),
      line,
      evidence: CLEAN_EVIDENCE,
    })),
    defects: [],
  };
}

function writeResponse(dir: string, unit: Unit, raw: string, over: Record<string, unknown> = {}): void {
  const path = join(dir, "units", "responses", `${unit.id}.json`);
  mkdirSync(join(dir, "units", "responses"), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({
      unitId: unit.id,
      model: "test/model",
      systemPromptSha256: "0",
      requestSha256: unit.requestSha256,
      ok: true,
      cached: false,
      attempts: 1,
      raw,
      error: null,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
      durationMs: 0,
      ...over,
    }),
  );
}

function answerAll(dir: string, doc: UnitsDocument, obligations: Obligation[]): void {
  for (const unit of doc.units) writeResponse(dir, unit, JSON.stringify(replyFor(unit, obligations)));
}

function familyRows(dir: string, family: string): Record<string, unknown>[] {
  const path = join(dir, "hypotheses", `${family}.jsonl`);
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function gatesPass(dir: string): void {
  for (const family of ["contract", "enforcement", "security", "state", "tests"]) {
    const result = checkDischarge({ dir, family });
    expect(result.satisfied, `${family}: ${result.notes.join(" | ")}`).toBe(true);
  }
}

describe("units-ingest", () => {
  let fixture: Fixture;
  let n = 0;
  /** A fresh workspace with units.json assembled. */
  const setup = (): { dir: string; doc: UnitsDocument } => {
    const dir = workspace(fixture, factsFor(fixture), OBLIGATIONS, `ingest-${++n}`);
    const doc = buildUnits({ dir, repo: fixture.dir }).document;
    writeFileSync(join(dir, "units.json"), JSON.stringify(doc));
    return { dir, doc };
  };
  beforeAll(() => {
    fixture = makeUnitsFixture();
  });
  afterAll(() => fixture.cleanup());

  it("turns valid replies into rows of the existing shape, and every family's discharge gate passes", () => {
    const { dir, doc } = setup();
    answerAll(dir, doc, OBLIGATIONS);
    const { document, exitCode } = ingestUnits({ dir });
    expect(document.units.filter((u) => u.status !== "ok")).toEqual([]);
    expect(exitCode).toBe(EXIT_OK);
    expect(document.satisfied).toBe(true);

    const [row] = familyRows(dir, "contract");
    expect(row).toMatchObject({
      id: "contract-001",
      family: "contract",
      obligation: "O-002",
      discharge: "QUOTE",
      source: "units",
      unitId: "u-002",
      bothEnds: { introducedAt: "src/limits.ts:1", enforcedAt: "src/limits.ts:8" },
      quotes: [{ path: "src/limits.ts", line: 6, text: "export function checkUpload(size: number, strict = false): boolean {" }],
    });
    // Nothing the model does not own is on the row.
    expect(row).not.toHaveProperty("severity");
    expect(row).not.toHaveProperty("needsProbe");
    // The ids are the canonical ones every other reader assigns.
    const set = readHypothesisSet(dir);
    for (const record of set.records) expect((record.row as { id?: unknown }).id).toBe(record.id);
    gatesPass(dir);
    expect(JSON.parse(readFileSync(join(dir, "units", "ingest.json"), "utf8"))).toMatchObject({ satisfied: true });
  });

  it("reads a fenced reply with prose around it, and files an unprompted defect under its own family", () => {
    const { dir, doc } = setup();
    answerAll(dir, doc, OBLIGATIONS);
    const unit = unitOf(doc, (u) => u.symbol === "Store.put");
    const body = replyFor(unit, OBLIGATIONS);
    body.defects = [{ family: "security", claim: "negative values are silently dropped", line: 20, evidence: RISK_EVIDENCE } as never];
    writeResponse(dir, unit, `Here is my answer.\n\n\`\`\`json\n${JSON.stringify(body, null, 2)}\n\`\`\`\nDone.`);
    const { document } = ingestUnits({ dir });
    const report = document.units.find((u) => u.unitId === unit.id)!;
    expect(report).toMatchObject({ status: "ok", via: "span" });
    const defect = familyRows(dir, "security").find((r) => r.unitId === unit.id)!;
    expect(defect).toMatchObject({ discharge: "ABSENT", quotes: [{ line: 20, text: "    if (value < 0) return;" }] });
    expect(defect).not.toHaveProperty("obligation");
    expect(deriveVerdict(defect.evidence as SurveyEvidence).needsProbe).toBe(true);
    gatesPass(dir);
  });

  it("a missing reply still yields a row per obligation — PROBE, unknown evidence, routed to a probe", () => {
    const { dir, doc } = setup();
    answerAll(dir, doc, OBLIGATIONS);
    const unit = unitOf(doc, (u) => u.symbol === "checkUpload");
    rmSync(join(dir, "units", "responses", `${unit.id}.json`));
    const { document, exitCode } = ingestUnits({ dir });
    expect(exitCode).toBe(EXIT_DEGRADED);
    expect(document.units.find((u) => u.unitId === unit.id)).toMatchObject({ status: "missing", unanswered: ["O-002"] });
    const row = familyRows(dir, "contract").find((r) => r.obligation === "O-002")!;
    expect(row).toMatchObject({ discharge: "PROBE", source: "units", unitId: unit.id });
    expect(deriveVerdict(row.evidence as SurveyEvidence).needsProbe).toBe(true);
    gatesPass(dir);
  });

  it("ok:false and a stale request hash are both unanswered, never read", () => {
    const { dir, doc } = setup();
    answerAll(dir, doc, OBLIGATIONS);
    const failed = unitOf(doc, (u) => u.symbol === "checkUpload");
    const stale = unitOf(doc, (u) => u.symbol === "Store.put");
    writeResponse(dir, failed, JSON.stringify(replyFor(failed, OBLIGATIONS)), { ok: false, error: "provider 500" });
    writeResponse(dir, stale, JSON.stringify(replyFor(stale, OBLIGATIONS)), { requestSha256: "f".repeat(64) });
    const { document } = ingestUnits({ dir });
    expect(document.units.find((u) => u.unitId === failed.id)?.status).toBe("failed");
    expect(document.units.find((u) => u.unitId === stale.id)?.status).toBe("stale");
    expect(familyRows(dir, "contract").find((r) => r.obligation === "O-002")?.discharge).toBe("PROBE");
    expect(familyRows(dir, "state").find((r) => r.obligation === "O-003")?.discharge).toBe("PROBE");
    gatesPass(dir);
  });

  it("an invalid entry keeps its claim, and an obligation the reply skipped is still conserved", () => {
    const { dir, doc } = setup();
    answerAll(dir, doc, OBLIGATIONS);
    const unit = unitOf(doc, (u) => u.symbol === "checkUpload");
    const bad = replyFor(unit, OBLIGATIONS);
    bad.answers[0] = { ...bad.answers[0]!, evidence: { ...CLEAN_EVIDENCE, authority: "probably" } as never };
    writeResponse(dir, unit, JSON.stringify(bad));
    const skipped = unitOf(doc, (u) => u.symbol === "Store.put");
    writeResponse(dir, skipped, JSON.stringify({ ...replyFor(skipped, OBLIGATIONS), answers: [] }));

    const { document } = ingestUnits({ dir });
    expect(document.units.find((u) => u.unitId === unit.id)).toMatchObject({ status: "partial", unanswered: ["O-002"] });
    const invalid = familyRows(dir, "contract").find((r) => r.obligation === "O-002")!;
    expect(invalid.discharge).toBe("PROBE");
    expect(String(invalid.claim)).toContain("answer to O-002");
    expect(document.units.find((u) => u.unitId === skipped.id)).toMatchObject({ status: "partial", unanswered: ["O-003"] });
    expect(familyRows(dir, "state").filter((r) => r.obligation === "O-003")).toHaveLength(1);
    gatesPass(dir);
  });

  it("a line that is not one of the request's tags keeps the row and drops only its location", () => {
    const { dir, doc } = setup();
    answerAll(dir, doc, OBLIGATIONS);
    const unit = unitOf(doc, (u) => u.symbol === "checkUpload");
    const body = replyFor(unit, OBLIGATIONS);
    body.answers[0] = { ...body.answers[0]!, line: 999 };
    writeResponse(dir, unit, JSON.stringify(body));
    const { document } = ingestUnits({ dir });
    const report = document.units.find((u) => u.unitId === unit.id)!;
    expect(report.status).toBe("ok");
    expect(report.warnings.some((w) => w.includes(":999"))).toBe(true);
    expect(familyRows(dir, "contract")[0]).toMatchObject({ obligation: "O-002", quotes: [], existingCode: null });
  });

  it("with every reply missing, the gates still pass — every obligation and every measured family has a row", () => {
    const { dir } = setup();
    const { document, exitCode } = ingestUnits({ dir });
    expect(exitCode).toBe(EXIT_DEGRADED);
    expect(document.satisfied).toBe(false);
    const rows = ["contract", "enforcement", "security", "state"].flatMap((f) => familyRows(dir, f));
    expect(rows.filter((r) => typeof r.obligation === "string").map((r) => r.obligation).sort()).toEqual([
      "O-001",
      "O-002",
      "O-003",
      "O-004",
    ]);
    gatesPass(dir);
  });

  it("a measured family with no obligation gets a placeholder row the gate accepts", () => {
    const dir = workspace(fixture, factsFor(fixture), OBLIGATIONS.filter((o) => o.family !== "security"), `ingest-${++n}`);
    const doc = buildUnits({ dir, repo: fixture.dir }).document;
    writeFileSync(join(dir, "units.json"), JSON.stringify(doc));
    answerAll(dir, doc, OBLIGATIONS);
    ingestUnits({ dir });
    const [row] = familyRows(dir, "security");
    expect(row).toMatchObject({ id: "security-001", source: "units" });
    expect(row).not.toHaveProperty("obligation");
    expect(deriveVerdict(row!.evidence as SurveyEvidence).needsProbe).toBe(false);
    gatesPass(dir);
  });

  it("an unreadable units.json still conserves every obligation, and the CLI exits 2 (0 under --never-fail)", () => {
    const { dir } = setup();
    writeFileSync(join(dir, "units.json"), "{ not json");
    const out: string[] = [];
    const cli = { out: (s: string) => out.push(s), err: () => {} };
    expect(runCli(["units-ingest", "--dir", dir], cli)).toBe(EXIT_UNAVAILABLE);
    expect(["contract", "enforcement", "security", "state"].flatMap((f) => familyRows(dir, f)).filter((r) => r.obligation)).toHaveLength(4);
    expect(runCli(["units-ingest", "--dir", dir, "--never-fail"], cli)).toBe(EXIT_OK);
    gatesPass(dir);
  });
});

describe("units — end to end over real facts and seed", () => {
  let fixture: Fixture;
  afterAll(() => fixture?.cleanup());

  it("every seeded obligation lands in exactly one unit, and an answered survey passes every gate", () => {
    fixture = makeUnitsFixture();
    const dir = join(fixture.dir, ".lastlight", "pr-review");
    mkdirSync(dir, { recursive: true });
    const facts = runExtractor({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      env: { PATH: "" },
    }).document as unknown as AllDocument;
    writeFileSync(join(dir, "facts.json"), JSON.stringify(facts));
    const seeded = seedObligations(facts);
    writeFileSync(join(dir, "obligations.json"), JSON.stringify(seeded));
    expect(seeded.obligations.length).toBeGreaterThan(0);

    const out: string[] = [];
    const cli = { out: (s: string) => out.push(s), err: () => {} };
    runCli(["units", "--dir", dir, "--repo", fixture.dir], cli);
    const doc = JSON.parse(readFileSync(join(dir, "units.json"), "utf8")) as UnitsDocument;
    expect(doc.units.flatMap((u) => u.obligationIds).sort()).toEqual(seeded.obligations.map((o) => o.id).sort());

    answerAll(dir, doc, seeded.obligations);
    expect(runCli(["units-ingest", "--dir", dir], cli)).toBe(EXIT_OK);
    gatesPass(dir);
  });
});

// ── one module unit per file, and the shared prefix ─────────────────────────

const fill = (tag: string, n: number): string[] => Array.from({ length: n }, (_, i) => `export const ${tag}_${i} = ${i};`);

/**
 * Four module-scope changes far apart (an import, a constant, a type, and the
 * body of a three-line function), plus a 22-line function that stays a symbol.
 */
function configSource(head: boolean): string {
  return [
    head ? `import { a, b } from "./a";` : `import { a } from "./a";`,
    "",
    ...fill("A", 20),
    head ? "export const LIMIT = 5;" : "export const LIMIT = 4;",
    ...fill("B", 20),
    "export function tiny(x: number): number {",
    head ? "  return helper(x) + 2;" : "  return helper(x) + 1;",
    "}",
    ...fill("C", 20),
    "export function large(x: number): number {",
    "  let y = x;",
    ...Array.from({ length: 18 }, (_, i) => (head && i === 9 ? `  y += ${i} * 2;` : `  y += ${i};`)),
    "  return y;",
    "}",
    ...fill("D", 20),
    head ? `export type Mode = "a" | "b" | "c";` : `export type Mode = "a" | "b";`,
    "",
  ].join("\n");
}

const CONFIG_HEAD = configSource(true);
const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
const L = {
  import: 1,
  limit: lineOf(CONFIG_HEAD, "export const LIMIT"),
  tiny: lineOf(CONFIG_HEAD, "export function tiny"),
  tinyBody: lineOf(CONFIG_HEAD, "helper(x) + 2"),
  large: lineOf(CONFIG_HEAD, "export function large"),
  largeChanged: lineOf(CONFIG_HEAD, "y += 9 * 2"),
  mode: lineOf(CONFIG_HEAD, "export type Mode"),
  gap: lineOf(CONFIG_HEAD, "A_10 ="),
};

function makeCoalesceFixture(): Fixture {
  return makeFixture(
    "units-coalesce",
    {
      message: "base",
      files: {
        "src/a.ts": "export const a = 1;\nexport const b = 2;\n",
        "src/config.ts": configSource(false),
        "src/other.ts": "export function tiny2(): number {\n  return 1;\n}\n",
        "src/app.ts": `import { tiny } from "./config";\nexport const r = tiny(3);\n`,
      },
    },
    { message: "head", files: { "src/config.ts": CONFIG_HEAD, "src/other.ts": "export function tiny2(): number {\n  return 2;\n}\n" } },
  );
}

/** Facts for the coalesce fixture: `tiny` has a caller and a callee, or — `bare` — nothing is known. */
function coalesceFacts(fixture: Fixture, bare = false): AllDocument {
  const facts = factsFor(fixture);
  facts.extractors.facts!.symbols = bare
    ? []
    : [
        symbol("tiny", "function", `src/config.ts:${L.tiny}`, {
          changedHunks: [`src/config.ts:${L.tinyBody}-${L.tinyBody}`],
          references: [ref("src/app.ts:2")],
          callees: ["helper"],
          referenceCount: 1,
        }) as never,
      ];
  facts.extractors.contracts = { contracts: [] } as never;
  return facts;
}

const COALESCE_OBLIGATIONS: Obligation[] = [
  obligation("O-101", "enforcement", "src/config.ts", L.limit, []),
  obligation("O-102", "tests", "src/config.ts", L.largeChanged, []),
];

/** The tags shown in a request's SOURCE section only (not IMPORTS). */
function sourceTags(request: string): number[] {
  const tail = request.slice(request.indexOf(UNIT_SEPARATOR));
  const section = tail.slice(tail.indexOf("\nSOURCE\n"), tail.indexOf("\nIMPORTS") >= 0 ? tail.indexOf("\nIMPORTS") : tail.indexOf("\nCALLERS"));
  return section
    .split("\n")
    .map((l) => TAG.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

const ELISION = /^\s+⋮/;

describe("units — one module unit per file", () => {
  let fixture: Fixture;
  let dir: string;
  let doc: UnitsDocument;
  beforeAll(() => {
    fixture = makeCoalesceFixture();
    dir = workspace(fixture, coalesceFacts(fixture), COALESCE_OBLIGATIONS, "coalesce");
    doc = buildUnits({ dir, repo: fixture.dir }).document;
  });
  afterAll(() => fixture.cleanup());

  it("coalesces every changed region no symbol holds into ONE module unit, and keeps a long function a symbol", () => {
    const config = doc.units.filter((u) => u.file === "src/config.ts");
    expect(config.map((u) => [u.kind, u.symbol])).toEqual([
      ["module", null],
      ["symbol", "large"],
    ]);
    const module = config[0]!;
    expect(module.lines).toEqual([L.import, L.mode]);
    expect(L.large + SMALL_SYMBOL_LINES).toBeLessThan(lineOf(CONFIG_HEAD, "  return y;"));
  });

  it("shows the regions in head order, one elision row between each, and not the lines in the gaps", () => {
    const module = unitOf(doc, (u) => u.kind === "module" && u.file === "src/config.ts");
    const shown = sourceTags(module.request);
    expect(shown).toEqual([...shown].sort((a, b) => a - b));
    expect(new Set(shown).size).toBe(shown.length);
    for (const line of [L.import, L.limit, L.tinyBody, L.mode]) expect(shown).toContain(line);
    expect(shown).not.toContain(L.gap);
    const specific = module.request.slice(doc.sharedPrefix.length);
    // import · LIMIT · tiny · Mode: four regions, three gaps.
    expect(specific.split("\n").filter((l) => ELISION.test(l))).toHaveLength(3);
    // Each changed line is marked, with context around it.
    const tags = requestLineTags(module.request).get("src/config.ts")!;
    for (const line of [L.limit, L.tinyBody, L.mode]) {
      expect(tags.get(line)?.changed).toBe(true);
      expect(tags.has(line - 1) || tags.has(line + 1)).toBe(true);
    }
  });

  it("folds a small changed function with no obligation into the module unit, keeping its callers and callees", () => {
    expect(doc.units.some((u) => u.symbol === "tiny")).toBe(false);
    const module = unitOf(doc, (u) => u.kind === "module" && u.file === "src/config.ts");
    const tags = requestLineTags(module.request).get("src/config.ts")!;
    // Shown whole: declaration to closing brace.
    for (let l = L.tiny; l <= L.tiny + 2; l++) expect(tags.has(l), `L${l}`).toBe(true);
    expect(module.request).toContain("src/app.ts:2 (");
    expect(module.request).toContain("export const r = tiny(3);");
    expect(module.request).toMatch(/^ {2}- helper$/m);
  });

  it("does not fold a lone small function in a file with no module unit", () => {
    expect(doc.units.filter((u) => u.file === "src/other.ts").map((u) => [u.kind, u.symbol])).toEqual([["symbol", "tiny2"]]);
  });

  it("attaches an obligation to the module region that owns its anchor", () => {
    expect(unitOf(doc, (u) => u.obligationIds.includes("O-101")).kind).toBe("module");
    expect(unitOf(doc, (u) => u.obligationIds.includes("O-102")).symbol).toBe("large");
    expect(doc.units.flatMap((u) => u.obligationIds).sort()).toEqual(["O-101", "O-102"]);
  });

  it("is deterministic", () => {
    expect(buildUnits({ dir, repo: fixture.dir }).document.units).toEqual(doc.units);
  });

  it("spreads the regions over several module units only when the file's changes overrun the budget", () => {
    // No neighbours to trim or drop, so only a split can make it fit.
    const bareDir = workspace(fixture, coalesceFacts(fixture, true), COALESCE_OBLIGATIONS, "coalesce-split");
    const whole = buildUnits({ dir: bareDir, repo: fixture.dir }).document;
    const one = whole.units.filter((u) => u.kind === "module" && u.file === "src/config.ts");
    expect(one).toHaveLength(1);
    const budget = one[0]!.request.length - 1;

    const split = buildUnits({ dir: bareDir, repo: fixture.dir, maxRequestChars: budget }).document;
    const pieces = split.units.filter((u) => u.kind === "module" && u.file === "src/config.ts");
    expect(pieces.length).toBeGreaterThan(1);
    for (const p of pieces) {
      expect(p.request.length).toBeLessThanOrEqual(budget);
      expect(p.truncated).toBe(true);
    }
    // Every changed line is still in some piece, and the pieces do not overlap.
    const shown = pieces.map((p) => sourceTags(p.request));
    expect(shown.flat().sort((a, b) => a - b)).toEqual(sourceTags(one[0]!.request));
    // Ordered by line, ids in that order.
    const firsts = pieces.map((p) => p.lines![0]);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    // The obligation travels with the region that owns its anchor, once.
    const home = pieces.filter((p) => p.obligationIds.includes("O-101"));
    expect(home).toHaveLength(1);
    expect(sourceTags(home[0]!.request)).toContain(L.limit);
    expect(split.units.flatMap((u) => u.obligationIds).sort()).toEqual(["O-101", "O-102"]);
    expect(split.degraded.some((d) => d.reason.startsWith("src/config.ts:"))).toBe(true);
  });
});

describe("units — the shared prefix", () => {
  let fixture: Fixture;
  let coalesce: Fixture;
  let a: UnitsDocument;
  let b: UnitsDocument;
  beforeAll(() => {
    fixture = makeUnitsFixture();
    coalesce = makeCoalesceFixture();
    a = buildUnits({ dir: workspace(fixture, factsFor(fixture), OBLIGATIONS, "prefix"), repo: fixture.dir }).document;
    b = buildUnits({ dir: workspace(coalesce, coalesceFacts(coalesce), COALESCE_OBLIGATIONS, "prefix"), repo: coalesce.dir }).document;
  });
  afterAll(() => {
    fixture.cleanup();
    coalesce.cleanup();
  });

  it("every request starts with the document's sharedPrefix, and its sha is recorded", () => {
    for (const doc of [a, b]) {
      expect(doc.units.length).toBeGreaterThan(1);
      expect(doc.sharedPrefixSha256).toBe(createHash("sha256").update(doc.sharedPrefix, "utf8").digest("hex"));
      for (const unit of doc.units) expect(unit.request.startsWith(doc.sharedPrefix), unit.id).toBe(true);
    }
  });

  it("is byte-identical across units, documents and runs — nothing unit-specific is in it", () => {
    expect(a.sharedPrefix).toBe(b.sharedPrefix);
    expect(a.sharedPrefix).toBe(UNITS_SHARED_PREFIX);
    expect(a.sharedPrefix.trimEnd().endsWith(UNIT_SEPARATOR)).toBe(true);
    for (const unit of [...a.units, ...b.units]) {
      expect(a.sharedPrefix).not.toContain(unit.id);
      for (const id of unit.obligationIds) expect(a.sharedPrefix).not.toContain(id);
      if (unit.file) expect(a.sharedPrefix).not.toContain(unit.file);
    }
    // No line tag and no FILE header: the ingest reads tags from the unit part only.
    expect(requestLineTags(a.sharedPrefix).size).toBe(0);
    // The always-asked families are in it; the conditional one is not.
    for (const family of ["contract", "enforcement", "security", "state", "spec"]) {
      expect(a.sharedPrefix).toContain(FAMILY_QUESTIONS[family]!.question);
    }
    expect(a.sharedPrefix).not.toContain(FAMILY_QUESTIONS.tests!.question);
  });

  it("asks the conditional tests family after the prefix, and only of a unit carrying a tests obligation", () => {
    const tests = FAMILY_QUESTIONS.tests!.question;
    for (const unit of b.units) {
      const specific = unit.request.slice(b.sharedPrefix.length);
      expect(specific.includes(tests), unit.id).toBe(unit.families.includes("tests"));
    }
    expect(b.units.some((u) => u.families.includes("tests"))).toBe(true);
  });
});

describe("units-ingest — coalesced module units", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeCoalesceFixture();
  });
  afterAll(() => fixture.cleanup());

  it("maps lines in every region of a module unit to the shown text, and drops only a line from a gap", () => {
    const dir = workspace(fixture, coalesceFacts(fixture), COALESCE_OBLIGATIONS, "coalesce-ingest");
    const doc = buildUnits({ dir, repo: fixture.dir }).document;
    writeFileSync(join(dir, "units.json"), JSON.stringify(doc));
    answerAll(dir, doc, COALESCE_OBLIGATIONS);

    const module = unitOf(doc, (u) => u.kind === "module" && u.file === "src/config.ts");
    const entry = (line: number, claim: string) => ({ family: "state", claim, line, evidence: RISK_EVIDENCE });
    writeResponse(
      dir,
      module,
      JSON.stringify({
        unitId: module.id,
        // The obligation anchored in region 2, answered at a line in region 4.
        answers: [{ obligation: "O-101", family: "enforcement", claim: "answered far away", line: L.mode, evidence: CLEAN_EVIDENCE }],
        defects: [entry(L.import, "first region"), entry(L.tinyBody, "folded function"), entry(L.gap, "a line never shown")],
      }),
    );
    const { document } = ingestUnits({ dir });
    const report = document.units.find((u) => u.unitId === module.id)!;
    expect(report.status).toBe("ok");
    expect(report.answered).toEqual(["O-101"]);

    const quoted = (rows: Record<string, unknown>[], claim: string) => rows.find((r) => r.claim === claim)?.quotes;
    expect(quoted(familyRows(dir, "enforcement"), "answered far away")).toEqual([
      { path: "src/config.ts", line: L.mode, text: `export type Mode = "a" | "b" | "c";` },
    ]);
    const state = familyRows(dir, "state");
    expect(quoted(state, "first region")).toEqual([{ path: "src/config.ts", line: 1, text: `import { a, b } from "./a";` }]);
    expect(quoted(state, "folded function")).toEqual([{ path: "src/config.ts", line: L.tinyBody, text: "  return helper(x) + 2;" }]);
    // A line from an elided gap was never a tag: the row stays, its location goes.
    expect(quoted(state, "a line never shown")).toEqual([]);
    expect(report.warnings.some((w) => w.includes(`:${L.gap} `))).toBe(true);
    gatesPass(dir);
  });
});

// ── the fix-up slice: reply rule at ingest, probe stamping, fallback document, spec obligations ──

describe("units-ingest — the canonical reply rule", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeUnitsFixture();
  });
  afterAll(() => fixture.cleanup());

  const setup = (name: string): { dir: string; doc: UnitsDocument } => {
    const dir = workspace(fixture, factsFor(fixture), OBLIGATIONS, name);
    const doc = buildUnits({ dir, repo: fixture.dir }).document;
    writeFileSync(join(dir, "units.json"), JSON.stringify(doc));
    answerAll(dir, doc, OBLIGATIONS);
    return { dir, doc };
  };

  it("reads a reply nested under a key, and one after a stray brace in prose — both of which the handler accepts", () => {
    const { dir, doc } = setup("rule-1");
    const nested = unitOf(doc, (u) => u.symbol === "checkUpload");
    const stray = unitOf(doc, (u) => u.symbol === "Store.put");
    writeResponse(dir, nested, JSON.stringify({ result: replyFor(nested, OBLIGATIONS) }));
    writeResponse(dir, stray, `The limit uses { braces, like "this. ${JSON.stringify(replyFor(stray, OBLIGATIONS))}`);
    const { document } = ingestUnits({ dir });
    expect(document.units.find((u) => u.unitId === nested.id)).toMatchObject({ status: "ok", via: "nested", answered: ["O-002"] });
    expect(document.units.find((u) => u.unitId === stray.id)).toMatchObject({ status: "ok", via: "span", answered: ["O-003"] });
  });

  it("a reply object without a `defects` array is not usable — the same rule the handler retries on", () => {
    const { dir, doc } = setup("rule-2");
    const unit = unitOf(doc, (u) => u.symbol === "checkUpload");
    const { defects: _drop, ...noDefects } = replyFor(unit, OBLIGATIONS);
    writeResponse(dir, unit, JSON.stringify(noDefects));
    const report = ingestUnits({ dir }).document.units.find((u) => u.unitId === unit.id)!;
    expect(report.status).toBe("invalid");
    expect(report.errors.join(" ")).toMatch(/defects/);
    // …and its obligation is still conserved.
    expect(familyRows(dir, "contract").find((r) => r.obligation === "O-002")?.discharge).toBe("PROBE");
  });
});

describe("units-ingest — unanswered rows are REQUIRED to be probed", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeUnitsFixture();
  });
  afterAll(() => fixture.cleanup());

  it("stamps needsProbe on every row for an obligation the model did not answer, and on no other row", () => {
    const dir = workspace(fixture, factsFor(fixture), OBLIGATIONS, "probe-1");
    const doc = buildUnits({ dir, repo: fixture.dir }).document;
    writeFileSync(join(dir, "units.json"), JSON.stringify(doc));
    answerAll(dir, doc, OBLIGATIONS);
    // One unit's reply missing (O-002), one reply that skips its obligation
    // (O-003), and one unprompted defect whose entry is invalid.
    const missing = unitOf(doc, (u) => u.symbol === "checkUpload");
    rmSync(join(dir, "units", "responses", `${missing.id}.json`));
    const partial = unitOf(doc, (u) => u.symbol === "Store.put");
    writeResponse(dir, partial, JSON.stringify({ ...replyFor(partial, OBLIGATIONS), answers: [], defects: [{ family: "state", claim: "garbled", line: 20, evidence: { nope: 1 } }] }));
    ingestUnits({ dir });

    const set = readHypothesisSet(dir);
    const byObligation = (id: string) => set.records.find((r) => (r.row as { obligation?: unknown }).obligation === id)!;
    const unanswered = [byObligation("O-002"), byObligation("O-003")];
    for (const record of unanswered) {
      expect(record.row).toMatchObject({ needsProbe: true, discharge: "PROBE" });
      expect(requiresProbe(record.row)).toBe(true);
    }
    // Answered rows (O-001, O-004 — clean evidence) and the garbled DEFECT are not declared.
    for (const id of ["O-001", "O-004"]) expect(requiresProbe(byObligation(id).row)).toBe(false);
    const garbled = set.records.find((r) => String((r.row as { claim?: unknown }).claim).includes("garbled"))!;
    expect(garbled.row).not.toHaveProperty("needsProbe");

    // The falsify gate now OWES a verdict on exactly the unanswered rows.
    const probes = checkProbes({ dir, repo: fixture.dir });
    expect(probes.required.sort()).toEqual(unanswered.map((r) => r.id).sort());
    expect(probes.satisfied).toBe(false);
    expect(probes.gaps.map((g) => g.kind)).toEqual(["no-verdict", "no-verdict"]);
  });

  it("the declaration agrees with the derivation, so the hygiene report stays clean", () => {
    const dir = workspace(fixture, factsFor(fixture), OBLIGATIONS, "probe-2");
    writeFileSync(join(dir, "units.json"), JSON.stringify(buildUnits({ dir, repo: fixture.dir }).document));
    ingestUnits({ dir });
    const rows = ["contract", "enforcement", "security", "state"].flatMap((f) => familyRows(dir, f)).filter((r) => r.obligation);
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.needsProbe).toBe(true);
      expect(deriveVerdict(row.evidence as SurveyEvidence).needsProbe).toBe(true);
    }
  });
});

describe("units.json — the shell fallback document", () => {
  /** EXACTLY what `pr-review.yaml`'s `fallback()` prints (its printf, with a date and a sha filled in). */
  const YAML_FALLBACK =
    '{"version":1,"generatedAt":"2026-09-27T00:00:00.000Z","baseSha":null,"headSha":"abc","promptVersion":null,"coverage":"none","degraded":[{"extractor":"units","reason":"the units process exited 137 without writing units.json"}],"responseSchema":null,"units":[]}';

  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeUnitsFixture();
  });
  afterAll(() => fixture.cleanup());

  it("validates, and so does the builder's document, which has exactly the YAML's fields", () => {
    const literal = JSON.parse(YAML_FALLBACK) as Record<string, unknown>;
    expect(UnitsDocumentSchema.safeParse(literal).success).toBe(true);
    const built = fallbackUnitsDocument("the units process exited 137 without writing units.json", "abc");
    expect(UnitsDocumentSchema.safeParse(built).success).toBe(true);
    expect(Object.keys(built).sort()).toEqual(Object.keys(literal).sort());
    expect({ ...built, generatedAt: literal.generatedAt }).toEqual(literal);
  });

  it("is accepted ONLY empty and coverage:none — a document with units must carry every field", () => {
    const literal = JSON.parse(YAML_FALLBACK) as Record<string, unknown>;
    expect(UnitsDocumentSchema.safeParse({ ...literal, coverage: "degraded" }).success).toBe(false);
    const unit = { id: "u-001", kind: "pr", file: null, symbol: null, lines: null, language: null, families: [], obligationIds: [], request: "r", requestSha256: "s", truncated: false };
    expect(UnitsDocumentSchema.safeParse({ ...literal, units: [unit] }).success).toBe(false);
  });

  it("ingest reads it as 'the units phase died' — the reason propagated — never as unreadable, and never as clean", () => {
    const dir = workspace(fixture, factsFor(fixture), OBLIGATIONS, "fallback");
    writeFileSync(join(dir, "units.json"), YAML_FALLBACK);
    const { document, exitCode } = ingestUnits({ dir });
    expect(document.unitsRead).toBe(true);
    expect(document.unitsState).toBe("not-surveyed");
    expect(document.unitsReason).toMatch(/exited 137/);
    expect(document.notes.join(" ")).not.toMatch(/not readable|does not validate/);
    expect(document.notes.join(" ")).toMatch(/exited 137/);
    expect(document.satisfied).toBe(false);
    expect(exitCode).toBe(EXIT_DEGRADED);
    // Every obligation is conserved, and its row says why nobody answered it.
    const rows = ["contract", "enforcement", "security", "state"].flatMap((f) => familyRows(dir, f)).filter((r) => r.obligation);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(String(row.claim)).toMatch(/exited 137/);
  });

  it("a genuinely empty range still reads as nothing to survey — a clean answer, exit 0", () => {
    const dir = workspace(fixture, { ...factsFor(fixture), baseSha: fixture.head }, [], "empty-range");
    writeFileSync(join(dir, "units.json"), JSON.stringify(buildUnits({ dir, repo: fixture.dir }).document));
    const { document } = ingestUnits({ dir });
    expect(document.unitsState).toBe("nothing-to-survey");
  });
});

describe("units — spec obligations from spec-obligations.json", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeUnitsFixture();
  });
  afterAll(() => fixture.cleanup());

  /** Core's `SpecObligationSet`, as `review-spec.ts` builds it. */
  const SPEC = {
    obligations: [
      {
        id: "S-1",
        criterion: "Uploads over the limit are rejected in strict mode",
        source: "issue #12",
        candidates: ["src/limits.ts"],
        changedFileCount: 2,
        found: false,
        question: 'Quote the line — `path:line` plus its text — in one of the candidate files that implements "Uploads over the limit are rejected in strict mode", or state that no changed file does.',
      },
      {
        id: "S-2",
        criterion: "The lockfile is regenerated",
        source: "the PR body",
        candidates: ["pnpm-lock.yaml", "src/app.ts"],
        changedFileCount: 2,
        found: false,
        question: "Quote the line that implements it, or state that no changed file does.",
      },
    ],
    dropped: 0,
    changedFileCount: 2,
    degraded: [],
  };

  const specWorkspace = (name: string, spec: unknown): string => {
    const dir = workspace(fixture, factsFor(fixture), OBLIGATIONS, name);
    if (spec !== undefined) writeFileSync(join(dir, "spec-obligations.json"), typeof spec === "string" ? spec : JSON.stringify(spec));
    return dir;
  };

  it("attaches each to the unit with the most touched lines in its first candidate file with a unit, else the pr unit", () => {
    const dir = specWorkspace("spec-attach", SPEC);
    const doc = buildUnits({ dir, repo: fixture.dir }).document;
    const holder = (id: string) => doc.units.filter((u) => u.obligationIds.includes(id));
    // Exactly one unit each.
    expect(holder("S-1")).toHaveLength(1);
    expect(holder("S-2")).toHaveLength(1);
    // S-1: its candidate is src/limits.ts, and of that file's units the one
    // holding the most changed lines carries it.
    const limitsUnits = doc.units.filter((u) => u.file === "src/limits.ts");
    const changed = (u: Unit) => [...(requestLineTags(u.request).get("src/limits.ts")?.values() ?? [])].filter((t) => t.changed).length;
    const most = Math.max(...limitsUnits.map(changed));
    expect(holder("S-1")[0]!.file).toBe("src/limits.ts");
    expect(changed(holder("S-1")[0]!)).toBe(most);
    // …which is checkUpload (two changed lines), NOT the file's first unit (the
    // one-line module region) — the rule is "most touched", not "first".
    expect(holder("S-1")[0]!.symbol).toBe("checkUpload");
    expect(limitsUnits[0]!.kind).toBe("module");
    expect(holder("S-1")[0]!.families).toContain("spec");
    // S-2: the lockfile is skipped and src/app.ts did not change — no unit, so the pr unit.
    expect(holder("S-2")[0]!.kind).toBe("pr");
    // Rendered under OBLIGATIONS with criterion, source and question.
    const request = holder("S-1")[0]!.request.slice(doc.sharedPrefix.length);
    expect(request).toContain("S-1 · family spec · asked in issue #12");
    expect(request).toContain('"Uploads over the limit are rejected in strict mode"');
    expect(request).toContain(SPEC.obligations[0]!.question);
    // Recorded as printed, and the permanent spec gap is gone.
    expect(doc.specObligations?.map((o) => o.id)).toEqual(["S-1", "S-2"]);
    expect(doc.degraded.some((d) => /spec/.test(d.reason))).toBe(false);
    // The shared prefix is still the same bytes for every unit.
    for (const u of doc.units) expect(u.request.startsWith(doc.sharedPrefix)).toBe(true);
  });

  it("ingests answers as hypotheses/spec.jsonl rows in the spec survey's shape, conserving an unanswered one", () => {
    const dir = specWorkspace("spec-ingest", SPEC);
    const doc = buildUnits({ dir, repo: fixture.dir }).document;
    writeFileSync(join(dir, "units.json"), JSON.stringify(doc));
    answerAll(dir, doc, OBLIGATIONS);
    const pr = unitOf(doc, (u) => u.kind === "pr");
    rmSync(join(dir, "units", "responses", `${pr.id}.json`));
    ingestUnits({ dir });

    const rows = familyRows(dir, "spec");
    const s1 = rows.find((r) => r.obligation === "S-1")!;
    expect(s1).toMatchObject({
      id: "spec-001",
      family: "spec",
      obligation: "S-1",
      discharge: "QUOTE",
      path: "src/limits.ts",
      bothEnds: { introducedAt: "issue #12", enforcedAt: "src/limits.ts:8" },
      source: "units",
    });
    expect((s1.quotes as unknown[]).length).toBe(1);
    expect(s1).not.toHaveProperty("needsProbe");
    const s2 = rows.find((r) => r.obligation === "S-2")!;
    expect(s2).toMatchObject({ discharge: "PROBE", needsProbe: true, path: "pnpm-lock.yaml", bothEnds: { introducedAt: "the PR body", enforcedAt: null } });
    // The ingest phase's spec gate — `discharge --ungraded` — passes on these rows.
    expect(runCli(["discharge", "--dir", dir, "--family", "spec", "--ungraded"], { out: () => {}, err: () => {} })).toBe(EXIT_OK);
  });

  it("a malformed or duplicated spec file is a degraded[] entry and no spec obligation — never a crash", () => {
    for (const [name, spec] of [
      ["spec-bad-json", "{ nope"],
      ["spec-bad-shape", { obligations: [{ id: 1, criterion: "x" }] }],
      ["spec-dup-ids", { obligations: [SPEC.obligations[0], SPEC.obligations[0]] }],
    ] as const) {
      const dir = specWorkspace(name, spec);
      const { document, exitCode } = buildUnits({ dir, repo: fixture.dir });
      expect(exitCode, name).toBe(EXIT_DEGRADED);
      expect(document.degraded.some((d) => /spec-obligations\.json/.test(d.reason)), name).toBe(true);
      expect(document.units.flatMap((u) => u.obligationIds).filter((id) => id.startsWith("S-")), name).toEqual([]);
      expect(document.specObligations, name).toBeUndefined();
    }
  });

  it("without the file the gap is still named; --spec naming a missing file names that path", () => {
    const dir = specWorkspace("spec-absent", undefined);
    expect(buildUnits({ dir, repo: fixture.dir }).document.degraded.some((d) => /spec-obligations\.json not found/.test(d.reason))).toBe(true);
    const out: string[] = [];
    runCli(["units", "--dir", dir, "--repo", fixture.dir, "--spec", join(dir, "elsewhere.json")], { out: (s) => out.push(s), err: () => {} });
    const doc = JSON.parse(readFileSync(join(dir, "units.json"), "utf8")) as UnitsDocument;
    expect(doc.degraded.some((d) => d.reason.includes("elsewhere.json") && d.reason.includes("--spec"))).toBe(true);
  });
});
