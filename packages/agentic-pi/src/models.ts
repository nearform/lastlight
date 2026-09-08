/**
 * Resolve a "provider/model_id" string to a Pi Model object.
 *
 * Falls back to the ModelRegistry for custom models when a provider/id is not
 * recognised by the built-in registry.
 */

// pi 0.80 moved the static catalog read off the pi-ai root: `getModel` now lives
// in providers/all as `getBuiltinModel` (the root/`compat` aliases are deprecated).
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import type { Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { ProviderEndpointOverrides } from "./providers.js";

export function parseModelSpec(spec: string): { provider: string; modelId: string } {
  const idx = spec.indexOf("/");
  if (idx < 0) throw new Error(`model spec must be 'provider/id', got '${spec}'`);
  const provider = spec.slice(0, idx);
  const modelId = spec.slice(idx + 1);
  if (!provider || !modelId) {
    throw new Error(`model spec must be 'provider/id', got '${spec}'`);
  }
  return { provider, modelId };
}

export function resolveModel(
  spec: string,
  registry: ModelRegistry,
  overrides: ProviderEndpointOverrides = {},
): Model<any> {
  const { provider, modelId } = parseModelSpec(spec);

  // An endpoint override (lastlight#373) was registered on the runtime, so the
  // REGISTRY is authoritative for that provider — it composes the override over
  // the built-in entry. Checking the static catalog first would hand back the
  // vendor's baseUrl and quietly ignore the gateway the operator configured.
  if (overrides[provider]) {
    const overridden = registry.find(provider, modelId);
    if (overridden) return overridden;
  }

  // The types of getBuiltinModel are narrow keyof MODELS — runtime accepts strings.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const builtin = (getBuiltinModel as unknown as (p: string, m: string) => Model<any> | undefined)(
    provider,
    modelId,
  );
  if (builtin) return builtin;

  const custom = registry.find(provider, modelId);
  if (custom) return custom;

  throw new Error(`unknown model: ${spec}`);
}

/** Advertised limits for a model on a provider pi has no catalog entry for. */
const CUSTOM_MODEL_CONTEXT_WINDOW = 128_000;
const CUSTOM_MODEL_MAX_TOKENS = 16_384;

/**
 * Register each endpoint override on the model runtime, through pi's own
 * `registerProvider` seam (lastlight#373).
 *
 * Two shapes, and the difference is whether pi's catalog knows the model:
 *
 *   - **known** — register `{ baseUrl }` alone. pi maps every built-in model of
 *     that provider onto the new base URL and keeps its auth, cost table and
 *     request quirks. One line moves Anthropic to a gateway.
 *   - **unknown** — nothing to inherit, so the model being run is defined here:
 *     its api family, its endpoint, and an `$ENV_VAR` API-key reference (pi
 *     resolves that against the process env at request time, so the key is
 *     never embedded in config). Cost is registered as ZERO — a gateway
 *     publishes no price list, so a run against a custom provider reports no
 *     spend rather than a wrong one.
 *
 * Best-effort per provider: a bad entry warns and is skipped rather than
 * failing the run, EXCEPT for the provider of the model being run — that one is
 * the whole point of the override, and continuing would send the prompt to the
 * vendor instead.
 */
export function registerProviderOverrides(
  registry: ModelRegistry,
  overrides: ProviderEndpointOverrides,
  modelSpec: string,
  onWarn: (msg: string) => void = () => undefined,
): void {
  const { provider: runProvider, modelId: runModelId } = parseModelSpec(modelSpec);
  for (const [prefix, override] of Object.entries(overrides)) {
    const isRunProvider = prefix === runProvider;
    try {
      const modelId = isRunProvider ? runModelId : undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const builtin = modelId
        ? (getBuiltinModel as unknown as (p: string, m: string) => Model<any> | undefined)(prefix, modelId)
        : undefined;
      if (builtin) {
        registry.registerProvider(prefix, { baseUrl: override.baseUrl });
        continue;
      }
      if (!modelId) {
        // Not the model we're running and not obviously built-in: a baseUrl-only
        // registration still moves that provider's catalog if it has one.
        registry.registerProvider(prefix, { baseUrl: override.baseUrl });
        continue;
      }
      registry.registerProvider(prefix, {
        name: prefix,
        baseUrl: override.baseUrl,
        api: override.api ?? "openai-completions",
        apiKey: `$${override.apiKeyEnv ?? defaultApiKeyEnv(prefix)}`,
        models: [
          {
            id: modelId,
            name: modelId,
            api: override.api ?? "openai-completions",
            baseUrl: override.baseUrl,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: override.contextWindow ?? CUSTOM_MODEL_CONTEXT_WINDOW,
            maxTokens: override.maxTokens ?? CUSTOM_MODEL_MAX_TOKENS,
          },
        ],
      });
    } catch (err) {
      const msg = `provider override for '${prefix}' rejected: ${err instanceof Error ? err.message : String(err)}`;
      if (isRunProvider) throw new Error(msg);
      onWarn(msg);
    }
  }
}

function defaultApiKeyEnv(prefix: string): string {
  return `${prefix.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}
