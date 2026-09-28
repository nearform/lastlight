import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { checkSiteFindings, findingsAsJudgeFindings, isExecutionCommand, noneChecksRequired, renderGateFeedback } from "./site-review.js";

let repo: string;
let prDir: string;
const SITE = "site-001";

const write = (lines: unknown[]) =>
  writeFileSync(join(prDir, "sites", `${SITE}.findings.jsonl`), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");

const finding = (over: Record<string, unknown> = {}) => ({
  site: SITE,
  path: "src/a.ts",
  line: 2,
  title: "t",
  mechanism: "m",
  consequence: "c",
  strength: "read",
  command: null,
  transcript: null,
  leads: [],
  ...over,
});

const kinds = () => checkSiteFindings({ prDir, repo, siteId: SITE, leadCount: 2 }).gaps.map((g) => g.kind);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "site-review-"));
  prDir = join(repo, ".lastlight", "pr-review");
  mkdirSync(join(prDir, "sites", SITE), { recursive: true });
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "a.ts"), "one\ntwo\nthree\n");
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

describe("checkSiteFindings", () => {
  it("fails when the file was never written", () => {
    const r = checkSiteFindings({ prDir, repo, siteId: SITE });
    expect(r.satisfied).toBe(false);
    expect(r.gaps.map((g) => g.kind)).toEqual(["missing-file"]);
  });

  /** A `checked` entry whose transcript exists and echoes `command`. */
  const check = (name: string, command: string) => {
    const transcript = `.lastlight/pr-review/sites/${SITE}/${name}.txt`;
    writeFileSync(join(repo, transcript), `$ ${command}\nout\n`);
    return { suspicion: `s-${name}`, command, transcript, outcome: "ruled out" };
  };
  const none = (checked: unknown[]) => ({ site: SITE, none: true, reason: "nothing", checked });

  it("passes an earned `none` line, and refuses one mixed with findings", () => {
    write([none([check("N1", "node probe.mjs"), check("N2", "grep -n x src/a.ts")])]);
    const ok = checkSiteFindings({ prDir, repo, siteId: SITE, siteRows: 8 });
    expect(ok).toMatchObject({ satisfied: true, none: true, findings: [] });
    write([none([check("N1", "node probe.mjs"), check("N2", "grep -n x src/a.ts")]), finding()]);
    expect(kinds()).toContain("none-mixed");
  });

  it("scales the checks a `none` needs by site size: 1 on a ≤ 3-row site, else 2 (unknown size → 2)", () => {
    expect([1, 3, 4, 20].map(noneChecksRequired)).toEqual([1, 1, 2, 2]);
    write([none([check("N1", "node probe.mjs")])]);
    expect(checkSiteFindings({ prDir, repo, siteId: SITE, siteRows: 3 }).satisfied).toBe(true);
    expect(checkSiteFindings({ prDir, repo, siteId: SITE, siteRows: 4 }).gaps.map((g) => g.kind)).toEqual(["none-few-checks"]);
    expect(kinds()).toEqual(["none-few-checks"]);
    write([{ site: SITE, none: true, reason: "nothing" }]);
    expect(checkSiteFindings({ prDir, repo, siteId: SITE, siteRows: 1 }).gaps.map((g) => g.kind)).toEqual(["none-few-checks"]);
  });

  it("refuses a `none` whose every check only reads code", () => {
    write([none([check("N1", "grep -rn pendingRaw src"), check("N2", "sed -n 1,40p src/a.ts | cat")])]);
    expect(checkSiteFindings({ prDir, repo, siteId: SITE, siteRows: 8 }).gaps.map((g) => g.kind)).toEqual(["none-no-execution"]);
    write([none([check("N1", "grep -rn pendingRaw src"), check("N2", "git show origin/main:src/a.ts")])]);
    expect(checkSiteFindings({ prDir, repo, siteId: SITE, siteRows: 8 }).satisfied).toBe(true);
  });

  it("holds each `none` check to a complete record and a transcript that echoes its command", () => {
    const bad = check("N2", "node other.mjs");
    writeFileSync(join(repo, bad.transcript), "$ node something-else.mjs\n");
    write([none([check("N1", "node probe.mjs"), { suspicion: "s" }, { ...check("N3", "node x.mjs"), transcript: "missing.txt" }, bad])]);
    expect(checkSiteFindings({ prDir, repo, siteId: SITE, siteRows: 8 }).gaps.map((g) => g.kind)).toEqual([
      "check-missing-field",
      "no-transcript",
      "transcript-command",
      "none-few-checks",
    ]);
  });

  it("classifies executions with falsify's read classifier, and never counts a read- or echo-only command", () => {
    for (const c of ["node probe.mjs", "cd x && node -e 'JSON.parse(\"{\")'", "git show origin/main:src/a.ts", "BASE: git show origin/main:a HEAD: cat a", "node p.mjs | grep FAIL"])
      expect(isExecutionCommand(c)).toBe(true);
    for (const c of ["grep -rn x src", "sed -n 1,20p a.ts | wc -l", "lastlight-facts refs foo", "lastlight facts refs foo", "echo ok", "cd src && ls"])
      expect(isExecutionCommand(c)).toBe(false);
  });

  it("passes 1–3 grounded `read` findings and refuses a fourth", () => {
    write([finding(), finding({ line: 3 })]);
    const r = checkSiteFindings({ prDir, repo, siteId: SITE });
    expect(r.satisfied).toBe(true);
    expect(r.findings).toHaveLength(2);
    write([finding(), finding(), finding(), finding()]);
    expect(kinds()).toEqual(["too-many"]);
  });

  it("rejects a malformed line, a missing path, a line past the end of the file and a path outside the checkout", () => {
    write(["{nope", finding({ path: "src/missing.ts" }), finding({ line: 4 }), finding({ path: "../outside.ts" })]);
    writeFileSync(join(repo, "..", "outside.ts"), "x\n");
    try {
      const k = kinds();
      expect(k).toEqual(expect.arrayContaining(["malformed-line", "path-missing", "line-out-of-range"]));
      write([finding({ path: "../outside.ts", line: 1 })]);
      expect(kinds()).toEqual(["path-outside"]);
    } finally {
      rmSync(join(repo, "..", "outside.ts"), { force: true });
    }
  });

  it("requires a transcript whose first line echoes `command` for reproduced / corroborated", () => {
    const t = `.lastlight/pr-review/sites/${SITE}/F1.txt`;
    write([finding({ strength: "reproduced", command: "node probe.mjs", transcript: t })]);
    expect(kinds()).toEqual(["no-transcript"]);
    writeFileSync(join(repo, t), "$ node other.mjs\nout\n");
    expect(kinds()).toEqual(["transcript-command"]);
    writeFileSync(join(repo, t), "$ node probe.mjs\nout\n");
    expect(checkSiteFindings({ prDir, repo, siteId: SITE }).satisfied).toBe(true);
  });

  it("bounds lead numbers by the brief's lead count and checks the strength vocabulary", () => {
    write([finding({ leads: [3], strength: "proven" })]);
    expect(kinds()).toEqual(expect.arrayContaining(["bad-leads", "bad-strength"]));
  });

  it("renders the gaps as a feedback section and projects findings for the judge", () => {
    const text = renderGateFeedback([{ kind: "too-many", detail: "4 findings" }], "x.jsonl");
    expect(text).toContain("`too-many`");
    expect(text).toContain("4 findings");
    expect(findingsAsJudgeFindings([finding() as never])).toEqual([{ description: expect.stringContaining("src/a.ts:2"), file: "src/a.ts" }]);
  });
});
