/**
 * The adjudication dossier — the document that replaces `adjudicate`'s thirty
 * shell calls (#399).
 *
 * The properties under test are the ones that would let the phase silently go
 * back to shelling out, or worse, trust something it should not:
 *
 * - **A quote is verified against the tree, and a bad one says so.** 26 of 54
 *   off-diff demotions in the archive had an `existingCode` matching nothing in
 *   the file it named. If the dossier says VERIFIED when it is not, the model
 *   anchors a comment onto a line that does not exist; if it says nothing, the
 *   `sed -n '<N>p'` calls come straight back.
 * - **The path comes off `quotes[]` before `path`.** 229 of 267 hypotheses in
 *   the measured arm carry the first and only 61 the second, so reading `path`
 *   alone reports three quarters of the corpus as unanchorable — which reads as
 *   a broken pipeline rather than a broken reader.
 * - **The falsify pass's `reason` never appears.** `adjudicate` runs
 *   `fresh_context: true` because agents shown the reasoning behind a false
 *   report fail to reject it 96% of the time. A dossier that leaked that prose
 *   back in would quietly undo the setting.
 * - **`confidence` never appears.** Measured AUROC 0.228 — inverted. It is
 *   deleted from the ranking; re-presenting it at the moment of judgement is
 *   the one place it can still do damage.
 * - **An empty pipeline renders a labelled block, not a short document.** Same
 *   never-empty rule `renderFamilyBlock` has: absence and cleanliness must not
 *   read alike.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { locateExcerpt, pathOfRow, renderAdjudicationDossier } from "../src/adjudicate-render.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  root: string;
  dir: string;
}

/** A repo root with a `.lastlight/pr-review` inside it and one real source file. */
function fixture(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "dossier-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  mkdirSync(join(dir, "probes"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src", "auth.ts"),
    ["export function check(token: string) {", "  if (!token) return null;", "  return verify(token);", "}", ""].join("\n"),
  );
  return { root, dir };
}

function writeHypotheses(f: Fixture, family: string, rows: unknown[]): void {
  writeFileSync(join(f.dir, "hypotheses", `${family}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

const render = (f: Fixture): string => renderAdjudicationDossier({ dir: f.dir, repo: f.root });

describe("locateExcerpt", () => {
  it("finds a re-indented excerpt and reports its line", () => {
    const f = fixture();
    // Leading whitespace differs from the file; `needleOf`/`norm` trim, so this
    // must still resolve — a survey re-indenting a quote is not a fabrication.
    expect(locateExcerpt(f.root, "src/auth.ts", "      if (!token) return null;")).toEqual({ kind: "resolved", line: 2 });
  });

  it("separates the four ways a quote can fail to resolve", () => {
    const f = fixture();
    expect(locateExcerpt(f.root, "src/auth.ts", "if (!user) return null;")).toEqual({ kind: "not-found" });
    expect(locateExcerpt(f.root, "src/gone.ts", "anything")).toEqual({ kind: "no-file" });
    expect(locateExcerpt(f.root, null, "anything")).toEqual({ kind: "no-path" });
    expect(locateExcerpt(f.root, "src/auth.ts", null)).toEqual({ kind: "no-excerpt" });
  });
});

describe("pathOfRow", () => {
  it("prefers quotes[].path, which is what the surveys actually write", () => {
    expect(pathOfRow({ quotes: [{ path: "src/a.ts" }], path: "src/b.ts" })).toBe("src/a.ts");
    expect(pathOfRow({ path: "src/b.ts" })).toBe("src/b.ts");
    expect(pathOfRow({ file: "src/c.ts" })).toBe("src/c.ts");
    expect(pathOfRow({ claim: "no location at all" })).toBeNull();
  });
});

describe("renderAdjudicationDossier", () => {
  it("verifies a quote against the tree and names the line", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [
      {
        claim: "the token guard returns null instead of throwing",
        quotes: [{ path: "src/auth.ts", line: 99, text: "if (!token) return null;" }],
        existingCode: "  if (!token) return null;",
      },
    ]);
    const out = render(f);
    expect(out).toContain("quote VERIFIED — src/auth.ts:2");
    // The survey claimed line 99. The disagreement is stated, not silently
    // corrected — the survey's line number is evidence too.
    expect(out).toContain("(the survey said :99)");
  });

  it("says plainly when an excerpt matches nothing in the file it names", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [
      {
        claim: "prose where a quote goes",
        quotes: [{ path: "src/auth.ts", text: "Lines 1-4 declare the check function" }],
        existingCode: "Lines 1-4 declare the check function",
      },
    ]);
    const out = render(f);
    expect(out).toContain("quote NOT FOUND in src/auth.ts");
    expect(out).toContain("1 carry an excerpt that matches nothing in the file it names");
  });

  it("inlines a probe's verdict, command and transcript — and not its reason", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [{ id: "contract-001", claim: "c", needsProbe: true }]);
    writeFileSync(join(f.dir, "probes", "contract-001.txt"), "node -e 'check()'\nnull\n");
    writeFileSync(
      join(f.dir, "probes", "verdicts.jsonl"),
      JSON.stringify({
        hypothesis: "contract-001",
        verdict: "refuted",
        transcript: "probes/contract-001.txt",
        command: "node -e 'check()'",
        reason: "THE FALSIFY PASS ARGUING FOR ITSELF",
      }) + "\n",
    );
    const out = render(f);
    expect(out).toContain("**Probe.** `refuted`");
    expect(out).toContain("node -e 'check()'");
    expect(out).toContain("null");
    expect(out).not.toContain("THE FALSIFY PASS ARGUING FOR ITSELF");
  });

  it("calls out a verdict whose transcript is not on disk", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [{ id: "contract-001", claim: "c", needsProbe: true }]);
    writeFileSync(
      join(f.dir, "probes", "verdicts.jsonl"),
      JSON.stringify({ hypothesis: "contract-001", verdict: "refuted", transcript: "probes/missing.txt", command: "x" }) + "\n",
    );
    expect(render(f)).toContain("is NOT ON DISK");
  });

  it("truncates a runaway transcript and says where the rest is", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [{ id: "contract-001", claim: "c", needsProbe: true }]);
    writeFileSync(join(f.dir, "probes", "contract-001.txt"), "cmd\n" + "x".repeat(5_000));
    writeFileSync(
      join(f.dir, "probes", "verdicts.jsonl"),
      JSON.stringify({ hypothesis: "contract-001", verdict: "reproduced", transcript: "probes/contract-001.txt", command: "cmd" }) + "\n",
    );
    const out = renderAdjudicationDossier({ dir: f.dir, repo: f.root, transcriptChars: 100 });
    expect(out).toContain("(truncated — the full transcript is at `probes/contract-001.txt`)");
    expect(out).not.toContain("x".repeat(200));
  });

  it("never carries confidence, from a hypothesis or a finding", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [{ claim: "c", confidence: 0.97, quotes: [{ path: "src/auth.ts", text: "return verify(token);" }] }]);
    writeFileSync(
      join(f.dir, "findings.json"),
      JSON.stringify({ findings: [{ title: "t", path: "src/auth.ts", severity: "Important", confidence: 0.42, existingCode: "return verify(token);" }] }),
    );
    const out = render(f);
    expect(out).not.toContain("0.97");
    expect(out).not.toContain("0.42");
    expect(out.toLowerCase()).not.toContain("confidence: ");
  });

  it("carries the review pass's findings, with their anchors checked", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [{ id: "contract-001", claim: "c" }]);
    writeFileSync(
      join(f.dir, "findings.json"),
      JSON.stringify({
        findings: [
          { title: "real anchor", path: "src/auth.ts", existingCode: "return verify(token);", hypotheses: ["contract-001"] },
          { title: "bad anchor", path: "src/auth.ts", existingCode: "return verify(session);" },
        ],
      }),
    );
    const out = render(f);
    expect(out).toContain("## What the review pass wrote");
    expect(out).toContain("**real anchor**");
    expect(out).toContain("quote VERIFIED — src/auth.ts:3");
    expect(out).toContain("quote NOT FOUND in src/auth.ts");
    expect(out).toContain("**Cites.** contract-001");
    expect(out).toContain("**Cites.** nothing — this finding has no provenance");
  });

  it("labels an empty pipeline rather than rendering a thin document", () => {
    const f = fixture();
    const out = render(f);
    expect(out).toContain("**NONE.** No survey pass wrote a hypothesis.");
    expect(out).toContain("That is not a clean bill of health");
    expect(out).toContain("`findings.json` does not exist yet");
  });

  it("carries the conservation ledger, uncapped", () => {
    const f = fixture();
    writeHypotheses(
      f,
      "contract",
      Array.from({ length: 25 }, (_, i) => ({ claim: `c${i}` })),
    );
    writeFileSync(join(f.dir, "findings.json"), JSON.stringify({ findings: [] }));
    const out = render(f);
    expect(out).toContain("**25 are not.**");
    // Every outstanding id, not the first twenty: a checklist that elided
    // entries would reproduce the omission it exists to prevent.
    expect(out).toContain("contract-001");
    expect(out).toContain("contract-025");
    expect(out).not.toContain("more");
  });

  it("does not let a fenced excerpt close the document's own fence", () => {
    const f = fixture();
    writeHypotheses(f, "contract", [{ claim: "c", quotes: [{ path: "src/auth.ts", text: "```\nnested\n```" }] }]);
    const out = render(f);
    expect(out).toContain("````");
  });

  it("reports unparseable JSONL rather than quietly dropping it", () => {
    const f = fixture();
    writeFileSync(join(f.dir, "hypotheses", "contract.jsonl"), '{"claim":"ok"}\nnot json at all\n');
    expect(render(f)).toContain("1 line(s) in the pipeline's JSONL could not be parsed");
  });
});
