import { describe, expect, it } from "vitest";
import { defaultGateConfig, effectiveGate } from "#src/config/config.js";

// Issue #385 / PR #386 review: `gate.timeoutSeconds` is a duration, and config
// load accepts a fractional value. The run context must still carry whole
// seconds — the `guardrails_gate` bash template renders it into `timeout N`
// behind a digits-only guard, where `900.5` would read as "not set".
describe("effectiveGate", () => {
  const operator = { timeoutSeconds: 900, maxTimeoutSeconds: 1500, phaseTimeoutSeconds: 2400 };

  it("rounds a fractional repo timeout UP to whole seconds", () => {
    expect(effectiveGate({ timeoutSeconds: 900.5 }, operator).timeoutSeconds).toBe(901);
  });

  it("rounds fractional operator values UP too", () => {
    const gate = effectiveGate(undefined, { timeoutSeconds: 899.2, maxTimeoutSeconds: 1499.1, phaseTimeoutSeconds: 2399.9 });
    expect(gate).toEqual({ timeoutSeconds: 900, maxTimeoutSeconds: 1500, phaseTimeoutSeconds: 2400 });
  });

  it("clamps to the operator ceiling before rounding", () => {
    expect(effectiveGate({ timeoutSeconds: 5000 }, operator).timeoutSeconds).toBe(1500);
  });

  it("every value in the effective block is an integer the bash gate accepts", () => {
    const gate = effectiveGate({ timeoutSeconds: 1234.01 }, defaultGateConfig());
    for (const v of Object.values(gate)) expect(String(v)).toMatch(/^[0-9]+$/);
  });
});
