/**
 * Brave Search provider. https://api.search.brave.com/app/documentation
 *
 * Endpoint used:
 *   GET https://api.search.brave.com/res/v1/web/search?q=…&count=…
 *   Header: X-Subscription-Token: <key>
 *
 * Brave has no content-extraction endpoint, so this provider has no
 * `fetch()` method — the tool layer falls back to safeFetch + the HTML
 * extractor for `web_fetch`.
 *
 * `include_domains` / `exclude_domains` are honored via client-side
 * post-filtering so the tool's schema behaves uniformly across providers.
 */

import type {
  FetchImpl,
  NormalizedSearchResult,
  Provider,
  SearchParams,
  SearchResultItem,
} from "../types.js";

export interface BraveOptions {
  apiKey: string;
  fetchImpl?: FetchImpl;
  baseUrl?: string;
}

interface BraveResponse {
  web?: {
    results?: Array<{
      title?: string;
      url?: string;
      description?: string;
      age?: string;
    }>;
  };
}

function hostMatches(url: string, pattern: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  const p = pattern.toLowerCase();
  return host === p || host.endsWith(`.${p}`);
}

export function createBraveProvider(options: BraveOptions): Provider {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchImpl);
  const baseUrl = options.baseUrl ?? "https://api.search.brave.com/res/v1";

  return {
    name: "brave",
    supportsExtractedContent: false,

    async search(params: SearchParams): Promise<NormalizedSearchResult> {
      const url = new URL(`${baseUrl}/web/search`);
      url.searchParams.set("q", params.query);
      // Brave's `count` caps at 20; we then post-filter and slice.
      url.searchParams.set("count", String(Math.min(20, Math.max(1, params.maxResults * 2))));

      const r = await fetchImpl(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json",
          "x-subscription-token": options.apiKey,
        },
      });
      if (!r.ok) {
        const text = await r.text().catch(() => "");
        throw new Error(`brave search failed: http ${r.status} ${text.slice(0, 200)}`);
      }
      const data = (await r.json()) as BraveResponse;
      const items: SearchResultItem[] = (data.web?.results ?? []).map((it) => ({
        title: it.title ?? "",
        url: it.url ?? "",
        snippet: it.description,
        publishedDate: it.age,
      }));

      let filtered = items;
      if (params.includeDomains?.length) {
        const list = params.includeDomains;
        filtered = filtered.filter((it) => it.url && list.some((d) => hostMatches(it.url, d)));
      }
      if (params.excludeDomains?.length) {
        const list = params.excludeDomains;
        filtered = filtered.filter((it) => !(it.url && list.some((d) => hostMatches(it.url, d))));
      }
      filtered = filtered.slice(0, params.maxResults);

      return {
        provider: "brave",
        query: params.query,
        results: filtered,
      };
    },
  };
}
