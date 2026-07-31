/**
 * Uniform config precedence resolution (issue #99).
 *
 * Takes three plain-object layers — default YAML, overlay YAML, and a
 * materialized env layer — and produces one merged config tree where every
 * leaf carries its provenance (which layer supplied it). This is a pure
 * function: it reads no environment and performs no parsing. `loadConfig`
 * is responsible for building the `env` layer (the one place that knows how
 * env vars like LASTLIGHT_MODELS map onto config paths) and feeding it in.
 *
 * Precedence per leaf path: env > overlay > default. Nested mappings are
 * merged key-by-key so each leaf resolves (and is attributed) independently;
 * arrays and scalars are replaced wholesale by the highest layer that
 * supplies them.
 *
 * A fourth layer, `repo`, exists but is deliberately NOT part of the boot
 * resolution above: it is a managed repo's own `.lastlight/lastlight.yml`
 * (issue #180), which is per-repo and per-run rather than per-process. It is
 * applied on top of the boot result — with the *same* merge semantics — via
 * {@link resolveWithExtraLayer}, so the repo layer can never diverge from how
 * the operator's own layers combine. See `src/config/repo-config.ts` for the
 * allow-listing and bounds that gate what may appear in that layer.
 *
 * The merge itself ({@link mergeLayer}) is DEFINED in
 * `packages/shared/src/repo-config-schema.ts` and re-exported here, not copied:
 * the repo layer is bounded and merged by that leaf package (the `lastlight`
 * CLI validates `.lastlight/` offline and may never gain an edge to core), so
 * shared is the only place both consumers can reach. This module keeps the boot
 * layering — the ordering, the `ConfigLayers` shape, the seam — and borrows the
 * one function whose semantics must be identical everywhere.
 */

import { mergeLayer } from "lastlight-shared/repo-config-schema";

/**
 * The merge primitive, re-exported so `src/config/config-resolve.js` stays the
 * single import surface for core's config layering. Most callers want
 * {@link resolveConfigLayers} or {@link resolveWithExtraLayer} instead; this is
 * for callers that already own their accumulators (and for tests).
 */
export { mergeLayer };

export type ConfigSource = "default" | "overlay" | "env" | "repo";

export interface ConfigLayers {
  default: Record<string, unknown>;
  overlay: Record<string, unknown> | null;
  env: Record<string, unknown>;
}

export interface ResolvedConfig {
  /** Merged plain config tree (env > overlay > default). */
  value: Record<string, unknown>;
  /** Mirror of `value`; object nodes stay nested, leaves are a ConfigSource. */
  sources: Record<string, unknown>;
}

export function resolveConfigLayers(layers: ConfigLayers): ResolvedConfig {
  const ordered: Array<[ConfigSource, Record<string, unknown>]> = [
    ["default", layers.default],
    ["overlay", layers.overlay ?? {}],
    ["env", layers.env],
  ];
  const value: Record<string, unknown> = {};
  const sources: Record<string, unknown> = {};
  for (const [source, layer] of ordered) {
    mergeLayer(value, sources, layer, source);
  }
  return { value, sources };
}

/**
 * Apply ONE extra layer on top of an already-resolved tree, returning a new
 * result — the inputs are cloned, never mutated, so the caller's boot config
 * survives a per-run merge unchanged.
 *
 * This is the seam the per-repo config layer (issue #180) merges through. It
 * exists so the repo layer gets byte-for-byte the same semantics as the boot
 * layers (plain objects deep-merge key-by-key; arrays and scalars replace
 * wholesale) rather than a second, subtly-different merge implementation.
 * Whatever bounds the caller wants — allow-lists, value validation — must be
 * applied to `layer` BEFORE calling this; this function trusts what it is given.
 */
export function resolveWithExtraLayer(
  base: Record<string, unknown>,
  sources: Record<string, unknown>,
  layer: Record<string, unknown>,
  source: ConfigSource,
): ResolvedConfig {
  const value = structuredClone(base);
  const nextSources = structuredClone(sources);
  mergeLayer(value, nextSources, layer, source);
  return { value, sources: nextSources };
}
