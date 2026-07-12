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

export function resolveModel(spec: string, registry: ModelRegistry): Model<any> {
  const { provider, modelId } = parseModelSpec(spec);

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
