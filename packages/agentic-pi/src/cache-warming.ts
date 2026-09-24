/**
 * Prompt-cache warming policy.
 *
 * Pi 0.86 added cost-aware cache warming, on by default (`"streaming"`): while
 * a long tool call runs, Pi replays the request with a one-token output cap to
 * keep the provider's prompt cache alive. Every replay is a billed request.
 * For a one-shot worker that is a spend change nobody opted into, so
 * agentic-pi vetoes warming unless the operator's settings.json names a mode.
 *
 * Why a veto instead of a setting: Pi reads the mode from GLOBAL settings only
 * (`getCacheWarmingMode`, "because warming costs money"), so
 * `applyOverrides()` cannot reach it, and `setCacheWarmingMode()` would write
 * the operator's file. The public seam left is the `cache_warming_decision`
 * extension event. Pi awaits it before sending each refresh, and `"stop"`
 * cancels that refresh.
 */

import type { CacheWarmingMode, ExtensionFactory } from "@earendil-works/pi-coding-agent";

/**
 * The inline extension that disables warming, or `undefined` when the operator
 * chose a mode explicitly (their choice stands, `"off"` included).
 */
export function cacheWarmingVeto(
  operatorMode: CacheWarmingMode | undefined,
): ExtensionFactory | undefined {
  if (operatorMode !== undefined) return undefined;
  return (pi) => {
    pi.on("cache_warming_decision", () => ({ action: "stop" }));
  };
}
