/**
 * `probes` — the `falsify` loop's exit gate.
 *
 * Two properties carry the whole file, and both are things this codebase has
 * already been burned by:
 *
 * **It must be SATISFIABLE, honestly.** WP3's first design gated six survey
 * passes on `hypotheses/$LL_FAMILY.jsonl` with a variable that was never set, so
 * the gate tested `hypotheses/.jsonl`, always failed, and the loop ran to
 * `max_iterations` against a condition that meant nothing. A gate a pass cannot
 * close is worse than no gate: it burns the budget AND teaches nothing.
 *
 * **It must not accept a refutation by argument.** *"You may add evidence and
 * lower confidence; you may not drop a hypothesis without a counter-transcript"*
 * is the rule with money on it — the intervention that raised precision
 * 54.5 → 67.1 and cut recall 45.5 → 39.8 is exactly a verifier that deletes on
 * reasoning. So a `refuted` verdict naming a transcript that does not exist is a
 * gap, not a pass.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkProbes, renderProbeCheck, requiresProbe } from "../src/probes.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  /** `<root>/.lastlight/pr-review`. */
  dir: string;
  root: string;
}

/** A `.lastlight/pr-review` tree, laid out exactly as the phases write it. */
function workspace(files: {
  hypotheses?: Record<string, unknown[] | string>;
  verdicts?: unknown[] | string;
  transcripts?: string[];
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ll-probes-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  mkdirSync(join(dir, "probes"), { recursive: true });

  for (const [family, rows] of Object.entries(files.hypotheses ?? {})) {
    const body = typeof rows === "string" ? rows : rows.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), `${body}\n`, "utf8");
  }
  if (files.verdicts !== undefined) {
    const body =
      typeof files.verdicts === "string"
        ? files.verdicts
        : files.verdicts.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(join(dir, "probes", "verdicts.jsonl"), `${body}\n`, "utf8");
  }
  for (const name of files.transcripts ?? []) {
    writeFileSync(join(dir, "probes", name), "npx eslint probe.js\n  1:1 error …\n", "utf8");
  }
  return { dir, root };
}

const critical = { id: "H-001", severity: "Critical", needsProbe: false };
const asked = { id: "H-002", severity: "Minor", needsProbe: true };
const neither = { id: "H-003", severity: "Minor", needsProbe: false };

describe("what has to be probed", () => {
  it("takes the survey's own request", () => {
    expect(requiresProbe({ needsProbe: true, severity: "Minor" })).toBe(true);
  });

  it("takes every Critical whether it asked or not", () => {
    // The case this whole pipeline exists for was a Critical the reviewer talked
    // itself out of while standing at the defect site. A Critical nobody tried
    // to run must not survive silently.
    expect(requiresProbe({ needsProbe: false, severity: "Critical" })).toBe(true);
    expect(requiresProbe({ severity: "critical" })).toBe(true);
  });

  it("leaves everything else alone", () => {
    expect(requiresProbe({ needsProbe: false, severity: "Important" })).toBe(false);
    expect(requiresProbe({})).toBe(false);
  });

  it("collects across every family file, since no pass sees another's", () => {
    const { dir } = workspace({
      hypotheses: { contract: [critical, neither], security: [asked] },
    });
    expect(checkProbes({ dir }).required).toEqual(["contract-001", "security-001"]);
  });
});

describe("the gate is satisfiable — honestly, in one pass", () => {
  it("closes on `unprobed` with no transcript at all", () => {
    // The load-bearing case. A hypothesis that genuinely cannot be executed
    // against — no runner, no dependencies, no toolchain for the language — has
    // to have an honest way to close the gate, or the pass is pushed towards a
    // dishonest one.
    const { dir } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [{ hypothesis: "H-001", verdict: "unprobed", reason: "no dependencies installed" }],
    });
    const result = checkProbes({ dir });
    expect(result.satisfied).toBe(true);
    expect(result.byVerdict).toEqual({ unprobed: 1 });
  });

  it("closes when nothing needed probing", () => {
    const { dir } = workspace({ hypotheses: { contract: [neither] } });
    const result = checkProbes({ dir });
    expect(result.satisfied).toBe(true);
    expect(result.notes.join(" ")).toMatch(/nothing to run/);
  });

  it("does NOT close on a hypothesis nobody answered", () => {
    const { dir } = workspace({ hypotheses: { contract: [critical, asked] }, verdicts: [] });
    const result = checkProbes({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.gaps.map((g) => g.hypothesis)).toEqual(["contract-001", "contract-002"]);
    expect(result.gaps.every((g) => g.kind === "no-verdict")).toBe(true);
  });

  it("says so when the surveys produced nothing at all", () => {
    // Vacuously satisfied, and that must not read as "the probes came back
    // clean" — there was nothing to probe because the pass upstream never ran.
    const { dir } = workspace({});
    const result = checkProbes({ dir });
    expect(result.satisfied).toBe(true);
    expect(result.notes.join(" ")).toMatch(/did not run.*NOT a clean probe result/);
  });
});

describe("only a transcript may refute", () => {
  it("accepts `refuted` when the transcript exists", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [
        {
          hypothesis: "H-001",
          verdict: "refuted",
          transcript: ".lastlight/pr-review/probes/H-001.txt",
        },
      ],
      transcripts: ["H-001.txt"],
    });
    expect(checkProbes({ dir, repo: root }).satisfied).toBe(true);
  });

  it("rejects `refuted` with no transcript — the rule with money on it", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [{ hypothesis: "H-001", verdict: "refuted", reason: "on reflection, fine" }],
    });
    const result = checkProbes({ dir, repo: root });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0].kind).toBe("no-transcript");
    expect(result.gaps[0].detail).toMatch(/only a transcript may refute/);
  });

  it("rejects `refuted` naming a transcript that was never written", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [
        {
          hypothesis: "H-001",
          verdict: "refuted",
          transcript: ".lastlight/pr-review/probes/H-001.txt",
        },
      ],
    });
    expect(checkProbes({ dir, repo: root }).satisfied).toBe(false);
  });

  it("holds `reproduced` to the same bar", () => {
    // Symmetry matters: an unbacked `reproduced` would put a fabricated
    // transcript-free "we ran it and it broke" in front of the adjudicator,
    // which is the mirror image of the same failure.
    const { dir, root } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [{ hypothesis: "H-001", verdict: "reproduced" }],
    });
    expect(checkProbes({ dir, repo: root }).satisfied).toBe(false);
  });

  it("does NOT demand a transcript for `unprobed`", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [{ hypothesis: "H-001", verdict: "unprobed", transcript: null }],
    });
    expect(checkProbes({ dir, repo: root }).satisfied).toBe(true);
  });

  it("resolves a transcript path relative to the repo OR to the pr-review dir", () => {
    // The prompt asks for a repo-relative path. A pass that writes
    // `probes/H-001.txt` is being helpful, not wrong, and failing the gate over
    // a path convention would cost a round of probing for nothing.
    const { dir, root } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [{ hypothesis: "H-001", verdict: "refuted", transcript: "probes/H-001.txt" }],
      transcripts: ["H-001.txt"],
    });
    expect(checkProbes({ dir, repo: root }).satisfied).toBe(true);
  });
});

describe("the file is append-only, so the LAST line wins", () => {
  it("lets a second round revise a verdict by appending", () => {
    // `max_iterations: 2`. Round 1 could not run it; round 2 installed something
    // and could. Rewriting the file would be an edit to an append-only artifact,
    // so the newest line is the answer.
    const { dir, root } = workspace({
      hypotheses: { contract: [critical] },
      verdicts: [
        { hypothesis: "H-001", verdict: "unprobed", reason: "no runner" },
        { hypothesis: "H-001", verdict: "refuted", transcript: "probes/H-001.txt" },
      ],
      transcripts: ["H-001.txt"],
    });
    const result = checkProbes({ dir, repo: root });
    expect(result.satisfied).toBe(true);
    expect(result.byVerdict).toEqual({ refuted: 1 });
  });
});

describe("malformed input is counted, never silently skipped", () => {
  it("keeps reading past a bad line and says how many it dropped", () => {
    const { dir } = workspace({
      hypotheses: { contract: `${JSON.stringify(critical)}\nnot json at all\n` },
      verdicts: [{ hypothesis: "H-001", verdict: "unprobed" }],
    });
    const result = checkProbes({ dir });
    expect(result.malformed).toBe(1);
    expect(result.notes.join(" ")).toMatch(/1 unparseable JSONL line/);
    // …and the good line still counted.
    expect(result.required).toEqual(["contract-001"]);
  });
});

describe("the summary a phase log actually shows", () => {
  it("names the count, the verdict mix and each gap", () => {
    const { dir } = workspace({
      hypotheses: { contract: [critical, asked] },
      verdicts: [{ hypothesis: "H-002", verdict: "unprobed" }],
    });
    const text = renderProbeCheck(checkProbes({ dir }));
    expect(text).toContain("1/2 required hypotheses answered");
    expect(text).toContain("unprobed=1");
    expect(text).toContain("contract-001");
  });
});
