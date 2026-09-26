/**
 * Issue #405 — the survey gate writes canonical ids into the file, so the raw
 * `hypotheses/*.jsonl` and every reader (dossier, gates, a model's own script)
 * agree on one id scheme.
 */
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runCli as run } from "../src/cli.js";
import { checkFindings } from "../src/findings.js";
import { normalizeFamilyIds, readHypothesisSet } from "../src/hypotheses.js";

function workspace(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "normalize-ids-"));
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, "hypotheses", name), text);
  return dir;
}

const row = (o: object) => JSON.stringify(o);

/** The measured shape: a `-000` placeholder, then real rows numbered from `-001`. */
const OFFSET = [
  row({ id: "enforcement-000", claim: "unseeded — no obligations built" }),
  row({ id: "enforcement-001", claim: "a" }),
  "{ not json at all",
  row({ id: "enforcement-002", claim: "b" }),
  row({ claim: "no id" }),
].join("\n") + "\n";

describe("normalizeFamilyIds", () => {
  it("writes the canonical id, keeps the label as declared_id, and moves no ordinal", () => {
    const dir = workspace({ "enforcement.jsonl": OFFSET });
    const before = readHypothesisSet(dir).records.map((r) => [r.id, r.row.claim]);
    const r = normalizeFamilyIds(dir, "enforcement");
    expect(r).toEqual({ family: "enforcement", rows: 4, rewritten: 4 });

    const after = readHypothesisSet(dir);
    expect(after.records.map((x) => [x.id, x.row.claim])).toEqual(before);
    expect(after.records.map((x) => (x.row as { id?: string }).id)).toEqual([
      "enforcement-001",
      "enforcement-002",
      "enforcement-003",
      "enforcement-004",
    ]);
    expect(after.records.map((x) => (x.row as { declared_id?: string }).declared_id)).toEqual([
      "enforcement-000",
      "enforcement-001",
      "enforcement-002",
      undefined,
    ]);
    // The malformed line is still there, byte for byte.
    expect(readFileSync(join(dir, "hypotheses", "enforcement.jsonl"), "utf8")).toContain("\n{ not json at all\n");
  });

  it("is idempotent, and leaves an already-canonical file byte-identical", () => {
    const dir = workspace({ "enforcement.jsonl": OFFSET });
    normalizeFamilyIds(dir, "enforcement");
    const once = readFileSync(join(dir, "hypotheses", "enforcement.jsonl"), "utf8");
    expect(normalizeFamilyIds(dir, "enforcement").rewritten).toBe(0);
    expect(readFileSync(join(dir, "hypotheses", "enforcement.jsonl"), "utf8")).toBe(once);
  });

  it("keeps a non-colliding label usable as an alias", () => {
    const dir = workspace({ "contract.jsonl": row({ id: "H-004", claim: "x" }) + "\n" });
    normalizeFamilyIds(dir, "contract");
    expect(readHypothesisSet(dir).aliases.get("H-004")).toBe("contract-001");
  });

  it("rewrites a multi-line row in place", () => {
    const dir = workspace({ "state.jsonl": '{\n  "id": "state-000",\n  "claim": "pretty"\n}\n' + row({ id: "state-001", claim: "b" }) + "\n" });
    normalizeFamilyIds(dir, "state");
    expect(readHypothesisSet(dir).records.map((x) => [(x.row as { id?: string }).id, x.row.claim])).toEqual([
      ["state-001", "pretty"],
      ["state-002", "b"],
    ]);
  });

  it("is what makes a raw-file self-check agree with the conservation gate", () => {
    // Before: citing the ids a script reads off the raw file (the labels)
    // collides with canonical ids — the measured duplicate + uncovered failure.
    const cite = (ids: string[]) =>
      writeFileSync(
        join(dir, "findings.json"),
        JSON.stringify({ summary: "s", event: "COMMENT", findings: ids.map((id) => ({ title: id, hypotheses: [id] })) }),
      );
    const dir = workspace({ "enforcement.jsonl": OFFSET });
    const rawIds = () =>
      readFileSync(join(dir, "hypotheses", "enforcement.jsonl"), "utf8")
        .split("\n")
        .flatMap((l) => {
          try {
            const id = (JSON.parse(l) as { id?: string }).id;
            return id ? [id] : [];
          } catch {
            return [];
          }
        });
    cite(rawIds());
    expect(checkFindings({ dir }).satisfied).toBe(false);

    normalizeFamilyIds(dir, "enforcement");
    cite(rawIds());
    expect(checkFindings({ dir }).satisfied).toBe(true);
  });
});

describe("discharge gate", () => {
  it("--ungraded rewrites ids and passes on a non-empty file, fails on a missing one", async () => {
    const dir = workspace({ "spec.jsonl": row({ id: "spec-000", claim: "criterion" }) + "\n" });
    const out: string[] = [];
    const io = { out: (s: string) => out.push(s), err: (s: string) => out.push(s) };
    expect(await run(["discharge", "--dir", dir, "--family", "spec", "--ungraded"], io)).toBe(0);
    expect(readHypothesisSet(dir).records[0]!.row.id).toBe("spec-001");
    expect(await run(["discharge", "--dir", dir, "--family", "nope", "--ungraded"], io)).not.toBe(0);
  });

  it("--ledger never writes", async () => {
    const dir = workspace({ "enforcement.jsonl": OFFSET });
    const io = { out: () => {}, err: () => {} };
    await run(["discharge", "--dir", dir, "--family", "enforcement", "--ledger"], io);
    expect(readFileSync(join(dir, "hypotheses", "enforcement.jsonl"), "utf8")).toBe(OFFSET);
  });
});
