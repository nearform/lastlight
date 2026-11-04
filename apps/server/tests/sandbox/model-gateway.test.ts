/**
 * The model gateway (docker backend): the sandbox gets a placeholder key and
 * the gateway's URL for a `sandboxGateway` provider; the real key stays with
 * the gateway sidecar.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installProviderOverrides, resetProviderRegistry } from "#src/config/provider-registry.js";
import {
  applyModelGateway,
  gatewayEndpoints,
  MODEL_GATEWAY_KEY_PLACEHOLDER,
  modelGatewayBaseUrl,
} from "#src/sandbox/model-gateway.js";

const REAL_KEY = "sk-test-not-a-real-key";

function wireFor(extra: Record<string, unknown> = {}) {
  return {
    acme: {
      baseUrl: "https://gw.example/v1",
      api: "openai-completions",
      apiKeyEnv: "ACME_API_KEY",
      headers: { "x-cmd-zdr": "1" },
      ...extra,
    },
  };
}

describe("model gateway", () => {
  beforeEach(() => {
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1", sandboxGateway: true } });
  });
  afterEach(() => resetProviderRegistry());

  it("exposes the gateway URL per provider prefix", () => {
    expect(modelGatewayBaseUrl("acme")).toBe("http://172.30.0.40/acme");
    expect(MODEL_GATEWAY_KEY_PLACEHOLDER).toBe("lastlight-model-gateway");
    expect(gatewayEndpoints().map((e) => e.prefix)).toEqual(["acme"]);
  });

  it("docker: the real key is replaced by the placeholder and the URL points at the gateway", () => {
    const { env, wire } = applyModelGateway({ ACME_API_KEY: REAL_KEY, GITHUB_TOKEN: "t" }, wireFor(), "docker");
    expect(env.ACME_API_KEY).toBe("lastlight-model-gateway");
    expect(env.GITHUB_TOKEN).toBe("t");
    expect(wire!.acme.baseUrl).toBe("http://172.30.0.40/acme");
    expect(wire!.acme.headers).toEqual({ "x-cmd-zdr": "1" });
    expect(JSON.stringify({ env, wire })).not.toContain(REAL_KEY);
  });

  it("docker: sets the placeholder even when the key was absent from env", () => {
    const { env } = applyModelGateway({}, wireFor(), "docker");
    expect(env.ACME_API_KEY).toBe("lastlight-model-gateway");
  });

  it("gondolin/none: unchanged (the model call is host-side)", () => {
    for (const backend of ["gondolin", "none"] as const) {
      const inEnv = { ACME_API_KEY: REAL_KEY };
      const inWire = wireFor();
      const { env, wire } = applyModelGateway(inEnv, inWire, backend);
      expect(env.ACME_API_KEY).toBe(REAL_KEY);
      expect(wire!.acme.baseUrl).toBe("https://gw.example/v1");
    }
  });

  it("a provider without sandboxGateway keeps its real key and URL", () => {
    resetProviderRegistry();
    installProviderOverrides({ acme: { baseUrl: "https://gw.example/v1" } });
    const { env, wire } = applyModelGateway({ ACME_API_KEY: REAL_KEY }, wireFor(), "docker");
    expect(env.ACME_API_KEY).toBe(REAL_KEY);
    expect(wire!.acme.baseUrl).toBe("https://gw.example/v1");
  });

  it("does not mutate its inputs", () => {
    const inEnv = { ACME_API_KEY: REAL_KEY };
    const inWire = wireFor();
    applyModelGateway(inEnv, inWire, "docker");
    expect(inEnv.ACME_API_KEY).toBe(REAL_KEY);
    expect(inWire.acme.baseUrl).toBe("https://gw.example/v1");
  });
});
