import { describe, it, expect } from "vitest";
import { evalUntilExpression, evalSkipIf } from "#src/workflows/loop-eval.js";

describe("evalUntilExpression — output.contains", () => {
  it("returns true when output contains the target string", () => {
    expect(evalUntilExpression("output.contains('APPROVED')", { output: "VERDICT: APPROVED" })).toBe(true);
  });

  it("returns false when output does not contain the target string", () => {
    expect(evalUntilExpression("output.contains('APPROVED')", { output: "REQUEST_CHANGES" })).toBe(false);
  });

  it("is case-sensitive", () => {
    expect(evalUntilExpression("output.contains('approved')", { output: "APPROVED" })).toBe(false);
  });

  it("works with double-quoted strings", () => {
    expect(evalUntilExpression('output.contains("PASS")', { output: "All tests PASS" })).toBe(true);
  });
});

describe("evalUntilExpression — equality (==)", () => {
  it("returns true when context variable equals value", () => {
    expect(evalUntilExpression("verdict == 'APPROVED'", { output: "", verdict: "APPROVED" })).toBe(true);
  });

  it("returns false when context variable does not equal value", () => {
    expect(evalUntilExpression("verdict == 'APPROVED'", { output: "", verdict: "REQUEST_CHANGES" })).toBe(false);
  });

  it("works with double-quoted value", () => {
    expect(evalUntilExpression('status == "done"', { output: "", status: "done" })).toBe(true);
  });

  it("returns false when variable is absent from context", () => {
    expect(evalUntilExpression("missing == 'value'", { output: "" })).toBe(false);
  });
});

describe("evalUntilExpression — inequality (!=)", () => {
  it("returns true when context variable does not equal value", () => {
    expect(evalUntilExpression("verdict != 'FAILED'", { output: "", verdict: "APPROVED" })).toBe(true);
  });

  it("returns false when context variable equals the value", () => {
    expect(evalUntilExpression("verdict != 'FAILED'", { output: "", verdict: "FAILED" })).toBe(false);
  });

  it("returns false when variable is absent from context", () => {
    expect(evalUntilExpression("missing != 'value'", { output: "" })).toBe(false);
  });
});

describe("evalUntilExpression — dotted paths (scratch.*)", () => {
  it("resolves a two-level dotted path", () => {
    const ctx = { output: "", scratch: { socratic: { ready: true } } };
    expect(evalUntilExpression("scratch.socratic.ready == true", ctx)).toBe(true);
  });

  it("resolves a dotted path with string value", () => {
    const ctx = { output: "", scratch: { socratic: { status: "done" } } };
    expect(evalUntilExpression("scratch.socratic.status == 'done'", ctx)).toBe(true);
  });

  it("returns false for a missing intermediate", () => {
    const ctx = { output: "", scratch: {} };
    expect(evalUntilExpression("scratch.socratic.ready == true", ctx)).toBe(false);
  });

  it("returns false when the leaf value is false", () => {
    const ctx = { output: "", scratch: { socratic: { ready: false } } };
    expect(evalUntilExpression("scratch.socratic.ready == true", ctx)).toBe(false);
  });

  it("handles bare boolean != comparison", () => {
    const ctx = { output: "", scratch: { socratic: { ready: true } } };
    expect(evalUntilExpression("scratch.socratic.ready != false", ctx)).toBe(true);
  });
});

describe("evalUntilExpression — prototype chain guard", () => {
  it("returns false when path traverses __proto__", () => {
    const ctx = { output: "" };
    expect(evalUntilExpression("__proto__.polluted == 'yes'", ctx)).toBe(false);
  });

  it("returns false when path traverses constructor", () => {
    const ctx = { output: "", obj: {} };
    expect(evalUntilExpression("obj.constructor == 'Object'", ctx)).toBe(false);
  });

  it("returns false when path traverses prototype", () => {
    const ctx = { output: "", obj: {} };
    expect(evalUntilExpression("obj.prototype.x == 'y'", ctx)).toBe(false);
  });
});

describe("evalUntilExpression — dotted-path .contains()", () => {
  const diagnosis =
    "The lockfile is stale.\nDIAGNOSIS_COMPLETE: pr=7 attempt=1 class=flaky cause=network blip ci_vs_local=none unreproducible=";
  const ctx = { output: "", phaseOutputs: { diagnosis }, scratch: { diagnosis: { class: "flaky" } } };

  it("matches a substring of an upstream phase's output", () => {
    expect(evalUntilExpression("phaseOutputs.diagnosis.contains('class=flaky')", ctx)).toBe(true);
  });

  it("does not match a different class", () => {
    expect(evalUntilExpression("phaseOutputs.diagnosis.contains('class=reproducible')", ctx)).toBe(false);
  });

  it("returns false when the path is absent (the safe default)", () => {
    expect(evalUntilExpression("phaseOutputs.diagnosis.contains('class=flaky')", { output: "" })).toBe(false);
  });

  it("returns false when the path resolves to an object, not a string", () => {
    expect(evalUntilExpression("scratch.diagnosis.contains('flaky')", ctx)).toBe(false);
  });

  it("keeps the bare output.contains form working (the generic-loop case)", () => {
    expect(evalUntilExpression("output.contains('PASS')", { output: "tests PASS" })).toBe(true);
  });

  it("returns false when the path traverses the prototype chain", () => {
    expect(evalUntilExpression("__proto__.contains('x')", { output: "" })).toBe(false);
  });
});

describe("evalSkipIf — phase-level skip guard", () => {
  const ctxFor = (diagnosis: string) => ({ output: "", phaseOutputs: { diagnosis } });
  const NON_FIXABLE = [
    "phaseOutputs.diagnosis.contains('class=flaky')",
    "phaseOutputs.diagnosis.contains('class=infra-dependent')",
    "phaseOutputs.diagnosis.contains('class=upstream-broken')",
  ];

  it("returns the first matching expression so the caller can name it", () => {
    expect(evalSkipIf(NON_FIXABLE, ctxFor("class=upstream-broken"))).toBe(
      "phaseOutputs.diagnosis.contains('class=upstream-broken')",
    );
  });

  it("ORs the list — any match skips", () => {
    for (const cls of ["flaky", "infra-dependent", "upstream-broken"]) {
      expect(evalSkipIf(NON_FIXABLE, ctxFor(`class=${cls}`))).toBeDefined();
    }
  });

  it("does not fire for the two fixable classes", () => {
    for (const cls of ["reproducible", "env-mismatch"]) {
      expect(evalSkipIf(NON_FIXABLE, ctxFor(`class=${cls}`))).toBeUndefined();
    }
  });

  it("does not fire when the upstream output is missing (resume boundary)", () => {
    // `{{phaseOutputs}}` is empty across a resume — the guard must fail OPEN
    // (run the phase), never swallow it.
    expect(evalSkipIf(NON_FIXABLE, { output: "" })).toBeUndefined();
  });

  it("fails open on a malformed expression", () => {
    expect(evalSkipIf(["diagnosis is flaky"], ctxFor("class=flaky"))).toBeUndefined();
  });

  it("returns undefined for an empty list", () => {
    expect(evalSkipIf([], ctxFor("class=flaky"))).toBeUndefined();
  });
});

describe("evalUntilExpression — invalid / unrecognised expressions", () => {
  it("returns false for an empty string", () => {
    expect(evalUntilExpression("", { output: "anything" })).toBe(false);
  });

  it("returns false for an unrecognised expression form", () => {
    expect(evalUntilExpression("output > 5", { output: "10" })).toBe(false);
  });

  it("returns false for a bare variable name", () => {
    expect(evalUntilExpression("verdict", { output: "", verdict: "APPROVED" })).toBe(false);
  });
});
