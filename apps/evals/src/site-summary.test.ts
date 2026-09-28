import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHypothesisSet, type HypothesisSet, type Site } from "lastlight-code-facts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Completion } from "./judge.js";
import { checkSiteFindings } from "./site-review.js";
import {
  maxConcernsFor,
  UNMERGED_CONCERN,
  siteBriefFor,
  siteSummaryRows,
  summariseSite,
  retryInput,
  summaryCacheKey,
  validateSiteSummary,
  type SiteSummary,
  type SummaryRow,
} from "./site-summary.js";

const IDS = ["a-001", "a-002", "b-001"];
const reply = (v: unknown) => JSON.stringify(v);

describe("maxConcernsFor", () => {
  it("scales with the site: min(8, max(2, ceil(rows / 2)))", () => {
    expect([1, 3, 4, 5, 10, 15, 16, 17, 40].map(maxConcernsFor)).toEqual([2, 2, 2, 3, 5, 8, 8, 8, 8]);
  });
});

describe("validateSiteSummary", () => {
  it("accepts a reply putting every row in exactly one concern", () => {
    const v = validateSiteSummary(reply({ concerns: [{ concern: "x", line: 4, rows: ["a-001", "b-001"], specific: "b-001" }, { concern: "y", rows: ["a-002"] }] }), IDS);
    expect(v).toEqual({
      ok: true,
      summary: {
        concerns: [
          { concern: "x", line: 4, rows: ["a-001", "b-001"], specific: "b-001" },
          { concern: "y", line: null, rows: ["a-002"], specific: "a-002" },
        ],
        uncovered: [],
        maxConcerns: 2,
      },
    });
  });

  it("collects rows cited nowhere (a `noise` key included) into a synthetic unmerged concern, never dropping one", () => {
    const v = validateSiteSummary(reply({ concerns: [{ concern: "x", rows: ["a-001"] }], noise: ["a-002"] }), IDS);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.summary.uncovered).toEqual(["a-002", "b-001"]);
    expect(v.summary.concerns.at(-1)).toEqual({ concern: UNMERGED_CONCERN, line: null, rows: ["a-002", "b-001"], specific: null, unmerged: true });
    expect(v.summary.concerns.flatMap((c) => c.rows).sort()).toEqual([...IDS].sort());
  });

  it("tolerates a fenced reply", () => {
    expect(validateSiteSummary("```json\n" + reply({ concerns: [{ concern: "x", rows: IDS }] }) + "\n```", IDS).ok).toBe(true);
  });

  it("holds the reply to the site's cap (the synthetic concern is beyond it)", () => {
    const three = reply({ concerns: IDS.map((id) => ({ concern: id, rows: [id] })) });
    expect(validateSiteSummary(three, IDS).ok).toBe(false); // 3 rows → cap 2
    expect(validateSiteSummary(three, IDS, 3).ok).toBe(true);
    const two = reply({ concerns: [{ concern: "x", rows: ["a-001"] }, { concern: "y", rows: ["a-002"] }] });
    const v = validateSiteSummary(two, IDS);
    expect(v.ok && v.summary.concerns).toHaveLength(3);
  });

  it.each([
    ["not JSON", "no json here"],
    ["a row in two concerns", reply({ concerns: [{ concern: "x", rows: ["a-001"] }, { concern: "y", rows: ["a-001"] }] })],
    ["a duplicate within one concern", reply({ concerns: [{ concern: "x", rows: ["a-001", "a-001"] }] })],
    ["a foreign id", reply({ concerns: [{ concern: "x", rows: ["z-009"] }] })],
    ["a `specific` outside its concern", reply({ concerns: [{ concern: "x", rows: ["a-001"], specific: "a-002" }] })],
    ["a concern with no rows", reply({ concerns: [{ concern: "x", rows: [] }] })],
    ["a concern with no text", reply({ concerns: [{ concern: " ", rows: ["a-001"] }] })],
    ["concerns not an array", reply({ concerns: "x" })],
  ])("rejects %s", (_name, text) => {
    expect(validateSiteSummary(text, IDS).ok).toBe(false);
  });
});

const ROWS: SummaryRow[] = [{ id: "a-001", family: "a", line: 3, claim: "c", subject: "s", consequence: null, cannot_distinguish: null }];

describe("summaryCacheKey", () => {
  it("is stable for the same inputs and changes with model, prompt or rows", () => {
    const k = summaryCacheKey("m", "p", ROWS);
    expect(summaryCacheKey("m", "p", structuredClone(ROWS))).toBe(k);
    expect(summaryCacheKey("m2", "p", ROWS)).not.toBe(k);
    expect(summaryCacheKey("m", "p2", ROWS)).not.toBe(k);
    expect(summaryCacheKey("m", "p", [{ ...ROWS[0], line: 4 }])).not.toBe(k);
  });
});

describe("summariseSite", () => {
  let cacheDir: string;
  beforeEach(() => (cacheDir = mkdtempSync(join(tmpdir(), "site-summary-"))));
  afterEach(() => rmSync(cacheDir, { recursive: true, force: true }));

  const site = { id: "site-001", path: "src/a.ts", startLine: 1, endLine: 9 };
  const scripted = (texts: string[]) => {
    const calls: string[] = [];
    const users: string[] = [];
    const call = async (_m: string, _s: string, user: string): Promise<Completion> => {
      const text = texts[calls.length] ?? "";
      calls.push(text);
      users.push(user);
      return { text, inputTokens: 1000, outputTokens: 100 };
    };
    return { call, calls, users };
  };
  const good = reply({ concerns: [{ concern: "x", line: 3, rows: ["a-001"] }] });

  it("calls once, then serves the repeat from the cache for free", async () => {
    const first = scripted([good]);
    const r1 = await summariseSite({ model: "anthropic/claude-haiku-4-5", prompt: "p", site, rows: ROWS, cacheDir, call: first.call });
    expect(r1).toMatchObject({ fallback: false, attempts: 1, cached: false, outputTokens: 100 });
    expect(r1.costUsd).toBeCloseTo(0.0015);
    const again = scripted([]);
    const r2 = await summariseSite({ model: "anthropic/claude-haiku-4-5", prompt: "p", site, rows: ROWS, cacheDir, call: again.call });
    expect(again.calls).toHaveLength(0);
    expect(r2).toMatchObject({ cached: true, summary: r1.summary });
    expect(readdirSync(cacheDir)).toHaveLength(1);
  });

  it("retries a malformed reply once, feeding back the rejection", async () => {
    const s = scripted(["garbage", good]);
    const r = await summariseSite({ model: "m", prompt: "p", site, rows: ROWS, cacheDir, call: s.call });
    expect(r).toMatchObject({ fallback: false, attempts: 2, costUsd: null });
    expect(r.errors).toHaveLength(1);
    expect(s.users[1]).toBe(retryInput(s.users[0], r.errors[0]));
    // Both replies are cached: a repeat spends nothing.
    const again = scripted([]);
    expect(await summariseSite({ model: "m", prompt: "p", site, rows: ROWS, cacheDir, call: again.call })).toMatchObject({ cached: true, fallback: false });
    expect(again.calls).toHaveLength(0);
  });

  it("falls back after two malformed replies", async () => {
    const s = scripted(["garbage", reply({ concerns: [{ concern: "x", rows: ["nope"] }] })]);
    const r = await summariseSite({ model: "m", prompt: "p", site, rows: ROWS, cacheDir, call: s.call });
    expect(r).toMatchObject({ fallback: true, summary: null, attempts: 2 });
    expect(s.calls).toHaveLength(2);
  });

  it("counts a provider error as an attempt and never caches it", async () => {
    let n = 0;
    const call = async (): Promise<Completion> => {
      if (n++ === 0) throw new Error("HTTP 529");
      return { text: good, inputTokens: 1, outputTokens: 1 };
    };
    const r = await summariseSite({ model: "m", prompt: "p", site, rows: ROWS, cacheDir, call });
    expect(r).toMatchObject({ fallback: false, attempts: 2 });
  });
});

describe("siteBriefFor", () => {
  let dir: string;
  let set: HypothesisSet;
  let site: Pick<Site, "id" | "path" | "startLine" | "endLine" | "support" | "voters" | "rows">;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "site-brief-"));
    mkdirSync(join(dir, "hypotheses"));
    const row = (subject: string, line: number) => JSON.stringify({ claim: "c", quotes: [{ path: "src/a.ts", line, text: "x" }], evidence: { subject } });
    writeFileSync(join(dir, "hypotheses", "a.jsonl"), [row("s1", 3), row("s2", 5), row("s3", 7)].join("\n") + "\n");
    set = readHypothesisSet(dir);
    site = { id: "site-001", path: "src/a.ts", startLine: 3, endLine: 7, support: 3, voters: 2, rows: set.records.map((r) => r.id) };
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("projects the site's rows with their anchor lines", () => {
    expect(siteSummaryRows(site, set).map((r) => [r.id, r.line, r.subject])).toEqual([
      ["a-001", 3, "s1"],
      ["a-002", 5, "s2"],
      ["a-003", 7, "s3"],
    ]);
  });

  it("numbers the concerns 1..n and bounds the gate's lead numbers by n", () => {
    const summary: SiteSummary = {
      concerns: [
        { concern: "first", line: 3, rows: ["a-001", "a-002"], specific: "a-002" },
        { concern: "second", line: null, rows: ["a-003"], specific: "a-003" },
      ],
      uncovered: [],
      maxConcerns: 2,
    };
    const { brief, leadCount } = siteBriefFor("summary", site, set, summary);
    expect(leadCount).toBe(2);
    expect(brief.match(/^\d+\. /gm)).toEqual(["1. ", "2. "]);

    const repo = mkdtempSync(join(tmpdir(), "site-brief-repo-"));
    try {
      const prDir = join(repo, ".lastlight", "pr-review");
      mkdirSync(join(prDir, "sites"), { recursive: true });
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src", "a.ts"), "1\n2\n3\n");
      const write = (leads: number[]) =>
        writeFileSync(
          join(prDir, "sites", "site-001.findings.jsonl"),
          JSON.stringify({ site: "site-001", path: "src/a.ts", line: 1, title: "t", mechanism: "m", consequence: "c", strength: "read", leads }) + "\n",
        );
      write([2]);
      expect(checkSiteFindings({ prDir, repo, siteId: "site-001", leadCount }).satisfied).toBe(true);
      write([3]);
      expect(checkSiteFindings({ prDir, repo, siteId: "site-001", leadCount }).gaps.map((g) => g.kind)).toEqual(["bad-leads"]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("carries each concern's specific row's subject verbatim, and the unmerged rows' subjects", () => {
    const summary: SiteSummary = {
      concerns: [
        { concern: "broad", line: 3, rows: ["a-001", "a-002"], specific: "a-002" },
        { concern: UNMERGED_CONCERN, line: null, rows: ["a-003"], specific: null, unmerged: true },
      ],
      uncovered: ["a-003"],
      maxConcerns: 2,
    };
    const { brief } = siteBriefFor("summary", site, set, summary);
    const [first, second] = brief.split(/^2\. /m);
    expect(first).toContain("s2");
    expect(first).not.toContain("s1");
    expect(second).toContain("s3");
  });

  it("falls back to the subject leads (and their count) when the summary is null", () => {
    const { leadCount } = siteBriefFor("summary", site, set, null);
    expect(leadCount).toBe(3);
    expect(siteBriefFor("none", site, set, null).leadCount).toBe(0);
  });
});
