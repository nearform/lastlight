/**
 * `findings` — the `adjudicate` loop's exit gate, and the conservation check.
 *
 * The property under test is the one §D11 says nothing in the plan enforced:
 * **an adjudicator that reads thirty hypotheses and writes six findings must not
 * pass.** That is v2, which *"worked mechanically"* and cost recall anyway, and
 * it passed every existence-plus-schema gate this plan had. So every test here
 * is about a hypothesis id and where it went — not about whether the document
 * parses.
 *
 * Three of them carry money directly:
 *
 * - **A drop with no transcript fails.** *"You may add evidence and lower
 *   confidence; you may not drop a hypothesis without a counter-transcript."*
 *   A refutation by argument is exactly the intervention that raised precision
 *   54.5 → 67.1 and cut recall 45.5 → 39.8.
 * - **A finding with no `hypotheses` field fails nothing.** Those are the
 *   shipped reviewer's own findings; a gate that demanded provenance from them
 *   would delete the reviewer we already have.
 * - **No hypothesis files at all passes.** The gate must never fail a run for
 *   the absence of the thing it audits — the pipeline being off is not a
 *   finding.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli.js";
import { EXIT_DEGRADED, EXIT_OK } from "../src/errors.js";
import {
  buildFindingsLedger,
  checkFindings,
  renderFindingsCheck,
  renderFindingsLedger,
  titleFrom,
} from "../src/findings.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
  /** `<root>/.lastlight/pr-review`. */
  dir: string;
  root: string;
  /** The document as it is on disk right now. */
  read(): Record<string, unknown>;
}

/** A `.lastlight/pr-review` tree, laid out exactly as the phases write it. */
function workspace(files: {
  hypotheses?: Record<string, unknown[] | string>;
  /** Omit entirely to leave `findings.json` absent. A string is written raw. */
  findings?: Record<string, unknown> | string;
  transcripts?: string[];
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ll-findings-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  mkdirSync(join(dir, "probes"), { recursive: true });

  for (const [family, rows] of Object.entries(files.hypotheses ?? {})) {
    const body = typeof rows === "string" ? rows : rows.map((r) => JSON.stringify(r)).join("\n");
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), `${body}\n`, "utf8");
  }
  if (files.findings !== undefined) {
    const body =
      typeof files.findings === "string" ? files.findings : JSON.stringify(files.findings, null, 2);
    writeFileSync(join(dir, "findings.json"), `${body}\n`, "utf8");
  }
  for (const name of files.transcripts ?? []) {
    writeFileSync(join(dir, "probes", name), "npx vitest run probe.test.ts\n  1 failed\n", "utf8");
  }
  return {
    dir,
    root,
    read: () => JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as Record<
      string,
      unknown
    >,
  };
}

const H1 = {
  id: "H-001",
  obligation: "O-014",
  family: "contract",
  claim: "Token expiry is set on the client and never checked server-side; a stale token is accepted.",
  bothEnds: { introducedAt: "src/config.ts:12", enforcedAt: null },
  existingCode: "const MAX_TOKEN_AGE = 3600;",
  severity: "Critical",
  confidence: 0.82,
};
const H2 = {
  id: "H-002",
  obligation: "O-015",
  family: "enforcement",
  claim: "The new rate-limit branch is unreachable from the router.",
  severity: "Important",
  confidence: 0.4,
};
const H3 = { id: "H-003", obligation: "O-016", family: "tests", claim: "No test covers the new path." };

/** A finding that discharges the given hypotheses. */
function finding(ids: string[], extra: Record<string, unknown> = {}) {
  return {
    path: "src/auth.ts",
    existingCode: "if (token) return ok;",
    severity: "Critical",
    title: "Token expiry is never enforced",
    body: "A stale token is accepted.",
    tier: "inline",
    hypotheses: ids,
    ...extra,
  };
}

const doc = (over: Record<string, unknown> = {}) => ({
  skip: false,
  summary: "Adds auth.",
  event: "COMMENT",
  findings: [],
  ...over,
});

// ── Rule 1–3: exactly one disposition, each way it can break ────────────────

describe("every hypothesis has exactly one disposition", () => {
  it("closes when each id appears once, across every family file", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({ findings: [finding(["H-001"]), finding(["H-002"], { tier: "body" })] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(true);
    expect(result.hypotheses).toEqual(["contract-001", "enforcement-001"]);
    expect(result.covered).toEqual(["contract-001", "enforcement-001"]);
  });

  it("closes when ONE finding discharges several — dedup across families", () => {
    // §"Its instructions, in order of importance" #1: the same defect surfaces
    // from `contract` and `enforcement` and the two records merge. Conservation
    // is about every id being ACCOUNTED for, not about a finding per id.
    const { dir } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({ findings: [finding(["H-001", "H-002"])] }),
    });
    expect(checkFindings({ dir }).satisfied).toBe(true);
  });

  it("does NOT close on a hypothesis in neither list — the v2 shape", () => {
    // Thirty hypotheses in, six findings out. This is the whole work package.
    const { dir } = workspace({
      hypotheses: { contract: [H1, H2, H3] },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.gaps.map((g) => g.hypothesis)).toEqual(["contract-002", "contract-003"]);
    expect(result.gaps.every((g) => g.kind === "uncovered")).toBe(true);
  });

  it("does NOT close when two findings claim the same id", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: [finding(["H-001"]), finding(["H-001"])] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0].kind).toBe("duplicate");
    expect(result.gaps[0].detail).toMatch(/findings\[0\], findings\[1\]/);
  });

  it("does NOT close when an id is both kept and dropped", () => {
    // Having it both ways is the one disposition that makes internal recall
    // uncomputable, which is what WP8 needs this gate for.
    const { dir, root } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({
        findings: [finding(["H-001"])],
        dropped: [{ hypothesis: "H-001", refutedBy: "probes/H-001.txt" }],
      }),
      transcripts: ["H-001.txt"],
    });
    const result = checkFindings({ dir, repo: root });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0].kind).toBe("duplicate");
  });
});

// ── Rule 4: the single most important rule in the work package ──────────────

describe("only a probe transcript may delete", () => {
  it("accepts a drop whose transcript is on disk", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({
        dropped: [{ hypothesis: "H-001", refutedBy: ".lastlight/pr-review/probes/H-001.txt" }],
      }),
      transcripts: ["H-001.txt"],
    });
    expect(checkFindings({ dir, repo: root }).satisfied).toBe(true);
  });

  it("resolves `refutedBy` relative to the repo OR to the pr-review dir", () => {
    // The `falsify` prompt asks for a repo-relative path. An adjudicator that
    // copies the dir-relative spelling is being helpful, not wrong, and failing
    // over a path convention would cost a whole iteration for nothing.
    const { dir, root } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ dropped: [{ hypothesis: "H-001", refutedBy: "probes/H-001.txt" }] }),
      transcripts: ["H-001.txt"],
    });
    expect(checkFindings({ dir, repo: root }).satisfied).toBe(true);
  });

  it("rejects a drop with no `refutedBy` at all — refutation by argument", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ dropped: [{ hypothesis: "H-001", reason: "on reflection, fine" }] }),
    });
    const result = checkFindings({ dir, repo: root });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0].kind).toBe("unbacked-drop");
    expect(result.gaps[0].detail).toMatch(/only a probe transcript may delete/);
  });

  it("rejects a drop naming a transcript that was never written", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ dropped: [{ hypothesis: "H-001", refutedBy: "probes/H-001.txt" }] }),
    });
    const result = checkFindings({ dir, repo: root });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0].kind).toBe("unbacked-drop");
  });

  it("rejects a drop with no hypothesis id — nothing can be conserved", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: [finding(["H-001"])], dropped: [{ refutedBy: "probes/x.txt" }] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0].kind).toBe("unbacked-drop");
  });
});

// ── Rule 5: a fabricated id reads the OPPOSITE way to an uncovered one ──────

describe("a cited id that nothing declared", () => {
  it("fails distinctly from an omission", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: [finding(["H-001"]), finding(["H-999"])] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.gaps).toHaveLength(1);
    expect(result.gaps[0]).toMatchObject({ kind: "fabricated", hypothesis: "H-999" });
    expect(result.gaps[0].detail).toMatch(/no hypotheses\/\*\.jsonl declares this id/);
  });

  it("catches a DROP of an id nothing declared, on the same footing", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({
        findings: [finding(["H-001"])],
        dropped: [{ hypothesis: "H-404", refutedBy: "probes/H-404.txt" }],
      }),
      transcripts: ["H-404.txt"],
    });
    const result = checkFindings({ dir, repo: root });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0]).toMatchObject({ kind: "fabricated", hypothesis: "H-404" });
  });
});

// ── Rule 6: the shipped reviewer's own findings are not audited ─────────────

describe("a finding with no `hypotheses` field", () => {
  it("fails nothing, and is counted rather than ignored", () => {
    // The reviewer we already have does not work from hypotheses. Requiring the
    // field would make its findings unpostable, which is a recall loss dressed
    // up as a conservation win.
    const { dir } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({
        findings: [
          finding(["H-001"]),
          { path: "src/x.ts", severity: "Important", title: "Typo", body: "…" },
        ],
      }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(true);
    expect(result.notes.join(" ")).toMatch(/1 finding\(s\) carry no `hypotheses`/);
  });

  it("is fine as the ONLY finding when there are no hypotheses either", () => {
    const { dir } = workspace({
      findings: doc({ findings: [{ path: "src/x.ts", title: "Typo", body: "…" }] }),
    });
    expect(checkFindings({ dir }).satisfied).toBe(true);
  });
});

// ── Rule 7: never fail a run for the absence of the thing it audits ─────────

describe("no hypothesis files at all", () => {
  it("passes trivially, and says why that is not a clean bill of health", () => {
    const { dir } = workspace({ findings: doc() });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(true);
    expect(result.hypotheses).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/did not run.*NOT evidence/);
  });

  it("still refuses an unbacked deletion, because that rule is unconditional", () => {
    // The trivial pass is about the ABSENCE of hypotheses, not an amnesty on
    // findings.json. A drop with no transcript is wrong whether or not the
    // surveys ran — and with no `.jsonl` at all the id is fabricated too.
    const { dir } = workspace({
      findings: doc({ dropped: [{ hypothesis: "H-001", refutedBy: "probes/H-001.txt" }] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.gaps.map((g) => g.kind).sort()).toEqual(["fabricated", "unbacked-drop"]);
  });
});

// ── Rule 8: no readable document ⇒ another iteration ────────────────────────

describe("findings.json itself", () => {
  it("fails when it is absent, so the loop gets another go at writing one", () => {
    const { dir } = workspace({ hypotheses: { contract: [H1] } });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.documentError).toMatch(/findings\.json/);
    expect(renderFindingsCheck(result)).toMatch(/no readable findings\.json/);
  });

  it("fails when it is not JSON", () => {
    const { dir } = workspace({ hypotheses: { contract: [H1] }, findings: "{ not json" });
    expect(checkFindings({ dir }).satisfied).toBe(false);
  });

  it("fails when `findings` is not an array", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: "none" }),
    });
    expect(checkFindings({ dir }).satisfied).toBe(false);
  });

  it("fails when it is absent EVEN with no hypotheses — absence of an output is not absence of an audit", () => {
    const { dir } = workspace({});
    expect(checkFindings({ dir }).satisfied).toBe(false);
  });

  it("counts unparseable hypothesis lines rather than skipping them", () => {
    const { dir } = workspace({
      hypotheses: { contract: `${JSON.stringify(H1)}\nnot json at all\n` },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    const result = checkFindings({ dir });
    expect(result.malformed).toBe(1);
    expect(result.notes.join(" ")).toMatch(/1 unparseable JSONL line/);
    expect(result.satisfied).toBe(true);
  });
});

// ── `--repair`: the §D12 floor ──────────────────────────────────────────────

describe("--repair records what the adjudicator did not", () => {
  it("appends every uncovered hypothesis at tier internal, carrying its record", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({ findings: [finding(["H-002"])] }),
    });
    const result = checkFindings({ dir, repair: true });
    expect(result.satisfied).toBe(true);
    expect(result.repaired).toEqual([
      { kind: "recorded", hypothesis: "contract-001", detail: 'no disposition — recorded at tier "internal"' },
    ]);

    const written = read().findings as Record<string, unknown>[];
    expect(written).toHaveLength(2);
    expect(written[1]).toMatchObject({
      tier: "internal",
      hypotheses: ["contract-001"],
      family: "contract",
      obligation: "O-014",
      severity: "Critical",
      confidence: 0.82,
      existingCode: "const MAX_TOKEN_AGE = 3600;",
      // `path` is derived from `bothEnds.introducedAt`, because an internal
      // record nobody can navigate back to is not auditable.
      path: "src/config.ts",
    });
    // The claim survives verbatim as the body; the title is its first clause.
    expect(written[1].body).toBe(H1.claim);
    expect(written[1].title).toBe("Token expiry is set on the client and never checked server-side");
    // …and the gate now closes on its own.
    expect(checkFindings({ dir }).satisfied).toBe(true);
  });

  it("un-deletes an unbacked drop: the entry goes, the finding comes back", () => {
    // THE asymmetry of this work package, expressed as code. An unjustified
    // deletion becomes a recorded non-deletion — never the other way round.
    const { dir, root, read } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ dropped: [{ hypothesis: "H-001", refutedBy: "probes/H-001.txt" }] }),
    });
    const result = checkFindings({ dir, repo: root, repair: true });
    expect(result.satisfied).toBe(true);
    expect(result.repaired[0]).toMatchObject({ kind: "promoted", hypothesis: "contract-001" });

    const after = read();
    expect(after.dropped).toEqual([]);
    expect((after.findings as Record<string, unknown>[])[0]).toMatchObject({
      tier: "internal",
      hypotheses: ["contract-001"],
    });
    expect(checkFindings({ dir, repo: root }).satisfied).toBe(true);
  });

  it("leaves a BACKED drop exactly where it is", () => {
    const { dir, root, read } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({ dropped: [{ hypothesis: "H-001", refutedBy: "probes/H-001.txt" }] }),
      transcripts: ["H-001.txt"],
    });
    checkFindings({ dir, repo: root, repair: true });
    expect(read().dropped).toEqual([{ hypothesis: "H-001", refutedBy: "probes/H-001.txt" }]);
    // …and only the genuinely uncovered one was recorded.
    expect(read().findings).toHaveLength(1);
  });

  it("withdraws an unbacked drop the findings already cover, without duplicating", () => {
    const { dir, root, read } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({
        findings: [finding(["H-001"])],
        dropped: [{ hypothesis: "H-001", refutedBy: "probes/gone.txt" }],
      }),
    });
    const result = checkFindings({ dir, repo: root, repair: true });
    expect(result.repaired[0]).toMatchObject({ kind: "withdrawn", hypothesis: "contract-001" });
    expect(read().dropped).toEqual([]);
    expect(read().findings).toHaveLength(1);
    expect(checkFindings({ dir, repo: root }).satisfied).toBe(true);
  });

  it("leaves a duplicate alone and reports it — guessing would be the deletion", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({ findings: [finding(["H-001"]), finding(["H-001"])] }),
    });
    const result = checkFindings({ dir, repair: true });
    // The floor never takes the run down…
    expect(result.satisfied).toBe(true);
    // …but the duplicate survives, named, for the adjudicator to fix.
    expect(result.gaps.map((g) => g.kind)).toEqual(["duplicate"]);
    expect(read().findings).toHaveLength(3); // the two originals + H-002, recorded
  });

  it("does not invent a findings.json it cannot repair", () => {
    // A fabricated `summary` and `event` is a review nobody wrote. A loop that
    // runs out of iterations does not fail the run, so there is nothing to
    // rescue here — and everything to lose by rescuing it.
    const { dir } = workspace({ hypotheses: { contract: [H1] } });
    const result = checkFindings({ dir, repair: true });
    expect(result.satisfied).toBe(false);
    expect(result.repaired).toEqual([]);
    expect(existsSync(join(dir, "findings.json"))).toBe(false);
  });

  it("preserves every unknown field — the evidence packet is not the gate's to strip", () => {
    // `post-review` passes unknown fields through, WP7 reads them and the
    // dashboard renders them. A rewrite that dropped them would delete the
    // evidence in the act of preserving the finding.
    const { dir, read } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({
        verdict: { spec: "fail", standards: "pass" },
        findings: [
          finding(["H-002"], {
            mechanism: "value set on one side, never checked on the other",
            evidence: [{ type: "transcript", ref: "probes/H-002.txt", result: "reproduced" }],
            suggestion: "if (expired(token)) return 401;",
          }),
        ],
      }),
    });
    checkFindings({ dir, repair: true });
    const after = read();
    expect(after.verdict).toEqual({ spec: "fail", standards: "pass" });
    expect(after.summary).toBe("Adds auth.");
    const kept = (after.findings as Record<string, unknown>[])[0];
    expect(kept.mechanism).toBe("value set on one side, never checked on the other");
    expect(kept.evidence).toHaveLength(1);
    expect(kept.suggestion).toBe("if (expired(token)) return 401;");
  });

  it("is IDEMPOTENT — the second run changes nothing on disk", () => {
    const { dir, root } = workspace({
      hypotheses: { contract: [H1, H3], enforcement: [H2] },
      findings: doc({
        findings: [finding(["H-002"])],
        dropped: [{ hypothesis: "H-003", refutedBy: "probes/nope.txt" }],
      }),
    });
    const path = join(dir, "findings.json");
    const first = checkFindings({ dir, repo: root, repair: true });
    expect(first.repaired).toHaveLength(2);
    const afterFirst = readFileSync(path, "utf8");

    const second = checkFindings({ dir, repo: root, repair: true });
    expect(second.repaired).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(afterFirst);
    expect(second.satisfied).toBe(true);
  });

  it("records a drop of an id nothing declared, rather than deleting the drop's subject", () => {
    const { dir, root, read } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({
        findings: [finding(["H-001"])],
        dropped: [{ hypothesis: "H-404" }],
      }),
    });
    const result = checkFindings({ dir, repo: root, repair: true });
    expect(result.satisfied).toBe(true);
    const written = (read().findings as Record<string, unknown>[])[1];
    expect(written).toMatchObject({ tier: "internal", hypotheses: ["H-404"] });
    expect(written.title).toBe("Unadjudicated hypothesis H-404");
    expect(String(written.body)).toMatch(/only a probe transcript may delete/);
    // The fabricated id is still named — recording it does not make it real.
    expect(result.gaps.map((g) => g.kind)).toEqual(["fabricated"]);
  });
});

// ── The summary a phase log actually shows ─────────────────────────────────

describe("the output the next iteration has to act on", () => {
  it("names each offending id, not just a count", () => {
    // A gate that says "3 hypotheses unaccounted for" cannot be acted on, and
    // being acted on in the next iteration is the entire point.
    const { dir } = workspace({
      hypotheses: { contract: [H1, H2, H3] },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    const text = renderFindingsCheck(checkFindings({ dir }));
    expect(text).toContain("1/3 hypotheses accounted for");
    expect(text).toContain("inline=1");
    expect(text).toContain("contract-002");
    expect(text).toContain("contract-003");
  });

  it("caps the list at 20 and counts the rest — this goes into a context window", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `H-${String(i + 1).padStart(3, "0")}`,
      family: "contract",
      obligation: "O-001",
      claim: "something",
    }));
    const { dir } = workspace({ hypotheses: { contract: many }, findings: doc() });
    const result = checkFindings({ dir });
    expect(result.gaps).toHaveLength(25);
    const text = renderFindingsCheck(result);
    expect(text).toContain("… and 5 more");
    expect(text.split("\n").filter((l) => l.startsWith("  ✗"))).toHaveLength(20);
  });

  it("says what it repaired", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc(),
    });
    const text = renderFindingsCheck(checkFindings({ dir, repair: true }));
    expect(text).toContain("1/1 hypotheses accounted for");
    expect(text).toContain("internal=1");
    expect(text).toMatch(/\+ contract-001: no disposition/);
  });
});

// ── The exit-code contract, which is what `until_bash` actually reads ───────

describe("the gate on a command line", () => {
  const capture = () => {
    const out: string[] = [];
    return { out, io: { out: (s: string) => out.push(s), err: (s: string) => out.push(s) } };
  };

  it("exits 0 when conservation holds and 3 when it does not", () => {
    // Exit 0 CLOSES the `generic_loop.until_bash`; non-zero means keep looping.
    const broken = workspace({
      hypotheses: { contract: [H1, H2] },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    const first = capture();
    expect(runCli(["findings", "--dir", broken.dir], first.io)).toBe(EXIT_DEGRADED);
    expect(first.out.join("\n")).toContain("contract-002");

    const whole = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    expect(runCli(["findings", "--dir", whole.dir], capture().io)).toBe(EXIT_OK);
  });

  it("exits 0 under --repair, because a floor that can fail is not a floor", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc(),
    });
    const { out, io } = capture();
    expect(runCli(["findings", "--dir", dir, "--repair"], io)).toBe(EXIT_OK);
    expect(out.join("\n")).toMatch(/\+ contract-001/);
    expect((read().findings as Record<string, unknown>[])[0]).toMatchObject({ tier: "internal" });
  });
});

describe("a claim is a sentence; a title is a label", () => {
  it("takes the first clause — a full stop or a semicolon", () => {
    expect(titleFrom("A leaks into B. Then C happens.")).toBe("A leaks into B");
    expect(titleFrom("A leaks into B; C accepts it.")).toBe("A leaks into B");
  });

  it("does not cut a dotted identifier in half", () => {
    // `foo.bar` has no whitespace after the dot, which is why the stop is
    // `[.;]` FOLLOWED by a space or the end and not a bare `.`.
    expect(titleFrom("cfg.host is read before it is set")).toBe("cfg.host is read before it is set");
  });

  it("collapses whitespace and bounds the length", () => {
    expect(titleFrom("  a\n  b  ")).toBe("a b");
    expect(titleFrom("x".repeat(200))).toHaveLength(100);
  });
});

// ── `--ledger`: the checklist half, and its DIFFERENT exit contract ─────────
//
// The gate answers the harness ("may the loop stop?") with an exit code. The
// ledger answers the adjudicator ("what must I account for?") with a list. The
// measured reason it exists: attempt 1 spent 426 s / $0.52 reconstructing the
// id set by hand, missed some, and bought a second 274 s / $0.43 attempt.

describe("the conservation ledger", () => {
  const capture = () => {
    const out: string[] = [];
    return { out, io: { out: (s: string) => out.push(s), err: (s: string) => out.push(s) } };
  };

  it("lists every declared id, grouped by family, marking what is accounted for", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2], tests: [H3] },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    const ledger = buildFindingsLedger({ dir });

    expect(ledger.entries.map((e) => e.id)).toEqual(["contract-001", "enforcement-001", "tests-001"]);
    expect(ledger.families).toEqual(["contract", "enforcement", "tests"]);
    expect(ledger.uncovered.map((e) => e.id)).toEqual(["enforcement-001", "tests-001"]);
    expect(ledger.satisfied).toBe(false);

    // The fields that let a claim be DISPOSED of travel with it — an id alone
    // is not actionable, which is the whole complaint against the six .jsonl.
    expect(ledger.entries[0]).toMatchObject({
      id: "contract-001",
      family: "contract",
      obligation: "O-014",
      severity: "Critical",
      path: "src/config.ts",
      accounted: true,
    });
  });

  it("NEVER truncates the list — the cap is on each claim, not the count", () => {
    // `renderFindingsCheck` stops naming ids at 20 because it is a log line. A
    // checklist that elided entries would reproduce the omission it exists to
    // prevent, so this asserts the opposite property on the same data.
    const many = Array.from({ length: 45 }, (_, i) => ({
      id: `H-${String(i + 1).padStart(3, "0")}`,
      family: "contract",
      claim: `${"x".repeat(400)}. trailing`,
    }));
    const { dir } = workspace({ hypotheses: { contract: many }, findings: doc() });
    const text = renderFindingsLedger(buildFindingsLedger({ dir }));

    // Canonical ids, not the model's — every one of the 45 is listed.
    for (let n = 1; n <= many.length; n += 1)
      expect(text).toContain(`contract-${String(n).padStart(3, "0")}`);
    expect(text).not.toMatch(/and \d+ more/);
    // Bounded per line: `titleFrom` caps at 100 chars.
    for (const line of text.split("\n")) expect(line.length).toBeLessThan(140);
  });

  it("degrades sanely with zero hypotheses, and does not read as a completed review", () => {
    const { dir } = workspace({ findings: doc() });
    const ledger = buildFindingsLedger({ dir });
    expect(ledger.entries).toEqual([]);
    // Rule 7: nothing to conserve ⇒ the gate passes. The prose has to stop that
    // being read as "the adjudication was complete".
    expect(ledger.satisfied).toBe(true);
    expect(renderFindingsLedger(ledger)).toMatch(/NOT evidence that the review/);
  });

  it("says so plainly when everything is already accounted for", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1, H2] },
      findings: doc({ findings: [finding(["H-001"]), finding(["H-002"], { tier: "internal" })] }),
    });
    const ledger = buildFindingsLedger({ dir });
    expect(ledger.uncovered).toEqual([]);
    expect(ledger.satisfied).toBe(true);
    expect(renderFindingsLedger(ledger)).toContain("Conservation holds");
  });

  it("treats an absent findings.json as every id outstanding, not as an error", () => {
    // Iteration 1 reaches this with whatever the `review` phase wrote; a run
    // where that is missing must still get a usable checklist rather than a
    // zod dump.
    const { dir } = workspace({ hypotheses: { contract: [H1, H2] } });
    const ledger = buildFindingsLedger({ dir });
    expect(ledger.documentError).not.toBeNull();
    expect(ledger.uncovered.map((e) => e.id)).toEqual(["contract-001", "contract-002"]);
    expect(renderFindingsLedger(ledger)).toContain("contract-002");
  });

  it("ALWAYS exits 0 — it reports, it does not grade", () => {
    // The adjudicator runs this inside its own bash tool. The gate's non-zero
    // "keep looping" would read there as a tool failure, so the two modes must
    // not share an exit contract.
    const broken = workspace({
      hypotheses: { contract: [H1, H2] },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    const bare = capture();
    expect(runCli(["findings", "--dir", broken.dir], bare.io)).toBe(EXIT_DEGRADED);

    const led = capture();
    expect(runCli(["findings", "--dir", broken.dir, "--ledger"], led.io)).toBe(EXIT_OK);
    expect(led.out.join("\n")).toContain("contract-002");
  });

  it("does not write anything — the ledger is a read", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1, H2] },
      findings: doc({ findings: [finding(["H-001"])] }),
    });
    const before = JSON.stringify(read());
    runCli(["findings", "--dir", dir, "--ledger"], capture().io);
    expect(JSON.stringify(read())).toBe(before);
  });
});

/**
 * IDENTITY — the two defects that made the gate pass falsely on the first real
 * run, and the mechanism that closes both.
 *
 * Measured on `prreview__skillspro-1587-r1` (2026-08-22, 30 hypotheses across
 * six families): `contract.jsonl` minted `H-001..H-005` and `security.jsonl`
 * independently minted `H-001..H-003`, so the reader's flat first-write-wins map
 * DISCARDED the three security claims and the gate reported `5/5 accounted for`,
 * exit 0. Separately, only **8 of 30** rows carried an `id` at all, so 22 real
 * claims were structurally invisible to conservation.
 *
 * Both are the same species: identity minted by a model is an instruction, and
 * this plan's most expensive lesson is that an instruction is not a mechanism.
 * `<family>-NNN` is assigned at ingest, from the filename and the append-only
 * position, so it exists for every row and cannot collide.
 */
describe("findings — hypothesis identity", () => {
  it("gives two families minting the same id two distinct ids, and reports both", () => {
    // The exact shape from the real run, minimised.
    const fx = workspace({
      hypotheses: {
        contract: [{ id: "H-001", claim: "producer changed shape" }],
        security: [{ id: "H-001", claim: "COOKIES_SECRET is hard-coded" }],
      },
      findings: { summary: "s", event: "COMMENT", findings: [] },
    });
    const result = checkFindings({ dir: fx.dir });

    expect(result.hypotheses).toEqual(["contract-001", "security-001"]);
    // Before the fix this read `1/1 accounted for` and exited 0.
    expect(result.satisfied).toBe(false);
    expect(result.gaps.filter((g) => g.kind === "uncovered").map((g) => g.hypothesis)).toEqual([
      "contract-001",
      "security-001",
    ]);
  });

  it("credits NEITHER claimant when a finding cites the colliding id", () => {
    const fx = workspace({
      hypotheses: {
        contract: [{ id: "H-001", claim: "producer changed shape" }],
        security: [{ id: "H-001", claim: "COOKIES_SECRET is hard-coded" }],
      },
      findings: {
        summary: "s",
        event: "COMMENT",
        findings: [{ title: "t", body: "b", hypotheses: ["H-001"] }],
      },
    });
    const result = checkFindings({ dir: fx.dir });

    // Crediting the first family to sort is what silently marked the other
    // adjudicated. Neither is credited, and the citation is named.
    expect(result.covered).toEqual([]);
    const ambiguous = result.gaps.filter((g) => g.kind === "ambiguous");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0].hypothesis).toBe("H-001");
    expect(ambiguous[0].detail).toContain("contract-001");
    expect(ambiguous[0].detail).toContain("security-001");
    expect(result.satisfied).toBe(false);
  });

  it("counts a row with NO id — 22 of 30 were invisible before this", () => {
    const fx = workspace({
      hypotheses: {
        // Every free-form shape the real surveys actually emitted.
        enforcement: [
          { claim: "MAX_PENDING_NONCES defined but never checked", obligations: ["O-031"] },
        ],
        spec: [{ claim: "producer/consumer disagree", producer_side: "a.ts", consumer_side: "b.ts" }],
        state: [{ claim: "unguarded parse", symbol: "readIdToken", introduced_at: "x.ts:44" }],
      },
      findings: { summary: "s", event: "COMMENT", findings: [] },
    });
    const result = checkFindings({ dir: fx.dir });

    expect(result.hypotheses).toEqual(["enforcement-001", "spec-001", "state-001"]);
    expect(result.satisfied).toBe(false);
    // The floor must be able to conserve one, which means carrying its claim.
    const repaired = checkFindings({ dir: fx.dir, repair: true });
    expect(repaired.satisfied).toBe(true);
    const doc = fx.read();
    const bodies = (doc.findings as Record<string, unknown>[]).map((f) => f.body);
    expect(bodies).toContain("MAX_PENDING_NONCES defined but never checked");
    // Family comes from the FILENAME, so a free-form row is still attributable.
    const families = (doc.findings as Record<string, unknown>[]).map((f) => f.family);
    expect(families).toEqual(expect.arrayContaining(["enforcement", "spec", "state"]));
  });

  it("honours an unambiguous model-minted id as an alias", () => {
    const fx = workspace({
      hypotheses: {
        contract: [{ id: "H-004", claim: "only contract minted this one" }],
        security: [{ id: "H-009", claim: "and only security minted this" }],
      },
      findings: {
        summary: "s",
        event: "COMMENT",
        findings: [
          { title: "t", body: "b", hypotheses: ["H-004"] },
          { title: "u", body: "b", hypotheses: ["H-009"] },
        ],
      },
    });
    const result = checkFindings({ dir: fx.dir });

    // An adjudicator that used the id it was shown is still credited.
    expect(result.covered).toEqual(["contract-001", "security-001"]);
    expect(result.satisfied).toBe(true);
  });

  it("refuses an alias that would shadow a canonical id", () => {
    // Second row declares the id the FIRST row canonically owns. The canonical
    // reading has to win, or a citation of `contract-001` credits the wrong row.
    const fx = workspace({
      hypotheses: {
        contract: [{ claim: "first" }, { id: "contract-001", claim: "second, mislabelled" }],
      },
      findings: {
        summary: "s",
        event: "COMMENT",
        findings: [{ title: "t", body: "b", hypotheses: ["contract-001"] }],
      },
    });
    const result = checkFindings({ dir: fx.dir });

    expect(result.hypotheses).toEqual(["contract-001", "contract-002"]);
    expect(result.covered).toEqual(["contract-001"]);
    expect(result.gaps.map((g) => g.hypothesis)).toEqual(["contract-002"]);
  });

  it("still passes with no hypotheses at all, and still counts the empty case", () => {
    const fx = workspace({ findings: { summary: "s", event: "COMMENT", findings: [] } });
    const result = checkFindings({ dir: fx.dir });
    expect(result.hypotheses).toEqual([]);
    expect(result.satisfied).toBe(true);
  });

  it("names every family in the ledger, including free-form ones", () => {
    const fx = workspace({
      hypotheses: {
        contract: [{ id: "H-001", claim: "a producer changed shape." }],
        enforcement: [{ claim: "a value is never enforced." }],
      },
      findings: { summary: "s", event: "COMMENT", findings: [] },
    });
    const ledger = buildFindingsLedger({ dir: fx.dir });
    expect(ledger.families).toEqual(["contract", "enforcement"]);
    expect(ledger.entries.map((e) => e.id)).toEqual(["contract-001", "enforcement-001"]);
    // Every entry is attributable to a family — there is no "(no family)" row.
    expect(ledger.entries.every((e) => e.family.length > 0)).toBe(true);
    const rendered = renderFindingsLedger(ledger);
    expect(rendered).toContain("── enforcement ──");
    expect(rendered).toContain("[ ] enforcement-001");
  });
});

describe("the `internal[]` id-list shorthand", () => {
  // Measured 2026-08-25: internal-tier rows were 57% of findings.json bytes
  // (92% on one case) while their prose degenerates to the same verification
  // boilerplate `internalFinding` reproduces from the hypothesis record. The
  // shorthand lets the adjudicator spend output only on posted-tier findings;
  // conservation semantics must not move an inch.
  it("closes the gate: a listed id is one disposition", () => {
    const { dir } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({ findings: [finding(["H-001"])], internal: ["enforcement-001"] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(true);
    expect(result.covered).toEqual(["contract-001", "enforcement-001"]);
    expect(result.byTier["internal"]).toBe(1);
  });

  it("repair EXPANDS the list into full internal rows and removes the key — even on a satisfied document", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1], enforcement: [H2] },
      findings: doc({ findings: [finding(["H-001"])], internal: ["enforcement-001"] }),
    });
    const result = checkFindings({ dir, repair: true });
    expect(result.satisfied).toBe(true);
    expect(result.repaired).toEqual([
      expect.objectContaining({ kind: "expanded", hypothesis: "enforcement-001" }),
    ]);
    const after = read();
    expect(after.internal).toBeUndefined();
    const rows = after.findings as Record<string, unknown>[];
    const expanded = rows.find((f) => (f.hypotheses as string[])?.includes("enforcement-001"));
    expect(expanded).toBeDefined();
    expect(expanded!.tier).toBe("internal");
    // The materialized row carries the hypothesis's own claim, so the
    // internal-recall judge reads the claim, not boilerplate.
    expect(expanded!.body).toBe(H2.claim);
    // Idempotent: a second repair finds nothing to do.
    const again = checkFindings({ dir, repair: true });
    expect(again.repaired).toEqual([]);
  });

  it("a fabricated id in the list fails the gate and survives repair, reported", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: [finding(["H-001"])], internal: ["security-009"] }),
    });
    const before = checkFindings({ dir });
    expect(before.satisfied).toBe(false);
    expect(before.gaps).toEqual([expect.objectContaining({ kind: "fabricated", hypothesis: "security-009" })]);
    checkFindings({ dir, repair: true });
    // The citation is kept, not silently deleted — it is the evidence that the
    // adjudicator cited provenance that does not exist.
    expect(read().internal).toEqual(["security-009"]);
  });

  it("an id both listed and carried by a finding is a duplicate, and repair does not mint a second row", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: [finding(["H-001"])], internal: ["contract-001"] }),
    });
    const result = checkFindings({ dir });
    expect(result.satisfied).toBe(false);
    expect(result.gaps).toEqual([expect.objectContaining({ kind: "duplicate", hypothesis: "contract-001" })]);
    checkFindings({ dir, repair: true });
    // The finding cites the alias `H-001` (resolving to contract-001); repair
    // must not add a second row under the canonical spelling.
    const rows = read().findings as Record<string, unknown>[];
    const carrying = rows.filter((f) =>
      ((f.hypotheses as string[]) ?? []).some((h) => h === "H-001" || h === "contract-001"),
    );
    expect(carrying).toHaveLength(1);
  });

  it("an unbacked drop of a listed id is withdrawn, never restored beside the expansion", () => {
    const { dir, read } = workspace({
      hypotheses: { contract: [H1] },
      findings: doc({ findings: [], internal: ["contract-001"], dropped: [{ hypothesis: "contract-001", reason: "prose" }] }),
    });
    const result = checkFindings({ dir, repair: true });
    expect(result.repaired).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "expanded", hypothesis: "contract-001" }),
        expect.objectContaining({ kind: "withdrawn", hypothesis: "contract-001" }),
      ]),
    );
    const after = read();
    expect(after.dropped).toEqual([]);
    const rows = after.findings as Record<string, unknown>[];
    expect(rows.filter((f) => (f.hypotheses as string[])?.includes("contract-001"))).toHaveLength(1);
  });
});
