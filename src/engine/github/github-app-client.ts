import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "fs";
import { Octokit } from "octokit";
import { resolve } from "path";

export interface GitHubAppClientConfig {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  /**
   * Override the GitHub REST base URL (Octokit `baseUrl`). Prod leaves this
   * unset → `api.github.com`. The evals harness points it at its mock server so
   * harness-side writes land there. Test/eval escape hatch only — mirrors
   * `ExecutorConfig.githubApiBaseUrl`.
   */
  baseUrl?: string;
}

function normalizeBaseUrl(baseUrl: string | undefined): string | undefined {
  return baseUrl ? baseUrl.replace(/\/+$/, "") : undefined;
}

export function githubAppClient(config: GitHubAppClientConfig): Octokit {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey,
      installationId: config.installationId,
    },
    ...(baseUrl ? { baseUrl } : {}),
  });
}

/**
 * Octokit authed with a raw bearer token (a pre-minted installation token) plus
 * an optional `baseUrl`. This is the auth shape the evals mock and the
 * harness-minted scoped token both use — no App JWT / installation-token
 * minting round-trip against the REST base URL. Used by the harness-side
 * `post-review` action so it works identically against api.github.com and the
 * eval mock.
 */
export function githubTokenClient(token: string, baseUrl?: string): Octokit {
  const url = normalizeBaseUrl(baseUrl);
  return new Octokit({ auth: token, ...(url ? { baseUrl: url } : {}) });
}
