import { describe, it, expect } from "vitest";
import { Rfc1123Label } from "#src/sandbox/k8s/resource-name.js";
import { podNameFor } from "#src/sandbox/k8s/naming.js";
import { pvcNameFor } from "#src/sandbox/k8s/pvc.js";
import { secretNameFor } from "#src/sandbox/k8s/secret.js";

describe("Rfc1123Label.slug", () => {
  it("lowercases and collapses runs of non-alnum characters to a single '-'", () => {
    expect(Rfc1123Label.slug("MyRepo/PR#12_build-ABCDEF").value).toBe("myrepo-pr-12-build-abcdef");
  });

  it("strips leading and trailing '-' left by sanitizing", () => {
    expect(Rfc1123Label.slug("###/@@@").value).toBe("");
    expect(Rfc1123Label.slug("-leading-and-trailing-").value).toBe("leading-and-trailing");
  });

  it("prepends an optional prefix before truncating", () => {
    expect(Rfc1123Label.slug("acme-web-pr12", { prefix: "ws-" }).value).toBe("ws-acme-web-pr12");
  });

  it("truncates to maxLength (default 63) and strips any trailing '-' left by truncation", () => {
    const label = Rfc1123Label.slug("x".repeat(70));
    expect(label.value.length).toBeLessThanOrEqual(63);
    expect(label.value).toBe("x".repeat(63));
  });

  it("honours a caller-supplied maxLength", () => {
    const label = Rfc1123Label.slug("abcdefghij", { maxLength: 5 });
    expect(label.value).toBe("abcde");
  });
});

describe("Rfc1123Label.withSuffix", () => {
  it("appends '-<suffix>' when the result fits within 63 chars", () => {
    const label = Rfc1123Label.slug("ll-x-abc123").withSuffix("creds");
    expect(label.value).toBe("ll-x-abc123-creds");
  });

  it("throws a clear error when the result would exceed 63 chars", () => {
    const atCap = Rfc1123Label.slug("x".repeat(70)); // truncated to exactly 63 chars
    expect(() => atCap.withSuffix("creds")).toThrow(/63/);
  });
});

describe("golden: podNameFor/pvcNameFor/secretNameFor stay byte-for-byte unchanged", () => {
  it.each([
    ["MyRepo/PR#12_build-ABCDEF"],
    ["acme-web-pr12"],
    ["Acme/Web#PR12"],
    ["t"],
    [""],
    ["###/@@@"],
  ])("pins current output for taskId=%j", (taskId) => {
    const pod = podNameFor(taskId, "run");
    expect(pvcNameFor(taskId)).toMatch(/^ws(-[a-z0-9][-a-z0-9]*)?$/);
    expect(secretNameFor(pod, "creds")).toBe(`${pod.value}-creds`);
    expect(secretNameFor(pod, "prompt")).toBe(`${pod.value}-prompt`);
  });

  const GOLDEN: Record<string, { podName: string; pvcName: string }> = {
    "MyRepo/PR#12_build-ABCDEF": {
      podName: "ll-myrepo-pr-12-build-abcdef-run-6c83f751",
      pvcName: "ws-myrepo-pr-12-build-abcdef",
    },
    "acme-web-pr12": { podName: "ll-acme-web-pr12-run-e4929cde", pvcName: "ws-acme-web-pr12" },
    "Acme/Web#PR12": { podName: "ll-acme-web-pr12-run-afdb0bba", pvcName: "ws-acme-web-pr12" },
    "t": { podName: "ll-t-run-f5fe7c8d", pvcName: "ws-t" },
    "": { podName: "ll-run-d7f48d67", pvcName: "ws" },
    "###/@@@": { podName: "ll-run-499d6c20", pvcName: "ws" },
  };

  it.each(Object.entries(GOLDEN))("matches the pre-refactor literal output for taskId=%j", (
    taskId,
    expected,
  ) => {
    const pod = podNameFor(taskId, "run");
    expect(pod.value).toBe(expected.podName);
    expect(pvcNameFor(taskId)).toBe(expected.pvcName);
    expect(secretNameFor(pod, "creds")).toBe(`${expected.podName}-creds`);
  });
});
