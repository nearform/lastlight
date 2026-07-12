/**
 * Shared types for the web-search extension.
 *
 * The same `Provider` interface is implemented by tavily / brave / exa.
 * Callers of the extension treat all three uniformly: the tool layer never
 * branches on provider name except to surface `provider` in the result
 * payload.
 */

export type ProviderName = "tavily" | "brave" | "exa";

export const PROVIDER_NAMES: readonly ProviderName[] = ["tavily", "brave", "exa"];

export interface SearchParams {
  query: string;
  /** Hard-capped at 10 by the tool layer. */
  maxResults: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  /** Advisory: providers that have a "depth" knob map this; Brave ignores. */
  searchDepth?: "basic" | "advanced";
  /** Advisory: providers that can return extracted content do; Brave ignores. */
  includeContent?: boolean;
}

export interface SearchResultItem {
  title: string;
  url: string;
  snippet?: string;
  content?: string;
  score?: number;
  publishedDate?: string;
}

export interface NormalizedSearchResult {
  provider: ProviderName;
  query: string;
  results: SearchResultItem[];
  /** Optional provider-supplied summary answer (Tavily can return this). */
  answer?: string;
}

export interface FetchParams {
  url: string;
}

export interface NormalizedFetchResult {
  provider: ProviderName | "safe-fetch";
  url: string;
  /** Final URL after redirects (when known). */
  resolvedUrl?: string;
  status?: number;
  contentType?: string;
  /** Extracted readable text. Capped at ~200 KiB upstream. */
  text: string;
  title?: string;
}

/** Minimal fetch signature used by providers and safe-fetch for DI in tests. */
export type FetchImpl = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface Provider {
  readonly name: ProviderName;
  /** True if the provider's search endpoint can return extracted page content inline. */
  readonly supportsExtractedContent: boolean;
  search(params: SearchParams): Promise<NormalizedSearchResult>;
  /**
   * Optional native fetch endpoint. Tavily has /extract; Exa has /contents;
   * Brave has nothing here. When omitted, the tool layer falls back to
   * `safeFetch` + the HTML extractor.
   */
  fetch?(params: FetchParams): Promise<NormalizedFetchResult>;
}

export type WebSearchSkipReason = "disabled-by-flag" | "no-credentials" | "invalid-config";
