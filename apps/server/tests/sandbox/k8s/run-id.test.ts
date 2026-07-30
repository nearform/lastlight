import { describe, it, expect } from "vitest";
import { RunId } from "#src/sandbox/k8s/run-id.js";
import { buildPodManifest, RUN_ID_LABEL } from "#src/sandbox/k8s/pod.js";
import { buildPvcManifest } from "#src/sandbox/k8s/pvc.js";
import { pvcsToReclaim } from "#src/sandbox/k8s/reclaim.js";
import { sanitizeLabelValue } from "#src/sandbox/k8s/naming.js";

describe("RunId.from", () => {
  it("sanitizes the raw id the same way sanitizeLabelValue does", () => {
    const raw = "Run With!Odd.Chars_42";
    expect(RunId.from(raw).label).toBe(sanitizeLabelValue(raw));
  });

  it("lowercases and strips disallowed characters (mixed-case/odd-char raw id)", () => {
    const raw = "Mixed-CASE/Run#1 (feature)";
    expect(RunId.from(raw).label).toBe(sanitizeLabelValue(raw));
    expect(RunId.from(raw).label).toMatch(/^[a-z0-9._-]+$/);
  });

  it("matchLabels() returns RUN_ID_LABEL keyed on the sanitized label", () => {
    const runId = RunId.from("Odd Run ID!!");
    expect(runId.matchLabels()).toEqual({ [RUN_ID_LABEL]: runId.label });
  });
});

describe("RunId stamp/select symmetry", () => {
  it("a Pod stamped with a RunId carries exactly the label matchLabels() names", () => {
    const runId = RunId.from("Odd Run ID!!");
    const pod = buildPodManifest({
      name: "ll-x",
      namespace: "ns",
      image: "img",
      command: ["sh", "-c", "true"],
      envFromSecret: "ll-x-creds",
      cwd: "/home/agent/workspace",
      activeDeadlineSeconds: 1800,
      runAsUser: 10001,
      workspace: { kind: "emptyDir" },
      egressPolicy: "strict",
      runId,
    });
    expect(pod.metadata?.labels?.[RUN_ID_LABEL]).toBe(runId.label);
  });

  it("a PVC stamped with the SAME RunId is exactly what reclaim's run-selector matches", () => {
    const runId = RunId.from("Odd Run ID!!");
    const pvc = buildPvcManifest({
      name: "ws-x",
      namespace: "ns",
      storageClassName: "sc",
      size: "5Gi",
      runId,
    });
    const matched = pvcsToReclaim([pvc], { kind: "run", runId }, new Set(), 0);
    expect(matched).toEqual([pvc]);
  });

  it("two RunIds derived from the same raw id select each other's stamped objects", () => {
    // Stamp and select derived independently (mirrors production: `provision()`
    // stamps via one `RunId.from(pre.runId)` call, `cancel` selects via another) —
    // must still compare equal on `.label`.
    const stampId = RunId.from("PR-123/build");
    const selectId = RunId.from("PR-123/build");
    const pvc = buildPvcManifest({
      name: "ws-y",
      namespace: "ns",
      storageClassName: "sc",
      size: "5Gi",
      runId: stampId,
    });
    const matched = pvcsToReclaim([pvc], { kind: "run", runId: selectId }, new Set(), 0);
    expect(matched).toEqual([pvc]);
  });
});
