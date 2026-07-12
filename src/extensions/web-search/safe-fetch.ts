/**
 * Safe-by-default HTTP GET wrapper for web_fetch.
 *
 * Rails:
 *   - scheme must be http or https
 *   - timeout via AbortController (default 15s)
 *   - max response bytes hard-capped (default 1 MiB); streaming is aborted
 *     once the cap is exceeded
 *   - redirects followed manually, at most 3; scheme re-checked at each hop
 *   - caller passes the content-type allowlist; non-matching responses
 *     raise so the tool layer can return a structured error
 *
 * No SSRF private-range blocking is performed (deliberate per user
 * decision). Operators who care should run this behind their own egress
 * firewall.
 */

import type { FetchImpl } from "./types.js";

export interface SafeFetchOptions {
  /** Defaults to globalThis.fetch. Injected in tests. */
  fetchImpl?: FetchImpl;
  /** Per-request timeout in ms. Default 15_000. */
  timeoutMs?: number;
  /** Hard cap on response body bytes. Default 1 MiB. */
  maxBytes?: number;
  /** Max redirect hops. Default 3. */
  maxRedirects?: number;
  /**
   * Allowed content-types as case-insensitive prefixes. A response is
   * accepted if its Content-Type starts with any entry. Default: text/*,
   * application/(xhtml+xml|xml|json).
   */
  allowedContentTypePrefixes?: string[];
}

export interface SafeFetchResult {
  status: number;
  contentType?: string;
  body: string;
  finalUrl: string;
}

const DEFAULT_ALLOWED_PREFIXES = [
  "text/",
  "application/xhtml+xml",
  "application/xml",
  "application/json",
];

export const SAFE_FETCH_DEFAULTS = {
  timeoutMs: 15_000,
  maxBytes: 1024 * 1024,
  maxRedirects: 3,
};

export class SafeFetchError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

function assertHttpScheme(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError(
      `unsupported url scheme '${url.protocol}' (only http/https allowed)`,
      "bad-scheme",
    );
  }
}

function isAllowedContentType(ct: string | undefined, prefixes: string[]): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  return prefixes.some((p) => lower.startsWith(p));
}

/**
 * Issue a GET, follow redirects manually, cap byte count, enforce timeout
 * and content-type. Returns the decoded body as a UTF-8 string.
 */
export async function safeFetch(
  rawUrl: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchImpl);
  if (!fetchImpl) {
    throw new SafeFetchError("no fetch implementation available", "no-fetch");
  }
  const timeoutMs = options.timeoutMs ?? SAFE_FETCH_DEFAULTS.timeoutMs;
  const maxBytes = options.maxBytes ?? SAFE_FETCH_DEFAULTS.maxBytes;
  const maxRedirects = options.maxRedirects ?? SAFE_FETCH_DEFAULTS.maxRedirects;
  const allowedPrefixes = options.allowedContentTypePrefixes ?? DEFAULT_ALLOWED_PREFIXES;

  let currentUrl: URL;
  try {
    currentUrl = new URL(rawUrl);
  } catch {
    throw new SafeFetchError(`invalid url '${rawUrl}'`, "bad-url");
  }
  assertHttpScheme(currentUrl);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    for (let hop = 0; hop <= maxRedirects; hop++) {
      const response = await fetchImpl(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "user-agent": "agentic-pi/web-search" },
      });

      const status = response.status;
      if (status >= 300 && status < 400) {
        const loc = response.headers.get("location");
        if (!loc) {
          throw new SafeFetchError(
            `redirect (${status}) without Location header`,
            "bad-redirect",
            status,
          );
        }
        if (hop === maxRedirects) {
          throw new SafeFetchError(`too many redirects (>${maxRedirects})`, "too-many-redirects");
        }
        try {
          currentUrl = new URL(loc, currentUrl);
        } catch {
          throw new SafeFetchError(`invalid redirect target '${loc}'`, "bad-url");
        }
        assertHttpScheme(currentUrl);
        // Drain/close any body the redirect carried, just in case.
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        continue;
      }

      if (status >= 400) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new SafeFetchError(`http ${status}`, "http-error", status);
      }

      const contentType = response.headers.get("content-type") ?? undefined;
      if (!isAllowedContentType(contentType, allowedPrefixes)) {
        try {
          await response.body?.cancel();
        } catch {
          /* ignore */
        }
        throw new SafeFetchError(
          `disallowed content-type '${contentType ?? "(none)"}'`,
          "bad-content-type",
          status,
        );
      }

      const body = await readCapped(response, maxBytes);

      return {
        status,
        contentType,
        body,
        finalUrl: currentUrl.toString(),
      };
    }
    // Unreachable — the for-loop returns or throws every path.
    throw new SafeFetchError("redirect loop fell through", "internal");
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number): Promise<string> {
  // Prefer streaming so we can abort when the cap is hit without buffering
  // the entire body first.
  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          /* ignore */
        }
        throw new SafeFetchError(`response exceeded ${maxBytes} bytes`, "too-large");
      }
      chunks.push(value);
    }
    const buf = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      buf.set(c, offset);
      offset += c.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  }
  // Fallback: text() without streaming cap — only triggers when the
  // injected fetch returns a stub Response.
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new SafeFetchError(`response exceeded ${maxBytes} bytes`, "too-large");
  }
  return text;
}
