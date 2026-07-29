import { describe, it, expect, vi } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { applyEgressPolicies } from "#src/sandbox/k8s/egress-apply.js";
import { STRICT_POLICY_NAME, OPEN_POLICY_NAME } from "#src/sandbox/k8s/egress-policy.js";

function apiError(code: number): ApiException<unknown> {
  return new ApiException(code, "boom", {}, {});
}

describe("applyEgressPolicies", () => {
  it("creates both policies when neither exists", async () => {
    const create = vi.fn().mockResolvedValue({});
    const custom = { createNamespacedCustomObject: create } as any;
    await applyEgressPolicies(custom, { namespace: "ns", hosts: ["github.com"] });
    const names = create.mock.calls.map((c) => c[0].body.metadata.name);
    expect(names).toContain(STRICT_POLICY_NAME);
    expect(names).toContain(OPEN_POLICY_NAME);
    expect(create.mock.calls[0][0]).toMatchObject({
      group: "cilium.io",
      version: "v2",
      plural: "ciliumnetworkpolicies",
    });
  });

  it("replaces an existing policy (409) after reading its resourceVersion", async () => {
    const create = vi.fn().mockRejectedValue(apiError(409));
    const get = vi.fn().mockResolvedValue({ metadata: { resourceVersion: "42" } });
    const replace = vi.fn().mockResolvedValue({});
    const custom = {
      createNamespacedCustomObject: create,
      getNamespacedCustomObject: get,
      replaceNamespacedCustomObject: replace,
    } as any;
    await applyEgressPolicies(custom, { namespace: "ns", hosts: ["github.com"] });
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0][0].body.metadata.resourceVersion).toBe("42");
  });

  it("propagates a non-409 error (e.g. 403 — the adapter decides to warn)", async () => {
    const create = vi.fn().mockRejectedValue(apiError(403));
    const custom = { createNamespacedCustomObject: create } as any;
    await expect(
      applyEgressPolicies(custom, { namespace: "ns", hosts: ["github.com"] }),
    ).rejects.toMatchObject({
      code: 403,
    });
  });

  it("applies the toEndpoints harness rule to both policies when harness is passed", async () => {
    const create = vi.fn().mockResolvedValue({});
    const custom = { createNamespacedCustomObject: create } as any;
    const harness = {
      namespace: "lastlight",
      labels: { "app.kubernetes.io/name": "lastlight" },
      port: 8644,
    };
    await applyEgressPolicies(custom, { namespace: "ns", hosts: ["github.com"], harness });
    const bodies = create.mock.calls.map((c) => c[0].body);
    for (const body of bodies) {
      // DNS also uses toEndpoints (to kube-dns) — find the harness-labelled rule specifically.
      const rule = body.spec.egress.find(
        (r: any) => r.toEndpoints?.[0]?.matchLabels?.["app.kubernetes.io/name"] === "lastlight",
      ) as any;
      expect(rule.toEndpoints[0].matchLabels).toMatchObject({
        "k8s:io.kubernetes.pod.namespace": "lastlight",
        "app.kubernetes.io/name": "lastlight",
      });
      expect(rule.toPorts[0].ports).toContainEqual({ port: "8644", protocol: "TCP" });
    }
  });
});
