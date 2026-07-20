import { describe, it, expect, vi } from "vitest";
import {
  exchangeOAuth2Code,
  GITHUB_TOKEN_ENDPOINT,
  SLACK_TOKEN_ENDPOINT,
} from "../../src/admin/routes.js";

/**
 * Regression: the dashboard's GitHub/Slack OAuth token exchange must NOT set a
 * `Content-Length` header. arctic's `validateAuthorizationCode` did, and once an
 * in-process agent run replaces Node's global undici dispatcher (a non-default
 * build that rejects a manually-set Content-Length) every login threw
 * `UND_ERR_INVALID_ARG: invalid content-length header`. See exchangeOAuth2Code's
 * doc comment.
 */
describe("exchangeOAuth2Code", () => {
  function fakeFetch(status: number, payload: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return {
        status,
        json: async () => payload,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  const base = {
    code: "abc123",
    clientId: "client-id",
    clientSecret: "s3cr3t",
    redirectUri: "https://example.com/cb",
  };

  it("never sends a Content-Length header (the poisoned-dispatcher regression)", async () => {
    const { impl, calls } = fakeFetch(200, { access_token: "gho_token" });
    await exchangeOAuth2Code({ ...base, tokenEndpoint: GITHUB_TOKEN_ENDPOINT, fetchImpl: impl });

    const headers = calls[0].init.headers as Record<string, string>;
    const headerNames = Object.keys(headers).map((h) => h.toLowerCase());
    expect(headerNames).not.toContain("content-length");
  });

  it("posts a confidential-client exchange (Basic auth + form body) to the token endpoint", async () => {
    const { impl, calls } = fakeFetch(200, { access_token: "gho_token" });
    const token = await exchangeOAuth2Code({
      ...base,
      tokenEndpoint: GITHUB_TOKEN_ENDPOINT,
      fetchImpl: impl,
    });

    expect(token).toBe("gho_token");
    const { url, init } = calls[0];
    expect(url).toBe(GITHUB_TOKEN_ENDPOINT);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Basic ${Buffer.from("client-id:s3cr3t").toString("base64")}`);
    expect(headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("abc123");
    expect(body.get("redirect_uri")).toBe("https://example.com/cb");
    // Basic auth carries the credentials — they are NOT duplicated in the body.
    expect(body.get("client_id")).toBeNull();
  });

  it("works for the Slack token endpoint too (same shape)", async () => {
    const { impl, calls } = fakeFetch(200, { ok: true, access_token: "xoxp-token" });
    const token = await exchangeOAuth2Code({ ...base, tokenEndpoint: SLACK_TOKEN_ENDPOINT, fetchImpl: impl });
    expect(token).toBe("xoxp-token");
    expect(calls[0].url).toBe(SLACK_TOKEN_ENDPOINT);
  });

  it("throws with the provider error detail on a failed exchange", async () => {
    const { impl } = fakeFetch(401, { error: "bad_verification_code", error_description: "code expired" });
    await expect(
      exchangeOAuth2Code({ ...base, tokenEndpoint: GITHUB_TOKEN_ENDPOINT, fetchImpl: impl }),
    ).rejects.toThrow(/code expired/);
  });

  it("throws when the response is 200 but carries no access_token", async () => {
    const { impl } = fakeFetch(200, { ok: false, error: "invalid_client" });
    await expect(
      exchangeOAuth2Code({ ...base, tokenEndpoint: SLACK_TOKEN_ENDPOINT, fetchImpl: impl }),
    ).rejects.toThrow(/invalid_client/);
  });
});
