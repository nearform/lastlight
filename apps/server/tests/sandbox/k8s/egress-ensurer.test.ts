import { describe, it, expect, vi } from "vitest";
import { ApiException } from "@kubernetes/client-node";
import { EgressEnsurer } from "#src/sandbox/k8s/egress-ensurer.js";
import type { HarnessSelector } from "#src/sandbox/k8s/egress-policy.js";

const harness: HarnessSelector = {
  namespace: "lastlight",
  labels: { "app.kubernetes.io/name": "lastlight" },
  port: 8644,
};

function fakeCustom() {
  return { createNamespacedCustomObject: vi.fn(async () => ({})) } as any;
}

describe("EgressEnsurer", () => {
  it("applies the policy pair once per namespace, memoized across calls", async () => {
    const custom = fakeCustom();
    const ensurer = new EgressEnsurer();
    await ensurer.ensure(custom, "ns-a", ["example.com"], harness);
    await ensurer.ensure(custom, "ns-a", ["example.com"], harness);
    // strict + open applied once, NOT twice — the second `ensure()` call hits
    // the memoized promise instead of re-applying.
    expect(custom.createNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it("a fresh instance re-applies for the same namespace (per-instance isolation)", async () => {
    const custom = fakeCustom();
    const first = new EgressEnsurer();
    await first.ensure(custom, "ns-shared", ["example.com"], harness);
    expect(custom.createNamespacedCustomObject).toHaveBeenCalledTimes(2);

    const second = new EgressEnsurer();
    await second.ensure(custom, "ns-shared", ["example.com"], harness);
    expect(custom.createNamespacedCustomObject).toHaveBeenCalledTimes(4);
  });

  it("a 403 (RBAC not yet granted) warns once and resolves — default-allow", async () => {
    const custom = {
      createNamespacedCustomObject: vi.fn(async () => {
        throw new ApiException(403, "Forbidden", {}, {});
      }),
    } as any;
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const ensurer = new EgressEnsurer();
      await expect(ensurer.ensure(custom, "ns-403", [], harness)).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledTimes(1);

      // Cached: a second call on the SAME instance doesn't re-warn.
      await ensurer.ensure(custom, "ns-403", [], harness);
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("a non-403 error rejects and clears the cache so a later call retries", async () => {
    const custom = {
      createNamespacedCustomObject: vi
        .fn()
        .mockRejectedValueOnce(new ApiException(500, "Server Error", {}, {}))
        .mockResolvedValue({}),
    } as any;
    const ensurer = new EgressEnsurer();

    await expect(ensurer.ensure(custom, "ns-500", [], harness)).rejects.toThrow();
    expect(custom.createNamespacedCustomObject).toHaveBeenCalledTimes(1);

    await ensurer.ensure(custom, "ns-500", [], harness);
    expect(custom.createNamespacedCustomObject.mock.calls.length).toBeGreaterThan(1);
  });
});
