/**
 * Provider endpoint overrides, end to end through config (issue #373).
 *
 * The unit-level resolution lives in `tests/providers.test.ts`; what this file
 * pins is the wiring — that an overlay/env override reaches the process-wide
 * registry, and that the two consumers which would otherwise leak to the vendor
 * (the cheap `llm.ts` helper and the sandbox egress allowlist) follow it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import {
  providerRegistry,
  providerEndpointOverrides,
  resetProviderRegistry,
} from "#src/config/provider-registry.js";
import { defaultAllowlist } from "#src/sandbox/egress-allowlist.js";

function overlayWith(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "lastlight-providers-test-"));
  writeFileSync(join(dir, "config.yaml"), yaml);
  return dir;
}

describe("providers: config block", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "LASTLIGHT_OVERLAY_DIR", "LASTLIGHT_PROVIDERS", "ANTHROPIC_BASE_URL", "LASTLIGHT_ALLOW_INSECURE_PROVIDER_URLS"]) {
      vi.stubEnv(k, "");
    }
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
    resetProviderRegistry();
  });

  it("leaves every endpoint at its vendor default when nothing is configured", () => {
    loadConfig();
    expect(providerRegistry().byPrefix("anthropic")!.baseUrl).toBe("https://api.anthropic.com/v1");
    expect(providerEndpointOverrides()).toBeUndefined();
    expect(defaultAllowlist()).toContain("anthropic.com");
  });

  it("an overlay override reaches the registry, the egress allowlist and the sandbox payload", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("providers:\n  anthropic:\n    baseUrl: https://gateway.internal/anthropic\n"),
    );
    loadConfig();
    expect(providerRegistry().byPrefix("anthropic")!.baseUrl).toBe("https://gateway.internal/anthropic");
    // The firewall follows the URL — otherwise the sandbox is denied its own gateway.
    expect(defaultAllowlist()).toContain("gateway.internal");
    expect(defaultAllowlist()).not.toContain("anthropic.com");
    // No `apiKeyEnv`: the endpoint moved but the credential did not, so pi keeps
    // resolving it in-sandbox — which is what an OAuth login on `anthropic` needs.
    expect(providerEndpointOverrides()).toEqual({
      anthropic: {
        baseUrl: "https://gateway.internal/anthropic",
        api: "anthropic-messages",
      },
    });
  });

  it("forwards the key env var only when the deployment named one", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith(
        "providers:\n  anthropic:\n    baseUrl: https://gateway.internal/anthropic\n    envKey: GATEWAY_API_KEY\n",
      ),
    );
    loadConfig();
    expect(providerEndpointOverrides()!.anthropic.apiKeyEnv).toBe("GATEWAY_API_KEY");
    // …and it is the var the harness forwards into the sandbox, too.
    expect(providerRegistry().envKeys).toContain("GATEWAY_API_KEY");
  });

  it("a custom provider carries its own env key into the forwarded env keys", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("providers:\n  acme:\n    baseUrl: https://llm.corp.example/v1\n    envKey: ACME_KEY\n"),
    );
    loadConfig();
    expect(providerRegistry().envKeys).toContain("ACME_KEY");
    expect(providerEndpointOverrides()!.acme.baseUrl).toBe("https://llm.corp.example/v1");
    expect(providerEndpointOverrides()!.acme.apiKeyEnv).toBe("ACME_KEY");
  });

  it("ANTHROPIC_BASE_URL overrides the overlay, per prefix", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith(
        "providers:\n  anthropic:\n    baseUrl: https://overlay.example/anthropic\n  acme:\n    baseUrl: https://acme.example/v1\n",
      ),
    );
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://env.example/anthropic");
    loadConfig();
    expect(providerRegistry().byPrefix("anthropic")!.baseUrl).toBe("https://env.example/anthropic");
    // …and the sibling entry survives: env merges per prefix, it doesn't replace the block.
    expect(providerRegistry().byPrefix("acme")!.baseUrl).toBe("https://acme.example/v1");
  });

  it("LASTLIGHT_PROVIDERS is the env route for a provider the registry has never heard of", () => {
    vi.stubEnv("LASTLIGHT_PROVIDERS", JSON.stringify({ acme: { baseUrl: "https://gw/v1", envKey: "ACME_KEY" } }));
    loadConfig();
    expect(providerRegistry().byPrefix("acme")!.baseUrl).toBe("https://gw/v1");
  });

  /**
   * Deliberately the same shape as `LASTLIGHT_MODEL` vs `LASTLIGHT_MODELS` in the
   * same function — the scalar var is written first and the JSON map lands on
   * top. Consistency across the env layer beats a per-block "more specific wins"
   * rule that would make one map behave unlike its siblings.
   */
  it("LASTLIGHT_PROVIDERS lands on top of the per-provider _BASE_URL var", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://named.example/anthropic");
    vi.stubEnv("LASTLIGHT_PROVIDERS", JSON.stringify({ anthropic: { baseUrl: "https://json.example/anthropic" } }));
    loadConfig();
    expect(providerRegistry().byPrefix("anthropic")!.baseUrl).toBe("https://json.example/anthropic");
  });

  it("the two env sources merge per key when they name different providers", () => {
    vi.stubEnv("ANTHROPIC_BASE_URL", "https://named.example/anthropic");
    vi.stubEnv("LASTLIGHT_PROVIDERS", JSON.stringify({ acme: { baseUrl: "https://json.example/v1" } }));
    loadConfig();
    expect(providerRegistry().byPrefix("anthropic")!.baseUrl).toBe("https://named.example/anthropic");
    expect(providerRegistry().byPrefix("acme")!.baseUrl).toBe("https://json.example/v1");
  });

  it("fails the boot on a bad override rather than quietly using the vendor", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("providers:\n  anthropic:\n    baseUrl: http://gw.internal/v1\n"));
    expect(() => loadConfig()).toThrow(/non-loopback host/);
  });

  it("accepts a plaintext gateway when the operator explicitly allows it", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("providers:\n  anthropic:\n    baseUrl: http://gw.internal/v1\n"));
    vi.stubEnv("LASTLIGHT_ALLOW_INSECURE_PROVIDER_URLS", "1");
    loadConfig();
    expect(providerRegistry().byPrefix("anthropic")!.baseUrl).toBe("http://gw.internal/v1");
  });
});
