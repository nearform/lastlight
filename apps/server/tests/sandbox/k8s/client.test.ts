import { describe, it, expect } from "vitest";
import { KubeConfig, CustomObjectsApi } from "@kubernetes/client-node";
import { makeK8sApis, inClusterConfigAvailable } from "#src/sandbox/k8s/client.js";

describe("makeK8sApis", () => {
  it("builds core + log clients from an injected KubeConfig", () => {
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: "c", server: "http://127.0.0.1:1" }],
      users: [{ name: "u" }],
      contexts: [{ name: "x", cluster: "c", user: "u" }],
      currentContext: "x",
    });
    const apis = makeK8sApis(kc);
    expect(apis.core).toBeDefined();
    expect(apis.log).toBeDefined();
  });

  it("exposes a CustomObjectsApi client for CiliumNetworkPolicy", () => {
    const kc = new KubeConfig();
    kc.loadFromOptions({
      clusters: [{ name: "c", server: "https://example.test" }],
      users: [{ name: "u" }],
      contexts: [{ name: "ctx", cluster: "c", user: "u" }],
      currentContext: "ctx",
    });
    const apis = makeK8sApis(kc);
    expect(apis.custom).toBeInstanceOf(CustomObjectsApi);
  });
});

describe("inClusterConfigAvailable", () => {
  // Regression: loadFromCluster() does NOT throw off-cluster in
  // @kubernetes/client-node 1.4.0 — it builds https://undefined:undefined.
  // So we select the source by KUBERNETES_SERVICE_HOST, not by catching.
  it("is true only when KUBERNETES_SERVICE_HOST is set (in a Pod)", () => {
    expect(inClusterConfigAvailable({ KUBERNETES_SERVICE_HOST: "10.0.0.1" })).toBe(true);
  });
  it("is false off-cluster (no service-host env → use local kubeconfig)", () => {
    expect(inClusterConfigAvailable({})).toBe(false);
    expect(inClusterConfigAvailable({ KUBERNETES_SERVICE_HOST: "" })).toBe(false);
  });
});
