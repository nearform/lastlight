/**
 * The JSONL reader every gate shares — specifically the rows it used to lose.
 *
 * Measured 2026-09-24: GLM 5.3 Flash, DeepSeek V4 Flash and a full Haiku arm
 * all pretty-print some hypothesis rows. Line-by-line parsing dropped every
 * one (33 lines on one `1680-r1` family), counted each line as "malformed", and
 * the claim never reached adjudication.
 */
import { describe, expect, it } from "vitest";

import { parseJsonl } from "../src/jsonl.js";

describe("parseJsonl", () => {
  it("reads one object per line exactly as before", () => {
    const r = parseJsonl('{"a":1}\n\n{"b":2}\n');
    expect(r.rows).toEqual([{ a: 1 }, { b: 2 }]);
    expect(r).toMatchObject({ recovered: 0, malformed: 0 });
  });

  it("recovers a pretty-printed object and keeps its ordinal in place", () => {
    const pretty = JSON.stringify({ claim: "x", evidence: { quote: "a" } }, null, 2);
    const r = parseJsonl(`{"n":1}\n${pretty}\n{"n":3}\n`);
    expect(r.rows).toEqual([{ n: 1 }, { claim: "x", evidence: { quote: "a" } }, { n: 3 }]);
    expect(r).toMatchObject({ recovered: 1, malformed: 0 });
  });

  it("is not fooled by braces and escaped quotes inside strings", () => {
    const text = '{\n  "claim": "if (x) { return \\"}\\" }",\n  "n": 2\n}\n';
    const r = parseJsonl(text);
    expect(r.rows).toEqual([{ claim: 'if (x) { return "}" }', n: 2 }]);
    expect(r.recovered).toBe(1);
  });

  it("splits objects written back to back on one line", () => {
    const r = parseJsonl('{"n":1}{"n":2} {"n":3}\n');
    expect(r.rows).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
    // The trailing `{"n":3}` parses on its own once split off, so it is a plain row.
    expect(r.recovered).toBe(2);
  });

  it("counts a torn final object as malformed without swallowing earlier rows", () => {
    const r = parseJsonl('{"n":1}\n{\n  "claim": "cut off');
    expect(r.rows).toEqual([{ n: 1 }]);
    expect(r.malformed).toBeGreaterThan(0);
  });

  it("does not let one broken line eat the good lines after it", () => {
    const r = parseJsonl('{"n": 1, "bad": }\n{"n":2}\n{"n":3}\n');
    expect(r.rows).toEqual([{ n: 2 }, { n: 3 }]);
    expect(r.malformed).toBe(1);
  });

  it("keeps non-object lines that parse, as the ordinal rule requires", () => {
    const r = parseJsonl('42\n["a"]\n{"n":1}\n');
    expect(r.rows).toEqual([42, ["a"], { n: 1 }]);
  });

  it("counts prose and fences as malformed rather than guessing", () => {
    const r = parseJsonl('```json\n{"n":1}\n```\nnot json\n');
    expect(r.rows).toEqual([{ n: 1 }]);
    expect(r.malformed).toBe(3);
  });
});
