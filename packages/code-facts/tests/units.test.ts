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
import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE } from "../src/errors.js";
import { readHypothesisSet } from "../src/hypotheses.js";
import { runExtractor } from "../src/run.js";
import type { AllDocument } from "../src/schema.js";
import { seedObligations, type Obligation } from "../src/seed.js";
import { deriveVerdict, type SurveyEvidence } from "../src/survey-verdict.js";
import { extractResponseObject, UnitResponseBodySchema, unitResponseJsonSchema } from "../src/unit-response.js";
import { buildUnits, type Unit, type UnitsDocument } from "../src/units.js";
import { ingestUnits } from "../src/units-ingest.js";
import { requestLineTags } from "../src/units-render.js";
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
    // The spec gap is always named — its obligations never reach the workspace.
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

  it("with no obligations.json, still builds every unit and names the missing seed", () => {
    const dir = workspace(fixture, factsFor(fixture), null, "unseeded");
    const { io: cli } = io();
    expect(runCli(["units", "--dir", dir, "--repo", fixture.dir], cli)).toBe(EXIT_DEGRADED);
    const doc = JSON.parse(readFileSync(join(dir, "units.json"), "utf8")) as UnitsDocument;
    expect(doc.units.map((u) => u.kind)).toEqual(["module", "symbol", "symbol"]);
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
      family: obligations.find((o) => o.id === id)!.family,
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
    expect(report).toMatchObject({ status: "ok", via: "fence" });
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

describe("extractResponseObject", () => {
  it("prefers the object whose unitId matches, through fences and prose", () => {
    const raw = 'Example: {"unitId":"u-999"}\n```json\n{"unitId":"u-001","answers":[],"defects":[]}\n```';
    expect(extractResponseObject(raw, "u-001")).toMatchObject({ via: "fence", value: { unitId: "u-001" } });
    expect(extractResponseObject('lead {"unitId":"u-002","a":"}"} tail', "u-002")).toMatchObject({ via: "scan" });
    expect(extractResponseObject("no json here", "u-001").value).toBeNull();
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
