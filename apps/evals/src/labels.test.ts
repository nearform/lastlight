import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { appendLabel, buildFindings, labelsFilePath, readLabels, readProposals } from "./labels-node.js";
import {
  agreementMetrics,
  cohenKappa,
  dedupFindings,
  foldProposals,
  graderOfFile,
  parseProposalLines,
  proposalAgrees,
  type Proposal,
  foldLabels,
  gradedMetrics,
  labelKey,
  labelsOf,
  lineBucket,
  parseLabelLines,
  prIdentity,
  validateLabelInput,
  type FindingLabel,
  type GradeAppearance,
  type RawFinding,
} from "./labels.js";

const base = { pr: "prreview__x-1587", path: "src/a.ts", line: 70, title: "Null deref in parse", mechanism: "parse() reads x.y when x is null." };

describe("labelKey", () => {
  it("is stable and shaped f1-<28 hex>", () => {
    expect(labelKey(base)).toBe(labelKey({ ...base }));
    expect(labelKey(base)).toMatch(/^f1-[0-9a-f]{28}$/);
  });

  it("normalises case and whitespace in title + mechanism", () => {
    expect(labelKey({ ...base, title: "  NULL deref\n in   parse " })).toBe(labelKey(base));
    expect(labelKey({ ...base, mechanism: "parse()  reads\tX.Y when x is null." })).toBe(labelKey(base));
  });

  it("strips the re-run suffix, so re-runs of one PR share a key", () => {
    expect(prIdentity("prreview__skillspro-1587-r2")).toBe("prreview__skillspro-1587");
    expect(prIdentity("prreview__skillspro-1641")).toBe("prreview__skillspro-1641");
  });

  it("buckets lines by round(line / 7)", () => {
    expect(lineBucket(70)).toBe(10);
    expect(lineBucket(67)).toBe(10);
    expect(lineBucket(73)).toBe(10);
    expect(lineBucket(74)).toBe(11);
    expect(labelKey({ ...base, line: 72 })).toBe(labelKey(base));
    expect(labelKey({ ...base, line: 80 })).not.toBe(labelKey(base));
  });

  it("separates different paths, PRs and texts", () => {
    expect(labelKey({ ...base, path: "src/b.ts" })).not.toBe(labelKey(base));
    expect(labelKey({ ...base, pr: "prreview__x-1667" })).not.toBe(labelKey(base));
    expect(labelKey({ ...base, mechanism: "something else" })).not.toBe(labelKey(base));
  });
});

describe("validateLabelInput", () => {
  const key = labelKey(base);
  it("accepts a full grade", () => {
    const v = validateLabelInput({ key, real: "yes", importance: "must-fix", gold: { instanceId: "i", index: 2 }, note: " x " });
    expect(v).toEqual({ ok: true, value: { key, real: "yes", importance: "must-fix", gold: { instanceId: "i", index: 2 }, note: "x" } });
  });

  it("rejects bad enums, keys, gold and notes", () => {
    expect(validateLabelInput({ key, real: "maybe" }).ok).toBe(false);
    expect(validateLabelInput({ key, real: "yes", importance: "critical" }).ok).toBe(false);
    expect(validateLabelInput({ key: "nope", real: "yes" }).ok).toBe(false);
    expect(validateLabelInput({ key, real: "yes", gold: { instanceId: "i", index: -1 } }).ok).toBe(false);
    expect(validateLabelInput({ key, real: "yes", gold: 3 }).ok).toBe(false);
    expect(validateLabelInput({ key, real: "yes", note: "x".repeat(501) }).ok).toBe(false);
    expect(validateLabelInput([]).ok).toBe(false);
  });

  it("drops importance unless real is yes, and real:null clears everything", () => {
    expect(validateLabelInput({ key, real: "no", importance: "nit" })).toMatchObject({ ok: true, value: { importance: null } });
    expect(validateLabelInput({ key, real: null, importance: "nit", note: "n" })).toEqual({
      ok: true,
      value: { key, real: null, importance: null, gold: null, note: null },
    });
  });
});

const lbl = (key: string, real: FindingLabel["real"], extra: Partial<FindingLabel> = {}): FindingLabel => ({
  key,
  real,
  importance: null,
  gold: null,
  note: null,
  gradedAt: "t",
  finding: { ...base, consequence: "" },
  ...extra,
});

describe("foldLabels", () => {
  it("last write per key wins; real:null clears; torn lines are skipped", () => {
    const text = [
      JSON.stringify(lbl("a", "no")),
      JSON.stringify(lbl("b", "yes")),
      JSON.stringify(lbl("a", "yes", { importance: "nit" })),
      JSON.stringify(lbl("b", null)),
      '{"key":"c","re',
    ].join("\n");
    const m = foldLabels(parseLabelLines(text));
    expect([...m.keys()]).toEqual(["a"]);
    expect(m.get("a")).toMatchObject({ real: "yes", importance: "nit" });
  });
});

const app = (reportLabel: string, instanceId: string, extra: Partial<GradeAppearance> = {}): GradeAppearance => ({
  source: "site-review",
  reportId: `r-${reportLabel}`,
  reportLabel,
  instanceId,
  arm: "arm1",
  repeat: 1,
  site: "site-001",
  session: null,
  ...extra,
});
const raw = (a: GradeAppearance, over: Partial<RawFinding> = {}): RawFinding => ({
  ...base,
  consequence: "c",
  strength: "read",
  excerpt: null,
  gold: [{ index: 0, severity: "high", summary: `gold of ${a.instanceId}` }],
  appearance: a,
  ...over,
});

describe("dedupFindings", () => {
  it("collapses the same finding across reports and re-runs, keeping gold per instance", () => {
    const out = dedupFindings([
      raw(app("armA", "prreview__x-1587-r1")),
      raw(app("armC", "prreview__x-1587-r2"), { title: "null DEREF in parse", line: 71 }),
      raw(app("armC", "prreview__x-1587-r2"), { path: "src/other.ts" }),
    ]);
    expect(out).toHaveLength(2);
    const [f] = out;
    expect(f.appearances.map((a) => a.reportLabel)).toEqual(["armA", "armC"]);
    expect(f.gold.map((g) => g.instanceId)).toEqual(["prreview__x-1587-r1", "prreview__x-1587-r2"]);
    expect(f.title).toBe(base.title); // the first appearance supplies the text
  });

  it("attaches the current label and offers graded neighbours as similar", () => {
    const k = labelKey(base);
    const out = dedupFindings(
      [raw(app("armA", "p-r1")), raw(app("armA", "p-r1"), { line: 78, title: "Different" }), raw(app("armA", "p-r1"), { line: 200, title: "Far" })],
      new Map([[k, lbl(k, "yes")]]),
    );
    expect(out[0].label?.real).toBe("yes");
    expect(out[1].similar.map((s) => s.key)).toEqual([k]);
    expect(out[2].similar).toEqual([]);
  });
});

describe("gradedMetrics", () => {
  it("counts distinct findings per arm and derives precision = real / graded", () => {
    const fs = [
      { key: "a", appearances: [app("armA", "p"), app("armA", "p", { repeat: 2 }), app("armC", "p")] },
      { key: "b", appearances: [app("armA", "p")] },
      { key: "c", appearances: [app("armA", "p")] },
      { key: "d", appearances: [app("armA", "p")] },
      { key: "e", appearances: [app("armC", "p")] },
    ];
    const labels = new Map([
      ["a", lbl("a", "yes", { importance: "must-fix", gold: { instanceId: "p", index: 0 } })],
      ["b", lbl("b", "yes", { importance: "nit" })],
      ["c", lbl("c", "no")],
      ["d", lbl("d", "unsure")],
    ]);
    const [a, c] = gradedMetrics(fs, labels);
    expect(a).toEqual({ group: "armA", findings: 4, graded: 4, real: 2, notReal: 1, unsure: 1, realImportant: 1, precision: 0.5, goldLinked: 1 });
    expect(c).toEqual({ group: "armC", findings: 2, graded: 1, real: 1, notReal: 0, unsure: 0, realImportant: 1, precision: 1, goldLinked: 1 });
  });

  it("has no precision with nothing graded", () => {
    expect(gradedMetrics([{ key: "a", appearances: [app("armA", "p")] }], new Map())[0].precision).toBeNull();
  });
});

describe("the fs half", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("reads full text from findings.jsonl beside the session, an excerpt from the fixture, and round-trips a label", () => {
    dir = mkdtempSync(join(tmpdir(), "labels-test-"));
    const results = join(dir, "eval-results");
    const fixture = join(dir, "fx", "arm1", "prreview__x-1587-r1");
    const checkout = join(fixture, "sandboxes", "task", "repo");
    mkdirSync(join(checkout, ".git"), { recursive: true });
    mkdirSync(join(checkout, "src"), { recursive: true });
    writeFileSync(join(checkout, "src", "a.ts"), Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join("\n"));
    const sessionDir = join(results, "phase-replay", "sessions", "rep", "arm1__prreview__x-1587-r1__r1", "site-001");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, "findings.jsonl"), `${JSON.stringify({ ...base, site: "site-001", consequence: "boom", strength: "read" })}\n`);
    const session = "/data/phase-replay/sessions/rep/arm1__prreview__x-1587-r1__r1/site-001/full.jsonl";
    const report = {
      version: 1,
      kind: "site-review",
      label: "armA",
      cases: [
        {
          instanceId: "prreview__x-1587-r1",
          arm: "arm1",
          fixture,
          repeat: 1,
          gold: [{ severity: "high", summary: "g" }],
          siteReview: {
            sites: [{ id: "site-001", session }],
            findings: [
              { site: "site-001", path: base.path, line: base.line, title: base.title, strength: "read", leads: [], gold: 0 },
              { site: "site-001", path: base.path, line: 5, title: "no text on disk", strength: "read", leads: [] },
            ],
          },
        },
      ],
    };
    writeFileSync(join(results, "phase-replay", "rep.json"), JSON.stringify(report));
    writeFileSync(join(results, "phase-replay", "torn.json"), '{"version":1,');

    const r = buildFindings(results, "now");
    expect(r.unreadable).toBe(1);
    expect(r.findings).toHaveLength(1);
    const f = r.findings[0];
    expect(f).toMatchObject({ pr: "prreview__x-1587", consequence: "boom", key: labelKey(base) });
    expect(f.appearances[0]).toMatchObject({ reportLabel: "armA", judgeGold: 0, session });
    expect(f.excerpt).toEqual({ startLine: 62, lines: Array.from({ length: 17 }, (_, i) => `line ${62 + i}`) });

    const file = labelsFilePath(results);
    appendLabel(file, { key: f.key, real: "no", importance: null, gold: null, note: null }, f);
    appendLabel(file, { key: f.key, real: "yes", importance: "nit", gold: null, note: "n" }, f);
    expect(readLabels(file).get(f.key)).toMatchObject({ real: "yes", importance: "nit", finding: { mechanism: base.mechanism } });
    expect(buildFindings(results, "now").findings[0].label?.importance).toBe("nit");

    // Proposals from every proposals-*.jsonl beside findings.jsonl (one mid-write),
    // attached per finding; the human label and metrics are untouched by them.
    const dirL = join(results, "labels");
    writeFileSync(join(dirL, "proposals-fable.jsonl"), `${JSON.stringify({ key: f.key, real: "no", reason: "r" })}\n{"key":"${f.key}","real":"ye`);
    writeFileSync(join(dirL, "proposals-haiku.jsonl"), `${JSON.stringify({ key: f.key, real: "yes", importance: "nit" })}\n`);
    writeFileSync(join(dirL, "other.jsonl"), `${JSON.stringify({ key: f.key, real: "no", grader: "ghost" })}\n`);
    const r2 = buildFindings(results, "now");
    expect(r2.findings[0].proposals.map((p) => [p.grader, p.real])).toEqual([
      ["fable", "no"],
      ["haiku", "yes"],
    ]);
    expect(r2.findings[0].label).toMatchObject({ real: "yes", importance: "nit" });
    expect(r2.agreement.map((a) => [a.grader, a.n, a.realAgree])).toEqual([
      ["fable", 1, 0],
      ["haiku", 1, 1],
    ]);
    expect(readProposals(join(dir, "missing")).size).toBe(0);
  });
});

const prop = (grader: string, real: Proposal["real"], extra: Partial<Proposal> = {}): Proposal => ({
  grader,
  real,
  importance: null,
  gold: null,
  reason: null,
  gradedAt: null,
  ...extra,
});

describe("proposals", () => {
  it("names the grader from the file, and skips torn / invalid lines", () => {
    expect(graderOfFile("proposals-fable.jsonl")).toBe("fable");
    expect(graderOfFile("findings.jsonl")).toBeNull();
    expect(graderOfFile("proposals-.jsonl")).toBeNull();
    const text = [
      JSON.stringify({ key: "a", real: "yes", importance: "must-fix", gold: { instanceId: "i", index: 1 }, reason: "because", gradedAt: "t" }),
      JSON.stringify({ key: "b", real: "maybe" }),
      JSON.stringify({ key: "c", real: "no", importance: "nit" }),
      JSON.stringify({ key: "d", real: "yes", gold: { instanceId: "i", index: -1 } }),
      JSON.stringify({ key: "e", real: "yes", grader: "other" }),
      '{"key":"f","real":"y',
    ].join("\n");
    const lines = parseProposalLines(text, "fable");
    expect(lines.map((l) => l.key)).toEqual(["a", "c", "e"]);
    expect(lines[0]).toEqual({ key: "a", grader: "fable", real: "yes", importance: "must-fix", gold: { instanceId: "i", index: 1 }, reason: "because", gradedAt: "t" });
    expect(lines[1].importance).toBeNull(); // importance means nothing unless real = yes
    expect(lines[2].grader).toBe("other"); // the line's own grader wins
  });

  it("folds last write per (grader, key); a real:null line removes only that grader's proposal", () => {
    const m = foldProposals(
      parseProposalLines([{ key: "a", real: "no" }, { key: "a", real: "yes" }, { key: "b", real: "no" }, { key: "b", real: null }].map((l) => JSON.stringify(l)).join("\n"), "fable"),
    );
    foldProposals(parseProposalLines(JSON.stringify({ key: "a", real: "unsure" }), "haiku"), m);
    expect(m.get("a")?.get("fable")?.real).toBe("yes");
    expect(m.get("a")?.get("haiku")?.real).toBe("unsure");
    expect(m.get("b")?.size).toBe(0);
  });

  it("never count as human grades: labels, similar and gradedMetrics ignore them", () => {
    const k = labelKey(base);
    const proposals = new Map([[k, new Map([["fable", prop("fable", "yes", { importance: "must-fix" })]])]]);
    const out = dedupFindings([raw(app("armA", "p-r1")), raw(app("armA", "p-r1"), { line: 78, title: "Other" })], new Map(), proposals);
    expect(out[0].proposals.map((p) => p.grader)).toEqual(["fable"]);
    expect(out[0].label).toBeNull();
    expect(out[1].similar).toEqual([]);
    const [m] = gradedMetrics(out, labelsOf(out));
    expect(m).toMatchObject({ findings: 2, graded: 0, real: 0, precision: null });
  });

  it("agree on real, and on importance when both say yes", () => {
    expect(proposalAgrees({ real: "no", importance: null }, prop("g", "no"))).toBe(true);
    expect(proposalAgrees({ real: "yes", importance: "nit" }, prop("g", "yes", { importance: "nit" }))).toBe(true);
    expect(proposalAgrees({ real: "yes", importance: "nit" }, prop("g", "yes", { importance: "must-fix" }))).toBe(false);
    expect(proposalAgrees({ real: "unsure", importance: null }, prop("g", "no"))).toBe(false);
  });
});

describe("agreement", () => {
  it("Cohen's kappa on a hand-computed matrix", () => {
    // n=10, po = 8/10; row/col marginals 5,4,1 → pe = .25+.16+.01 = .42; κ = .38/.58 = 19/29.
    expect(cohenKappa([[4, 1, 0], [1, 3, 0], [0, 0, 1]])).toBeCloseTo(19 / 29, 10);
    expect(cohenKappa([[3, 0, 0], [0, 0, 0], [0, 0, 0]])).toBeNull(); // pe = 1: undefined
    expect(cohenKappa([[0, 0, 0], [0, 0, 0], [0, 0, 0]])).toBeNull();
    expect(cohenKappa([[0, 2, 0], [2, 0, 0], [0, 0, 0]])).toBe(-1);
  });

  it("builds the human × grader confusion matrix over findings carrying both", () => {
    const L = (real: FindingLabel["real"], extra: Partial<FindingLabel> = {}) => lbl("k", real, extra);
    const g = { instanceId: "i", index: 0 };
    const fs = [
      { label: L("yes", { importance: "nit", gold: g }), proposals: [prop("fable", "yes", { importance: "nit", gold: g }), prop("haiku", "no")] },
      { label: L("yes", { importance: "must-fix" }), proposals: [prop("fable", "yes", { importance: "nit", gold: g })] },
      { label: L("no"), proposals: [prop("fable", "yes")] },
      { label: L("unsure"), proposals: [prop("fable", "unsure")] },
      { label: null, proposals: [prop("fable", "no")] }, // no human label: proposed, not paired
      { label: L("no"), proposals: [] },
    ];
    const [fable, haiku] = agreementMetrics(fs);
    expect(fable).toMatchObject({ grader: "fable", proposals: 5, n: 4, realAgree: 3, realAgreeRate: 0.75, bothReal: 2, importanceAgree: 1, goldAgree: 1 });
    expect(fable.confusion).toEqual([
      [2, 0, 0],
      [1, 0, 0],
      [0, 0, 1],
    ]);
    // po = .75; rows 2,1,1 · cols 3,0,1 → pe = (6+0+1)/16; κ = (.75 − 7/16)/(1 − 7/16) = 5/9.
    expect(fable.kappa).toBeCloseTo(5 / 9, 10);
    expect(haiku).toMatchObject({ n: 1, realAgree: 0, bothReal: 0, importanceAgreeRate: null, goldAgreeRate: null });
    expect(haiku.confusion[0]).toEqual([0, 1, 0]);
  });
});
