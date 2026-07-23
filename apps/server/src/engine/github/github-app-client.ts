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

/**
 * Log a diagnostic on a 403/404 from the GitHub REST API and re-throw — no
 * behaviour change. Records the request, the endpoint's REQUIRED permissions
 * (`x-accepted-github-permissions`), and — for App-auth clients — the actual
 * `repository_selection` + permissions of the installation token that was used.
 *
 * This is the shared instrument for the two open token-scope bugs: the
 * private-repo enumeration 404 (issue #213 — is the enumeration token's
 * `repository_selection` really `all`, and does the 404 endpoint want a
 * permission the token lacks?) and any "Resource not accessible by integration"
 * 403. The token introspection reuses the strategy's CACHED installation auth
 * (the request we just made minted it), so it adds no extra network round-trip.
 */
function installScopeDiagnostics(octokit: Octokit, appAuth: boolean): void {
  octokit.hook.error("request", async (error, options) => {
    const status = (error as { status?: number }).status;
    if (status === 403 || status === 404) {
      const headers =
        (error as { response?: { headers?: Record<string, string> } }).response?.headers ?? {};
      const accepted = headers["x-accepted-github-permissions"] ?? "(none)";
      let scope = "";
      if (appAuth) {
        try {
          const auth = (await octokit.auth({ type: "installation" })) as {
            repositorySelection?: string;
            permissions?: Record<string, string>;
          };
          const perms = auth.permissions
            ? Object.entries(auth.permissions)
                .map(([name, level]) => `${name}=${level}`)
                .join(",")
            : "?";
          scope = `; token repository_selection=${auth.repositorySelection ?? "?"}, permissions=${perms}`;
        } catch {
          // Introspection is best-effort — never mask the real request error.
        }
      }
      console.warn(
        `[github-diag] ${options.method} ${options.url} -> ${status}; ` +
          `x-accepted-github-permissions=${accepted}${scope}`,
      );
    }
    throw error;
  });
}

export function githubAppClient(config: GitHubAppClientConfig): Octokit {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");
  const baseUrl = normalizeBaseUrl(config.baseUrl);
  const octokit = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.appId,
      privateKey,
      installationId: config.installationId,
    },
    ...(baseUrl ? { baseUrl } : {}),
  });
  installScopeDiagnostics(octokit, true);
  return octokit;
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
  const octokit = new Octokit({ auth: token, ...(url ? { baseUrl: url } : {}) });
  // Raw-bearer client carries no App installation to introspect — log only the
  // request + the endpoint's required permissions.
  installScopeDiagnostics(octokit, false);
  return octokit;
}
