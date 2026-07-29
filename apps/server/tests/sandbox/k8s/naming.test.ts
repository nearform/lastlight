import { describe, it, expect } from "vitest";
import { podNameFor } from "#src/sandbox/k8s/naming.js";
import { secretNameFor } from "#src/sandbox/k8s/secret.js";

describe("podNameFor", () => {
  it("produces an RFC-1123 label ≤63 chars", () => {
    const name = podNameFor("MyRepo/PR#12_build-ABCDEF", "run").value;
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
    expect(name.startsWith("ll-")).toBe(true);
  });
  it("is deterministic for the same input", () => {
    expect(podNameFor("t", "run").value).toBe(podNameFor("t", "run").value);
  });
  it.each([
    ["empty string", ""],
    ["symbol-only", "###/@@@"],
    ["over-63-char taskId", "x".repeat(200)],
  ])("produces a valid RFC-1123 label for %s", (_label, taskId) => {
    const name = podNameFor(taskId, "run").value;
    expect(name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(name.length).toBeLessThanOrEqual(63);
  });
});

describe("secretNameFor's type-enforced 63-char invariant (F6)", () => {
  // secretNameFor(podName: Rfc1123Label, ...) — not `string` — so the ONLY
  // way to reach it is this exact flow: taskId -> podNameFor -> secretNameFor.
  // A hand-built string is rejected at compile time (verified separately via
  // `pnpm run typecheck:test`, not expressible as a runtime assertion here),
  // which is what makes "a Secret name is only ever derived from a pod name"
  // a structural fact instead of a prose contract. podNameFor's own budget
  // then guarantees this end-to-end flow never overflows; the `withSuffix`
  // throw the invariant relies on is covered directly, with a hand-built
  // over-length label, in resource-name.test.ts — it's unreachable from this
  // pipeline precisely because the type system closes off any other route in.
  it("stays within 63 chars end-to-end for a max-length taskId", () => {
    const podLabel = podNameFor("x".repeat(80), "run");
    const secretName = secretNameFor(podLabel, "prompt");
    expect(secretName).toBe(`${podLabel.value}-prompt`);
    expect(secretName.length).toBeLessThanOrEqual(63);
  });
});
