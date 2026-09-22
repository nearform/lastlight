/**
 * `jev-classify` — #399 idea 2. The properties under test are the ones that
 * make it safe to ship behind `adjudicate: "jev"`: it must NEVER fail the
 * run, and it must never spend on a hypothesis that isn't one.
 *
 * No real TypeSafe call is made anywhere here — that would need a live key
 * and a network, and the paths worth pinning (no key, no candidates) never
 * reach the client at all. The classification call itself was validated for
 * real against a preserved arm; see `docs/plans/probe-oracle.md`.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildJevState } from "../src/jev-classify.js";
import { classifyHypotheses } from "../src/index.js";
import type { DossierEntry } from "../src/adjudicate-render.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): { root: string; dir: string } {
  const root = mkdtempSync(join(tmpdir(), "jev-classify-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  return { root, dir };
}

function withoutTypesafeEnv<T>(fn: () => T): T {
  const saved = { key: process.env.TYPESAFE_KEY, alt: process.env.TYPESAFE_API_KEY };
  delete process.env.TYPESAFE_KEY;
  delete process.env.TYPESAFE_API_KEY;
  try {
    return fn();
  } finally {
    if (saved.key !== undefined) process.env.TYPESAFE_KEY = saved.key;
    if (saved.alt !== undefined) process.env.TYPESAFE_API_KEY = saved.alt;
  }
}

describe("classifyHypotheses never fails the run", () => {
  it("degrades to an empty, explained document with no key — never throws", async () => {
    const { dir } = fixture();
    writeFileSync(join(dir, "hypotheses", "contract.jsonl"), JSON.stringify({ id: "contract-001", claim: "c" }) + "\n");
    const doc = await withoutTypesafeEnv(() => classifyHypotheses({ dir }));
    expect(doc.error).toMatch(/TYPESAFE_KEY/);
    expect(doc.results).toEqual([]);
  });

  it("spends nothing and reports cleanly when every hypothesis is a placeholder", async () => {
    const { dir } = fixture();
    writeFileSync(join(dir, "hypotheses", "contract.jsonl"), JSON.stringify({ id: "contract-001", claim: "no contract hypothesis" }) + "\n");
    // A key present but no candidates must not even try to build a client —
    // if it did, a fake key would throw on construction and `error` would be
    // non-null. Asserting `null` here pins that short-circuit.
    const doc = await classifyHypotheses({ dir, apiKey: "unused-because-no-candidates" });
    expect(doc.error).toBeNull();
    expect(doc.results).toEqual([]);
  });

  it("reports cleanly with no hypotheses at all", async () => {
    const { dir } = fixture();
    const doc = await withoutTypesafeEnv(() => classifyHypotheses({ dir }));
    expect(doc.error).toMatch(/TYPESAFE_KEY/);
    expect(doc.results).toEqual([]);
  });
});

describe("buildJevState — the evidence a hypothesis hands to jev", () => {
  function entry(over: Partial<DossierEntry>): DossierEntry {
    return {
      record: { id: "contract-001", family: "contract", ordinal: 1, declaredId: "contract-001", declaredObligation: null, obligation: null, row: { claim: "c" } },
      probe: null,
      transcript: null,
      transcriptTruncated: false,
      path: null,
      excerpt: { kind: "no-path" },
      quotes: [],
      ...over,
    };
  }

  it("shows a VERIFIED anchor in full", () => {
    const state = buildJevState(entry({ path: "src/a.ts", excerpt: { kind: "resolved", line: 3 }, record: { ...entry({}).record, row: { claim: "c", existingCode: "return 1;" } } }));
    expect(state.anchor).toEqual({ status: "verified", file: "src/a.ts", line: 3, text: "return 1;" });
  });

  it("shows only a status line for a mismatched anchor — never the wrong text", () => {
    const state = buildJevState(
      entry({ path: "src/a.ts", excerpt: { kind: "not-found" }, record: { ...entry({}).record, row: { claim: "c", existingCode: "this is not in the file" } } }),
    );
    expect(state.anchor).toEqual({ status: "not-found", file: "src/a.ts" });
  });

  it("omits the probe's own reasoning — only verdict, command and transcript ride along", () => {
    const state = buildJevState(
      entry({
        probe: { verdict: "refuted", command: "node x.mjs", transcript: "node x.mjs\nfalse\n", transcriptPath: "/tmp/x.txt" },
        transcript: "node x.mjs\nfalse\n",
      }),
    );
    expect(state.probe).toEqual({ verdict: "refuted", command: "node x.mjs", differential: false, transcript: "node x.mjs\nfalse\n" });
  });
});
