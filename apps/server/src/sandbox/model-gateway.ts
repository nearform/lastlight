/**
 * The model gateway (docker backend only).
 *
 * A custom provider with `sandboxGateway: true` never hands its key to a docker
 * sandbox. The sandbox gets a placeholder key and a base URL on the gateway
 * sidecar (`model-gateway`, on the sandbox egress network); the gateway strips
 * whatever credential the client sent, adds the real key and the provider's
 * literal headers, and forwards over HTTPS. The real key lives only in the
 * server's env and in the gateway's mode-0600 config.
 *
 * Kept free of imports from `egress-firewall-config.ts`: that module imports the
 * allowlist, which imports this one.
 */
import type { ProviderEndpoint } from "lastlight-shared/providers";
import type { SandboxBackend } from "../config/config.js";
import { providerRegistry, type WireEndpoint } from "../config/provider-registry.js";

/** The gateway's fixed address on `SANDBOX_EGRESS_SUBNET` (172.30.0.0/24). */
export const MODEL_GATEWAY_IP = "172.30.0.40";
export const MODEL_GATEWAY_PORT = 80;
/** What the sandbox holds instead of the key. The gateway overwrites it. */
export const MODEL_GATEWAY_KEY_PLACEHOLDER = "lastlight-model-gateway";

/** The in-sandbox base URL for a gateway provider: one path prefix per provider. */
export function modelGatewayBaseUrl(prefix: string): string {
  return `http://${MODEL_GATEWAY_IP}/${prefix}`;
}

/** The providers this deployment routes through the gateway. */
export function gatewayEndpoints(): readonly ProviderEndpoint[] {
  return providerRegistry().endpoints.filter((e) => e.sandboxGateway === true);
}

/**
 * Swap a gateway provider's key and base URL for the placeholder and the
 * gateway URL, for docker runs. Pure: returns new objects. Every other backend
 * gets its inputs back, since gondolin and none make the model call host-side
 * and smol/kubernetes refuse `sandboxGateway` at config load.
 *
 * The placeholder is set even when the key is absent from `env`, so pi always
 * has a key to send and the gateway always has one to replace.
 */
export function applyModelGateway(
  env: Record<string, string>,
  wire: Record<string, WireEndpoint> | undefined,
  backend: SandboxBackend,
): { env: Record<string, string>; wire: Record<string, WireEndpoint> | undefined } {
  const gated = backend === "docker" ? gatewayEndpoints() : [];
  if (gated.length === 0) return { env, wire };
  const outEnv = { ...env };
  const outWire: Record<string, WireEndpoint> = { ...(wire ?? {}) };
  for (const e of gated) {
    outEnv[e.envKey] = MODEL_GATEWAY_KEY_PLACEHOLDER;
    const current = outWire[e.prefix];
    if (current) outWire[e.prefix] = { ...current, baseUrl: modelGatewayBaseUrl(e.prefix) };
  }
  return { env: outEnv, wire: outWire };
}
