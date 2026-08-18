import { describe, it, expect, afterEach } from "vitest";
import { resolveKubernetesConfig } from "#src/config/config.js";

const K8S_ENV = [
  "LASTLIGHT_K8S_NAMESPACE", "K8S_SANDBOX_IMAGE",
  "LASTLIGHT_K8S_STORAGE_CLASS", "LASTLIGHT_K8S_WORKSPACE_SIZE", "LASTLIGHT_K8S_RUN_AS_USER",
  "LASTLIGHT_K8S_HARNESS_ENDPOINT", "LASTLIGHT_K8S_HARNESS_NAMESPACE", "LASTLIGHT_K8S_HARNESS_POD_LABELS",
];

describe("resolveKubernetesConfig", () => {
  afterEach(() => { for (const k of K8S_ENV) delete process.env[k]; });

  it("defaults to the nearform-published image, sandbox namespace, and cluster-default storage", () => {
    const cfg = resolveKubernetesConfig();
    expect(cfg.image).toBe("ghcr.io/nearform/lastlight-sandbox:latest");
    expect(cfg.namespace).toBe("lastlight-sandboxes");
    expect(cfg.storageClassName).toBe("");
    expect(cfg.workspaceSize).toBe("5Gi");
    expect(cfg.runAsUser).toBe(10001);
  });

  it("lets env override the image, namespace, and runAsUser", () => {
    process.env.K8S_SANDBOX_IMAGE = "alpine/git:latest";
    process.env.LASTLIGHT_K8S_NAMESPACE = "ll-test";
    process.env.LASTLIGHT_K8S_RUN_AS_USER = "1000";
    const cfg = resolveKubernetesConfig();
    expect(cfg.image).toBe("alpine/git:latest");
    expect(cfg.namespace).toBe("ll-test");
    expect(cfg.runAsUser).toBe(1000);
  });

  it("defaults the harness endpoint + toEndpoints selector", () => {
    // (ensure the three env vars are unset for this case)
    const k = resolveKubernetesConfig();
    expect(k.harnessEndpoint).toBe("http://lastlight.lastlight.svc.cluster.local:8644");
    expect(k.harnessNamespace).toBe("lastlight");
    expect(k.harnessPodLabels).toEqual({ "app.kubernetes.io/name": "lastlight" });
  });

  it("env overrides the harness endpoint + parses pod labels", () => {
    process.env.LASTLIGHT_K8S_HARNESS_ENDPOINT = "http://h.ns.svc:9000";
    process.env.LASTLIGHT_K8S_HARNESS_NAMESPACE = "ll-sys";
    process.env.LASTLIGHT_K8S_HARNESS_POD_LABELS = "app=lastlight,tier=control";
    try {
      const k = resolveKubernetesConfig();
      expect(k.harnessEndpoint).toBe("http://h.ns.svc:9000");
      expect(k.harnessNamespace).toBe("ll-sys");
      expect(k.harnessPodLabels).toEqual({ app: "lastlight", tier: "control" });
    } finally {
      delete process.env.LASTLIGHT_K8S_HARNESS_ENDPOINT;
      delete process.env.LASTLIGHT_K8S_HARNESS_NAMESPACE;
      delete process.env.LASTLIGHT_K8S_HARNESS_POD_LABELS;
    }
  });
});
