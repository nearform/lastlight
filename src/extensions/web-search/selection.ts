/**
 * Provider selection logic — pure, no IO, easy to unit-test.
 *
 * Resolution order:
 *   1. config.webSearch === false   → skipped (disabled-by-flag).
 *   2. Explicit provider (config.webSearchProvider OR WEB_SEARCH_PROVIDER env):
 *        - key present → selected.
 *        - key missing → skipped (no-credentials) naming the env var.
 *   3. Auto: scan env keys in fixed priority Tavily → Exa → Brave.
 *        - first hit wins; if more than one is set, attach an advisory
 *          message so the user can override via WEB_SEARCH_PROVIDER.
 *   4. None present → skipped (no-credentials), silent.
 *   5. Unknown explicit provider name → throw (config error).
 */

import { PROVIDER_NAMES, type ProviderName, type WebSearchSkipReason } from "./types.js";

export interface SelectionInput {
  /** When false, force-skip with reason `disabled-by-flag`. */
  webSearch: boolean;
  /** Explicit provider from --web-search-provider (overrides env). */
  webSearchProvider?: string;
  /** Process env or test override. */
  env: Record<string, string | undefined>;
}

export interface SelectedProvider {
  status: "configured";
  provider: ProviderName;
  apiKey: string;
  /** Optional advisory note (e.g. multi-key collision). */
  message?: string;
}

export interface SkippedProvider {
  status: "skipped";
  reason: WebSearchSkipReason;
  message?: string;
  /** Echoed back when the user explicitly asked for one. */
  provider?: ProviderName;
}

export type SelectionResult = SelectedProvider | SkippedProvider;

/** env var name that holds each provider's key. */
export const PROVIDER_ENV_VAR: Record<ProviderName, string> = {
  tavily: "TAVILY_API_KEY",
  exa: "EXA_API_KEY",
  brave: "BRAVE_SEARCH_API_KEY",
};

/** Priority order for auto-detection. */
const AUTO_PRIORITY: readonly ProviderName[] = ["tavily", "exa", "brave"];

export function isProviderName(s: string): s is ProviderName {
  return (PROVIDER_NAMES as readonly string[]).includes(s);
}

export function selectProvider(input: SelectionInput): SelectionResult {
  if (input.webSearch === false) {
    return { status: "skipped", reason: "disabled-by-flag" };
  }

  const envExplicit = input.env.WEB_SEARCH_PROVIDER?.trim();
  const explicit = input.webSearchProvider ?? envExplicit;

  if (explicit) {
    if (!isProviderName(explicit)) {
      throw new Error(
        `Unknown web-search provider '${explicit}'. Expected one of: ${PROVIDER_NAMES.join(", ")}`,
      );
    }
    const envVar = PROVIDER_ENV_VAR[explicit];
    const apiKey = input.env[envVar]?.trim();
    if (!apiKey) {
      return {
        status: "skipped",
        reason: "no-credentials",
        provider: explicit,
        message: `--web-search-provider=${explicit} set but ${envVar} is empty`,
      };
    }
    return { status: "configured", provider: explicit, apiKey };
  }

  const present = AUTO_PRIORITY.filter(
    (p) => (input.env[PROVIDER_ENV_VAR[p]] ?? "").trim().length > 0,
  );

  if (present.length === 0) {
    return { status: "skipped", reason: "no-credentials" };
  }

  const chosen = present[0];
  const message =
    present.length > 1
      ? `multiple provider keys present (${present.join(", ")}); using ${chosen} — set WEB_SEARCH_PROVIDER to override`
      : undefined;

  return {
    status: "configured",
    provider: chosen,
    apiKey: input.env[PROVIDER_ENV_VAR[chosen]]!.trim(),
    message,
  };
}
