import { logger } from "../../logging/logger.js";
import { appJwt } from "./app-jwt.js";

const log = logger("installations");

/**
 * One installation of the GitHub App — i.e. one account (user or org) that
 * installed it. A single App has N of these, and **each has its own
 * installation id**, which is what an installation-token mint is scoped to.
 */
export interface AppInstallation {
  /** Installation id, as a string (the mint URL takes it verbatim). */
  id: string;
  /** Account login the App is installed on (`cliftonc`, `mirevue`, …). */
  account: string;
  accountType: string;
  /** `all` = every repo in the account; `selected` = an explicit subset. */
  repositorySelection: "all" | "selected";
  suspended: boolean;
}

export interface InstallationDirectoryConfig {
  appId: string;
  privateKeyPath: string;
  /**
   * Override the GitHub REST base URL. Prod leaves this unset →
   * `api.github.com`. Mirrors `GitHubAppClientConfig.baseUrl` — a test/eval
   * escape hatch only.
   */
  baseUrl?: string;
  /**
   * Optional legacy seed: the single `GITHUB_APP_INSTALLATION_ID` an older
   * deployment configured. It carries no account login, so it can't answer
   * `resolve()` on its own — it's kept only as the last-resort answer when the
   * App JWT lookup is unavailable (no network, a revoked PEM), so an existing
   * single-installation deployment degrades to exactly its old behaviour rather
   * than to no behaviour.
   */
  fallbackInstallationId?: string;
}

/** How long a "this owner has no installation" answer is trusted. */
const NEGATIVE_TTL_MS = 60_000;
/** Floor between two full refreshes triggered by a cache miss. */
const REFRESH_MIN_INTERVAL_MS = 10_000;

/**
 * The single authority for **owner → installation id**.
 *
 * A GitHub App is installed per *account*, so an App installed on two accounts
 * has two installation ids and a token minted against the wrong one 422s with
 * "at least one repository ... is not accessible to the parent installation".
 * Last Light used to carry one statically-configured id
 * (`GITHUB_APP_INSTALLATION_ID`) threaded into every mint and every
 * App-authenticated Octokit, which is exactly that bug for every account but the
 * first.
 *
 * Two feeds, both cheap:
 *  - **`note()`** — every webhook delivery carries `payload.installation.id`
 *    alongside the account login. Authoritative, free, and covers the account
 *    the event came from before we ever ask GitHub anything.
 *  - **`refresh()`** — `GET /app/installations` under an App JWT. Needed for the
 *    routes with no webhook behind them (boot discovery, cron fan-out, CLI/API
 *    triggers).
 *
 * A miss triggers at most one in-flight refresh (`REFRESH_MIN_INTERVAL_MS`
 * apart), so a cron fanning out over N repos in an uninstalled org costs one
 * request, not N.
 */
export class InstallationDirectory {
  /** owner login (lowercased) → installation id. */
  private byOwner = new Map<string, string>();
  /** installation id → the full record, for the admin/ops surface. */
  private byId = new Map<string, AppInstallation>();
  /** owner login (lowercased) → epoch ms when "not installed" was concluded. */
  private negative = new Map<string, number>();
  private inFlight: Promise<AppInstallation[]> | null = null;
  private lastRefreshAt = 0;

  constructor(private readonly config: InstallationDirectoryConfig) {}

  /**
   * Record an owner→installation mapping learned out of band (a webhook
   * payload). Cheaper and fresher than any lookup, so it always wins.
   */
  note(owner: string, id: string | number | undefined | null): void {
    if (!owner || id === undefined || id === null || id === "") return;
    const key = owner.toLowerCase();
    const value = String(id);
    // Never resurrect a suspended installation: it still delivers its own
    // `installation` events, and resolving to it would put the account back in
    // service against tokens GitHub will 403.
    if (this.byId.get(value)?.suspended) return;
    this.negative.delete(key);
    if (this.byOwner.get(key) === value) return;
    this.byOwner.set(key, value);
    if (!this.byId.has(value)) {
      this.byId.set(value, {
        id: value,
        account: owner,
        accountType: "",
        repositorySelection: "all",
        suspended: false,
      });
    }
    log.info("Learned installation from event", { owner, installationId: value });
  }

  /** Drop an installation entirely (the App was uninstalled from that account). */
  forget(id: string | number): void {
    const value = String(id);
    const record = this.byId.get(value);
    this.byId.delete(value);
    for (const [owner, installationId] of this.byOwner) {
      if (installationId === value) this.byOwner.delete(owner);
    }
    log.info("Forgot installation", { installationId: value, account: record?.account });
  }

  /**
   * Mark an installation suspended or restored.
   *
   * A suspended installation still EXISTS — it stays in the listing and keeps
   * its id — but every token mint against it 403s. So it is dropped from
   * `resolve()` (the run fails fast, before a sandbox) while staying in
   * `list()`, where the admin surface can say "suspended" rather than the
   * account simply vanishing.
   */
  setSuspended(id: string | number, suspended: boolean): void {
    const value = String(id);
    const record = this.byId.get(value);
    if (record) record.suspended = suspended;
    const account = record?.account;
    if (suspended) {
      for (const [owner, installationId] of this.byOwner) {
        if (installationId === value) this.byOwner.delete(owner);
      }
    } else if (account) {
      this.byOwner.set(account.toLowerCase(), value);
      this.negative.delete(account.toLowerCase());
    }
    log.info(suspended ? "Installation suspended" : "Installation unsuspended", {
      installationId: value,
      account,
    });
  }

  /** Cached snapshot — never triggers a fetch. Ordered by account login. */
  list(): AppInstallation[] {
    return [...this.byId.values()].sort((a, b) => a.account.localeCompare(b.account));
  }

  /**
   * The installation id when the App is installed on exactly ONE account.
   *
   * The answer for a run that names no owner (a Slack-scoped `explore`, say):
   * it still wants a GitHub token, and with a single installation there is no
   * ambiguity about which — that is the deployment this harness supported
   * before it grew multi-installation support, so it keeps behaving identically.
   * With several installations there is no defensible pick, so the caller goes
   * without a token rather than guessing an account.
   */
  async soleInstallationId(): Promise<string | undefined> {
    if (this.byId.size === 0) {
      try {
        await this.refresh();
      } catch {
        return this.config.fallbackInstallationId;
      }
    }
    if (this.byId.size === 1) return [...this.byId.keys()][0];
    return this.byId.size === 0 ? this.config.fallbackInstallationId : undefined;
  }

  /**
   * The installation id for `owner`, or `undefined` when the App isn't
   * installed on that account. Cache → one shared refresh → a cached negative.
   *
   * `undefined` means **we asked and the App is genuinely not installed there**,
   * so the caller can fail with an actionable "install the App on `<owner>`"
   * message instead of letting a mint 422 with GitHub's opaque wording. A
   * lookup *failure* (network, bad PEM) is a different thing and falls back to
   * the legacy single id rather than claiming the account isn't installed.
   */
  async resolve(owner: string): Promise<string | undefined> {
    if (!owner) return undefined;
    const key = owner.toLowerCase();

    const cached = this.byOwner.get(key);
    if (cached) return cached;

    const deniedAt = this.negative.get(key);
    if (deniedAt !== undefined && Date.now() - deniedAt < NEGATIVE_TTL_MS) {
      return undefined;
    }

    if (Date.now() - this.lastRefreshAt >= REFRESH_MIN_INTERVAL_MS || this.inFlight) {
      try {
        await this.refresh();
      } catch (err) {
        // Never cache a negative off a failed lookup — that would report a
        // perfectly good installation as missing for the next minute.
        log.warn("Installation lookup failed", { owner, err });
        return this.config.fallbackInstallationId;
      }
      const found = this.byOwner.get(key);
      if (found) return found;
    }

    this.negative.set(key, Date.now());
    return undefined;
  }

  /**
   * Re-read every installation of the App. Concurrent callers share one
   * request — a cron fan-out resolves N owners against a single round-trip.
   */
  refresh(): Promise<AppInstallation[]> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.fetchAll().finally(() => {
      this.inFlight = null;
      this.lastRefreshAt = Date.now();
    });
    return this.inFlight;
  }

  private async fetchAll(): Promise<AppInstallation[]> {
    const jwt = appJwt(this.config.appId, this.config.privateKeyPath);
    const base = (this.config.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
    const found: AppInstallation[] = [];

    // `GET /app/installations` is App-JWT-authed and paginated. 100/page is the
    // maximum; an App with more than a handful of installations is unusual, but
    // paginating costs nothing and a truncated list would silently look like
    // "not installed" for every account past the first page.
    for (let page = 1; page <= 20; page++) {
      const res = await fetch(`${base}/app/installations?per_page=100&page=${page}`, {
        headers: {
          Authorization: `Bearer ${jwt}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub App installations request failed (${res.status}): ${await res.text()}`);
      }
      const batch = (await res.json()) as Array<{
        id: number;
        account?: { login?: string; type?: string } | null;
        repository_selection?: string;
        suspended_at?: string | null;
      }>;
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const raw of batch) {
        const account = raw.account?.login;
        if (!account) continue;
        found.push({
          id: String(raw.id),
          account,
          accountType: raw.account?.type ?? "",
          repositorySelection: raw.repository_selection === "selected" ? "selected" : "all",
          suspended: !!raw.suspended_at,
        });
      }
      if (batch.length < 100) break;
    }

    // Replace wholesale — an installation that vanished from the listing was
    // uninstalled, and keeping its stale mapping would keep minting 404s. A
    // SUSPENDED one is still listed but cannot mint, so it is kept for the admin
    // surface and withheld from resolution.
    this.byOwner = new Map(
      found.filter((i) => !i.suspended).map((i) => [i.account.toLowerCase(), i.id]),
    );
    this.byId = new Map(found.map((i) => [i.id, i]));
    this.negative.clear();

    log.info("Refreshed App installations", {
      count: found.length,
      accounts: found.map((i) => `${i.account}=${i.id}`).join(","),
    });
    return found;
  }
}

// ── Module singleton ────────────────────────────────────────────────

let directory: InstallationDirectory | null = null;

/**
 * Install the process-wide directory. Called once at boot from the App creds in
 * runtime config; safe to call again (a re-init replaces the cache).
 */
export function initInstallationDirectory(
  config: InstallationDirectoryConfig,
): InstallationDirectory {
  directory = new InstallationDirectory(config);
  return directory;
}

/**
 * The process-wide directory, or `undefined` when no GitHub App is configured
 * (PAT / chat-only mode). Callers that need a mapping must handle `undefined` —
 * they are in token mode, where there is no installation to resolve.
 */
export function getInstallationDirectory(): InstallationDirectory | undefined {
  return directory ?? undefined;
}

/** Test-only: drop the singleton so each test starts from a clean directory. */
export function resetInstallationDirectoryForTests(): void {
  directory = null;
}
