/**
 * The owner → installation directory.
 *
 * A GitHub App is installed per ACCOUNT, and each installation mints its own
 * tokens. Last Light used to carry one statically-configured
 * `GITHUB_APP_INSTALLATION_ID` threaded into every mint and every App-authed
 * Octokit, so every run against a second account 422'd. This is the lookup that
 * replaced it; what matters is that it answers per owner, asks GitHub at most
 * once per burst, and never turns a failed lookup into "not installed".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync } from "crypto";
import {
  InstallationDirectory,
  installationSettingsUrl,
} from "#src/engine/github/installations.js";

/** A real RSA key, because the directory signs a genuine RS256 App JWT. */
function writePem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "ll-installations-"));
  const path = join(dir, "app.pem");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  return path;
}

const privateKeyPath = writePem();

function installation(id: number, login: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    account: { login, type: "Organization" },
    repository_selection: "all",
    suspended_at: null,
    ...extra,
  };
}

function directory(fallbackInstallationId?: string) {
  return new InstallationDirectory({ appId: "12345", privateKeyPath, fallbackInstallationId });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answer `GET /app/installations` with one page. */
function respondWith(installations: unknown[]) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => installations,
    text: async () => JSON.stringify(installations),
  });
}

describe("InstallationDirectory.resolve", () => {
  it("maps each account to its own installation id", async () => {
    respondWith([installation(121130978, "cliftonc"), installation(150854297, "mirevue")]);
    const dir = directory();

    expect(await dir.resolve("cliftonc")).toBe("121130978");
    expect(await dir.resolve("mirevue")).toBe("150854297");
  });

  it("matches the account case-insensitively", async () => {
    respondWith([installation(150854297, "MiReVue")]);
    const dir = directory();

    expect(await dir.resolve("mirevue")).toBe("150854297");
  });

  it("asks GitHub once for a burst of owners — a cron fan-out is one request", async () => {
    respondWith([installation(1, "a"), installation(2, "b"), installation(3, "c")]);
    const dir = directory();

    const ids = await Promise.all([dir.resolve("a"), dir.resolve("b"), dir.resolve("c")]);

    expect(ids).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("caches the negative, so an uninstalled owner doesn't re-ask per repo", async () => {
    respondWith([installation(1, "cliftonc")]);
    const dir = directory();

    expect(await dir.resolve("stranger")).toBeUndefined();
    expect(await dir.resolve("stranger")).toBeUndefined();
    // One refresh for the first miss; the second is answered from the cache.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back to the legacy id when the LOOKUP fails — never a false negative", async () => {
    fetchMock.mockRejectedValue(new Error("ENETUNREACH"));
    const dir = directory("999");

    expect(await dir.resolve("cliftonc")).toBe("999");
  });

  it("reports a genuinely uninstalled account as undefined even with a legacy id set", async () => {
    // The distinction the caller's error message depends on: we asked, and the
    // App really isn't installed there. Falling back to the legacy id here would
    // mint against the wrong account and 422 with GitHub's opaque wording.
    respondWith([installation(1, "cliftonc")]);
    const dir = directory("999");

    expect(await dir.resolve("stranger")).toBeUndefined();
  });

  it("surfaces a non-ok response as a lookup failure, not an empty directory", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "Bad credentials",
      json: async () => ({}),
    });
    const dir = directory("999");

    expect(await dir.resolve("cliftonc")).toBe("999");
  });

  it("paginates — an account past the first page is still found", async () => {
    const first = Array.from({ length: 100 }, (_, i) => installation(i + 1, `filler${i}`));
    fetchMock.mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.endsWith("&page=1") ? first : [installation(500, "mirevue")]),
      text: async () => "",
    }));
    const dir = directory();

    expect(await dir.resolve("mirevue")).toBe("500");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The settings-page path differs by account type, and guessing wrong 404s — an
 * org install lives under `/organizations/<login>/settings/...`, a personal one
 * under a bare `/settings/...` that GitHub scopes to the viewer. Pinned because
 * these are the links an operator clicks to fix exactly the condition this
 * whole subsystem reports.
 */
describe("installationSettingsUrl", () => {
  const base = { repositorySelection: "all" as const, suspended: false };

  it("points an ORG install at the org's installation settings", () => {
    expect(
      installationSettingsUrl({
        ...base,
        id: "150854297",
        account: "mirevue",
        accountType: "Organization",
      }),
    ).toBe("https://github.com/organizations/mirevue/settings/installations/150854297");
  });

  it("points a PERSONAL install at the viewer-scoped settings page", () => {
    expect(
      installationSettingsUrl({
        ...base,
        id: "121130978",
        account: "cliftonc",
        accountType: "User",
      }),
    ).toBe("https://github.com/settings/installations/121130978");
  });

  it("returns undefined for an unknown account type rather than guessing", () => {
    expect(
      installationSettingsUrl({ ...base, id: "1", account: "who", accountType: "" }),
    ).toBeUndefined();
  });
});

describe("InstallationDirectory.note", () => {
  it("answers from a webhook-learned mapping with no lookup at all", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297);

    expect(await dir.resolve("mirevue")).toBe("150854297");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears a cached negative, so an install mid-flight takes effect immediately", async () => {
    respondWith([installation(1, "cliftonc")]);
    const dir = directory();
    expect(await dir.resolve("mirevue")).toBeUndefined();

    dir.note("mirevue", 150854297);

    expect(await dir.resolve("mirevue")).toBe("150854297");
  });

  it("records the account type, so a webhook-learned install is still linkable", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297, "Organization");

    expect(installationSettingsUrl(dir.list()[0])).toBe(
      "https://github.com/organizations/mirevue/settings/installations/150854297",
    );
  });

  it("fills in a type learned later without disturbing the mapping", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297); // an early event with no account.type
    dir.note("mirevue", 150854297, "Organization");

    expect(dir.list()[0].accountType).toBe("Organization");
    expect(await dir.resolve("mirevue")).toBe("150854297");
  });

  it("ignores an absent id rather than caching a bogus mapping", async () => {
    const dir = directory();
    dir.note("mirevue", undefined);
    respondWith([]);

    expect(await dir.resolve("mirevue")).toBeUndefined();
  });
});

describe("InstallationDirectory.forget", () => {
  it("drops the account so a later resolve no longer answers a dead installation", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297);
    dir.forget("150854297");
    respondWith([]);

    expect(await dir.resolve("mirevue")).toBeUndefined();
    expect(dir.list()).toEqual([]);
  });

  it("leaves every other account intact", async () => {
    const dir = directory();
    dir.note("cliftonc", 121130978);
    dir.note("mirevue", 150854297);

    dir.forget("150854297");

    expect(await dir.resolve("cliftonc")).toBe("121130978");
  });
});

/**
 * A suspended installation still EXISTS — GitHub keeps listing it, with its id —
 * but every token mint against it 403s. So it must be withheld from resolution
 * (the run fails fast, before a sandbox) while staying visible to the admin
 * surface, where "suspended" is a more useful answer than the account silently
 * disappearing.
 */
describe("InstallationDirectory — suspension", () => {
  it("withholds a suspended installation from resolve but keeps it listed", async () => {
    respondWith([installation(150854297, "mirevue", { suspended_at: "2026-01-01T00:00:00Z" })]);
    const dir = directory();

    expect(await dir.resolve("mirevue")).toBeUndefined();
    expect(dir.list()).toMatchObject([{ account: "mirevue", suspended: true }]);
  });

  it("takes the account out of service on setSuspended(true)", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297);
    expect(await dir.resolve("mirevue")).toBe("150854297");

    dir.setSuspended("150854297", true);

    // Still listed (so the admin surface can say "suspended")…
    expect(dir.list()).toMatchObject([{ account: "mirevue", suspended: true }]);
    // …but no longer resolvable, so no run tries to mint against it.
    respondWith([]);
    expect(await dir.resolve("mirevue")).toBeUndefined();
  });

  it("restores it on setSuspended(false)", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297);
    dir.setSuspended("150854297", true);

    dir.setSuspended("150854297", false);

    expect(await dir.resolve("mirevue")).toBe("150854297");
  });

  it("is not resurrected by a later webhook — suspended installations still emit events", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297);
    dir.setSuspended("150854297", true);

    dir.note("mirevue", 150854297);
    respondWith([]);

    expect(await dir.resolve("mirevue")).toBeUndefined();
  });
});

describe("InstallationDirectory.soleInstallationId", () => {
  it("answers when exactly one installation exists — the ownerless-run case", async () => {
    respondWith([installation(121130978, "cliftonc")]);
    const dir = directory();

    expect(await dir.soleInstallationId()).toBe("121130978");
  });

  it("refuses to guess when several exist", async () => {
    respondWith([installation(1, "cliftonc"), installation(2, "mirevue")]);
    const dir = directory();
    await dir.refresh();

    expect(await dir.soleInstallationId()).toBeUndefined();
  });

  it("falls back to the legacy id when nothing can be discovered", async () => {
    fetchMock.mockRejectedValue(new Error("ENETUNREACH"));
    const dir = directory("999");

    expect(await dir.soleInstallationId()).toBe("999");
  });
});

describe("InstallationDirectory.list", () => {
  it("reports the account metadata the admin surface renders", async () => {
    respondWith([
      installation(150854297, "mirevue", { repository_selection: "selected" }),
      installation(121130978, "cliftonc", { suspended_at: "2026-01-01T00:00:00Z" }),
    ]);
    const dir = directory();
    await dir.refresh();

    expect(dir.list()).toEqual([
      {
        id: "121130978",
        account: "cliftonc",
        accountType: "Organization",
        repositorySelection: "all",
        suspended: true,
      },
      {
        id: "150854297",
        account: "mirevue",
        accountType: "Organization",
        repositorySelection: "selected",
        suspended: false,
      },
    ]);
  });

  it("drops an installation that vanished from the listing", async () => {
    const dir = directory();
    dir.note("mirevue", 150854297);
    respondWith([installation(121130978, "cliftonc")]);

    await dir.refresh();

    expect(dir.list().map((i) => i.account)).toEqual(["cliftonc"]);
  });
});
